-- Spec F — La clave de deduplicación del envío, en su propia columna.
--
-- El problema: `items_nombre_unico` es PARCIAL (`WHERE deleted_at IS NULL`), así que un
-- reenvío de una fila de la cola deja de chocar en cuanto alguien tacha el producto, e
-- inserta: lo que el usuario quitó vuelve. El hueco es estructural — la baja local va
-- después del `await` del envío—, así que no lo cierra ningún booleano del cliente.
--
-- Por qué una columna nueva y no `items.id`: la clave primaria es autoridad del servidor y
-- el cliente no la escribe, declarado en la matriz de privilegios y con su guarda
-- (`unit/grants.test.ts` › «un miembro no puede reescribir el id de un ítem»). El cliente
-- manda **intención** —«ésta es mi fila de la cola»—, no autoridad (§B.5).
--
-- Por qué NO parcial: es justo lo que le falta al índice de nombre. Rechaza el reenvío
-- también con la fila anterior tachada.
--
-- Por qué `(group_id, origen_id)` y no `origen_id` solo: acota la clave al grupo, y con eso
-- el borde de «un uuid que ya existe en otro grupo» deja de existir en vez de aceptarse.
--
-- Las filas que ya existen quedan en NULL, y los NULL son distintos entre sí bajo un índice
-- único: medido, tres NULL conviven. Ninguna fila se toca, ninguna se rellena.
alter table public.items add column if not exists origen_id uuid;

create unique index if not exists items_origen_unico
  on public.items (group_id, origen_id);

-- Lo que este fichero concede, declarado en el formato que la guarda AC8 compara con el
-- catálogo. INSERT y SELECT, no UPDATE: el cliente pone la clave al enviar y la lee de vuelta,
-- pero no la reescribe — igual que la primaria, y por el mismo motivo.
--
--   INSERT: `origen_id`. Nada más.
--

grant insert (origen_id), select (origen_id) on public.items to authenticated;
