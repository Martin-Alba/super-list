-- Y1 — La hora es autoridad del servidor, y el cliente no puede escribirla.
--
-- X1 arregló *quién escribe la hora* (`clock_timestamp()` en vez de `now()`) y
-- dejó abierto *quién puede escribir la columna*. Verificado contra el catálogo:
-- el trigger era `before update` **únicamente**, y `authenticated` tenía `INSERT`
-- sobre `updated_at` y `created_at`.
--
-- Consecuencia medida: un miembro activo con un cliente HTTP inserta
-- `updated_at: '2999-01-01'` y la fila queda envenenada. A partir de ahí la
-- fusión de la vista (J6/W1) elige siempre la versión vieja, así que la primera
-- edición de cualquiera se revierte en pantalla hasta recargar. Es el síntoma de
-- W1 sobreviviendo a X1, y es B.5 literal: la autoridad la manda el cliente.

drop trigger if exists items_touch_updated_at on public.items;
create trigger items_touch_updated_at
  before insert or update on public.items
  for each row execute function public.touch_updated_at();

-- Un `revoke` por columna no muerde un `grant` de tabla: hay que retirar el de
-- tabla y conceder columna a columna.
--
-- AC8 — Lo que se concede, dicho exacto. Este párrafo describía la lista de
-- ANTES de AB8 —decía que el INSERT concedía `id` y `deleted_at` "por comodidad
-- de PostgREST"— mientras cuatro líneas más abajo el `grant` ya no los concedía.
-- Es el defecto de la iteración 8 ("el comentario de la migración decía lo
-- contrario") reaparecido en el mismo fichero, en el mismo diff que lo arreglaba.
--
--   INSERT: `group_id`, `name`, `quantity`, `created_by`. Nada más: son
--   exactamente las cuatro que escribe `lib/items.ts`.
--
--   UPDATE: `name`, `quantity`, `deleted_at` —las que la app escribe— y, **como
--   excepción declarada**, `group_id` y `created_by`, que no escribe. Se
--   conservan a propósito y la razón está abajo: el trigger items_guard las
--   protege con un mensaje que explica lo que pasa, y retirarlas por privilegio
--   lo cambiaría por un "no tienes acceso" menos cierto y menos accionable.
--
-- `unit/grants.test.ts` compara esta lista con el catálogo, así que el texto y el
-- privilegio no pueden volver a separarse sin que algo se ponga rojo.
revoke insert, update on public.items from authenticated;
-- AB8 — `id` y `deleted_at` salen también del INSERT: eran las dos últimas
-- columnas concedidas que la app no escribe. `id` daba un oráculo de existencia
-- por `23505` sobre un uuid adivinado, y un `deleted_at` al insertar creaba una
-- fila invisible. PostgREST no las necesita.
grant insert (group_id, name, quantity, created_by) on public.items to authenticated;
-- `created_by` y `group_id` siguen siendo escribibles en el UPDATE **a
-- propósito**: el trigger `items_guard` ya los protege, y con un mensaje que
-- explica lo que pasa ("created_by is immutable"). Quitarlos por privilegio
-- cambiaría ese aviso por un "no tienes acceso", que es menos cierto y menos
-- accionable — justo lo contrario de lo que esta spec vino a arreglar.
-- `id` NO entra: la app no lo escribe nunca y ningún trigger lo protege. Medido:
-- un miembro reescribía la clave primaria y el otro cliente, que indexa por `id`,
-- se quedaba con la fila vieja **y** la nueva — producto duplicado en pantalla con
-- una sola fila en la base; y una escritura en vuelo sobre el id viejo devolvía
-- cero filas, así que la vista decía "alguien lo quitó" borrando un ítem vivo.
grant update (group_id, name, quantity, created_by, deleted_at) on public.items to authenticated;
