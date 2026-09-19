import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
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
/**
 * `filas` se añadió para la Spec E: hasta entonces `getAll` devolvía siempre vacío, y
 * el caso que hacía falta —la puerta con el almacén **rechazando el borrado** de una
 * caducada— necesita que la lectura entregue algo. Va al final y con valor por defecto:
 * las llamadas que ya existían no cambian.
 */
function falso(aperturas: ('ok' | 'error')[], escritura: 'ok' | 'error' = 'ok',
  cerrada = false, saltos = 1, filas: unknown[] = []) {
  let n = 0
  let vivas = 0
  /**
   * Una petición está viva hasta que **su manejador ha corrido**, y lo dice el propio
   * disparo (R6). Contarlo en microtareas era acoplarse a cuántos saltos usa `disparar`.
   */
  const viva = <T,>(hacer: (fin: () => void) => T): T => { vivas++; return hacer(() => { vivas-- }) }
  const tienda = {
    put: () => ({}), delete: () => ({}),
    get: (k?: unknown) => viva(fin => disparar({}, 'ok',
      (filas as { id?: unknown }[]).find(f => f.id === k), fin, saltos)),
    getAll: () => viva(fin => disparar({}, 'ok', filas, fin, saltos)),
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
    /**
     * Spec E — Lo que este caso afirma es lo mismo: **la lectura no rechaza, contesta
     * vacío**. Con el almacén caído no hay nada que filtrar, así que la lista sale vacía.
     */
    await expect(leerCola('u1'), 'la lectura rechazó: nadie recoge eso')
      .resolves.toEqual([])
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
    const { mod, oidos } = await conCanal(falso(['ok'], 'ok', false, 1, [{ id: 'p1' }]))
    /**
     * Spec E / i2-R2 — Lo que este caso guarda es **el anuncio**, y sigue intacto. Lo
     * que cambió es el valor devuelto: ya no dice si la escritura entró sino si **había
     * fila que borrar**, que es lo que impide que dos barridos solapados cuenten las
     * mismas filas. Por eso el falso ahora entrega una fila: sin ella el borrado no
     * borra nada y el `false` sería correcto.
     */
    expect(await mod.quitarDeCola('p1')).toBe(true)
    expect(oidos, 'la escritura entró y no se anunció').toHaveLength(1)
  })

  // Y la otra mitad del valor nuevo: si no había fila, la escritura entra igual —así
  // que se anuncia— pero no se ha retirado nada, y eso es lo que se devuelve.
  it('quitarDeCola distingue «borré» de «la escritura entró»', async () => {
    const { mod, oidos } = await conCanal(falso(['ok']))
    expect(await mod.quitarDeCola('no-existe'),
      'dice que borró una fila que no estaba: dos barridos contarían lo mismo dos veces').toBe(false)
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
      // Spec E / i1-R1 — La lectura cruda se extrajo a `deEsteUsuario`, el ayudante
      // privado del que cuelgan las dos exportadas: `leerCola`, que filtra, y
      // `barrerCaducados`, que barre. La puerta al almacén es ahora suya.
      .toEqual(['deEsteUsuario:lee', 'encolar:escribe', 'quitarDeCola:escribe'])
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

/**
 * Spec E / R1 — Lo que la puerta hace cuando el almacén **no acepta el borrado**, que es
 * la mitad que la Spec B aprendió a fuerza de medirlo: no se cuenta como descartada, y
 * nadie la ve igual. Se prueba aquí porque este falso sí sabe abortar; el de
 * `unit/duplicado.test.tsx` declara en su cabecera que no puede producir un fallo.
 */
describe('Spec E · la puerta con el almacén rechazando', () => {
  const viejo = { id: 'v', usuario: 'u1', grupo: 'g1', nombre: 'lejia', cantidad: null,
    creado: Date.now() - 25 * 60 * 60 * 1000 }

  it('DoD 3: no la cuenta como descartada, y tampoco la entrega', async () => {
    const m = await cargar(falso(['ok'], 'error', false, 1, [viejo]))
    expect(await m.leerCola('u1'), 'entregó una caducada porque no la pudo borrar').toEqual([])
    expect((await m.barrerCaducados('u1')).descartadas,
      'anunció un descarte que el almacén no aceptó').toBe(0)
  })
})

/**
 * Spec E / R2 — **Toda fila que salga de la tienda `cola` ha pasado por la regla.**
 *
 * Esto no se puede comprobar contando puertas al almacén: `encolar` lee con un
 * `t.getAll()` **dentro** de su propia transacción de escritura, y para el lector de
 * `puertas()` eso es una escritura, no una lectura. Ése es justo el octavo lector que
 * ninguna búsqueda por `leerCola` encontraba y el que costó la deuda 63.
 *
 * Así que se buscan **las llamadas que producen filas** —`getAll`, `get`, `openCursor`—
 * y se exige que la función que las envuelve mencione `reparte`. Es una condición
 * estructural sobre el módulo, no sobre su comportamiento de hoy (§E.1): lo que guarda
 * es al lector que alguien escriba mañana.
 *
 * **Su límite, escrito:** comprueba que la regla se *nombra* en esa función, no que se
 * aplique bien. Una función que llamara a `reparte` y tirara el resultado pasaría. Lo
 * que impide es lo que de verdad ocurrió cinco veces — un lector nuevo que ni se entera
 * de que la regla existe —, y para lo otro están los casos de comportamiento.
 */
/**
 * Spec E / i3-R4 — `getAllKeys` **no** está: devuelve claves, y a una clave no se le
 * puede aplicar la regla de caducidad. Exigírselo marcaba a un lector legítimo, y una
 * guarda que marca lo legítimo se desactiva a mano la primera vez que molesta.
 */
const PRODUCEN_FILAS = new Set(['getAll', 'get', 'openCursor'])

/**
 * Spec E / i3-R1 — **La propiedad, dicha entera.** No es «ninguna fila **sale** sin la
 * regla»: es **ninguna fila se usa sin la regla**. Las dos difieren exactamente en
 * `encolar`, que lee la cola cruda para **decidir** un duplicado y devuelve una cadena —
 * y decidir contra lo caducado es la deuda 63, o sea el defecto que este ciclo existe
 * para cerrar. La iteración 2 midió «salir» y con eso perdió esa sonda sin decirlo.
 *
 * Así que la regla vale para toda unidad que saque filas de la cola, y lo que se
 * exceptúa se escribe aquí, una por una, con su motivo. Un lector nuevo no está en esta
 * lista: tiene que añadirse a mano, que es justo el momento en que alguien lo mira.
 */
const EXENTAS: Record<string, string> = {
  quitarDeCola: 'lee una fila para saber si EXISTÍA y devuelve un booleano: no mira su '
    + 'contenido ni la entrega. Sin esta exención, el arreglo de B7 marcaría a su propio autor.',
}

/**
 * Spec E / i2-R1 — **De dónde salen estas filas**, no «¿conozco esta forma?».
 *
 * La primera versión preguntaba lo segundo y se escapaba por nueve caminos, medidos por
 * la revisión —y uno era **el refactor que la propia obra acababa de hacer**: extraer el
 * callback de la tienda a un ayudante con nombre—. Una guarda que enumera formas siempre
 * va una forma por detrás de quien escribe el código.
 *
 * Así que se parte de la **puerta al almacén** y se sigue hacia fuera: qué llamada produce
 * filas de la tienda `cola`, si esas filas **salen** de su unidad, qué unidades las
 * reciben, y si alguna de las que las entregan es alcanzable desde fuera del módulo. Una
 * forma nueva aparece como un camino nuevo, no como un caso que falta.
 *
 * Las unidades se indexan **por nodo**, no por nombre: con el nombre como clave, un
 * `leerCola` crudo local se fundía con el exportado y heredaba su cumplimiento.
 */
type Unidad = {
  id: number; fn: string; nodo: ts.Node
  aplica: boolean        // llama a `reparte` de verdad (AST, no texto)
  entregaCrudo: boolean  // saca filas de la tienda y las deja salir
  entrega: boolean       // entrega filas, propias o prestadas
  llama: string[]
}

function lectorasDeLaCola(codigo: string): { fn: string; expuesta: boolean; aplica: boolean }[] {
  const sf = ts.createSourceFile('local.ts', codigo, ts.ScriptTarget.Latest, true)
  const unidades: Unidad[] = []
  const porNombre = new Map<string, Unidad[]>()
  const expuestos = new Set<string>()

  /** Todo lo que sale del módulo, en cualquiera de sus formas. */
  const verExportaciones = (n: ts.Node) => {
    const exportado = (x: ts.Node) =>
      !!(ts.canHaveModifiers(x) && ts.getModifiers(x)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword))
    if (ts.isFunctionDeclaration(n) && n.name && exportado(n)) expuestos.add(n.name.text)
    if (ts.isClassDeclaration(n) && exportado(n)) {
      for (const m of n.members) if (ts.isMethodDeclaration(m) && ts.isIdentifier(m.name)) expuestos.add(m.name.text)
    }
    if (ts.isVariableStatement(n) && exportado(n)) {
      for (const d of n.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        expuestos.add(d.name.text)
        // Un objeto exportado expone sus métodos y lo que sus propiedades apuntan.
        if (d.initializer && ts.isObjectLiteralExpression(d.initializer)) {
          for (const pr of d.initializer.properties) {
            if (ts.isMethodDeclaration(pr) && ts.isIdentifier(pr.name)) expuestos.add(pr.name.text)
            if (ts.isPropertyAssignment(pr) && ts.isIdentifier(pr.initializer)) expuestos.add(pr.initializer.text)
            if (ts.isShorthandPropertyAssignment(pr)) expuestos.add(pr.name.text)
          }
        }
        // `export const x = y` — un alias de una línea expone a `y`.
        if (d.initializer && ts.isIdentifier(d.initializer)) expuestos.add(d.initializer.text)
      }
    }
    // `export { x }` y `export { x as y }`
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      for (const e of n.exportClause.elements) expuestos.add((e.propertyName ?? e.name).text)
    }
    ts.forEachChild(n, verExportaciones)
  }
  verExportaciones(sf)

  const unidadDe = (n: ts.Node): Unidad => {
    for (let a: ts.Node | undefined = n; a; a = a.parent) {
      const nom = nombreDeUnidad(a)
      if (!nom) continue
      let u = unidades.find(x => x.nodo === a)
      if (!u) {
        u = { id: unidades.length, fn: nom, nodo: a, aplica: false, entregaCrudo: false, entrega: false, llama: [] }
        unidades.push(u)
        porNombre.set(nom, [...(porNombre.get(nom) ?? []), u])
      }
      return u
    }
    // Lectura a nivel de módulo: unidad propia, y expuesta por definición — cualquiera
    // que importe el módulo puede alcanzar lo que deje en una constante.
    let u = unidades.find(x => x.fn === '(módulo)')
    if (!u) {
      u = { id: unidades.length, fn: '(módulo)', nodo: sf, aplica: false, entregaCrudo: false, entrega: false, llama: [] }
      unidades.push(u); porNombre.set('(módulo)', [u]); expuestos.add('(módulo)')
    }
    return u
  }
  /**
   * La unidad es una **función con nombre**, no la variable más cercana. Sin el filtro
   * del inicializador, desde la llamada gana el `const ok = await escribir(COLA, …)` de
   * `encolar` y el sitio sale llamándose «ok» — es la cicatriz que `puertas()` documenta
   * doce describes más arriba, y la volvió a cazar la depuración de esta vuelta: la
   * guarda marcaba `ok`, `q`, `todo`, `idas` y `descartadas`.
   */
  const esFuncion = (n: ts.Node | undefined): boolean =>
    !!n && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
  const nombreDeUnidad = (a: ts.Node): string | null => {
    if (ts.isFunctionDeclaration(a) && a.name) return a.name.text
    if (ts.isMethodDeclaration(a) && ts.isIdentifier(a.name)) return a.name.text
    if (ts.isPropertyAssignment(a) && ts.isIdentifier(a.name) && esFuncion(a.initializer)) return a.name.text
    if (ts.isVariableDeclaration(a) && ts.isIdentifier(a.name) && esFuncion(a.initializer)) return a.name.text
    return null
  }

  /**
   * Los callbacks que una puerta de la cola recibe **por nombre**. Sin esto, extraer el
   * callback a un ayudante saca la lectura del alcance de la guarda — y ésa es
   * exactamente la forma que el refactor de esta spec usó, así que no es hipotética.
   */
  const callbacksDeLaCola = new Set<string>()
  /**
   * Spec E / i3-R1 — **Se reconoce la puerta como ya sabe hacerlo este fichero.**
   *
   * La primera versión comparaba el argumento con el identificador `COLA` o con el
   * literal `'cola'`, y con eso se escapaban `const TIENDA = COLA`, `'co' + 'la'` y una
   * transacción propia. Doce describes más arriba, `puertas()` ya resuelve constantes con
   * punto fijo, pliega sumas de literales y acepta las cuatro puertas — se usa **su**
   * tabla `PUERTAS` y **su** resolución de texto, de modo que abrir una puerta nueva
   * rompa un solo inventario y no pase inadvertido en dos sitios distintos.
   */
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
  for (let vuelta = 0; vuelta < 3; vuelta++) {
    const verC = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const v2 = textoDe(n.initializer)
        if (v2 !== null) constantes.set(n.name.text, v2)
      }
      ts.forEachChild(n, verC)
    }
    verC(sf)
  }
  const esPuertaDeLaCola = (a: ts.CallExpression): boolean => {
    const llamada = ts.isPropertyAccessExpression(a.expression) ? a.expression.name.text
      : ts.isIdentifier(a.expression) ? a.expression.text : ''
    const idx = PUERTAS[llamada]
    if (idx === undefined) return false
    const arg = a.arguments[idx]
    return !!arg && textoDe(arg) === 'cola'
  }
  const verPuertas = (n: ts.Node) => {
    if (ts.isCallExpression(n) && esPuertaDeLaCola(n)) {
      for (const arg of n.arguments) if (ts.isIdentifier(arg)) callbacksDeLaCola.add(arg.text)
    }
    ts.forEachChild(n, verPuertas)
  }
  verPuertas(sf)

  const enLaCola = (n: ts.Node): boolean => {
    /**
     * Una transacción propia —`db.transaction(COLA).objectStore(COLA).getAll()`— no tiene
     * la puerta por **encima** sino a la **izquierda**: el `objectStore(…)` es el receptor
     * de la llamada, no su ancestro. Subir por el árbol no la encuentra, y por eso se
     * escapaba. Se mira también la cadena de receptores.
     */
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      // El receptor suele venir guardado en una variable —`const t = db.transaction(…)`—,
      // así que un identificador se resuelve a su inicializador antes de seguir la cadena.
      const resolver = (x: ts.Node): ts.Node => {
        if (!ts.isIdentifier(x)) return x
        let hallado: ts.Node = x
        const verV = (m2: ts.Node) => {
          if (ts.isVariableDeclaration(m2) && ts.isIdentifier(m2.name)
              && m2.name.text === (x as ts.Identifier).text && m2.initializer) hallado = m2.initializer
          ts.forEachChild(m2, verV)
        }
        verV(sf)
        return hallado
      }
      for (let r: ts.Node = resolver(n.expression.expression); ; ) {
        if (ts.isCallExpression(r)) {
          if (esPuertaDeLaCola(r)) return true
          if (ts.isPropertyAccessExpression(r.expression)) { r = resolver(r.expression.expression); continue }
        }
        if (ts.isPropertyAccessExpression(r)) { r = resolver(r.expression); continue }
        break
      }
    }
    for (let a: ts.Node | undefined = n; a; a = a.parent) {
      if (ts.isCallExpression(a) && ts.isIdentifier(a.expression)
          && (a.expression.text === 'conTienda' || a.expression.text === 'escribir')) {
        return esPuertaDeLaCola(a)
      }
      const nom = nombreDeUnidad(a)
      if (nom && callbacksDeLaCola.has(nom)) return true
    }
    return false
  }
  /**
   * *(Aquí vivía `sale()`, que medía si las filas **salían** de su unidad. Se fue al
   * ensanchar la propiedad: lo que la regla exige no es que no salgan sino que no se
   * **usen** sin filtrar, y la diferencia es exactamente `encolar`, que decide un
   * duplicado contra ellas y devuelve una cadena. Lo que sustituye al refinamiento es la
   * lista `EXENTAS`, que dice a mano quién puede leer sin la regla y por qué.)*
   */

  const ver = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const u = unidadDe(n)
      if (ts.isIdentifier(n.expression)) {
        if (n.expression.text === 'reparte') u.aplica = true
        u.llama.push(n.expression.text)
      }
      if (ts.isPropertyAccessExpression(n.expression)
          && PRODUCEN_FILAS.has(n.expression.name.text) && enLaCola(n)
          && !(u.fn in EXENTAS)) {
        u.entregaCrudo = true; u.entrega = true
      }
    }
    // Un identificador suelto que nombra a otra unidad —parámetro por defecto, alias—
    // también es un camino por el que las filas pueden viajar.
    // Se excluye sólo cuando el identificador **es** el llamado —eso ya lo recoge la
    // rama de arriba—; como **argumento** sí cuenta, que es como viaja un callback
    // extraído o un parámetro por defecto.
    const esElLlamado = !!n.parent && ts.isCallExpression(n.parent) && n.parent.expression === n
    if (ts.isIdentifier(n) && !esElLlamado && porNombre.has(n.text)) {
      const u = unidadDe(n); if (u.fn !== n.text) u.llama.push(n.text)
    }
    ts.forEachChild(n, ver)
  }
  ver(sf)
  ver(sf)   // segunda vuelta: `porNombre` ya está poblado para los identificadores sueltos

  for (let vuelta = 0; vuelta < 6; vuelta++) {
    for (const u of unidades) {
      const fuentes = u.llama.flatMap(c => porNombre.get(c) ?? []).filter(f => f.entrega)
      if (!fuentes.length) continue
      u.entrega = true
      if (!u.entregaCrudo && fuentes.every(f => f.aplica)) u.aplica = true
    }
  }
  return unidades.filter(u => u.entrega)
    .map(u => ({ fn: u.fn, expuesta: expuestos.has(u.fn), aplica: u.aplica }))
}

