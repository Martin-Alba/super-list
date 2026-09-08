import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { newUser, newGroup, sql } from './helpers'

/**
 * J2 / K5 — RLS gobierna SELECT, INSERT, UPDATE y DELETE, pero **no** gobierna
 * TRUNCATE. R16 se apoyaba sólo en la ausencia de política DELETE, y eso deja
 * fuera el único comando capaz de vaciar una tabla publicada sin pasar por
 * ninguna política.
 *
 * K5 — la versión anterior afirmaba sobre el conjunto DISTINCT de privilegios,
 * así que un `grant update on group_members` la pasaba entera. Ahora se fija la
 * matriz completa: rol, tabla y privilegio.
 */
const MATRIZ_ESPERADA = [
  'authenticated|group_invites|SELECT',
  'authenticated|group_members|SELECT',
  'authenticated|groups|SELECT',
  // Y1 — `items` ya no tiene INSERT/UPDATE a nivel de TABLA: se revocaron para
  // conceder por columna, porque `updated_at` y `created_at` son autoridad del
  // servidor. El SELECT sigue siendo de tabla. La matriz de columnas se afirma
  // aparte, y es la que ahora manda.
  'authenticated|items|SELECT',
  'authenticated|profiles|SELECT',
]

/**
 * guarda-borrado: sonda RLS. Este fichero INTENTA borrar a propósito, con el
 * token del usuario, para comprobar que la base lo deniega — y afirma que la
 * fila sigue existiendo. No es un borrado del arnés: es la prueba de que no
 * se puede borrar. Sin esta marca, `unit/harness-no-delete.test.ts` lo trata
 * como infracción, que es lo correcto por defecto.
 */
describe('J2/K5 los roles de cliente no pueden destruir tablas', () => {
  it('la matriz de privilegios es exactamente la declarada', async () => {
    const rows = await sql<{ fila: string }>(`
      select grantee || '|' || table_name || '|' || privilege_type as fila
        from information_schema.role_table_grants
       where table_schema = 'public' and grantee in ('anon','authenticated')
       order by 1`)
    expect(rows.map(r => r.fila)).toEqual(MATRIZ_ESPERADA)
  })

  /**
   * Y1 / DoD 74 — Donde vive ahora la autoridad. El cliente no puede escribir
   * `updated_at` ni `created_at`: son la clave con la que la vista decide quién
   * gana al fusionar, y dejarlas escribibles permitía envenenar una fila para que
   * la primera edición de cualquiera se revirtiera en pantalla.
   */
  it('el cliente no puede escribir las columnas de hora de items', async () => {
    const rows = await sql<{ fila: string }>(`
      select privilege_type || ':' || string_agg(column_name, ',' order by column_name) as fila
        from information_schema.column_privileges
       where table_name = 'items' and grantee = 'authenticated'
       group by privilege_type order by 1`)
    expect(rows.map(r => r.fila)).toEqual([
      'INSERT:created_by,group_id,name,quantity',
      'SELECT:created_at,created_by,deleted_at,group_id,id,name,quantity,updated_at',
      'UPDATE:created_by,deleted_at,group_id,name,quantity',
    ])
  })

  // Z1 / DoD 82 — la clave primaria no la reescribe el cliente.
  it('un miembro no puede reescribir el id de un ítem', async () => {
    const owner = await newUser('pk'); const gid = await newGroup(owner)
    const { data: fila } = await owner.client.from('items')
      .insert({ group_id: gid, name: 'pan', created_by: owner.id }).select('id').single()
    /**
     * AA1 — Esto apuntaba a un uuid **fijo** que ya existía en la base — lo dejó
     * mi propio experimento de R-C —, así que fallaba por `23505` y pasaba igual
     * con el privilegio devuelto: no podía ponerse rojo por lo que nombra.
     */
    const { error } = await owner.client.from('items')
      .update({ id: randomUUID() }).eq('id', fila!.id)
    expect(error?.code, 'el cliente reescribió la clave primaria').toBe('42501')
  })

  it('anon no conserva ningún privilegio', async () => {
    const rows = await sql(`
      select 1 from information_schema.role_table_grants
       where table_schema='public' and grantee='anon'`)
    expect(rows).toEqual([])
  })

  it('un TRUNCATE como anon es rechazado por privilegio, no por política', async () => {
    await expect(
      // borrado-permitido: sonda RLS — intenta borrar para comprobar que la base lo deniega
      sql(`set local role anon; truncate public.items;`),
    ).rejects.toThrow(/permission denied|must be owner/i)
  })

  it('un DELETE como authenticated también se rechaza por privilegio', async () => {
    await expect(
      // borrado-permitido: sonda RLS — intenta borrar para comprobar que la base lo deniega
      sql(`set local role authenticated; delete from public.items;`),
    ).rejects.toThrow(/permission denied/i)
  })

  /**
   * K12 / DoD 60 — el rol que crea las tablas en estas migraciones es
   * `postgres`; su entrada en `pg_default_acl` es la que gobierna de verdad lo
   * que hereda una tabla nueva. La de `supabase_admin` no se puede tocar desde
   * una migración que corre como `postgres`, y queda registrado en la spec.
   */
  // L2 / DoD 63 — la version anterior filtraba `defaclobjtype='r'`: sólo
  // tablas. Medido: la fila de funciones concedia EXECUTE a anon por defecto,
  // asi que toda funcion nueva en `public` nacia invocable por un anonimo. Era
  // el principio de J2 sin aplicar justo donde su propia guarda no miraba.
  it.each([['r', 'tablas'], ['f', 'funciones'], ['S', 'secuencias']])(
    'el rol que crea los objetos no concede nada por defecto sobre %s (%s)', async (tipo) => {
      const rows = await sql<{ acl: string }>(`
        select unnest(d.defaclacl)::text as acl
          from pg_default_acl d
          join pg_roles r on r.oid = d.defaclrole
          join pg_namespace n on n.oid = d.defaclnamespace
         where n.nspname='public' and d.defaclobjtype=$1 and r.rolname='postgres'`, [tipo])
      const paraClientes = rows.map(r => r.acl)
        .filter(a => a.startsWith('anon=') || a.startsWith('authenticated='))
      expect(paraClientes).toEqual([])
    })

  it('sólo invite_preview es invocable por anon, y a propósito', async () => {
    const rows = await sql<{ proname: string }>(`
      select p.proname from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and has_function_privilege('anon', p.oid, 'EXECUTE')
       order by 1`)
    expect(rows.map(r => r.proname)).toEqual(['invite_preview'])
  })
})

