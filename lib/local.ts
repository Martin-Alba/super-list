import type { Item } from '@/lib/items'

/**
 * R5/R6 — Lo que la app guarda **en el dispositivo**: la cola de altas que aún no
 * han llegado al servidor, y la última lista conocida de cada grupo.
 *
 * Los dos viven en el mismo módulo a propósito. Comparten la conexión, la clave
 * por usuario y —sobre todo— la regla de que un cierre de sesión los borra: dos
 * módulos con la misma regla escrita dos veces divergen, y el que se usa menos se
 * queda atrás. Es la cicatriz X2 de este proyecto.
 *
 * La **política** —qué caduca, qué sale primero— son funciones puras aquí arriba,
 * separadas del almacén: una regla enterrada en una transacción de IndexedDB no
 * la puede afirmar nadie sin levantar un navegador.
 */

export type Pendiente = {
  id: string
  usuario: string
  grupo: string
  nombre: string
  cantidad: string | null
  creado: number
}

/**
 * Un día. Una lista de la compra de anteayer ya no es la lista de nadie, y ver
 * aparecer productos que ya se compraron sorprende más de lo que ayuda.
 */
export const VIDA_COLA_MS = 24 * 60 * 60 * 1000

/** Separa lo que aún vale de lo que hay que descartar. Puro. */
export function reparte(cola: Pendiente[], ahora: number): {
  vivos: Pendiente[]; caducados: Pendiente[]
} {
  const vivos: Pendiente[] = []
  const caducados: Pendiente[] = []
  for (const p of cola) (ahora - p.creado > VIDA_COLA_MS ? caducados : vivos).push(p)
  return { vivos, caducados }
}

/**
 * El siguiente a enviar de un grupo: el más antiguo. Uno cada vez — dos envíos
 * simultáneos sobre el mismo grupo son la carrera que D.2 prohíbe resolver en
 * memoria del proceso.
 */
export function siguienteEnCola(cola: Pendiente[], grupo: string): Pendiente | null {
  const suyos = cola.filter(p => p.grupo === grupo)
  if (!suyos.length) return null
  return suyos.reduce((a, b) => (a.creado <= b.creado ? a : b))
}

/**
 * I3 — Quién estaba dentro la última vez. El shell sin red lo necesita para saber
 * de quién es la instantánea que puede pintar, y el arranque con red lo compara
 * con el usuario actual: si cambió, lo del anterior se va.
 */
const ULTIMO = 'ultimo-usuario'

/** Clave de la instantánea: por usuario **y** por grupo (A.1). */
const claveInstantanea = (usuario: string, grupo: string) => `${usuario}:${grupo}`

/**
 * Spec C / R5 — El nombre del grupo, en su **propia clave**, no como cuarto
 * argumento de `guardarLista`: `unit/drenado.test.tsx:258` afirma esa llamada con
 * tres, y ampliarla la pondría roja sin que el producto hubiera empeorado.
 *
 * El usuario va **delante** a propósito: `esClaveDe` barre por ese prefijo, y una
 * clave `nombre:u1:g1` sobreviviría al cierre de sesión. Dos segmentos son una
 * instantánea y tres un nombre, así que no colisionan.
 */
export const claveDelNombre = (usuario: string, grupo: string) => `${usuario}:${grupo}:nombre`

/**
 * Lo que `olvidarTodo` se lleva. Extraído para que la sonda pueda **ejercitarlo**
 * en vez de reimplementarlo al lado: una copia pasa en verde mientras el de
 * verdad se queda atrás.
 */
export const esClaveDe = (usuario: string, clave: unknown): boolean =>
  typeof clave === 'string' && (clave.startsWith(`${usuario}:`) || clave === ULTIMO)

const BASE = 'super'
const COLA = 'cola'
const LISTAS = 'listas'

/**
 * Sin navegador no hay almacén: en el render del servidor esto no existe, y
 * devolver `null` es lo correcto — no hay nada local que leer.
 */
let conexion: Promise<IDBDatabase | null> | null = null

/**
 * I10 — La conexión se reutiliza. Abrirla por operación salían siete aperturas
 * por montaje, y el dispositivo objetivo es un móvil en el camino frío.
 */
function abrir(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  /**
   * J8 — Un fallo de apertura **no** se cachea: cachearlo convertía un error
   * pasajero en un almacén muerto durante el resto de la pestaña.
   */
  /**
   * L2 — `indexedDB.open()` **lanza** —modo privado, almacenamiento denegado por
   * política— además de poder emitir `onerror`. K5 tapó la transacción y dejó
   * esto: medido, las seis funciones del módulo rechazaban, y como `BotonSalir`
   * espera a `olvidarTodo` antes de cerrar sesión, quien pulsaba «Salir» no salía.
   */
  return (conexion ??= new Promise<IDBDatabase | null>((resolve) => {
    // El `try` va **dentro**: lo que lanza en el ejecutor de una promesa sale
    // como rechazo, no como excepción, y envolver la llamada por fuera no lo veía.
    let req: IDBOpenDBRequest
    try { req = indexedDB.open(BASE, 1) } catch { resolve(null); return }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(COLA)) db.createObjectStore(COLA, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(LISTAS)) db.createObjectStore(LISTAS)
    }
    req.onsuccess = () => resolve(req.result)
    // Un almacén que no abre no puede romper la app: se sigue sin cola.
    req.onerror = () => resolve(null)
  }).then((db) => { if (!db) conexion = null; return db }))
}

