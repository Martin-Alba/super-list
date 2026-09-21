import { describe, it, expect } from 'vitest'
import { newUser, sql } from './helpers'

// R1 — si el perfil lo creara el código de la app, faltaría en cuanto
// alguien entrara por otro camino.
describe('R1 perfil creado por trigger', () => {
  it('dar de alta un usuario crea su fila en profiles', async () => {
    const u = await newUser('trigger')
    const rows = await sql('select id, display_name, avatar_url from public.profiles where id = $1', [u.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].display_name).toBe('Test trigger')
    expect(rows[0].avatar_url).toBe('https://example.test/a.png')
  })
})
