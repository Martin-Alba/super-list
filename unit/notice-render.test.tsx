// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { claseDe, RELECTURA, type Clase } from '@/lib/errors'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import type { Item } from '@/lib/items'

/**
 * J5 / DoD 39 y 44 — la version anterior probaba que `lib/items` DEVUELVE el
 * error. El requisito (I11) es de interfaz: que alguien lo PINTE. Aqui se monta
 * el componente real; borrar `setNotice` pone este test en rojo, que es
 * justamente lo que no ocurria antes.
 */
/**
 * AD2 — Los dobles devolvían `error` con el texto crudo, que `lib/items.ts` ya no
 * produce. Devuelven lo que produce el fichero real: la clase que `claseDe`
 * calcula a partir de ese mismo crudo. El test de «no filtra el texto crudo»
 * sigue metiendo el crudo por la entrada, que es lo que lo hace valer.
 */
const comoElReal = (crudo: string | null, code: string | null = null, data: unknown = null) => ({
  data, code, clase: claseDe(crudo ? { message: crudo, code } : null),
})

const activeItems = vi.fn()
const addItem = vi.fn()
const updateItem = vi.fn()
const softDeleteItem = vi.fn()

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
// AF7 — se guardan las opciones para poder disparar `onResync`, que es el
// camino que AE1 abrió al dejar de lanzar y que no ejercitaba nadie.
const opcionesDelCanal: { onResync?: () => void }[] = []
vi.mock('@/lib/useGroupChannel', () => ({
  useGroupChannel: (_id: string, opciones: { onResync?: () => void }) => {
    opcionesDelCanal[0] = opciones
    return 'live'
  },
}))
vi.mock('@/app/actions', () => ({
  createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/items', async (orig) => ({
  ...(await orig<typeof import('@/lib/items')>()),
  activeItems: (...a: unknown[]) => activeItems(...a),
  addItem: (...a: unknown[]) => addItem(...a),
  updateItem: (...a: unknown[]) => updateItem(...a),
  softDeleteItem: (...a: unknown[]) => softDeleteItem(...a),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const item = (id: string): Item => ({
  id, group_id: 'g1', name: 'pan', quantity: null, created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null, origen_id: null,
})

const vista = (items: Item[] = [], loadClase: Clase | null = null) => (
  <GroupView
    group={{ id: 'g1', name: 'Familia' }}
    initialItems={items}
    members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'owner' }}
    loadClase={loadClase}
  />
)
const mount = (items: Item[] = [], loadClase: Clase | null = null) => render(vista(items, loadClase))

const addProducto = () => {
  fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'leche' } })
  fireEvent.click(screen.getByTestId('add-item'))
}

beforeEach(() => {
  vi.clearAllMocks()
  activeItems.mockResolvedValue({ data: [], clase: null, code: null })
})
// Sin esto los montajes se acumulan en el mismo DOM y los localizadores
// encuentran varios elementos: el test fallaria por su propio arnes.
afterEach(() => { cleanup() })