/**
 * AC8 / DoD 110 — El texto de la migración y el privilegio se habían separado ya
 * dos veces: la iteración 8 lo arregló y la 10 lo reintrodujo en el mismo
 * fichero. Un comentario que miente sobre lo que concede un `grant` es peor que
 * no tenerlo, porque el siguiente que lo lea no irá a mirar el catálogo.
 *
 * Así que el comentario se compara con la base, no con la memoria de nadie.
 */
describe('AC8 el texto de la migración dice lo que hace el grant', () => {
  const SQL = readFileSync('supabase/migrations/20260908000300_autoridad_hora.sql', 'utf8')

  const declaradas = (verbo: 'INSERT' | 'UPDATE'): string[] => {
    const m = new RegExp(`^--\\s+${verbo}: (.+?)(?=\\n--\\s*\\n)`, 'ms').exec(SQL)
    if (!m) throw new Error(`el comentario no declara las columnas de ${verbo}`)
    return [...m[1].matchAll(/`([a-z_]+)`/g)].map(x => x[1]).sort()
  }

  const concedidas = (verbo: string, sql: string): string[] => {
    const m = new RegExp(`grant ${verbo.toLowerCase()} \\(([^)]+)\\)`, 'i').exec(sql)
    return m![1].split(',').map(c => c.trim()).sort()
  }

  it.each(['INSERT', 'UPDATE'] as const)('el comentario de %s casa con su grant', (verbo) => {
    expect(declaradas(verbo), `el texto de ${verbo} no dice lo que concede`)
      .toEqual(concedidas(verbo, SQL))
  })

  it('y las dos casan con el catálogo de la base', async () => {
    const rows = await sql<{ privilege_type: string; column_name: string }>(
      `select privilege_type, column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'items' and grantee = 'authenticated'
         and privilege_type in ('INSERT', 'UPDATE')`)
    for (const verbo of ['INSERT', 'UPDATE'] as const) {
      const enLaBase = rows.filter(r => r.privilege_type === verbo).map(r => r.column_name).sort()
      expect(enLaBase, `${verbo}: la base no concede lo que el comentario declara`)
        .toEqual(declaradas(verbo))
    }
  })
})
