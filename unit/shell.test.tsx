// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import { SIN_INSTANTANEA, SIN_RED_FUERA } from '@/lib/errors'

/**
 * K4/K5 — El shell, atacado donde vive. La mitad de navegador (DoD 49) prueba la
 * fuga con cookies de verdad; ésta prueba lo que el navegador no puede provocar a
 * mano: un almacén que **rechaza**.
 */
const leerUltimoUsuario = vi.fn()
const leerLista = vi.fn()
const leerNombre = vi.fn()
const leerCola = vi.fn()
const encolar = vi.fn()
const haySesionLocal = vi.fn()

vi.mock('@/lib/local', () => ({
  leerUltimoUsuario: () => leerUltimoUsuario(),
  leerLista: (...a: unknown[]) => leerLista(...a),
  leerNombre: (...a: unknown[]) => leerNombre(...a),
  leerCola: (...a: unknown[]) => leerCola(...a),
  encolar: (...a: unknown[]) => encolar(...a),
}))
vi.mock('@/lib/sesionLocal', () => ({ haySesionLocal: () => haySesionLocal() }))

const SinConexion = (await import('@/app/sin-conexion/page')).default

/**
 * Spec C / iter 2 / M2 — La ruta vive en una variable, no en la copia que el
 * banco del sondeo hacía de `window.location`. Aquel `{...window.location}`
 * congelaba `pathname` en `/`, así que los cinco casos del sondeo **nunca**
 * corrían dentro de un grupo: ni campo en pantalla, ni recarga con nada que
 * perder. Es el hueco por el que pasaron H1 y H3.
 */
let rutaActual = '/'
/** El `window.name` con el que arrancó el fichero: el bloque final compara con él. */
const nombreAlEmpezar = window.name
const enGrupo = (id = '8f1f1f7a-0000-4000-8000-000000000000') => {
  rutaActual = `/g/${id}`
  window.history.replaceState({}, '', rutaActual)
}

beforeEach(() => {
  vi.clearAllMocks()
  haySesionLocal.mockReturnValue(true)
  leerUltimoUsuario.mockResolvedValue('u1')
  leerLista.mockResolvedValue([{ id: 'i1', name: 'anchoas', quantity: null }])
  leerNombre.mockResolvedValue('Familia Alba')
  leerCola.mockResolvedValue([])
  encolar.mockResolvedValue(true)
  rutaActual = '/'
  window.history.replaceState({}, '', rutaActual)
})
afterEach(() => cleanup())

describe('K4 sin sesión en el dispositivo no se pinta la instantánea de nadie', () => {
  it('DoD 49 (módulo): sin cookie de sesión no se lee nada y no se pinta nada', async () => {
    haySesionLocal.mockReturnValue(false)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    expect(leerLista, 'se leyó la instantánea sin sesión en el dispositivo').not.toHaveBeenCalled()
    expect(screen.queryByText('anchoas'), 'la lista del anterior, sin sesión ninguna').toBeNull()
    expect(screen.getByTestId('sin-instantanea').textContent).toBe(SIN_INSTANTANEA)
  })

  // La sonda: si no pintara nunca, lo de arriba no probaría nada.
  it('DoD 50: con sesión, la instantánea del grupo sí se pinta', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByText('anchoas')).toBeTruthy())
  })
})

describe('K5 el shell termina de cargar aunque el almacén falle', () => {
  it.each([
    ['la marca de usuario', () => leerUltimoUsuario.mockRejectedValue(new Error('InvalidStateError'))],
    ['la instantánea', () => leerLista.mockRejectedValue(new Error('InvalidStateError'))],
  ])('DoD 52: si %s rechaza, se dice algo en vez de quedarse en blanco', async (_n, romper) => {
    romper()
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    expect(screen.getByTestId('sin-instantanea').textContent).toBe(SIN_INSTANTANEA)
  })

  it('y fuera de un grupo, con el almacén roto, tampoco habla de «este grupo»', async () => {
    leerUltimoUsuario.mockRejectedValue(new Error('InvalidStateError'))
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    expect(screen.getByTestId('sin-instantanea').textContent).toBe(SIN_RED_FUERA)
  })
})

/**
 * Spec C — Lo que la cáscara pasa a hacer. Todo medido en el navegador el
 * 2026-09-13 antes de escribir esto: la pantalla tenía **cero** elementos
 * interactivos, el banner era incondicional, y ocho segundos después de volver la
 * red seguía igual.
 */