describe('Spec E / i2-R1 · ninguna fila de la cola sale del módulo sin la regla', () => {
  const codigo = readFileSync('lib/local.ts', 'utf8')
  const sinRegla = (src: string) =>
    lectorasDeLaCola(src).filter(l => l.expuesta && !l.aplica).map(l => l.fn)

  it('i2-1: el instrumento ve lectoras, y ninguna expuesta se salta la regla', () => {
    expect(lectorasDeLaCola(codigo).length, 'no ve ninguna: no mide nada').toBeGreaterThanOrEqual(2)
    expect(sinRegla(codigo), 'una función alcanzable desde fuera entrega filas sin la regla').toEqual([])
  })

  /**
   * Las **nueve formas** que la revisión midió que se escapaban. Cada una es una sonda:
   * si la guarda deja de cazar una, este banco lo dice. La novena —la colisión de
   * nombres— es la que más importa, porque no parece una forma: parece un descuido.
   */
  const CRUDO = `(await conTienda<Pendiente[]>(COLA, 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<Pendiente[]>)) ?? []`
  const formas: [string, string][] = [
    ['re-exportación', `const fisgona = async (): Promise<Pendiente[]> => ${CRUDO}\nexport { fisgona }`],
    ['re-exportación con alias', `const fisgona = async (): Promise<Pendiente[]> => ${CRUDO}\nexport { fisgona as leerColaCruda }`],
    ['callback extraído a un ayudante', `const traer = (t: IDBObjectStore) => t.getAll() as IDBRequest<Pendiente[]>\nexport const fisgona = async (): Promise<Pendiente[]> => (await conTienda<Pendiente[]>(COLA, 'readonly', traer)) ?? []`],
    ['método de clase', `export class Fisgona {\n  async fisgona(): Promise<Pendiente[]> { return ${CRUDO} }\n}`],
    ['método de objeto exportado', `export const api = {\n  async fisgona(): Promise<Pendiente[]> { return ${CRUDO} }\n}`],
    ['lectura a nivel de módulo', `export const fisgona = ${CRUDO}`],
    ['parámetro por defecto', `const fisgona = async (): Promise<Pendiente[]> => ${CRUDO}\nexport const usa = (f = fisgona) => f()`],
    ['alias de una línea', `const fisgona = async (): Promise<Pendiente[]> => ${CRUDO}\nexport const leerColaCruda = fisgona`],
    ['colisión de nombres con una que sí aplica', `export const otra = async (): Promise<Pendiente[]> => {\n  const leerCola = async (): Promise<Pendiente[]> => ${CRUDO}\n  return leerCola()\n}`],
  ]
  /**
   * Spec E / i3-R1 — **El horizonte, medido.** Las cuatro formas que la revisión
   * reprodujo atravesando el análisis en vez de rodeando sus casos: la tienda nombrada
   * por una constante intermedia, por concatenación, una transacción propia, y las filas
   * saliendo **por un cierre** — que es el idioma que `encolar` usa y declara.
   */
  const delHorizonte: [string, string][] = [
    ['la tienda por una constante intermedia', `const TIENDA = COLA\nexport const fisgona = async (): Promise<Pendiente[]> => (await conTienda<Pendiente[]>(TIENDA, 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<Pendiente[]>)) ?? []`],
    ['la tienda por concatenación', `export const fisgona = async (): Promise<Pendiente[]> => (await conTienda<Pendiente[]>('co' + 'la', 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<Pendiente[]>)) ?? []`],
    ['una transacción propia', `export const fisgona = async (db: IDBDatabase): Promise<Pendiente[]> => {\n  const t = db.transaction(COLA, 'readonly').objectStore(COLA)\n  return (t.getAll() as IDBRequest<Pendiente[]>).result ?? []\n}`],
    ['las filas salen por un cierre', `export const fisgona = async (): Promise<Pendiente[]> => {\n  let filas: Pendiente[] = []\n  await escribir(COLA, (t: IDBObjectStore) => {\n    const q = t.getAll() as IDBRequest<Pendiente[]>\n    q.onsuccess = () => { filas = q.result ?? [] }\n  })\n  return filas\n}`],
  ]
  it.each(delHorizonte)('i3-1: la sonda del horizonte — %s', (_n, inyectado) => {
    const sembrado = codigo + '\n' + inyectado.replace(/\\n/g, '\n') + '\n'
    expect(sinRegla(sembrado).length,
      'el análisis no sigue este camino: un lector nuevo entrega caducadas sin que nadie lo vea').toBeGreaterThan(0)
  })

  /**
   * Spec E / i3-R3 — **Las dos sondas del expediente anterior.** La base citaba la
   * primera y la iteración 1 la segunda; al reescribir la guarda se perdieron las dos, y
   * la primera dejó de estar guardada por ninguna estructura — sólo por un caso de
   * comportamiento. Es el test que se pone rojo cuando alguien revierte (§E.4).
   */
  it('i3-4: la sonda heredada — `encolar` decidiendo contra la cola cruda', () => {
    const sembrado = codigo.replace(
      'const hay = reparte((q.result ?? []) as Pendiente[], Date.now()).vivos.some(x =>',
      'const hay = ((q.result ?? []) as Pendiente[]).some(x =>')
    expect(sembrado, 'la sonda no se aplicó: el ancla cambió').not.toBe(codigo)
    expect(sinRegla(sembrado), 'la guarda dejó de ver al octavo lector').toContain('encolar')
  })

  it('i3-4: la sonda heredada — un `getAll` crudo dentro de una función que ya aplica la regla', () => {
    const sembrado = codigo.replace(
      'export const barrerCaducados',
      `export const fisgona = async (): Promise<Pendiente[]> =>
  (await conTienda<Pendiente[]>(COLA, 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<Pendiente[]>)) ?? []

export const barrerCaducados`)
    expect(sembrado, 'la sonda no se aplicó: el ancla cambió').not.toBe(codigo)
    expect(sinRegla(sembrado)).toContain('fisgona')
  })

  it.each(formas)('i2-1: la sonda — %s', (_n, inyectado) => {
    const sembrado = codigo + '\n' + inyectado.replace(/\\n/g, '\n') + '\n'
    expect(sinRegla(sembrado).length,
      'la guarda no ve esta forma: un lector nuevo puede nacer sin la regla').toBeGreaterThan(0)
  })

  /**
   * Sondas negativas (§E.2) — lo que **no** puede marcar. Sin ellas, endurecer la guarda
   * se convierte en marcarlo todo, que es la otra forma de no distinguir nada.
   */
  const negativas: [string, string][] = [
    ['un `.get()` que no es del almacén', `export const ajena = (m: Map<string, string>): string | undefined => m.get(COLA)`],
    ['una lectura de OTRA tienda', `export const listas = async (): Promise<unknown[]> => (await conTienda<unknown[]>(LISTAS, 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<unknown[]>)) ?? []`],
    ['un envoltorio de una que sí aplica', `export const envuelve = async (u: string): Promise<Pendiente[]> => (await leerCola(u)).slice()`],
  ]
  /**
   * Spec E / i3-R4 — **La otra mitad de una guarda: a quién NO marca.** Los tres que la
   * revisión midió. Una guarda que marca lo legítimo se desactiva a mano la primera vez
   * que molesta, y entonces no guarda nada.
   */
  const falsosPositivos: [string, string][] = [
    ['una variable local llamada como una exportada', `export const inocuaN1 = async (): Promise<number> => {\n  const leerCola = (xs: Pendiente[]) => xs.length\n  return leerCola([])\n}`],
    ['un contador que lee y devuelve un número', `export const cuantas = async (u: string): Promise<number> => (await leerCola(u)).length`],
    ['una lectura de claves, a las que no se les aplica la regla', `export const claves = async (): Promise<IDBValidKey[]> => (await conTienda<IDBValidKey[]>(COLA, 'readonly', (t: IDBObjectStore) => t.getAllKeys() as IDBRequest<IDBValidKey[]>)) ?? []`],
  ]
  it.each(falsosPositivos)('i3-3: no marca — %s', (_n, inyectado) => {
    const sembrado = codigo + '\n' + inyectado.replace(/\\n/g, '\n') + '\n'
    expect(sinRegla(sembrado), 'marcó a quien no entrega filas de la cola').toEqual([])
  })

  it.each(negativas)('i2-2: la sonda negativa — %s', (_n, inyectado) => {
    const sembrado = codigo + '\n' + inyectado + '\n'
    expect(sinRegla(sembrado), 'marcó a quien no entrega filas crudas de la cola').toEqual([])
  })
})

