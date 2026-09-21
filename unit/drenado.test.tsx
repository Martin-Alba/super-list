// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { Item } from '@/lib/items'
import type { Pendiente } from '@/lib/local'
import { dobleDeLaPuerta } from './puertaDeLaCola'
import { reparte } from '@/lib/local'
import { claseDe, DUPLICADO, EN_COLA, mensajeDe, SIN_ALMACEN, GONE, SIN_ACCESO, RELECTURA, type Clase } from '@/lib/errors'

/**
 * I7/I9 — El drenado, atacado en la capa donde vive: montado dentro de la vista.
 * La spec lo declaró en «módulo» y no lo es — el bucle usa estado y efectos del
 * componente, así que probarlo por debajo sería probar otra cosa.
 */
const addItem = vi.fn()
const activeItems = vi.fn()
const leerCola = vi.fn()
const barrerCaducados = vi.fn()
const quitarDeCola = vi.fn()
const encolar = vi.fn()
const guardarLista = vi.fn()
const softDeleteItem = vi.fn()
const updateItem = vi.fn()

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
  updateItem: (...a: unknown[]) => updateItem(...a),
  softDeleteItem: (...a: unknown[]) => softDeleteItem(...a),
}))
/**
 * El canal por el que el almacén anuncia que la cola cambió. El doble deja que el
 * test dispare la señal como si la hubiera emitido otra pestaña — y **no** aplica
 * nada: quien la recibe tiene que releer, que es lo que se quiere probar.
 */
let oyentesDeLaCola: (() => void)[] = []
const avisarDeOtraPestana = () => { for (const f of [...oyentesDeLaCola]) f() }

vi.mock('@/lib/local', async (orig) => ({
  ...(await orig<typeof import('@/lib/local')>()),
  leerCola: (...a: unknown[]) => leerCola(...a),
  barrerCaducados: (...a: unknown[]) => barrerCaducados(...a),
  quitarDeCola: (...a: unknown[]) => quitarDeCola(...a),
  encolar: (...a: unknown[]) => encolar(...a),
  guardarLista: (...a: unknown[]) => guardarLista(...a),
  alCambiarLaCola: (f: () => void) => {
    oyentesDeLaCola.push(f)
    return () => { oyentesDeLaCola = oyentesDeLaCola.filter(x => x !== f) }
  },
  leerLista: vi.fn(async () => null),
  leerUltimoUsuario: vi.fn(async () => 'u1'),
  guardarUltimoUsuario: vi.fn(async () => {}),
  olvidarTodo: vi.fn(async () => {}),
}))

const { GroupView } = await import('@/app/g/[id]/GroupView')

const fila = (nombre: string): Item => ({
  id: `id-${nombre}`, group_id: 'g1', name: nombre, quantity: null, created_by: 'u1',
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null, origen_id: null,
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
const { leerComoLaPuerta, barrerComoElDueno } = dobleDeLaPuerta(
  () => cola, (vivos) => { cola = vivos }, reparte, quitarDeCola)
const colaViva = () => {
  leerCola.mockImplementation(leerComoLaPuerta)
  barrerCaducados.mockImplementation(barrerComoElDueno)
  // Devuelve `boolean`, como el de verdad: desde Spec B / i5-R1 la vista distingue el
  // borrado que entró del que el almacén rechazó, y un doble que devuelve `undefined`
  // le está diciendo «rechazado» sin querer.
  quitarDeCola.mockImplementation(async (id: string) => { cola = cola.filter(x => x.id !== id); return true })
}
/** Un `addItem` que se queda parado hasta que el test lo suelta. */
const enVuelo = () => {
  let empezo!: () => void, soltar!: () => void
  const primero = new Promise<void>(r => { empezo = r })
  const permiso = new Promise<void>(r => { soltar = r })
  addItem.mockImplementationOnce(async (...a: unknown[]) => {
    empezo(); await permiso
    return { data: fila(String((a[3] as { nombre: string }).nombre)), clase: null, code: null }
  })
  addItem.mockImplementation(async (...a: unknown[]) =>
    ({ data: fila(String((a[3] as { nombre: string }).nombre)), clase: null, code: null }))
  return { primero, soltar: () => act(async () => { soltar() }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  oyentesDeLaCola = []
  sinRedAhora = false
  cola = []
  encolar.mockResolvedValue('entro')
  guardarLista.mockResolvedValue(undefined)
  leerCola.mockResolvedValue([])
  barrerCaducados.mockResolvedValue({ vivos: [], descartadas: 0 })
  quitarDeCola.mockResolvedValue(true)
  addItem.mockResolvedValue({ data: fila('x'), clase: null, code: null })
  activeItems.mockResolvedValue({ data: [], clase: null, code: null })
  softDeleteItem.mockResolvedValue({ data: 1, clase: null, code: null })
  updateItem.mockResolvedValue({ data: fila('x'), clase: null, code: null })
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
      return { data: fila(String((a[3] as { nombre: string }).nombre)), clase: null, code: null }
    })
    montar()
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(2))
    expect(solapado, 'dos envíos a la vez: D.2 lo prohíbe').toBe(false)
    const nombres = addItem.mock.calls.map(c => (c[3] as { nombre: string }).nombre)
    expect(nombres, 'no salió el más antiguo primero').toEqual(['pronto', 'tarde'])
    /**
     * Spec B / iteración 2 · i2-R1 — **Y se espera a que la pasada termine.** El
     * caso salía en cuanto veía los dos `addItem`, con el segundo todavía en vuelo;
     * su `quitarDeCola('p-tarde')` caía dentro del caso de abajo, que afirma que
     * NADIE lo llamó. La suite fallaba 2 de 5 corridas por eso, y la iteración 1 lo
     * tapó metiendo una guarda en el producto — un test que se protege cambiando lo
     * que prueba está midiendo su propio andamio. La aserción es de más, no de
     * menos: las dos entradas salen de la cola.
     */
    await waitFor(() => expect(quitarDeCola).toHaveBeenCalledTimes(2))
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
    expect(addItem.mock.calls.map(c => (c[3] as { nombre: string }).nombre),
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
    expect(addItem.mock.calls.map(c => (c[3] as { nombre: string }).nombre),
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
    encolar.mockResolvedValue('rechazado')
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
    let soltar!: (v: string) => void
    encolar.mockImplementation(() => new Promise<string>(r => { soltar = r }))
    sinRedAhora = true
    const r = montar()
    await tecleaYEnvia(r, 'lentejas')
    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'el campo no se liberó: apuntar dos cosas seguidas obliga a esperar').toBe('')

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await act(async () => { soltar('rechazado') })

    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'la rama de fallo pisó lo que se estaba tecleando').toBe('garbanzos')
    expect(r.getByTestId('notice').textContent).toContain(SIN_ALMACEN)
  })

  it('DoD 47: y con un duplicado sin red, igual', async () => {
    // Spec E / i1-R1 — Lo que la rama sin red espera es el **barrido**, que es el que
    // trae lo vivo en un solo viaje; `leerCola` ya no interviene en este camino.
    let soltar!: (v: { vivos: Pendiente[]; descartadas: number }) => void
    barrerCaducados.mockResolvedValueOnce({ vivos: [], descartadas: 0 })
    barrerCaducados.mockImplementation(() => new Promise(r => { soltar = r }))
    sinRedAhora = true
    const r = montar()
    await tecleaYEnvia(r, 'lentejas')

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'garbanzos' } })
    await act(async () => { soltar({ vivos: [pendiente('lentejas', 1_000)], descartadas: 0 }) })

    expect((r.getByTestId('item-name') as HTMLInputElement).value,
      'el duplicado sin red pisó lo que se estaba tecleando').toBe('garbanzos')
  })

  /**
   * DoD 60 — Y se devuelve **entero** o nada. Mirando cada campo por su cuenta,
   * quien teclea sólo el nombre durante la espera se encontraba su producto con
   * la cantidad del anterior: pedía «pan» y le salía «pan, 2».
   */
  it('DoD 60: tecleando sólo el nombre, no aparece la cantidad del anterior', async () => {
    let soltar!: (v: string) => void
    encolar.mockImplementation(() => new Promise<string>(r => { soltar = r }))
    sinRedAhora = true
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    fireEvent.change(r.getByTestId('item-qty'), { target: { value: '2' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'pan' } })
    await act(async () => { soltar('rechazado') })

    expect((r.getByTestId('item-name') as HTMLInputElement).value).toBe('pan')
    expect((r.getByTestId('item-qty') as HTMLInputElement).value,
      'se cruzaron dos altas: el nombre nuevo con la cantidad del anterior').toBe('')
  })

  // La sonda: si nunca devolviera nada, los tres de arriba pasarían por vacío.
  it('y si nadie ha tecleado nada, lo que falló vuelve al campo', async () => {
    encolar.mockResolvedValue('rechazado')
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
    encolar.mockResolvedValue('rechazado')
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

  it('DoD 17: el envío se recupera y la relectura sigue fallando: se dice cuál falla', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      /**
       * Iteración 2 / R4 — La relectura falla con una clase **distinta** de la
       * que produjo el aviso de la cola. Con las dos en `servidor` los textos
       * coincidían y la aserción no podía distinguir «quedó el de la cola» de
       * «quedó el de la relectura»: medido, seguía verde con la limpieza quitada.
       */
      activeItems.mockResolvedValue({ data: [], clase: 'sin-acceso', code: '42501' })
      addItem.mockResolvedValueOnce(falloReal())
      const r = montar()
      await apuntar3(r, 'lentejas')
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })

      expect(r.queryAllByTestId('item-pendiente')).toHaveLength(0)
      /**
       * Esta aserción era `toBeNull()`, y afirmaba el defecto que la deuda 40
       * describe palabra por palabra: con `loadClase` nulo y la relectura
       * fallando, la pantalla se quedaba muda. Lo que la prueba protege de verdad
       * —que no quede el aviso de la cola mintiendo con el producto ya en la
       * lista— se conserva aquí: el que queda es el de la relectura.
       */
      expect(r.queryByTestId('notice'),
        'la relectura falló y la pantalla se quedó muda: deuda 40').not.toBeNull()
      expect(r.queryByTestId('notice')!.textContent,
        'quedó el aviso de la cola, que con el producto ya en la lista es mentira')
        .toBe(RELECTURA)
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
      /**
       * Aviso AJENO, puesto por otro camino. Antes tenía que ser de clase
       * `servidor` **y** la relectura tenía que seguir fallando, porque
       * `reintentar` limpiaba el hueco entero al acertar; con las dos en
       * `servidor` los textos coincidían y la aserción no distinguía «sobrevivió»
       * de «lo sustituyó otro igual». Era el mismo agujero que el DoD 17 tuvo.
       *
       * R4.1 lo hace comprobable: la recuperación retira sólo lo suyo, así que la
       * relectura puede acertar y el aviso ajeno tiene que seguir ahí. Es la
       * puerta que abre el arreglo, probada por donde la abre (§E.4b).
       */
      activeItems.mockResolvedValue({ data: [], clase: null, code: null })
      softDeleteItem.mockResolvedValue({ data: null, clase: 'sin-acceso', code: '42501' })
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
    /**
     * Spec B / R3 — La guarda es la misma y es más fuerte: lo que no puede pasar
     * es que a quien se ha quedado sin red se le culpe al servidor, ni que se le
     * mande reintentar a mano algo que ya está en la cola. Antes se comprobaba
     * pidiendo el texto de `'red'`; ahora el hecho «encolado» tiene texto propio
     * que no señala a nadie, y se afirman los dos negativos explícitamente.
     */
    const texto = r.getByTestId('notice').textContent
    expect(texto,
      'se le enseña «el servicio está despertando» a quien se ha quedado sin red')
      .not.toBe(mensajeDe('servidor'))
    expect(texto,
      'se le manda reintentar a mano un producto que ya está guardado en la cola')
      .not.toBe(mensajeDe('red'))
    expect(texto, 'el aviso de lo encolado no dice dónde quedó el producto').toBe(EN_COLA)
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
      /**
       * Iteración 2 / R4 — Monta con `null`, no con `'servidor'`. Aquel prop sólo
       * estaba aquí por `setResueltaPara(loadClase)`, que R3 borró, y con él la
       * relectura del reintento de montaje satisfacía el recuento sola: medido,
       * borrando la relectura del drenado esta prueba **seguía verde**.
       */
      const r = montar()
      await encolarFallando(r, 'lentejas')
      activeItems.mockClear()
      activeItems.mockResolvedValue({ data: [fila('arroz')], clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      /**
       * Spec B / R1 — Eran una y pasan a ser dos, y las dos tienen dueño: la del
       * drenado, y el **reintento de carga sobreviviendo** a `limpiarAviso()`.
       * Que antes fuera una era la regresión I1 metida en una cifra. Se afirma el
       * suelo —que se relee, o la lista se queda rancia— y el techo —que no
       * vuelve el bucle de cinco que R13 quitó—.
       */
      expect(activeItems.mock.calls.length,
        'no se releyó una vez tras vaciar la cola: la lista se queda rancia').toBe(1)
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

/**
 * Spec B — El ciclo de vida de aviso-y-recuperación.
 *
 * Viven aquí y no en un fichero propio porque el arnés que hace falta ya está
 * montado en éste: `GroupView` real, con `loadClase` gobernable desde el test y
 * la red conmutable a mitad de una petición en vuelo. Duplicar ese banco al lado
 * es la deriva que la cicatriz N3 describe.
 */
const avisoTexto = (r: ReturnType<typeof render>) =>
  r.queryByTestId('notice')?.textContent ?? null

describe('Spec B · cada generación sella una sola cosa', () => {
  /**
   * DoD 1 / R1 + R2 — Vigila **dos partes**: que `limpiarAviso` incremente sólo
   * la generación de avisos, y que `reintentar` se selle con la de recuperación.
   * Hoy una sola generación sella las tres cosas, así que apuntar algo mata la
   * recuperación en vuelo sin que nada lo diga. Es la regresión I1.
   */
  it('DoD 1: limpiar un aviso no mata un reintento de carga en vuelo', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [fila('llegada')], clase: null, code: null })
      const r = montarCon('servidor')
      await act(async () => {})

      // Antes de que venza la primera espera del reintento (1 s), se apunta algo:
      // `onAdd` empieza llamando a `limpiarAviso()`.
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'pan' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })

      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(activeItems, 'el reintento murió al limpiar el aviso: regresión I1')
        .toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

})

