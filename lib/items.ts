import type { SupabaseClient } from '@supabase/supabase-js'
import { claseDe, type Clase } from '@/lib/errors'

export type Item = {
  id: string
  group_id: string
  name: string
  quantity: string | null
  created_by: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/**
 * I11 — las mutaciones devuelven el error en vez de lanzarlo o descartarlo.
 * R1 — y con su **código**, que es lo único que distingue "no tienes sesión" de
 * "no tienes acceso": las dos llegan como `permission denied`.
 * Descartarlo es el "éxito falso" del borde 8 trasladado a la interfaz: el
 * usuario ve su texto en pantalla y cree que se guardó.
 */
/**
 * AD2 — Llevaba `error: string | null`, y ese string era el **texto crudo de
 * Postgres**. `ActionState.error`, que llega del servidor, lleva el mensaje ya
 * traducido: mismo nombre, mismo tipo, significado opuesto. Los dos se pasaban a
 * `avisarTexto(...)` en la vista, y confundirlos era un cambio de una palabra que
 * ni el compilador ni once iteraciones de guardas podían impedir.
 *
 * Ahora lleva la **clase**, que es lo que la vista necesita para pintar y para
 * afinar. No hay texto crudo que filtrar, así que `avisarTexto(r.error)` ni
 * siquiera compila.
 */
export type Result<T> = { data: T; clase: Clase | null; code: string | null }

/** I13 — ninguna llamada de red sin cota (D.6). */
const TIMEOUT_MS = 10_000
const withTimeout = () => AbortSignal.timeout(TIMEOUT_MS)

/**
 * Lecturas de la lista: los borrados lógicos quedan fuera (R8).
 *
 * AE1 — Hacía `throw error`, y ése era **el objeto crudo de la base saliendo del
 * módulo**. La revisión lo midió: en `GroupView.tsx` lo recoge un `.catch`, y
 * `String(e)` pinta `PostgrestError: permission denied for table items` con la
 * suite entera en verde. El objeto no se puede filtrar si no sale, así que no
 * sale: esta función ya no lanza nunca y devuelve lo mismo que sus hermanas.
 */
export async function activeItems(
  client: SupabaseClient, groupId: string,
): Promise<Result<Item[]>> {
  try {
    const { data, error } = await client
      .from('items').select('*')
      .eq('group_id', groupId).is('deleted_at', null)
      .order('created_at', { ascending: true })
      .abortSignal(withTimeout())
    return { data: (data ?? []) as Item[], clase: claseDe(error), code: error?.code ?? null }
  } catch (fallo) {
    // Una promesa rechazada —red caída, cota agotada— también traía el objeto
    // hasta aquí. Se clasifica y se suelta.
    // `claseDe` nunca devuelve `null` para un error de verdad, así que aquí no
    // hace falta comodín: el `?? 'red'` que había era una rama inalcanzable.
    return { data: [], clase: claseDe(fallo), code: null }
  }
}

export async function addItem(
  client: SupabaseClient, groupId: string, createdBy: string, name: string, quantity?: string | null,
): Promise<Result<Item | null>> {
  const { data, error } = await client
    .from('items')
    .insert({ group_id: groupId, name, quantity: quantity ?? null, created_by: createdBy })
    .select('*').abortSignal(withTimeout()).single()
  return { data: (data as Item) ?? null, clase: claseDe(error), code: error?.code ?? null }
}

/**
 * Borde 8 — el filtro `deleted_at is null` es lo que hace que editar un ítem
 * ya borrado afecte a 0 filas en vez de resucitarlo para todo el grupo.
 */
/**
 * V1 — Devuelve la FILA, no sólo el recuento. La vista soltaba el borrador y se
 * quedaba esperando a que el canal trajera el cambio; con el canal degradado
 * —estado que la app detecta y anuncia— no llega nunca, y el campo volvía al
 * valor viejo: una edición correcta pintada como fallo, justo en el camino de
 * mala cobertura para el que existe esta app. De paso ahorra un viaje al canal.
 */
export async function updateItem(
  client: SupabaseClient, id: string, patch: { name?: string; quantity?: string | null },
): Promise<Result<Item | null>> {
  const { data, error } = await client
    .from('items').update(patch).eq('id', id).is('deleted_at', null).select('*')
    .abortSignal(withTimeout())
  // W7 — `data` era el recuento **y** además se devolvía la fila: dos campos para
  // el mismo hecho, y la vista ramificaba por los dos. La fila ausente ya dice
  // que no se tocó ninguna.
  return { data: ((data ?? []) as Item[])[0] ?? null, clase: claseDe(error), code: error?.code ?? null }
}

/** R8/R16 — borrar es un UPDATE. No hay política DELETE que lo permita. */
export async function softDeleteItem(client: SupabaseClient, id: string): Promise<Result<number>> {
  const { data, error } = await client
    .from('items').update({ deleted_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).select('id')
    .abortSignal(withTimeout())
  return { data: data?.length ?? 0, clase: claseDe(error), code: error?.code ?? null }
}

/**
 * J6/D.2 — el refresco de `onResync` cruza un `await`: los eventos que llegan
 * mientras está en vuelo ya se han aplicado al estado, y sustituir la lista por
 * la respuesta los borraría hasta el siguiente evento. Se fusiona quedándose
 * con la versión más reciente de cada ítem.
 */
export function mergeItems(fresh: Item[], current: Item[]): Item[] {
  const byId = new Map(fresh.map(i => [i.id, i]))
  for (const item of current) {
    const known = byId.get(item.id)
    if (!known || item.updated_at > known.updated_at) byId.set(item.id, item)
  }
  return [...byId.values()]
    .filter(i => !i.deleted_at)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/**
 * R7 — Espejo exacto del `translate` que usa el índice único de la base:
 * minúsculas, sin tildes, **con la ñ intacta**. Se escribe con el mismo par de
 * cadenas y no con `normalize('NFD')`, porque NFD descompone la ñ en n + tilde y
 * el barrido de diacríticos se la lleva por delante: medido, `Piña` salía `pina`,
 * que es justo lo contrario de lo que se decidió.
 *
 * Aquí NO decide nada: quien decide si hay duplicado es el índice, con `23505`.
 * Esto sólo localiza en pantalla la fila que ya estaba, para llevar el foco a su
 * cantidad.
 */
/**
 * La mitad mayúscula es inalcanzable —aquí se hace `toLowerCase()` antes, y la
 * base hace `lower(btrim(…))` antes de su `translate`— y se conserva a propósito:
 * estas dos cadenas espejan carácter a carácter las del índice único, y recortar
 * una obligaría a reconstruirlo para que siguieran coincidiendo.
 */
const DE = 'áàäâãéèëêíìïîóòöôõúùüûçÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÇ'
const A  = 'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC'

export function normNombre(t: string): string {
  // S12 — `btrim` de Postgres recorta **espacios**, no todo el espacio en blanco:
  // `trim()` de JS se lleva además tabuladores, saltos y el espacio duro, y con
  // eso fundía en pantalla lo que la base separa.
  const bajo = t.replace(/^ +| +$/g, '').toLowerCase()
  let salida = ''
  for (const c of bajo) {
    const i = DE.indexOf(c)
    salida += i >= 0 ? A[i] : c
  }
  return salida
}

export const mismoProducto = (a: string, b: string) => normNombre(a) === normNombre(b)