describe('J5 la interfaz muestra los fallos', () => {
  it('una mutacion denegada pinta el aviso', async () => {
    addItem.mockResolvedValue(comoElReal('new row violates row-level security policy'))
    mount()
    addProducto()
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
  })

  /**
   * AE9 — Aquí había «el aviso no filtra el texto crudo de Postgres», y desde
   * AD2 **no podía fallar**: el doble le entrega una `Clase`, así que la
   * aserción compara uno de siete literales contra sí mismo. La revisión lo
   * demostró: con la mutación que pintaba `PostgrestError: permission denied`
   * en el aviso, este test seguía verde.
   *
   * Su trabajo está en tres sitios donde sí puede fallar: el tipo (DoD 112, el
   * proyecto no compila), la guarda sobre el fichero real (DoD 125) y el
   * duplicado de verdad en navegador, que sí trae `details` (DoD 134).
   */

  it('una mutacion que va bien no deja aviso', async () => {
    addItem.mockResolvedValue(comoElReal(null, null, item('i1')))
    mount()
    addProducto()
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })

  it('el aviso se limpia en la siguiente operacion con exito', async () => {
    addItem.mockResolvedValueOnce(comoElReal('permission denied'))
    mount()
    addProducto()
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())

    addItem.mockResolvedValueOnce(comoElReal(null, null, item('i2')))
    addProducto()
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })

  it('DoD 51 (K2): un doble clic en borrar llama UNA vez y no acusa a nadie', async () => {
    // Antes: el boton no se deshabilitaba, la segunda llamada devolvia 0 filas
    // y J14 la traducia a "alguien lo quito antes que tu". La app culpaba a
    // otro usuario del segundo toque del propio.
    let resolver: ((v: { data: number; clase: null; code: null }) => void) | undefined
    softDeleteItem.mockImplementation(() => new Promise(res => { resolver = res }))
    mount([item('i1')])
    const boton = screen.getByTestId('delete-item')
    fireEvent.click(boton)
    fireEvent.click(boton)
    await waitFor(() => expect(softDeleteItem).toHaveBeenCalledTimes(1))
    resolver?.({ data: 1, clase: null, code: null })
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })

  it('DoD 62 (L1): tras un borrado que falla, el boton vuelve a estar disponible', async () => {
    // Antes: el id entraba en el conjunto de operaciones en vuelo y no salia
    // nunca, asi que el boton quedaba deshabilitado para siempre mientras el
    // aviso invitaba a reintentar lo que la interfaz impedia.
    softDeleteItem.mockResolvedValue(comoElReal('permission denied', null, 0))
    mount([item('i1')])
    const boton = screen.getByTestId('delete-item') as HTMLButtonElement
    fireEvent.click(boton)
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    await waitFor(() => expect(boton.disabled).toBe(false))
  })

  it('DoD 64 (L3): con loadClase la vista lo pinta, y sobrevive a un re-render', async () => {
    // U6 / AD3 — del servidor llega la CLASE: el texto crudo de
    // Postgres dejó de viajar al cliente.
    const { rerender } = render(vista([], 'red'))
    await waitFor(() => expect(screen.getByTestId('notice')).toBeTruthy())
    expect(screen.getByTestId('notice').textContent).toContain('conexión')

    // Un `router.refresh()` re-renderiza con las mismas props: como valor
    // inicial de estado, el aviso desaparecia aunque el fallo siguiera vigente.
    rerender(vista([], 'red'))
    expect(screen.getByTestId('notice')).toBeTruthy()
  })

  it('DoD 58 (K10): renombrar algo que otro ya borro tambien se informa', async () => {
    updateItem.mockResolvedValue(comoElReal(null, null, 0))
    mount([item('i1')])
    const campo = screen.getByLabelText('Nombre')
    fireEvent.change(campo, { target: { value: 'pan de molde' } })
    fireEvent.blur(campo)
    await waitFor(() => {
      expect(screen.getByTestId('notice').textContent).toContain('Alguien lo quitó')
    })
  })

  it('DoD 16: borrar algo que ya no esta se informa, no se da por exito', async () => {
    softDeleteItem.mockResolvedValue(comoElReal(null, null, 0))
    mount([item('i1')])
    fireEvent.click(screen.getByTestId('delete-item'))
    await waitFor(() => {
      expect(screen.getByTestId('notice').textContent).toContain('Alguien lo quitó')
    })
  })
})

/**
 * AF7 / DoD 144 — El camino que AE1 abrió: `activeItems` ya no lanza, así que la
 * relectura fallida llega como clase y no como excepción. Nadie lo ejercitaba, y
 * §E.4 dice que un arreglo que cambia el mecanismo se prueba también por la
 * puerta que abre.
 */
describe('AF7 la relectura que falla se anuncia', () => {
  it('con la relectura fallando, el aviso aparece', async () => {
    activeItems.mockResolvedValue({ data: [], clase: 'red', code: null })
    mount()
    opcionesDelCanal[0]?.onResync?.()
    await waitFor(() => {
      expect(screen.getByTestId('notice').textContent).toContain(RELECTURA)
    })
  })

  it('y con la relectura yendo bien, no se inventa ninguno', async () => {
    activeItems.mockResolvedValue({ data: [item('i9')], clase: null, code: null })
    mount()
    opcionesDelCanal[0]?.onResync?.()
    await waitFor(() => expect(screen.queryByTestId('notice')).toBeNull())
  })
})
