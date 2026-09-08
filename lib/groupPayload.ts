import type { SupabaseClient } from '@supabase/supabase-js'
import { activeItems, type Item } from '@/lib/items'
import { claseDe, type Clase } from '@/lib/errors'

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
  /**
   * AD3 — Era el **texto crudo** de Postgres, arrastrado hasta la vista para que
   * allí alguien lo tradujera. Ahora viaja la clase: no hay texto que filtrar, y
   * la página no tiene que reclasificar nada para pintarlo.
   */
  /**
   * AE6 — Aquí iba también `errorCode`, y desde AD3 **no lo consumía nadie**: la
   * página dejó de desestructurarlo y lo único que lo defendía era un test que
   * buscaba la palabra en el fuente. Un campo que viaja en el payload de Flight
   * en cada carga y no lo lee nadie es peso, no información.
   */
  clase: Clase | null
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
    // AD3 — aquí se leía `e.message` para arrastrarlo hasta la vista.
    // AE1 — y aquí se recogía el OBJETO crudo con un `catch`. `activeItems` ya no
    // lanza: devuelve su clase como las otras dos, y este envoltorio desaparece.
    activeItems(supabase, groupId),
    supabase.from('group_members')
      .select('user_id, status, role, profiles!group_members_user_id_fkey(id, display_name)')
      .eq('group_id', groupId),
  ])

  const items = itemsRes.data
  const clase = claseDe(groupRes.error) ?? itemsRes.clase ?? claseDe(membersRes.error)
  const rows = (membersRes.data ?? []) as Array<Membership & { profiles: Profile | Profile[] | null }>
  const members = rows.map(({ user_id, status, role }) => ({ user_id, status, role }))
  const profiles = rows
    .map(r => (Array.isArray(r.profiles) ? r.profiles[0] : r.profiles))
    .filter((p): p is Profile => Boolean(p))

  return { group: groupRes.data, items, members, profiles, clase }
}