describe('Spec B · un solo origen para el aviso visible', () => {
  /**
   * RETIRADA (spec del reducer, §2b) — «DoD 3: retirado el aviso, un loadClase que no
   * cambia no lo repone». Su montaje usaba una escritura correcta para vaciar el
   * hueco, y esa escritura ya no retira la condición de carga: un alta que sale bien
   * no desmiente «ya no tienes acceso a este grupo». No se reescribe con otro
   * escenario —eso fue el error de una vuelta anterior—: lo que vigilaba, la
   * comparación que impide reanunciar, lo juzga la pasada de mutación del ítem 8.
   */


  /**
   * DoD 4 / R3 — La mitad de **conversión**: la clase que trae el servidor pasa
   * por `avisar`, y por tanto se refina con la red. Hoy el derivado pinta
   * `mensajeDe(loadClase)` en crudo, así que a quien está sin red se le culpa al
   * servidor de su propia conexión.
   */
  it('DoD 4: sin red, un loadClase de servidor culpa a la red y no al servidor', async () => {
    sinRedAhora = true
    const r = montarCon('servidor')
    await waitFor(() => expect(avisoTexto(r)).toBeTruthy())
    expect(avisoTexto(r), 'culpó al servidor de la red del usuario')
      .toBe(mensajeDe('red'))
  })

  /**
   * `[REGRESIÓN]` — verde hoy por el derivado, y tiene que seguir verde por el
   * aviso normal: un `loadClase` que cambia tras el montaje se anuncia.
   */
  it('DoD 4b: un loadClase que cambia tras el montaje produce aviso', async () => {
    const r = render(vista(null))
    await waitFor(() => expect(avisoTexto(r)).toBeNull())
    await act(async () => { r.rerender(vista('sin-acceso')) })
    await waitFor(() => expect(avisoTexto(r), 'el cambio de clase no se anunció').toBeTruthy())
  })
})

describe('Spec B · el refinado usa la red viva', () => {
  const caeLaRedAMitad = () => {
    let soltar!: (v: unknown) => void
    const parado = new Promise(r => { soltar = r })
    return { parado, soltar }
  }

  /**
   * DoD 5 / R4 — Camino de **edición**. `avisar` refina con `!sinRed`, el valor
   * del render en que se creó el manejador; la rama de la cola usa
   * `!sinRedVivo.current`. La ventana es la que la deuda 34 nombró: la red cae
   * entre pulsar y responder.
   */
  it('DoD 5: la red cae durante una edición y se culpa a la red', async () => {
    const { parado, soltar } = caeLaRedAMitad()
    updateItem.mockReturnValue(parado)
    const r = render(vista(null, [fila('sal')]))
    await act(async () => {})
    const campo = r.getByLabelText('Nombre')
    fireEvent.change(campo, { target: { value: 'sal gorda' } })
    await act(async () => { fireEvent.blur(campo) })

    await ponerSinRed(true)
    await act(async () => { soltar({ data: null, clase: 'servidor', code: null }) })

    await waitFor(() => expect(avisoTexto(r)).toBeTruthy())
    expect(avisoTexto(r), 'culpó al servidor de la red del usuario').toBe(mensajeDe('red'))
  })

  /** DoD 6 / R4 — El mismo refinado, camino de **borrado**. */
  it('DoD 6: la red cae durante un borrado y se culpa a la red', async () => {
    const { parado, soltar } = caeLaRedAMitad()
    softDeleteItem.mockReturnValue(parado)
    const r = render(vista(null, [fila('sal')]))
    await act(async () => {})
    await act(async () => { fireEvent.click(r.getByTestId('delete-item')) })

    await ponerSinRed(true)
    await act(async () => { soltar({ data: null, clase: 'servidor', code: null }) })

    await waitFor(() => expect(avisoTexto(r)).toBeTruthy())
    expect(avisoTexto(r), 'culpó al servidor de la red del usuario').toBe(mensajeDe('red'))
  })
})

