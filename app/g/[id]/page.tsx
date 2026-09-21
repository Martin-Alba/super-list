import { notFound } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { loadGroupPayload } from '@/lib/groupPayload'
import { GroupView } from './GroupView'
import { PendingView } from './PendingView'

export default async function GroupPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) notFound()

  // Cada quien lee siempre su propia fila, en cualquier estado.
  const { data: me } = await supabase
    .from('group_members').select('status, role')
    .eq('group_id', id).eq('user_id', user.id).maybeSingle()

  if (me?.status === 'pending') return <PendingView groupId={id} userId={user.id} />

  // A.3 / borde 5 — para quien no es miembro activo el grupo no existe.
  // Un 403 confirmaría que existe.
  if (me?.status !== 'active') notFound()

  const { group, items, members, profiles, clase } = await loadGroupPayload(supabase, id)
  // U6 — medido en el payload de Flight: el mensaje crudo de Postgres viajaba
  // entero al navegador. No se enseñaba, pero llegaba.
  // AD3 — Y ya no existe: del servidor sale la **clase**, siete valores fijos.
  // La página no traduce ni reclasifica; la vista pinta desde la etiqueta.

  // L3 — un fallo de consulta no es "el grupo no existe". Antes los dos daban
  // `null` y respondian 404: a un miembro legitimo se le decia que su grupo no
  // existe por una caida pasajera. El 404 queda para la ausencia real.
  if (!group && !clase) notFound()

  return (
    <GroupView
      group={group ?? { id, name: 'Grupo' }}
      initialItems={items}
      members={members}
      profiles={profiles}
      me={{ id: user.id, role: me.role }}
      loadClase={clase}
    />
  )
}
