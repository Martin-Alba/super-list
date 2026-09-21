-- Spec J / J-R1 — La cantidad es un entero de 1 a 99, o nada, y **lo hace cumplir la base**
-- (§D.2), no el formulario.
--
-- ORDEN OBLIGATORIO: primero NORMALIZAR, después RESTRINGIR. No es una precaución, está
-- medido: contra la base local (42.232 ítems, 2.762 cantidades sucias en 16 formas), sin el
-- `update` el `add constraint` es RECHAZADO —«check constraint is violated by some row»—. En
-- el proyecto hospedado no hay ninguna fila que normalizar, así que una migración escrita
-- sólo para allí habría pasado todas las comprobaciones y reventado aquí.
--
-- Lo que el orden compra, dicho como propiedad: **la migración no depende del estado de la
-- base.** Se aplica igual sobre datos limpios que sucios, y eso es lo que hace que
-- `unit/migrations.test.ts` › «desde cero» signifique algo.
--
-- Y cierra la ventana de §6: entre desplegar el código y aplicar esto, una cola antigua de
-- un dispositivo puede haber colado texto. El `update` lo recoge.

-- 0. Quitar una definición previa, ANTES de normalizar.
--
-- i1-R9 — Estaba abajo, junto al `add`, y eso hacía falsa la propiedad que la cabecera de
-- este fichero reclama. Medido: con un `items_quantity_num` previo más estrecho, el `update`
-- del paso 1 muere —«violates check constraint»— y la migración no llega a tocar nada. Una
-- migración que sólo aplica si la base está como ella espera es una suposición, que es
-- justamente lo que el orden normalizar→restringir venía a quitar.
alter table public.items drop constraint if exists items_quantity_num;

-- 1. Normalizar lo que ya está escrito.
--
-- La regla, en palabras: (a) dígitos, separador decimal —punto o coma— y dígito → vacío;
-- (b) si no, el entero inicial de 1 a 99 seguido de no-dígito o de final → ese número;
-- (c) si no → vacío.
--
-- (a) existe por el mismo motivo que `299` no se trunca a `29`: `1.5` no es un entero, y
-- convertirlo en `1` es inventar otro dato — en una lista de la compra son 1,5 kilos.
--
-- Su gemela en TypeScript es `normalizar` de `lib/cantidad.ts`, y la expresión de aquí abajo
-- la extrae `unit/cantidad.test.ts` entre los dos marcadores para comparar los dos lados
-- caso por caso. Si se mueven los marcadores, esa guarda falla en vez de callarse.
update public.items
   set quantity =
       -- cantidad:normalizar:inicio
       case when quantity ~ '^[0-9]+[.,][0-9]' then null
            else substring(quantity from '^([1-9][0-9]?)(?:[^0-9]|$)') end
       -- cantidad:normalizar:fin
 where quantity is not null and quantity !~ '^[1-9][0-9]?$';

-- 2. Restringir. Forward-only e idempotente (§C).
--
-- `check` sobre la columna de texto, sin cambio de tipo: compatible hacia atrás por
-- construcción, sin reescritura de tabla, y `items_quantity_len` se conserva.
--
-- El regex no lleva cast a propósito: `^[1-9][0-9]?$` ya *es* exactamente 1..99, así que no
-- hace falta un `::int` que la base pudiera evaluar antes que la guarda que lo protege.
-- Rechaza `0`, `00`, `007`, `100`, `-3`, ` 5` y `5 `.
-- El `check` va entre marcadores por el mismo motivo que la normalización: `unit/cantidad.test.ts`
-- lo extrae **de este fichero** y le pasa la tabla de casos. Antes sólo se leía del catálogo de la
-- base local, así que ensanchar el regex de aquí a `^[1-9][0-9]{0,2}$` dejaba la suite entera
-- verde — medido por el review— y el artefacto que llega a producción no se comparaba con nada.
alter table public.items add constraint items_quantity_num
  -- cantidad:check:inicio
  check (quantity is null or quantity ~ '^[1-9][0-9]?$')
  -- cantidad:check:fin
  ;
