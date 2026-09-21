import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

/** El respaldo de `sw.js` cuando `importScripts` no existe, que es el caso de este banco. */
const VERSION_EN_BANCO = 'super-sin-version'

/**
 * R9 / DoD 15 — El criterio de prueba suficiente que la spec escribió antes de
 * sellar, mitad de módulo: se carga el **fuente real** del service worker y se le
 * disparan eventos. No se afirma sobre su árbol ni sobre una copia: lo que se
 * ejecuta es el fichero que se sirve.
 *
 * Lo que se mide es la rama: para una petición de datos o de auth, ¿llega a
 * responder? Si no responde, no cachea — no hay otra vía.
 */
type Escucha = (evento: unknown) => void

type Traida = { ok?: boolean; redirected?: boolean; rechaza?: boolean; tipo?: string; cuerpo?: string }
type Respuesta = {
  url: string; ok: boolean; redirected: boolean
  headers: { get: (n: string) => string | null }
  text: () => Promise<string>; clone: () => Respuesta
}

function cargarSW(origen = 'https://app.example', traidas: Record<string, Traida> = {}) {
  const oyentes: Record<string, Escucha> = {}
  const pendientes: Promise<unknown>[] = []
  const cacheado: string[] = []
  const borradas: string[] = []
  /** Lo que el precacheado guarda bajo cada clave, para poder mirarlo. */
  const guardado = new Map<string, { text: () => Promise<string> }>()
  const almacen = {
    open: async () => ({
      addAll: async () => {},
      add: async (url: string) => {
        if (traidas[url]?.rechaza || traidas[url]?.ok === false) throw new Error('no se pudo guardar')
        cacheado.push(url); guardado.set(url, { text: async () => '' })
      },
      // Lo que se lee de vuelta es lo que se guardó: con un cuerpo fijo, el
      // precacheado de los recursos del shell no podía mirarse.
      match: async (clave?: string) => guardado.get(clave ?? ''),
      put: async (req: { url: string } | string, res?: { text?: () => Promise<string> }) => {
        const clave = typeof req === 'string' ? req : req.url
        cacheado.push(clave)
        guardado.set(clave, { text: async () => (res?.text ? await res.text() : '<html></html>') })
      },
    }),
    match: async (clave?: string) => guardado.get(clave ?? ''),
    /**
     * Spec I / I-R4 — La versión del worker ya no es un literal de `sw.js`: la trae
     * `sw-version.js`, generado a partir del sha del commit. En este banco `importScripts` no
     * existe, así que el worker cae a su respaldo y se llama `super-sin-version`. Lo que estas
     * filas vigilan —purgar sólo lo ajeno, borrar lo propio al fallar— no cambia; cambia el nombre.
     */
    keys: async () => [VERSION_EN_BANCO, 'super-vieja', 'otra-cosa'],
    delete: async (n: string) => { borradas.push(n); return true },
  }
  const yo = {
    addEventListener: (t: string, f: Escucha) => { oyentes[t] = f },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
    location: { origin: origen },
  }
  /**
   * El precacheado pide por **cadena** —`fetch('/sin-conexion')`— y el resto por
   * objeto. Lo que devuelve lleva `ok` y `redirected`, que es lo que la guarda
   * mira: sin ellos el fetch de mentira daba por bueno cualquier cosa.
   */
  const fetchFalso = async (req: { url: string } | string) => {
    const url = typeof req === 'string' ? req : req.url
    const t = traidas[url] ?? {}
    // L3 — Un `fetch` puede **rechazar**, no sólo traer un `!ok`: es lo que hace
    // una red que se cae a mitad, que es la red de un supermercado.
    if (t.rechaza) throw new Error('red caída')
    const cuerpo = t.cuerpo ?? '<html><p data-testid="sin-red">x</p></html>'
    /**
     * El tipo por defecto lo decide la extensión, como lo decide un servidor: un
     * banco que devolvía `text/html` para todo hacía que un chunk legítimo se
     * rechazara, y con él la instalación entera.
     */
    const tipoPorDefecto = /\.js($|\?)/.test(url) ? 'application/javascript'
      : /\.css($|\?)/.test(url) ? 'text/css'
      : /\.(png|svg|ico|woff2?)($|\?)/.test(url) ? 'image/png'
      : 'text/html'
    const hacer = (): Respuesta => ({
      url, ok: t.ok ?? true, redirected: t.redirected ?? false,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-type' ? (t.tipo ?? tipoPorDefecto) : null) },
      text: async () => cuerpo,
      clone: () => hacer(),
    })
    return hacer()
  }
  const fuente = readFileSync('public/sw.js', 'utf8')
  new Function('self', 'caches', 'fetch', fuente)(yo, almacen, fetchFalso)

  return {
    /**
     * Dispara un `fetch` y devuelve si el service worker se hizo cargo.
     *
     * El evento trae `waitUntil` porque el producto lo usa para guardar el
     * estático **después** de responder. Sin él, esa rama lanzaba dentro de una
     * promesa sin dueño: el recuento de casos seguía verde y `pnpm test` salía
     * con código 1. La puerta se lee por su código de salida.
     */
    pide(url: string, modo: 'navigate' | 'cors' = 'navigate', metodo = 'GET') {
      let respondio = false
      const dadas: Promise<unknown>[] = []
      oyentes.fetch?.({
        request: { url, mode: modo, method: metodo },
        respondWith: (p: Promise<unknown>) => { respondio = true; dadas.push(Promise.resolve(p)) },
        waitUntil: (p: Promise<unknown>) => { dadas.push(Promise.resolve(p)) },
      })
      pendientes.push(...dadas)
      return respondio
    },
    /** Espera a todo lo que el worker dejó en marcha. */
    async reposo() { await Promise.all(pendientes.splice(0)) },
    /** Devuelve la promesa que el evento `install` pone en cola. */
    instalar(): Promise<unknown> {
      let esperada: Promise<unknown> = Promise.resolve()
      oyentes.install?.({ waitUntil: (p: Promise<unknown>) => { esperada = p } })
      return esperada
    },
    /** Devuelve la promesa que el evento `activate` pone en cola. */
    activar(): Promise<unknown> {
      let esperada: Promise<unknown> = Promise.resolve()
      oyentes.activate?.({ waitUntil: (p: Promise<unknown>) => { esperada = p } })
      return esperada
    },
    cacheado,
    borradas,
    guardado,
  }
}

