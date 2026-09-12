// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { Item } from '@/lib/items'
import type { Pendiente } from '@/lib/local'
import { claseDe, mensajeDe, SIN_ALMACEN, type Clase } from '@/lib/errors'

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
const softDeleteItem = vi.fn()

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
  softDeleteItem: (...a: unknown[]) => softDeleteItem(...a),
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

const vista = (loadClase: Clase | null = null, iniciales: Item[] = []) => (
  <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={iniciales}
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
  softDeleteItem.mockResolvedValue({ data: 1, clase: null, code: null })
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
    /**
     * N1 — Contrato cambiado a propósito (deuda 34). Antes volvía al campo y
     * había que pulsar otra vez; ahora un fallo de «no contestó nadie» entra en
     * la cola y se envía solo. La aserción se invierte porque el comportamiento
     * se invirtió, no porque la prueba se debilite: lo que antes comprobaba el
     * campo ahora lo comprueba la cola, más abajo.
     */
    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'lo fallido ya no vuelve al campo: va a la cola').toBe('')
    expect(encolar).toHaveBeenCalledWith(expect.objectContaining(
      { nombre: 'lentejas', cantidad: '2', grupo: 'g1', usuario: 'u1' }))
  })

  it('DoD 64: pero no si mientras tanto se ha tecleado otra cosa', async () => {
    const alta = enVueloAddItem()
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await alta.mal()
    // N1 — Sigue siendo cierto: lo tecleado manda en el campo.
    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('garbanzos')
    // N1 — Y lo que antes se perdía ahora está en la cola. Ésta es la mitad nueva.
    expect(encolar).toHaveBeenCalledWith(expect.objectContaining({ nombre: 'lentejas' }))
  })
})

/**
 * N1 — Deuda 34: un alta que falla porque **no contestó nadie** entra en la cola
 * en vez de perderse. Atacado en la vista, que es la capa que el requisito nombra.
 */
describe('N1 un alta fallida por red se encola', () => {
  const falloCon = (clase: Clase, code: string | null = null) =>
    addItem.mockResolvedValue({ data: null, clase, code })
  /**
   * N3 — Lo que `addItem` devuelve **de verdad** ante una red caída, no una clase
   * sembrada: `claseDe` sobre un error sin código. Medido: `claseDe` devuelve
   * `'servidor'` para todo lo que no trae código, y `clasificar` —lo único que
   * produce `'red'`— sólo se alcanza con código. Sembrar `'red'` dejaba cuatro
   * ítems verdes con un producto que no encolaba nada.
   */
  const falloDeRed = () => {
    const r = { data: null, clase: claseDe({ message: 'TypeError: Failed to fetch' } as never), code: '' }
    addItem.mockResolvedValue(r)
    return r
  }
  const apuntar = async (r: ReturnType<typeof montar>, nombre: string, cantidad = '') => {
    fireEvent.change(r.getByTestId('item-name'), { target: { value: nombre } })
    if (cantidad) fireEvent.change(r.getByTestId('item-qty'), { target: { value: cantidad } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
  }

  it('DoD 1: un fallo de red deja la entrada en la cola, con nombre y cantidad', async () => {
    falloDeRed()
    const r = montar()
    await apuntar(r, 'lentejas', '2')
    expect(encolar).toHaveBeenCalledWith(expect.objectContaining(
      { nombre: 'lentejas', cantidad: '2', grupo: 'g1', usuario: 'u1' }))
    expect(r.getAllByTestId('item-pendiente')).toHaveLength(1)
  })

  it('DoD 6: un fallo de servidor —proyecto pausado— encola igual', async () => {
    falloCon('servidor')
    const r = montar()
    await apuntar(r, 'lentejas')
    expect(encolar).toHaveBeenCalledWith(expect.objectContaining({ nombre: 'lentejas' }))
  })

  it('DoD 2: un fallo CON código no encola, y la sonda: sin código sí', async () => {
    falloCon('duplicado', '23505')
    const r = montar()
    await apuntar(r, 'lentejas')
    expect(encolar, 'un 23505 es un rechazo real de la base, no una red caída')
      .not.toHaveBeenCalled()
    expect(r.queryAllByTestId('item-pendiente')).toHaveLength(0)
  })

  it('DoD 2: una sesión caducada tampoco encola', async () => {
    falloCon('sesion', null)
    const r = montar()
    await apuntar(r, 'lentejas')
    expect(encolar).not.toHaveBeenCalled()
  })

  it('DoD 5: si el almacén rechaza, vuelve al campo, se avisa y no hay ficha', async () => {
    falloDeRed()
    encolar.mockResolvedValue(false)
    const r = montar()
    await apuntar(r, 'lentejas', '3')
    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('lentejas')
    expect((r.getByTestId('item-qty') as HTMLInputElement).value).toBe('3')
    expect(r.getByTestId('notice').textContent).toContain(SIN_ALMACEN)
    expect(r.queryAllByTestId('item-pendiente')).toHaveLength(0)
  })

  it('DoD 8: dos altas fallidas seguidas se encolan en el orden apuntado', async () => {
    falloDeRed()
    const r = montar()
    await apuntar(r, 'lentejas')
    await apuntar(r, 'garbanzos')
    const nombres = encolar.mock.calls.map(c => (c[0] as Pendiente).nombre)
    expect(nombres).toEqual(['lentejas', 'garbanzos'])
    expect(r.getAllByTestId('item-pendiente').map(n => n.textContent))
      .toEqual([expect.stringContaining('lentejas'), expect.stringContaining('garbanzos')])
  })

  it('DoD 7: lo encolado se envía sin que la red cambie nunca', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce({ data: null, clase: claseDe({ message: 'Failed to fetch' } as never), code: null })
      const r = montar()
      await apuntar(r, 'lentejas')
      cola = [...cola, (encolar.mock.calls[0][0] as Pendiente)]
      addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
      const antes = addItem.mock.calls.length
      // La cota ya existe: esperasDeReintento() = [1s, 2s, 4s, 8s, 8s].
      await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
      expect(addItem.mock.calls.length,
        'nadie volvió a intentarlo: sin cambio de red no se drena').toBeGreaterThan(antes)
      expect(sinRedAhora, 'la red no cambió en ningún momento').toBe(false)
    } finally { vi.useRealTimers() }
  })
})

