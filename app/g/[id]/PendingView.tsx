'use client'

import { useRouter } from 'next/navigation'
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
      // Aceptado: entra. Rechazado o expulsado: fuera, sin esperar a que un
      // refresco acabe produciendo un 404 (A.3, fallar cerrado).
      if (row.status === 'active') router.refresh()
      else router.replace('/')
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
          Sin conexión en vivo. Recarga la página para comprobar si ya te han aceptado.
        </p>
      )}
    </main>
  )
}