describe('R9 el service worker no toca datos ni sesión', () => {
  const sw = cargarSW()
  /**
   * L6 / DoD 62 — El bloque comparte instancia, así que lo que el worker deja en
   * marcha se quedaba sin dueño: un rechazo ahí sale como `Unhandled Rejection`,
   * el recuento de casos sigue verde y `pnpm test` acaba en 1. Es exactamente el
   * fallo que K1 arregló en un sitio y no en la estructura que lo permitía.
   */
  afterEach(() => sw.reposo())

  it.each([
    ['una consulta a la base', 'https://xyz.supabase.co/rest/v1/items?select=*'],
    ['un canje de sesión', 'https://xyz.supabase.co/auth/v1/token'],
    ['la base en el mismo origen', 'https://app.example/rest/v1/items'],
    ['el callback de auth', 'https://app.example/auth/callback?code=x'],
    ['una ruta de api', 'https://app.example/api/loquesea'],
  ])('no se hace cargo de %s', (_n, url) => {
    expect(sw.pide(url, 'cors'), 'el service worker respondió a algo que no debe cachear').toBe(false)
    expect(sw.pide(url, 'navigate'), 'ni siquiera navegando').toBe(false)
  })

  it('ni de una escritura, aunque sea de este origen', () => {
    expect(sw.pide('https://app.example/g/123', 'navigate', 'POST')).toBe(false)
  })

  it('ni de otro origen cualquiera', () => {
    expect(sw.pide('https://otro.example/algo.js', 'cors')).toBe(false)
  })

  // La contraparte: si no se hiciera cargo de NADA, lo de arriba sería vacío.
  it('pero sí del documento y de los estáticos de la app', () => {
    expect(sw.pide('https://app.example/g/123', 'navigate'), 'no sirve el documento').toBe(true)
    expect(sw.pide('https://app.example/_next/static/chunk.js', 'cors'), 'no sirve los estáticos').toBe(true)
  })

  /**
   * I1 / DoD 19 — Y del documento **no guarda nada**. Es la mitad que convirtió a
   * la versión anterior en un fallo duro de A.1: el documento va renderizado con
   * sesión, así que cachearlo es dejar los datos de alguien en un disco que
   * comparten todos los que usen el dispositivo.
   */
  it('sirve el documento pero no lo guarda', async () => {
    const limpio = cargarSW()
    limpio.pide('https://app.example/g/123', 'navigate')
    await limpio.reposo()
    expect(limpio.cacheado, 'guardó una navegación en caché').toEqual([])
  })

  /**
   * DoD 46 — Y la otra mitad, que hasta ahora no la miraba nadie: el estático
   * **sí** se guarda. Sin ella, «no guarda navegaciones» lo cumpliría también un
   * worker que no guardara nada, y el arranque en frío se quedaría sin los
   * scripts con los que el shell hidrata.
   */
  it('pero el estático sí lo guarda, que es de lo que vive el shell', async () => {
    const limpio = cargarSW()
    limpio.pide('https://app.example/_next/static/chunks/a.js', 'cors')
    await limpio.reposo()
    expect(limpio.cacheado, 'no guardó el estático: sin él el shell no hidrata')
      .toContain('https://app.example/_next/static/chunks/a.js')
  })

  /**
   * DoD 16 / borde 7 — Se prueba aquí y no en navegador: forzar una activación
   * real exige publicar una segunda versión del fichero, y sin eso el navegador
   * reutiliza el worker que ya tiene — medido, la caché vieja sobrevivía 20 s de
   * espera. Ejecutando el fuente real el resultado es determinista.
   */
  it('una versión nueva purga las cachés de las anteriores y sólo ésas', async () => {
    const nuevo = cargarSW()
    await nuevo.activar()
    expect(nuevo.borradas, 'no purgó la caché de la versión anterior').toContain('super-vieja')
    expect(nuevo.borradas, 'se llevó por delante su propia caché').not.toContain(VERSION_EN_BANCO)
    /**
     * I8 / DoD 29 — La versión anterior de este test afirmaba que una caché
     * ajena **debía** borrarse, que es lo contrario de lo que el DoD dice. El
     * origen puede tener más código; llevarse sus cachés por delante es pisarlo.
     */
    expect(nuevo.borradas, 'borró una caché que no es suya').not.toContain('otra-cosa')
  })
})