function conTienda<T>(
  almacen: string, modo: IDBTransactionMode, hacer: (t: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return abrir().then(db => db && new Promise<T | null>((resolve) => {
    /**
     * K5 — Igual que `escribir`. Con la conexión ya cerrada —una evicción de
     * almacenamiento, otra pestaña que la cierra— `db.transaction()` **lanza**, y
     * como todos los llamadores están dentro de un `void (async …)`, el rechazo
     * no lo recogía nadie: el shell se quedaba en blanco antes de decir siquiera
     * que hacía falta conexión. El almacén informa, no rompe.
     */
    try {
      const req = hacer(db.transaction(almacen, modo).objectStore(almacen))
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  }))
}

/**
 * J6 — Toda escritura dice si **entró**, y lo dice cuando la transacción
 * confirma, no cuando la petición contesta: sin cuota, el `put` responde bien y
 * es la transacción la que aborta después. Esperar a la petición daba por buena
 * una escritura que nunca llegó al disco.
 *
 * Un `null` de lectura y un rechazo no se distinguen —`getAll` de una tienda
 * vacía devuelve lo mismo que un error—, así que las escrituras no pasan por
 * `conTienda`: tienen su propia puerta, que sólo sabe de sí o no.
 */
function escribir(almacen: string, hacer: (t: IDBObjectStore) => void): Promise<boolean> {
  return abrir().then(db => db === null ? false : new Promise<boolean>((resolve) => {
    try {
      const tx = db.transaction(almacen, 'readwrite')
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
      tx.onabort = () => resolve(false)
      hacer(tx.objectStore(almacen))
    } catch { resolve(false) }
  }))
}

/**
 * J6 — Devuelve si el almacén **aceptó** la escritura. Antes se tragaba el fallo
 * y la vista pintaba la ficha igual: el usuario veía su producto, recargaba, y no
 * estaba. Un almacén que no admite nada no puede parecer que sí.
 */
export const encolar = (p: Pendiente): Promise<boolean> =>
  escribir(COLA, (t: IDBObjectStore) => { t.put(p) })

export const leerCola = (usuario: string): Promise<Pendiente[]> =>
  conTienda<Pendiente[]>(COLA, 'readonly', (t: IDBObjectStore) => t.getAll() as IDBRequest<Pendiente[]>)
    .then(todo => (todo ?? []).filter(p => p.usuario === usuario))

export const quitarDeCola = (id: string): Promise<boolean> =>
  escribir(COLA, (t: IDBObjectStore) => { t.delete(id) })

export const guardarLista = (usuario: string, grupo: string, items: Item[]): Promise<boolean> =>
  escribir(LISTAS, (t: IDBObjectStore) => { t.put(items, claveInstantanea(usuario, grupo)) })

export const leerLista = (usuario: string, grupo: string): Promise<Item[] | null> =>
  conTienda<Item[]>(LISTAS, 'readonly', (t: IDBObjectStore) =>
    t.get(claveInstantanea(usuario, grupo)) as IDBRequest<Item[]>)

/**
 * Spec C / R5 — Expand/contract (§D.5): un dispositivo con instantánea anterior
 * a este cambio no tiene nombre guardado, y la cáscara tiene que aguantarlo sin
 * inventarse ninguno.
 */
export const guardarNombre = (usuario: string, grupo: string, nombre: string): Promise<boolean> =>
  escribir(LISTAS, (t: IDBObjectStore) => { t.put(nombre, claveDelNombre(usuario, grupo)) })

export const leerNombre = (usuario: string, grupo: string): Promise<string | null> =>
  conTienda<string>(LISTAS, 'readonly', (t: IDBObjectStore) =>
    t.get(claveDelNombre(usuario, grupo)) as IDBRequest<string>)

export const guardarUltimoUsuario = (usuario: string): Promise<boolean> =>
  escribir(LISTAS, (t: IDBObjectStore) => { t.put(usuario, ULTIMO) })

/** K6 — Y se puede quitar: sin marca, el shell no pinta la instantánea de nadie. */
export const olvidarUltimoUsuario = (): Promise<boolean> =>
  escribir(LISTAS, (t: IDBObjectStore) => { t.delete(ULTIMO) })

export const leerUltimoUsuario = (): Promise<string | null> =>
  conTienda<string>(LISTAS, 'readonly', (t: IDBObjectStore) => t.get(ULTIMO) as IDBRequest<string>)

/**
 * R5/R6 — Cerrar sesión borra las dos cosas. Sin esto, el siguiente que entre en
 * el mismo dispositivo encuentra la lista del anterior, que es lo que A.1 prohíbe
 * en el servidor y no tendría sentido permitir aquí.
 */
export async function olvidarTodo(usuario: string): Promise<void> {
  const cola = await leerCola(usuario)
  await Promise.all(cola.map(p => quitarDeCola(p.id)))
  /**
   * Se pasa por `conTienda` como todo lo demás. La primera versión abría aquí su
   * propia transacción, y la guarda de borrado físico la marcó — con razón: era
   * una segunda forma de llegar al almacén, y el receptor del `delete` dejaba de
   * ser un parámetro reconocible. La deuda 20 predijo esta colisión por escrito.
   */
  const claves = await conTienda<IDBValidKey[]>(LISTAS, 'readonly', (t: IDBObjectStore) =>
    t.getAllKeys() as IDBRequest<IDBValidKey[]>)
  // Y la marca de quién estaba: si no, el shell sin red seguiría creyendo que
  // hay alguien dentro después de que se haya ido.
  const mias = (claves ?? []).filter((k): k is string => esClaveDe(usuario, k))
  await Promise.all(mias.map(k => escribir(LISTAS, (t: IDBObjectStore) => { t.delete(k) })))
}
