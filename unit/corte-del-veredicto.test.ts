import { describe, it, expect, vi, afterEach } from 'vitest'
import { boundedFetch, NETWORK_TIMEOUT_MS } from '@/lib/boundedFetch'

/**
 * Spec C / iteración 3, R2 — **La petición en vuelo se aborta, no se abandona.**
 *
 * Medido con el cliente real antes de escribir esto: abandonándola, una rotación de token
 * más lenta que la cota del veredicto se completaba arriba —la API servía
 * `/auth/v1/token`— mientras la respuesta ya había salido con `set-cookie: []`. El refresh
 * token se consumía y el navegador se quedaba con el viejo: una API lenta no mandaba al
 * login una vez, **cerraba la sesión**.
 *
 * Capa (§E.1): lo que el requisito nombra es el transporte del cliente, así que se ataca
 * `boundedFetch` directamente. En `unit/guarda-sesion.test.ts` el cliente entero está
 * mockeado y esta señal no existe — por eso la pasada de mutación dejaba vivas las dos
 * mutaciones del aborto, y por eso este fichero existe.
 */
afterEach(() => { vi.unstubAllGlobals() })

/** Un `fetch` que no contesta nunca y que respeta la señal que le den. */
const colgado = () => vi.fn((_u: unknown, init?: { signal?: AbortSignal }) =>
  new Promise((_, rechaza) => {
    init?.signal?.addEventListener('abort',
      () => rechaza(Object.assign(new Error('abortada'), { name: 'AbortError' })))
  }))

describe('R2 · la señal externa corta la operación entera', () => {
  it('abortar el controlador rechaza una petición en vuelo', async () => {
    vi.stubGlobal('fetch', colgado())
    const corte = new AbortController()
    const enVuelo = boundedFetch(NETWORK_TIMEOUT_MS, corte.signal)('http://x/')
    corte.abort()
    await expect(enVuelo, 'la petición siguió en vuelo tras cortar: puede rotar el token después de responder')
      .rejects.toThrow(/abortada/)
  })

  // Sonda (§E.2): sin la señal externa, la misma petición sigue viva. Si este caso se
  // pusiera verde, el de arriba no probaría nada.
  it('sin señal externa, cortar no la toca', async () => {
    vi.stubGlobal('fetch', colgado())
    const corte = new AbortController()
    let resuelta = false
    void boundedFetch(NETWORK_TIMEOUT_MS)('http://x/').catch(() => { resuelta = true })
    corte.abort()
    await new Promise((ok) => setTimeout(ok, 10))
    expect(resuelta, 'el doble no está midiendo lo que se cree').toBe(false)
  })

  // Y la cota del transporte sigue en pie: la señal externa se suma, no sustituye.
  it('la cota del transporte sigue abortando por su cuenta', async () => {
    vi.stubGlobal('fetch', colgado())
    vi.useFakeTimers()
    try {
      const corte = new AbortController()
      const enVuelo = boundedFetch(50, corte.signal)('http://x/')
      const esperado = expect(enVuelo).rejects.toThrow(/abortada/)
      await vi.advanceTimersByTimeAsync(100)
      await esperado
    } finally { vi.useRealTimers() }
  })
})
