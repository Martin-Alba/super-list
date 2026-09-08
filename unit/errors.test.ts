import { describe, it, expect } from 'vitest'
import { claseDe, mensajeDe } from '../lib/errors'

/**
 * L5 / DoD 67 — `failed to fetch` es el texto del navegador; Node, en servidor,
 * produce `TypeError: fetch failed`. Sin las dos formas el fallo real del
 * servidor caia al mensaje generico, que no dice al usuario que reintentar.
 */
describe('L5 la traduccion de errores cubre el fallo de red del servidor', () => {
  it.each([
    'TypeError: fetch failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'The operation was aborted',
    'signal timed out',
  ])('%s se traduce como problema de conexion', (raw) => {
    expect(mensajeDe(claseDe({ message: raw }))).toContain('conexión')
  })

  it('una denegacion de RLS no se confunde con un problema de red', () => {
    const msg = mensajeDe(claseDe({ message: 'new row violates row-level security policy for table "items"' }))
    expect(msg).not.toContain('conexión')
    expect(msg).toContain('acceso')
  })

  it('nunca devuelve el texto crudo', () => {
    const crudo = 'new row violates row-level security policy for table "items"'
    expect(mensajeDe(claseDe({ message: crudo }))).not.toContain('row-level')
    expect(mensajeDe(claseDe({ message: crudo }))).not.toContain('items')
  })
})
