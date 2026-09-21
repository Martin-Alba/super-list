-- Spec H — Transferir y borrar grupo.
--
-- Borrar un grupo NO puede ser un `delete`. `groups` está referenciada con `on delete cascade`
-- por `group_members`, `items` y `group_invites`, y las dos primeras están publicadas en
-- `supabase_realtime`. Un borrado físico sobre una tabla publicada es hard fail de la
-- constitución (§B.3): los DELETE están exentos de RLS, así que su evento no va autorizado.
--
-- Así que **borrar un grupo es expulsar a todos sus miembros, el owner incluido** — que es
-- exactamente lo único que `leave_group` y `decide_member` prohíben. `delete_group` es la
-- excepción autorizada, y la única.
--
-- Y funciona sin tocar ninguna política, por un motivo que conviene dejar escrito:
-- `group_members_select` es `USING (user_id = auth.uid() OR is_active_member(group_id))`. Esa
-- primera mitad deja que cada quien vea SIEMPRE su propia fila, en cualquier estado, así que el
-- UPDATE que pone tu `status` en `removed` **sí se te entrega** por realtime: el predicado que
-- autoriza el evento sobrevive al cambio que el evento anuncia. Por `groups` sería lo contrario
-- —su política es `is_active_member(id)`, que se vuelve falsa—, y el evento que anuncia la
-- desaparición quedaría filtrado por el estado que anuncia. Por eso esta migración **no publica
-- ninguna tabla nueva**.
--
-- Forward-only e idempotente: `create index if not exists`, `create or replace function`.

-- ─────────────────────────────────────────────────────────────────────────────
-- H-R2 — Exactamente un owner activo por grupo, hecho cumplir por la base (§D.2).
--
-- Antes de esto, el único índice único de `group_members` era su clave primaria `(group_id,
-- user_id)`: cero owners o dos owners eran estados representables, y una transferencia hecha en
-- dos escrituras podía aterrizar en cualquiera de los dos.
--
-- Medido antes de crearlo: 0 grupos con dos owners activos sobre 58.137, así que entra limpio.
--
-- **Y tiene una precondición que conviene escribir, porque la pagué al construirla:** si la base ya
-- contuviera un grupo con dos owners activos, `create unique index` **aborta** con «Key (group_id) is
-- duplicated», y como `unit/migrations.test.ts` reaplica las doce migraciones, ese fichero se pondría
-- rojo por una fila que no es suya. Abortar es la conducta correcta —la alternativa sería que una
-- migración decidiera por su cuenta qué owner sobra—, así que lo que se arregla es el origen: ninguna
-- prueba deja una fila que viole el invariante. Medido: la sonda de h4 dejó tres, y ahora se limpia
-- pase lo que pase.
--
-- **Es parcial, y no se puede diferir.** Un índice único no acepta `deferrable`, así que el orden
-- dentro de `transfer_group` importa y está escrito allí: degradar antes de promover. Con el orden
-- al revés habría dos owners activos a la vez dentro de la transacción y el índice la abortaría.
create unique index if not exists group_members_un_solo_owner
  on public.group_members (group_id)
  where role = 'owner' and status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- H-R1 / H-R8 — Transferir la propiedad.