/**
 * Spec E / R2 — **El límite del requisito, que se selló sin él.**
 *
 * R2 pide demostrar una **ausencia**: que ninguna fila de la cola se use sin la regla. Una
 * ausencia sobre todo lo que el lenguaje admite no tiene final: tres vueltas seguidas
 * cerraron formas y la siguiente encontró más. `spec` tiene la regla para esto —un
 * requisito de ausencia necesita, antes de sellar, qué cuenta como prueba suficiente y qué
 * queda fuera— y no se aplicó.
 *
 * **Lo que cuenta como prueba suficiente, escrito:**
 *
 * 1. **El perímetro.** `lib/local.ts` es el único fichero del producto que abre IndexedDB.
 *    Eso es finito y se comprueba aquí. Mientras se cumpla, la guarda AST del describe de
 *    arriba —que lee ese fichero— alcanza a **todo** el producto.
 * 2. **Dentro del módulo, las formas medidas.** Quince: las nueve de la iteración 2, las
 *    cuatro del horizonte, y las dos heredadas del expediente anterior. No todas las que el
 *    lenguaje admite.
 *
 * **Lo que queda explícitamente fuera:** demostrar la ausencia para cualquier forma que
 * alguien escriba mañana dentro de `lib/local.ts`. Los escapes que la revisión midió y no se
 * cerraron están en la deuda con su medida. Lo que impide que importen es el punto 1: un
 * fichero nuevo que abra la tienda rompe **este** caso, y entonces alguien mira.
 */
