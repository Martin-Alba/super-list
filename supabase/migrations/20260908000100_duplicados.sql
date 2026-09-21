-- R7 — Un producto que ya está en la lista se avisa, no se duplica.
--
-- La invariante la impone el ALMACÉN, no el cliente: comprobar antes de insertar
-- es el `check-then-act` que la constitución prohíbe, y no resuelve la carrera
-- real —dos personas añadiendo "cebolla" a la vez, ninguna ve todavía a la otra—.
-- Medido en el QA: quedaban dos filas. Con el índice, una entra y la otra recibe
-- 23505, que la interfaz traduce al mismo aviso.
--
-- Mismas letras, misma palabra: sin mayúsculas y sin tildes, con la Ñ como letra
-- propia — `piña` y `pina` NO son lo mismo en castellano, ni `año` y `ano`.
--
-- La normalización va **en línea** y no en una función propia. Se intentó con
-- `public.norm_nombre(text)` y se midió el precio: evaluar la expresión de un
-- índice comprueba el EXECUTE de las funciones que usa, así que la función tenía
-- que quedar ejecutable por `authenticated` — y con eso aparecía en la superficie
-- invocable por RPC, que es justo lo que la matriz de privilegios vigila. Al
-- quitarle el permiso, ningún miembro podía ya insertar un ítem. `translate`,
-- `lower` y `btrim` son inmutables y de `pg_catalog`: no hacen falta permisos ni
-- superficie nueva. `unaccent` tampoco sirve aquí: convierte la ñ en n.

-- El índice no se puede crear sobre los datos actuales: medido, ya hay nombres
-- repetidos. Se conserva el más antiguo de cada nombre y el resto se retira con
-- borrado SUAVE — un DELETE físico sobre `items` es un hard fail de B.3, y la
-- tabla está publicada en `supabase_realtime`.
update public.items i
   set deleted_at = now()
 where i.deleted_at is null
   and exists (
     select 1 from public.items j
      where j.deleted_at is null
        and j.group_id = i.group_id
        and translate(lower(btrim(j.name)),
              'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ',
              'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
          = translate(lower(btrim(i.name)),
              'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ',
              'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
        and (j.created_at, j.id) < (i.created_at, i.id)
   );

-- Parcial sobre `deleted_at is null`: volver a añadir algo que se borró debe
-- poder hacerse, y un índice total lo impediría para siempre.
create unique index if not exists items_nombre_unico
  on public.items (
    group_id,
    translate(lower(btrim(name)),
      'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ',
      'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')
  )
  where deleted_at is null;

