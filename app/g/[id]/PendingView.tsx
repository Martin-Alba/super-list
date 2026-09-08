'use client'

import { useRouter } from 'next/navigation'
import { SIN_CONEXION_ESPERA } from '@/lib/errors'
import { createClient } from '@/lib/supabase/client'
import { useGroupChannel } from '@/lib/useGroupChannel'

/** R5 — el pendiente no ve la lista. Se entera de la decisión en vivo. */
export function PendingView({ groupId, userId }: { groupId: string; userId: string }) {
  const router = useRouter()

  // I8 — la misma suscripción que el grupo, sin duplicar el bloque.
  // I7 — al quedar suscrito se revalida: si la decisión se tomó durante la
  // ventana previa, sin esto la espera no terminaría nunca.
  const channelState = useGroupChannel(groupId, {
    onMembership: (row) => {
      if (row.user_id !== userId) return
      // U1 — mismo motivo que en la vista de grupo: el primer evento puede ser
      // uno anterior a la suscripción. Aceptado: entra. Para lo demás se
      // confirma contra la fuente antes de sacar a nadie.
      if (row.status === 'active') { router.refresh(); return }
      void createClient()
        .from('group_members').select('status')
        .eq('group_id', groupId).eq('user_id', userId).maybeSingle()
        .then(({ data }) => {
          if (data?.status === 'active') router.refresh()
          else if (data?.status !== 'pending') router.replace('/')
        })
    },
    onResync: () => router.refresh(),
  })

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6 text-center">
      <h1 className="text-2xl font-semibold" data-testid="pending">Esperando aprobación</h1>
      <p className="text-neutral-500">
        Ya has pedido entrar. Cuando quien creó el grupo lo acepte, verás la lista aquí.
      </p>
      {channelState === 'degraded' && (
        <p role="status" data-testid="channel-degraded" className="text-sm text-amber-800">
          {SIN_CONEXION_ESPERA}
        </p>
      )}
    </main>
  )
}