describe('Spec B · el aviso se retira después de saber', () => {
  /**
   * DoD 7b / R5 — La **otra** mitad: con la relectura buena, el aviso de la cola
   * se retira. Sin `loadClase`, porque con él el reintento de carga limpia por su
   * cuenta y tapa la falta — lo demostró la pasada de mutación del ítem 10, que
   * dejó verdes tanto al DoD 17 como al DoD 25 con la limpieza quitada.
   */
  it('DoD 7b: vaciada la cola y releída bien, el aviso de la cola se va', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      const r = montar()
      // El alta falla de verdad: eso encola **y** pinta el aviso `deCola`, que es
      // justo lo que hay que ver desaparecer. Sembrar la cola a mano no lo pinta,
      // y entonces el test pasaría sin nada que retirar — lo midió el ítem 10.
      addItem.mockResolvedValueOnce({
        data: null, clase: claseDe({ message: 'Failed to fetch' } as never), code: '' })
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      cola = [...cola, encolar.mock.calls.at(-1)![0] as Pendiente]
      expect(r.queryByTestId('notice'), 'no se pintó el aviso de la cola').not.toBeNull()

      addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [fila('lentejas')], clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })

      expect(r.queryAllByTestId('item-pendiente'), 'la cola no se vació').toHaveLength(0)
      expect(r.queryByTestId('notice'),
        'la cola se vació y el aviso sigue diciendo que se enviará al volver la red').toBeNull()
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 7 / R5 — Vigila que la limpieza ocurra **dentro de la rama que
   * confirmó**. Hoy se limpia antes de releer: si la relectura falla y no hay
   * `loadClase` que pinte un derivado, la pantalla se queda muda.
   */
  it('DoD 7: una relectura fallida con loadClase nula deja señal en pantalla', async () => {
    colaViva()
    cola = [{ id: 'p1', usuario: 'u1', grupo: 'g1', nombre: 'sal', cantidad: null, creado: Date.now() }]
    addItem.mockResolvedValue({ data: fila('sal'), clase: null, code: null })
    activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })

    const r = montarCon(null)
    await waitFor(() => expect(addItem).toHaveBeenCalled())
    await waitFor(() => expect(activeItems).toHaveBeenCalled())

    expect(avisoTexto(r), 'la relectura falló y la pantalla se quedó muda')
      .toBeTruthy()
  })
})

/**
 * Spec B / iteración 2 — Lo que el refactor rompió, medido contra `HEAD`.
 */
describe('Spec B · el refactor no puede perder lo que la capa derivada hacía sola', () => {
  /**
   * DoD 1 / R1 — El efecto viejo llevaba `[loadClase, sinRed]`. Con la red
   * parpadeando al arrancar —«1 de cada 3 arranques», lo dice este mismo
   * fichero— `avisar` refina a `red` y no arranca nada; cuando la red vuelve
   * tiene que rearmarse alguien.
   */
  it('iter2 DoD 1: con la red volviendo, la carga fallida se relee', async () => {
    vi.useFakeTimers()
    try {
      sinRedAhora = true
      activeItems.mockResolvedValue({ data: [fila('llegada')], clase: null, code: null })
      montarCon('servidor')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(activeItems, 'sin red no debe sondear al servidor').not.toHaveBeenCalled()

      await ponerSinRed(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(activeItems, 'volvió la red y no se rearmó nadie: la lista se queda vacía')
        .toHaveBeenCalled()
    } finally { vi.useRealTimers(); sinRedAhora = false }
  })

  /**
   * DoD 2 y 3 / R2 — El aviso derivado se apagaba solo cuando `loadClase` dejaba
   * de venir. `notice` es estado: si nadie lo retira, queda sobre una lista
   * fresca. Para `servidor` el bucle lo tapa en ≤23 s; para estas dos, nada.
   */
  it.each<[Clase, string]>([
    ['sin-acceso', 'DoD 2'],
    ['sesion', 'DoD 3'],
  ])('iter2 %s (%s): una clase que se resuelve retira su aviso', async (clase) => {
    const r = montarCon(clase)
    await waitFor(() => expect(r.queryByTestId('notice')).not.toBeNull())
    await act(async () => { r.rerender(vista(null)) })
    await waitFor(() => expect(r.queryByTestId('notice'),
      'la carga se resolvió y el aviso sigue en pantalla sobre una lista buena').toBeNull())
    expect(r.queryByTestId('volver-a-entrar'),
      'el callejón de «Volver a entrar» con la sesión ya buena').toBeNull()
  })

  /**
   * DoD 4 / R3 — `envio` se invalida al desmontar (`:349`); `recuperacion` no.
   * El DoD 15 no lo cubre: mide `addItem`, no `activeItems`.
   */
  it('iter2 DoD 4: tras desmontar, la recuperación deja de llamar', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      const r = montarCon('servidor')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      const antes = activeItems.mock.calls.length
      expect(antes, 'no llegó a sondear').toBeGreaterThan(0)
      r.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(activeItems.mock.calls.length,
        'la recuperación siguió llamando sobre un árbol muerto').toBe(antes)
    } finally { vi.useRealTimers() }
  })
})

/**
 * Spec B / R3 reescrita — Anunciar y rearmar son dos disparadores. Los tres
 * tests de abajo atacan la vista, que es la capa que el requisito nombra: el
 * mecanismo vive en efectos y estado del componente.
 */
describe('R3 reescrita · anunciar no es rearmar', () => {
  /**
   * DoD 1 / R3.3 — `loadClase` es una prop del render del servidor y NO cambia
   * cuando la recuperación resuelve dentro del componente. Sin una marca de
   * resuelta, «resuelta» y «aún no anunciada» son el mismo estado, y el
   * siguiente parpadeo repone el aviso sobre una lista buena. Es I6 otra vez.
   */
  it('r3bis DoD 1: resuelta la carga, un parpadeo de red no repone el aviso', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [fila('llegada')], clase: null, code: null })
      const r = montarCon('servidor')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(r.queryByTestId('notice'),
        'la recuperación trajo la lista y el aviso sigue puesto').toBeNull()

      await ponerSinRed(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(r.queryByTestId('notice'),
        'irse la red repuso un aviso sobre una lista ya traída').toBeNull()

      await ponerSinRed(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      expect(r.queryByTestId('notice'),
        'volver la red repuso «el servicio está despertando» sobre una lista buena').toBeNull()
    } finally { vi.useRealTimers(); sinRedAhora = false }
  })

  /**
   * RETIRADA (spec del reducer, §2b) — «r3bis DoD 2». Mismo montaje y mismo motivo
   * que la de arriba; las dos caen por la misma causa, contada mal como una.
   */


  /**
   * DoD 2b / R3.2 y R3.3 — La otra mitad de las dos puertas: se **reinician**
   * cuando la carga deja de fallar. Sin el reinicio, una segunda carga fallida de
   * la MISMA clase se queda callada, porque sigue pareciendo la ya anunciada o la
   * ya resuelta. Es J7 por la puerta de al lado: aquel test usa una clase
   * distinta para el segundo fallo, así que no lo mira. Lo encontró la pasada de
   * mutación del ítem 7 — quitar el reinicio dejaba la suite entera verde.
   */
  it('r3bis DoD 2b: recuperada una carga, otra igual que falla vuelve a anunciarse', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [fila('llegada')], clase: null, code: null })
      const r = montarCon('servidor')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(r.queryByTestId('notice')).toBeNull()

      // La carga se resolvió...
      await act(async () => { r.rerender(vista(null)) })
      // ...y el servicio se vuelve a dormir: mismo fallo, otra vez.
      await act(async () => { r.rerender(vista('servidor')) })
      expect(r.queryByTestId('notice')?.textContent ?? '',
        'el segundo fallo de la misma clase no se anunció: la lista se queda vieja y callada')
        .toContain('despertando')
    } finally { vi.useRealTimers() }
  })

  /**
   * RETIRADA (iteración 1 del reducer, R3) — «r3bis DoD 2c». Existía para vigilar el
   * reinicio de `cargaAnunciada`, y esa ref está muerta y borrada. Medido: ninguna
   * mutación la pone roja —ni quitar el reinicio de `cargaResuelta`, que caza la 2b,
   * ni quitar la puerta de resuelta, que caza la DoD 1—. El comportamiento que decía
   * vigilar —una segunda carga fallida de la misma clase se anuncia— sigue siendo
   * cierto, pero ahora **por construcción**: sin comparación previa, el disparador
   * anuncia siempre que corre, así que no queda mecanismo que quitarle. Un test que
   * no puede fallar ocupa el sitio del que sí probaría (§E.3).
   */


  /**
   * DoD 3 / R3.4 — La regla de prioridad, punto 1: una escritura de carga sólo
   * aterriza sobre un hueco vacío o sobre otro aviso de carga. Con la capa
   * derivada esto era estructural (`notice ?? derivado`: el estado siempre
   * ganaba); con un solo hueco y diez escritores lo decide el orden de llegada.
   */
  it('r3bis DoD 3: un parpadeo de red no pisa el aviso de una mutación', async () => {
    activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
    softDeleteItem.mockResolvedValue({ data: 0, clase: null, code: null })
    const r = render(vista('servidor', [fila('leche')]))
    await act(async () => { fireEvent.click(r.getByTestId('delete-item')) })
    await waitFor(() => expect(r.getByTestId('notice').textContent).toContain(GONE))

    await ponerSinRed(true)
    await ponerSinRed(false)
    expect(r.getByTestId('notice').textContent,
      'el parpadeo pisó el aviso de la mutación con el de la carga').toContain(GONE)
  })

  /**
   * DoD 5 / R3.5 — La relectura del drenado la contesta el servidor que acaba de
   * aceptar el envío: no hay nada que reintentar. Anunciar su fallo por `avisar`
   * arrancaba además un bucle de carga encima del de envío — el doble bucle que
   * `N4` ya quitó una vez.
   */
  it('r3bis DoD 5: una relectura fallida del drenado no arranca el bucle de carga', async () => {
    vi.useFakeTimers()
    try {
      cola = [pendiente('leche', 0)]
      colaViva()
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      montar()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(activeItems.mock.calls.length,
        'la relectura fallida arrancó el bucle de carga encima del de envío').toBe(1)
    } finally { vi.useRealTimers() }
  })
})

