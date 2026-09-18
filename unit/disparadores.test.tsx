// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import type { Item } from '@/lib/items'
import type { Pendiente } from '@/lib/local'
import { caducados, EN_COLA, LISTA_EN_VIVO, SERVIDOR } from '@/lib/errors'
import { VIDA_COLA_MS } from '@/lib/local'
import type { ChannelState } from '@/lib/channelState'

/**
 * Spec B — Los disparadores del drenado, la afirmación «Lista en vivo» y el texto
 * de lo encolado. Atacados **en la vista**, que es la capa que los tres requisitos
 * nombran: los disparadores son efectos del componente y la afirmación es su
 * render (§E.1).
 *
 * **Fichero propio, y no un añadido a `unit/drenado.test.tsx`, por dos razones.**
 * La primera es la valla: la spec nombra «DoD 7: lo encolado se envía sin que la red cambie nunca» como la fila que
 * esta obra puede romper sin querer, y tocar la cabecera de aquel fichero movería
 * esa línea. La segunda es que el arnés **cambia de forma** — aquí el canal es un
 * estado que el test mueve, y allí es la constante `'live'` —, y un arnés que
 * cambia de forma suele estar diciendo que el fallo es de otra familia. Lo es: la
 * de allí es «volvió la red», la de aquí es «volvió el servicio».
 */
const addItem = vi.fn()
const activeItems = vi.fn()
const leerCola = vi.fn()
const quitarDeCola = vi.fn()
const encolar = vi.fn()
const guardarLista = vi.fn()
const updateItem = vi.fn()
const softDeleteItem = vi.fn()

let sinRedAhora = false
const oyentesRed = new Set<() => void>()

/** El canal, mandable desde el test: sin transición no hay disparador que probar. */
let canalAhora: ChannelState = 'live'
const oyentesCanal = new Set<() => void>()
const ponerCanal = async (v: ChannelState) => {
  canalAhora = v
  await act(async () => { for (const f of [...oyentesCanal]) f() })
}

vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
vi.mock('@/app/actions', () => ({
  createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/lib/useGroupChannel', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useGroupChannel: () => useSyncExternalStore(
      (f: () => void) => { oyentesCanal.add(f); return () => { oyentesCanal.delete(f) } },
      () => canalAhora, () => canalAhora),
  }
})
vi.mock('@/lib/useSinRed', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useSinRed: () => useSyncExternalStore(
      (f: () => void) => { oyentesRed.add(f); return () => { oyentesRed.delete(f) } },
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
 * El canal de la cola. **El doble emite donde emite el de verdad**: `encolar` y
 * `quitarDeCola` avisan (`encolar` y `quitarDeCola`). Sin esa fidelidad no se
 * puede mirar el borde B1 —que el drenado se redispara a sí mismo al vaciar la
 * cola— porque el bucle que hay que ver terminar no llegaría a existir.
 */
let oyentesDeLaCola: (() => void)[] = []
const avisarDeLaCola = () => { for (const f of [...oyentesDeLaCola]) f() }

vi.mock('@/lib/local', async (orig) => ({
  ...(await orig<typeof import('@/lib/local')>()),
  leerCola: (...a: unknown[]) => leerCola(...a),
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
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', deleted_at: null,
})
const pendiente = (nombre: string, grupo = 'g1', edad = 1000): Pendiente =>
  ({ id: `p-${nombre}`, usuario: 'u1', grupo, nombre, cantidad: null, creado: Date.now() - edad })
/** Una entrada que la regla de las 24 h manda descartar. */
const caducada = (nombre: string) => pendiente(nombre, 'g1', VIDA_COLA_MS + 60_000)

const montar = (iniciales: Item[] = []) => render(
  <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={iniciales}
    members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
    profiles={[{ id: 'u1', display_name: 'Yo' }]}
    me={{ id: 'u1', role: 'owner' }} loadClase={null} />,
)

/** Una cola que recuerda, y que **avisa al escribir**, como la de verdad. */
let cola: Pendiente[] = []
const colaViva = () => {
  leerCola.mockImplementation(async () => cola)
  quitarDeCola.mockImplementation(async (id: string) => {
    // Devuelve `boolean`, como el de verdad: desde i5-R1 la vista distingue el
    // borrado que entró del que el almacén rechazó, y un doble que devuelve
    // `undefined` le dice «rechazado» sin querer.
    cola = cola.filter(x => x.id !== id); avisarDeLaCola(); return true
  })
  encolar.mockImplementation(async (p: Pendiente) => { cola = [...cola, p]; avisarDeLaCola(); return 'entro' })
}

/**
 * Deja pasar los efectos del montaje sin adelantar ningún reloj. Varias vueltas: la
 * lectura de la cola encadena `leerCola` → `quitarDeCola` → `setPendientes`, y con
 * una sola el caso medía el estado a medio asentar.
 */
const asentar = async () => {
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  vi.clearAllMocks()
  oyentesDeLaCola = []
  sinRedAhora = false
  canalAhora = 'live'
  cola = []
  encolar.mockResolvedValue('entro')
  guardarLista.mockResolvedValue(undefined)
  leerCola.mockResolvedValue([])
  quitarDeCola.mockResolvedValue(true)
  addItem.mockResolvedValue({ data: fila('x'), clase: null, code: null })
  activeItems.mockResolvedValue({ data: [], clase: null, code: null })
  updateItem.mockResolvedValue({ data: fila('x'), clase: null, code: null })
  softDeleteItem.mockResolvedValue({ data: 1, clase: null, code: null })
})
afterEach(() => cleanup())

/* ─────────────────────────── R1 · los disparadores ─────────────────────────── */

describe('R1 · el drenado se dispara cuando la cola cambia', () => {
  /**
   * DoD 1 — Reproduce lo medido: la cola llena, el bucle de reintento muerto (aquí
   * ni siquiera llegó a armarse: lo arma un alta fallida, y el drenado del montaje
   * no), y treinta segundos de reloj en los que **nadie** lo intenta.
   */
  it('DoD 1: con la cola llena y nadie reintentando, un cambio de la cola manda lo pendiente', async () => {
    vi.useFakeTimers()
    try {
      cola = [pendiente('lentejas')]
      colaViva()
      addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
      montar()
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      const antes = addItem.mock.calls.length
      // Sonda de vivacidad: si el montaje no intentó nada, el caso no mide lo que cree.
      expect(antes, 'el drenado del montaje no llegó a intentarlo').toBeGreaterThan(0)

      addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(addItem.mock.calls.length,
        'con el servicio ya bueno pero sin señal, alguien drenó por su cuenta').toBe(antes)

      await act(async () => { avisarDeLaCola(); await vi.advanceTimersByTimeAsync(0) })
      expect(addItem.mock.calls.length,
        'la cola cambió y nadie la drenó: es lo medido el 2026-09-18').toBeGreaterThan(antes)
    } finally { vi.useRealTimers() }
  })

  /**
   * B1 / DoD 5 — El drenado vacía la cola, y vaciarla **avisa**, y ese aviso vuelve
   * a disparar el drenado. La cadena tiene que morir sola: la vuelta siguiente
   * encuentra la cola vacía y no manda nada.
   */
  it('DoD 5: el aviso que produce el propio drenado no lo deja girando', async () => {
    colaViva()
    montar()
    await asentar()
    cola = [pendiente('lentejas')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()
    expect(addItem.mock.calls.length, 'la entrada se mandó más de una vez').toBe(1)
    expect(cola, 'la cola no se vació').toEqual([])
    // Si la cadena no muriera, `leerCola` seguiría creciendo sin fin.
    expect(leerCola.mock.calls.length, 'la cadena no terminó').toBeLessThan(12)
  })
})

describe('R1 · el drenado se dispara cuando el canal vuelve a estar vivo', () => {
  /**
   * DoD 2 y DoD 3 en un caso, porque la sonda es la mitad que importa: colgar el
   * disparador del **nivel** `channelState === 'live'` en vez de de la
   * **transición** lo dispararía en cada render, y colgarlo del cambio a secas lo
   * dispararía también al degradarse, que es justo cuando no hay servicio al que
   * mandar nada.
   */
  it('DoD 2 y 3: dispara al volver el canal, y NO al caerse', async () => {
    cola = [pendiente('lentejas')]
    colaViva()
    // El drenado del montaje falla, así que la cola sigue llena y el canal arranca
    // vivo: eso hace que la caída de abajo sea una transición de verdad y no un
    // cambio que React no llega a renderizar.
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    montar()
    await asentar()
    const antes = addItem.mock.calls.length
    expect(antes, 'el drenado del montaje no llegó a intentarlo').toBeGreaterThan(0)

    // (sonda) El canal se cae: no hay servicio, no hay nada que mandar.
    addItem.mockResolvedValue({ data: fila('lentejas'), clase: null, code: null })
    await ponerCanal('degraded')
    await asentar()
    expect(addItem.mock.calls.length,
      'se drenó al degradarse el canal: el disparador cuelga del cambio, no de la vuelta').toBe(antes)

    // El canal vuelve: eso es el servicio contestando, y es evidencia, no un reloj.
    await ponerCanal('live')
    await asentar()
    expect(addItem.mock.calls.length,
      'el canal volvió a estar vivo y la cola siguió en disco').toBeGreaterThan(antes)
  })

  /**
   * B3 / DoD 4 — Los dos disparadores a la vez sobre una sola entrada. El cerrojo
   * de `drenar` ya existe; lo que esto comprueba es que añadir un segundo
   * disparador no convierte una entrada en dos envíos.
   */
  it('DoD 4: dos disparadores seguidos sobre una entrada mandan un solo alta', async () => {
    colaViva()
    canalAhora = 'degraded'
    montar()
    await asentar()
    cola = [pendiente('lentejas')]
    await act(async () => {
      avisarDeLaCola()
      canalAhora = 'live'
      for (const f of [...oyentesCanal]) f()
      await Promise.resolve()
    })
    await asentar()
    expect(addItem.mock.calls.length, 'dos disparadores mandaron la misma entrada dos veces').toBe(1)
  })
})

/* ──────────────────── R2 · la afirmación «Lista en vivo» ──────────────────── */

describe('R2 · la app no dice «Lista en vivo» con pendientes sin enviar', () => {
  it('DoD 8: con un pendiente de este grupo y el canal vivo, no se afirma', async () => {
    cola = [pendiente('lentejas')]
    leerCola.mockImplementation(async () => cola)
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    expect(r.queryByTestId('channel-live'),
      'la pantalla afirma estar al día con productos parados en disco (§A.3)').toBeNull()
  })

  // Sonda (§E.2): sin pendientes la afirmación sigue saliendo, y con su texto. Si
  // esto se pusiera rojo, el caso de arriba estaría pasando por apagarlo todo.
  it('DoD 9: con la cola vacía y el canal vivo, sí se afirma y dice lo de siempre', async () => {
    const r = montar()
    await asentar()
    expect(r.getByTestId('channel-live').textContent).toBe(LISTA_EN_VIVO)
  })

  it('DoD 10: un pendiente de OTRO grupo no calla el anuncio', async () => {
    cola = [pendiente('lentejas', 'g2')]
    leerCola.mockImplementation(async () => cola)
    const r = montar()
    await asentar()
    expect(r.queryByTestId('channel-live'),
      'la cola de otro grupo apagó el anuncio de éste (§D.3)').not.toBeNull()
  })
})

/* ────────────────────────── R3 · el texto de la cola ────────────────────────── */

describe('R3 · lo encolado y lo perdido no dicen lo mismo', () => {
  /**
   * DoD 13 — Los dos hechos en el mismo caso, porque lo que hay que ver es que se
   * **separan**: con el mismo servicio caído, el alta queda guardada y la edición
   * no, y hasta hoy las dos pintaban `SERVIDOR`.
   */
  it('DoD 13: el alta encolada dice que está guardada; la edición fallida, no', async () => {
    colaViva()
    const r = montar([fila('pan')])
    await asentar()

    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.getByTestId('notice').textContent,
      'el alta encolada sigue prometiendo un reintento que no existe').toBe(EN_COLA)

    updateItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const campo = r.getByLabelText('Cantidad de pan')
    fireEvent.change(campo, { target: { value: '3' } })
    await act(async () => { fireEvent.blur(campo) })
    expect(r.getByTestId('notice').textContent,
      'la edición fallida dice «guardado» de algo que no se guardó en ninguna parte').toBe(SERVIDOR)
  })
})

/* ───────────── Iteración 1 · lo caducado, el desmontaje y el registro ───────────── */

/**
 * i1-R1 — **El camino que la base abrió.** Antes del diff, una entrada caducada
 * escrita por otra pestaña sólo se releía y se quedaba en disco hasta el próximo
 * montaje. Con el disparador nuevo se **envía**, y eso publica a todo el grupo un
 * producto que la app promete descartar.
 *
 * El caso no monta con la cola llena a propósito: así no compite con el efecto de
 * apertura, que descarta, y lo que se mide es el envío y no quién gana una carrera.
 */
describe('i1-R1 · el drenado no publica lo que la regla manda descartar', () => {
  it('i1-4: otra pestaña encola algo caducado y avisa: no sale', async () => {
    colaViva()
    montar()
    await asentar()
    cola = [caducada('viejo')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()
    expect(addItem.mock.calls.map(c => c[3]),
      'se publicó al grupo un producto de más de 24 h').not.toContain('viejo')
  })

  // Sonda (§E.2): por el mismo camino, lo que NO está caducado sí sale. Sin esto,
  // un filtro que rechazara todo dejaría verde el caso de arriba y roto R1 entero.
  it('i1-2: y por el mismo camino, lo reciente sí sale', async () => {
    colaViva()
    montar()
    await asentar()
    cola = [pendiente('fresco')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()
    expect(addItem.mock.calls.map(c => c[3]),
      'el filtro de caducidad se llevó por delante lo que sí había que enviar').toContain('fresco')
  })

  /**
   * i1-R2 — La otra mitad. Rechazar el envío y dejarla contada como pendiente
   * apagaría «Lista en vivo» hasta el próximo montaje: la afirmación pasaría de
   * mentir por exceso a callar por defecto.
   */
  it('i1-5: lo caducado no cuenta como pendiente, y no calla el anuncio', async () => {
    /**
     * Por la relectura, no por el montaje: el efecto de apertura **ya** pasa por
     * `reparte` (por `leerColaViva`, como todos), así que montar con la cola llena mediría
     * un filtro que ya existe. El que falta es el de `releerLaCola`, y a ése sólo
     * se llega con la señal.
     */
    colaViva()
    /**
     * Y con el servicio caído: si el envío funcionara, el drenado se llevaría la
     * entrada y la ficha desaparecería **por el defecto que i1-R1 cierra**, no por
     * el filtro que este caso mira. Un verde así es de los que ocupan el sitio.
     */
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    cola = [caducada('viejo')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()
    expect(r.queryAllByTestId('item-pendiente'),
      'se pinta como pendiente algo que ya no se va a enviar').toHaveLength(0)
    expect(r.queryByTestId('channel-live'),
      'una entrada caducada apaga el anuncio hasta el próximo montaje').not.toBeNull()
  })
})

/**
 * i2-R1 — **Dónde corta el desmontaje, y dónde NO.**
 *
 * La iteración 1 metió un tercer chequeo de generación entre `await addItem(...)` y
 * `await quitarDeCola(...)`, razonando que si el reenvío llegaba a repetirse la base
 * lo pararía con `23505`. `items_nombre_unico` es **parcial**: en cuanto alguien
 * tacha el producto, el reenvío crea fila nueva. El chequeo convertía un desmontaje
 * a mitad de envío en una resurrección.
 *
 * Lo que sí tiene que seguir cortando es el **bucle**: un drenado de un árbol
 * muerto no empieza otra vuelta. Los dos casos van juntos porque son las dos
 * mitades de la misma decisión, y separados se pierde cuál paga a cuál.
 */
describe('i2-R1 · el desmontaje corta el bucle, no la vuelta en curso', () => {
  const montarConEnvioEnVuelo = async () => {
    colaViva()
    cola = [pendiente('lentejas'), pendiente('arroz')]
    let acabar!: (r: unknown) => void
    addItem.mockImplementation(() => new Promise(res => { acabar = res }))
    const r = montar()
    await asentar()
    expect(addItem.mock.calls.length, 'el drenado del montaje no llegó a salir').toBe(1)
    return { r, acabar: (v: unknown) => act(async () => { acabar(v) }) }
  }

  it('i2-2: la vuelta en curso se remata: lo enviado sale de la cola', async () => {
    const { r, acabar } = await montarConEnvioEnVuelo()
    r.unmount()
    await acabar({ data: fila('lentejas'), clase: null, code: null })
    await asentar()
    expect(quitarDeCola.mock.calls.map(c => c[0]),
      'el envío entró y la entrada se quedó: al próximo montaje se reenvía, y con el producto tachado eso es una fila nueva')
      .toContain('p-lentejas')
  })

  it('i2-3: pero no empieza otra vuelta: el segundo no se manda', async () => {
    const { r, acabar } = await montarConEnvioEnVuelo()
    r.unmount()
    await acabar({ data: fila('lentejas'), clase: null, code: null })
    await asentar()
    expect(addItem.mock.calls.length,
      'un drenado de un árbol muerto siguió vaciando la cola entera').toBe(1)
  })
})

/**
 * i1-R4 — **El registro, no sólo las palabras.** R3 de la base cambió el texto y
 * dejó el `role="alert"` rojo: a quien usa lector de pantalla se le anuncia de
 * forma asertiva, como un fallo, un mensaje que dice que todo está guardado.
 *
 * La condición es el **origen**, que sólo tiene un escritor. Por `clase` no se
 * puede: `'servidor'` la comparten la carga y la edición fallidas, que sí son
 * errores.
 */
describe('i1-R4 · lo encolado se anuncia como estado, no como alerta', () => {
  it('i1-7: el aviso de la cola es `status`; el de una edición fallida sigue siendo `alert`', async () => {
    colaViva()
    const r = montar([fila('pan')])
    await asentar()

    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.getByTestId('notice').getAttribute('role'),
      'se anuncia como alerta un mensaje que dice que todo está bien').toBe('status')

    updateItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const campo = r.getByLabelText('Cantidad de pan')
    fireEvent.change(campo, { target: { value: '3' } })
    await act(async () => { fireEvent.blur(campo) })
    expect(r.getByTestId('notice').getAttribute('role'),
      'se degradó a estado un fallo que sí perdió lo que el usuario escribió').toBe('alert')
  })
})

/**
 * i2-R2 — **Lo que caduca con la vista montada no se queda en un callejón.**
 *
 * Medido en la revisión: la relectura le quitaba la ficha y el texto «Se enviará al
 * volver la conexión», devolvía «Lista en vivo», **no decía nada**, y dejaba la
 * entrada en disco. Y volver a apuntar ese producto se rechazaba con «Ese producto
 * ya está en la lista» sobre algo que no estaba en ninguna lista ni en ninguna
 * pantalla, porque el duplicado se mira contra la cola **cruda**.
 *
 * La iteración 1 había declarado como límite que el anuncio no se movía. Se escribió
 * antes de medir qué hacía el camino callado: la alternativa al anuncio no era el
 * silencio, era el callejón.
 */
describe('i2-R2 · lo que caduca en caliente se descarta y se dice', () => {
  it('i2-5: la relectura lo descarta, lo anuncia, y sale del disco', async () => {
    colaViva()
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    cola = [caducada('viejo')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()
    expect(r.queryByTestId('notice')?.textContent,
      'el producto desapareció de la pantalla sin que nadie dijera nada').toBe(caducados(1))
    expect(cola, 'se quedó en disco, invisible y sin poder enviarse').toEqual([])
  })

  it('i2-6: y ese producto se puede volver a apuntar', async () => {
    colaViva()
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    cola = [caducada('viejo')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'viejo' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    expect(r.queryAllByTestId('item-pendiente').map(e => e.textContent).join(' '),
      'se rechaza como duplicado contra una entrada que ya no existe para nadie').toContain('viejo')
  })
})

/**
 * i2-R4 — El registro de i1-R4 cubre **las dos mitades** de la historia de la
 * caducidad. El anuncio del descarte es la app informando de su propia política, no
 * un fallo, y se pintaba `alert` rojo — el mismo trato que i1-R4 le quitó a su gemelo.
 */
describe('i2-R4 · el descarte también se anuncia como estado', () => {
  it('i2-8: el aviso de apertura es `status`, no `alert`', async () => {
    colaViva()
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    cola = [caducada('viejo')]
    await act(async () => { avisarDeLaCola(); await Promise.resolve() })
    await asentar()
    expect(r.getByTestId('notice').getAttribute('role'),
      'se le anuncia como fallo a un lector de pantalla lo que es la app cumpliendo su regla')
      .toBe('status')
  })

  /**
   * i2-9 — React parchea el atributo en sitio: el nodo era **el mismo objeto DOM**
   * antes y después del giro, y un `role` que cambia sin remontar no lo recogen de
   * forma fiable las ayudas técnicas. O sea que i1-7 afirmaba el atributo y no el
   * anuncio, que es lo que i1-R4 prometía.
   */
  it('i2-9: al girar de estado a alerta, el nodo del aviso se remonta', async () => {
    colaViva()
    const r = montar([fila('pan')])
    await asentar()

    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'lentejas' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    const primero = r.getByTestId('notice')
    expect(primero.getAttribute('role')).toBe('status')

    updateItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const campo = r.getByLabelText('Cantidad de pan')
    fireEvent.change(campo, { target: { value: '3' } })
    await act(async () => { fireEvent.blur(campo) })
    const segundo = r.getByTestId('notice')
    expect(segundo.getAttribute('role')).toBe('alert')
    expect(segundo === primero,
      'es el mismo nodo con el atributo parcheado: el lector de pantalla no se entera').toBe(false)
  })
})

/**
 * i3-R1 — **El último sitio que leía la cola cruda.**
 *
 * Medido a mano contra el build de producción: con una entrada de 25 h sembrada y la
 * pantalla ya montada, apuntar ese mismo producto daba «Ese producto ya está en la
 * lista» sobre algo que ninguna pantalla enseña — y el rechazo **no escribe en la
 * cola**, así que no dispara ninguna relectura y el intento siguiente da lo mismo.
 * La iteración 2 había dado el callejón por cerrado; sólo lo estrechó.
 *
 * El caso no dispara ninguna señal a propósito: ésa es exactamente la situación de
 * quien está solo con una pestaña.
 */
/**
 * i4-R3 — **El doble emite donde emite el de verdad.** La iteración 3 lo silenció,
 * y con eso la reentrada que la obra creó —`releerLaCola` y `drenar` disparándose
 * DENTRO de `meterEnCola`, sobre la misma cola compartida— no la ejercitaba nadie
 * (§D.2). Con la emisión puesta, el gesto entero pasa por ese camino.
 */
const sembrarCaducada = (nombre: string) => {
  cola = [caducada(nombre)]
  leerCola.mockImplementation(async () => cola)
  quitarDeCola.mockImplementation(async (id: string) => {
    // Devuelve `boolean`, como el de verdad: desde i5-R1 la vista distingue el
    // borrado que entró del que el almacén rechazó, y un doble que devuelve
    // `undefined` le dice «rechazado» sin querer.
    cola = cola.filter(x => x.id !== id); avisarDeLaCola(); return true
  })
  encolar.mockImplementation(async (p: Pendiente) => {
    if (cola.some(x => x.nombre === p.nombre && x.grupo === p.grupo)) return 'ya-estaba'
    cola = [...cola, p]; avisarDeLaCola(); return 'entro'
  })
}

describe('i3-R1 · el duplicado no se decide contra entradas ya condenadas', () => {

  it('i3-1 y i3-2: se encola, y la caducada sale del disco en el mismo gesto', async () => {
    const r = montar()
    await asentar()
    sembrarCaducada('romero')
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'romero' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    await asentar()

    expect(r.getByTestId('notice').textContent,
      'se rechaza un producto legítimo con una frase falsa y sin salida').not.toContain('ya está en la lista')
    expect(cola.map(x => x.id),
      'la caducada sigue en disco: el almacén la volverá a ver y rechazará lo recién aprobado')
      .toEqual([expect.not.stringContaining('p-romero')])
    expect(cola.map(x => x.nombre), 'el producto no entró en la cola').toEqual(['romero'])
  })

  // Sonda (§E.2): la regla del duplicado no se afloja. Un pendiente VIVO del mismo
  // producto se sigue rechazando — es el mecanismo de otra spec y esta obra no lo toca.
  it('i3-3: un duplicado vivo se sigue rechazando', async () => {
    colaViva()
    const r = montar()
    await asentar()
    cola = [pendiente('romero')]
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })

    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'romero' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    await asentar()
    expect(r.getByTestId('notice').textContent,
      'se aflojó la regla del duplicado: entran dos veces el mismo producto').toContain('ya está en la lista')
  })
})

/**
 * i4-R1 — **Quien descarta no le roba la pantalla a quien acaba de apuntar.**
 *
 * La iteración 3 puso a `meterEnCola` a escribir y a hablar, y no pesó sus tres
 * salidas: sin red el `limpiarAviso()` de después borraba el anuncio; con el
 * servicio caído el anuncio —`una-vez`— tapaba `EN_COLA`, que es un `nivel`; y con
 * un duplicado, el aviso del duplicado lo sustituía. Se anuncia sólo donde no
 * compite, y el orden es parte del requisito.
 */
describe('i4-R1 · el descarte no tapa el aviso del gesto', () => {
  const conCaducadaYRedCaida = async (sinRed: boolean) => {
    const r = montar()
    await asentar()
    sembrarCaducada('romero')
    sinRedAhora = sinRed
    await act(async () => { for (const f of [...oyentesRed]) f() })
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'tomillo' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    await asentar()
    return r
  }

  it('i4-1: sin red no hay otro aviso, así que el descarte SÍ se dice', async () => {
    const r = await conCaducadaYRedCaida(true)
    expect(r.queryByTestId('notice')?.textContent ?? 'NINGUNO',
      'el descarte se anunció y `limpiarAviso()` se lo llevó: desaparición en silencio')
      .toBe(caducados(1))
  })

  it('i4-2: con el servicio caído gana `EN_COLA`, que es lo que el gesto preguntó', async () => {
    const r = await conCaducadaYRedCaida(false)
    expect(r.getByTestId('notice').textContent,
      'el descarte tapó el único entregable de R3 en el gesto que lo pedía').toBe(EN_COLA)
  })

  // i4-3 `[REGRESIÓN]`: hoy ya gana por peso. Se fija para que el reparto nuevo no lo mueva.
  it('i4-3: con un duplicado vivo gana el aviso del duplicado', async () => {
    colaViva()
    const r = montar()
    await asentar()
    cola = [pendiente('romero'), caducada('viejo')]
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'romero' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    await asentar()
    expect(r.getByTestId('notice').textContent,
      'el descarte sustituyó a la respuesta del gesto').toContain('ya está en la lista')
  })

  /**
   * i4-4 — El sitio nuevo era el único de los tres que no tocaba `pendientes`, y se
   * fiaba de la señal del canal para curar la pantalla. En el residuo B4 —un
   * navegador sin `BroadcastChannel`, donde `alCambiarLaCola` es un no-op por
   * diseño— nunca cura: queda una ficha prometiendo enviar algo que esta misma
   * pestaña acaba de borrar, y «Lista en vivo» callada para siempre.
   */
  it('i4-4: sin canal, descartar no deja ficha huérfana', async () => {
    // Entra viva —23 h— así que el montaje la pinta; y caduca con la vista abierta.
    cola = [pendiente('viejo', 'g1', 23 * 60 * 60 * 1000)]
    leerCola.mockImplementation(async () => cola)
    // Sin canal: el doble NO emite, como el navegador sin `BroadcastChannel`, donde
    // `alCambiarLaCola` es un no-op por diseño (`lib/local.ts`). Si la ficha se cura,
    // se cura porque alguien la quitó, no porque llegara una señal.
    quitarDeCola.mockImplementation(async (id: string) => { cola = cola.filter(x => x.id !== id); return true })
    encolar.mockImplementation(async (p: Pendiente) => { cola = [...cola, p]; return 'entro' })
    // El servicio caído YA al montar: si no, el drenado del montaje la envía y la
    // ficha desaparece por haber salido, no por el camino que este caso mira. Lo cazó
    // la propia sonda de vivacidad de abajo.
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    expect(r.queryAllByTestId('item-pendiente').map(e => e.textContent ?? '').join(' '),
      'el montaje no llegó a pintar la ficha: el caso no mide lo que cree').toContain('viejo')

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)  // pasa a tener 25 h
    try {
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'tomillo' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      await asentar()
      expect(r.queryAllByTestId('item-pendiente').map(e => e.textContent ?? '').join(' '),
        'queda una ficha prometiendo enviar algo que esta pestaña acaba de borrar').not.toContain('viejo')
    } finally { vi.useRealTimers() }
  })
})

/**
 * i5-R1 — **Sólo se da por descartado lo que el almacén confirmó.**
 *
 * `quitarDeCola` puede devolver `false`: `lib/local.ts` lo documenta —transacción
 * abortada, conexión cerrada entre la lectura y la escritura—. Medido por la
 * revisión: la app quitaba la ficha, anunciaba un descarte que no había ocurrido, y
 * `encolar` seguía viendo la entrada, así que el alta se rechazaba con «ya está en
 * la lista» sin escribir nada y sin señal que curara nada. El callejón, reabierto.
 */
describe('i5-R1 · un descarte que el almacén no aceptó no se canta', () => {
  const conAlmacen = (admite: boolean) => {
    leerCola.mockImplementation(async () => cola)
    quitarDeCola.mockImplementation(async (id: string) => {
      if (!admite) return false
      cola = cola.filter(x => x.id !== id); return true
    })
    encolar.mockImplementation(async (p: Pendiente) => {
      if (cola.some(x => x.nombre === p.nombre && x.grupo === p.grupo)) return 'ya-estaba'
      cola = [...cola, p]; return 'entro'
    })
  }

  it('i5-1: con el almacén rechazando, no hay anuncio y la ficha se queda', async () => {
    cola = [pendiente('viejo', 'g1', 23 * 60 * 60 * 1000)]
    conAlmacen(false)
    addItem.mockResolvedValue({ data: null, clase: 'servidor', code: null })
    const r = montar()
    await asentar()
    expect(r.queryAllByTestId('item-pendiente').map(e => e.textContent ?? '').join(' '),
      'el montaje no pintó la ficha: el caso no mide lo que cree').toContain('viejo')

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
    try {
      fireEvent.change(r.getByTestId('item-name'), { target: { value: 'tomillo' } })
      await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
      await asentar()
      expect(r.queryByTestId('notice')?.textContent ?? '',
        'anuncia un descarte que el almacén no aceptó').not.toContain('Se descartó')
      /**
       * **Lo que este caso NO afirma, y por qué.** La iteración 5 escribió también «y
       * la ficha se queda», y es **falso**: `releerLaCola` y el efecto de apertura
       * pintan `vivos`, que excluye toda caducada se haya podido borrar o no, así que
       * la resta de `leerColaViva` queda pisada. Medido por la revisión en un
       * navegador real: cero fichas, ningún aviso, la entrada en disco, y al apuntar
       * ese producto «Ese producto ya está en la lista» frente a una lista vacía.
       *
       * La aserción que había aquí daba verde **porque este doble no emite**, no
       * porque el producto lo cumpliera. Se retira en vez de dejar una guarda que
       * afirma lo contrario de lo que pasa. El callejón queda en la deuda 63.
       */
    } finally { vi.useRealTimers() }
  })

  // Sonda (§E.2): con el almacén aceptando, sí se descarta y sí se dice. Sin esto,
  // un arreglo que dejara de descartar siempre pasaría el caso de arriba.
  /**
   * Las dos de abajo entran **vivas** y caducan con la vista montada: sembrarlas ya
   * caducadas las descarta el efecto de apertura, y el caso mediría ese camino y no
   * el de `meterEnCola`. Lo cazó la sonda de vivacidad al escribirlas.
   */
  const caducarConLaVistaAbierta = async (r: ReturnType<typeof montar>) => {
    expect(r.queryAllByTestId('item-pendiente').length,
      'el montaje no pintó nada: el caso no mide lo que cree').toBeGreaterThan(0)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000)
    fireEvent.change(r.getByTestId('item-name'), { target: { value: 'tomillo' } })
    await act(async () => { fireEvent.click(r.getByTestId('add-item')) })
    await asentar()
  }

  it('i5-2: con el almacén aceptando, sí se anuncia y sí se despinta', async () => {
    cola = [pendiente('viejo', 'g1', 23 * 60 * 60 * 1000)]
    conAlmacen(true)
    sinRedAhora = true
    const r = montar()
    await act(async () => { for (const f of [...oyentesRed]) f() })
    await asentar()
    try {
      await caducarConLaVistaAbierta(r)
      expect(r.queryByTestId('notice')?.textContent ?? '').toContain('Se descartó')
      expect(r.queryAllByTestId('item-pendiente').map(e => e.textContent ?? '').join(' ')).not.toContain('viejo')
    } finally { vi.useRealTimers() }
  })

  it('i5-3: con dos caducadas y el almacén borrando una, la cuenta es 1', async () => {
    cola = [pendiente('uno', 'g1', 23 * 60 * 60 * 1000), pendiente('dos', 'g1', 23 * 60 * 60 * 1000)]
    leerCola.mockImplementation(async () => cola)
    quitarDeCola.mockImplementation(async (id: string) => {
      if (id !== 'p-uno') return false
      cola = cola.filter(x => x.id !== id); return true
    })
    encolar.mockImplementation(async (p: Pendiente) => { cola = [...cola, p]; return 'entro' })
    sinRedAhora = true
    const r = montar()
    await act(async () => { for (const f of [...oyentesRed]) f() })
    await asentar()
    try {
      await caducarConLaVistaAbierta(r)
      expect(r.queryByTestId('notice')?.textContent ?? '',
        'cuenta las que intentó borrar, no las que borró').toBe(caducados(1))
    } finally { vi.useRealTimers() }
  })
})