describe('Spec E / R2 · el perímetro: un solo fichero del producto abre el almacén', () => {
  /**
   * La revisión del cierre midió que la versión anterior de este bloque **no podía
   * fallar** en la dirección que importa: la sonda inyectaba el fichero con `.concat()`,
   * o sea **después** del recorrido y del filtro de extensión, así que reducir el
   * recorrido a `lib` sola —dejar de mirar toda la capa de vista— dejaba las dos filas
   * verdes. Y el detector era `/\bindexedDB\b/` sobre texto crudo: no veía
   * `public/sw.js` (ni la raíz ni la extensión), ni `import { openDB } from 'idb'`, ni
   * `g['indexed' + 'DB']`, y sí marcaba un **comentario** que nombrara la API.
   *
   * Tres cambios, y los tres atacan la misma cosa —que lo comprobado sea el perímetro y
   * no que un fichero contenga una cadena—:
   *
   * 1. **El nivel superior del repo se enumera entero**, y cada entrada está dentro o
   *    fuera con su motivo. Eso es lo que hace **finita** la afirmación: un directorio
   *    nuevo con código no puede quedarse fuera en silencio.
   * 2. **El recorrido se afirma**: tiene que llegar a las cuatro capas del producto. Es
   *    la fila que se pone roja si alguien lo encoge, que es lo que antes no pasaba.
   * 3. **El detector es el compilador, no un regex** — la misma razón que ya está escrita
   *    arriba para `puertas()`: una afirmación de ausencia no se comprueba con `grep`. Un
   *    comentario y una cadena son invisibles para el AST por construcción, y la
   *    concatenación se pliega.
   */
  const CODIGO = /\.(tsx?|m?js)$/
  const ficheros = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.name === 'node_modules' || e.name.startsWith('.') ? []
        : e.isDirectory() ? ficheros(`${dir}/${e.name}`)
        : CODIGO.test(e.name) ? [`${dir}/${e.name}`] : [])

  /** Dentro del perímetro. `public` está porque el service worker es código de producto
   *  del mismo origen, con IndexedDB entero a su alcance, y es el sitio natural de un
   *  background-sync de esta misma cola. */
  const RAICES = ['app', 'lib', 'public']
  /** Fuera, con su motivo. Sin esta tabla, «fuera» es «nadie se acordó». */
  const FUERA: Record<string, string> = {
    docs: 'documentación', unit: 'pruebas unitarias', e2e: 'pruebas de navegador',
    supabase: 'migraciones y configuración de la base', 'test-results': 'salida de playwright',
    node_modules: 'dependencias',
  }
  /** Configuración de la raíz: corre en el build o en el runner, no en el navegador. */
  const CONFIG = new Set(['next.config.ts', 'postcss.config.mjs', 'eslint.config.mjs',
    'playwright.config.ts', 'vitest.config.ts', 'next-env.d.ts'])

  const deLaRaiz = () => readdirSync('.', { withFileTypes: true })
    .filter(e => e.isFile() && CODIGO.test(e.name) && !CONFIG.has(e.name))
    .map(e => e.name)

  const recorrido = (raices: string[]): string[] =>
    raices.flatMap(r => statSync(r).isDirectory() ? ficheros(r) : [r])

  const PRODUCTO = () => [...RAICES, ...deLaRaiz()]

  /** Un `import`/`require` de un envoltorio de IndexedDB cuenta como abrirla: `idb` no
   *  nombra la API en ninguna parte del fichero que lo usa. */
  const ENVOLTORIOS = new Set(['idb', 'idb-keyval'])

  function abreLaTienda(ruta: string, codigo: string): boolean {
    const sf = ts.createSourceFile(ruta, codigo, ts.ScriptTarget.Latest, true)
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
    const verConstantes = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const v = textoDe(n.initializer)
        if (v !== null) constantes.set(n.name.text, v)
      }
      ts.forEachChild(n, verConstantes)
    }
    verConstantes(sf)

    let abre = false
    const modulo = (n: ts.Node): string | null =>
      ts.isImportDeclaration(n) ? textoDe(n.moduleSpecifier)
        : ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'require'
          ? textoDe(n.arguments[0] ?? n) : null
    const ver = (n: ts.Node) => {
      // Un identificador `indexedDB` en posición de expresión: la forma desnuda y
      // `self.indexedDB`/`window.indexedDB`. Los comentarios y las cadenas no son nodos.
      if (ts.isIdentifier(n) && n.text === 'indexedDB') abre = true
      // `g['indexed' + 'DB']`, que es la forma que el regex no veía.
      if (ts.isElementAccessExpression(n) && textoDe(n.argumentExpression) === 'indexedDB') abre = true
      const m = modulo(n)
      if (m && ENVOLTORIOS.has(m.split('/')[0])) abre = true
      if (!abre) ts.forEachChild(n, ver)
    }
    ver(sf)
    return abre
  }

  const abren = (raices: string[]): string[] =>
    recorrido(raices).filter(f => abreLaTienda(f, readFileSync(f, 'utf8')))

  /** Siembra de verdad, en disco: la sonda tiene que pasar por el recorrido y por el
   *  filtro de extensión, que son justo las dos piezas que deciden el alcance. */
  const sembrando = (ficheros: Record<string, string>, comprobar: (raiz: string) => void) => {
    const raiz = mkdtempSync(join(tmpdir(), 'perimetro-'))
    try {
      for (const [rel, codigo] of Object.entries(ficheros)) {
        const abs = join(raiz, rel)
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, codigo)
      }
      comprobar(raiz)
    } finally { rmSync(raiz, { recursive: true, force: true }) }
  }

  it('R2-perímetro: el nivel superior del repo está clasificado, dentro o fuera', () => {
    const sinClasificar = readdirSync('.', { withFileTypes: true })
      .filter(e => !e.name.startsWith('.'))
      .filter(e => e.isDirectory()
        ? !RAICES.includes(e.name) && !(e.name in FUERA)
        : CODIGO.test(e.name) && !CONFIG.has(e.name) && !deLaRaiz().includes(e.name))
      .map(e => e.name)
    expect(sinClasificar, 'algo nuevo en la raíz: decide si entra en el perímetro o queda fuera, con su motivo')
      .toEqual([])
  })

  it('R2-perímetro: el recorrido llega a las cuatro capas del producto', () => {
    const vistos = recorrido(PRODUCTO())
    for (const f of ['app/sin-conexion/page.tsx', 'app/g/[id]/GroupView.tsx',
                     'lib/local.ts', 'public/sw.js', 'proxy.ts'])
      expect(vistos, `el recorrido no mira ${f}: el perímetro deja de cubrir su capa`).toContain(f)
  })

  it('R2-perímetro: sólo `lib/local.ts` abre IndexedDB en el producto', () => {
    expect(abren(PRODUCTO()), 'otro fichero abre la tienda: la guarda AST no lo mira y R2 deja de valer')
      .toEqual(['lib/local.ts'])
  })

  it('R2-perímetro: y nadie puede abrirla sin nombrarla — las tres puertas siguen sin exportar', () => {
    const sf = ts.createSourceFile('local.ts', readFileSync('lib/local.ts', 'utf8'),
      ts.ScriptTarget.Latest, true)
    const exportados: string[] = []
    const ver = (n: ts.Node) => {
      if ((ts.isFunctionDeclaration(n) || ts.isVariableStatement(n)) &&
          n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isFunctionDeclaration(n) && n.name) exportados.push(n.name.text)
        if (ts.isVariableStatement(n)) for (const d of n.declarationList.declarations)
          if (ts.isIdentifier(d.name)) exportados.push(d.name.text)
      }
      if (ts.isExportSpecifier(n)) exportados.push(n.name.text)
      ts.forEachChild(n, ver)
    }
    ver(sf)
    for (const puerta of ['abrir', 'conTienda', 'escribir'])
      expect(exportados, `\`${puerta}\` exportada: un fichero nuevo leería la tienda sin escribir nunca `
        + '`indexedDB`, así que el perímetro daría verde y la guarda AST —que lee un solo fichero— tampoco lo vería')
        .not.toContain(puerta)
  })

  // ---- las sondas, todas sembrando en disco (§E.2) ----

  it('R2-perímetro: la sonda — un fichero sembrado en disco se caza', () => {
    sembrando({ 'cola/diagnostico.ts': 'const db = indexedDB.open("super", 1)\n' }, raiz =>
      expect(abren([raiz]), 'un fichero nuevo que abre la tienda pasó inadvertido').toHaveLength(1))
  })

  it('R2-perímetro: la sonda — y en `.js`, que es la extensión del service worker', () => {
    sembrando({ 'sw.js': 'self.indexedDB.open("super", 1)\n' }, raiz =>
      expect(abren([raiz]), 'el filtro de extensión deja fuera la capa de service worker').toHaveLength(1))
  })

  it('R2-perímetro: la sonda — el envoltorio y la concatenación también', () => {
    sembrando({ 'a.ts': "import { openDB } from 'idb'\nexport const x = openDB\n" }, raiz =>
      expect(abren([raiz]), 'un envoltorio de IndexedDB no nombra la API').toHaveLength(1))
    sembrando({ 'b.ts': "const g = globalThis as Record<string, unknown>\nexport const d = g['indexed' + 'DB']\n" }, raiz =>
      expect(abren([raiz]), 'la concatenación se pliega en `puertas()` y aquí también').toHaveLength(1))
  })

  it('R2-perímetro: la sonda negativa — prosa que nombra la API no marca el fichero', () => {
    sembrando({
      'comentario.ts': '// este módulo no toca indexedDB, la cola vive en lib/local.ts\nexport const a = 1\n',
      'cadena.ts': 'export const aviso = "indexedDB no disponible"\n',
      'sw-real.js': '/** Los datos siguen viviendo en IndexedDB. */\nconst V = "super-v2"\n',
    }, raiz => expect(abren([raiz]),
      'una guarda que marca lo legítimo se desactiva a mano la primera vez que molesta').toEqual([]))
  })
})

