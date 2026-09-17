// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent, within } from '@testing-library/react'
import type { Pendiente } from '@/lib/local'

/**
 * Spec «el duplicado lo impide la escritura» — El invariante vive en el almacén, así
 * que el arnés usa **el almacén de verdad** sobre un IndexedDB falso que **guarda**.
 * Un doble de `encolar` no valdría: tendría que implementar el invariante él mismo, y
 * entonces el test probaría el doble y no el producto.
 *
 * El falso es de mentira en el almacenamiento y **fiel en lo que importa**: las
 * peticiones resuelven de forma asíncrona, y una petición lanzada desde el
 * `onsuccess` de otra mantiene viva la transacción — que es exactamente la
 * propiedad de la que depende el re-chequeo, verificada antes en navegador real.
 *
 * **R6 — Y en qué NO es fiel, porque «fiel en lo que importa» sólo significa algo si
 * se dice lo que queda fuera.** Tres cosas, y ninguna es accidental:
 *
 * 1. **Las `readonly` no toman turno.** Sólo se serializan las `readwrite` (`turnos`),
 *    que es la propiedad que sostiene el invariante. El navegador real **sí** ordena
 *    las `readonly` frente a las `readwrite` sobre la misma tienda. Consecuencia: un
 *    defecto que viviera en ese orden —una lectura que adelanta a una escritura ya
 *    encolada— este falso no lo ve. Por eso el DoD nombra el caso de navegador: esa
 *    capa es la única donde el orden es el de verdad.
 * 2. **No hay ningún camino de fallo.** Ni apertura que no abre, ni transacción que
 *    aborta, ni cuota. O sea: `'rechazado'` es **inalcanzable** con este falso, y
 *    quien quiera probar esa rama tiene que ir a `unit/almacen.test.ts`, cuyo falso
 *    sí sabe abortar. Un caso de este fichero que esperara `'rechazado'` estaría
 *    afirmando algo que el arnés no puede producir.
 * 3. **`getAll` devuelve las mismas referencias.** No hay clonado estructural: la
 *    fila que sale es el objeto que entró. El navegador real entrega una copia, así
 *    que si el producto mutara lo leído, aquí no se notaría y allí sí.
 */
type Fila = Record<string, unknown>
const tiendas: Record<string, Map<string, Fila>> = {}


function idbFalso() {
  /**
   * **Las transacciones `readwrite` sobre la misma tienda se serializan.** No es un
   * detalle del falso: es la propiedad de IndexedDB de la que depende el invariante,
   * y se verificó en navegador real antes de escribirla aquí — dos transacciones
   * abiertas en la misma tarea, y la segunda ve lo que la primera escribió
   * (`filas: 1`, `yaEstaba: true`).
   *
   * La primera versión de este falso NO serializaba, y el test de dos pestañas salía
   * rojo con el producto ya arreglado. Un falso infiel en la propiedad que sostiene
   * el arreglo no mide el arreglo: mide el falso.
   */
  const turnos: Record<string, Promise<void>> = {}
  const db = {
    objectStoreNames: { contains: (n: string) => n in tiendas },
    createObjectStore: (n: string) => { tiendas[n] = new Map(); return {} },
    transaction: (nombre: string, modo: string = 'readonly') => {
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = {}
      let liberar: () => void = () => {}
      const anterior = turnos[nombre] ?? Promise.resolve()
      const miTurno = modo === 'readwrite'
        ? anterior.then(() => {})
        : Promise.resolve()
      if (modo === 'readwrite') turnos[nombre] = new Promise<void>(r => { liberar = r })

      let pendientes = 0
      const cerrarSiVacia = () => {
        if (pendientes > 0) return
        queueMicrotask(() => {
          if (pendientes > 0) return
          tx.oncomplete?.()
          liberar()
        })
      }
      const conta = <T,>(valor: () => T) => {
        pendientes++
        const req: { result?: T; onsuccess?: () => void } = {}
        void miTurno.then(() => {
          req.result = valor()
          req.onsuccess?.()
          pendientes--
          cerrarSiVacia()
        })
        return req
      }
      const quitarDe = (m: Map<string, Fila>, k: string) => m.delete(k)
      const m = (): Map<string, Fila> => (tiendas[nombre] ??= new Map())
      const tienda = {
        put: (v: Fila, clave?: string) => conta(() => { m().set(clave ?? String(v.id), v); return undefined }),
        delete: (k: string) => conta(() => { quitarDe(m(), k); return undefined }),
        get: (k: string) => conta(() => m().get(k)),
        getAll: () => conta(() => [...m().values()]),
        getAllKeys: () => conta(() => [...m().keys()]),
      }
      // Una transacción sin ninguna petición también cierra, en su turno.
      void miTurno.then(() => cerrarSiVacia())
      return { objectStore: () => tienda,
        set oncomplete(f: () => void) { tx.oncomplete = f },
        set onerror(f: () => void) { tx.onerror = f },
        set onabort(f: () => void) { tx.onabort = f } }
    },
  }
  return { open: () => {
    const req: { result?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void } = {}
    queueMicrotask(() => { req.result = db; req.onupgradeneeded?.(); req.onsuccess?.() })
    return req
  } }
}

