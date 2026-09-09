/**
 * R2 — rutas públicas enumeradas.
 * Una entrada que casa por prefijo no nombra una ruta: nombra un conjunto.
 * Por eso '/' casa SÓLO exacta (si casara por prefijo capturaría todo el
 * sitio) y las demás casan exactas o como segmento completo, nunca como
 * subcadena: '/loginx' no es '/login'.
 */
/**
 * J2 — `/sin-conexion` entra aquí porque el service worker la precachea **sin
 * sesión**: la primera visita de cualquiera es anónima, y ahí es donde se
 * instala. Sin esto el proxy la redirigía a `/login` y lo que se guardaba bajo la
 * clave del shell era la redirección — medido: arranque en frío sin red con
 * `ERR_FAILED` para todo usuario real, y verde en la suite sólo porque sus
 * caminos entran por `/auth/callback`, que no renderiza layout.
 *
 * No enseña nada de nadie: es una página estática que lee el almacén local.
 */
export const PUBLIC_ROUTES = ['/', '/login', '/auth/callback', '/invite', '/sin-conexion'] as const

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

/**
 * Q5 — `encodeURI` a secas doble-codifica lo que ya venía percent-encoded:
 * medido, `/g/a%20b` acaba en `/g/a%2520b`, y es alcanzable porque el middleware
 * escribe `pathname + search` ya codificado. Pero sin codificar nada, un
 * carácter fuera de ASCII hace que Node rechace la cabecera `Location` con un
 * 500 que quema el código de un solo uso.
 *
 * Se codifica **sólo cuando hace falta**: si el destino ya es ASCII imprimible,
 * viaja tal cual.
 */
// Caracteres que pueden viajar crudos en una cabecera `Location`: los que RFC
// 3986 permite sin codificar, más `%` cuando ya encabeza un triplete válido.
const SEGURO_CRUDO = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/
const TRIPLETE = /^%[0-9A-Fa-f]{2}/

export function comoLocation(destino: string): string {
  let salida = ''
  let i = 0
  while (i < destino.length) {
    // S6 — un triplete ya codificado se respeta: codificar la cadena entera lo
    // volvía `%25xx`, y es alcanzable porque el middleware escribe
    // `pathname + search` ya codificado.
    if (TRIPLETE.test(destino.slice(i, i + 3))) { salida += destino.slice(i, i + 3); i += 3; continue }
    // Se avanza por PUNTO DE CÓDIGO, no por unidad UTF-16. Recorrer unidades
    // partía en dos los pares suplentes —cualquier emoji— y `encodeURIComponent`
    // lanzaba sobre cada mitad: 500, sin `Location` y sin `Set-Cookie`, con el
    // código de un solo uso quemado. Es el fallo de N1 reintroducido por el
    // arreglo de S6, y alcanzable desde fuera con un enlace a `/login?next=…`.
    const punto = String.fromCodePoint(destino.codePointAt(i)!)
    salida += punto.length === 1 && SEGURO_CRUDO.test(punto) ? punto : encodeURIComponent(punto)
    i += punto.length
  }
  return salida
}
