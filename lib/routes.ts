/**
 * R2 — rutas públicas enumeradas.
 * Una entrada que casa por prefijo no nombra una ruta: nombra un conjunto.
 * Por eso '/' casa SÓLO exacta (si casara por prefijo capturaría todo el
 * sitio) y las demás casan exactas o como segmento completo, nunca como
 * subcadena: '/loginx' no es '/login'.
 */
export const PUBLIC_ROUTES = ['/', '/login', '/auth/callback', '/invite'] as const

export function isPublicRoute(pathname: string): boolean {
  for (const route of PUBLIC_ROUTES) {
    if (route === '/') {
      if (pathname === '/') return true
      continue
    }
    if (pathname === route || pathname.startsWith(`${route}/`)) return true
  }
  return false
}

/**
 * I4 — comprobar `next.startsWith('/')` NO basta. `//example.com` y su variante
 * con barra invertida son rutas relativas de protocolo: el navegador las
 * resuelve a otro dominio, así que el phishing sale servido desde el nuestro.
 * Un único validador, usado en los tres sitios que redirigen.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next) return '/'
  if (!next.startsWith('/')) return '/'
  if (next.startsWith('//')) return '/'
  if (next.startsWith('/\\')) return '/'
  // Un carácter de control puede colarse entre la barra y el host.
  if (/\p{Cc}/u.test(next)) return '/'
  return next
}
