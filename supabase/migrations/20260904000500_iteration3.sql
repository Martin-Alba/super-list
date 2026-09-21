-- K4 — R4 promete caducidad. Medido antes del cambio:
-- create_invite(p_ttl_days => 3650000) acunaba un link que caduca en el ano
-- 12020, y el link es justo el artefacto que se reenvia a desconocidos (A.2).
create or replace function public.create_invite(p_group_id uuid, p_ttl_days int default 7)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_token text; v_days int;
begin
  if not public.is_group_owner(p_group_id) then
    raise exception 'only the owner can invite' using errcode = '42501';
  end if;
  v_days := least(greatest(coalesce(p_ttl_days, 7), 1), 30);
  update public.group_invites set revoked_at = now()
   where group_id = p_group_id and revoked_at is null;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.group_invites (group_id, token, expires_at, created_by)
  values (p_group_id, v_token, now() + make_interval(days => v_days), v_uid);
  return v_token;
end;
$$;

-- K6 — J8 pidio que el owner viera a quien APRUEBA. El permiso salio mas ancho
-- de lo pedido: leia indefinidamente el perfil de alguien a quien ya expulso, y
-- A.1 cuenta a `removed` y `rejected` como no-miembros.
create or replace function public.owns_group_of(p_user_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.group_members me
    join public.group_members other on other.group_id = me.group_id
    where me.user_id = (select auth.uid())
      and me.status = 'active' and me.role = 'owner'
      and other.user_id = p_user_id
      and other.status in ('pending','active')
  );
$$;

-- K11 — `authenticated` tiene UPDATE de tabla y `created_at` es la clave de
-- ordenacion de la lista: reescribirlo reordena la compra para todo el grupo.
create or replace function public.items_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by is immutable' using errcode = '42501';
  end if;
  if new.group_id is distinct from old.group_id then
    raise exception 'group_id is immutable' using errcode = '42501';
  end if;
  if new.created_at is distinct from old.created_at then
    raise exception 'created_at is immutable' using errcode = '42501';
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'a deleted item cannot be restored' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- K12 — la entrada de `postgres` quedo limpia, pero la de `supabase_admin`
-- seguia concediendo todo a anon y authenticated: J2 dependia de quien creara
-- la proxima tabla.
-- Se intenta, no se exige: las migraciones corren como `postgres`, que no
-- puede tocar los privilegios por defecto de otro rol. Donde el ciclo corra con
-- permisos suficientes, se aplica; donde no, se deja constancia y el riesgo
-- sigue siendo teorico, porque ninguna migracion crea tablas como supabase_admin.
do $$ begin
  execute 'alter default privileges for role supabase_admin in schema public '
       || 'revoke all on tables from anon, authenticated';
exception when insufficient_privilege then
  raise notice 'sin permiso para limpiar los privilegios por defecto de supabase_admin';
end $$;
