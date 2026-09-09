// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { Item } from '@/lib/items'
import type { Pendiente } from '@/lib/local'
import { mensajeDe, SIN_ALMACEN, type Clase } from '@/lib/errors'

/**
 * I7/I9 — El drenado, atacado en la capa donde vive: montado dentro de la vista.
 * La spec lo declaró en «módulo» y no lo es — el bucle usa estado y efectos del
 * componente, así que probarlo por debajo sería probar otra cosa.
 */
const addItem = vi.fn()
const activeItems = vi.fn()
const leerCola = vi.fn()
const quitarDeCola = vi.fn()
const encolar = vi.fn()
const guardarLista = vi.fn()

/**
 * J3/DoD 38 — `sinRed` mandable desde el test. Es lo que hace observable el
 * solape: el drenado se dispara con cada cambio de red, y la red **parpadea** por
 * diseño (medido: 1 de cada 3 arranques), así que un segundo drenado encima de
 * uno en vuelo no es un caso raro, es el caso normal.
 */
let sinRedAhora = false
const oyentes = new Set<() => void>()
const ponerSinRed = async (v: boolean) => {
  sinRedAhora = v
  await act(async () => { for (const f of [...oyentes]) f() })
}

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/lib/useGroupChannel', () => ({ useGroupChannel: () => 'live' }))
vi.mock('@/app/actions', () => ({
  createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/useSinRed', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useSinRed: () => useSyncExternalStore(
      (f: () => void) => { oyentes.add(f); return () => { oyentes.delete(f) } },
      () => sinRedAhora, () => sinRedAhora),
  }
})
vi.mock('@/lib/items', async (orig) => ({
  ...(await orig<typeof import('@/lib/items')>()),
  activeItems: (...a: unknown[]) => activeItems(...a),
  addItem: (...a: unknown[]) => addItem(...a),
  updateItem: vi.fn(),
  softDeleteItem: vi.fn(),
}))
vi.mock('@/lib/local', async (orig) => ({
  ...(await orig<typeof import('@/lib/local')>()),
  leerCola: (...a: unknown[]) => leerCola(...a),
  quitarDeCola: (...a: unknown[]) => quitarDeCola(...a),
  encolar: (...a: unknown[]) => encolar(...a),
  guardarLista: (...a: unknown[]) => guardarLista(...a),
  leerLista: vi.fn(async () => null),
  leerUltimoUsuario: vi.fn(async () => 'u1'),
  guardarUltimoUsuario: vi.fn(async () => {}),
  olvidarTodo: vi.fn(async () => {}),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const fila = (nombre: string): Item => ({
  id: `id-${nombre}`, group_id: 'g1', name: nombre, quantity: null, created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null,
})
/**
 * Las marcas de tiempo son recientes a propósito: con valores pequeños el efecto
 * de montaje las daba por caducadas y llamaba a `quitarDeCola` por su cuenta,
 * enmascarando lo que estas pruebas miran.
 */
const pendiente = (nombre: string, hace: number) =>
  ({ id: `p-${nombre}`, usuario: 'u1', grupo: 'g1', nombre, cantidad: null, creado: Date.now() - hace })

const vista = (loadClase: Clase | null = null) => (
  <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={[]}
    members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'owner' }} loadClase={loadClase} />
)
const montarCon = (loadClase: Clase | null) => render(vista(loadClase))
const montar = () => render(vista())

/**
 * Una cola de mentira que **recuerda**: `quitarDeCola` tiene que cambiar lo que
 * `leerCola` devuelve después, o el segundo drenado vuelve a ver lo ya enviado y
 * el test mediría el doble envío que él mismo fabricó.
 */
let cola: Pendiente[] = []
const colaViva = () => {
  leerCola.mockImplementation(async () => cola)
  quitarDeCola.mockImplementation(async (id: string) => { cola = cola.filter(x => x.id !== id) })
}
/** Un `addItem` que se queda parado hasta que el test lo suelta. */
const enVuelo = () => {
  let empezo!: () => void, soltar!: () => void
  const primero = new Promise<void>(r => { empezo = r })
  const permiso = new Promise<void>(r => { soltar = r })
  addItem.mockImplementationOnce(async (...a: unknown[]) => {
    empezo(); await permiso
    return { data: fila(String(a[3])), clase: null, code: null }
  })
  addItem.mockImplementation(async (...a: unknown[]) =>
    ({ data: fila(String(a[3])), clase: null, code: null }))
  return { primero, soltar: () => act(async () => { soltar() }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  sinRedAhora = false
  cola = []
  encolar.mockResolvedValue(true)
  guardarLista.mockResolvedValue(undefined)
  leerCola.mockResolvedValue([])
  quitarDeCola.mockResolvedValue(undefined)
  addItem.mockResolvedValue({ data: fila('x'), clase: null, code: null })
  activeItems.mockResolvedValue({ data: [], clase: null, code: null })
})
afterEach(() => cleanup())

describe('R4/I7 el drenado va en orden, uno cada vez y sin solaparse', () => {
  it('DoD 28: sale el más antiguo primero, y sólo un envío en vuelo', async () => {
    leerCola.mockResolvedValue([pendiente('tarde', 1_000), pendiente('pronto', 5_000)])
    let enVuelo = 0
    let solapado = false
    addItem.mockImplementation(async (...a: unknown[]) => {
      enVuelo++
      if (enVuelo > 1) solapado = true
      await new Promise(r => setTimeout(r, 5))
      enVuelo--
      return { data: fila(String(a[3])), clase: null, code: null }
    })
    montar()
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(2))
    expect(solapado, 'dos envíos a la vez: D.2 lo prohíbe').toBe(false)
    const nombres = addItem.mock.calls.map(c => c[3])
    expect(nombres, 'no salió el más antiguo primero').toEqual(['pronto', 'tarde'])
  })

  /**
   * DoD 32 — Un alta que ya entró devuelve `23505` por el índice único. Es éxito:
   * el producto está. Sin este trato, la cola se atasca para siempre en ella.
   */
  it('DoD 32: un 23505 al drenar saca la entrada de la cola', async () => {
    leerCola.mockResolvedValue([pendiente('cebolla', 1_000)])
    addItem.mockResolvedValue({ data: null, clase: 'duplicado', code: '23505' })
    montar()
    await waitFor(() => expect(quitarDeCola).toHaveBeenCalledWith('p-cebolla'))
  })

  it('y un fallo de verdad la deja donde está, para reintentarla', async () => {
    leerCola.mockResolvedValue([pendiente('cebolla', 1_000)])
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    montar()
    await waitFor(() => expect(addItem).toHaveBeenCalled())
    expect(quitarDeCola, 'se tiró una entrada que no llegó a entrar').not.toHaveBeenCalled()
  })
})

/**
 * I6 / DoD 26 — El camino que R2 nombra por su nombre: **el primer acceso** tras
 * la pausa. El aviso decía «lo reintentamos solo» y no reintentaba nadie.
 *
 * Se prueba aquí y no en navegador porque la carga del grupo la hace el
 * **servidor**: `page.route` intercepta lo que pide el navegador, no lo que pide
 * el render, así que allí no hay forma de dormir la base para esta página.
 */
describe('I6 una carga que falló por el servidor se reintenta sola', () => {
  it('DoD 26: trae la lista y retira el aviso sin que nadie pulse', async () => {
    activeItems.mockResolvedValueOnce({ data: [], clase: 'servidor', code: null })
    activeItems.mockResolvedValue({ data: [fila('clavo')], clase: null, code: null })

    const { getByTestId, queryByTestId, getByLabelText } = montarCon('servidor')
    expect(getByTestId('notice').textContent).toContain('despertando')
    await waitFor(() => expect(queryByTestId('notice')).toBeNull(), { timeout: 20_000 })
    // El nombre vive en el campo de la fila, no en su texto.
    expect((getByLabelText('Nombre') as HTMLInputElement).value).toBe('clavo')
  }, 25_000)

  it('y una carga que fue bien no reintenta nada', async () => {
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    montarCon(null)
    await new Promise(r => setTimeout(r, 1_200))
    expect(activeItems, 'reintentó sin haber fallado nada').not.toHaveBeenCalled()
  })
})

/**
 * J3 — El cerrojo evita el **solape**, no el trabajo. La versión anterior
 * descartaba el segundo drenado en silencio, y como el bucle trabaja sobre la
 * cola leída al principio, lo apuntado mientras había un envío en vuelo no se
 * mandaba nunca: se quedaba en el disco hasta el siguiente cambio de red y a las
 * 24 h se descartaba con un aviso. Se había cambiado un defecto por otro.
 */
describe('J3 el cerrojo del drenado no se traga trabajo', () => {
  it('DoD 38: lo apuntado durante un drenado en vuelo acaba enviándose', async () => {
    cola = [pendiente('viejo', 5_000)]
    colaViva()
    const vuelo = enVuelo()
    montar()
    await vuelo.primero

    // Llega trabajo nuevo mientras el primero está en vuelo, y la red parpadea:
    // eso dispara el segundo drenado, que se encuentra el cerrojo puesto.
    cola = [...cola, pendiente('nuevo', 1_000)]
    await ponerSinRed(true)
    await ponerSinRed(false)
    await vuelo.soltar()

    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(2))
    expect(addItem.mock.calls.map(c => c[3]),
      'lo apuntado durante el envío se quedó en la cola para siempre')
      .toEqual(['viejo', 'nuevo'])
  })

  it('DoD 39: dos drenados solapados no mandan nada dos veces', async () => {
    cola = [pendiente('solo', 5_000)]
    colaViva()
    const vuelo = enVuelo()
    montar()
    await vuelo.primero

    await ponerSinRed(true)
    await ponerSinRed(false)
    await vuelo.soltar()

    await waitFor(() => expect(quitarDeCola).toHaveBeenCalledWith('p-solo'))
    await new Promise(r => setTimeout(r, 50))
    expect(addItem.mock.calls.map(c => c[3]),
      'el mismo producto salió dos veces: D.2 lo prohíbe').toEqual(['solo'])
  })
})

