import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

/**
 * J6/J8 — La mitad del almacén que las funciones puras no cubren: qué contesta
 * `lib/local.ts` cuando el disco dice que no. Es la capa donde vive la promesa —
 * la vista sólo puede reaccionar a lo que ésta le devuelva— y hasta ahora nadie
 * la miraba: `encolar` se tragaba el fallo y devolvía lo mismo que un éxito.
 *
 * Se monta un IndexedDB de mentira porque jsdom no trae uno. Lo que se afirma no
 * es el almacén del navegador, es **el contrato de este módulo**: informar.
 */
type Req = { result?: unknown; onsuccess?: () => void; onerror?: () => void
  onupgradeneeded?: () => void }

/**
 * Spec iter2 / R6 — `alTerminar` se llama **justo después** del manejador, en su misma
 * vuelta. Antes la vida de una petición se contaba con aritmética de microtareas —dos
 * `queueMicrotask` anidados en el contador, uno aquí— y funcionaba sólo porque los
 * números cuadraban: un salto más aquí cerraba la transacción antes de la lectura, o sea
 * volvía a hacer inalcanzable la rama `ya-estaba` que R5 acababa de destapar. Ahora la
 * relación es causal y `saltos` existe para demostrarlo (ver la sonda de DoD 5/7).
 */
const disparar = (req: Req, como: 'ok' | 'error', result?: unknown,
  alTerminar?: () => void, saltos = 1) => {
  const correr = (quedan: number) => queueMicrotask(() => {
    if (quedan > 1) { correr(quedan - 1); return }
    if (como === 'error') req.onerror?.()
    else { req.result = result; req.onsuccess?.() }
    alTerminar?.()
  })
  correr(saltos)
  return req
}

type Tx = { oncomplete?: () => void; onerror?: () => void; onabort?: () => void }

/**
 * @param aperturas qué hace cada `open()`, en orden; la última se repite.
 * @param escritura 'error' aborta la **transacción**, que es como se manifiesta
 *   quedarse sin cuota: el `put` contesta bien y el disco dice que no después.
 */
function falso(aperturas: ('ok' | 'error')[], escritura: 'ok' | 'error' = 'ok',
  cerrada = false, saltos = 1) {
  let n = 0
  let vivas = 0
  /**
   * Una petición está viva hasta que **su manejador ha corrido**, y lo dice el propio
   * disparo (R6). Contarlo en microtareas era acoplarse a cuántos saltos usa `disparar`.
   */
  const viva = <T,>(hacer: (fin: () => void) => T): T => { vivas++; return hacer(() => { vivas-- }) }
  const tienda = {
    put: () => ({}), delete: () => ({}),
    get: () => viva(fin => disparar({}, 'ok', undefined, fin, saltos)),
    getAll: () => viva(fin => disparar({}, 'ok', [], fin, saltos)),
    getAllKeys: () => viva(fin => disparar({}, 'ok', [], fin, saltos)),
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      // K5 — Con la conexión ya cerrada, `transaction()` **lanza**. Es lo que
      // pasa tras una evicción de almacenamiento, y es lo que hacía rechazar a
      // las lecturas: nadie recogía ese rechazo.
      if (cerrada) throw new Error('InvalidStateError')
      const tx: Tx = {}
      /**
       * La transacción cierra cuando **no queda ninguna petición viva**, no al
       * crearse. Antes disparaba `oncomplete` en el microtask siguiente a
       * `transaction()`, o sea **antes** del `onsuccess` de cualquier lectura: en
       * los ocho casos de `encolar` la rama del re-chequeo era inalcanzable, y el
       * `put` ocurría después de completar — secuencia que en un navegador real
       * lanza `TransactionInactiveError`.
       *
       * Dos falsos de la misma API en la misma suite tienen que ordenar igual, y
       * el orden que vale es el que hace el navegador.
       */
      queueMicrotask(function cerrar() {
        if (vivas > 0) { queueMicrotask(cerrar); return }
        if (escritura === 'ok') tx.oncomplete?.()
        else tx.onabort?.()
      })
      return { ...tx, objectStore: () => tienda,
        set oncomplete(f: () => void) { tx.oncomplete = f },
        set onerror(f: () => void) { tx.onerror = f },
        set onabort(f: () => void) { tx.onabort = f } }
    },
  }
  return {
    get aperturas() { return n },
    open: () => {
      const como = aperturas[Math.min(n++, aperturas.length - 1)]
      return disparar({}, como, db)
    },
  }
}

const p = { id: 'p1', usuario: 'u1', grupo: 'g1', nombre: 'sal', cantidad: null, creado: 1 }

const cargar = async (idb: unknown) => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', idb)
  return import('@/lib/local')
}

beforeEach(() => vi.unstubAllGlobals())

