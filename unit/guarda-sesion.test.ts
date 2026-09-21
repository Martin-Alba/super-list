import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Spec C — **«No puedo comprobar la sesión» no es «no tienes sesión».**
 *
 * La guarda resolvía las dos causas en `user = null` y mandaba las dos al login.
 * Con el plan gratuito pausado —la web responde, la base no— eso deja a quien SÍ
 * tiene sesión fuera de una lista que su dispositivo ya tiene guardada, y en una
 * pantalla desde la que tampoco puede entrar, porque el login también necesita la API.
 *
 * Capa (§E.1): el requisito habla de la guarda de ruta del servidor, así que se llama a
 * `updateSession` directamente, sin pasar por el navegador.
 *
 * Las tres clases de error están **medidas** contra el cliente real (spec §2):
 * sin sesión → `AuthSessionMissingError` / 400 · sesión inválida con la API viva →
 * `AuthApiError` / 403 · sesión con la API caída → `AuthRetryableFetchError` / **0**.
 * Los dobles de aquí reproducen esas tres formas, no unas inventadas.
 */
const getUser = vi.fn()
/**
 * iter4 R1 — El doble **usa** el `global.fetch` que la guarda le inyecta, en vez de
 * tirarlo. Es lo único que faltaba para poder observar el cableado del aborto: la señal
 * que llega al transporte es un hecho de esta capa, y tirarla era lo que hacía
 * «imposible» un caso que resultó ser de veinte líneas.
 */
let fetchInyectado: typeof fetch | undefined
vi.mock('@supabase/ssr', () => ({
  createServerClient: (_url: string, _clave: string, opciones?: { global?: { fetch?: typeof fetch } }) => {
    fetchInyectado = opciones?.global?.fetch
    return { auth: { getUser } }
  },
}))

const { updateSession } = await import('@/lib/supabase/middleware')
const { NextRequest } = await import('next/server')

const pedir = (ruta: string) =>
  updateSession(new NextRequest(new URL(`http://localhost:3000${ruta}`)))

/** Dónde acaba la petición: null si no hubo redirección. */
const destino = (r: Response) =>
  r.status >= 300 && r.status < 400 ? new URL(r.headers.get('location')!) : null

const sinSesion = { data: { user: null }, error: { name: 'AuthSessionMissingError', status: 400 } }
const invalida = { data: { user: null }, error: { name: 'AuthApiError', status: 403 } }
const sinRed = { data: { user: null }, error: { name: 'AuthRetryableFetchError', status: 0 } }
const conSesion = { data: { user: { id: 'u1' } }, error: null }

beforeEach(() => { getUser.mockReset() })

describe('DoD 1 y 2 · con sesión y la API caída se va a la cáscara, no al login', () => {
  it('una ruta privada termina en /sin-conexion', async () => {
    getUser.mockResolvedValue(sinRed)
    const u = destino(await pedir('/g/abc'))
    expect(u?.pathname, 'la red caída sigue tratándose como ausencia de sesión')
      .toBe('/sin-conexion')
  })

  /**
   * DoD 3 — y conserva el destino. Se afirma **junto con la ruta**: comprobar sólo el
   * `next` pasaba en verde hoy, porque el camino del login ya lo conserva, y habría sido
   * una casilla que se marca sola.
   */
  it('y conserva el destino en `next`, en la cáscara', async () => {
    getUser.mockResolvedValue(sinRed)
    const u = destino(await pedir('/g/abc?x=1'))
    expect([u?.pathname, u?.searchParams.get('next')]).toEqual(['/sin-conexion', '/g/abc?x=1'])
  })
})

