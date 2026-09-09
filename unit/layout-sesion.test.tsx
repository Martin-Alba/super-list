// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'

/**
 * K7 / DoD 54 — El layout no le pregunta al servidor por la sesión.
 *
 * Se afirma llamando al componente y mirando si construye el cliente de
 * servidor, no leyendo su fuente: si alguien vuelve a pedirla —de nuevo, o desde
 * otro sitio del mismo fichero— esto se pone rojo igual.
 *
 * Medido antes del cambio: `GET /` disparaba **6** peticiones a `/auth/v1/user`
 * y `/sin-conexion` **4**; con el servicio de auth colgado, el peor caso pasaba
 * de 10 s a 20,0 s por dos cotas en serie.
 */
const createClient = vi.fn(async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient }))
vi.mock('@/app/RegistrarSW', () => ({ RegistrarSW: () => null }))
vi.mock('@/app/RecordarUsuario', () => ({ RecordarUsuario: () => null }))

const { RegistrarSW } = await import('@/app/RegistrarSW')
const { RecordarUsuario } = await import('@/app/RecordarUsuario')

const RootLayout = (await import('@/app/layout')).default

describe('K7 el layout no pide la sesión al servidor', () => {
  it('DoD 54: renderizarlo no construye ningún cliente de servidor', () => {
    const salida = RootLayout({ children: null })
    expect(salida, 'el layout no devolvió nada').toBeTruthy()
    expect(createClient, 'el layout vuelve a preguntar por la sesión en cada render')
      .not.toHaveBeenCalled()
  })

  /**
   * L5 / DoD 61 — Antes esto afirmaba «hay algún hijo con `type`», y eso lo
   * cumplía `<RegistrarSW/>` él solo: la aserción no podía ponerse roja aunque
   * `<RecordarUsuario/>` desapareciera. Ahora se compara con el componente
   * concreto, que es lo que el requisito nombra.
   */
  it('DoD 61: monta el registro de usuario, sin condicionarlo a una sesión de servidor', () => {
    const html = RootLayout({ children: null }) as { props: { children: { props: { children: unknown[] } } } }
    const hijos = html.props.children.props.children as { type?: unknown }[]
    expect(hijos.some(h => !!h && typeof h === 'object' && h.type === RecordarUsuario),
      'el registro de usuario dejó de montarse').toBe(true)
    // La sonda del propio test: el hermano NO lo satisface.
    expect(hijos.some(h => !!h && typeof h === 'object' && h.type === RegistrarSW),
      'el banco de este test ya no tiene con qué distinguir').toBe(true)
  })
})