describe('J6 una escritura que el almacén rechaza se informa', () => {
  it('DoD 42 (módulo): si la transacción aborta —sin cuota—, `encolar` devuelve false', async () => {
    const { encolar } = await cargar(falso(['ok'], 'error'))
    expect(await encolar(p), 'un rechazo del disco pasó por éxito').toBe('rechazado')
  })

  it('y si el almacén no abre siquiera, también', async () => {
    const { encolar } = await cargar(falso(['error']))
    expect(await encolar(p)).toBe('rechazado')
  })

  // La sonda: si devolviera `false` siempre, lo de arriba no probaría nada.
  it('la sonda: una escritura que entra devuelve true', async () => {
    const { encolar } = await cargar(falso(['ok']))
    expect(await encolar(p)).toBe('entro')
  })

  it('y sin IndexedDB en la plataforma no se rompe: devuelve false', async () => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', undefined)
    const { encolar } = await import('@/lib/local')
    expect(await encolar(p)).toBe('rechazado')
  })
})

/**
 * J8 — Un fallo de apertura no se cachea. Cachearlo convertía un error pasajero
 * —el disco ocupado, una pestaña con la base bloqueada— en un almacén muerto
 * durante el resto de la vida de la pestaña: nada más se encolaría nunca.
 */
describe('J8 una apertura fallida no deja el almacén muerto', () => {
  it('el siguiente intento vuelve a abrir, y funciona', async () => {
    const idb = falso(['error', 'ok'])
    const { encolar } = await cargar(idb)
    expect(await encolar(p), 'el primer intento debía fallar').toBe('rechazado')
    expect(await encolar(p), 'el fallo quedó cacheado: el almacén murió').toBe('entro')
    expect(idb.aperturas, 'no reintentó la apertura').toBe(2)
  })

  it('y una apertura buena sí se reutiliza: no se abre una vez por operación', async () => {
    const idb = falso(['ok'])
    const { encolar } = await cargar(idb)
    await encolar(p); await encolar(p); await encolar(p)
    expect(idb.aperturas, 'una apertura por operación en un móvil en frío').toBe(1)
  })
})

/**
 * K5 — El almacén informa, no rompe. Con la conexión cerrada las escrituras ya
 * degradaban y las lecturas **rechazaban**: y como todos los llamadores están
 * dentro de un `void (async …)`, ese rechazo no lo recogía nadie — el shell se
 * quedaba en blanco antes de decir siquiera que hacía falta conexión.
 */
describe('K5 una lectura con la conexión cerrada no rompe', () => {
  it('DoD 51: `leerCola` devuelve vacío en vez de rechazar', async () => {
    const { leerCola } = await cargar(falso(['ok'], 'ok', true))
    await expect(leerCola('u1'), 'la lectura rechazó: nadie recoge eso').resolves.toEqual([])
  })

  it('y `leerLista` y `leerUltimoUsuario`, igual', async () => {
    const m = await cargar(falso(['ok'], 'ok', true))
    await expect(m.leerLista('u1', 'g1')).resolves.toBeNull()
    await expect(m.leerUltimoUsuario()).resolves.toBeNull()
  })

  it('y la escritura sigue diciendo que no', async () => {
    const { encolar } = await cargar(falso(['ok'], 'ok', true))
    await expect(encolar(p)).resolves.toBe('rechazado')
  })

  // La sonda: con la conexión viva, las mismas lecturas traen lo que hay.
  it('la sonda: con la conexión abierta se lee de verdad', async () => {
    const m = await cargar(falso(['ok']))
    await expect(m.leerCola('u1')).resolves.toEqual([])
    await expect(m.encolar(p)).resolves.toBe('entro')
  })
})

/**
 * L2 / DoD 56 — `indexedDB.open()` **lanza**, además de poder emitir `onerror`:
 * en modo privado, o con el almacenamiento denegado por política. K5 tapó la
 * transacción y dejó la apertura, y como todo el módulo cuelga de `abrir()`, las
 * seis funciones rechazaban a la vez.
 */
describe('L2 un almacén que ni se puede abrir tampoco rompe', () => {
  const queLanza = { open: () => { throw new Error('SecurityError') } }

  it('DoD 56: las seis funciones devuelven vacío en vez de rechazar', async () => {
    const m = await cargar(queLanza)
    await expect(m.leerCola('u1'), 'leerCola rechazó').resolves.toEqual([])
    await expect(m.leerLista('u1', 'g1')).resolves.toBeNull()
    await expect(m.leerUltimoUsuario()).resolves.toBeNull()
    await expect(m.encolar(p)).resolves.toBe('rechazado')
    await expect(m.guardarUltimoUsuario('u1')).resolves.toBe(false)
    await expect(m.olvidarTodo('u1'), 'olvidarTodo rechazó: «Salir» se queda colgado')
      .resolves.toBeUndefined()
  })

  // La sonda: con un almacén que abre, las mismas seis hacen su trabajo.
  it('la sonda: con el almacén abierto, escribir y leer funcionan', async () => {
    const m = await cargar(falso(['ok']))
    await expect(m.encolar(p)).resolves.toBe('entro')
    await expect(m.olvidarTodo('u1')).resolves.toBeUndefined()
  })
})

