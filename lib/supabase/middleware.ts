import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isPublicRoute, noConsumeSesion } from '../routes'
import { noSePudoComprobar } from '../errors'
import { boundedFetch, NETWORK_TIMEOUT_MS } from '../boundedFetch'

/** Spec C — no hubo veredicto dentro de la cota. Distinto de «no hay usuario». */
const SIN_VEREDICTO = Symbol('sin-veredicto')

/**
 * Spec C / R4 — La cota del **veredicto**. `NETWORK_TIMEOUT_MS` acota cada **intento**, y
 * `getUser` reintenta: medido, una API colgada no dio veredicto en 80 s. O sea que sin
 * esto la espera no tenía techo, y ésa es la diferencia que R4 pedía.
 *
 * **Spec I — va por DEBAJO de la del transporte, y eso invierte lo que este párrafo decía.**
 * Decía «estrictamente por encima… empatadas, el destino lo decidía una diferencia de 4 ms»: con
 * 5 s de veredicto y 10 s de transporte ya no hay empate que romper, porque el veredicto **siempre**
 * gana. Eso es lo que hace el destino determinista, y es deliberado: lo que antes se resolvía como
 * «rechazo con señal de red real» tras 25 s ahora se resuelve como «no contesta» a los 5, que es la
 * inversión de I-R2.
 *
 * **Spec I — el valor bajó a 2 s, y las tres razones que lo impedían se midieron falsas.**
 *
 * Este párrafo decía que la cota tenía que ser la de red porque «`getUser` tarda cuando refresca el
 * token» y porque una cota de 3 s «enrojeció cuatro casos de navegador». Medido:
 *
 * - Un refresco cuesta **29 ms** (p50, n=40); el compuesto refresco+lectura, **76 ms**. Lo que tarda
 *   25 s es el **bucle de reintentos** ante un fallo de red, que es otro mecanismo — el mismo
 *   comentario lo dice bien tres párrafos más arriba.
 * - Las sesiones inválidas, que el párrafo de abajo decía que «tardan en ser rechazadas», tardan
 *   **3 ms** (refresh token basura) y **6 ms** (usuario borrado), con `status 400`.
 * - Y los cuatro casos de navegador **no se reproducen**: se probó con la cota a 3 s, con 3 s más la
 *   inversión, y con las dos más la señal de aborto retirada. `test:e2e` exit 0, 106/106 las tres
 *   veces. No se puede distinguir entre «otros cambios lo arreglaron», «esos casos ya no existen» y
 *   «la atribución era falsa», y no se elige.
 *
 * 2 s deja ~20× de margen sobre el peor caso sano medido, y queda muy por debajo del límite de la
 * plataforma (300 s en Hobby con Fluid Compute), que ya no es la restricción.
 */
/**
 * **5 s, y el número salió de dónde cae el abismo, no de apurar.**
 *
 * Medido: peor caso sano **53 ms**, suelo de lo que no contesta **25.428 ms**. Cualquier cota muy por
 * debajo de 25 s separa los dos lados igual de bien, así que bajar de 5 a 2 no compra detección —
 * compra 3 s menos de espera en la caída real, y los paga con margen sobre el único número que nadie
 * ha medido: cuánto tarda en contestar un proyecto de Supabase **despertando**. Con 5 s el abismo
 * sigue a 5× y el margen sobre lo sano es de casi 100×.
 *
 * Y hay un coste de apurar que conviene tener escrito: al vencer, la señal aborta un **refresco en
 * vuelo**. Si el servidor estaba lento pero vivo y llegó a rotar el refresh token, pasado el
 * intervalo de reutilización esa sesión muere — y entonces el destino no es la cáscara, es el login
 * de verdad. Cuanto más corta la cota, más a menudo se corta un refresco sano.
 */
const COTA_DEL_VEREDICTO_MS = 5_000