describe('DoD 4 y 5 · R3, lo que NO cambia: sin sesión válida se sigue yendo al login', () => {
  it('sin sesión ninguna, al login', async () => {
    getUser.mockResolvedValue(sinSesion)
    expect(destino(await pedir('/g/abc'))?.pathname).toBe('/login')
  })

  it('con sesión inválida, al login', async () => {
    getUser.mockResolvedValue(invalida)
    expect(destino(await pedir('/g/abc'))?.pathname,
      'un 403 se tomó por fallo de red: eso deja entrar a quien no tiene sesión').toBe('/login')
  })

  /**
   * La sonda del límite escrito de R3: una clase que **no** se midió cae al destino por
   * defecto, que es el login. Es lo que hace segura la lista sin enumerarla entera.
   */
  /**
   * iter3 R5 — Con las formas que el cliente **puede** producir, medidas contra él: el
   * `AuthUnknownError` real llega sin `status`, y un 5xx llega como `AuthRetryableFetchError`.
   * La versión anterior usaba `{name:'AuthUnknownError', status:500}`, que no existe, y por
   * eso pasaba sin cruzar ninguna frontera real.
   */
  it('un AuthUnknownError sin status cae al login', async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthUnknownError', status: undefined } })
    expect(destino(await pedir('/g/abc'))?.pathname).toBe('/login')
  })

  /**
   * iter3 R4 — Y un 5xx **sí desvía**, que es lo que el cliente hace y lo que la spec dice
   * ahora: un 5xx es el servicio diciendo que no puede contestar. R3 no se toca — sin
   * cookies `getUser()` ni sale a la red, así que nadie sin sesión llega aquí.
   */
  it.each([500, 502, 503, 504])('un %i llega como fallo de red y desvía', async (status) => {
    getUser.mockResolvedValue({ data: { user: null }, error: { name: 'AuthRetryableFetchError', status } })
    expect(destino(await pedir('/g/abc'))?.pathname).toBe('/sin-conexion')
  })

  it('y con sesión válida no se redirige a ningún sitio', async () => {
    getUser.mockResolvedValue(conSesion)
    expect(destino(await pedir('/g/abc'))).toBeNull()
  })
})

describe('Spec I / I-R2 · la cota es del veredicto — y agotarla SÍ desvía', () => {
  /**
   * **Esta fila invierte su aserción, y es una de las dos que la Spec I declara.**
   *
   * Decía: el destino es el login, porque «un timeout no es evidencia de nada». Ahora es la
   * cáscara, y la evidencia que lo justifica es un abismo medido: contra la instancia local, todo lo
   * que el servidor contesta se resuelve **por debajo de 100 ms** —sana con refresco 76 ms, inválida
   * 3 ms, usuario borrado 6 ms— y todo lo que no contesta tarda **25–31 s**, porque `getUser`
   * reintenta. Con tres órdenes de magnitud de separación, agotar una cota corta **sí** dice algo.
   *
   * Y su motivo escrito —«las sesiones inválidas tardan en ser rechazadas y acababan en la
   * cáscara»— se midió falso: tardan 3 y 6 ms.
   *
   * Lo que esto arregla: con la cota anterior de 12 s, ni un proyecto dormido ni uno caído llegaban
   * **nunca** a la cáscara. Los dos la agotaban, no desviaban, y caían al login — el callejón que la
   * Spec C existía para cerrar, con su mecanismo construido y sin alcanzar su caso.
   */
  it('si getUser no contesta, la espera termina y desvía a la cáscara', async () => {
    getUser.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const enCurso = pedir('/g/abc')
      /**
       * La relación con la cota del transporte se invirtió: el veredicto (2 s) vence **antes** que
       * el transporte (10 s), y a propósito. Ya no hay empate que romper: el veredicto siempre gana,
       * que es lo que hace el destino determinista. A 1,5 s todavía no hay veredicto; esta línea se
       * pone roja si alguien baja la cota hasta empatarla con el render.
       */
      let resuelta = false
      void enCurso.then(() => { resuelta = true })
      await vi.advanceTimersByTimeAsync(4_000)
      expect(resuelta, 'la cota venció antes de su plazo').toBe(false)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(destino(await enCurso)?.pathname,
        'agotar la cota cayó al login: quien tiene sesión se queda fuera de su propia lista')
        .toBe('/sin-conexion')
    } finally { vi.useRealTimers() }
  })
})