/**
 * Spec C / R5 y D3 — El nombre del grupo entra en la instantánea, y **tiene que
 * irse con ella**.
 *
 * `olvidarTodo` borra las claves que empiezan por `${usuario}:`. Una clave
 * `nombre:u1:g1` **sobreviviría al cierre de sesión**, y el siguiente que entrase
 * en el mismo dispositivo vería el nombre del grupo del anterior: §A.1, la misma
 * regla que costó retirar el cacheo del documento.
 *
 * Se ejercita **el predicado real**, no una copia: una copia al lado pasa en
 * verde mientras el de verdad se queda atrás (§E.2).
 *
 * Qué lo pone rojo (§E.3): mover el nombre a una clave fuera del prefijo.
 */
describe('Spec C · el nombre del grupo se borra al salir, como la lista', () => {
  it('la clave del nombre cae dentro de lo que olvidarTodo barre', async () => {
    const { claveDelNombre, esClaveDe } = await import('@/lib/local')
    expect(esClaveDe('u1', claveDelNombre('u1', 'g1')),
      'el nombre sobreviviría al cierre de sesión: A.1').toBe(true)
  })

  it('y la de otro usuario no', async () => {
    const { claveDelNombre, esClaveDe } = await import('@/lib/local')
    expect(esClaveDe('u1', claveDelNombre('u2', 'g1')),
      'borraría la clave de otro usuario').toBe(false)
  })

  // Sonda (§E.2): sin esto, un `esClaveDe` que devolviera siempre `true` pasaría
  // las dos de arriba y borraría el almacén entero.
  it('el predicado distingue: barre lo del usuario y la marca, nada más', async () => {
    const { esClaveDe } = await import('@/lib/local')
    expect(esClaveDe('u1', 'u1:g1')).toBe(true)
    expect(esClaveDe('u1', 'ultimo-usuario')).toBe(true)
    expect(esClaveDe('u1', 'u2:g1')).toBe(false)
    expect(esClaveDe('u1', 'otra-cosa')).toBe(false)
  })
})

/**
 * Spec C / iteración 2 / DoD 13 — `olvidarTodo`, conducido de verdad.
 *
 * La sonda de más arriba ejercita `esClaveDe`, que es la mitad correcta; pero
 * nadie llevaba `olvidarTodo` contra un almacén y comprobaba que la clave del
 * nombre **desaparece**. Una guarda a una indirección de distancia cubre la copia
 * y deja suelta la otra: si mañana alguien deja de llamar al predicado, el nombre
 * del grupo del anterior sobrevive al cierre de sesión. Es §A.1.
 *
 * Qué lo pone rojo (§E.3): sacar la clave del prefijo del usuario, o dejar de
 * filtrar con `esClaveDe`.
 */
describe('Spec C · cerrar sesión se lleva también el nombre del grupo', () => {
  const conClaves = (claves: string[]) => {
    const borradas: string[] = []
    const tienda = {
      put: () => ({}),
      delete: (k: string) => { borradas.push(k); return {} },
      get: () => disparar({}, 'ok', undefined),
      getAll: () => disparar({}, 'ok', []),
      getAllKeys: () => disparar({}, 'ok', claves),
    }
    const db = {
      objectStoreNames: { contains: () => true },
      transaction: () => {
        const tx: Tx = {}
        queueMicrotask(() => tx.oncomplete?.())
        return { ...tx, objectStore: () => tienda,
          set oncomplete(f: () => void) { tx.oncomplete = f },
          set onerror(f: () => void) { tx.onerror = f },
          set onabort(f: () => void) { tx.onabort = f } }
      },
    }
    return { idb: { open: () => disparar({}, 'ok', db) }, borradas }
  }

  it('borra la instantánea y el nombre del usuario que sale', async () => {
    const { idb, borradas } = conClaves(['u1:g1', 'u1:g1:nombre', 'ultimo-usuario'])
    const { olvidarTodo } = await cargar(idb)
    await olvidarTodo('u1')
    expect(borradas, 'el nombre del grupo sobrevivió al cierre de sesión: A.1')
      .toContain('u1:g1:nombre')
    expect(borradas).toContain('u1:g1')
  })

  // Sonda (§E.2): sin ella, un `olvidarTodo` que borrara el almacén entero
  // pasaría la de arriba y se llevaría por delante la cola de otro usuario.
  it('y no toca lo de otro usuario', async () => {
    const { idb, borradas } = conClaves(['u1:g1:nombre', 'u2:g9:nombre', 'u2:g9'])
    const { olvidarTodo } = await cargar(idb)
    await olvidarTodo('u1')
    expect(borradas).toContain('u1:g1:nombre')
    expect(borradas, 'se llevó por delante lo de otro usuario').not.toContain('u2:g9:nombre')
    expect(borradas).not.toContain('u2:g9')
  })
})

