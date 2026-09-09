/**
 * R9 / I1 — Service worker mínimo, escrito a mano.
 *
 * Existe por una razón medida: sin él, abrir la app **sin red y desde cero** da la
 * pantalla de error del navegador. El App Shell de Next vive en el router de la
 * pestaña, no en disco, así que no sobrevive a cerrar la app — que es justo lo que
 * pasa entre una compra y la siguiente.
 *
 * **Lo que NO hace, que es la mitad importante:** no guarda ni una navegación. La
 * primera versión cacheaba el documento y eso resultó ser un fallo duro de A.1 —
 * medido: 9.851 B con el nombre del grupo y sus ítems, sobreviviendo al cierre de
 * sesión, legibles por otro usuario del mismo dispositivo con sólo navegar. Un
 * documento renderizado con sesión es dato de alguien; en disco compartido no
 * entra.
 *
 * Lo que sí guarda es un shell **estático**, sin dato de nadie, que al abrirse lee
 * la instantánea local del usuario que estaba dentro. Los datos siguen viviendo en
 * IndexedDB, que es lo único que `olvidarTodo` puede vaciar.
 */
const VERSION = 'super-v2'
const SHELL = '/sin-conexion'
/** Lo que acompaña al shell y puede faltar sin que deje de servir. */
const ACCESORIOS = ['/icon-192.png', '/icon-512.png']

/**
 * Lo que pasa de largo sin que el service worker lo toque. Aunque ya no se guarda
 * ninguna navegación, interceptar el callback de auth para servirle un shell
 * cuando la red falla rompería el canje del código en silencio: ese camino tiene
 * que llegar al servidor o fallar como lo que es.
 */
const PROHIBIDO = /^\/(auth|api)\/|\/rest\/v1\//

const esDocumento = (req) => req.mode === 'navigate'
const esEstatico = (url) => url.pathname.startsWith('/_next/static/')
  || /\.(png|svg|ico|woff2?|css|js)$/.test(url.pathname)

/**
 * L3 — Y el shell se acepta sólo si **es** el shell. Un portal cautivo —una wifi
 * de centro comercial -- contesta **200 y sin redirección** con su propia página,
 * así que ni `ok` ni `redirected` lo delatan; y como esta clave no se vuelve a
 * escribir nunca, el dispositivo se queda con el portal de puerta sin red.
 *
 * La marca es el testigo que la propia pantalla pinta: si algún día desaparece
 * del shell, esto deja de precachear y se nota, que es mejor que aceptar
 * cualquier HTML.
 */
const MARCA_DEL_SHELL = 'data-testid="sin-red"'

async function esElShell(res) {
  if (!/text\/html/i.test(res.headers.get('content-type') || '')) return false
  return (await res.text()).includes(MARCA_DEL_SHELL)
}

/**
 * El shell no sirve de nada sin lo que necesita para hidratarse, y nadie visita
 * `/sin-conexion` con red, así que sus scripts nunca llegarían a la caché por el
 * camino normal. Medido: el documento se servía con estado 200 y la página no
 * hidrataba — un `ERR_FAILED` por cada chunk, y la lista local sin pintar.
 *
 * Se leen del propio HTML del shell en vez de escribirlos a mano: los nombres
 * llevan hash y cambian en cada build. Así el precacheado se mantiene solo.
 */
async function recursosDelShell(html) {
  const urls = new Set()
  for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) urls.add(m[1])
  return [...urls]
}

/**
 * M4 — Nada entra en la caché sin decir qué es.
 *
 * `cache.add` acepta cualquier 200, y bajo un portal cautivo —una wifi de centro
 * comercial— **todo** es un 200 con HTML. Medido: un chunk pedido bajo el portal
 * se guardaba como si fuera código, y como los estáticos se sirven de caché sin
 * revalidar, el dispositivo quedaba con una app que no arranca ni con red ni sin
 * ella. Un `.js` que vuelve como HTML no es un `.js`.
 */
async function guardarRecurso(cache, url) {
  const res = await fetch(url, { credentials: 'omit' })
  if (!res.ok || res.redirected) throw new Error(`no llegó ${url}`)
  if (/text\/html/i.test(res.headers.get('content-type') || '')) {
    throw new Error(`no es un recurso: ${url}`)
  }
  await cache.put(url, res)
}