/**
 * J5 / DoD 41 — Probado donde el fallo existe. La aserción anterior vivía en un
 * test de navegador con `page.route`, que intercepta lo que pide **el
 * navegador**: la carga del grupo la hace el render del servidor, así que aquella
 * aserción no podía ponerse roja ni con el fallo puesto.
 */
describe('J5 una carga fallida no borra la instantánea', () => {
  it('DoD 41: con la carga fallida no se escribe nada en el disco', async () => {
    activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
    montarCon('servidor')
    await new Promise(r => setTimeout(r, 50))
    expect(guardarLista, 'la lista vacía de una carga fallida pisó la instantánea')
      .not.toHaveBeenCalled()
  })

  it('y la sonda: con la carga buena sí se guarda', async () => {
    montarCon(null)
    await waitFor(() => expect(guardarLista).toHaveBeenCalledWith('u1', 'g1', []))
  })
})

/**
 * J6 / DoD 42 — Un almacén que no admite nada no puede parecer que sí. Sin cuota,
 * en modo privado o sin IndexedDB, la ficha se pintaba igual: el usuario veía su
 * producto, recargaba, y no estaba.
 */
describe('J6 una cola que no admite la escritura lo dice', () => {
  const apuntarSinRed = async (r: ReturnType<typeof render>) => {
    await ponerSinRed(true)
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
  }

  it('DoD 42: no se pinta ficha, se avisa, y lo tecleado sigue ahí', async () => {
    encolar.mockResolvedValue(false)
    const r = montar()
    await apuntarSinRed(r)
    expect(r.queryAllByTestId('item-pendiente'),
      'se pintó una ficha que el almacén rechazó').toHaveLength(0)
    expect(r.getByTestId('notice').textContent).toContain(SIN_ALMACEN)
    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('lentejas')
  })

  it('y la sonda: si el almacén la acepta, la ficha se pinta y el campo se vacía', async () => {
    const r = montar()
    await apuntarSinRed(r)
    expect(r.queryAllByTestId('item-pendiente')).toHaveLength(1)
    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('')
  })
})