/**
 * Spec «pantalla y estado durable» / R2 — **El almacén publica.** La cola la
 * comparten todas las instancias y IndexedDB no emite eventos de cambio, así que
 * quien escribe tiene que decirlo. Va aquí y no en cada vista por una medida: los
 * cuatro escritores de la cola pasan por estas dos funciones, y este módulo es el
 * único que toca la tienda. Publicando aquí, un escritor nuevo no puede olvidarse.
 *
 * Capa (§E.1): el requisito habla del almacén, así que se ataca el almacén.
 */
describe('R2 el almacén avisa de lo que escribe en la cola', () => {
  const conCanal = async (idb: unknown) => {
    const oidos: unknown[] = []
    class CanalFalso {
      onmessage: ((e: { data: unknown }) => void) | null = null
      constructor(public nombre: string) { canales.push(this) }
      postMessage(d: unknown) { oidos.push({ canal: this.nombre, dato: d }) }
      // Un canal cerrado no entrega: modelarlo es lo que hace observable que
      // alguien se suelte, y sin eso el test de soltarse no podría fallar.
      close() { this.onmessage = null }
    }
    const canales: CanalFalso[] = []
    vi.stubGlobal('BroadcastChannel', CanalFalso)
    const mod = await cargar(idb)
    return { mod, oidos, canales }
  }

  it('encolar avisa después de escribir', async () => {
    const { mod, oidos } = await conCanal(falso(['ok']))
    expect(await mod.encolar(p), 'la escritura no entró').toBe('entro')
    expect(oidos, 'escribió en la cola y no lo dijo: otra pestaña no puede enterarse')
      .toHaveLength(1)
  })

  it('quitarDeCola avisa después de escribir', async () => {
    const { mod, oidos } = await conCanal(falso(['ok']))
    expect(await mod.quitarDeCola('p1')).toBe(true)
    expect(oidos).toHaveLength(1)
  })

  // Sonda (§E.2) — si la escritura no entra, no hay nada que anunciar: avisar de
  // un cambio que no ocurrió haría releer a las demás para encontrar lo mismo, y
  // peor, les diría que algo pasó cuando no pasó.
  it('una escritura que el disco rechaza NO avisa', async () => {
    const { mod, oidos } = await conCanal(falso(['ok'], 'error'))
    expect(await mod.encolar(p), 'el doble no está rechazando').toBe('rechazado')
    expect(oidos, 'anunció un cambio que no llegó al disco').toHaveLength(0)
  })

  // Escribir no puede depender del canal: un navegador sin `BroadcastChannel`
  // pierde la notificación, que es el estado de hoy, no uno peor.
  it('sin BroadcastChannel se escribe igual', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const mod = await cargar(falso(['ok']))
    expect(await mod.encolar(p), 'la falta de canal se llevó la escritura').toBe('entro')
  })

  it('alCambiarLaCola avisa a quien escucha', async () => {
    const { mod, canales } = await conCanal(falso(['ok']))
    let oidas = 0
    mod.alCambiarLaCola(() => { oidas++ })
    canales[canales.length - 1].onmessage?.({ data: 1 })
    expect(oidas, 'la vista no se entera de nada').toBe(1)
  })

  // La cicatriz N3 con otro traje: un oyente que sobrevive al desmontaje sigue
  // trabajando sobre un árbol muerto. Quien se suscribe recibe cómo soltarse.
  it('y deja de avisar cuando se suelta', async () => {
    const { mod, canales } = await conCanal(falso(['ok']))
    let oidas = 0
    const soltar = mod.alCambiarLaCola(() => { oidas++ })
    const c = canales[canales.length - 1]
    soltar()
    c.onmessage?.({ data: 1 })
    expect(oidas, 'sigue escuchando después de soltarse').toBe(0)
  })

  // Las demás tiendas no son compartidas de esta forma: la instantánea y el nombre
  // los reescribe su propia vista, y anunciarlos sería ruido que hace releer.
  it('guardarLista no avisa: la cola es lo compartido', async () => {
    const { mod, oidos } = await conCanal(falso(['ok']))
    expect(await mod.guardarLista('u1', 'g1', [])).toBe(true)
    expect(oidos).toHaveLength(0)
  })
})