/**
 * J2 / DoD 35 — La guarda que sobrevive a que la ruta vuelva a ser privada. Un
 * service worker **no reinstala**: lo que se guarde mal bajo la clave del shell
 * queda ahí para el resto de la vida de la instalación, así que precachear una
 * redirección al login no es un fallo pasajero, es un dispositivo estropeado.
 *
 * Se prueba en el módulo porque la mitad de navegador (DoD 34) sólo puede
 * ponerse roja quitando también la ruta pública: con la ruta bien, esta guarda no
 * tiene nada que rechazar y no la mira nadie.
 */
describe('J2 el precacheado no guarda lo que no es el shell', () => {
  /**
   * DoD 35 y 48 — Las dos mitades del mismo requisito: no se guarda lo que no es
   * el shell, **y** la instalación que se queda sin shell falla. Resolver igual
   * dejaba el worker activo y vacío para el resto de la vida de la instalación.
   */
  it('DoD 35 y 48: una respuesta redirigida no ocupa la clave del shell, y la instalación falla',
    async () => {
      const sw = cargarSW('https://app.example', { '/sin-conexion': { redirected: true } })
      await expect(sw.instalar(), 'dio por buena una instalación sin shell').rejects.toThrow()
      expect(sw.cacheado, 'guardó la redirección bajo la clave del shell')
        .not.toContain('/sin-conexion')
    })

  it('ni una que no llega con éxito', async () => {
    const sw = cargarSW('https://app.example', { '/sin-conexion': { ok: false } })
    await expect(sw.instalar()).rejects.toThrow()
    expect(sw.cacheado).not.toContain('/sin-conexion')
  })

  // La sonda: si no guardara nunca nada, lo de arriba pasaría sin probar nada.
  it('la sonda: el shell que llega bien sí se guarda', async () => {
    const sw = cargarSW()
    await sw.instalar()
    expect(sw.cacheado, 'no guardó el shell: sin él no hay arranque en frío')
      .toContain('/sin-conexion')
  })

  it('y un icono roto no se lleva por delante al shell', async () => {
    const sw = cargarSW('https://app.example', { '/icon-192.png': { ok: false } })
    await sw.instalar()
    expect(sw.cacheado).toContain('/sin-conexion')
    expect(sw.cacheado).not.toContain('/icon-192.png')
  })
})