/**
 * Spec B / R3 reescrita, iteración 2 — La regla de prioridad cubría las
 * escrituras del mecanismo de carga y no sus retiradas; y el aviso que quedó tras
 * quitar el rearme seguía prometiéndolo.
 */
describe('R3 reescrita · las retiradas también tienen dueño', () => {
  /**
   * DoD 1 / R4.1 — `limpiarAviso()` dentro de `reintentar` es un cuarto escritor
   * del hueco, del mecanismo de carga, y se llevaba por delante el aviso de una
   * mutación. La puerta la abrió R1 al separar las generaciones; R3.4 la cerró
   * sólo del lado de la escritura.
   */
  it('r3bis-2 DoD 1: la recuperación no se lleva el aviso de una mutación', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [fila('llegada')], clase: null, code: null })
      softDeleteItem.mockResolvedValue({ data: 0, clase: null, code: null })
      const r = render(vista('servidor', [fila('leche')]))
      await act(async () => { fireEvent.click(r.getByTestId('delete-item')) })
      expect(r.getByTestId('notice').textContent).toContain(GONE)

      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(r.queryByTestId('notice')?.textContent ?? '',
        'la recuperación borró el aviso de la mutación que el usuario acababa de provocar')
        .toContain(GONE)
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 2 / R4.2 — `SERVIDOR` dice «lo reintentamos solo». Tras R3.5 ese camino
   * ya no reintenta, así que el mensaje miente. Su gemelo de `:716` dice la
   * verdad para el mismo hecho desde el ciclo de la deuda 34.
   */
  it('r3bis-2 DoD 2: la relectura fallida del drenado no promete un reintento', async () => {
    vi.useFakeTimers()
    try {
      cola = [pendiente('leche', 0)]
      colaViva()
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      const r = montar()
      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(r.queryByTestId('notice')?.textContent ?? '',
        'promete un reintento que ya no existe').toContain(RELECTURA)
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 3 / R4.3 — El disparador de rearme no miraba `cargaResuelta`, así que
   * rearmaba con cada parpadeo durante toda la vida de la pestaña.
   */
  it('r3bis-2 DoD 3: resuelta la carga, un parpadeo no vuelve a sondear', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [fila('llegada')], clase: null, code: null })
      montarCon('servidor')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      const antes = activeItems.mock.calls.length
      expect(antes, 'no llegó a recuperarse').toBe(1)

      await ponerSinRed(true)
      await ponerSinRed(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      expect(activeItems.mock.calls.length,
        'un parpadeo rearmó una carga que ya estaba resuelta').toBe(antes)
    } finally { vi.useRealTimers(); sinRedAhora = false }
  })

  /**
   * DoD 4 / R4.3 — Y no invalidaba el bucle en vuelo al irse la red: seguía
   * sondeando a un servidor inalcanzable hasta agotar sus cinco esperas.
   */
  it('r3bis-2 DoD 4: al irse la red, la recuperación en vuelo para', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      montarCon('servidor')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      const antes = activeItems.mock.calls.length
      expect(antes, 'no llegó a sondear').toBeGreaterThan(0)

      await ponerSinRed(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(activeItems.mock.calls.length,
        'siguió sondeando al servidor con la red caída').toBe(antes)
    } finally { vi.useRealTimers(); sinRedAhora = false }
  })
})

/**
 * Spec del reducer — Lo que el principio de «sucesos y estados» cambia, visto donde
 * el usuario lo ve. La tabla vive en `unit/aviso.test.ts`; esto es la superficie que
 * el requisito promete (§E.1).
 */
describe('el reducer del aviso · visto en la pantalla', () => {
  /**
   * DoD 3 — El usuario acaba de hacer un gesto y espera leer su resultado. Una
   * lista rancia es un estado; un borrado fallido es un suceso.
   */
  it('reducer DoD 3: una relectura fallida del drenado no pisa el aviso de un borrado', async () => {
    vi.useFakeTimers()
    try {
      cola = [pendiente('leche', 0)]
      colaViva()
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      softDeleteItem.mockResolvedValue({ data: 0, clase: null, code: null })
      const r = render(vista(null, [fila('arroz')]))
      await act(async () => { fireEvent.click(r.getByTestId('delete-item')) })
      expect(r.getByTestId('notice').textContent).toContain(GONE)

      await act(async () => { await vi.advanceTimersByTimeAsync(500) })
      expect(r.queryByTestId('notice')?.textContent ?? '',
        'la relectura pisó el aviso del gesto que el usuario acababa de hacer').toContain(GONE)
    } finally { vi.useRealTimers() }
  })

  /**
   * La pidió la pasada de mutación del ítem 8: quitar la invalidación de
   * `recMutacion` al desmontar dejaba las 103 en verde. Su gemela para la
   * recuperación de carga existe desde la iteración 2; ésta nació con la
   * generación nueva y llegó sin vigilancia. Es la cicatriz N3 por el otro lado.
   */
  it('reducer DoD 3b: tras desmontar, la recuperación de una mutación deja de llamar', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      softDeleteItem.mockResolvedValue({ data: null, clase: 'servidor', code: '' })
      const r = render(vista(null, [fila('arroz')]))
      await act(async () => { fireEvent.click(r.getByTestId('delete-item')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      const antes = activeItems.mock.calls.length
      expect(antes, 'el borrado fallido no arrancó la recuperación').toBeGreaterThan(0)

      r.unmount()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(activeItems.mock.calls.length,
        'la recuperación de la mutación siguió llamando sobre un árbol muerto').toBe(antes)
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 4 — «Un alta que sale bien no borra *ya no tienes acceso a este grupo*,
   * porque eso sigue siendo cierto.» Decisión del usuario, 2026-09-14.
   */
  it('reducer DoD 4: un alta con éxito no borra la condición de carga', async () => {
    const r = montarCon('sin-acceso')
    expect(r.getByTestId('notice').textContent).toContain(SIN_ACCESO)

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'pan' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'la operación con éxito se llevó una condición que sigue siendo cierta').toContain(SIN_ACCESO)
  })

  /**
   * DoD 5 — El hueco por el que entró el CRITICAL: la Spec B declaró que quitar el
   * lanzamiento de `avisar` pondría roja una prueba, y esa guarda caducó. Se prueba
   * por el camino donde falla — una mutación, no la carga— y **tras un parpadeo**.
   */
  it('reducer DoD 5: un borrado fallido con servidor arranca la recuperación, y sobrevive a un parpadeo', async () => {
    vi.useFakeTimers()
    try {
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      softDeleteItem.mockResolvedValue({ data: null, clase: 'servidor', code: '' })
      const r = render(vista(null, [fila('arroz')]))
      await act(async () => { fireEvent.click(r.getByTestId('delete-item')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_500) })
      const armado = activeItems.mock.calls.length
      expect(armado, 'el borrado fallido no arrancó la recuperación').toBeGreaterThan(0)

      await ponerSinRed(true)
      await ponerSinRed(false)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(activeItems.mock.calls.length,
        'un parpadeo mató la recuperación de una mutación, y el aviso sigue prometiéndola')
        .toBeGreaterThan(armado)
    } finally { vi.useRealTimers(); sinRedAhora = false }
  })
})

/**
 * Spec «el eje que faltaba es la duración» — El fallo medido, visto donde el usuario
 * lo ve: abrir con la carga fallida y la cola caducada borraba el aviso de que se
 * habían descartado productos, que es la única señal de que desaparecieron.
 */
describe('duración · lo de una vez tapa el nivel, no lo borra', () => {
  it('duracion DoD 2: con la carga fallida, el aviso de apertura se ve igual', async () => {
    cola = [pendiente('viejo', 40 * 60 * 60 * 1000)]
    colaViva()
    const r = montarCon('sin-acceso')
    await waitFor(() => expect(quitarDeCola).toHaveBeenCalled())
    await act(async () => {})
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'la condición de carga se tragó la única señal de que el producto se descartó')
      .toContain('descart')
  })

  it('duracion DoD 2b: y leído ese aviso, la condición de carga sigue debajo', async () => {
    cola = [pendiente('viejo', 40 * 60 * 60 * 1000)]
    colaViva()
    const r = render(vista('sin-acceso', [fila('arroz')]))
    await waitFor(() => expect(quitarDeCola).toHaveBeenCalled())
    softDeleteItem.mockResolvedValue({ data: 1, clase: null, code: null })
    await act(async () => { fireEvent.click(r.getAllByTestId('delete-item')[0]) })
    await waitFor(() => expect(r.queryByTestId('notice')?.textContent ?? '',
      'el aviso de apertura se fue y no quedó la condición de carga debajo')
      .toContain(SIN_ACCESO))
  })
})

/**
 * Duración / lista 2 — La retirada del aviso de la cola dejó de estar vigilada al
 * pasar `cola` a nivel: la relectura ya no lo **sobrescribe**, lo **tapa**, así que
 * quitar la retirada no se nota mientras el aviso de una vez esté delante. Se nota
 * en cuanto se lee, y lo que queda debajo es mentira: la cola está vacía.
 *
 * El aviso de la cola tiene que nacer del gesto del usuario —apuntar sin red—, no
 * de sembrar el array: sembrado, nadie lo escribe y el test no puede fallar.
 */
describe('duración · la cola vaciada retira su aviso aunque haya otro encima', () => {
  /**
   * CORRECCIÓN (2026-09-15) — Aquí decía que las dos retiradas del aviso de la cola
   * estaban sin vigilar. **Era falso**, y salió de un instrumento roto: el `perl` de
   * la pasada de mutación exigía doce espacios de sangría y una de las dos líneas
   * tenía diez, así que borraba una creyendo borrar dos. Las dos eran guardias vivos.
   *
   * Ya no existen: las sustituyó una sola retirada en la rama `!p` del drenado, que
   * las subsume por construcción y además cubre el caso que ninguna cubría —otra
   * pestaña vaciando la cola compartida—. Lo vigila «duracion-it1 DoD 1».
   */
  it('duracion DoD 3: vaciada la cola, no queda aviso', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      // El aviso de la cola nace cuando el envío falla con `servidor`, no en el
      // camino sin red: sembrar el array no lo escribe y el test no podría fallar.
      addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [fila('leche')], clase: null, code: null })
      const r = montar()
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      expect(r.queryByTestId('notice'), 'el envío fallido no dejó aviso de cola').not.toBeNull()
      // `encolar` es un doble que no empuja al array: sin esto el drenado no
      // encuentra nada, `envioHecho` se queda en falso y el test no prueba nada.
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]

      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryByTestId('notice'),
        'la cola se vació y su aviso sigue: con `cola` como nivel, nada lo sobrescribe')
        .toBeNull()
    } finally { vi.useRealTimers() }
  })
})

