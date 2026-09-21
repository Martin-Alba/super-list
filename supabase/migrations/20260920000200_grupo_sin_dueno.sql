-- Spec H / iteración 1 — Cerrar las dos carreras que la base dejó abiertas.
--
-- Forward-only e idempotente: `create or replace function`.

-- ─────────────────────────────────────────────────────────────────────────────
-- i1-R1 · CRITICAL — `decide_member` no puede quitar una fila de owner.
--
-- **La spec predijo esta carrera y yo la cerré a medias.** Su respuesta construida nº 1 decía que
-- entre la comprobación de pertenencia y su escritura cabe un `decide_member` concurrente. Cerré el
-- hueco en `transfer_group` —la comprobación del destinatario vive en el `where` de su `update`— y
-- dejé abierto el de `decide_member`, que es la otra mitad exacta.
--
-- Medido por la revisión con dos sesiones de psql:
--   S1: begin; transfer_group(G, B);            -- sin confirmar
--   S2: decide_member(G, B, 'removed');         -- su is_group_owner ve al viejo owner: pasa
--   S1: commit;
--   S2: se desbloquea. EvalPlanQual re-evalúa la fila de B, que ahora es `role='owner'` y
--       `status='active'`, y la expulsa.
-- Resultado: grupo **vivo** (`deleted_at` nulo) con **cero owners activos**, un miembro activo
-- atrapado sin nadie que pueda aprobarle nada, y `owner_id` apuntando a un expulsado. Ni la interfaz
-- ni ninguna función pueden repararlo. Los dos botones que lo producen están en la misma fila de la
-- pantalla, uno al lado del otro.
--
-- **El arreglo va en el `where`, no en un `if`.** Un `if` previo tiene el mismo problema que la
-- puerta que ya falló: se evalúa contra un snapshot viejo. El `where` de un `update` bloqueado se
-- **re-evalúa entero** contra la versión nueva de la fila cuando la transacción que la tenía
-- confirma — eso es EvalPlanQual—, así que `role <> 'owner'` ve el rol nuevo y la fila deja de
-- casar. La guarda es estructural, no una comprobación más.
--
-- Nota sobre el índice parcial de la migración anterior: impide **dos** owners activos, y no puede
-- impedir **cero** — un índice único no habla de ausencia. El «cero» se cierra haciendo que ninguna
-- ruta de expulsión acepte una fila de owner, que es esto.
create or replace function public.decide_member(p_group_id uuid, p_user_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
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
     -- i1-R1 — El único añadido, y cierra la carrera de arriba.
     and m.role <> 'owner'
     and case p_decision
           when 'active'   then m.status = 'pending'
           when 'rejected' then m.status = 'pending'
           when 'removed'  then m.status = 'active'
         end;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- i1-R2 — Borrar y solicitar no pueden cruzarse.
--
-- Medido: S1 abre `delete_group` sin confirmar; S2 ejecuta `request_join` con un token vivo, ve la
-- invitación **sin revocar** y al owner **activo**, e inserta `pending`; S1 confirma y su `update` ya
-- había pasado de largo. Queda un `pending` esperando a un owner que no existe, sobre un grupo
-- borrado. Y ningún barrido lo caza, porque `deleted_at` excluye al grupo de la guarda de huérfanos.
--
-- Las dos serializan sobre **la misma fila**: la del owner del grupo. `delete_group` la bloquea antes
-- de tocar nada; `request_join` la bloquea antes de decidir si el grupo está vivo. La que llegue
-- segunda espera y **vuelve a leer**, así que ve el mundo que dejó la primera.
--
-- `for update` y no `for share`: las dos escriben en función de lo que leen. Y sobre `group_members`
-- y no sobre `groups`, porque la fila de owner es la que las dos consultan para decidir.
create or replace function public.delete_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_owner uuid;
begin
  -- Bloquea la fila de owner **y** comprueba la autoridad en la misma lectura.
  select m.user_id into v_owner from public.group_members m
   where m.group_id = p_group_id and m.user_id = v_uid and m.role = 'owner'
   for update;
  if v_owner is null then
    raise exception 'only the owner can delete' using errcode = '42501';
  end if;

  update public.group_members m
     set status = 'removed', decided_at = now(), decided_by = v_uid
   where m.group_id = p_group_id and m.status in ('active', 'pending');

  update public.group_invites i
     set revoked_at = now()
   where i.group_id = p_group_id and i.revoked_at is null;

  update public.groups g
     set deleted_at = coalesce(g.deleted_at, now())
   where g.id = p_group_id;
end;
$$;

create or replace function public.request_join(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_uid uuid := (select auth.uid()); v_group uuid; v_status public.member_status; v_owner uuid;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select i.group_id into v_group from public.group_invites i
   where i.token = p_token and i.revoked_at is null and i.expires_at > now();
  if v_group is null then return jsonb_build_object('status','invalid'); end if;

  -- H-R4 + i1-R2 — La pregunta «¿tiene este grupo un owner activo?» se hace **bloqueando** la fila
  -- que la contesta. Sin `for update`, un `delete_group` sin confirmar la deja pasar y el `pending`
  -- entra en un grupo que va a estar borrado un milisegundo después.
  -- Se contesta `invalid`, igual que un token caducado: distinguirlo le confirmaría a un desconocido
  -- que ese grupo existió (§A.1).
  select m.user_id into v_owner from public.group_members m
   where m.group_id = v_group and m.role = 'owner' and m.status = 'active'
   for update;
  if v_owner is null then return jsonb_build_object('status','invalid'); end if;

  select m.status into v_status from public.group_members m
   where m.group_id = v_group and m.user_id = v_uid;

  if v_status = 'active' then
    return jsonb_build_object('status','active','group_id',v_group);
  end if;

  insert into public.group_members (group_id, user_id, status)
  values (v_group, v_uid, 'pending')
  on conflict (group_id, user_id) do update
    -- i1-R7 — **También el rol.** Esta spec crea por primera vez filas `role='owner'` con
    -- `status='removed'` (el owner de un grupo borrado). Una readmisión futura de una de ellas
    -- devolvería la propiedad en silencio. Hoy no es alcanzable —`delete_group` revoca las
    -- invitaciones—, pero la forma peligrosa la crea esta misma spec, y una palabra la cierra sin
    -- depender de que nadie abra un camino nuevo.
    set status = 'pending', role = 'member', requested_at = now(), decided_at = null, decided_by = null
    where public.group_members.status in ('rejected','removed');

  return jsonb_build_object('status','pending','group_id',v_group);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- i1-R7 — `transfer_group`: quitar el `if` redundante y hacerla idempotente.
--
-- El `if not is_group_owner(...)` previo era **exactamente** el `where` del `update` de degradación
-- (`user_id = v_uid and role='owner' and status='active'`), que ya levanta el mismo 42501 con el
-- mismo mensaje. Dos sitios decidiendo la autoridad en una función cuyo comentario argumenta que la
-- autoridad se decide en un solo sitio.
--
-- Y la idempotencia, que es la lección que la iteración base aplicó a `delete_group` y no a su
-- gemela: con `RPC_TIMEOUT_MS` de 10 s, un aborto **después** del commit deja al cliente creyendo que
-- falló. Su reintento daba `42501` sobre algo que sí funcionó. Ahora, si el destinatario ya es el
-- owner activo, la función vuelve sin decir nada.
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

  -- Idempotencia, **y quién la puede reclamar**. La primera versión de esta guarda preguntaba sólo
  -- «¿es ya el destinatario el owner activo?», y con eso un **desconocido** que llamara a
  -- `transfer_group` sobre un grupo ajeno recibía éxito silencioso: el atajo corría antes que
  -- cualquier puerta de autoridad. Lo cazó `h2` en la misma vuelta que lo introdujo, y es una
  -- regresión de seguridad que me inventé al juntar dos hallazgos —quitar el `if` redundante y hacer
  -- la función idempotente— sin mirar el orden en que quedaban.
  --
  -- Tras una transferencia, quien la hizo ya no es distinguible por su rol: queda `member`. Pero sí
  -- por `decided_by`, que la propia función escribe en la fila del nuevo owner. Así que el reintento
  -- silencioso es sólo para **quien la hizo**, y cualquier otro cae por la puerta de abajo.
  select exists (
    select 1 from public.group_members m
     where m.group_id = p_group_id and m.user_id = p_user_id
       and m.role = 'owner' and m.status = 'active'
       and m.decided_by = v_uid
  ) into v_ya;
  if v_ya then return; end if;

  -- Degradar antes de promover, por el índice parcial: al revés habría dos owners activos dentro de
  -- la transacción y el índice la abortaría. Y este `where` **es** la puerta de autoridad.
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