/**
 * L3 — El precacheado distingue lo que **falta** de lo que **sobra**.
 */
describe('L3 la instalación no se tira por un accesorio, y el shell tiene que ser el shell', () => {
  it('DoD 58: un icono cuyo fetch rechaza no impide instalar', async () => {
    const sw = cargarSW('https://app.example', { '/icon-192.png': { rechaza: true } })
    await expect(sw.instalar(), 'una red que se cae a mitad tiró la instalación entera')
      .resolves.toBeUndefined()
    expect(sw.cacheado).toContain('/sin-conexion')
  })

  it('DoD 59: un HTML que no es el shell no ocupa su clave', async () => {
    const sw = cargarSW('https://app.example', {
      // Un portal cautivo: 200, sin redirección, y su propia página.
      '/sin-conexion': { cuerpo: '<html><h1>Conéctate a la wifi del centro</h1></html>' },
    })
    await expect(sw.instalar()).rejects.toThrow()
    expect(sw.cacheado, 'se guardó el portal cautivo bajo la clave del shell')
      .not.toContain('/sin-conexion')
  })

  it('ni algo que no sea HTML', async () => {
    const sw = cargarSW('https://app.example', { '/sin-conexion': { tipo: 'application/json' } })
    await expect(sw.instalar()).rejects.toThrow()
    expect(sw.cacheado).not.toContain('/sin-conexion')
  })

  // La sonda: el shell de verdad —el que lleva su testigo— sí entra.
  it('la sonda: el shell con su marca se guarda y la instalación va bien', async () => {
    const sw = cargarSW()
    await expect(sw.instalar()).resolves.toBeUndefined()
    expect(sw.cacheado).toContain('/sin-conexion')
  })
})

/**
 * M2 / DoD 65 — Los recursos del shell **son** el shell. Tragarse su fallo daba
 * por buena una instalación que sirve el documento y no hidrata: la franja de
 * «sin conexión» sin la lista debajo y sin el aviso de que no la hay. Como el
 * service worker no reinstala, eso duraba hasta el siguiente despliegue.
 */
describe('M2 un shell sin sus recursos no es una instalación buena', () => {
  const conChunk = '<html><p data-testid="sin-red">x</p>'
    + '<script src="/_next/static/chunks/pagina.js"></script></html>'

  it('DoD 65: si el chunk del shell no se puede guardar, la instalación falla', async () => {
    const sw = cargarSW('https://app.example', {
      '/sin-conexion': { cuerpo: conChunk },
      '/_next/static/chunks/pagina.js': { rechaza: true },
    })
    await expect(sw.instalar(), 'se dio por buena una instalación que no hidrata')
      .rejects.toThrow()
  })

  // La sonda: con sus recursos enteros, la instalación va bien y los guarda.
  it('la sonda: con el chunk disponible, instala y lo guarda', async () => {
    const sw = cargarSW('https://app.example', { '/sin-conexion': { cuerpo: conChunk } })
    await expect(sw.instalar()).resolves.toBeUndefined()
    expect(sw.cacheado).toContain('/_next/static/chunks/pagina.js')
  })
})

/**
 * M4 — Lo que la propia iteración 6 abrió al cerrar, medido por la revisión: al
 * hacer que la instalación **falle**, el intento fallido dejaba el shell ya
 * guardado; y el reintento del día siguiente, bajo un portal cautivo, sólo pedía
 * lo que faltaba —los chunks— y guardaba el HTML del portal bajo la clave de cada
 * uno. Como los estáticos se sirven de caché sin revalidar, el dispositivo se
 * quedaba con una app que no arranca ni con red ni sin ella: estrictamente peor
 * que el síntoma que M2 vino a arreglar.
 */