/**
 * N3 — Los tres casos de al lado que la iteración 1 no cubría: la segunda alta,
 * el aviso que se queda mintiendo, y el desmontaje.
 */
describe('N3 el reintento del envío es del envío, no de los avisos', () => {
  const apuntar2 = async (r: ReturnType<typeof montar>, nombre: string) => {
    fireEvent.change(r.getByTestId('item-name'), { target: { value: nombre } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
  }
  // R16 — postgrest devuelve `code: ''` ante un fetch caído, no `null`, y
  // `addItem` lo propaga tal cual: `error?.code ?? null` no sustituye la cadena
  // vacía. Es el campo que enruta el aviso, así que la prueba usa la forma real.
  const falloReal = () => ({ data: null, clase: claseDe({ message: 'Failed to fetch' } as never), code: '' })

  it('DoD 12: un alta posterior que va bien no mata el reintento de la anterior', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce(falloReal())
      const r = montar()
      await apuntar2(r, 'lentejas')
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      addItem.mockResolvedValue({ data: fila('garbanzos'), clase: null, code: null })
      await apuntar2(r, 'garbanzos')          // pasa por limpiarAviso()
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(cola.some(p => p.nombre === 'lentejas'),
        'la segunda alta mató el reintento de la primera: quedó varada').toBe(false)
    } finally { vi.useRealTimers() }
  })

  it('DoD 13: tras drenar no queda aviso mintiendo en pantalla', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce(falloReal())
      const r = montar()
      await apuntar2(r, 'lentejas')
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(r.queryAllByTestId('item-pendiente')).toHaveLength(0)
      expect(r.queryByTestId('notice'),
        'el producto está en la lista y la app sigue diciendo que el servidor no contesta').toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('DoD 14: el mismo nombre dos veces con el servidor caído deja una entrada', async () => {
    // La cola tiene que RECORDAR: el duplicado se mira contra el almacén, no
    // contra la copia en memoria. Con un `encolar` que no guarda, la segunda
    // lectura ve la cola vacía y el test mediría su propio mock.
    colaViva()
    encolar.mockImplementation(async (pe: Pendiente) => { cola = [...cola, pe]; return true })
    addItem.mockResolvedValue(falloReal())
    const r = montar()
    await apuntar2(r, 'lentejas')
    await apuntar2(r, 'lentejas')
    expect(encolar.mock.calls.filter(c => (c[0] as Pendiente).nombre === 'lentejas'),
      'las dos puertas a la cola no se comportan igual').toHaveLength(1)
    expect(r.getAllByTestId('item-pendiente')).toHaveLength(1)
  })

  it('DoD 15: tras desmontar, el reintento no sigue llamando', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValue(falloReal())
      const r = montar()
      await apuntar2(r, 'lentejas')
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      r.unmount()
      const antes = addItem.mock.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(addItem.mock.calls.length,
        'el bucle siguió corriendo sobre un árbol muerto').toBe(antes)
    } finally { vi.useRealTimers() }
  })
})

