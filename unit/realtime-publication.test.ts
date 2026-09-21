import { describe, it, expect } from 'vitest'
import { sql } from './helpers'

// R12 — es el fallo silencioso: sin esto R9 y R7 no funcionan y ningún otro
// test se entera.
describe('R12 publicación realtime', () => {
  it('items y group_members están publicadas', async () => {
    const rows = await sql(
      `select tablename from pg_publication_tables where pubname='supabase_realtime' and schemaname='public'`)
    const names = rows.map(r => r.tablename).sort()
    expect(names).toContain('items')
    expect(names).toContain('group_members')
  })
})