describe('M4 una instalación a medias no deja nada escrito', () => {
  const conChunk = '<html><p data-testid="sin-red">x</p>'
    + '<script src="/_next/static/chunks/pagina.js"></script></html>'

  it('DoD 66: si la instalación falla, la caché de esta versión se borra', async () => {
    const sw = cargarSW('https://app.example', {
      '/sin-conexion': { cuerpo: conChunk },
      '/_next/static/chunks/pagina.js': { rechaza: true },
    })
    await expect(sw.instalar()).rejects.toThrow()
    expect(sw.borradas, 'el intento fallido dejó la caché a medias: el siguiente la reutiliza')
      .toContain(VERSION_EN_BANCO)
  })

  it('DoD 67: un chunk que vuelve como HTML —un portal cautivo— no se guarda', async () => {
    const sw = cargarSW('https://app.example', {
      '/sin-conexion': { cuerpo: conChunk },
      '/_next/static/chunks/pagina.js': { tipo: 'text/html', cuerpo: '<html>Conéctate</html>' },
    })
    await expect(sw.instalar(), 'se guardó el HTML de un portal bajo la clave de un chunk')
      .rejects.toThrow()
    expect(sw.cacheado).not.toContain('/_next/static/chunks/pagina.js')
  })

  it('y un icono servido por el portal tampoco, aunque no tire la instalación', async () => {
    const sw = cargarSW('https://app.example', {
      '/sin-conexion': { cuerpo: conChunk },
      '/icon-192.png': { tipo: 'text/html', cuerpo: '<html>Conéctate</html>' },
    })
    await expect(sw.instalar()).resolves.toBeUndefined()
    expect(sw.cacheado).not.toContain('/icon-192.png')
    expect(sw.cacheado, 'el icono se llevó por delante al shell').toContain('/sin-conexion')
  })

  // La sonda: una instalación buena no borra nada y guarda las tres cosas.
  it('la sonda: la instalación que va bien guarda shell, iconos y chunks', async () => {
    const sw = cargarSW('https://app.example', { '/sin-conexion': { cuerpo: conChunk } })
    await expect(sw.instalar()).resolves.toBeUndefined()
    expect(sw.cacheado).toEqual(expect.arrayContaining(
      ['/sin-conexion', '/icon-192.png', '/icon-512.png', '/_next/static/chunks/pagina.js']))
    expect(sw.borradas, 'borró la caché de una instalación que fue bien').toEqual([])
  })
})

/**
 * Spec C / DoD 11 — La sonda del sondeo **tiene que salir a la red**.
 *
 * La cáscara comprueba si volvió la conexión sondeando `location.href` con
 * `{cache:'no-store'}` — dentro de un grupo, `/g/<uuid>`.
 * Si el worker la respondiera de caché, acertaría siempre estando sin red: la
 * cáscara recargaría, la navegación volvería a caer en la cáscara, y sería un
 * **bucle de recargas** que además martillearía el disco cada pocos segundos.
 *
 * Se ataca el fuente real del worker, que es la capa donde vive la decisión
 * (§E.1). La otra mitad —que en un Chrome de verdad tampoco se sirva de caché—
 * se comprueba en el navegador, porque aquí el `mode` lo pone la prueba.
 *
 * Qué lo pone rojo (§E.3): meter `/` entre los estáticos, o responder a todo.
 */