const cargarAlmacen = async () => {
  vi.resetModules()
  vi.stubGlobal('indexedDB', idbFalso())
  vi.stubGlobal('BroadcastChannel', undefined)
  return import('@/lib/local')
}

/** Igual, pero con el canal espiado: hace falta para ver qué se anuncia y qué no. */
const cargarConCanal = async () => {
  const oidos: unknown[] = []
  class CanalFalso {
    onmessage: ((e: { data: unknown }) => void) | null = null
    postMessage(d: unknown) { oidos.push(d) }
    close() { this.onmessage = null }
  }
  vi.resetModules()
  vi.stubGlobal('indexedDB', idbFalso())
  vi.stubGlobal('BroadcastChannel', CanalFalso)
  return { mod: await import('@/lib/local'), oidos }
}

beforeEach(() => { for (const k of Object.keys(tiendas)) delete tiendas[k] })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const pendiente = (id: string, nombre: string, grupo = 'g1'): Pendiente =>
  ({ id, usuario: 'u1', grupo, nombre, cantidad: null, creado: 1 })

describe('el almacén impide el duplicado', () => {
  // DoD 3 — El invariante, en la capa que el requisito nombra.
  it('dos altas del mismo producto dejan una sola fila', async () => {
    const { encolar, leerCola } = await cargarAlmacen()
    await encolar(pendiente('1', 'leche'))
    await encolar(pendiente('2', 'leche'))
    expect((await leerCola('u1')).length, 'entraron las dos').toBe(1)
  })

  // DoD 4 — Sonda (§E.2): el invariante es el que `mismoProducto` declara, no uno
  // más ancho. El mismo nombre en OTRO grupo sí entra.
  it('el mismo nombre en otro grupo sí entra', async () => {
    const { encolar, leerCola } = await cargarAlmacen()
    await encolar(pendiente('1', 'leche', 'g1'))
    await encolar(pendiente('2', 'leche', 'g2'))
    expect((await leerCola('u1')).length, 'el invariante se comió un grupo ajeno').toBe(2)
  })

  // La pidió la pasada de mutación: quitar la comparación de usuario dejaba los
  // siete verdes. La cola es de todos los usuarios del dispositivo y `leerCola`
  // filtra por el suyo, así que sin esto el invariante de uno tapa el alta de otro.
  it('el mismo nombre de OTRO usuario sí entra', async () => {
    const { encolar, leerCola } = await cargarAlmacen()
    await encolar(pendiente('1', 'leche'))
    await encolar({ ...pendiente('2', 'leche'), usuario: 'u2' })
    expect((await leerCola('u1')).length).toBe(1)
    expect((await leerCola('u2')).length,
      'el invariante de un usuario se comió el alta de otro').toBe(1)
  })

  /**
   * La pidió la pasada de mutación: sin la rama de «ya estaba», `encolar` caía en el
   * camino del éxito y anunciaba un cambio que no ocurrió —haciendo releer a las
   * demás pestañas para encontrar lo mismo— **y** le decía al llamador que entró.
   * Las dos mentiras a la vez, y la suite seguía verde.
   */
  it('un duplicado no entra, no avisa, y lo dice', async () => {
    const { mod, oidos } = await cargarConCanal()
    expect(await mod.encolar(pendiente('1', 'leche'))).toBe('entro')
    expect(oidos, 'el primero debía anunciarse').toHaveLength(1)
    expect(await mod.encolar(pendiente('2', 'leche')),
      'el segundo del mismo producto no dijo «ya estaba»').toBe('ya-estaba')
    expect(oidos, 'anunció un cambio que no ocurrió').toHaveLength(1)
  })

  // Y por nombre normalizado, que es lo que `mismoProducto` compara.
  it('el mismo producto escrito distinto tampoco entra dos veces', async () => {
    const { encolar, leerCola } = await cargarAlmacen()
    await encolar(pendiente('1', 'Leche'))
    await encolar(pendiente('2', '  leche  '))
    expect((await leerCola('u1')).length).toBe(1)
  })
})

