// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup } from '@testing-library/react'
import type { Item } from '@/lib/items'

/**
 * V10 / DoD 56 — U1 tenía un solo test, en el navegador, y ése sólo caza el
 * defecto cuando el slot de replicación entrega el evento viejo: medido 2 de 4.
 * §E.1 mantiene el del navegador como principal —ahí vive la vista—, pero la
 * relectura de la propia fila necesita además una guarda que **no pueda pasar en
 * vacío**: aquí el evento se entrega a mano, así que revertir U1 pone esto rojo
 * las cuatro veces de cada cuatro.
 *
 * Se comprueban las dos direcciones. Una guarda que sólo afirma "no me eches"
 * daría verde con un `onMembership` que no hace nada nunca, y entonces la
 * expulsión real dejaría de funcionar (R7).
 */
const replace = vi.fn()
const refresh = vi.fn()

/** Lo que dice la FUENTE cuando la vista va a confirmar. */
let estadoEnLaFuente: string | null = 'active'
/** El manejador que la vista entrega al canal: se dispara a mano. */
let entregar: (row: { user_id: string; status: string }) => void = () => {}

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: estadoEnLaFuente ? { status: estadoEnLaFuente } : null }) }),
        }),
      }),
    }),
  }),
}))
vi.mock('@/lib/useGroupChannel', () => ({
  useGroupChannel: (_id: string, h: { onMembership?: (r: { user_id: string; status: string }) => void }) => {
    entregar = (row) => h.onMembership?.(row)
    return 'live'
  },
}))
vi.mock('@/app/actions', () => ({
  createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh, replace }) }))
vi.mock('@/lib/items', async (orig) => ({
  ...(await orig<typeof import('@/lib/items')>()),
  activeItems: vi.fn(async () => ({ data: [], clase: null, code: null })),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const pan: Item = {
  id: 'i1', group_id: 'g1', name: 'pan', quantity: null, created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null,
}

const montar = () => render(
  <GroupView
    group={{ id: 'g1', name: 'Familia' }}
    initialItems={[pan]}
    members={[{ user_id: 'u1', status: 'active', role: 'member' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'member' }}
  />,
)

beforeEach(() => { vi.clearAllMocks(); estadoEnLaFuente = 'active' })
afterEach(() => { cleanup() })

describe('V10 la vista mira el estado de la FUENTE, no el del evento', () => {
  it('un pending viejo con la fuente en active NO expulsa', async () => {
    const { getAllByTestId } = montar()
    estadoEnLaFuente = 'active'

    entregar({ user_id: 'u1', status: 'pending' })

    await waitFor(() => expect(replace).not.toHaveBeenCalled())
    expect(replace, 'se actuó sobre el evento en vez de sobre la fuente').not.toHaveBeenCalled()
    expect(getAllByTestId('item'), 'se vació la lista de un miembro activo').toHaveLength(1)
  })

  it('un removed con la fuente ya en removed SÍ expulsa', async () => {
    montar()
    estadoEnLaFuente = 'removed'

    entregar({ user_id: 'u1', status: 'removed' })

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
  })

  // Sonda (§E.2): si la fuente no responde, A.3 manda fallar cerrado.
  it('si la fuente no devuelve fila, se sale igual', async () => {
    montar()
    estadoEnLaFuente = null

    entregar({ user_id: 'u1', status: 'pending' })

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/'))
  })

  it('un evento de OTRO miembro sólo refresca', async () => {
    montar()
    entregar({ user_id: 'otro', status: 'pending' })

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(replace).not.toHaveBeenCalled()
  })
})