/**
 * Spec «pantalla y estado durable» / R2, la parte estructural — **un escritor de la
 * cola que no publique no puede existir.** Es la diferencia entre una convención
 * que hay que recordar en cada sitio nuevo y una consecuencia de dónde vive el
 * canal, y es lo que la spec eligió: publicar desde el almacén y no desde la vista.
 *
 * Capa (§E.1): el requisito habla del módulo, así que se lee el módulo. No hay
 * instrumento más fino — un test de comportamiento sólo vería los escritores que
 * hoy existen, y lo que se afirma es sobre los que alguien escriba mañana.
 */
/**
 * Spec iter2 / R3 y R4 — **El lector de puertas al almacén, y por qué es un parser.**
 *
 * Tercer intento, y los dos anteriores están medidos. El primero perseguía formas
 * (`escribir(COLA, …)`): cazaba **2 de 7**. El segundo inventariaba las líneas que
 * mencionan la tienda: subió a 7 de 7 y parecía resuelto — pero la revisión le encontró
 * **cuatro escapes más**, y los tres primeros compilan y pasan lint, porque
 * `eslint.config.mjs` no trae regla `quotes`:
 *
 * - la plantilla `` escribir(`cola`, …) ``
 * - las comillas dobles `escribir("cola", …)`
 * - la concatenación `escribir('co' + 'la', …)`
 * - y **la coartada**: el filtro `!/VIDA_COLA_MS/` borraba *cualquier línea* con ese
 *   token, así que `escribir(COLA, …) // VIDA_COLA_MS` era invisible. Medido aparte: ese
 *   filtro **no excluía nada** —`/\bCOLA\b/` no casa dentro de `VIDA_COLA_MS`, porque el
 *   `_` es carácter de palabra y no hay frontera—. Era una puerta sin cerradura.
 *
 * Ninguna de esas cuatro la puede cerrar un escaneo de líneas: `'co' + 'la'` exige
 * **plegar** la expresión y `const Q = COLA` exige **resolver** el nombre. Es lo que la
 * constitución ya dice —una afirmación de ausencia no se comprueba con `grep`, se
 * comprueba con el instrumento del lenguaje— aplicado por fin a este fichero.
 *
 * Así que se lee el módulo con el compilador: se resuelven las constantes de cadena
 * (con punto fijo, para los alias), se pliegan las sumas de literales, y se acepta
 * cualquier estilo de comilla. Y de paso el instrumento contesta las **dos** preguntas
 * —qué escribe en la cola sin anunciar (R3) y cuántos sitios escriben en `LISTAS` (R4)—,
 * que antes eran dos patrones distintos con el mismo defecto.
 *
 * Capa (§E.1): el requisito habla de los escritores que alguien escriba mañana, así que
 * se lee el módulo, no su comportamiento de hoy.
 */
type Sitio = { tienda: string; escribe: boolean; fn: string; anuncia: boolean }

/** Puertas al almacén, y en qué argumento viaja el nombre de la tienda. */
const PUERTAS: Record<string, number> = {
  escribir: 0, conTienda: 0, transaction: 0, objectStore: 0,
}

function puertas(codigo: string): Sitio[] {
  const sf = ts.createSourceFile('local.ts', codigo, ts.ScriptTarget.Latest, true)
  const constantes = new Map<string, string>()
  const textoDe = (n: ts.Node): string | null => {
    if (ts.isStringLiteralLike(n)) return n.text
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const i = textoDe(n.left), d = textoDe(n.right)
      return i !== null && d !== null ? i + d : null
    }
    if (ts.isIdentifier(n)) return constantes.get(n.text) ?? null
    return null
  }
  // Punto fijo: `const Q = COLA` sólo resuelve cuando COLA ya está, y el orden del
  // fichero no se puede dar por supuesto.
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const ver = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const v = textoDe(n.initializer)
        if (v !== null) constantes.set(n.name.text, v)
      }
      ts.forEachChild(n, ver)
    }
    ver(sf)
  }
  /**
   * La etiqueta se busca desde la **función** que envuelve, no desde la llamada: desde
   * la llamada, el `const ok = await escribir(COLA, …)` de `encolar` gana y el sitio
   * sale llamándose «ok». Lo cazó la sonda de este mismo describe en su primera corrida.
   */
  const etiqueta = (f: ts.Node | undefined): string => {
    for (let a = f; a; a = a.parent) {
      if (ts.isFunctionDeclaration(a) && a.name) return a.name.text
      if (ts.isMethodDeclaration(a) && ts.isIdentifier(a.name)) return a.name.text
      if (ts.isVariableDeclaration(a) && ts.isIdentifier(a.name)) return a.name.text
    }
    return '(anónima)'
  }
  const sitios: Sitio[] = []
  const ver2 = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const llamada = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
        : ts.isIdentifier(n.expression) ? n.expression.text : ''
      const idx = PUERTAS[llamada]
      if (idx !== undefined && n.arguments[idx]) {
        const tienda = textoDe(n.arguments[idx])
        if (tienda !== null) {
          // Sólo cuenta como lectura la que lo declara. Todo lo demás se trata como
          // escritura: fallar cerrado (§A.3) también vale para una guarda.
          const arg1 = n.arguments[1]
          const modo = arg1 && ts.isStringLiteralLike(arg1) ? arg1.text : null
          // La función que envuelve la llamada; el callback que recibe es hijo, no
          // ancestro, así que `avisarDeLaCola` se busca donde de verdad tendría que estar.
          let f: ts.Node | undefined = n.parent
          while (f && !ts.isFunctionDeclaration(f) && !ts.isArrowFunction(f)
            && !ts.isFunctionExpression(f) && !ts.isMethodDeclaration(f)) f = f.parent
          sitios.push({
            tienda, escribe: modo !== 'readonly', fn: etiqueta(f),
            anuncia: (f ?? sf).getText(sf).includes('avisarDeLaCola'),
          })
        }
      }
    }
    ts.forEachChild(n, ver2)
  }
  ver2(sf)
  return sitios
}

