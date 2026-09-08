-- X1 — `updated_at` tiene que ORDENAR.
--
-- El trigger lo rellenaba con `now()`, que en Postgres es la hora de **inicio de
-- transacción**, no la de aplicación: dos escrituras concurrentes pueden recibir
-- el mismo valor, o incluso quedar invertidas respecto al orden en que la base
-- las aplicó. Medido con la forma de transacción de PostgREST y RLS activa:
-- **3 de 300 pares** acababan con un `updated_at` menor que el devuelto al otro
-- escritor **medido a resolución de milisegundo**; al comparar en microsegundos,
-- que es la precisión real de la columna, la tasa observada en seis tandas va de
-- **41 a 86 de cada 300**. Se da el rango medido y no un suelo: el suelo ya no
-- sobrevivió dos veces a la remedición.
--
-- Eso importa porque la vista decide con esa clave quién gana al fusionar la
-- respuesta de una escritura con lo que llega por el canal (J6, W1). Con la clave
-- invertida elige la fila vieja y revierte en pantalla el cambio correcto de otro
-- miembro, sin ningún evento posterior que lo repare.
--
-- `clock_timestamp()` es la hora de aplicación y avanza dentro de la transacción.
create or replace function public.touch_updated_at() returns trigger
language plpgsql
set search_path = ''
as $$
begin new.updated_at := clock_timestamp(); return new; end;
$$;
