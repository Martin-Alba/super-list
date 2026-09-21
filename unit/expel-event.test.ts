import { describe, it, expect } from 'vitest'
import { newUser, newGroup, sql } from './helpers'

/**
 * R7 — el mecanismo, aislado del navegador. La expulsión es un UPDATE de estado
 * y la política deja a cada quien leer su propia fila en cualquier estado: eso
 * es lo que hace que el evento le llegue al expulsado filtrado por RLS. Si esto
 * falla, ningún arreglo de interfaz puede salvar R7.
 */
describe('R7 el expulsado recibe el evento de su propia fila', () => {
  it('un UPDATE a removed llega al canal del expulsado', { timeout: 40_000 }, async () => {
    const owner = await newUser('ev-owner')
    const gid = await newGroup(owner)
    const { data: token } = await owner.client.rpc('create_invite', { p_group_id: gid })
    const guest = await newUser('ev-guest')
    await guest.client.rpc('request_join', { p_token: token })
    await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'active' })

    const received: Record<string, unknown>[] = []
    const channel = guest.client
      .channel(`test-expel:${gid}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'group_members', filter: `group_id=eq.${gid}` },
        payload => { received.push(payload.new as Record<string, unknown>) })

    await new Promise<void>((resolve, reject) => {
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') resolve()
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') reject(new Error(status))
      })
    })

    // K7 — `SUBSCRIBED` dice que el canal se registró, no que entregue: tras un
    // `supabase db reset` el servicio puede tardar en empezar a emitir. En vez
    // de ampliar un margen a ciegas se manda un cambio centinela y se espera a
    // verlo. A partir de ahí, lo que se mida es el comportamiento y no el
    // arranque del servicio.
    const seen = () => received.length
    for (let intento = 0; intento < 40 && seen() === 0; intento++) {
      await sql('update public.group_members set decided_at = now() where group_id=$1 and user_id=$2',
        [gid, guest.id])
      await new Promise(r => setTimeout(r, 500))
    }
    expect(seen(), 'el canal nunca empezó a entregar').toBeGreaterThan(0)

    const { error: rmErr } = await owner.client.rpc('decide_member', { p_group_id: gid, p_user_id: guest.id, p_decision: 'removed' })
    expect(rmErr).toBeNull()

    // El canal entrega tambien los cambios anteriores a la suscripcion que
    // siguen en el slot de replicacion, asi que hay que mirar el ULTIMO estado
    // de la propia fila, no el primero que aparezca.
    const mineNow = () => received.filter(r => r.user_id === guest.id).at(-1)
    // Con la tubería ya probada viva, este plazo mide el comportamiento.
    const deadline = Date.now() + 10_000
    while (mineNow()?.status !== 'removed' && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 150))
    }
    await guest.client.removeChannel(channel)

    const mine = mineNow()
    expect(mine, 'el expulsado no recibio ningun evento de su propia fila').toBeTruthy()
    expect(mine!.status).toBe('removed')
  })
})
