/**
 * `live` = el canal entrega. `degraded` = se cayó y lo que se ve puede estar
 * viejo. I6 — sin observar el estado, una caída del canal congela la lista sin
 * ninguna señal: exactamente el fallo silencioso que B.2 quiere evitar.
 */
export type ChannelState = 'connecting' | 'live' | 'degraded'

/**
 * Salud del socket y salud del canal son dos señales distintas, y confundirlas
 * fue el defecto de la iteración anterior: el sondeo de conexión reescribía a
 * `connecting` el `degraded` que el canal acababa de poner, así que el aviso
 * vivía dos segundos y no volvía nunca.
 *
 * La regla que lo cierra: **el sondeo sólo puede ENTRAR en degradado.** Salir de
 * degradado exige un `SUBSCRIBED`, que es la única señal que prueba de verdad
 * que los eventos vuelven a llegar. Un socket vivo no demuestra nada: el canal
 * puede estar rechazado por un JWT vencido con la conexión intacta.
 */
export type ChannelSignal =
  | { type: 'subscribed' }
  | { type: 'channel-failed' }
  | { type: 'socket-poll'; connected: boolean }

export function nextChannelState(prev: ChannelState, signal: ChannelSignal): ChannelState {
  switch (signal.type) {
    case 'subscribed':
      return 'live'
    case 'channel-failed':
      return 'degraded'
    case 'socket-poll':
      return signal.connected ? prev : 'degraded'
  }
}