/**
 * Iteración 1 de la duración — Lo que `cola` como nivel cambió, y lo que abrió.
 */
describe('duración · el aviso de la cola no sobrevive a su condición', () => {
  /**
   * DoD 2 / R2 — La puerta que abrió pasar `cola` a nivel: la relectura fallida ya
   * no lo **sobrescribe**, lo **tapa**. Si nadie lo retira al vaciar la cola, una
   * operación con éxito se lleva lo de una vez y el de la cola **resucita** sobre
   * una cola ya vacía. Es lo que `GroupView.tsx:461` impide.
   */
  it('duracion-it1 DoD 2: tras una relectura fallida y un alta buena, el aviso de la cola no resucita', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      // La relectura del drenado falla: su aviso tapa al de la cola.
      activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
      const r = montar()
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      await act(async () => { await vi.advanceTimersByTimeAsync(25_000) })
      expect(r.queryByTestId('notice')?.textContent ?? '').toContain(RELECTURA)

      // Y ahora una operación que va bien: se lleva lo de una vez.
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'pan' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(50) })
      // El aviso de la cola, con red, pinta el texto de `servidor`: buscar «volver
      // la red» no distinguiría nada. Se comprueba que NO queda nada, que es lo que
      // toca con la cola vacía y la última operación correcta.
      expect(r.queryByTestId('notice')?.textContent ?? 'NINGUNO',
        'el aviso de la cola resucitó con la cola ya vacía').toBe('NINGUNO')
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 2 — **Dos instancias sobre la misma cola.** Los dos casos que la spec de
   * la duración retiró, repuestos aquí, que es su sitio: la cola vive en IndexedDB
   * y la comparten todas las pestañas (§D.3), pero nada avisaba del cambio.
   *
   * Ahora avisa el almacén, y quien recibe **relee**: el mensaje es una señal de
   * «mira otra vez», nunca un dato. Por eso el arnés deja que la vista relea de
   * verdad en vez de aplicarle lo que otro dice.
   */
  it('durable DoD 2: si otra pestaña vacía la cola, ésta retira su aviso', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [fila('leche')], clase: null, code: null })
      const r = montar()
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      expect(r.queryByTestId('notice'), 'no llegó a avisar de la cola').not.toBeNull()

      // Otra instancia la vacía y lo anuncia. Esta pestaña no ha tocado nada.
      cola = []
      await act(async () => { avisarDeOtraPestana(); await vi.advanceTimersByTimeAsync(50) })
      expect(r.queryByTestId('notice')?.textContent ?? 'NINGUNO',
        'se quedó prometiendo un envío que otra pestaña ya hizo').toBe('NINGUNO')
    } finally { vi.useRealTimers() }
  })

  it('durable DoD 2b: y también retira sus fichas', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [fila('leche')], clase: null, code: null })
      const r = montar()
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      expect(r.queryAllByTestId('item-pendiente'), 'no pintó la ficha').toHaveLength(1)

      cola = []
      await act(async () => { avisarDeOtraPestana(); await vi.advanceTimersByTimeAsync(50) })
      expect(r.queryAllByTestId('item-pendiente'),
        'sigue enseñando como pendiente algo que otra pestaña ya envió').toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 3 — La señal sobrevive a no haberla oído. Un mensaje se pierde si lo
   * escribió un contexto sin canal, o si el navegador no lo soporta; volver a la
   * pestaña es el momento en que el usuario mira, y por tanto el momento en que lo
   * que ve tiene que ser verdad.
   */
  it('durable DoD 3: al volver a la pestaña se relee la cola', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [fila('leche')], clase: null, code: null })
      const r = montar()
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]
      expect(r.queryAllByTestId('item-pendiente')).toHaveLength(1)

      // Otra instancia vacía la cola SIN que llegue el mensaje, y el usuario vuelve.
      cola = []
      await act(async () => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await vi.advanceTimersByTimeAsync(50)
      })
      expect(r.queryAllByTestId('item-pendiente'),
        'se volvió a la pestaña y seguía enseñando lo que ya no está').toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  /**
   * DoD 2c — La otra mitad, y es la que impide aplicar el mensaje como dato: si
   * la cola **no** se vació, la señal no debe llevarse nada. Sin releer, un aviso
   * de «cambió» borraría lo que sigue pendiente.
   */
  it('durable DoD 2c: un aviso con la cola aún llena no se lleva nada', async () => {
    vi.useFakeTimers()
    try {
      colaViva()
      addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
      addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
      activeItems.mockResolvedValue({ data: [fila('leche')], clase: null, code: null })
      const r = montar()
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      cola = [...cola, encolar.mock.calls[0][0] as Pendiente]

      // Spec B / R1 — La señal ahora **también drena**, así que el servicio se
      // queda caído durante toda esta parte: si dejara de estarlo, lo que vaciaría
      // la cola sería el envío y no habría nada que mirar. Lo que este caso guarda
      // es que la señal se relee, no se aplica como dato.
      addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
      // Otra pestaña apunta lo suyo: la cola cambia, pero lo nuestro sigue ahí.
      cola = [...cola, pendiente('pan de otra', 0)]
      await act(async () => { avisarDeOtraPestana(); await vi.advanceTimersByTimeAsync(50) })
      expect(r.queryByTestId('notice')?.textContent ?? 'NINGUNO',
        'el aviso se fue con la cola todavía llena').not.toBe('NINGUNO')
      expect(r.queryAllByTestId('item-pendiente').length,
        'se llevó por delante una ficha que sigue pendiente').toBeGreaterThan(0)
    } finally { vi.useRealTimers() }
  })
})

/**
 * Spec «el duplicado lo impide la escritura» / DoD 6 — La vista distingue las dos
 * razones por las que el almacén no guardó. Decir «no se pudo guardar» cuando el
 * producto SÍ está guardado es una pantalla mintiendo sobre la causa, y el aviso que
 * toca es el del duplicado.
 */
