import { describe, it, expect } from 'vitest'
import { nextChannelState, type ChannelState } from '../lib/channelState'

/**
 * J1 / DoD 35 — el defecto que introdujo la iteracion anterior: el sondeo de
 * conexion borraba el aviso que el canal acababa de poner. Con el socket sano y
 * el canal rechazado (JWT vencido, politica que deniega), el aviso vivia dos
 * segundos y no volvia. Aqui se prueba la regla que lo cierra.
 */
const poll = (connected: boolean) => ({ type: 'socket-poll' as const, connected })

describe('J1 maquina de estados del canal', () => {
  it('un canal rechazado deja el estado en degradado', () => {
    expect(nextChannelState('live', { type: 'channel-failed' })).toBe('degraded')
  })

  it('el sondeo NO saca de degradado aunque el socket este sano', () => {
    // Este es el caso exacto que fallaba: socket vivo, canal muerto.
    let state: ChannelState = 'live'
    state = nextChannelState(state, { type: 'channel-failed' })
    for (let i = 0; i < 10; i++) state = nextChannelState(state, poll(true))
    expect(state).toBe('degraded')
  })

  it('solo un SUBSCRIBED devuelve a vivo', () => {
    let state: ChannelState = 'degraded'
    state = nextChannelState(state, poll(true))
    expect(state).toBe('degraded')
    state = nextChannelState(state, { type: 'subscribed' })
    expect(state).toBe('live')
  })

  it('un socket caido degrada desde cualquier estado', () => {
    expect(nextChannelState('live', poll(false))).toBe('degraded')
    expect(nextChannelState('connecting', poll(false))).toBe('degraded')
    expect(nextChannelState('degraded', poll(false))).toBe('degraded')
  })

  it('con socket sano el sondeo no altera un estado que no sea peor', () => {
    expect(nextChannelState('live', poll(true))).toBe('live')
    expect(nextChannelState('connecting', poll(true))).toBe('connecting')
  })
})