/**
 * N4 — La iteración 2 dejó DOS bucles de recuperación donde antes había uno, y
 * con ellos una segunda vía al mismo síntoma: el aviso sólo lo retiraba una
 * relectura con éxito.
 */
describe('N4 un solo bucle, y quien vacía la cola retira el aviso', () => {
  const falloReal = () => ({ data: null, clase: claseDe({ message: 'Failed to fetch' } as never), code: '' })
  const apuntar3 = async (r: ReturnType<typeof montar>, nombre: string) => {
    fireEvent.change(r.getByTestId('item-name'), { target: { value: nombre } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
  }

  it('DoD 17: el envío se recupera y la relectura sigue fallando: no queda aviso', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      // El GET nunca se recupera. El POST sí. Es el caso medido.
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: '' })
      addItem.mockResolvedValueOnce(falloReal())
      const r = montar()
      await apuntar3(r, 'lentejas')
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryAllByTestId('item-pendiente')).toHaveLength(0)
      expect(r.queryByTestId('notice'),
        'el producto está en la lista y la alerta sigue diciendo que el servidor no contesta').toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('DoD 18: un alta fallida no dispara relecturas de lista', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValue(falloReal())
      const r = montar()
      activeItems.mockClear()
      await apuntar3(r, 'lentejas')
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(activeItems.mock.calls.length,
        'dos bucles de recuperación sobre un servidor que no contesta').toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('DoD 19: desmontar con el drenado en vuelo no deja llamadas', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      cola = [pendiente('a', 10), pendiente('b', 5), pendiente('c', 1)]
      let sueltaAdd!: () => void
      addItem.mockImplementation(() => new Promise(res => {
        sueltaAdd = () => res({ data: fila('x'), clase: null, code: null })
      }))
      const r = montar()
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      r.unmount()
      const antes = addItem.mock.calls.length
      await act(async () => { sueltaAdd?.(); await vi.advanceTimersByTimeAsync(5_000) })
      expect(addItem.mock.calls.length,
        'el drenado siguió vaciando la cola sobre un árbol muerto').toBe(antes)
    } finally { vi.useRealTimers() }
  })
})

/**
 * N5 — El aviso de la cola se identificaba por su CLASE, que comparte con otros
 * tres, y su vida tiene dos capas —el estado y el derivado de `loadClase`— de las
 * que sólo se tocaba una. Tres iteraciones tocaron este sitio; ésta lo cierra.
 */
