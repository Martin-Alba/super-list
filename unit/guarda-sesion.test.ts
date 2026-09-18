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

describe('DoD 6 y 6b · R4, la cota es del veredicto — y agotarla NO desvía', () => {
  /**
   * Medido en la spec (§2): `getUser()` **reintenta** los fallos de red, así que acotar
   * cada intento no acota nada — una sonda con la API colgada no dio veredicto en 80 s.
   * Aquí el doble no resuelve nunca, que es exactamente ese caso.
   *
   * Y el destino es el **login**, no la cáscara: un timeout no es evidencia de nada.
   * `status 0` dice que la red falló; una espera agotada sólo dice que no sabemos, y
   * desviar sobre «no sé» relaja R3. La primera versión desviaba, y puso rojos cuatro
   * casos de navegador —uno de ellos fila de la valla— porque las sesiones **inválidas**
   * tardan en ser rechazadas y acababan en la cáscara.
   */
  it('si getUser no contesta, la espera termina y cae al login', async () => {
    getUser.mockReturnValue(new Promise(() => {}))
    vi.useFakeTimers()
    try {
      const enCurso = pedir('/g/abc')
      /**
       * iter3 DoD 4 — A los 10,5 s —ya pasada la cota del **transporte**— todavía no hay
       * veredicto: la del veredicto va estrictamente por encima. Igualadas, el destino lo
       * decidía una diferencia de milisegundos. Este `race` contra un temporizador propio
       * es lo que pone rojo el caso si alguien las vuelve a empatar.
       */
      let resuelta = false
      void enCurso.then(() => { resuelta = true })
      await vi.advanceTimersByTimeAsync(10_500)
      expect(resuelta, 'la cota del veredicto empató con la del transporte').toBe(false)

      await vi.advanceTimersByTimeAsync(2_000)
      expect(destino(await enCurso)?.pathname,
        'agotar la cota desvió a la cáscara: eso es desviar sobre «no sé»').toBe('/login')
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

describe('iter1 · una respuesta lenta pero sana no se confunde con una caída', () => {
  /**
   * El hueco por el que entró la regresión. Con la cota en 3 s, cuatro casos de navegador
   * se pusieron rojos —tres tardando 15–16 min— porque `getUser` **tarda** cuando refresca
   * el token, y tardar se estaba leyendo como «no contesta»: la misma confusión que esta
   * spec arregla, una capa más abajo. Ningún caso ejercitaba «tarda y contesta bien», así
   * que ni los tests ni la pasada de mutación podían verlo.
   */
  it('si el veredicto llega dentro de la cota, se respeta aunque tarde', async () => {
    vi.useFakeTimers()
    try {
      getUser.mockReturnValue(new Promise((ok) => { setTimeout(() => ok(conSesion), 9_000) }))
      const enCurso = pedir('/g/abc')
      await vi.advanceTimersByTimeAsync(9_500)
      expect(destino(await enCurso),
        'una respuesta lenta pero válida acabó desviada: tardar no es no contestar').toBeNull()
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
      await vi.advanceTimersByTimeAsync(12_500)
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
      await vi.advanceTimersByTimeAsync(5_000)
      expect(señal?.aborted, 'abortó antes de vencer la cota').toBe(false)
      await vi.advanceTimersByTimeAsync(8_000)
      await enCurso
    } finally { vi.useRealTimers(); vi.unstubAllGlobals() }
  })
})

describe('DoD 8 · una ruta pública con la API caída se sirve sin redirección', () => {
  it.each(['/', '/login', '/sin-conexion', '/invite/tok3n'])('%s', async (ruta) => {
    getUser.mockResolvedValue(sinRed)
    expect(destino(await pedir(ruta)), 'se desvió una ruta pública').toBeNull()
  })
})