/**
 * R3 / DoD 3 — **`escribir` sigue devolviendo lo mismo para los cinco usos de
 * `LISTAS`.** El ítem se declaró PARCIAL en la vuelta anterior con un motivo que no se
 * sostenía: que probarlo exigiría leer el fichero. Es falso — la propiedad es de
 * comportamiento y su capa es el almacén.
 *
 * Y el argumento de respaldo tampoco valía: el compilador prueba la **firma**, no la
 * semántica. `tx.onabort = () => resolve(true)` compila, y hasta ahora ningún escritor
 * de `LISTAS` se afirmaba contra un abort: de los cinco, sólo dos tenían aserción de
 * retorno y ninguno contra el disco diciendo que no.
 */
/**
 * DoD 5 — **El falso ordena como el navegador.** Antes disparaba `oncomplete` al
 * crear la transacción, o sea antes del `onsuccess` de cualquier lectura: los ocho
 * casos de `encolar` de este fichero no llegaban a ejercitar el re-chequeo, y el
 * `put` caía después de completar — secuencia que en un navegador real lanza
 * `TransactionInactiveError`.
 *
 * Esto vigila el arnés, no el producto, y por eso está escrito: dos falsos de la
 * misma API en la misma suite tienen que ordenar igual, y el orden que vale es el
 * del navegador.
 */
describe('DoD 5 el falso mantiene viva la transacción mientras haya peticiones', () => {
  /**
   * iter2 / DoD 7 — **Y con un salto de más en `disparar`.** Con la vida contada en
   * microtareas, `saltos: 3` cerraba la transacción antes de que la lectura contestara y
   * la rama del re-chequeo volvía a ser inalcanzable sin que nada se pusiera rojo. Que el
   * caso corra con 1 y con 3 es lo que convierte «es causal» en una medida.
   */
  it.each([1, 3])('un put desde el onsuccess de un getAll entra antes de completar (%i salto(s))', async (saltos) => {
    vi.stubGlobal('indexedDB', falso(['ok'], 'ok', false, saltos))
    const orden: string[] = []
    const db = await new Promise<IDBDatabase>(res => {
      const q = indexedDB.open('x', 1) as unknown as { onsuccess?: () => void; result: IDBDatabase }
      queueMicrotask(() => { q.onsuccess?.(); res(q.result) })
    })
    await new Promise<void>(res => {
      const tx = db.transaction('cola', 'readwrite')
      tx.oncomplete = () => { orden.push('completa'); res() }
      const t = tx.objectStore('cola')
      const q = t.getAll()
      ;(q as unknown as { onsuccess?: () => void }).onsuccess = () => {
        orden.push('leyó'); t.put({ id: '1' } as never); orden.push('escribió')
      }
    })
    expect(orden, 'la transacción cerró antes de que la lectura contestara: el re-chequeo es inalcanzable')
      .toEqual(['leyó', 'escribió', 'completa'])
  })
})

