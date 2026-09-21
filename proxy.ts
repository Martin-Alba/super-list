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
   *
   * **Spec I / i1-R1 — y `sw-version.js`, que es el fichero del propio worker.** Lo genera
   * `scripts/version-sw.mjs` en cada build y `sw.js` lo trae con `importScripts`. Sin excluirlo, esa
   * petición —anónima, la hace el worker— recibía **307 a `/login`**: `importScripts` lanzaba y el
   * worker se instalaba con la versión de respaldo. Medido en Chromium real.
   *
   * Va aquí y no en `RUTAS_SIN_SESION` porque el invariante de esa lista lo rechazó, y con razón:
   * estaría servido sin sesión sin ser una ruta pública. No es una página — es el hermano de `sw.js`,
   * y su sitio es el de `sw.js`.
   */
  matcher: ['/((?!_next/|favicon.ico|manifest.webmanifest|sw.js|sw-version.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
