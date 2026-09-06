import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

/**
 * B.1 — la pertenencia se resuelve en `is_active_member`, nunca consultando
 * `group_members` desde su propia política: eso produce `42P17` y deja la app
 * inservible. Postgres renderiza el mismo SQL de varias formas, y la guarda
 * tiene que reconocerlas todas.
 */
export function consultaSuPropiaTabla(expr: string | null | undefined): boolean {
  if (!expr) return false
  return /from\s*\(?\s*(?:"?public"?\s*\.\s*)?"?group_members"?/i.test(expr)
}

// R11 — la política ingenua (subconsulta sobre la propia tabla) lanza 42P17
// y deja la app inservible.
describe('R11 pertenencia sin recursión', () => {
  it('consultar group_members como miembro activo no lanza 42P17', async () => {
    const owner = await newUser('rec'); const gid = await newGroup(owner)
    const { error } = await owner.client.from('group_members').select('*').eq('group_id', gid)
    expect(error).toBeNull()
  })

  it('toda función SECURITY DEFINER fija search_path', async () => {
    const rows = await sql(`
      select p.proname, p.proconfig
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname='public' and p.prosecdef`)
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.proconfig, `${r.proname} sin search_path fijado`).toBeTruthy()
      expect(String(r.proconfig)).toContain('search_path=')
    }
  })

  it('ninguna política consulta group_members en su propio USING ni WITH CHECK', async () => {
    const rows = await sql<{ policyname: string; qual: string | null; with_check: string | null }>(`
      select policyname, qual, with_check from pg_policies
       where schemaname='public' and tablename='group_members'`)
    // Sin esta guarda el test pasaría recorriendo un conjunto vacío: una base
    // sin políticas no viola la regla, pero tampoco la cumple.
    expect(rows.length, 'group_members no tiene ninguna política').toBeGreaterThan(0)
    for (const r of rows) {
      expect(consultaSuPropiaTabla(r.qual), `${r.policyname} (USING)`).toBe(false)
      expect(consultaSuPropiaTabla(r.with_check), `${r.policyname} (WITH CHECK)`).toBe(false)
    }
  })

  // Sonda R-B / DoD 68 — la versión anterior era `/from\s+group_members/i` y la
  // forma de join la atravesaba: Postgres la renderiza con un paréntesis entre
  // `FROM` y el nombre. Un guarda de una decisión congelada (B.1) que se
  // esquiva escribiendo la política de otra forma no guarda nada.
  it('DoD 68: la guarda caza la política escrita como join', () => {
    const comoJoin = '(EXISTS (SELECT 1 FROM (group_members m JOIN group_members o ON ((o.group_id = m.group_id)))))'
    const comoSubconsulta = '(EXISTS (SELECT 1 FROM group_members m WHERE (m.user_id = auth.uid())))'
    const calificada = '(EXISTS (SELECT 1 FROM public.group_members m))'
    const entrecomillada = '(EXISTS (SELECT 1 FROM "public"."group_members" m))'
    for (const forma of [comoJoin, comoSubconsulta, calificada, entrecomillada]) {
      expect(consultaSuPropiaTabla(forma), forma).toBe(true)
    }
  })

  it('DoD 68: y no salta con una política legítima', () => {
    expect(consultaSuPropiaTabla('((user_id = auth.uid()) OR is_active_member(group_id))')).toBe(false)
    expect(consultaSuPropiaTabla(null)).toBe(false)
  })
})