describe('R3 los escritores de LISTAS informan igual', () => {
  const p2 = { id: 'p2', usuario: 'u1', grupo: 'g1', nombre: 'sal', cantidad: null, creado: 1 }
  const escritores = (m: typeof import('@/lib/local')) => [
    ['guardarLista', () => m.guardarLista('u1', 'g1', [])],
    ['guardarNombre', () => m.guardarNombre('u1', 'g1', 'Familia')],
    ['guardarUltimoUsuario', () => m.guardarUltimoUsuario('u1')],
    ['olvidarUltimoUsuario', () => m.olvidarUltimoUsuario()],
    ['encolar (la cola, para contraste)', () => m.encolar(p2)],
  ] as const

  /**
   * **La spec dijo «los cinco» y midió mal: son cinco sitios, pero sólo cuatro
   * devuelven el resultado a alguien.** El quinto es el `delete` de dentro de
   * `olvidarTodo`, y esa función **descarta** lo que `escribir` le contesta
   * (`Promise<void>`), así que su retorno es inobservable por construcción: hacer
   * que `escribir` resolviera `true` en `onabort` no cambiaría nada que un test
   * pueda ver desde fuera de ese sitio. Lo que sí se puede probar de él es su
   * **efecto**, y está probado donde hay un falso que guarda de verdad —
   * `unit/duplicado.test.tsx`, «olvidarTodo se lleva también la lista y el nombre».
   *
   * Y para que «cinco» no vuelva a ser prosa: se cuentan los sitios en la fuente.
   * Un sexto pone esto rojo y obliga a decir cuál de los dos casos le toca.
   */
  /**
   * R4 (iter2) — El recuento lo hace el **mismo lector** que la guarda de la cola, no un
   * regex sobre la forma de la llamada. Medido: `escribir(LISTAS,` dejaba pasar tres
   * formas —salto de línea tras `escribir(`, alias `const L2 = LISTAS`, y un espacio
   * antes de la coma—, o sea que reintroducía en este fichero, doce líneas más arriba, la
   * lección que la guarda de la cola acababa de aprender.
   */
  it('hay exactamente cinco sitios que escriben en LISTAS, y cuatro informan', () => {
    const escriben = puertas(readFileSync('lib/local.ts', 'utf8'))
      .filter(x => x.tienda === 'listas' && x.escribe)
    expect(escriben.length,
      'cambió el número de escrituras a LISTAS: di si informa o si descarta como olvidarTodo')
      .toBe(5)
  })

  // Sonda (§E.2) de las tres formas que al patrón se le escapaban.
  it.each([
    ['salto de línea tras escribir(', "\nexport const w1 = (k: string) => escribir(\n  LISTAS, (t: IDBObjectStore) => { t.delete(k) })\n"],
    ['alias de la constante', "\nconst L2 = LISTAS\nexport const w2 = (k: string) => escribir(L2, (t: IDBObjectStore) => { t.delete(k) })\n"],
    ['espacio antes de la coma', "\nexport const w3 = (k: string) => escribir(LISTAS , (t: IDBObjectStore) => { t.delete(k) })\n"],
  ])('el recuento ve un escritor nuevo escrito como: %s', (_n, siembra) => {
    const escriben = puertas(readFileSync('lib/local.ts', 'utf8') + siembra)
      .filter(x => x.tienda === 'listas' && x.escribe)
    expect(escriben.length, 'el escritor nuevo no movió el recuento').toBe(6)
  })

  it('con el disco bueno, los cuatro de LISTAS dicen que sí', async () => {
    const m = await cargar(falso(['ok']))
    for (const [nombre, hacer] of escritores(m).slice(0, 4)) {
      expect(await hacer(), `${nombre} no informó de una escritura que entró`).toBe(true)
    }
  })

  it('y con la transacción abortando, dicen que no', async () => {
    const m = await cargar(falso(['ok'], 'error'))
    for (const [nombre, hacer] of escritores(m).slice(0, 4)) {
      expect(await hacer(), `${nombre} dio por buena una escritura que el disco rechazó`).toBe(false)
    }
  })

  // Sonda (§E.2): el de la cola usa el mismo `escribir` y su contrato es OTRO —
  // tres valores, no dos—. Si alguien unificara los dos, esto lo dice.
  it('el de la cola informa con su propio contrato, no con el de LISTAS', async () => {
    const m = await cargar(falso(['ok'], 'error'))
    expect(await m.encolar(p2), 'el contrato de la cola se fundió con el de LISTAS').toBe('rechazado')
  })
})

/**
 * **Lo que esta guarda comprueba, y lo que NO** — acotado a propósito, y por una razón
 * medida: son ya **tres** instrumentos sobre el mismo enunciado universal —patrón,
 * inventario de líneas, y este lector— y los tres se quedaron cortos, cada uno por menos.
 * La afirmación «ninguna forma de escribir en la cola se salta el aviso» es universal y
 * cualquier instrumento es particular, así que perseguir la forma siguiente es una carrera
 * que el que escribe código gana siempre. Un guarda que promete lo que cubre vale más que
 * uno que promete el universo y se lo cree (deuda 56, decidida el 2026-09-17).
 *
 * **Comprueba:** toda llamada directa a `escribir`, `conTienda`, `db.transaction` o
 * `tx.objectStore` cuyo nombre de tienda resuelva a `'cola'` —por la constante, por un
 * alias, por cualquier comilla, o por una suma de literales— llama a `avisarDeLaCola`
 * desde la función que la envuelve. Once formas sembradas lo demuestran.
 *
 * **NO comprueba, medido, no supuesto:**
 * - **Comentarios y cadenas.** El aviso se busca como texto dentro de la función, así que
 *   un `/* … avisarDeLaCola … *\/` o un `const nota = '… avisarDeLaCola …'` en el cuerpo
 *   la dan por anunciada. (Deuda 57.1; el arreglo es resolverlo por AST.)
 * - **La indirección.** Un solo salto —`const guardar = (t, f) => escribir(t, f)` y luego
 *   `guardar(COLA, cb)`— deja al lector con cero sitios. (Deuda 57.2.)
 *
 * Quien añada un escritor de la cola por cualquiera de esos dos caminos **no** se va a
 * encontrar esto en rojo. Está escrito aquí para que lo sepa antes, y no después.
 */