describe('Spec C · la cáscara dice la verdad y tiene salida', () => {
  it('DoD 5: fuera de un grupo el banner no promete memoria', async () => {
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-red')).toBeTruthy())
    expect(screen.getByTestId('sin-red').textContent, 'promete una copia que no hay')
      .not.toMatch(/último que vimos/i)
  })

  it('DoD 6: en un grupo sin copia tampoco, pero sí ofrece apuntar', async () => {
    leerLista.mockResolvedValue(null)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-instantanea')).toBeTruthy())
    const t = screen.getByTestId('sin-red').textContent ?? ''
    expect(t).not.toMatch(/último que vimos/i)
    expect(t).toMatch(/apuntar/i)
  })

  /**
   * DoD 9 de la iteración 3 — Una instantánea **vacía** no es lo mismo que no
   * tener instantánea: el grupo se abrió y estaba sin productos. Decir «sin copia
   * de este grupo» ahí es falso.
   */
  it('iter4 DoD 1: con instantánea vacía, el banner y la línea no se contradicen', async () => {
    leerLista.mockResolvedValue([])
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-red')).toBeTruthy())
    const banner = screen.getByTestId('sin-red').textContent ?? ''
    expect(banner, 'con el grupo abierto y vacío dice que no hay copia').not.toMatch(/sin copia/i)
    /**
     * La mitad que la iteración 3 dejó abierta: el banner decía «esto es lo
     * último que vimos» y la línea de debajo «necesitas conexión para ver este
     * grupo por primera vez», en el mismo render. El arreglo tocó una de las dos
     * y nadie miró la otra (§E.4b).
     */
    const linea = screen.queryByTestId('sin-instantanea')?.textContent ?? ''
    expect(linea, `banner y línea se contradicen: «${banner}» contra «${linea}»`)
      .not.toMatch(/por primera vez/i)
  })

  it('DoD 7: con copia, la cáscara dice de qué grupo es', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('nombre-grupo')).toBeTruthy())
    expect(screen.getByTestId('nombre-grupo').textContent).toBe('Familia Alba')
  })

  // §D.5 — un dispositivo con instantánea anterior a este cambio no tiene nombre.
  it('DoD 8: sin nombre guardado no se rompe ni se inventa uno', async () => {
    leerNombre.mockResolvedValue(null)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByText('anchoas')).toBeTruthy())
    expect(screen.queryByTestId('nombre-grupo'), 'se inventó un nombre').toBeNull()
  })

  it('DoD 9: hay una salida', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('salida')).toBeTruthy())
    expect(screen.getByTestId('salida').getAttribute('href')).toBe('/')
  })
})

/**
 * Spec C / R3 — Apuntar desde la cáscara. Es el escenario que motivó la PWA:
 * supermercado, sin cobertura, y la app abierta de nuevo desde cero. Medido el
 * 2026-09-13: aquí no había ni campo ni botón.
 */
describe('Spec C · desde la cáscara se apunta, con la misma regla', () => {
  const apuntar = (nombre: string) => {
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: nombre } })
    fireEvent.click(screen.getByTestId('add-item'))
  }

  it('iter1 DoD 3: lo apuntado va a la cola, con su grupo y su usuario', async () => {
    enGrupo('8f1f1f7a-0000-4000-8000-000000000000')
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    apuntar('aceitunas')
    await waitFor(() => expect(encolar).toHaveBeenCalled())
    expect(encolar.mock.calls[0][0]).toMatchObject({
      usuario: 'u1', grupo: '8f1f1f7a-0000-4000-8000-000000000000',
      nombre: 'aceitunas', cantidad: null,
    })
    await waitFor(() => expect(screen.getByTestId('pendiente').textContent).toContain('aceitunas'))
  })

  it('iter1 DoD 4: un duplicado se rechaza con el mismo criterio que en la vista', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    // `anchoas` está en la instantánea; la regla normaliza, así que ANCHOAS también.
    apuntar('ANCHOAS')
    await waitFor(() => expect(screen.getByTestId('aviso-local')).toBeTruthy())
    expect(encolar, 'se encoló un duplicado').not.toHaveBeenCalled()
  })

  // J6 — si el almacén dice que no, no se pinta ficha.
  it('si el almacén rechaza, no se pinta el producto', async () => {
    encolar.mockResolvedValue(false)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    apuntar('aceitunas')
    await waitFor(() => expect(screen.getByTestId('aviso-local')).toBeTruthy())
    expect(screen.queryByTestId('pendiente'), 'ficha pintada sin que el disco la aceptara').toBeNull()
  })

  // Sonda (§E.2): fuera de un grupo no hay grupo al que apuntar, así que no se
  // ofrece. Sin esto, «hay campo» lo cumpliría también una cáscara que ofreciera
  // apuntar a ninguna parte.
  it('fuera de un grupo no se ofrece apuntar', async () => {
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-red')).toBeTruthy())
    expect(screen.queryByTestId('add-item')).toBeNull()
  })

  it('sin sesión en el dispositivo, tampoco', async () => {
    haySesionLocal.mockReturnValue(false)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('sin-red')).toBeTruthy())
    expect(screen.queryByTestId('add-item')).toBeNull()
  })
})