describe('R2 la vista distingue «ya estaba» de «no se pudo guardar»', () => {
  it('duplicado DoD 6: el almacén dice «ya estaba» y se avisa del duplicado', async () => {
    encolar.mockResolvedValue('ya-estaba')
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'dijo que no se pudo guardar sobre un producto que ya estaba').toContain(DUPLICADO)
    expect(r.queryAllByTestId('item-pendiente'), 'pintó ficha de algo que ya estaba').toHaveLength(0)
  })

  /**
   * Y el camino **normal** del duplicado sigue avisando: el que `decidirEncolar`
   * ve porque el producto ya está en pantalla. La pidió la pasada de mutación —
   * quitar ese aviso dejaba los 72 verdes—. El invariante del almacén es la red
   * para lo que la decisión no puede ver, no su sustituto.
   */
  it('duplicado DoD 6c: apuntar algo que ya está en la lista avisa del duplicado', async () => {
    // Sin red: es el camino que pasa por `decidirEncolar`, que con red no se toca.
    await ponerSinRed(true)
    const r = render(vista(null, [fila('leche')]))
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'el duplicado que la decisión sí ve dejó de avisar').toContain(DUPLICADO)
    expect(encolar, 'lo encoló pese a estar ya en la lista').not.toHaveBeenCalled()
  })

  // Sonda (§E.2): el rechazo del disco sigue diciendo lo suyo. Sin este caso, el de
  // arriba pasaría con las dos ramas dando el mismo mensaje.
  it('y un rechazo del disco sigue diciendo que no se pudo guardar', async () => {
    encolar.mockResolvedValue('rechazado')
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'leche' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.queryByTestId('notice')?.textContent ?? '').toContain(SIN_ALMACEN)
  })
})

/**
 * Spec F / F3 — **La secuencia que abre la resurrección, en la capa del drenado.**
 *
 * Envío aceptado, baja local que el almacén rechaza, y una segunda pasada. Lo que esta capa
 * tiene que garantizar es que el reenvío llegue **con la misma clave**: es lo único que
 * permite a la base reconocerlo como repetición. Si el drenado regenerara la clave —o mandara
 * un nombre suelto, como antes—, la base no vería repetición alguna y el producto tachado
 * volvería. Que la base efectivamente lo rechace lo prueban F1 y F2, con token real.
 *
 * Capa (§E.1): el requisito habla del envío del drenado, así que se monta la vista y se mira
 * qué manda, no se llama a `addItem` a mano.
 */
describe('Spec F / F3 · el reenvío lleva la misma clave', () => {
  it('F3: con la baja rechazada, la segunda pasada manda la misma clave de origen', async () => {
    const p = pendiente('lentejas', 1_000)
    leerCola.mockResolvedValue([p])
    // El almacén acepta el envío y **rechaza la baja**: la fila sobrevive en disco.
    quitarDeCola.mockResolvedValue(false)
    addItem.mockImplementation(async (...a: unknown[]) =>
      ({ data: fila(String((a[3] as { nombre: string }).nombre)), clase: null, code: null }))

    montar()
    await waitFor(() => expect(addItem).toHaveBeenCalledTimes(1))
    // Segunda pasada: la cola vuelve a entregar la fila, porque la baja no entró.
    await act(async () => { oyentesDeLaCola.forEach(f => f()) })
    await waitFor(() => expect(addItem.mock.calls.length).toBeGreaterThan(1))

    const claves = addItem.mock.calls.map(c => (c[3] as { id: string }).id)
    expect(claves[0], 'el primer envío no mandó la clave de la fila').toBe(p.id)
    expect(new Set(claves).size,
      'el reenvío llegó con otra clave: la base no puede reconocerlo y el tachado se resucita')
      .toBe(1)
  })
})

/**
 * Spec F / iteración 2 — **Los tres casos que la iteración 1 declaró imposibles de escribir.**
 *
 * Su lista decía que el arnés «no compone hoy» un `addItem` que falle con `servidor` y un
 * `encolar` que devuelva `'rechazado'` en la misma pasada. Los compone **este mismo fichero**, en
 * su caso «y un rechazo del disco sigue diciendo que no se pudo guardar». Era una excusa, no una
 * medida, y la revisión la desmintió con el fichero delante.
 */
const apuntarEn = async (r: { getByTestId: (id: string) => HTMLElement }, nombre: string) => {
  fireEvent.change(r.getByTestId('item-name'), { target: { value: nombre } })
  await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
}

describe('Spec F / iteración 2 · la clave sobrevive al gesto, y no más de lo debido', () => {
  const fallaElGesto = () => {
    // El servidor puede haber guardado la fila —`servidor` incluye un timeout después de
    // confirmar— y el disco no acepta encolar: la clave no queda en ninguna parte salvo el ref.
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('rechazado')
  }
  const apuntar = apuntarEn
  const claves = () => addItem.mock.calls.map(c => (c[3] as { id: string }).id)

  it('i2-2: reintentado el mismo producto, el segundo envío lleva la misma clave', async () => {
    fallaElGesto()
    const r = montar()
    await apuntar(r, 'leche')
    await apuntar(r, 'leche')
    expect(claves().length, 'no hubo dos envíos: el caso no mide nada').toBe(2)
    expect(new Set(claves()).size,
      'el reintento acuñó otra clave: el servidor puede tener la fila bajo la primera')
      .toBe(1)
  })

  it('i2-4: dos productos fallidos conservan cada uno su clave', async () => {
    fallaElGesto()
    const r = montar()
    await apuntar(r, 'leche')
    await apuntar(r, 'pan')
    await apuntar(r, 'leche')
    const [k1, , k3] = claves()
    expect(claves().length, 'faltan envíos').toBe(3)
    expect(k3, 'intercalar otro producto fallido perdió la clave del primero').toBe(k1)
  })

  /**
   * Iteración 3 — **La parte que la pasada dejó viva.** El mutante «la clave no se olvida cuando
   * el envío entra» sobrevivió: quitar `olvidarClave` en el camino del envío **aceptado** no ponía
   * nada rojo. El caso de abajo cubre el camino de la **cola**, no el del servidor, y nadie miraba
   * éste. Lo predijo la revisión y lo confirmó la pasada.
   */
  it('i2-4: la clave se olvida cuando el envío entra en el servidor', async () => {
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('rechazado')
    const r = montar()
    await apuntarEn(r, 'leche')
    const heredada = (addItem.mock.calls[0][3] as { id: string }).id

    // Ahora entra de verdad: la clave queda resuelta y no debe heredarse nunca más.
    addItem.mockResolvedValue({ data: fila('leche'), clase: null, code: null })
    await apuntarEn(r, 'leche')
    await apuntarEn(r, 'leche')

    const ultima = (addItem.mock.calls.at(-1)![3] as { id: string }).id
    expect(ultima, 'heredó una clave que el servidor ya aceptó: el alta siguiente choca sin motivo')
      .not.toBe(heredada)
  })

  it('i2-4: y la clave se olvida cuando el producto acabó encolado', async () => {
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('entro')
    const r = montar()
    await apuntar(r, 'leche')
    await apuntar(r, 'leche')
    expect(new Set(claves()).size,
      'la clave sobrevivió a su intención: el producto ya estaba encolado bajo ella').toBe(2)
  })

  /**
   * Iteración 2 · i2-3 — **La regresión que introduje, y que nadie había declarado.**
   *
   * El intento anterior llegó al servidor —`servidor` incluye un timeout después de confirmar— y
   * alguien tachó el producto. El reintento hereda la clave y choca contra `items_origen_unico`,
   * que NO es parcial. Sin arreglo, el usuario lee «ya está en la lista» sobre algo que no está,
   * sin ficha que enfocar y sin salida salvo renombrar. Antes de la Spec F ese re-apunte
   * funcionaba, porque el índice de nombre sí es parcial.
   */
  it('i2-3: con la clave heredada chocando, el producto entra con clave nueva', async () => {
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('rechazado')
    const r = montar()
    await apuntarEn(r, 'leche')

    // Segundo gesto: la clave heredada choca, y la nueva entra.
    addItem.mockReset()
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    addItem.mockResolvedValueOnce({ data: fila('leche'), clase: null, code: null })
    // Spec G2 — **La siembra que faltaba, declarada en la spec como cambio de forma sin cambio de
    // propiedad.** Con el reintento condicionado a la lectura, este caso sólo es el que dice ser si
    // el producto NO está vivo. Antes lo conseguía por el valor por defecto del `beforeEach`: verde
    // por un motivo que no declaraba. Ahora lo dice.
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    await apuntarEn(r, 'leche')

    expect(addItem.mock.calls.length, 'no reintentó con clave nueva: el alta queda en callejón').toBe(2)
    const [k1, k2] = addItem.mock.calls.map(c => (c[3] as { id: string }).id)
    expect(k2, 'el reintento repitió la clave que acababa de chocar').not.toBe(k1)
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'dice «ya está en la lista» sobre algo que el usuario no puede ver').not.toMatch(/ya está en la lista/i)
  })
})

/**
 * Spec F / F4 — **La valla que no vigilaba.** La lista citaba `unit/notice-render.test.tsx`
 * › «una mucacion que va bien no deja aviso» como la mitad de vista de F4, y ese caso sólo
 * afirma que **no aparece un aviso**: una vista que no llamara a `addItem` en absoluto lo pone
 * verde igual. Era un rótulo más débil que el anterior, no un arreglo. Esto es lo que F4 dice
 * en su columna de capa: que el alta directa **manda la fila** y que el producto aparece.
 *
 * Es arreglo de una prueba que mentía, no de producto.
 */