/**
 * J7 / DoD 43 — Se recuerda **qué** carga se resolvió, no que alguna se resolvió.
 * Con el booleano, el primer reintento con éxito callaba el aviso derivado para
 * el resto de la vida de la pestaña.
 */
describe('J7 un segundo fallo de carga vuelve a avisar', () => {
  it('DoD 43: recuperada una carga, la siguiente que falla se anuncia', async () => {
    activeItems.mockResolvedValueOnce({ data: [], clase: 'servidor', code: null })
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    const r = montarCon('servidor')
    expect(r.getByTestId('notice').textContent).toContain('despertando')
    await waitFor(() => expect(r.queryByTestId('notice')).toBeNull(), { timeout: 20_000 })

    // Otra carga, otro fallo: aquí el usuario perdió el acceso al grupo.
    await act(async () => { r.rerender(vista('sin-acceso')) })
    expect(r.queryByTestId('notice'),
      'la carga fallida no se anunció: el aviso quedó callado para siempre')
      .not.toBeNull()
    expect(r.getByTestId('notice').textContent).toBe(mensajeDe('sin-acceso'))
  }, 25_000)
})

/**
 * K2 / DoD 47 — El campo se vacía **antes** del `await` para que apuntar dos
 * cosas seguidas no obligue a esperar: es el gesto normal en un pasillo. Por eso
 * lo que se devuelve al campo cuando algo falla no puede pisar lo que se haya
 * tecleado mientras tanto. Es I4 —«de seis altas seguidas entraban tres»—
 * reabierto por las dos ramas de fallo que abrió la iteración 3.
 */
