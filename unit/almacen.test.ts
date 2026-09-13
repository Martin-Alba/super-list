import { describe, it, expect, vi, beforeEach } from 'vitest'

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

const disparar = (req: Req, como: 'ok' | 'error', result?: unknown) => {
  queueMicrotask(() => {
    if (como === 'error') req.onerror?.()
    else { req.result = result; req.onsuccess?.() }
  })
  return req
}

type Tx = { oncomplete?: () => void; onerror?: () => void; onabort?: () => void }

/**
 * @param aperturas qué hace cada `open()`, en orden; la última se repite.
 * @param escritura 'error' aborta la **transacción**, que es como se manifiesta
 *   quedarse sin cuota: el `put` contesta bien y el disco dice que no después.
 */
function falso(aperturas: ('ok' | 'error')[], escritura: 'ok' | 'error' = 'ok',
  cerrada = false) {
  let n = 0
  const tienda = {
    put: () => ({}), delete: () => ({}),
    get: () => disparar({}, 'ok', undefined),
    getAll: () => disparar({}, 'ok', []),
    getAllKeys: () => disparar({}, 'ok', []),
  }
  const db = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      // K5 — Con la conexión ya cerrada, `transaction()` **lanza**. Es lo que
      // pasa tras una evicción de almacenamiento, y es lo que hacía rechazar a
      // las lecturas: nadie recogía ese rechazo.
      if (cerrada) throw new Error('InvalidStateError')
      const tx: Tx = {}
      queueMicrotask(() => (escritura === 'ok' ? tx.oncomplete?.() : tx.onabort?.()))
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
    expect(await encolar(p), 'un rechazo del disco pasó por éxito').toBe(false)
  })

  it('y si el almacén no abre siquiera, también', async () => {
    const { encolar } = await cargar(falso(['error']))
    expect(await encolar(p)).toBe(false)
  })

  // La sonda: si devolviera `false` siempre, lo de arriba no probaría nada.
  it('la sonda: una escritura que entra devuelve true', async () => {
    const { encolar } = await cargar(falso(['ok']))
    expect(await encolar(p)).toBe(true)
  })

  it('y sin IndexedDB en la plataforma no se rompe: devuelve false', async () => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', undefined)
    const { encolar } = await import('@/lib/local')
    expect(await encolar(p)).toBe(false)
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
    expect(await encolar(p), 'el primer intento debía fallar').toBe(false)
    expect(await encolar(p), 'el fallo quedó cacheado: el almacén murió').toBe(true)
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
    await expect(encolar(p)).resolves.toBe(false)
  })

  // La sonda: con la conexión viva, las mismas lecturas traen lo que hay.
  it('la sonda: con la conexión abierta se lee de verdad', async () => {
    const m = await cargar(falso(['ok']))
    await expect(m.leerCola('u1')).resolves.toEqual([])
    await expect(m.encolar(p)).resolves.toBe(true)
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
    await expect(m.encolar(p)).resolves.toBe(false)
    await expect(m.guardarUltimoUsuario('u1')).resolves.toBe(false)
    await expect(m.olvidarTodo('u1'), 'olvidarTodo rechazó: «Salir» se queda colgado')
      .resolves.toBeUndefined()
  })

  // La sonda: con un almacén que abre, las mismas seis hacen su trabajo.
  it('la sonda: con el almacén abierto, escribir y leer funcionan', async () => {
    const m = await cargar(falso(['ok']))
    await expect(m.encolar(p)).resolves.toBe(true)
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