describe('Spec F / F4 · el alta directa manda la fila, y se ve', () => {
  it('F4 (vista): el envío lleva la fila con su clave y el producto se pinta', async () => {
    addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
    const r = montar()
    await apuntarEn(r, 'lentejas')

    expect(addItem, 'la vista no llamó al envío: el caso no vigilaba nada').toHaveBeenCalledTimes(1)
    const enviada = addItem.mock.calls[0][3] as { id: string; nombre: string }
    expect(enviada.nombre, 'mandó otro nombre que el teclado').toBe('lentejas')
    expect(enviada.id, 'mandó la fila sin clave: la base no puede reconocer un reenvío')
      .toMatch(/^[0-9a-f-]{36}$/)
    // **Lo que este caso NO cubre, dicho aquí:** que el producto se pinte. Este arnés no renderiza
    // filas vivas —la lista queda en «La lista está vacía.» aunque `setItems` reciba la fila—, así
    // que afirmarlo aquí sería una aserción que no mide lo que dice. La mitad de pintado la cubre
    // el navegador. Lo que esta fila sí vigila, y era lo que faltaba, es que **se llame al envío
    // con la fila y su clave**: una vista que no llamara a `addItem` la pone roja.
  })
})

/**
 * Spec F / iteración 2 · i2-7 — **Que la solución nueva no reabra lo que la F vino a cerrar.**
 *
 * La clave del intento es un uuid y **no lleva el nombre**; lo que lleva el nombre es el índice
 * del mapa de claves devueltas. La pregunta es si dos altas del MISMO producto dentro de la
 * ventana pueden acabar en dos filas: las dos heredan la misma clave, la segunda choca, y el
 * reintento de i2-R3 acuña una nueva — momento en el que la única red que queda es el índice de
 * **nombre**, el que la Spec F declaró insuficiente por ser parcial.
 *
 * **Se afirma el resultado, no la secuencia de claves.** La primera versión de este caso
 * comparaba la primera, la segunda y la tercera clave entre gestos, y resultó no ser
 * interpretable: acoplaba la prueba a mi orden interno de llamadas, así que un fallo no distinguía
 * «se reabrió el defecto» de «el reintento salió de otro sitio». Una prueba que no sabe qué
 * significa su rojo no es una prueba.
 */
describe('Spec F / iteración 2 · dos altas del mismo producto en la ventana', () => {
  it('i2-7: con clave heredada y el producto tachado, acaba una sola fila', async () => {
    // Un fallo previo deja clave devuelta para «arroz».
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('rechazado')
    const r = montar()
    await apuntarEn(r, 'arroz')

    // La base responde como responde de verdad: la clave heredada choca —el producto está
    // tachado—, la clave nueva entra, y cualquier envío posterior del mismo nombre choca contra
    // esa fila viva. Es el índice de nombre haciendo de red, que es lo que hay que comprobar.
    // La revisión midió que la versión anterior de este doble **capaba `vivas` a 1 por
    // construcción** —`if (vivas > 0) return 23505` bloqueaba todo inserto posterior—, así que la
    // aserción `toBe(1)` no podía observar el fallo que su mensaje nombra. Ahora el doble imita el
    // índice de nombre de verdad: rechaza por NOMBRE cuando ya hay una fila viva con ese nombre, y
    // rechaza por CLAVE cuando la clave ya se usó. Con eso, dos filas del mismo producto son
    // alcanzables si el mecanismo falla, y la aserción puede ponerse roja por su motivo.
    let vivas = 0
    const nombresVivos = new Set<string>()
    const clavesUsadas = new Set<string>()
    addItem.mockImplementation(async (...a: unknown[]) => {
      const f = a[3] as { id: string; nombre: string }
      if (clavesUsadas.has(f.id)) return { data: null, clase: 'duplicado', code: '23505' }
      if (nombresVivos.has(f.nombre)) return { data: null, clase: 'duplicado', code: '23505' }
      clavesUsadas.add(f.id); nombresVivos.add(f.nombre); vivas++
      return { data: fila(f.nombre), clase: null, code: null }
    })
    const heredada = (addItem.mock.calls[0][3] as { id: string }).id
    const antes = addItem.mock.calls.length

    await apuntarEn(r, 'arroz')
    await apuntarEn(r, 'arroz')

    // El escenario, fijado: el primer envío de estos dos gestos tiene que HEREDAR la clave del
    // fallo. Sin esto el caso podría medir dos altas cualesquiera y pasar por el motivo
    // equivocado, que es lo que la revisión encontró en su primera versión.
    expect((addItem.mock.calls[antes][3] as { id: string }).id,
      'el gesto no heredó la clave: este caso no es el que dice ser').toBe(heredada)
    expect(vivas, 'la base aceptó más de una fila del mismo producto: la Spec F se reabre').toBe(1)
    // La afirmación es sobre lo que **la base aceptó**, que es donde vive el invariante de la
    // Spec F. El pintado no se afirma aquí: este arnés no renderiza filas vivas, y una aserción
    // que no mide lo que dice es peor que ninguna.
  })
})

/**
 * Spec G2 — **`devolver` hace dos trabajos con calendarios distintos.**
 *
 * Devolver el texto al campo toca en **todo** fallo; recordar la clave sólo tiene sentido cuando
 * el resultado es **desconocido**, porque sólo entonces el servidor puede tener la fila bajo ella.
 * Fundidos, la clave se recuerda también tras `42501` y `23505`, donde el servidor **probó** que no
 * la tiene — y el reintento dispara sobre una clave rechazada.
 *
 * Las seis filas de abajo son g1…g6. El corte que prueban es **por quién decide**: recordar se
 * deriva de la clase del resultado en un solo sitio, no se elige en la rama.
 */