/**
 * Spec F / R6 y F7 — **La firma impide olvidar el id; no impide falsearlo.**
 *
 * `addItem` pide la fila entera, así que un llamador nuevo no compila sin darle una. Pero
 * nada en el tipo distingue «la fila que acabo de leer de la cola» de «una fila que me acabo
 * de inventar», y una fila inventada en cada intento devuelve la idempotencia a cero sin que
 * ninguna puerta se ponga roja: el envío entra, la base no ve repetición, y el reenvío tras
 * un tachado vuelve a resucitar.
 *
 * Así que se lee el módulo con el compilador y se exige que el envío del drenado mande **un
 * identificador**, no un objeto construido en el sitio. Capa (§E.1): el requisito habla de lo
 * que cualquiera escriba mañana en ese bucle, así que se mira el módulo y no su
 * comportamiento de hoy.
 */
describe('Spec F / R6 · el envío del drenado manda la fila que leyó', () => {
  type Envio = { fabricada: boolean; texto: string }

  /**
   * Iteración 1 · i1-R6 — **La primera versión seguía una forma, y la forma se rodea en una
   * línea.** La revisión construyó un banco que corre el código de esta guarda y midió 5 huecos
   * y 5 falsos positivos; tres de los huecos compilan limpios contra el proyecto real. El más
   * barato es `const q = { ...p, id: crypto.randomUUID() }` y luego `addItem(…, q)`: un
   * identificador, así que la versión anterior callaba — y es exactamente el defecto que esta
   * guarda existe para impedir.
   *
   * Ahora sigue **el binding un salto**: un identificador se resuelve a su declaración y lo que
   * se juzga es su inicializador. Y se desenvuelven los adornos que no cambian el valor —
   * paréntesis, `as`, `!`, `satisfies`—, que eran los cinco falsos positivos: una guarda que se
   * pone roja con un cast y calla con un re-acuñado es una guarda que el siguiente relaja.
   *
   * **Su límite, escrito:** un salto, no un análisis de flujo. Una fila que pase por dos
   * variables, o que se mute después de declararse (`p.id = …`), sigue fuera — y para eso está
   * `unit/drenado.test.tsx` › «F3…», que compara las claves de dos pasadas y **sí** las caza, y la
   * fila F6 de navegador, que caza la que F3 no puede ver. R6 no descansa sólo en esta guarda, y
   * eso va dicho aquí y en la lista del DoD en vez de suponerse.
   */
  const INVENTA = /randomUUID|Math\.random|Date\.now/

  function enviosDelDrenado(codigo: string): Envio[] {
    const sf = ts.createSourceFile('v.tsx', codigo, ts.ScriptTarget.Latest, true)
    const out: Envio[] = []

    /** Los adornos no cambian el valor: `(p)`, `p as T`, `p!`, `p satisfies T`. */
    const desnudo = (n: ts.Node): ts.Node =>
      ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n)
        || ts.isSatisfiesExpression(n) ? desnudo(n.expression) : n

    /** Un salto: de un identificador a lo que se le asignó al declararlo. */
    const declaraciones = new Map<string, ts.Node>()
    const verDecls = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer)
        declaraciones.set(n.name.text, desnudo(n.initializer))
      ts.forEachChild(n, verDecls)
    }
    verDecls(sf)

    /** Se fabrica si es un literal de objeto, o si lo es lo que hay detrás del nombre. */
    const fabricado = (n: ts.Node, salto = true): boolean => {
      const x = desnudo(n)
      if (ts.isObjectLiteralExpression(x)) return true
      if (INVENTA.test(x.getText())) return true
      if (salto && ts.isIdentifier(x)) {
        const d = declaraciones.get(x.text)
        return d ? fabricado(d, false) : false
      }
      return false
    }

    const ver = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'addItem') {
        const fila = n.arguments[3]
        if (fila) out.push({
          fabricada: fabricado(fila),
          texto: fila.getText().replace(/\s+/g, ' ').slice(0, 60),
        })
      }
      ts.forEachChild(n, ver)
    }
    ver(sf)
    return out
  }

  /** Sólo el bucle del drenado: el alta directa construye su fila a propósito y no tiene cola. */
  const DEL_DRENADO = (codigo: string) =>
    enviosDelDrenado(codigo.slice(codigo.indexOf('const drenarUnaVez'),
      codigo.indexOf('const drenar =')))

  it('F7: en el drenado, el envío no construye la fila', () => {
    const envios = DEL_DRENADO(readFileSync('app/g/[id]/GroupView.tsx', 'utf8'))
    expect(envios.length, 'el instrumento no encontró ningún envío: no mide nada').toBeGreaterThan(0)
    expect(envios.filter(e => e.fabricada).map(e => e.texto),
      'el drenado construye la fila que manda: un uuid nuevo por intento deja la base sin repetición que ver')
      .toEqual([])
  })

  it('F7: la sonda — un envío que se inventa la fila se caza', () => {
    const sembrado = `const drenarUnaVez = async () => {
      const p = siguienteEnCola(cola, group.id, ahora)
      const r = await addItem(createClient(), group.id, me.id,
        { id: crypto.randomUUID(), nombre: p.nombre, cantidad: p.cantidad })
    }
    const drenar = () => {}`
    const envios = DEL_DRENADO(sembrado)
    expect(envios.filter(e => e.fabricada).length,
      'una fila construida en el sitio pasó inadvertida').toBe(1)
  })

  it('F7: la sonda — las tres variantes que la primera versión no cazaba', () => {
    const casos: [string, string][] = [
      ['propagación por un spread', 'const q = { ...p, id: crypto.randomUUID() }\n      const r = await addItem(c, g, u, q)'],
      ['una fila construida detrás de un nombre', 'const q = { id: crypto.randomUUID(), nombre: p.nombre, cantidad: null }\n      const r = await addItem(c, g, u, q)'],
      ['acuñada en la propia llamada', 'const r = await addItem(c, g, u, { ...p, id: crypto.randomUUID() })'],
    ]
    for (const [nombre, cuerpo] of casos) {
      const sembrado = `const drenarUnaVez = async () => {\n      ${cuerpo}\n    }\n    const drenar = () => {}`
      expect(DEL_DRENADO(sembrado).filter(e => e.fabricada).length, `${nombre}: pasó inadvertida`)
        .toBeGreaterThan(0)
    }
  })

  it('F7: las negativas — los cinco adornos de la fila leída no se marcan', () => {
    for (const forma of ['(p)', 'p as FilaAEnviar', 'p!', 'p satisfies FilaAEnviar', 'cola[0]']) {
      const sembrado = `const drenarUnaVez = async () => {
      const r = await addItem(c, g, u, ${forma})
    }
    const drenar = () => {}`
      expect(DEL_DRENADO(sembrado).filter(e => e.fabricada), `${forma}: marca lo legítimo`).toEqual([])
    }
  })

  it('F7: y la negativa — mandar la fila leída no se marca', () => {
    const sembrado = `const drenarUnaVez = async () => {
      const p = siguienteEnCola(cola, group.id, ahora)
      const r = await addItem(createClient(), group.id, me.id, p)
    }
    const drenar = () => {}`
    expect(DEL_DRENADO(sembrado).filter(e => e.fabricada), 'marca lo legítimo').toEqual([])
  })
})

