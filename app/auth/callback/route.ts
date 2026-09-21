import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { comoLocation, safeNext } from '@/lib/routes'

/**
 * M1 — El destino se emite **relativo**. `new URL(request.url).origin` lo
 * resuelve `next start` como `localhost:3000` sea cual sea el `Host` que envió
 * el navegador, así que un redirect absoluto cambiaba de origen y abandonaba la
 * cookie de sesión que se acababa de escribir: el usuario volvía a la pantalla
 * de invitado con la sesión intacta en el otro host. La guarda de rutas ya usa
 * destino relativo y por eso nunca tuvo el problema.
 */
function redirigirA(destino: string) {
  // N1 — `NextResponse.redirect()` normalizaba la URL; la cabecera cruda no.
  // Q5 — pero codificar siempre doble-codificaba lo ya percent-encoded.
  // Un `next` con caracteres fuera de ASCII (p. ej. `/⁄⁄evil.com`, con barra de
  // fracción U+2044) hacía que Node rechazara la cabecera: 500, sin `Location`
  // y sin `Set-Cookie`, quemando el código de un solo uso y dejando fuera a un
  // usuario ya autenticado. El estado a medias que A.3 prohíbe.
  return new NextResponse(null, { status: 303, headers: { Location: comoLocation(destino) } })
}

/**
 * N5 / P1 — Aquí hubo un barrido manual de verificadores, primero ciego y luego
 * acotado al éxito. Se retira del todo: con el identificador de flujo viajando
 * en el callback, `auth-js` limpia **el slot correcto** con su
 * `removePKCEVerifier`, documentado como *"Never clears other flows' slots"*.
 * El barrido hacía a bulto lo que la librería hace con precisión, y quedaba
 * como mina para el día en que alguien conectara `flowId`.
 */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  // `sb_flow_id`: identifica cuál de los flujos concurrentes vuelve.
  const flowId = searchParams.get('sb_flow_id')
  // M2 — el destino se valida igual que antes; lo que cambia es cómo se emite.
  const target = safeNext(searchParams.get('next'))

  let destino = '/login?error=auth'
  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(
      code, flowId ? { flowId } : undefined)
    if (!error) destino = target
  }

  return redirigirA(destino)
}