describe('Spec G2 · recordar la clave se deriva del resultado, no de la rama', () => {
  const claves = () => addItem.mock.calls.map(c => (c[3] as { id: string }).id)
  /** Un gesto cuyo resultado es DESCONOCIDO: el servidor no contestó y el disco no aceptó. */
  const desconocido = () => {
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('rechazado')
  }

  it('g1: tras un 42501, el gesto siguiente NO hereda clave', async () => {
    addItem.mockResolvedValue({ data: null, clase: 'sin-acceso', code: '42501' })
    const r = montar()
    await apuntarEn(r, 'leche')
    await apuntarEn(r, 'leche')
    expect(claves().length, 'no hubo dos envíos: el caso no mide nada').toBe(2)
    expect(claves()[1], 'heredó una clave que el servidor RECHAZÓ: no puede tener la fila bajo ella')
      .not.toBe(claves()[0])
  })

  it('g2: tras un resultado desconocido, sí la hereda', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')
    await apuntarEn(r, 'leche')
    // i1-4 — La cuenta que le faltaba: sin ella, un gesto heredado que **no manda nada** satisface
    // `size === 1` y la fila pasa. Medido por la revisión con ese mutante exacto.
    expect(claves().length, 'no hubo dos envíos: el caso no mide nada').toBe(2)
    expect(new Set(claves()).size, 'dejó de heredar donde el servidor sí puede tener la fila').toBe(1)
  })

  it('g3: con el producto VIVO, el 23505 heredado no reintenta: relee y lo dice', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')

    addItem.mockReset(); activeItems.mockClear()
    addItem.mockResolvedValue({ data: null, clase: 'duplicado', code: '23505' })
    activeItems.mockResolvedValue({ data: [fila('leche')], clase: null, code: null })
    await apuntarEn(r, 'leche')

    expect(addItem.mock.calls.length, 'reintentó sobre un producto que SÍ está en la lista').toBe(1)
    expect(activeItems, 'no releyó: entonces adivinó en vez de preguntar').toHaveBeenCalled()
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'no dijo lo que de verdad pasa: el producto está en la lista').toMatch(/ya está en la lista/i)
    /**
     * Iteración 3 · i3-R3 — **el foco se afirma, y la declaración de no-cobertura de la iteración 2
     * era falsa.** Aquella decía que este arnés «no renderiza filas vivas» y que por eso el efecto
     * del foco no tenía nodo al que ir. Lo comprobé mal: la relectura entra por `setItems`, la fila
     * se pinta, y `document.activeElement` cae en su campo de cantidad.
     *
     * Vale la pena dejar dicho por qué esto es peor que no haber afirmado nada: **una declaración de
     * no-cobertura falsa cierra la pregunta.** Un hueco sin declarar lo encuentra el siguiente que
     * mire; un hueco declarado con motivo medido —y el motivo era medido, sólo que de una medición
     * equivocada— no lo vuelve a mirar nadie.
     *
     * Rojo sin el mecanismo: anulando `pendienteFoco.current = ya.id` (`GroupView.tsx`), el foco se
     * queda en el campo del nombre y esta aserción falla.
     */
    expect(document.activeElement?.getAttribute('data-cantidad-de'),
      'no enfocó la cantidad de la fila viva: g3 promete «avisa Y enfoca»').toBe('id-leche')
  })

  it('g4: con el producto TACHADO, sí reintenta con clave nueva y entra', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')
    const heredada = claves()[0]

    addItem.mockReset()
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    addItem.mockResolvedValueOnce({ data: fila('leche'), clase: null, code: null })
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    await apuntarEn(r, 'leche')

    expect(addItem.mock.calls.length, 'no reintentó: el alta queda en callejón').toBe(2)
    const [k1, k2] = addItem.mock.calls.map(c => (c[3] as { id: string }).id)
    expect(k1, 'el primer envío del gesto no heredó').toBe(heredada)
    expect(k2, 'el reintento repitió la clave que acababa de chocar').not.toBe(heredada)
  })

  /**
   * i1-R5 — **Rotulada por lo que mide.** La fila de la DoD decía «tres claves, no cuatro», y
   * medido son tres antes y tres después: ese número no puede estar rojo antes. Lo que este caso
   * afirma —y sí cambia— es la **identidad** de la clave que el tercer gesto hereda: la original,
   * no la del reintento.
   */
  it('g5: el reintento no se re-arma — el tercer gesto hereda la original, no la del reintento', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')
    const heredada = claves()[0]

    // El reintento entra y falla con un rechazo del servidor: NO puede quedar su clave recordada.
    addItem.mockReset()
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    addItem.mockResolvedValueOnce({ data: null, clase: 'sin-acceso', code: '42501' })
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    await apuntarEn(r, 'leche')

    // Tercer gesto: tiene que heredar la ORIGINAL, la única cuyo resultado sigue desconocido.
    addItem.mockReset()
    addItem.mockResolvedValue({ data: null, clase: 'duplicado', code: '23505' })
    await apuntarEn(r, 'leche')
    expect((addItem.mock.calls[0][3] as { id: string }).id,
      'heredó la clave del reintento: el reintento se re-armó y acuña una clave por gesto')
      .toBe(heredada)
  })

  /**
   * Iteración 1 de G2 · i1-1 y i1-2 — **La puerta que la propia spec escribió y el código
   * contradecía.** §A.3: «si la relectura falla, no se reintenta… No se acuña clave nueva sin
   * saber». Con `relectura.clase` puesto, `ya` se queda `undefined` y el reintento disparaba: el
   * mecanismo construido para dejar de adivinar, adivinando en el único caso en que no puede saber.
   */
  it('i1-1: con la relectura caída, no reintenta ni acuña', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')

    addItem.mockReset()
    addItem.mockResolvedValue({ data: null, clase: 'duplicado', code: '23505' })
    activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
    await apuntarEn(r, 'leche')

    expect(addItem.mock.calls.length,
      'acuñó clave nueva sin saber si el producto está vivo: fallar abierto').toBe(1)
  })

  /**
   * Iteración 3 · i3-R8 — **rotulada por lo que mide.** El nombre decía «y el producto vivo», y este
   * montaje no puede representarlo: `activeItems` devuelve `clase: 'servidor'`, o sea que la lectura
   * **falló**, y con la lectura caída no hay forma de saber si el producto está vivo. Ése era el
   * mismo defecto de rótulo que esta vuelta corrigió en g3, en una fila que escribió esta vuelta.
   *
   * No se funde con i1-1 aunque el montaje sea el mismo: i1-1 afirma que **no se reintenta ni se
   * acuña**, ésta afirma **qué se le dice al usuario**. Dos propiedades del mismo escenario, y cada
   * una se puede romper sin la otra.
   */
  it('i1-2: con la relectura caída, el aviso es el del duplicado y no se escribe a ciegas', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')

    addItem.mockReset()
    addItem.mockResolvedValue({ data: null, clase: 'duplicado', code: '23505' })
    activeItems.mockResolvedValue({ data: [], clase: 'servidor', code: null })
    await apuntarEn(r, 'leche')

    expect(r.queryByTestId('notice')?.textContent ?? '',
      'no dijo nada sobre un 23505 que no pudo explicar').toMatch(/ya está en la lista/i)
  })

  /**
   * i1-3 — `'desconocido'` deja de conflarse: con `'ya-estaba'` el almacén **sí** contestó, así que
   * el servidor no puede tener la fila bajo esa clave y no hay nada que recordar.
   */
  it('i1-3: un `ya-estaba` del almacén no deja clave recordada', async () => {
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    encolar.mockResolvedValue('ya-estaba')
    const r = montar()
    await apuntarEn(r, 'leche')
    const primera = claves()[0]
    await apuntarEn(r, 'leche')
    expect(claves()[1], 'heredó una clave que el almacén rechazó por duplicado').not.toBe(primera)
  })

  it('g6: el resultado desconocido del reintento encola y anuncia EN_COLA', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')

    addItem.mockReset(); encolar.mockClear()
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    encolar.mockResolvedValue('entro')
    await apuntarEn(r, 'leche')

    expect(encolar, 'el reintento perdió el producto: no lo encoló').toHaveBeenCalled()
    expect(r.queryByTestId('notice')?.textContent ?? '',
      'no anunció dónde quedó el producto').toMatch(/se envía solo/i)
  })

  /**
   * Iteración 3 de G2 · i3-R1 — **la caché que desmiente a la relectura.** g6 no caza esto porque
   * su caché está vacía: `visibles` e `items` valen lo mismo y la sustitución no se nota. El defecto
   * necesita que la caché **tenga** el producto en el momento de encolar y que la relectura acabe de
   * decir que no está.
   *
   * La carga diferida es lo que representa eso, y no es un artificio: en el navegador la caché
   * aprende la fila por el canal *después* del gesto —el intento anterior sí aterrizó—, y cuando
   * alguien la tacha con el canal cortado, la caché se la queda. `mergeItems` (`lib/items.ts`)
   * **nunca quita** una fila ausente de la lectura fresca, así que la relectura vacía no la limpia.
   * Aquí la fila entra por la carga del montaje resuelta tarde, que deja el mismo estado con lo que
   * este arnés sí puede controlar.
   */
  const conCacheRancia = async () => {
    const r = montar()
    await apuntarEn(r, 'leche')

    /**
     * La caché se ensucia como se ensucia de verdad: **con una lectura legítima.** Un gesto sobre
     * otro producto no encuentra su nombre en la caché, relee, y `mergeItems` mete en ella todo lo
     * que la lectura trajo — incluido `leche`. Después alguien tacha `leche` y nadie limpia la
     * caché, porque `mergeItems` **nunca quita** una fila ausente de la lectura fresca.
     *
     * Dos intentos anteriores de montar esto fallaron por el montaje y no por el producto, y vale
     * decir cuáles: sembrar la caché desde el montaje hace que el primer gesto salga «duplicado» y
     * no deje clave —`decidirEncolar` corre antes de `'sin-almacen'`—; y diferir la carga del
     * montaje impide que el primer gesto ocurra siquiera. Esta vía no toca el primer gesto.
     */
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    activeItems.mockResolvedValueOnce({ data: [fila('leche')], clase: null, code: null })
    await apuntarEn(r, 'pan')
    return r
  }

  it('i3-1: con la caché conservando el producto tachado, el reintento desconocido SÍ encola', async () => {
    desconocido()
    const r = await conCacheRancia()

    addItem.mockReset(); encolar.mockClear()
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    encolar.mockResolvedValue('entro')
    await apuntarEn(r, 'leche')

    expect(encolar,
      'perdió el producto: encoló contra la caché que la relectura acababa de desmentir')
      .toHaveBeenCalled()
  })

  it('i3-2: y no dice «ya está en la lista» sobre algo que la relectura no encontró', async () => {
    desconocido()
    const r = await conCacheRancia()

    addItem.mockReset(); encolar.mockClear()
    addItem.mockResolvedValueOnce({ data: null, clase: 'duplicado', code: '23505' })
    addItem.mockResolvedValueOnce({ data: null, clase: 'servidor', code: null })
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    encolar.mockResolvedValue('entro')
    await apuntarEn(r, 'leche')

    expect(r.queryByTestId('notice')?.textContent ?? '',
      'dijo «ya está en la lista» contradiciendo a su propia relectura')
      .not.toMatch(/ya está en la lista/i)
  })

  /**
   * Iteración 3 de G2 · i3-R2 — **«no pude leer» no cierra un resultado desconocido.** i1-1 cubre
   * la otra mitad de esta rama —que no se reintenta— y se conserva. Ésta mira lo que i1-1 no mira:
   * qué pasa con la clave heredada. Antes caía en «duplicado de verdad» y se olvidaba, con lo que
   * el gesto siguiente acuñaba una nueva y el intento original quedaba sin forma de reintentarse.
   */
  it('i3-3: con la relectura caída y clave heredada, el gesto siguiente HEREDA la clave', async () => {
    desconocido()
    const r = montar()
    await apuntarEn(r, 'leche')
    const primera = addItem.mock.calls.map(c => (c[3] as { id: string }).id)[0]

    addItem.mockReset()
    addItem.mockResolvedValue({ data: null, clase: 'duplicado', code: '23505' })
    activeItems.mockResolvedValue({ data: [], clase: RELECTURA, code: null })
    await apuntarEn(r, 'leche')

    addItem.mockClear()
    activeItems.mockResolvedValue({ data: [], clase: null, code: null })
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    await apuntarEn(r, 'leche')

    expect(addItem.mock.calls.map(c => (c[3] as { id: string }).id)[0],
      'olvidó la clave sin haber podido mirar: el intento original ya no se puede reintentar')
      .toBe(primera)
  })
})
