-- I3 — A.1 protege tambien los metadatos del grupo, y A.3 manda fallar cerrado.
-- La version anterior devolvia el nombre del grupo a un cliente sin sesion con
-- solo tener el token. Ni R4 ni R5 autorizaron esa excepcion, asi que se cierra:
-- la vista previa dice si el link sirve, y nada mas.
create or replace function public.invite_preview(p_token text)
returns jsonb language sql security definer stable set search_path = '' as $$
  select jsonb_build_object('valid', exists (
    select 1 from public.group_invites i
     where i.token = p_token and i.revoked_at is null and i.expires_at > now()
  ));
$$;
