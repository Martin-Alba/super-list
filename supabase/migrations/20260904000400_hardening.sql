-- ============================================================
-- J2 — los roles de cliente no pueden destruir tablas.
-- RLS gobierna SELECT/INSERT/UPDATE/DELETE, pero NO gobierna TRUNCATE:
-- medido, `set role anon; truncate public.items` estaba permitido. R16 se
-- sostenia solo en la ausencia de politica DELETE; ahora se sostiene tambien
-- en el privilegio, que es la capa que TRUNCATE si respeta.
-- ============================================================
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

-- Se reconcede lo minimo que las politicas necesitan. `anon` no recibe nada:
-- su unico uso es invite_preview(), que es SECURITY DEFINER.
grant select on public.profiles, public.groups, public.group_members,
                public.group_invites, public.items to authenticated;
grant insert, update on public.items to authenticated;

-- ============================================================
-- J3 — la autoria no es falsificable y un borrado no resucita.
-- Una politica RLS no puede comparar la fila vieja con la nueva (USING ve la
-- vieja, WITH CHECK la nueva), asi que el invariante va en un trigger.
-- ============================================================
create or replace function public.items_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.created_by is distinct from old.created_by then
    raise exception 'created_by is immutable' using errcode = '42501';
  end if;
  if new.group_id is distinct from old.group_id then
    raise exception 'group_id is immutable' using errcode = '42501';
  end if;
  if old.deleted_at is not null and new.deleted_at is null then
    raise exception 'a deleted item cannot be restored' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists items_guard on public.items;
create trigger items_guard before update on public.items
for each row execute function public.items_guard();

-- ============================================================
-- J7 — cota de longitud. Sin ella un miembro legitimo mete 200 000 caracteres
-- y Realtime los difunde a todos los suscriptores: con 500 MB de base y 2 M de
-- mensajes al mes, es una palanca de agotamiento.
-- ============================================================
alter table public.items  drop constraint if exists items_name_len;
alter table public.items  add  constraint items_name_len  check (length(name) <= 200);
alter table public.items  drop constraint if exists items_quantity_len;
alter table public.items  add  constraint items_quantity_len check (quantity is null or length(quantity) <= 50);
alter table public.groups drop constraint if exists groups_name_len;
alter table public.groups add  constraint groups_name_len check (length(name) <= 200);

-- ============================================================
-- J8 — el owner ve a quien esta aprobando. `shares_active_group` exige que los
-- dos sean `active`, asi que el owner leia "alguien" en cada solicitud y
-- aprobaba a ciegas: lo contrario de lo que A.2 le pide.
-- ============================================================
create or replace function public.owns_group_of(p_user_id uuid)
returns boolean language sql security definer stable set search_path = '' as $$
  select exists (
    select 1
    from public.group_members me
    join public.group_members other on other.group_id = me.group_id
    where me.user_id = (select auth.uid())
      and me.status = 'active' and me.role = 'owner'
      and other.user_id = p_user_id
  );
$$;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_active_group(id)
    or public.owns_group_of(id)
  );