describe('N5 el aviso de la cola es suyo, se refina, y resuelve la carga', () => {
  const falloReal = () => ({ data: null, clase: claseDe({ message: 'Failed to fetch' } as never), code: '' })
  const apuntar4 = async (r: ReturnType<typeof montar>, nombre: string) => {
    fireEvent.change(r.getByTestId('item-name'), { target: { value: nombre } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
  }
  /** Encola una entrada por el camino real y deja la cola lista para drenar. */
  const encolarFallando = async (r: ReturnType<typeof montar>, nombre: string) => {
    addItem.mockResolvedValueOnce(falloReal())
    await apuntar4(r, nombre)
    cola = [...cola, encolar.mock.calls.at(-1)![0] as Pendiente]
    addItem.mockResolvedValue({ data: fila(nombre), clase: null, code: null })
  }

  it('DoD 22: con la carga fallida, tras drenar no queda aviso', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      // El caso canónico del plan gratuito: la página carga con el servicio
      // dormido. Es el montaje que faltaba, y por el que M1 pasó verde.
      const r = montarCon('servidor')
      await encolarFallando(r, 'lentejas')
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryAllByTestId('item-pendiente')).toHaveLength(0)
      expect(r.queryByTestId('notice'),
        'el envío llegó y el aviso derivado de la carga sigue ahí para siempre').toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('DoD 21: un aviso de otro origen sobrevive a un drenado con éxito', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      // Una fila real de partida, para poder fallar un borrado sobre ella.
      const r = render(vista(null, [fila('arroz')]))
      await encolarFallando(r, 'lentejas')
      // Aviso AJENO, de la misma clase `servidor`, puesto por otro camino.
      // La relectura tiene que seguir fallando: si acierta, `reintentar` limpia
      // el aviso por su cuenta y el test mediría esa cura, no la del drenado.
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: '' })
      softDeleteItem.mockResolvedValue({ data: null, clase: 'servidor', code: '' })
      await act(async () => { fireEvent.click(r.getAllByTestId('delete-item')[0]) })
      expect(r.getByTestId('notice'), 'el aviso ajeno no llegó a pintarse').toBeTruthy()
      const ajeno = r.getByTestId('notice').textContent
      // Y ahora el drenado termina con éxito.
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryAllByTestId('item-pendiente'), 'la cola no se vació').toHaveLength(0)
      expect(r.queryByTestId('notice')?.textContent,
        'un drenado con éxito borró el aviso de un borrado fallido').toBe(ajeno)
    } finally { vi.useRealTimers() }
  })

  it('DoD 23: si la red cae mientras el alta viaja, no se culpa al servidor', async () => {
    colaViva()
    let acabar!: (r: unknown) => void
    addItem.mockImplementation(() => new Promise(res => { acabar = res }))
    const r = montar()
    // Se pulsa CON red: entra por la rama de red, no por la de sin red.
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    // La red cae mientras el alta viaja.
    await ponerSinRed(true)
    await act(async () => { acabar({ data: null, clase: 'servidor', code: '' }) })
    expect(r.getByTestId('notice').textContent,
      'se le enseña «el servicio está despertando» a quien se ha quedado sin red')
      .toBe(mensajeDe('red'))
  })
})

/**
 * N6 — Las dos regresiones que este ciclo introdujo respecto a HEAD.
 */
describe('N6 vaciar la cola relee la lista, y el loadClase es el vivo', () => {
  const falloReal = () => ({ data: null, clase: claseDe({ message: 'Failed to fetch' } as never), code: '' })
  const encolarFallando = async (r: ReturnType<typeof montar>, nombre: string) => {
    addItem.mockResolvedValueOnce(falloReal())
    fireEvent.change(r.getByTestId('item-name'), { target: { value: nombre } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    cola = [...cola, encolar.mock.calls.at(-1)![0] as Pendiente]
    addItem.mockResolvedValue({ data: fila(nombre), clase: null, code: null })
  }

  it('DoD 25: tras vaciar la cola, la lista se relee una vez', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      const r = montarCon('servidor')
      await encolarFallando(r, 'lentejas')
      activeItems.mockClear()
      activeItems.mockResolvedValue({ data: [fila('arroz')], clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(activeItems.mock.calls.length,
        'se dio la carga por resuelta sin haber leído nada: la lista se queda rancia').toBe(1)
      expect(r.queryByTestId('notice')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('DoD 26: si esa relectura falla, el aviso NO se retira', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      const r = montarCon('servidor')
      await encolarFallando(r, 'lentejas')
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: '' })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryAllByTestId('item-pendiente'), 'la cola no se vació').toHaveLength(0)
      expect(r.queryByTestId('notice'),
        'se fingió resuelto lo que no se pudo leer: fallar abierto').not.toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('DoD 27: un loadClase que llega tras el montaje se respeta', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      // Monta con la carga BUENA. El servidor re-renderiza después con la mala,
      // que es lo que hace `router.refresh()` y ocurre sin desmontar.
      const r = render(vista(null))
      await act(async () => { r.rerender(vista('servidor')) })
      await encolarFallando(r, 'lentejas')
      activeItems.mockResolvedValue({ data: [], clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryByTestId('notice'),
        'el drenado resolvió con el loadClase capturado al montar, no el vivo').toBeNull()
    } finally { vi.useRealTimers() }
  })
})