describe('Spec C la sonda de la cáscara no la responde el worker', () => {
  /**
   * Iteración 3 — Se pregunta con la **forma real** de la sonda: la cáscara
   * sondea `location.href`, que dentro de un grupo es `/g/<uuid>`. La versión
   * anterior preguntaba por `/` y por eso no cazaba lo que importa: metiendo
   * `/g/` en `esEstatico` el worker respondería la sonda de caché —bucle de
   * recargas— **y** guardaría el documento del grupo, que es §A.1.
   */
  it('un fetch a la URL del grupo en modo cors pasa de largo', () => {
    const sw = cargarSW()
    expect(sw.pide('https://app.example/g/8f1f1f7a-0000-4000-8000-000000000000', 'cors'),
      'el worker respondió la sonda: sondear sin red acertaría siempre').toBe(false)
  })

  // Sonda (§E.2): sin ella, un worker que no respondiera a NADA pasaría la de
  // arriba, y con él no habría ni modo sin red ni estáticos cacheados.
  it('pero sí responde lo que debe: la navegación y el estático', () => {
    const sw = cargarSW()
    expect(sw.pide('https://app.example/g/123', 'navigate'),
      'dejó de servir el documento: no hay modo sin red').toBe(true)
    expect(sw.pide('https://app.example/_next/static/chunks/a.js', 'cors'),
      'dejó de servir el estático: el shell no hidrata').toBe(true)
  })
})

describe('Spec I / I-R4 · la versión del worker viene del build, no de este fichero', () => {
  /**
   * Deuda 31. `VERSION` era `'super-v2'`, un literal escrito a mano, y `sw.js` no se regenera: sus
   * bytes eran **idénticos entre despliegues**. El navegador no reinstala si los bytes no cambian,
   * y `activate` sólo purga cachés `super-*` distintas de la actual — que nunca las hay. Resultado
   * medido y escrito en la deuda: el shell se congela en el build de la primera instalación.
   *
   * Lo que pone roja esta fila: que alguien devuelva un literal a `sw.js`.
   */
  it('i6: `sw.js` no lleva ninguna versión escrita a mano', () => {
    const fuente = readFileSync('public/sw.js', 'utf8')
    /**
     * Se busca la **forma de una asignación**, no el literal suelto. La primera versión buscaba
     * `'super-vN'` en cualquier parte y se puso roja sobre el comentario que explica el arreglo, que
     * cita el valor viejo a propósito: una guarda que no distingue código de prosa es la que «detecta
     * todo», y ésas se acaban desactivando.
     */
    // i1-R10 — las tres formas de escribir un literal, no sólo la de comillas simples. Medido por
    // la revisión: `"super-v3"` y las comillas graves pasaban por delante de la guarda.
    const asignaciones = fuente.match(/VERSION\s*=\s*['"`]super-[^'"`]*['"`]/g) ?? []
    expect(asignaciones, 'hay una versión escrita a mano: los bytes no cambiarán entre despliegues')
      .toEqual([])
    expect(fuente, 'la versión no se toma del generado').toContain("importScripts('/sw-version.js')")
  })

  it('i6 bis: el generado existe y su versión sale del commit', () => {
    const gen = readFileSync('public/sw-version.js', 'utf8')
    const m = gen.match(/self\.SW_VERSION = '([^']+)'/)
    expect(m, 'el generado no declara una versión').not.toBeNull()
    /**
     * §E.2 — Que exista no basta: tiene que **atarse al artefacto**. Se compara contra el sha que
     * el propio script usa, así que un generador que escribiera una constante pondría esto rojo.
     */
    let sha: string | null = null
    try { sha = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim() } catch { /* sin git */ }
    if (sha) {
      expect(m![1], 'la versión generada no corresponde al commit del árbol').toBe(`super-${sha}`)
    }
  })

  it('i7: la prosa de `sw.js` no afirma un mecanismo que no existe', () => {
    /**
     * Deuda 32. El comentario de la purga decía que un reintento «sólo pediría los recursos que
     * faltaban». `guardarRecurso` hace `fetch` siempre: no hay rama que salte lo cacheado. La fila
     * vigila las dos mitades — que la frase no vuelva, y que el mecanismo que sí cierra la cadena
     * (la comprobación de `content-type`) siga en pie.
     */
    const fuente = readFileSync('public/sw.js', 'utf8')
    expect(fuente, 'volvió la afirmación de que el reintento sólo pide lo que falta')
      .not.toMatch(/sólo pediría los recursos que\s+\*?\s*faltaban/)
    expect(fuente, 'desapareció la comprobación que sí cierra la cadena del portal cautivo')
      .toMatch(/text\/html/)
  })
})
