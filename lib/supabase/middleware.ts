import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isPublicRoute } from '../routes'
import { noSePudoComprobar } from '../errors'
import { boundedFetch, NETWORK_TIMEOUT_MS } from '../boundedFetch'

/** Spec C — no hubo veredicto dentro de la cota. Distinto de «no hay usuario». */
const SIN_VEREDICTO = Symbol('sin-veredicto')

/**
 * Spec C / R4 — La cota del **veredicto**. `NETWORK_TIMEOUT_MS` acota cada **intento**, y
 * `getUser` reintenta: medido, una API colgada no dio veredicto en 80 s. O sea que sin
 * esto la espera no tenía techo, y ésa es la diferencia que R4 pedía.
 *
 * Va **estrictamente por encima** de la del transporte, y eso es parte del mecanismo:
 * empatadas, el destino lo decidía una diferencia de 4 ms — si gana el transporte, el
 * mismo estado da `status 0` y desvía; si gana la carrera, login. Por encima, un intento
 * lento resuelve siempre como rechazo **con señal de red real**, y la carrera sólo
 * dispara cuando `getUser` está reintentando, que es para lo que existe.
 *
 * El valor base es el de red que el proyecto ya declara, y no uno nuevo, por una medida:
 * **la primera versión puso 3 s y enrojeció cuatro casos de navegador**, tres de ellos
 * tardando 15–16 minutos. `getUser` **tarda** cuando refresca el token, y una cota corta
 * lee «tarda» como «no contesta» — la misma confusión que esta spec arregla, una capa más
 * abajo. Ver el caso «una respuesta lenta pero sana no se confunde con una caída».
 */
const COTA_DEL_VEREDICTO_MS = NETWORK_TIMEOUT_MS + 2_000

export async function updateSession(request: NextRequest) {
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

  // I13/D.6 — el `fetch` del cliente ya lleva la cota, así que `getUser` rechaza
  // al vencer el plazo en vez de colgarse, y la petición queda abortada de
  // verdad. No se omite en las rutas públicas: todas consumen la sesión, y éste
  // es el único punto donde se renueva el token.
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
  // Spec C / R1 y R2 — Lo único que cambia es **a dónde** se deniega. «No hay
  // sesión» y «no he podido comprobarla» son causas distintas: la primera va al
  // login, que es donde se arregla; la segunda, a la cáscara, que enseña la copia
  // local del dispositivo y deja apuntar. No se relaja ninguna comprobación —el
  // destino nuevo ya era ruta pública— y quien no tiene sesión sigue yendo al
  // login (R3).
  if (!user && !isPublicRoute(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = sinComprobar ? '/sin-conexion' : '/login'
    url.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(url)
  }

  return response
}
