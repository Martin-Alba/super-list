import { describe, it, expect } from 'vitest'
import { claseDe, mensajeDe , refinarSinRed } from '../lib/errors'

/**
 * L5 / DoD 67 — `failed to fetch` es el texto del navegador; Node, en servidor,
 * produce `TypeError: fetch failed`. Sin las dos formas el fallo real del
 * servidor caia al mensaje generico, que no dice al usuario que reintentar.
 */
describe('L5 la traduccion de errores cubre el fallo de red del servidor', () => {
  /**
   * R1 — Estas cinco llegaban **sin código**, y antes se clasificaban leyendo su
   * texto. Ahora sin código decide la red: si está caída, es de la conexión; si
   * está bien, no contestó el servidor. Se afirma con la red caída, que es cuando
   * «no hay conexión» es cierto.
   */
  it.each([
    'TypeError: fetch failed',
    'Failed to fetch',
    'NetworkError when attempting to fetch resource',
    'The operation was aborted',
    'signal timed out',
  ])('%s sin red se traduce como problema de conexion', (raw) => {
    expect(mensajeDe(refinarSinRed(claseDe({ message: raw }), false))).toContain('conexión')
  })

  it.each([
    'TypeError: fetch failed',
    'The operation was aborted',
  ])('%s con la red bien no culpa a la conexion', (raw) => {
    expect(mensajeDe(refinarSinRed(claseDe({ message: raw }), true))).not.toContain('conexión')
  })

  // Con su código real: medido, toda denegación de RLS llega con `42501`.
  it('una denegacion de RLS no se confunde con un problema de red', () => {
    const msg = mensajeDe(claseDe({
      code: '42501', message: 'new row violates row-level security policy for table "items"',
    }))
    expect(msg).not.toContain('conexión')
    expect(msg).toContain('acceso')
  })

  it('nunca devuelve el texto crudo', () => {
    const crudo = 'new row violates row-level security policy for table "items"'
    const e = { code: '42501', message: crudo }
    expect(mensajeDe(claseDe(e))).not.toContain('row-level')
    expect(mensajeDe(claseDe(e))).not.toContain('items')
  })
})