self.addEventListener('install', (evento) => {
  evento.waitUntil((async () => {
    try {
      const cache = await caches.open(VERSION)
      /**
       * J2 — Se guarda lo que llega **sin redirección**. `cache.addAll` guardaba
       * alegremente el 307 hacia `/login`, y como el service worker no reinstala,
       * la clave del shell quedaba envenenada para el resto de la vida de la
       * instalación. Ahora una redirección se rechaza: mejor sin shell que con uno
       * que lleva a otro sitio.
       *
       * K3 — Y sin shell no hay instalación: resolver igual dejaba el worker
       * activo y vacío, y un `!ok` pasajero en la primera visita —la del usuario
       * anónimo, que es donde se instala— dejaba el dispositivo sin modo sin red
       * para siempre. Fallando, el navegador lo reintenta en la siguiente
       * navegación.
       */
      const res = await fetch(SHELL, { credentials: 'omit' })
      if (!res.ok || res.redirected || !(await esElShell(res.clone()))) {
        throw new Error('no se pudo precachear el shell')
      }
      await cache.put(SHELL, res)

      /**
       * L3 — Los accesorios no tiran la instalación: sin iconos el shell sigue
       * sirviendo, y `fetch` rechaza cuando la red se cae a mitad, que con la red
       * del supermercado es normal.
       */
      for (const url of ACCESORIOS) {
        try { await guardarRecurso(cache, url) } catch { continue }
      }

      /**
       * M2 — Pero los **recursos del shell** son el shell. Tragarse su fallo daba
       * por buena una instalación que servía el documento y no hidrataba: la
       * franja de «sin conexión» sin la lista debajo, y sin el aviso de que no la
       * hay. Misma decisión que K3: mejor sin modo sin red —y reintentándolo— que
       * con uno roto para siempre.
       */
      const html = await (await cache.match(SHELL)).text()
      await Promise.all((await recursosDelShell(html)).map((u) => guardarRecurso(cache, u)))
      await self.skipWaiting()
    } catch (e) {
      /**
       * M4 — Una instalación a medias es peor que ninguna. Lo que quedara escrito
       * se serviría de caché sin revalidar, y el reintento del día siguiente se
       * encontraría el shell ya guardado y sólo pediría los recursos que
       * faltaban: bajo un portal cautivo, eso es guardar su HTML bajo la clave de
       * cada chunk. Medido con un banco que conserva la caché entre intentos, que
       * es lo que hace el navegador. Se deja el sitio vacío.
       */
      await caches.delete(VERSION)
      throw e
    }
  })())
})

self.addEventListener('activate', (evento) => {
  /**
   * Borde 7 — una versión nueva se lleva por delante las cachés de las anteriores
   * y toma el mando de las pestañas abiertas. I8 — **sólo las suyas**: borrar
   * cualquier caché ajena es pisar a otro código que comparte el origen.
   */
  evento.waitUntil(
    caches.keys()
      .then((nombres) => Promise.all(
        nombres.filter((n) => n.startsWith('super-') && n !== VERSION).map((n) => caches.delete(n)),
      ))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (evento) => {
  const req = evento.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Otro origen —la base, el servicio de auth— pasa de largo: ni se mira.
  if (url.origin !== self.location.origin) return
  if (PROHIBIDO.test(url.pathname)) return

  if (esDocumento(req)) {
    /**
     * Siempre a la red, y **nunca se guarda lo que vuelve**. Si no hay quien
     * conteste, se sirve el shell estático: la URL no cambia, así que el shell
     * sabe qué grupo se pedía y puede pintar su última lista conocida.
     */
    /**
     * L7 — Si el shell fue desalojado por presión de almacenamiento, `match`
     * devuelve `undefined` y `respondWith(undefined)` es un error de red raro. Se
     * responde con un fallo de verdad: el navegador enseña su pantalla, que es lo
     * mismo que sin service worker, pero sin quedar en un estado indefinido.
     */
    evento.respondWith(
      fetch(req).catch(() => caches.match(SHELL).then((r) => r || Response.error())),
    )
    return
  }

  if (esEstatico(url)) {
    evento.respondWith(
      caches.match(req).then((c) => c || fetch(req).then((res) => {
        // I10 — un 404 o un 500 cacheado se serviría sin red para siempre.
        if (!res.ok) return res
        const copia = res.clone()
        evento.waitUntil(caches.open(VERSION).then((k) => k.put(req, copia)))
        return res
      })),
    )
  }
})