/**
 * DoD 1 y 2 — El defecto donde el usuario lo provoca: **dos pestañas**. El arnés lo
 * fija la spec porque dos sondas anteriores fallaron por no tener las tres cosas a
 * la vez — dos raíces, pulsaciones **solapadas dentro de una misma tarea**, y un
 * almacén que escribe de verdad. Aquí el almacén ES el de verdad, sobre el falso
 * que guarda, así que no hay doble que pudiera implementar el invariante por su
 * cuenta y hacer el test circular.
 */
describe('dos pestañas apuntan lo mismo a la vez', () => {
  const montarDos = async () => {
    vi.resetModules()
    vi.stubGlobal('indexedDB', idbFalso())
    vi.stubGlobal('BroadcastChannel', undefined)
    vi.doMock('@/lib/supabase/client', () => ({ createClient: () => ({}) }))
    vi.doMock('@/lib/useGroupChannel', () => ({ useGroupChannel: () => 'live' }))
    vi.doMock('@/app/actions', () => ({
      createInviteAction: vi.fn(), decideMemberAction: vi.fn(), leaveGroupAction: vi.fn(),
    }))
    vi.doMock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }))
    vi.doMock('@/lib/useSinRed', () => ({ useSinRed: () => true }))
    vi.doMock('@/lib/items', async (o) => ({
      ...(await o<typeof import('@/lib/items')>()),
      activeItems: vi.fn(async () => ({ data: [], clase: null, code: null })),
      addItem: vi.fn(), updateItem: vi.fn(), softDeleteItem: vi.fn(),
    }))
    const { GroupView } = await import('@/app/g/[id]/GroupView')
    const local = await import('@/lib/local')
    const vista = () => (
      <GroupView group={{ id: 'g1', name: 'Familia' }} initialItems={[]}
        members={[{ user_id: 'u1', status: 'active', role: 'owner' }]}
        profiles={[{ id: 'u1', display_name: 'Yo' }]}
        me={{ id: 'u1', role: 'owner' }} loadClase={null} />
    )
    const a = within(render(vista()).container)
    const b = within(render(vista()).container)
    await act(async () => {})
    return { a, b, local }
  }

  it('duplicado DoD 1: solapadas, sólo una entra en la cola', async () => {
    const { a, b, local } = await montarDos()
    fireEvent.change(a.getByTestId('item-name'), { target: { value: 'leche' } })
    fireEvent.change(b.getByTestId('item-name'), { target: { value: 'leche' } })
    await act(async () => {
      fireEvent.click(a.getByTestId('add-item'))
      fireEvent.click(b.getByTestId('add-item'))
    })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect((await local.leerCola('u1')).length,
      'las dos pasaron el chequeo y el almacén las aceptó: la cola tiene el producto dos veces')
      .toBe(1)
  })

  /**
   * DoD 2 — El control, y es parte del arnés, no un extra: sin él la sonda de arriba
   * no distingue «lo impidió el invariante» de «nunca llegó a ocurrir». Serializadas,
   * la segunda ve lo que la primera escribió y `decidirEncolar` ya lo para.
   */
  it('duplicado DoD 2: serializadas, también sólo una', async () => {
    const { a, b, local } = await montarDos()
    fireEvent.change(a.getByTestId('item-name'), { target: { value: 'leche' } })
    await act(async () => { fireEvent.click(a.getByTestId('add-item')) })
    fireEvent.change(b.getByTestId('item-name'), { target: { value: 'leche' } })
    await act(async () => { fireEvent.click(b.getByTestId('add-item')) })
    await act(async () => { await new Promise(r => setTimeout(r, 20)) })
    expect((await local.leerCola('u1')).length).toBe(1)
  })
})

