import type { SupabaseClient } from '@supabase/supabase-js'
import { activeItems, type Item } from '@/lib/items'

export type Membership = { user_id: string; status: string; role: string }
export type Profile = { id: string; display_name: string | null }

export type GroupPayload = {
  group: { id: string; name: string } | null
  items: Item[]
  members: Membership[]
  profiles: Profile[]
  /**
   * K3 — un `?? []` convertía un fallo de consulta en "no hay nadie": el owner
   * veía cero miembros y ningún contador de solicitudes, indistinguible de que
   * nadie hubiera pedido entrar. Es la misma clase de fallo silencioso que I6 y
   * J1 existen para matar, así que el fallo viaja y la vista lo dice.
   */
  error: string | null
}

/**
 * J5 — esto vive fuera del componente de página a propósito: es lo que decide
 * qué datos cruzan al cliente, y un test que reejecuta una *copia* de la
 * consulta no prueba nada. La página llama a esta función, así que el test la
 * llama a ella.
 *
 * I10 — las tres consultas son independientes y van a la vez.
 * I9 — los perfiles llegan embebidos en la membresía, acotados al grupo por
 * construcción. La relación se nombra explícitamente porque `group_members`
 * tiene DOS claves foráneas a `profiles` (`user_id` y `decided_by`) y sin
 * desambiguar PostgREST devuelve error, dejando la lista de miembros vacía.
 */
export async function loadGroupPayload(
  supabase: SupabaseClient, groupId: string,
): Promise<GroupPayload> {
  const [groupRes, itemsRes, membersRes] = await Promise.all([
    supabase.from('groups').select('id, name').eq('id', groupId).maybeSingle(),
    // Criterio unificado: las tres devuelven su fallo. Antes `activeItems`
    // lanzaba (y tumbaba la página) mientras sus hermanas se lo tragaban.
    activeItems(supabase, groupId)
      .then(data => ({ data, error: null as string | null }))
      .catch((e: unknown) => ({ data: [] as Item[], error: e instanceof Error ? e.message : String(e) })),
    supabase.from('group_members')
      .select('user_id, status, role, profiles!group_members_user_id_fkey(id, display_name)')
      .eq('group_id', groupId),
  ])

  const items = itemsRes.data
  const error = groupRes.error?.message ?? itemsRes.error ?? membersRes.error?.message ?? null
  const rows = (membersRes.data ?? []) as Array<Membership & { profiles: Profile | Profile[] | null }>
  const members = rows.map(({ user_id, status, role }) => ({ user_id, status, role }))
  const profiles = rows
    .map(r => (Array.isArray(r.profiles) ? r.profiles[0] : r.profiles))
    .filter((p): p is Profile => Boolean(p))

  return { group: groupRes.data, items, members, profiles, error }
}
