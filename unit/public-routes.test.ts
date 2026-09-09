import { describe, it, expect } from 'vitest'
import { PUBLIC_ROUTES, isPublicRoute } from '../lib/routes'

// R2 — una entrada que casa por prefijo no nombra una ruta: nombra un
// conjunto. El test enumera qué más captura.
describe('R2 rutas públicas enumeradas', () => {
  it('la lista es exactamente la declarada en la spec', () => {
    expect([...PUBLIC_ROUTES].sort())
      .toEqual(['/', '/auth/callback', '/invite', '/login', '/sin-conexion'])
  })
  // J2 — el shell se precachea sin sesión: si el proxy lo redirige, lo que se
  // guarda bajo su clave es la redirección y el arranque en frío sin red falla.
  it.each(['/', '/login', '/auth/callback', '/invite/abc123', '/sin-conexion'])('%s es pública', (p) => {
    expect(isPublicRoute(p)).toBe(true)
  })
  it.each([
    '/g/8f1f1f7a-0000-4000-8000-000000000000',
    '/g/8f1f1f7a-0000-4000-8000-000000000000/settings',
    '/groups',
    '/loginx',
    '/invitex',
    '/auth/callbackx',
    '/sin-conexionx',
  ])('%s NO es capturada por ningún patrón público', (p) => {
    expect(isPublicRoute(p)).toBe(false)
  })
})