/**
 * Spec F / R5 y F9 — Ningún documento puede seguir afirmando que la idempotencia la pone el
 * índice de **nombre**. Es la frase que haría revertir F leyéndola de buena fe, y estaba en el
 * docstring de R4 desde antes del sellado: la encontró una lectura, no una puerta.
 */
describe('Spec F / R5 · ningún documento afirma lo que F desmiente', () => {
  /**
   * Iteración 1 · i1-R1 — El alcance es **estas tres fuentes**, y la fila del DoD lo dice así en
   * vez de decir «ningún documento»: una afirmación más ancha que su barrido es la misma clase de
   * registro falso que este barrido existe para cazar. `docs/spec.md` queda fuera a propósito —
   * cita el texto viejo como cita marcada, y eso es legítimo.
   */
  const FUENTES = ['app/g/[id]/GroupView.tsx', 'lib/items.ts', 'lib/local.ts']

  /**
   * La primera versión de esta guarda buscaba «idempotencia … índice de nombre» en una ventana
   * de prosa, y su propia sonda la tumbó: el punto de «la pone la base.» cortaba la ventana, así
   * que **no cazaba la frase que estaba ahí**. Y al ensancharla aparecía el defecto de fondo: el
   * texto corregido dice «**no** por el índice de nombre», o sea que una ventana amplia marca
   * igual la afirmación y su negación. Un regex no distingue afirmar de negar.
   *
   * Así que la propiedad cambia a lo que sí es comprobable: **las dos frases retiradas no
   * vuelven.** Y con su límite dicho — esto caza que alguien restaure el texto viejo, que es
   * cómo se revierte F leyéndola de buena fe; NO caza que el comportamiento se revierta. De eso
   * responden F1 y F2, en la base.
   *
   * Y un efecto que este barrido destapó en su primera corrida, que vale anotar: **la corrección
   * citaba la frase retirada para explicarla**, así que el barrido la encontró en el sitio
   * corregido. Un registro que reproduce el texto que retira derrota al barrido de ese texto; se
   * describe la afirmación vieja, no se copia.
   */
  const RETIRADAS = [
    'por el índice único de nombre normalizado, y eso es éxito',
    'inventar aquí una clave de deduplicación',
  ]

  it('F9: ninguna fuente contiene las frases retiradas', () => {
    const culpables = FUENTES.flatMap(f => {
      const texto = readFileSync(f, 'utf8')
      return RETIRADAS.filter(r => texto.includes(r)).map(r => `${f}: ${r}`)
    })
    expect(culpables, 'volvió el texto que atribuye la idempotencia al índice de nombre').toEqual([])
  })

  it('F9: la sonda — el docstring original se caza, entero y por partes', () => {
    const original = 'La idempotencia no la pone este bucle: la pone la base. Reenviar un alta que '
      + 'ya entró devuelve `23505` por el índice único de nombre normalizado, y eso es éxito — el '
      + 'producto está, que es lo que se quería. Sin esa constraint habría que inventar aquí una '
      + 'clave de deduplicación, y sería peor.'
    expect(RETIRADAS.filter(r => original.includes(r)),
      'el barrido no caza el texto que de verdad estaba ahí: no mide nada').toHaveLength(2)
  })

  /**
   * i1-R1 — **Este caso negativo citaba una frase falsa y la bendecía.** Decía «Y por la clave
   * primaria», que es falso: el cliente no puede escribir `items.id` —`42501`, por privilegio de
   * columna— y quien rechaza es `items_origen_unico`. La frase se escribió cuando el mecanismo
   * iba a ser la primaria y no se actualizó al cambiarlo, así que la guarda de los registros
   * falsos **certificaba uno**. La revisión lo midió. Ahora el caso negativo usa el texto que de
   * verdad está en el fichero, leído del fichero.
   */
  it('F9: y la negativa — el texto corregido, tomado del fichero, no se marca', () => {
    const real = readFileSync('app/g/[id]/GroupView.tsx', 'utf8')
    const parrafo = real.slice(real.indexOf('La idempotencia no la pone este bucle'))
      .slice(0, 600)
    expect(parrafo, 'el párrafo corregido no está donde se espera: el caso mide otra cosa')
      .toContain('items_origen_unico')
    expect(RETIRADAS.filter(r => parrafo.includes(r)),
      'la guarda marca la negación igual que la afirmación').toEqual([])
  })

  /**
   * i1-R1 — Y la mitad positiva, que es la que no había: **el fichero nombra el mecanismo real**.
   * Un barrido de ausencias está verde también cuando el párrafo entero desaparece, o cuando
   * nombra un mecanismo que no es. Esta fila se pone roja en los dos casos.
   */
  it('F9: el fichero nombra el mecanismo que de verdad rechaza, y no la clave primaria', () => {
    const real = readFileSync('app/g/[id]/GroupView.tsx', 'utf8')
    expect(real, 'el drenado no nombra `items_origen_unico`: quien lo lea no sabrá qué rechaza')
      .toContain('items_origen_unico')
    expect(/idempotencia[^.]{0,120}\bclave\s+\n?\s*\*?\s*primaria\b/i.test(real),
      'vuelve a atribuir la idempotencia a la clave primaria, que el cliente no puede escribir')
      .toBe(false)
  })
})
