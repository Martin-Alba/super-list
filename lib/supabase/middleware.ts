import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { isPublicRoute } from '../routes'
import { boundedFetch } from '../boundedFetch'

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: { fetch: boundedFetch() },
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
  // verdad. Un fallo aquí se resuelve como "sin usuario": A.3 manda fallar
  // cerrado, y eso deniega en vez de esperar. No se omite en las rutas
  // públicas: todas consumen la sesión, y éste es el único punto donde se
  // renueva el token.
  let user = null
  try {
    const { data } = await supabase.auth.getUser()
    user = data.user
  } catch {
    user = null
  }

  const { pathname } = request.nextUrl

  // A.3 fallar cerrado: sin usuario, todo lo que no esté en la lista pública
  // se deniega — y se conserva el destino para volver tras el login (R1).
  if (!user && !isPublicRoute(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname + request.nextUrl.search)
    return NextResponse.redirect(url)
  }

  return response
}