describe('K2 lo tecleado durante la espera no se pisa', () => {
  const tecleaYEnvia = async (r: ReturnType<typeof render>, texto: string) => {
    fireEvent.change(r.getByTestId('item-name'), { target: { value: texto } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
  }

  it('DoD 47: con el almacén rechazando, lo nuevo sobrevive', async () => {
    let soltar!: (v: boolean) => void
    encolar.mockImplementation(() => new Promise<boolean>(r => { soltar = r }))
    sinRedAhora = true
    const r = montar()
    await tecleaYEnvia(r, 'lentejas')
    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'el campo no se liberó: apuntar dos cosas seguidas obliga a esperar').toBe('')

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await act(async () => { soltar(false) })

    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'la rama de fallo pisó lo que se estaba tecleando').toBe('garbanzos')
    expect(r.getByTestId('notice').textContent).toContain(SIN_ALMACEN)
  })

  it('DoD 47: y con un duplicado sin red, igual', async () => {
    let soltar!: (v: Pendiente[]) => void
    leerCola.mockResolvedValueOnce([])
    leerCola.mockImplementation(() => new Promise<Pendiente[]>(r => { soltar = r }))
    sinRedAhora = true
    const r = montar()
    await tecleaYEnvia(r, 'lentejas')

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await act(async () => { soltar([pendiente('lentejas', 1_000)]) })

    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'el duplicado sin red pisó lo que se estaba tecleando').toBe('garbanzos')
  })

  /**
   * DoD 60 — Y se devuelve **entero** o nada. Mirando cada campo por su cuenta,
   * quien teclea sólo el nombre durante la espera se encontraba su producto con
   * la cantidad del anterior: pedía «pan» y le salía «pan, 2».
   */
  it('DoD 60: tecleando sólo el nombre, no aparece la cantidad del anterior', async () => {
    let soltar!: (v: boolean) => void
    encolar.mockImplementation(() => new Promise<boolean>(r => { soltar = r }))
    sinRedAhora = true
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    fireEvent.change(r.getByTestId('item-qty'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'pan' } })
    await act(async () => { soltar(false) })

    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('pan')
    expect((r.getByTestId('item-qty') as HTMLInputElement).value,
      'se cruzaron dos altas: el nombre nuevo con la cantidad del anterior').toBe('')
  })

  // La sonda: si nunca devolviera nada, los tres de arriba pasarían por vacío.
  it('y si nadie ha tecleado nada, lo que falló vuelve al campo', async () => {
    encolar.mockResolvedValue(false)
    sinRedAhora = true
    const r = montar()
    await tecleaYEnvia(r, 'lentejas')
    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('lentejas')
  })
})

/**
 * M1 / DoD 64 — El camino con red, que es el que usa todo el mundo. La guarda de
 * lo tecleado vivió tres iteraciones en las ramas sin red, y aquí no: el campo
 * espera al viaje a la base —el hueco es más ancho que el de la cola— y lo que se
 * escribiera durante ese viaje se borraba al volver. El usuario teclea, pulsa «+»
 * (que no hace nada porque está ocupado), y ve desaparecer su texto.
 */
describe('M1/M3 con red, el campo se comporta como sin red', () => {
  const enVueloAddItem = () => {
    let acabar!: (r: unknown) => void
    addItem.mockImplementation(() => new Promise(r => { acabar = r }))
    return {
      bien: () => act(async () => { acabar({ data: fila('lentejas'), clase: null, code: null }) }),
      mal: () => act(async () => { acabar({ data: null, clase: 'servidor', code: null }) }),
    }
  }

  it('DoD 64: se vacía antes de esperar, y lo tecleado durante el viaje se queda', async () => {
    const alta = enVueloAddItem()
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    /**
     * Vaciar **antes** es lo que impide que cada tecla se añada al producto en
     * vuelo: con el campo lleno durante el viaje, teclear «garbanzos» dejaba
     * `lentejasgarbanzos` listo para entrar en la lista de toda la familia.
     */
    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'el campo no se liberó: apuntar dos cosas seguidas obliga a esperar').toBe('')

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await alta.bien()
    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'el alta con red pisó lo que se estaba tecleando').toBe('garbanzos')
  })

  it('DoD 64: y si el alta falla, lo suyo vuelve al campo (I12)', async () => {
    const alta = enVueloAddItem()
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    fireEvent.change(r.getByTestId('item-qty'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    await alta.mal()
    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'un alta que falló se llevó lo tecleado por delante').toBe('lentejas')
    expect((r.getByTestId('item-qty') as HTMLInputElement).value).toBe('2')
  })

  it('DoD 64: pero no si mientras tanto se ha tecleado otra cosa', async () => {
    const alta = enVueloAddItem()
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await alta.mal()
    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('garbanzos')
  })
})
