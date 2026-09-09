import type { NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export default async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  /**
   * `_next` entero queda fuera: el matcher anterior sólo excluía static e image,
   * así que interceptaba `_next/hmr` y rompía su WebSocket. Un patrón no nombra
   * una ruta, nombra un conjunto.
   *
   * R8 — Y ahora también el manifiesto y el service worker. El primero lo pide
   * el navegador en cada instalación y el segundo en cada arranque: hacerlos
   * pasar por `updateSession` es una ida y vuelta de sesión por algo que no
   * necesita sesión ninguna. El service worker además debe servirse desde la
   * raíz para poder gobernar todo el sitio.
   */
  matcher: ['/((?!_next/|favicon.ico|manifest.webmanifest|sw.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
