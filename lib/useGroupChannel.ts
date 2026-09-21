'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { Item } from '@/lib/items'
import { nextChannelState, type ChannelState } from '@/lib/channelState'

export type { ChannelState } from '@/lib/channelState'

type Handlers = {
  /** Un ítem del grupo cambió (alta, edición o borrado lógico). */
  onItem?: (row: Item) => void
  /** Cambió alguna membresía del grupo — incluida la propia. */
  onMembership?: (row: { user_id: string; status: string }) => void
  /**
   * El canal acaba de quedar suscrito. I7 — entre el render del servidor y este
   * momento hay una ventana en la que los eventos no llegan a nadie; sin releer
   * aquí, lo ocurrido en ella se pierde para siempre en esta sesión.
   */
  onResync?: () => void
}

export function useGroupChannel(groupId: string, handlers: Handlers): ChannelState {
  const [state, setState] = useState<ChannelState>('connecting')

  // Los manejadores cambian en cada render; el canal no debe recrearse por eso.
  // La ref se actualiza en un efecto, no durante el render: mutarla al renderizar
  // rompe con render concurrente, donde un render puede descartarse.
  const ref = useRef(handlers)
  useEffect(() => { ref.current = handlers })

  useEffect(() => {
    const supabase = createClient()
    let channel: ReturnType<typeof supabase.channel> | null = null
    let cancelled = false

    /**
     * I8 — la spec pedía quitar este `getSession()` + `setAuth()` porque
     * supabase-js ya propaga el token al socket. **Verificado y restituido:**
     * al quitarlo, `realtime.spec.ts` vuelve a fallar. Con `createBrowserClient`
     * la sesión se lee de las cookies de forma asíncrona, y el socket llega a
     * conectarse antes de que exista token: entonces se autentica como anónimo,
     * RLS deniega todo evento y el canal igualmente informa `SUBSCRIBED`.
     * Lo que sí se conserva de I8 es la deduplicación: un único hook en vez de
     * dos bloques gemelos. Los dos `await` que esto añade son justamente la
     * ventana ciega que cubre `onResync` (I7).
     */
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (cancelled) return
      await supabase.realtime.setAuth(session?.access_token)
      if (cancelled) return

      channel = supabase
        .channel(`group:${groupId}`)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'items', filter: `group_id=eq.${groupId}` },
          (payload) => {
            const row = payload.new as Item
            if (row?.id) ref.current.onItem?.(row)
          })
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'group_members', filter: `group_id=eq.${groupId}` },
          (payload) => {
            const row = payload.new as { user_id?: string; status?: string }
            if (row?.user_id && row.status) ref.current.onMembership?.({ user_id: row.user_id, status: row.status })
          })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setState(prev => nextChannelState(prev, { type: 'subscribed' }))
            ref.current.onResync?.()
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setState(prev => nextChannelState(prev, { type: 'channel-failed' }))
          }
        })
    })().catch(() => {
      // K13 — si `getSession()` es abortada por la cota, el rechazo quedaba sin
      // manejar y el aviso tardaba hasta 2 s en llegar por el sondeo.
      setState(prev => nextChannelState(prev, { type: 'channel-failed' }))
    })

    // El callback de `subscribe` avisa de los fallos del canal, pero si lo que
    // se cae es el socket puede tardar varios latidos en notarse. El sondeo es
    // la señal más temprana — y sólo puede empeorar el estado, nunca mejorarlo.
    const poll = setInterval(() => {
      const connected = supabase.realtime.isConnected()
      setState(prev => nextChannelState(prev, { type: 'socket-poll', connected }))
    }, 2_000)

    return () => {
      cancelled = true
      clearInterval(poll)
      if (channel) void supabase.removeChannel(channel)
    }
  }, [groupId])

  return state
}
