import type { NextRequest } from 'next/server'
import { updateSession } from './lib/supabase/middleware'

export default async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  // `_next` entero queda fuera: el matcher anterior sólo excluía static e
  // image, así que interceptaba `_next/hmr` y rompía su WebSocket. Un patrón
  // no nombra una ruta, nombra un conjunto.
  matcher: ['/((?!_next/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