create or replace function public.transfer_group(p_group_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if not public.is_group_owner(p_group_id) then
    raise exception 'only the owner can transfer' using errcode = '42501';
  end if;
  if p_user_id = v_uid then
    raise exception 'the owner cannot transfer to themselves' using errcode = '42501';
  end if;

  -- **Degradar antes de promover**, por el índice parcial de arriba: al revés, el `update` que
  -- promueve encontraría al viejo owner todavía activo y el índice abortaría la transacción.
  update public.group_members m
     set role = 'member', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.user_id = v_uid
     and m.role = 'owner' and m.status = 'active';
  if not found then
    raise exception 'only the owner can transfer' using errcode = '42501';
  end if;

  -- La pertenencia del destinatario se comprueba **en el `where` de su propio `update`**, no en un
  -- `if` previo: entre un `if` y su escritura cabe un `decide_member` concurrente que lo expulse, y
  -- entonces el grupo acabaría con cero owners sin que nadie se hubiera autoexpulsado. Ésa es la
  -- primera de las tres respuestas construidas de la spec.
  update public.group_members m
     set role = 'owner', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.user_id = p_user_id
     and m.status = 'active';
  if not found then
    raise exception 'the new owner must be an active member' using errcode = '42501';
  end if;

  -- H-R8 — `groups.owner_id` no lo lee nadie hoy —ni una función, ni una política; en código sólo
  -- el banco de e2e—, pero dejarlo rancio crearía dos fuentes de verdad para un solo hecho, que es
  -- lo que el ciclo anterior pagó tres vueltas. Se actualiza aquí, y un test afirma sobre toda la
  -- base que no pueden divergir.
  update public.groups g set owner_id = p_user_id where g.id = p_group_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- H-R3 — Borrar el grupo: expulsar a todos, el owner incluido, y revocar las invitaciones.
-- La definición vive más abajo, junto a `deleted_at`, porque las dos cosas son el mismo mecanismo.
-- Tuvo dos definiciones en este mismo fichero durante una iteración: la primera quedó muerta y su
-- comentario describía una función que no era la que corría. Lo cazó la revisión.

-- ─────────────────────────────────────────────────────────────────────────────
-- H-R4 — Un grupo sin owner activo no admite nuevas solicitudes.
--
-- Se reescribe `request_join` entera —`create or replace` no admite parches— y el único cambio
-- respecto a la versión anterior es la comprobación del owner activo, marcada abajo.
create or replace function public.request_join(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_group uuid; v_status public.member_status;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select i.group_id into v_group from public.group_invites i
   where i.token = p_token and i.revoked_at is null and i.expires_at > now();
  -- Token inexistente, malformado, caducado o revocado: misma respuesta (borde 1 y 9).
  if v_group is null then return jsonb_build_object('status','invalid'); end if;

  -- H-R4 — **El único añadido.** Un grupo borrado no tiene owner activo, y sin esto un link vivo
  -- readmitiría gente a un grupo muerto donde nadie puede aprobar. Se contesta `invalid`, igual que
  -- un token caducado: distinguir los dos casos le confirmaría a un desconocido que ese grupo
  -- existió (§A.1). Falla cerrado.
  if not exists (
    select 1 from public.group_members m
     where m.group_id = v_group and m.role = 'owner' and m.status = 'active'
  ) then
    return jsonb_build_object('status','invalid');
  end if;

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

grant execute on function public.transfer_group(uuid,uuid) to authenticated;
grant execute on function public.delete_group(uuid)        to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Privilegios: revocar el `execute` implícito a `PUBLIC`.
--
-- Postgres concede `EXECUTE` a `PUBLIC` en toda función nueva, y `anon` hereda de ahí. Sin estas dos
-- líneas, **un visitante sin sesión podría invocar `transfer_group` y `delete_group`** — las
-- funciones fallarían al no encontrar `auth.uid()`, pero la superficie estaría abierta y §A.3 manda
-- cerrar por defecto. Lo cazó `unit/grants.test.ts` › «sólo invite_preview es invocable por anon», que
-- existe exactamente para esto.
revoke all on function public.transfer_group(uuid,uuid) from public, anon;
revoke all on function public.delete_group(uuid)        from public, anon;

-- ─────────────────────────────────────────────────────────────────────────────
-- `groups.deleted_at` — y esto contradice el «fuera de alcance» de la spec, con su motivo medido.
--
-- La spec decía que no habría `deleted_at` en `groups`, razonando que el acceso ya se cierra por las
-- membresías. Eso sigue siendo verdad y no basta: `unit/create-group.test.ts` › «no existe ningún
-- grupo sin owner activo» vigila el invariante central del dominio, y **un grupo borrado es, por esa
-- definición, un grupo huérfano**. Medido: 16 grupos la pusieron roja en la primera corrida. Sin un
-- marcador, «borrado a propósito» y «huérfano por un defecto» son indistinguibles, y la guarda se
-- vuelve incomprobable — que es peor que no tenerla, porque alguien la relajaría.
--
-- **No es una puerta y no abre un deshacer.** `is_active_member` no lo consulta, ninguna política lo
-- menciona y ninguna vista lo lee: el acceso se cierra donde se cerraba, por las membresías (§B.1
-- intacta). Es un marcador para que el invariante siga siendo comprobable, y nada más.
alter table public.groups add column if not exists deleted_at timestamptz;

create or replace function public.delete_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid());
begin
  if not exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = v_uid and m.role = 'owner'
  ) then
    raise exception 'only the owner can delete' using errcode = '42501';
  end if;

  update public.group_members m
     set status = 'removed', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.status in ('active', 'pending');

  update public.group_invites i
     set revoked_at = now()
   where i.group_id = p_group_id and i.revoked_at is null;

  -- El marcador. `coalesce` para que un reintento no mueva la hora: la primera vez es la que cuenta.
  update public.groups g
     set deleted_at = coalesce(g.deleted_at, now())
   where g.id = p_group_id;
end;
$$;

revoke all on function public.delete_group(uuid) from public, anon;
grant execute on function public.delete_group(uuid) to authenticated;
