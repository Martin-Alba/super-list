-- ============================================================
-- Escrituras de pertenencia por RPC SECURITY DEFINER (B.5):
-- el cliente envía intención; el rol, el estado y el grupo se
-- derivan siempre en el servidor a partir de la sesión.
-- ============================================================

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end;
$$;

drop trigger if exists items_touch_updated_at on public.items;
create trigger items_touch_updated_at
before update on public.items
for each row execute function public.touch_updated_at();

-- R3: grupo y membresía de owner en la MISMA transacción.
create or replace function public.create_group(p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_id uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  insert into public.groups (name, owner_id) values (p_name, v_uid) returning id into v_id;
  insert into public.group_members (group_id, user_id, status, role, decided_at, decided_by)
  values (v_id, v_uid, 'active', 'owner', now(), v_uid);
  return v_id;
end;
$$;

-- R4: token >=128 bits (24 bytes = 192), caducidad, y regenerar revoca el anterior.
create or replace function public.create_invite(p_group_id uuid, p_ttl_days int default 7)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_token text;
begin
  if not public.is_group_owner(p_group_id) then
    raise exception 'only the owner can invite' using errcode='42501';
  end if;
  update public.group_invites set revoked_at = now()
   where group_id = p_group_id and revoked_at is null;
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.group_invites (group_id, token, expires_at, created_by)
  values (p_group_id, v_token, now() + make_interval(days => p_ttl_days), v_uid);
  return v_token;
end;
$$;

-- Vista previa pública del link: quien tiene el token ya puede ver el nombre.
create or replace function public.invite_preview(p_token text)
returns jsonb language sql security definer stable set search_path = '' as $$
  select coalesce(
    (select jsonb_build_object('valid', true, 'group_name', g.name)
       from public.group_invites i join public.groups g on g.id = i.group_id
      where i.token = p_token and i.revoked_at is null and i.expires_at > now()),
    jsonb_build_object('valid', false)
  );
$$;

-- R5: solicitar ingreso. Idempotente por la PK; nunca degrada a un activo.
create or replace function public.request_join(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_group uuid; v_status public.member_status;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select i.group_id into v_group from public.group_invites i
   where i.token = p_token and i.revoked_at is null and i.expires_at > now();
  -- Token inexistente, malformado, caducado o revocado: misma respuesta (borde 1 y 9).
  if v_group is null then return jsonb_build_object('status','invalid'); end if;

  select m.status into v_status from public.group_members m
   where m.group_id = v_group and m.user_id = v_uid;

  if v_status = 'active' then
    return jsonb_build_object('status','active','group_id',v_group);
  end if;

  insert into public.group_members (group_id, user_id, status)
  values (v_group, v_uid, 'pending')
  on conflict (group_id, user_id) do update
    set status = 'pending', requested_at = now(), decided_at = null, decided_by = null
    where public.group_members.status in ('rejected','removed');

  return jsonb_build_object('status','pending','group_id',v_group);
end;
$$;

-- R6 y R7: aprobar, rechazar, expulsar. Sólo el owner, y nunca sobre sí mismo.
create or replace function public.decide_member(p_group_id uuid, p_user_id uuid, p_decision text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.is_group_owner(p_group_id) then
    raise exception 'only the owner can decide' using errcode='42501';
  end if;
  if p_user_id = v_uid then
    raise exception 'the owner cannot act on their own membership' using errcode='42501';
  end if;
  if p_decision not in ('active','rejected','removed') then
    raise exception 'invalid decision' using errcode='22023';
  end if;

  update public.group_members m
     set status = p_decision::public.member_status, decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.user_id = p_user_id
     and case p_decision
           when 'active'   then m.status = 'pending'
           when 'rejected' then m.status = 'pending'
           when 'removed'  then m.status = 'active'
         end;
end;
$$;

-- R15: salir por voluntad propia. El owner queda excluido.
create or replace function public.leave_group(p_group_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid());
begin
  update public.group_members m
     set status = 'removed', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.user_id = v_uid
     and m.status = 'active' and m.role <> 'owner';
  if not found then
    raise exception 'only an active non-owner member can leave' using errcode='42501';
  end if;
end;
$$;

revoke all on function public.create_group(text)                  from public, anon;
revoke all on function public.create_invite(uuid,int)             from public, anon;
revoke all on function public.request_join(text)                  from public, anon;
revoke all on function public.decide_member(uuid,uuid,text)       from public, anon;
revoke all on function public.leave_group(uuid)                   from public, anon;
grant execute on function public.create_group(text)               to authenticated;
grant execute on function public.create_invite(uuid,int)          to authenticated;
grant execute on function public.request_join(text)               to authenticated;
grant execute on function public.decide_member(uuid,uuid,text)    to authenticated;
grant execute on function public.leave_group(uuid)                to authenticated;
grant execute on function public.invite_preview(text)             to anon, authenticated;