describe('R3 las escrituras a la cola que este lector ve, anuncian', () => {
  const fuente = readFileSync('lib/local.ts', 'utf8')
  const mudas = (txt: string) =>
    puertas(txt).filter(x => x.tienda === 'cola' && x.escribe && !x.anuncia)

  // Sonda del propio lector: si no encontrara las puertas reales, lo de abajo pasaría
  // con cualquier fichero — incluido uno vacío.
  it('el lector encuentra las puertas reales del módulo', () => {
    const cola = puertas(fuente).filter(x => x.tienda === 'cola')
    expect(cola.map(x => `${x.fn}:${x.escribe ? 'escribe' : 'lee'}`).sort(),
      'el lector no ve las puertas de la cola: no puede guardar nada')
      .toEqual(['encolar:escribe', 'leerCola:lee', 'quitarDeCola:escribe'])
  })

  it('hoy ninguna escritura a la cola que el lector ve es muda', () => {
    expect(mudas(fuente).map(x => x.fn),
      'una escritura a la cola no anuncia: otra pestaña no puede enterarse').toEqual([])
  })

  // Sonda (§E.2) en las ONCE formas: las siete que la versión anterior cazaba más las
  // cuatro que la revisión le encontró. Probar sólo las que ya se cazan es la forma de
  // no enterarse.
  it.each([
    ['export const', "\nexport const vaciar = () => escribir(COLA, (t: IDBObjectStore) => { t.clear() })\n"],
    ['conTienda readwrite', "\nexport const v2 = () => conTienda<undefined>(COLA, 'readwrite', (t: IDBObjectStore) => t.clear())\n"],
    ['let', "\nlet v3 = () => escribir(COLA, (t: IDBObjectStore) => { t.clear() })\n"],
    ['async function', "\nasync function v4() { await escribir(COLA, (t: IDBObjectStore) => { t.clear() }) }\n"],
    ['transacción directa', "\nexport const v5 = () => { const tx = db.transaction(COLA, 'readwrite'); tx.objectStore(COLA).clear() }\n"],
    ['alias de la constante', "\nconst Q = COLA\nexport const v6 = () => escribir(Q, (t: IDBObjectStore) => { t.clear() })\n"],
    ['literal en vez de constante', "\nexport const v7 = () => escribir('cola', (t: IDBObjectStore) => { t.clear() })\n"],
    ['plantilla', "\nexport const v9 = () => escribir(`cola`, (t: IDBObjectStore) => { t.clear() })\n"],
    ['comillas dobles', "\nexport const v10 = () => escribir(\"cola\", (t: IDBObjectStore) => { t.clear() })\n"],
    ['coartada VIDA_COLA_MS en la misma línea', "\nexport const v11 = () => escribir(COLA, (t: IDBObjectStore) => { t.clear() }) // VIDA_COLA_MS\n"],
    ['concatenación', "\nexport const v12 = () => escribir('co' + 'la', (t: IDBObjectStore) => { t.clear() })\n"],
  ])('caza una escritura muda sembrada: %s', (_n, siembra) => {
    expect(mudas(fuente + siembra).length, 'la siembra pasó sin que nadie la notara')
      .toBeGreaterThan(0)
  })

  // Los negativos, dos: lo que NO debe ponerla roja. Sin ellos la guarda no distingue
  // «caza lo que toca» de «caza todo».
  it('una escritura a otra tienda no la pone roja', () => {
    const otra = "\nexport const v8 = () => escribir(LISTAS, (t: IDBObjectStore) => { t.clear() })\n"
    expect(mudas(fuente + otra)).toEqual([])
  })

  it('y una LECTURA de la cola tampoco, aunque no anuncie', () => {
    const lee = "\nexport const v13 = () => conTienda<number[]>(COLA, 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<number[]>)\n"
    expect(mudas(fuente + lee), 'marcó una lectura: anunciar una lectura sería mentir').toEqual([])
  })
})
