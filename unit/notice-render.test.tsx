// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { Item } from '@/lib/items'

/**
 * J5 / DoD 39 y 44 — la version anterior probaba que `lib/items` DEVUELVE el
 * error. El requisito (I11) es de interfaz: que alguien lo PINTE. Aqui se monta
 * el componente real; borrar `setNotice` pone este test en rojo, que es
 * justamente lo que no ocurria antes.
 */
const addItem = vi.fn()
const updateItem = vi.fn()
const softDeleteItem = vi.fn()

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/useGroupChannel', () => ({ useGroupChannel: () => 'live' }))
vi.mock('@/app/actions', () => ({
  createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/items', async (orig) => ({
  ...(await orig<typeof import('@/lib/items')>()),
  activeItems: vi.fn(async () => []),
  addItem: (...a: unknown[]) => addItem(...a),
  updateItem: (...a: unknown[]) => updateItem(...a),
  softDeleteItem: (...a: unknown[]) => softDeleteItem(...a),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const item = (id: string): Item => ({
  id, group_id: 'g1', name: 'pan', quantity: null, created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null,
})

const vista = (items: Item[] = [], loadError: string | null = null) => (
  <GroupView
    group={{ id: 'g1', name: 'Familia' }}
    initialItems={items}
    members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'owner' }}
    loadError={loadError}
  />
)
const mount = (items: Item[] = [], loadError: string | null = null) => render(vista(items, loadError))

const addProducto = () => {
  fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'leche' } })
  fireEvent.click(screen.getByTestId('add-item'))
}

beforeEach(() => { vi.clearAllMocks() })
// Sin esto los montajes se acumulan en el mismo DOM y los localizadores
// encuentran varios elementos: el test fallaria por su propio arnes.
afterEach(() => { cleanup() })

describe('J5 la interfaz muestra los fallos', () => {
  it('una mutacion denegada pinta el aviso', async () => {
    addItem.mockResolvedValue({ data: null, error: 'new row violates row-level security policy' })
    mount()
    addProducto()
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
  })

  it('el aviso no filtra el texto crudo de Postgres', async () => {
    addItem.mockResolvedValue({
      data: null,
      error: 'new row violates row-level security policy for table "items"',
    })
    mount()
    addProducto()
    await waitFor(() => {
      const text = screen.getByTestId('notice').textContent ?? ''
      expect(text).not.toContain('row-level security')
      expect(text).not.toContain('items')
      expect(text.length).toBeGreaterThan(0)
    })
  })

  it('una mutacion que va bien no deja aviso', async () => {
    addItem.mockResolvedValue({ data: item('i1'), error: null })
    mount()
    addProducto()
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })

  it('el aviso se limpia en la siguiente operacion con exito', async () => {
    addItem.mockResolvedValueOnce({ data: null, error: 'permission denied' })
    mount()
    addProducto()
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())

    addItem.mockResolvedValueOnce({ data: item('i2'), error: null })
    addProducto()
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })

  it('DoD 51 (K2): un doble clic en borrar llama UNA vez y no acusa a nadie', async () => {
    // Antes: el boton no se deshabilitaba, la segunda llamada devolvia 0 filas
    // y J14 la traducia a "alguien lo quito antes que tu". La app culpaba a
    // otro usuario del segundo toque del propio.
    let resolver: ((v: { data: number; error: null }) => void) | undefined
    softDeleteItem.mockImplementation(() => new Promise(res => { resolver = res }))
    mount([item('i1')])
    const boton = screen.getByTestId('delete-item')
    fireEvent.click(boton)
    fireEvent.click(boton)
    await waitFor(() => expect(softDeleteItem).toHaveBeenCalledTimes(1))
    resolver?.({ data: 1, error: null })
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })

  it('DoD 62 (L1): tras un borrado que falla, el boton vuelve a estar disponible', async () => {
    // Antes: el id entraba en el conjunto de operaciones en vuelo y no salia
    // nunca, asi que el boton quedaba deshabilitado para siempre mientras el
    // aviso invitaba a reintentar lo que la interfaz impedia.
    softDeleteItem.mockResolvedValue({ data: 0, error: 'permission denied' })
    mount([item('i1')])
    const boton = screen.getByTestId('delete-item') as HTMLButtonElement
    fireEvent.click(boton)
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    await waitFor(() => expect(boton.disabled).toBe(false))
  })

  it('DoD 64 (L3): con loadError la vista lo pinta, y sobrevive a un re-render', async () => {
    const { rerender } = render(vista([], 'TypeError: fetch failed'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    expect(screen.getByTestId('notice').textContent).toContain('conexión')

    // Un `router.refresh()` re-renderiza con las mismas props: como valor
    // inicial de estado, el aviso desaparecia aunque el fallo siguiera vigente.
    rerender(vista([], 'TypeError: fetch failed'))
    expect(screen.getByTestId('notice')).toBeTruthy()
  })

  it('DoD 58 (K10): renombrar algo que otro ya borro tambien se informa', async () => {
    updateItem.mockResolvedValue({ data: 0, error: null })
    mount([item('i1')])
    const campo = screen.getByLabelText('Nombre')
    fireEvent.change(campo, { target: { value: 'pan de molde' } })
    fireEvent.blur(campo)
    await waitFor(() => {
      expect(screen.getByTestId('notice').textContent).toContain('Alguien lo quitó')
    })
  })

  it('DoD 16: borrar algo que ya no esta se informa, no se da por exito', async () => {
    softDeleteItem.mockResolvedValue({ data: 0, error: null })
    mount([item('i1')])
    fireEvent.click(screen.getByTestId('delete-item'))
    await waitFor(() => {
      expect(screen.getByTestId('notice').textContent).toContain('Alguien lo quitó')
    })
  })
})