export async function updateSession(request: NextRequest) {
  /**
   * Spec I / I-R1 — **Lo que no consume la sesión se sirve sin preguntar por ella.**
   *
   * Antes esta función llamaba a `getUser()` sin condiciones y miraba la ruta después, así que
   * `/sin-conexion` —la cáscara, que existe precisamente para cuando la base no contesta— esperaba
   * el veredicto de la base para servirse. Con el proyecto dormido eso es esperar por algo que no se
   * va a usar: la cáscara lee de IndexedDB.
   *
   * Es una sola ruta y no «las públicas»: ver `RUTAS_SIN_SESION`, donde está medido por qué.
   */
  if (noConsumeSesion(request.nextUrl.pathname)) return NextResponse.next({ request })

  let response = NextResponse.next({ request })
  const corte = new AbortController()

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // iter3 R2 — El `fetch` del cliente recibe nuestra señal además de su cota: al
      // vencer el veredicto la petición en vuelo se **aborta**, no se abandona.
      global: { fetch: boundedFetch(NETWORK_TIMEOUT_MS, corte.signal) },
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          toSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    },
  )

  // I13/D.6 — el `fetch` del cliente ya lleva la cota, así que `getUser` rechaza al vencer el plazo
  // en vez de colgarse, y la petición queda abortada de verdad.
  //
  // Spec I — este comentario decía «no se omite en las rutas públicas: **todas** consumen la
  // sesión». Ya no es cierto y era la negación de I-R1: se omite en `/sin-conexion`, que es pública
  // y no toca Supabase. Lo que sigue siendo cierto es el resto: `/`, `/login` e `/invite/[token]`
  // llaman a `getUser()` en su propio render, y éste es el único punto donde el token se renueva,
  // porque un Server Component no puede escribir cookies.
  //
  // Spec C / R4 — Pero la cota del transporte es la del **intento**, y `getUser`
  // reintenta los fallos de red: medido, una API colgada no daba veredicto en 80 s.
  // Así que la carrera acota el **veredicto**. Sin ella, R1 no sirve de nada: la
  // distinción existiría y nadie llegaría a usarla.
  let user = null
  let sinComprobar = false
  let reloj: ReturnType<typeof setTimeout> | undefined
  try {
    // La carrera va **aquí**, junto a la consulta, y no dentro de un auxiliar: la
    // guarda de D.6 sigue el dato hasta la llamada, y una cota que vive en otra
    // función es una cota que nadie puede comprobar desde ésta.
    const veredicto = await Promise.race([
      supabase.auth.getUser(),
      new Promise<typeof SIN_VEREDICTO>((ok) => {
        reloj = setTimeout(() => { corte.abort(); ok(SIN_VEREDICTO) }, COTA_DEL_VEREDICTO_MS)
      }),
    ])
    // R4 — Agotar la cota **no desvía**: un timeout no es evidencia de nada. `status 0`
    // dice que la red falló; una espera agotada sólo dice que no sabemos, y desviar sobre
    // «no sé» relaja R3. Medido: la versión que desviaba puso rojos cuatro casos de
    // navegador —uno de ellos fila de la valla— porque las sesiones inválidas tardan en
    // ser rechazadas y acababan en la cáscara.
    if (veredicto !== SIN_VEREDICTO) {
      user = veredicto.data.user
      sinComprobar = noSePudoComprobar(veredicto.error)
    } else {
      /**
       * Spec I / I-R2 — **Agotar la cota SÍ desvía, y esto invierte una regla de la Spec C.**
       *
       * La regla anterior decía que un timeout no es evidencia de nada. La medida dice lo contrario,
       * y por un margen que no admite discusión: contra la instancia local, **todo lo que el
       * servidor contesta se resuelve por debajo de 100 ms** —sesión sana con refresco 76 ms, sesión
       * inválida 3 ms, sesión de un usuario borrado 6 ms— y **todo lo que no contesta tarda 25–31 s**,
       * porque `getUser` reintenta. Tres órdenes de magnitud, y nada en medio.
       *
       * Con ese abismo, agotar una cota corta **es** la señal de que no hay servidor.
       *
       * Y lo que esto arregla no es un matiz: con la cota anterior de 12 s, ni un proyecto dormido ni
       * uno caído llegaban **nunca** a la cáscara. Los dos agotaban la cota, no desviaban, y caían a
       * `/login` — el callejón exacto que la Spec C se construyó para cerrar, con su mecanismo
       * construido y sin alcanzar su caso.
       */
      sinComprobar = true
    }
  } catch {
    // A.3 — un fallo que no sabemos leer no se interpreta: cae al destino por
    // defecto, que es el login. Es el límite escrito de R3.
    user = null
  } finally {
    // Sin esto la guarda deja un temporizador vivo en cada petición del sitio.
    clearTimeout(reloj)
  }

  const { pathname } = request.nextUrl

  // A.3 fallar cerrado: sin usuario, todo lo que no esté en la lista pública
  // se deniega — y se conserva el destino para volver tras el login (R1).
  //
  // Spec C / R1 y R2 — Lo único que cambia es **a dónde** se deniega. «No hay sesión» y «no he
  // podido comprobarla» son causas distintas: la primera va al login, que es donde se arregla; la
  // segunda, a la cáscara, que enseña la copia local del dispositivo y deja apuntar. No se relaja
  // ninguna comprobación —el destino nuevo ya era ruta pública— y quien no tiene sesión sigue yendo
  // al login (R3).
  //
  // Spec I — y «no he podido comprobarla» incluye ahora **agotar la cota**, que es la inversión de
  // I-R2. Este bloque llevaba un párrafo diciendo lo contrario, con una justificación —«las sesiones
  // inválidas tardan en ser rechazadas»— que se midió falsa: tardan 3 y 6 ms.
  /**
   * Spec I / i1-R8 — **La portada también va a la cáscara cuando el servidor no contesta.**
   *
   * Medido por mí, con el entorno declarado —`supabase_auth_super` pausado y los otros diez arriba—
   * y con una sesión real en el navegador:
   *
   *   `/g/<uuid>`      → `/sin-conexion`   5.022 ms  ✓
   *   `/sin-conexion`  → `/sin-conexion`       7 ms  ✓
   *   `/`              → se queda en `/`  15.022 ms
   *   `/login`         → se queda        15.023 ms
   *
   * Los 15 s se explican solos: 5 de la cota de aquí, más los 10 de `NETWORK_TIMEOUT_MS` que paga el
   * `getUser()` del propio render, al que esta cota no alcanza. Y `start_url` del manifiesto es `/`:
   * quien abre la PWA instalada con el proyecto dormido se come esos 15 s en blanco y acaba en la
   * portada de invitado, teniendo sesión y teniendo su lista guardada en el dispositivo.
   *
   * **Sólo `/`, y eso rompe una fila de la Spec C a propósito.** `DoD 8` afirma que las cuatro rutas
   * públicas se sirven sin redirección con la API caída. Se conserva para `/login` y `/invite`, donde
   * tiene sentido —con la API caída no puedes entrar ni aceptar una invitación, pero la pantalla que
   * pides es la tuya— y se rompe para `/`, que es el punto de entrada de la app instalada y la única
   * ruta donde la cáscara es estrictamente mejor: enseña la lista que el dispositivo ya guarda.
   *
   * `/auth/callback` no entra en esta rama por el mismo motivo que `PROHIBIDO` en `sw.js`: tiene que
   * llegar al servidor o fallar como lo que es.
   */
  if (sinComprobar && pathname === '/') {
    const url = request.nextUrl.clone()
    url.pathname = '/sin-conexion'
    url.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(url)
  }

  if (!user && !isPublicRoute(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = sinComprobar ? '/sin-conexion' : '/login'
    url.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(url)
  }

  return response
}
