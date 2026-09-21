-- Spec H / iteración 2 — Cerrar el oráculo del expulsado y hacer irrepresentable la forma peligrosa.

-- ─────────────────────────────────────────────────────────────────────────────
-- i2-R1 — El atajo de idempotencia no le contesta a quien ya no es miembro.
--
-- La iteración anterior acotó la idempotencia con `decided_by = v_uid`, razonando que después de una
-- transferencia sólo eso distingue a quien la hizo. Es verdad y **no basta**, y la revisión lo midió:
--
--   A transfiere a B. B expulsa a A. A queda `removed` y no es miembro de nada.
--   A llama a `transfer_group(G, B)` → **éxito silencioso**.
--   Un desconocido C llama a lo mismo  → 42501.
--   Y en cuanto B deja de ser owner, A → 42501.
--
-- O sea: un expulsado conserva un oráculo de un bit sobre «¿sigue B siendo el owner activo de G?».
-- La lista de *hard fails* de la constitución dice, con estas palabras, que los datos de un grupo no
-- son visibles para quien no es miembro `active`, y que `removed` cuenta como no-miembro.
--
-- `is_active_member` cierra exactamente eso sin tocar la idempotencia: quien reintenta de verdad
-- acaba de transferir, así que en ese instante sigue siendo `member` y `active`.
create or replace function public.transfer_group(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_ya boolean;
begin
  if p_user_id = v_uid then
    raise exception 'the owner cannot transfer to themselves' using errcode = '42501';
  end if;

  select exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_user_id
       and m.role = 'owner' and m.status = 'active'
       and m.decided_by = v_uid
       -- i2-R1 — y quien pregunta sigue dentro.
       and public.is_active_member(p_group_id)
  ) into v_ya;
  if v_ya then return; end if;

  update public.group_members m
     set role = 'member', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.user_id = v_uid
     and m.role = 'owner' and m.status = 'active';
  if not found then
    raise exception 'only the owner can transfer' using errcode = '42501';
  end if;

  update public.group_members m
     set role = 'owner', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.user_id = p_user_id
     and m.status = 'active';
  if not found then
    raise exception 'the new owner must be an active member' using errcode = '42501';
  end if;

  update public.groups g set owner_id = p_user_id where g.id = p_group_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- i2-R6 — `role='owner'` con `status` de espera o rechazo deja de ser representable.
--
-- Hasta ahora esa forma se parcheaba en cada escritor: el `on conflict` de `request_join` lleva un
-- comentario diciendo que la crea esta misma spec. Parchear escritores es lo que la constitución
-- manda no hacer (§D.2): el invariante va en la base.
--
-- Y la revisión midió que la forma no sólo es peligrosa, es **muerta**: una fila `owner` + `pending`
-- no se puede aprobar —el índice parcial rechaza el segundo owner activo— ni rechazar, porque
-- `decide_member` acaba de aprender a no tocar filas de owner. Nadie puede sacarla de ahí.
--
-- `owner` + `removed` sí es legítima y se conserva: es justo lo que deja un grupo borrado.
-- Medido antes de crearla: 0 filas la violan.
alter table public.group_members drop constraint if exists group_members_owner_no_espera;
alter table public.group_members add constraint group_members_owner_no_espera
  check (not (role = 'owner' and status in ('pending', 'rejected')));
