import { describe, it, expect } from 'vitest'
import { sql } from './helpers'

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
  'authenticated|items|INSERT',
  'authenticated|items|SELECT',
  'authenticated|items|UPDATE',
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