describe('R3 · lo que la pasada de mutación encontró sin guardar', () => {
  /**
   * Superviviente 7: cambiar el `catch` para que desvíe a la cáscara no ponía nada rojo.
   * El `catch` es el destino de lo que no sabemos leer, y R3 dice por escrito que eso cae
   * al login. Sin este caso, esa frase no la sostenía nadie.
   */
  it('si getUser LANZA, se va al login y no a la cáscara', async () => {
    getUser.mockRejectedValue(new Error('algo que no sabemos leer'))
    expect(destino(await pedir('/g/abc'))?.pathname,
      'un fallo ilegible abrió la cáscara: R3 dice que cae al destino cerrado').toBe('/login')
  })

  /**
   * Superviviente 8: quitar el `clearTimeout` tampoco ponía nada rojo. No se ve en
   * pantalla, pero son temporizadores vivos en **cada petición del sitio**, y eso sí se
   * puede contar.
   */
  it('no deja temporizadores vivos cuando el veredicto llega a tiempo', async () => {
    vi.useFakeTimers()
    try {
      getUser.mockResolvedValue(conSesion)
      await pedir('/g/abc')
      expect(vi.getTimerCount(), 'la guarda dejó un temporizador por petición').toBe(0)
    } finally { vi.useRealTimers() }
  })
})

describe('Spec I / I-R2 · una respuesta sana pero tardía SÍ se desvía — decisión provisional', () => {
  /**
   * **La segunda fila que la Spec I invierte, y la que no estaba declarada cuando se selló.** Salió
   * del build, se paró, y se declaró antes de tocarla.
   *
   * Afirmaba que una respuesta sana a los 9 s debía respetarse, sobre el lema «tardar no es no
   * contestar». Ese lema era **una suposición sobre el servidor, no una propiedad del producto**, y
   * su justificación escrita —que `getUser` tarda al refrescar, y que 3 s enrojeció cuatro casos—
   * se midió falsa dos veces: un refresco cuesta 29 ms, y los cuatro casos no se reproducen por
   * ninguno de los tres caminos que se probaron.
   *
   * **El intercambio, escrito como decisión PROVISIONAL y no como cerrada:**
   *
   * - *Qué se acepta:* una respuesta sana que tarde más que la cota se desvía a la cáscara. No es un
   *   callejón —la cáscara enseña la lista que el dispositivo guarda y deja apuntar—, pero es una
   *   pantalla distinta de la que el usuario pidió.
   * - *De qué depende:* de cuánto tarda en contestar un proyecto de Supabase **despertando**, que
   *   **no está medido** y no se puede medir desde local, porque el contenedor no duerme.
   * - *Cuándo se revisa:* en el primer despliegue, con esa medida delante. **Si un proyecto dormido
   *   contesta en varios segundos, este intercambio manda a la cáscara a quien abra la app tras una
   *   semana sin usarla — que es el uso normal de una lista familiar, no un caso raro.**
   */
  it('si el veredicto llega después de la cota, se desvía aunque sea sano', async () => {
    vi.useFakeTimers()
    try {
      getUser.mockReturnValue(new Promise((ok) => { setTimeout(() => ok(conSesion), 9_000) }))
      const enCurso = pedir('/g/abc')
      await vi.advanceTimersByTimeAsync(9_500)
      expect(destino(await enCurso)?.pathname,
        'una respuesta tardía se respetó: la cota no está acotando nada').toBe('/sin-conexion')
    } finally { vi.useRealTimers() }
  })

  it('y si llega DENTRO de la cota, se respeta — la mitad que no cambia', async () => {
    vi.useFakeTimers()
    try {
      getUser.mockReturnValue(new Promise((ok) => { setTimeout(() => ok(conSesion), 1_000) }))
      const enCurso = pedir('/g/abc')
      await vi.advanceTimersByTimeAsync(4_000)
      expect(destino(await enCurso),
        'una respuesta sana dentro de la cota acabó desviada').toBeNull()
    } finally { vi.useRealTimers() }
  })
})

