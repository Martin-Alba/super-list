-- btrim(name) con un solo argumento sólo recorta ESPACIOS: un nombre hecho de
-- tabuladores o saltos de línea pasaba el CHECK. `~ '\S'` exige al menos un
-- carácter no-blanco, que es lo que R8 quiere decir por "no sólo espacios".
alter table public.items  drop constraint if exists items_name_check;
alter table public.items  add  constraint items_name_check  check (name ~ '\S');
alter table public.groups drop constraint if exists groups_name_check;
alter table public.groups add  constraint groups_name_check check (name ~ '\S');
