-- L2 — J2 revoco los privilegios por defecto sobre TABLAS, y su propia guarda
-- solo miraba `defaclobjtype='r'`. Medido: toda funcion que `postgres` cree en
-- `public` nace EXECUTE-able por anon. Sin exploit vivo, pero es el principio
-- de J2 sin aplicar en la superficie que nadie miraba.
alter default privileges in schema public revoke all on functions from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- Las funciones que YA existen no las cubre `alter default privileges`. Y
-- revocar solo de anon no basta: en Postgres las funciones nacen ejecutables
-- por PUBLIC, asi que anon las hereda por ahi. Se revoca de PUBLIC y se
-- reconcede lo justo.
revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.create_group(text)               to authenticated;
grant execute on function public.create_invite(uuid,int)          to authenticated;
grant execute on function public.request_join(text)               to authenticated;
grant execute on function public.decide_member(uuid,uuid,text)    to authenticated;
grant execute on function public.leave_group(uuid)                to authenticated;
-- Las politicas RLS invocan estas tres como el usuario que consulta.
grant execute on function public.is_active_member(uuid)           to authenticated;
grant execute on function public.is_group_owner(uuid)             to authenticated;
grant execute on function public.shares_active_group(uuid)        to authenticated;
grant execute on function public.owns_group_of(uuid)              to authenticated;
-- La unica anonima, y a proposito: la pagina de invitacion es publica (R2).
grant execute on function public.invite_preview(text)             to anon, authenticated;
