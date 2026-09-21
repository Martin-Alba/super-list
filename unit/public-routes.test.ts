import { describe, it, expect } from 'vitest'
import { PUBLIC_ROUTES, RUTAS_SIN_SESION, isPublicRoute } from '../lib/routes'

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

describe('Spec I / i1-R5 · las rutas que no consumen la sesión', () => {
  /**
   * La guarda que el comentario de `lib/routes.ts` prometía y no existía. Es la misma forma que la
   * de `PUBLIC_ROUTES`: la lista se fija aquí, así que añadir una ruta exige tocar dos sitios y
   * declarar por qué.
   */
  it('j3: la lista es exactamente la declarada', () => {
    expect([...RUTAS_SIN_SESION]).toEqual(['/sin-conexion'])
  })

  /**
   * §A.3 — **El invariante que hace benigno el modo de fallo.** Sin él, una ruta que no consume
   * sesión pero tampoco es pública se sirve **sin denegar nada**: medido, con `/g` en la lista,
   * `/g/<uuid>` sin sesión ninguna devuelve 200 sin redirección. La prosa llamaba a eso «benigno»;
   * no lo era, y lo que lo arregla es impedirlo, no confiarlo.
   */
  it('j4: ninguna ruta sin sesión queda fuera de las públicas', () => {
    const fuera = RUTAS_SIN_SESION.filter(r => !isPublicRoute(r))
    expect(fuera, 'una ruta se sirve sin sesión y sin ser pública: A.3 desaparece del proxy')
      .toEqual([])
  })

  it('j4 bis: la sonda — una ruta privada en la lista se caza', () => {
    // §E.2 — sobre una lista sana el barrido no distingue «detecta» de «no mira nada».
    const torcida = ['/sin-conexion', '/g'] as const
    expect(torcida.filter(r => !isPublicRoute(r)), 'el invariante no caza una ruta privada')
      .toEqual(['/g'])
  })
})
