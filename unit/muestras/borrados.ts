/**
 * Las muestras viven fuera de la guarda a propósito: cuando estaban dentro, una
 * de ellas activaba la excepción y la guarda **se eximía a sí misma** — el
 * fichero que hace cumplir la regla era el único sin vigilar.
 */
export const FORMAS_PROHIBIDAS: ReadonlyArray<readonly [string, string]> = [
  ['directa', "await admin.from('items').delete().eq('id', x)"],
  ['padre que cascadea', "await admin.from('groups').delete().eq('id', g)"],
  ['usuario que cascadea', 'await admin.auth.admin.deleteUser(userId)'],
  ['usuario con encadenado opcional', 'await admin.auth?.admin?.deleteUser(userId)'],
  ['usuario desestructurado', 'const { deleteUser } = admin.auth.admin'],
  ['usuario desestructurado y renombrado', 'const { deleteUser: quitar } = admin.auth.admin'],
  ['usuario por corchetes', "await admin.auth.admin['deleteUser'](id)"],
  ['sql crudo', "await sql('delete from public.group_members where id = $1', [x])"],
  ['sql entrecomillado', 'await sql(`delete from "public"."items"`)'],
  ['sql por concatenación', "await pool.query('del' + 'ete from public.items')"],
  ['truncate por concatenación', "await pool.query('trun' + 'cate public.items')"],
  ['truncate', "await sql('truncate table public.items cascade')"],
  ['tabla en variable', "await admin.from(TABLA).delete().eq('id', x)"],
  ['encadenado en varias líneas', "admin\n  .from('items')\n  .delete()\n  .eq('id', x)"],
  ['delete lejos de su from', "await admin.from('items').select('a').eq('b', 1).eq('c', 2).eq('d', 3).eq('e', 4).eq('f', 5).eq('g', 6).eq('h', 7).eq('i', 8).eq('j', 9).eq('k', 10).delete()"],
  ['rpc desconocida', "await admin.rpc('reset_banco', {})"],
  ['rpc con nombre inocuo', "await admin.rpc('vaciar_items', {})"],
  ['rpc dinámica', 'await admin.rpc(nombreFuncion, {})'],
  ['fetch con method DELETE', "await fetch(url, { method: 'DELETE' })"],
  ['fetch con method en minúsculas', "await fetch(url, { method: 'delete' })"],
]

/**
 * Z10 — Formas **legítimas**. Sin ellas la guarda no distingue "detecta" de
 * "detecta todo": las cuatro primeras las cazaba la versión de patrones de
 * texto, y `next.delete(item.id)` existe hoy en `GroupView.tsx`.
 */
export const FORMAS_LEGITIMAS: ReadonlyArray<readonly [string, string]> = [
  ['borrado suave', "await admin.from('items').update({ deleted_at: ahora }).eq('id', x)"],
  ['Set.delete declarado en el fichero', "const next = new Set(prev); const r = admin.from('items'); next.delete(item.id)"],
  ['Map.delete declarado en el fichero', 'const cache = new Map(); cache.delete(k)'],
  ['borrar una clave de un objeto', 'delete opciones.cabecera'],
  ['la palabra truncate en una cadena', "const nota = 'no uses truncate en el arnés'"],
  ['la palabra delete en prosa', "const t = 'no se permite delete from aquí'"],
  ['removeChannel', 'await admin.removeChannel(canal)'],
  ['rpc del producto', "await cli.rpc('decide_member', { p_group_id: g })"],
  ['method distinto de DELETE', "await fetch(url, { method: 'POST' })"],
]

/** Formas legítimas en SQL que no deben cazarse (Z10). */
export const SQL_LEGITIMO: ReadonlyArray<readonly [string, string]> = [
  ['grant con truncate', 'grant select, truncate on public.items to postgres;'],
  ['revoke con truncate', 'revoke truncate on public.items from anon;'],
  ['comentario que menciona el borrado', '-- aquí nunca un delete from public.items'],
  ['prosa dentro de un literal', "comment on table public.items is 'nunca delete from aquí';"],
  ['política para DELETE', 'create policy p on public.items for delete using (false);'],
]

/** Formas peligrosas en SQL, incluida la que cegaba al despojador (Z3). */
export const SQL_PROHIBIDO: ReadonlyArray<readonly [string, string]> = [
  ['borrado directo', 'delete from public.items where id = 1;'],
  ['tras un literal con dos guiones', "insert into t(nota) values ('-- ojo'); delete from public.items;"],
  ['truncate', 'truncate table public.group_members;'],
  ['dentro de un cuerpo con etiqueta', 'create function f() returns void as $$ begin delete from public.items; end $$ language plpgsql;'],
]

/** La forma que se inyecta tras el literal de regex (DoD 79). */
export const INYECCION = "; await admin.from('items').delete().eq('id', x)"

/** La marca de excepción retirada: escribirla ya no exime nada. */
export const MARCA_RETIRADA = "// guarda-borrado: sonda\nawait admin.from('items').delete().eq('id', x)"

/** AA4 — la marca delante de un borrado NUEVO: no exime (DoD 96). */
export const MARCA_ANTES_DE_BORRADO_NUEVO =
  "// borrado-permitido: sonda RLS\nawait admin.from('items').delete().eq('id', 1)"