/**
 * Spec C / iter3 R2, guardado en iter4 — **La petición en vuelo queda abortada.**
 *
 * Medido con el cliente real antes de escribir el mecanismo: abandonándola, una rotación
 * de token más lenta que la cota se completaba arriba —la API servía `/auth/v1/token`—
 * mientras la respuesta ya había salido con `set-cookie: []`. El refresh token se consumía
 * y el navegador se quedaba con el viejo: una API lenta no mandaba al login una vez,
 * **cerraba la sesión**.
 *
 * Declaré este caso imposible en la iteración 3 —«con el cliente mockeado no existe el
 * reintento»— y estaba equivocado: el requisito no habla del reintento, habla de **la
 * petición en vuelo**, y eso se observa en la señal que recibe el `fetch` inyectado. Lo
 * que faltaba era que el doble la usara.
 */
describe('iter4 R1 · al vencer la cota, la señal que llega al transporte se aborta', () => {
  it('la petición en vuelo queda abortada', async () => {
    let señal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_u: unknown, init?: { signal?: AbortSignal }) => {
      señal = init?.signal
      return new Promise(() => {})
    }))
    // `getUser` hace lo que hace el cliente real: una petición por el transporte inyectado.
    getUser.mockImplementation(() => { void fetchInyectado?.('http://auth/'); return new Promise(() => {}) })
    vi.useFakeTimers()
    try {
      const enCurso = pedir('/g/abc')
      await vi.advanceTimersByTimeAsync(5_500)
      await enCurso
      expect(señal?.aborted,
        'la guarda venció su cota y dejó la petición viva: puede rotar el token después de responder')
        .toBe(true)
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })

  // Sonda (§E.2): con la cota sin vencer, la señal NO está abortada. Sin esto, el caso de
  // arriba pasaría con una señal que naciera abortada.
  it('y antes de vencer, no', async () => {
    let señal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_u: unknown, init?: { signal?: AbortSignal }) => {
      señal = init?.signal
      return new Promise(() => {})
    }))
    getUser.mockImplementation(() => { void fetchInyectado?.('http://auth/'); return new Promise(() => {}) })
    vi.useFakeTimers()
    try {
      const enCurso = pedir('/g/abc')
      // Spec I — sólo la constante: la cota bajó de 12 s a 2 s y la propiedad que esta sonda
      // vigila —«no aborta antes de vencer»— no cambia.
      await vi.advanceTimersByTimeAsync(4_000)
      expect(señal?.aborted, 'abortó antes de vencer la cota').toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      await enCurso
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
})

describe('DoD 8 · una ruta pública con la API caída se sirve sin redirección — salvo la portada', () => {
  /**
   * **Spec I / i1-R8 — esta fila pierde `/`, y es la cuarta de la valla que esta spec cambia.**
   *
   * La propiedad se conserva donde tiene sentido: con la API caída no puedes entrar ni aceptar una
   * invitación, pero la pantalla que pides es la tuya, y desviarla sería decidir por ti.
   *
   * `/` es distinta por una razón medida y no por gusto: es `start_url` del manifiesto, o sea el
   * punto de entrada de la app instalada, y tardaba **15.022 ms** en blanco para acabar pintando la
   * portada de invitado a alguien que tiene sesión y tiene su lista guardada en el dispositivo.
   * (Medido con `supabase_auth_super` pausado y los otros diez contenedores arriba; los 15 s son los
   * 5 de la cota del proxy más los 10 de `NETWORK_TIMEOUT_MS` que paga el `getUser()` del render.)
   * La cáscara enseña esa lista y deja apuntar.
   */
  it.each(['/login', '/sin-conexion', '/invite/tok3n'])('%s', async (ruta) => {
    getUser.mockResolvedValue(sinRed)
    expect(destino(await pedir(ruta)), 'se desvió una ruta pública').toBeNull()
  })

  it('la portada sí, y con el destino conservado', async () => {
    getUser.mockResolvedValue(sinRed)
    const d = destino(await pedir('/'))
    expect(d?.pathname, 'la portada se quedó esperando: 15 s en blanco en la app instalada')
      .toBe('/sin-conexion')
    expect(d?.searchParams.get('next'), 'se perdió el destino').toBe('/')
  })
})
