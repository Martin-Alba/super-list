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

/**
 * Spec I / I-R1 — **Rutas que no consumen la sesión.** La guarda se las sirve sin preguntar a
 * Supabase, que es lo que permite que la cáscara llegue con la base dormida.
 *
 * Es **una sola**, y no «las públicas», porque se midió ruta por ruta: `/`, `/login` e
 * `/invite/[token]` llaman a `getUser()` en su propio render —consumen la sesión— y además la guarda
 * es el único punto donde el token se renueva, porque un Server Component no puede escribir cookies.
 * Saltársela ahí dejaría la sesión sin refrescar. `/sin-conexion` no toca Supabase en absoluto: lee
 * de IndexedDB.
 *
 * La lista va aquí y no en el matcher del proxy a propósito: excluir rutas del matcher es un parche
 * que hay que mantener a mano cada vez que se añade una pública, y se olvida.
 *
 * **`/sw-version.js` NO está aquí, y dónde acabó lo decidió esta misma guarda.** El generado no era
 * ruta pública, así que la petición anónima que hace el service worker al importarlo recibía **307 a
 * `/login`**: `importScripts` lanzaba y entraba el respaldo — en Chromium real el worker se instalaba
 * como `super-sin-version`. Meterlo en esta lista lo arreglaba, y el invariante de abajo lo rechazó
 * con razón: se serviría sin sesión **sin ser una ruta pública**, que es el agujero que el invariante
 * existe para impedir.
 *
 * Lo que dice ese rechazo es que la lista no era su sitio: `/sw-version.js` no es una página, es **el
 * fichero del propio worker**, y su hermano `sw.js` lleva excluido en el matcher del proxy desde que
 * existe, con su motivo escrito al lado. Ahí es donde está.
 *
 * **Dos afirmaciones que este comentario hacía y eran falsas, corregidas:**
 *
 * 1. Decía «con la misma guarda que comprueba que coincide con lo declarado». **Esa guarda no
 *    existía.** Ahora sí: `unit/public-routes.test.ts`.
 * 2. Decía «su modo de fallo es benigno: una ruta de más sólo pierde el refresco». **Medido falso**:
 *    con `/g` en la lista, `/g/<uuid>` **sin sesión ninguna** devuelve 200 sin redirección — la
 *    denegación de §A.3 desaparece del proxy y el destino se pierde. Lo que lo hace benigno de verdad
 *    es el invariante de abajo, que lo impide en vez de confiarlo.
 *
 * **`RUTAS_SIN_SESION ⊆ PUBLIC_ROUTES`**, comprobado por su guarda: una ruta que no consume sesión
 * pero tampoco es pública sería exactamente el agujero que la afirmación 2 negaba.
 */
export const RUTAS_SIN_SESION = ['/sin-conexion'] as const

export function noConsumeSesion(pathname: string): boolean {
  return RUTAS_SIN_SESION.some(r => pathname === r || pathname.startsWith(`${r}/`))
}

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
