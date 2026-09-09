// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import type { Clase } from '@/lib/errors'

/**
 * AE7 / DoD 132 — La costura que AD3 reconectó no la probaba nadie: cambiar
 * `loadClase={clase}` por `loadClase={null}` en `app/g/[id]/page.tsx` no ponía
 * rojo ni un test. `loadGroupPayload` devolviendo la clase está probado, y
 * `GroupView` pintándola está probado; que la página la **reenvíe**, no — y un
 * fallo de carga que deja de anunciarse pasaría la puerta entera.
 *
 * Se llama al componente de servidor y se mira la prop que emite. No hay
 * navegador de por medio: es exactamente la costura, ni más ni menos.
 */
const payload = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({
        maybeSingle: async () => ({ data: { status: 'active', role: 'owner' } }),
      }) }) }),
    }),
  }),
}))
vi.mock('@/lib/groupPayload', () => ({ loadGroupPayload: (...a: unknown[]) => payload(...a) }))
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('notFound') } }))
vi.mock('@/app/g/[id]/GroupView', () => ({ GroupView: () => null }))
vi.mock('@/app/g/[id]/PendingView', () => ({ PendingView: () => null }))

const GroupPage = (await import('@/app/g/[id]/page')).default

const conClase = async (clase: Clase | null) => {
  payload.mockResolvedValue({
    group: { id: 'g1', name: 'Familia' }, items: [], members: [], profiles: [], clase,
  })
  const elemento = await GroupPage({ params: Promise.resolve({ id: 'g1' }) })
  /**
   * Se busca al que **lleva** la prop, esté en la raíz o dentro de un envoltorio.
   * La página ha devuelto las dos formas en este ciclo —fragmento mientras
   * `RecordarUsuario` la acompañaba, vista suelta desde que vive en el layout— y
   * afirmar sobre una daba `undefined` con la otra: el test se ponía rojo por el
   * envoltorio, no por la costura que mira. La costura es quién recibe la clase.
   */
  const lleva = (n: unknown): n is { props: { loadClase?: Clase | null } } =>
    !!n && typeof n === 'object' && 'props' in n && 'loadClase' in (n as { props: object }).props
  if (lleva(elemento)) return elemento.props
  const hijos = (elemento as { props?: { children?: unknown } }).props?.children
  return (Array.isArray(hijos) ? hijos : [hijos]).find(lleva)?.props ?? {}
}

describe('AE7 la página reenvía la clase que el payload le da', () => {
  it.each(['sesion', 'sin-acceso', 'red', 'generico'] as const)(
    'con %s, la vista la recibe', async (clase) => {
      expect((await conClase(clase)).loadClase,
        'el fallo de carga se pierde entre el payload y la vista').toBe(clase)
    })

  it('y sin fallo no inventa ninguno', async () => {
    expect((await conClase(null)).loadClase).toBeNull()
  })
})
