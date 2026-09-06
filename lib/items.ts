import type { SupabaseClient } from '@supabase/supabase-js'

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
 * Descartarlo es el "éxito falso" del borde 8 trasladado a la interfaz: el
 * usuario ve su texto en pantalla y cree que se guardó.
 */
export type Result<T> = { data: T; error: string | null }

/** I13 — ninguna llamada de red sin cota (D.6). */
const TIMEOUT_MS = 10_000
const withTimeout = () => AbortSignal.timeout(TIMEOUT_MS)

/** Lecturas de la lista: los borrados lógicos quedan fuera (R8). */
export async function activeItems(client: SupabaseClient, groupId: string): Promise<Item[]> {
  const { data, error } = await client
    .from('items').select('*')
    .eq('group_id', groupId).is('deleted_at', null)
    .order('created_at', { ascending: true })
    .abortSignal(withTimeout())
  if (error) throw error
  return (data ?? []) as Item[]
}

export async function addItem(
  client: SupabaseClient, groupId: string, createdBy: string, name: string, quantity?: string | null,
): Promise<Result<Item | null>> {
  const { data, error } = await client
    .from('items')
    .insert({ group_id: groupId, name, quantity: quantity ?? null, created_by: createdBy })
    .select('*').abortSignal(withTimeout()).single()
  return { data: (data as Item) ?? null, error: error?.message ?? null }
}

/**
 * Borde 8 — el filtro `deleted_at is null` es lo que hace que editar un ítem
 * ya borrado afecte a 0 filas en vez de resucitarlo para todo el grupo.
 */
export async function updateItem(
  client: SupabaseClient, id: string, patch: { name?: string; quantity?: string | null },
): Promise<Result<number>> {
  const { data, error } = await client
    .from('items').update(patch).eq('id', id).is('deleted_at', null).select('id')
    .abortSignal(withTimeout())
  return { data: data?.length ?? 0, error: error?.message ?? null }
}

/** R8/R16 — borrar es un UPDATE. No hay política DELETE que lo permita. */
export async function softDeleteItem(client: SupabaseClient, id: string): Promise<Result<number>> {
  const { data, error } = await client
    .from('items').update({ deleted_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).select('id')
    .abortSignal(withTimeout())
  return { data: data?.length ?? 0, error: error?.message ?? null }
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