/** …y la línea que de verdad deniega, que sí queda exenta. */
export const MARCA_EN_LA_LINEA_QUE_DENIEGA =
  "// borrado-permitido: sonda RLS\nawait sql('delete from public.items')"

/** AA1 — receptor en variable y tipo asertado: las dos puertas que quedaban. */
export const FORMAS_INDIRECTAS: ReadonlyArray<readonly [string, string]> = [
  ['receptor en variable', "const f = admin.from('items'); await f.delete()"],
  ['tipo asertado', "await (admin.from('items') as unknown as Q).delete()"],
  ['satisfies', "await (admin.from('items') satisfies Q).delete()"],
  ['receptor de otro sitio', 'await tabla.delete()'],
  ['pg con objeto de configuración', "await pool.query({ text: 'delete from public.items', values: [x] })"],
  ['sql en constante local', "const q = 'delete from public.items'; await pool.query(q)"],
  ['method computado', "await fetch(u, { ['method']: 'DELETE' })"],
  ['method en constante', "const m = 'DELETE'; await fetch(u, { method: m })"],
]

/** AA3 — las dos formas SQL que se colaban por la palabra `grant`. */
export const SQL_PROHIBIDO_INDIRECTO: ReadonlyArray<readonly [string, string]> = [
  ['grant sin punto y coma delante', 'grant select on public.items to anon\ndelete from public.items where id=1;'],
  ['grant en un comentario dentro de $$', 'create function f() returns void as $$ begin -- grant nada\n delete from public.items; end $$ language plpgsql;'],
]

/**
 * AB2 / DoD 103 — Código correcto que el fallo cerrado marcaba en rojo. Medido
 * por la revisión sobre React/Next normal: la spec siguiente toca cookies y
 * `searchParams` el primer día, así que esto habría bloqueado la puerta.
 */
export const PLATAFORMA_LEGITIMA: ReadonlyArray<readonly [string, string]> = [
  ['searchParams', "const url = new URL(r.url); url.searchParams.delete('code')"],
  ['cookies de Next', "cookies().delete('sb-auth')"],
  ['cookies de la respuesta', "res.cookies.delete('sb-auth')"],
  ['headers', "req.headers.delete('cookie')"],
  ['formData', "datos.formData.delete('file')"],
  ['Set por parámetro', 'function quitar(vistos: Set<string>, id: string) { vistos.delete(id) }'],
  ['Map por parámetro', 'const f = (cache: Map<string, number>, k: string) => cache.delete(k)'],
]

/** AB1 / DoD 102 — el nombre reaparece declarado de otra forma: deja de estar demostrado. */
export const AMBITO_AMBIGUO =
  "const next = new Set(prev)\nnext.delete(x)\nconst next2 = 1\nconst next = admin.from('items')\nawait next.delete()"

/** U8 — sonda de la guarda de migraciones: SQL que sí borra. */
export const SQL_QUE_BORRA = 'delete from public.items where id = 1;'

/** V6 — las dos formas que se colaban, y son las naturales al escribir esto. */
export const SQL_CON_CTE =
  'with viejos as (select id from public.items) delete from public.items where id in (select id from viejos);'
/** W2 — la forma CANÓNICA de una deduplicación: paréntesis anidados. */
export const SQL_CON_CTE_ANIDADA =
  'with dup as (select id, row_number() over (partition by group_id order by created_at) r from public.items) ' +
  'delete from public.items where id in (select id from dup where r > 1);'
export const SQL_CON_DOS_CTE =
  'with a as (select 1), b as (select coalesce(2, 3)) delete from public.items where id = 1;'

export const SQL_DINAMICO =
  "do $$ begin execute 'delete from public.items where id = 1'; end $$;"

/** X3 — las cuatro formas que la revisión midió coladas. */
export const SQL_CTE_CON_COLUMNAS =
  'with dup(id, r) as (select id, row_number() over (partition by group_id) from public.items) ' +
  'delete from public.items where id in (select id from dup where r > 1);'
export const SQL_BUCLE_PLPGSQL =
  'do $$ begin for x in select id from public.items loop delete from public.items where id = x.id; end loop; end $$;'
export const SQL_IF_PLPGSQL =
  'do $$ begin if true then delete from public.items where id = 1; end if; end $$;'
export const SQL_EXECUTE_VARIABLE =
  "do $$ declare q text; begin q := 'delete from public.items'; execute q; end $$;"

/** Y7 — las ocho formas que la revisión midió coladas. */
export const SQL_MAS_FORMAS: [string, string][] = [
  ['case when', 'do $$ begin case when true then delete from public.items; end case; end $$;'],
  ['elsif', 'do $$ begin if false then null; elsif true then delete from public.items; end if; end $$;'],
  ['loop sin cabecera', 'do $$ begin loop delete from public.items; exit; end loop; end $$;'],
  ['foreach', 'do $$ begin foreach x in array a loop delete from public.items; end loop; end $$;'],
  ['exception when', 'do $$ begin null; exception when others then delete from public.items; end $$;'],
  ['execute por concatenación', "do $$ declare q text; begin q := 'del' || 'ete from public.items'; execute q; end $$;"],
  ['cuerpo de función como literal', "create function f() returns void as 'delete from public.items' language sql;"],
  ['merge', 'merge into public.items t using x on t.id = x.id when matched then delete;'],
]