/**
 * DoD 7 — La guarda de la forma elegida. Si alguien cambia el `keyPath` de la cola
 * —la otra forma que §3 descartó— rompe el borrado por `id` en tres sitios, uno de
 * ellos `olvidarTodo`, o sea cerrar sesión. Esta prueba se pone roja antes de que
 * eso llegue a producción, y obliga a volver a `/spec` como la spec declara.
 */
describe('la cola sigue borrándose por id', () => {
  it('quitarDeCola borra lo que encolar puso, con su id', async () => {
    const { encolar, quitarDeCola, leerCola } = await cargarAlmacen()
    await encolar(pendiente('abc', 'leche'))
    expect(await quitarDeCola('abc'), 'el borrado por id no entró').toBe(true)
    expect((await leerCola('u1')).length, 'la fila sigue: el keyPath ya no es `id`').toBe(0)
  })

  it('olvidarTodo se lleva la cola del usuario', async () => {
    const { encolar, olvidarTodo, leerCola } = await cargarAlmacen()
    await encolar(pendiente('abc', 'leche'))
    await encolar(pendiente('def', 'pan'))
    await olvidarTodo('u1')
    expect((await leerCola('u1')).length, 'cerrar sesión dejó la cola del anterior').toBe(0)
  })

  /**
   * R3 — **El quinto escritor de `LISTAS`.** Es el `delete` de dentro de
   * `olvidarTodo`, el único de los cinco cuyo `escribir` nadie recoge: la función
   * devuelve `void`, así que su **retorno** es inobservable y lo dice
   * `unit/almacen.test.ts`. Lo que se prueba aquí es su **efecto**, que sí se ve —
   * y hace falta un falso que guarde de verdad para verlo, o sea este fichero y no
   * aquél, donde `getAllKeys` contesta siempre vacío y este camino no llega a
   * escribir nada (§E.1: la capa donde el hecho existe).
   *
   * Lo que se pone rojo: que cerrar sesión deje la lista del anterior en el
   * dispositivo, que es literalmente lo que §A.1 no permite ni en el servidor.
   */
  it('olvidarTodo se lleva también la lista y el nombre del usuario', async () => {
    const m = await cargarAlmacen()
    await m.guardarLista('u1', 'g1', [{
      id: 'i1', group_id: 'g1', name: 'anchoas', quantity: null,
      created_by: 'u1', created_at: 'a', updated_at: 'a', deleted_at: null,
    }])
    await m.guardarNombre('u1', 'g1', 'Familia Alba')
    await m.guardarUltimoUsuario('u1')
    // La sonda del propio caso: si no hubiera entrado nada, borrar no probaría nada.
    expect(await m.leerLista('u1', 'g1'), 'no entró la lista: el caso no prueba nada')
      .toHaveLength(1)
    expect(await m.leerNombre('u1', 'g1')).toBe('Familia Alba')

    await m.olvidarTodo('u1')

    expect(await m.leerLista('u1', 'g1'),
      'cerrar sesión dejó la lista del anterior en el dispositivo').toBeNull()
    expect(await m.leerNombre('u1', 'g1'), 'y dejó el nombre de su grupo').toBeNull()
    expect(await m.leerUltimoUsuario(), 'y dejó la marca de quién estaba').toBeNull()
  })
})
