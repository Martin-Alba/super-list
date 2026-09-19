-- Spec F / iteración 1 · i1-R5 — El índice se acota a las filas que tienen clave.
--
-- Medido por la revisión: `items_origen_unico` guardaba 26.350 entradas NULL para 97 claves
-- reales, 1.056 kB. Los NULL no colisionan nunca bajo un índice único —comprobado—, así que
-- excluirlos no cambia el invariante en absoluto y quita ~99 % de las entradas.
--
-- **Los dos ejes no son el mismo, y confundirlos sería una regresión:** parcial sobre
-- `deleted_at` está PROHIBIDO —es lo que impediría volver a apuntar algo tachado, que es el
-- caso de uso central y lo dice la guarda de `items_nombre_unico`—; parcial sobre
-- `origen_id is not null` es gratis, porque una fila sin clave no participa de la
-- deduplicación por definición. La condición nueva no menciona `deleted_at`, y una fila
-- lo comprueba contra el catálogo.
--
-- Forward-only e idempotente: se recrea el índice con la condición. Quitar un índice no
-- toca ninguna fila.
drop index if exists public.items_origen_unico;

create unique index if not exists items_origen_unico
  on public.items (group_id, origen_id)
  where origen_id is not null;