/**
 * Spec C / R1 y R2 — El sondeo. Se prueba con reloj falso porque lo que se
 * afirma es **cuándo** pregunta, no que la red exista.
 */
/** Lo que una sola cadena 2/4/8/16/30 gasta en 120 s, contando la que quedó en vuelo. */
const EN_REGIMEN = 8

describe('Spec C · la cáscara sondea hasta que vuelve la red', () => {
  let recargas = 0
  beforeEach(() => {
    recargas = 0
    sessionStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => respuesta(false)))
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        // La ruta se lee **cuando se usa**, no cuando se sustituye el objeto.
        get pathname() { return rutaActual },
        get href() { return `http://localhost${rutaActual}` },
        get origin() { return 'http://localhost' },
        reload: () => { recargas += 1 },
      },
    })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true, get: () => estadoVisible,
    })
  })
  let estadoVisible: DocumentVisibilityState = 'visible'
  /** R5 — la sonda exige HTML: un 200 sin tipo es un portal, no la app. */
  const respuesta = (ok: boolean, tipo = 'text/html; charset=utf-8',
                    url = `http://localhost${rutaActual}`) => ({
    ok, url,
    // Se deriva, como hace el navegador: si la URL final no es la pedida, hubo
    // redirección. Sin modelarlo, volver a `!res.redirected` no lo notaba nadie.
    redirected: url !== `http://localhost${rutaActual}`,
    headers: { get: () => tipo },
  }) as unknown as Response
  /**
   * `Object.defineProperty(window,'location',…)` **no** lo deshace
   * `unstubAllGlobals`: sin esta restauración, los casos del bloque siguiente
   * corrían sobre el sustituto de éste. Probado: envenenarlo los ponía rojos.
   */
  const locationReal = Object.getOwnPropertyDescriptor(window, 'location')
  const visibilidadReal = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  afterEach(() => {
    estadoVisible = 'visible'
    vi.unstubAllGlobals()
    vi.useRealTimers()
    if (locationReal) Object.defineProperty(window, 'location', locationReal)
    if (visibilidadReal) Object.defineProperty(document, 'visibilityState', visibilidadReal)
    else delete (document as unknown as Record<string, unknown>).visibilityState
  })

  it('DoD 1 y 2: cuando la sonda acierta, recarga', async () => {
    vi.useFakeTimers()
    enGrupo()
    render(<SinConexion />)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(respuesta(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(recargas, 'la red volvió y la cáscara siguió siendo la cáscara').toBe(1)
  })

  it('DoD 12: con la pestaña oculta no sondea', async () => {
    vi.useFakeTimers()
    estadoVisible = 'hidden'
    enGrupo()
    render(<SinConexion />)
    await act(async () => { await vi.advanceTimersByTimeAsync(40_000) })
    expect(globalThis.fetch, 'sondeó con la pestaña en el bolsillo').not.toHaveBeenCalled()
  })

  // Sonda de la de arriba: visible SÍ sondea. Sin ella, un sondeo que no
  // existiera pasaría el test de «oculta no sondea».
  it('y con la pestaña visible sí', async () => {
    vi.useFakeTimers()
    enGrupo()
    render(<SinConexion />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    // DoD 1 — se pregunta por la URL que se va a navegar, no por `/`.
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/g/'), expect.objectContaining({ cache: 'no-store' }))
  })

  /**
   * DoD 10 / borde 2 — La sonda acierta, la navegación vuelve a caer, y la
   * cadencia **no** se reinicia: si lo hiciera, una red que va y viene dejaría la
   * cáscara preguntando cada 2 s para siempre.
   */
  it('DoD 10: tras una recarga que vuelve a caer, la cadencia sigue donde estaba', async () => {
    vi.useFakeTimers()
    sessionStorage.setItem('sin-red:intento', JSON.stringify({ n: 4, t: Date.now() }))
    enGrupo()
    render(<SinConexion />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(globalThis.fetch, 'reinició la cadencia en 2 s').not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(28_000) })
    expect(globalThis.fetch, 'no sondeó a los 30 s').toHaveBeenCalled()
  })

  /**
   * DoD 15 — La prueba de que este banco mira lo que dice mirar. Antes sustituía
   * `window.location` con una copia hecha en `/`, así que los cinco casos de este
   * bloque corrían **fuera** de un grupo: sin campo en pantalla y sin nada que
   * perder al recargar. Es el hueco por el que pasaron el bucle y la cicatriz I4.
   */
  it('DoD 15: estos casos corren dentro de un grupo', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    expect(window.location.pathname).toMatch(/^\/g\//)
  })

  /**
   * DoD 2 — La sonda acierta, la navegación vuelve a caer aquí, y la cadencia
   * **escala**. Guardar sin incrementar dejaba la recarga a 2 s clavados,
   * indefinidamente: medido en la revisión, seis vueltas a 2.000 ms.
   */
  it('DoD 2: al acertar se guarda la cadencia escalada, no la misma', async () => {
    vi.useFakeTimers()
    enGrupo()
    render(<SinConexion />)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(respuesta(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(recargas).toBe(1)
    const { n } = JSON.parse(sessionStorage.getItem('sin-red:intento') ?? '{}') as { n: number }
    expect(n, 'se guardó el mismo intento: la recarga repetiría a los mismos 2 s').toBeGreaterThan(0)
  })

  /**
   * DoD 12 / R5 — Un portal cautivo contesta 200 a todo. Sin mirar el tipo, la
   * sonda acertaría bajo el portal y recargaría hacia su página.
   */
  it('iter2 DoD 12: un 200 que no es HTML no cuenta como red', async () => {
    vi.useFakeTimers()
    enGrupo()
    render(<SinConexion />)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValue(respuesta(true, 'text/plain'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(recargas, 'recargó con la respuesta de un portal').toBe(0)
  })

  /**
   * DoD 7 / R3 — Un hidden→visible con una sonda en vuelo dejaba el temporizador
   * anterior huérfano y armado. Medido en la revisión: el régimen pasaba de 4
   * sondas por 120 s a 7, y se quedaba así.
   */
  it('iter2 DoD 7: un cambio de visibilidad con sonda en vuelo no duplica el sondeo', async () => {
    vi.useFakeTimers()
    // La primera sonda se queda en vuelo a propósito: ésa es la ventana en la que
    // el cambio de visibilidad dejaba un temporizador huérfano y armado. Las
    // siguientes contestan enseguida, para poder medir el **régimen**.
    let soltar: (r: Response) => void = () => {}
    let n = 0
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      n += 1
      return n === 1 ? new Promise<Response>(r => { soltar = r }) : Promise.resolve(respuesta(false))
    })
    enGrupo()
    render(<SinConexion />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(n, 'no llegó a sondear').toBe(1)

    // La pestaña se va y vuelve mientras la sonda sigue en vuelo.
    estadoVisible = 'hidden'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    estadoVisible = 'visible'
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await act(async () => { soltar(respuesta(false)) })

    /**
     * Dos minutos de régimen, y se afirma el número **exacto**: bajo reloj falso
     * es determinista, y el techo holgado que tenía este test dejaba pasar la
     * duplicación entera — medido, 2 sondas contra 3, y el test pedía «≤ 7».
     */
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })
    expect(n, `el sondeo se duplicó: ${n} sondas en 120 s`).toBe(EN_REGIMEN)
  })

  /**
   * DoD 2 de la iteración 3 — Una redirección **fuera** del origen sigue
   * rechazada: es la defensa contra el portal cautivo, y aceptar la del propio
   * `/login` no puede llevársela por delante.
   */
  it('iter3 DoD 2: una redirección fuera del origen no cuenta como red', async () => {
    vi.useFakeTimers()
    enGrupo()
    render(<SinConexion />)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      respuesta(true, 'text/html', 'http://portal.wifi/acceso'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(recargas, 'recargó hacia el portal de una wifi ajena').toBe(0)
  })

  /** Y la del propio origen —el `/login` de la sesión caducada— sí. */
  it('iter3 DoD 1: la redirección al propio login sí cuenta como red', async () => {
    vi.useFakeTimers()
    enGrupo()
    render(<SinConexion />)
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      respuesta(true, 'text/html', 'http://localhost/login?next=%2Fg%2Fx'))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(recargas, 'la sesión caducada deja la cáscara encerrada para siempre').toBe(1)
  })

  /**
   * DoD 7 de la iteración 3 — Con el almacén de pestaña roto, la cadencia sigue
   * escalando. Si no, la guarda que acota el bucle se desactiva sola justo en el
   * navegador donde más falta hace.
   */
  /**
   * DoD 3 y 4 de la iteración 4 — El contador cruza la recarga **también** con el
   * almacén de pestaña capado. Medido el 2026-09-13: `window.name` sobrevive a
   * una recarga en la misma pestaña; `history.state` no vale, es de Next y lleva
   * su `__PRIVATE_NEXTJS_INTERNALS_TREE`. La iteración 3 declaró que «no había
   * dónde, y punto» sin haber buscado: era una afirmación de ausencia sin
   * instrumento.
   */
  it('iter4 DoD 3: con sessionStorage roto, el contador cruza la recarga', async () => {
    vi.useFakeTimers()
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: () => { throw new Error('denegado') },
               setItem: () => { throw new Error('denegado') } },
    })
    const nombrePrevio = window.name
    try {
      enGrupo()
      render(<SinConexion />)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
      expect(window.name, 'no quedó nada que cruce la recarga').toMatch(/^sin-red:/)
      expect(JSON.parse(window.name.replace('sin-red:', '')).n).toBeGreaterThan(0)
    } finally {
      window.name = nombrePrevio
      if (real) Object.defineProperty(window, 'sessionStorage', real)
    }
  })

  // La otra mitad: con el almacén bueno **no** se toca `window.name`, que es una
  // variable global de la pestaña y puede tener dueño.
  it('iter4 DoD 4: con sessionStorage bueno no se escribe window.name', async () => {
    vi.useFakeTimers()
    const nombrePrevio = window.name
    window.name = 'de-otro'
    try {
      enGrupo()
      render(<SinConexion />)
      await act(async () => { await vi.advanceTimersByTimeAsync(6_100) })
      expect(window.name, 'pisó una global de la pestaña que no es suya').toBe('de-otro')
    } finally { window.name = nombrePrevio }
  })

  /**
   * DoD 2 de la iteración 5 — La otra mitad del respaldo: que se **lea**.
   *
   * El `DoD 3` de la iteración 4 sólo probaba la escritura: quitando la lectura
   * de `window.name`, la suite entera seguía verde. Cuarta guarda medio ciega en
   * cuatro vueltas, y en el requisito que aquella vuelta estrenaba.
   */
  it('iter5 DoD 2: con sessionStorage roto, el contador sembrado SE LEE', async () => {
    vi.useFakeTimers()
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: () => { throw new Error('denegado') },
               setItem: () => { throw new Error('denegado') } },
    })
    const nombrePrevio = window.name
    window.name = `sin-red:${JSON.stringify({ n: 4, t: Date.now() })}`
    try {
      enGrupo()
      render(<SinConexion />)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
      expect(globalThis.fetch, 'no leyó el contador: la cadencia arrancó en 2 s')
        .not.toHaveBeenCalled()
      await act(async () => { await vi.advanceTimersByTimeAsync(28_000) })
      expect(globalThis.fetch, 'no sondeó a los 30 s').toHaveBeenCalled()
    } finally {
      window.name = nombrePrevio
      if (real) Object.defineProperty(window, 'sessionStorage', real)
    }
  })

  /**
   * DoD 6 de la iteración 4 — Una recarga entre `leerCola` y `encolar` aborta la
   * escritura: el usuario acaba en la vista y su producto no está, sin ficha y
   * sin aviso. El Borde 1 licencia perder el desplazamiento, no una escritura.
   */
  it('iter4 DoD 6: no se recarga con un envío en vuelo', async () => {
    vi.useFakeTimers()
    let soltar: (v: boolean) => void = () => {}
    encolar.mockImplementation(() => new Promise<boolean>(r => { soltar = r }))
    enGrupo()
    render(<SinConexion />)
    // Con reloj falso, `waitFor` no avanza: se deja asentar el efecto de montaje
    // a mano, sin llegar a los 2 s de la primera sonda.
    for (let i = 0; i < 5 && !screen.queryByTestId('add-item'); i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    }
    expect(screen.getByTestId('add-item')).toBeTruthy()
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: 'pan' } })
    fireEvent.click(screen.getByTestId('add-item'))
    ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(respuesta(true))
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(recargas, 'recargó con una escritura a medias: el producto se pierde').toBe(0)
    // Y cuando el envío termina, la recarga sí ocurre.
    await act(async () => { soltar(true) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(recargas, 'tras terminar el envío no se recuperó').toBe(1)
  })

  /**
   * DoD 7 de la iteración 3 — Un almacén de pestaña roto no **rompe** el sondeo
   * ni la recuperación. (El respaldo que cruza la recarga es `window.name`, y lo
   * prueban los casos de la iteración 4 y 5; aquel intento de respaldo en memoria
   * se retiró por no acotar nada.)
   */
  it('iter3 DoD 7: con sessionStorage roto el sondeo sigue funcionando', async () => {
    vi.useFakeTimers()
    const real = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: { getItem: () => { throw new Error('denegado') },
               setItem: () => { throw new Error('denegado') } },
    })
    // Con el almacén roto el producto escribe en `window.name`: hay que
    // devolverlo, y esto lo encontró la guarda del bloque final en su primera
    // pasada, que es para lo que está.
    const nombrePrevio = window.name
    try {
      enGrupo()
      render(<SinConexion />)
      // La cadencia dentro de una misma vida de página no depende del almacén:
      // 2/4 son dos sondas en 6,1 s. Y una sonda buena sigue recargando.
      await act(async () => { await vi.advanceTimersByTimeAsync(6_100) })
      expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length,
        'el almacén roto rompió el sondeo').toBe(2)
      ;(globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(respuesta(true))
      await act(async () => { await vi.advanceTimersByTimeAsync(9_000) })
      expect(recargas, 'el almacén roto impidió recuperarse').toBe(1)
    } finally {
      window.name = nombrePrevio
      if (real) Object.defineProperty(window, 'sessionStorage', real)
    }
  })

  // Y un episodio nuevo empieza rápido: una marca vieja no condena la pestaña a
  // esperar 30 s la próxima vez que se quede sin red.
  it('una marca caducada no ralentiza el episodio siguiente', async () => {
    vi.useFakeTimers()
    sessionStorage.setItem('sin-red:intento', JSON.stringify({ n: 4, t: Date.now() - 120_000 }))
    enGrupo()
    render(<SinConexion />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100) })
    expect(globalThis.fetch, 'arrastró una marca vieja').toHaveBeenCalled()
  })
})

/**
 * Spec C / iteración 2 — Lo que la revisión midió que faltaba.
 *
 * Tres de estos defectos son cicatrices que `GroupView` ya tenía pagadas y que
 * esta pantalla volvió a abrir: I4 (vaciar antes de esperar), R2 (el `return`
 * mudo) y la guarda de envío. Escribir una pantalla nueva no hereda las suyas.
 */
describe('Spec C · apuntar en la cáscara se comporta como en la vista', () => {
  const escribir = (v: string) =>
    fireEvent.change(screen.getByTestId('item-name'), { target: { value: v } })

  it('iter2 DoD 3: doble toque encola una sola vez', async () => {
    let soltar: (v: boolean) => void = () => {}
    encolar.mockImplementation(() => new Promise<boolean>(r => { soltar = r }))
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    escribir('pan')
    fireEvent.click(screen.getByTestId('add-item'))
    /**
     * Iteración 3 — Se teclea **otro** texto antes del segundo toque. Sin esto el
     * segundo clic caía en la rama del campo vacío, así que el test medía el
     * vaciado y no la guarda: quedaba verde quitando `enviandoRef`, quitando
     * `disabled`, y quitando las dos. Demostrado en la revisión.
     */
    escribir('vino')
    fireEvent.click(screen.getByTestId('add-item'))
    await act(async () => { soltar(true) })
    /**
     * Fija **la pareja** de guardas: medido, quitar las dos lo pone rojo, y
     * quitar sólo la `ref` no, porque aquí `disabled` ya ha vuelto a pintar. El
     * caso en que la `ref` es la que salva —dos toques antes de repintar— vive en
     * el navegador, y allí se prueba.
     */
    expect(encolar.mock.calls.length, 'el doble toque encoló dos veces').toBe(1)
  })

  it('DoD 4 (cicatriz I4): el campo se vacía ANTES de esperar al almacén', async () => {
    let soltar: (v: boolean) => void = () => {}
    encolar.mockImplementation(() => new Promise<boolean>(r => { soltar = r }))
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    escribir('pan')
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(encolar).toHaveBeenCalled())
    expect((screen.getByTestId('item-name') as HTMLInputElement).value,
      'lo tecleado durante el await se pierde: apuntando seis entran tres').toBe('')
    await act(async () => { soltar(true) })
  })

  it('y si el almacén dice que no, el texto vuelve al campo', async () => {
    encolar.mockResolvedValue(false)
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    escribir('pan')
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('aviso-local')).toBeTruthy())
    expect((screen.getByTestId('item-name') as HTMLInputElement).value,
      'se tragó lo tecleado y encima no lo guardó').toBe('pan')
  })

  it('iter2 DoD 5 (cicatriz R2): con el campo vacío se dice, no se calla', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('aviso-local')).toBeTruthy())
    expect(encolar).not.toHaveBeenCalled()
  })

  it('y con sólo espacios, igual', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    escribir('   ')
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('aviso-local')).toBeTruthy())
    expect(encolar).not.toHaveBeenCalled()
  })

  /**
   * DoD 6 de la iteración 3 — `try/finally` sin `catch`: un throw del almacén se
   * llevaba lo tecleado sin decir nada. Es la cicatriz del `return` mudo por otra
   * puerta.
   */
  it('iter3 DoD 6: si el almacén lanza, se devuelve el texto y se dice', async () => {
    encolar.mockRejectedValue(new Error('InvalidStateError'))
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    escribir('pan')
    fireEvent.click(screen.getByTestId('add-item'))
    await waitFor(() => expect(screen.getByTestId('aviso-local')).toBeTruthy())
    expect((screen.getByTestId('item-name') as HTMLInputElement).value,
      'se tragó lo tecleado y encima no lo guardó').toBe('pan')
  })

  it('DoD 6: la tecla «ir» del teclado envía', async () => {
    enGrupo()
    render(<SinConexion />)
    await waitFor(() => expect(screen.getByTestId('add-item')).toBeTruthy())
    const campo = screen.getByTestId('item-name')
    const formulario = campo.closest('form')
    expect(formulario, 'no hay formulario: en el móvil la tecla «ir» queda muerta').not.toBeNull()
    escribir('pan')
    fireEvent.submit(formulario!)
    await waitFor(() => expect(encolar).toHaveBeenCalled())
  })
})

/**
 * Spec C / iteración 4 / DoD 5 — La guarda de la guarda.
 *
 * R5 de la iteración 3 restauró `window.location` y **nadie lo vigilaba**:
 * quitar la restauración dejaba los 35 casos en verde. Este bloque va **después**
 * del sondeo a propósito, porque es el que heredaba su sustituto.
 */
describe('Spec C · el banco del sondeo devuelve lo que toma prestado', () => {
  it('iter4 DoD 5: window.location volvió a ser el de verdad', () => {
    expect(Object.getPrototypeOf(window.location),
      'el sustituto del bloque anterior sigue puesto: los casos de aquí no miran el producto')
      .toBe(Location.prototype)
  })

  it('y window.name también', () => {
    // Se compara con el valor de partida, no con la cadena vacía: un
    // `beforeEach` que limpiara taparía justo la falta de restauración.
    expect(window.name, 'el banco del sondeo dejó puesto un window.name suyo')
      .toBe(nombreAlEmpezar)
  })

  it('y document.visibilityState también', () => {
    const d = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    expect(d?.get?.toString().includes('estadoVisible'),
      'la visibilidad quedó sustituida para el resto del fichero').not.toBe(true)
  })
})
