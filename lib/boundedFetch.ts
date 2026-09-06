export const NETWORK_TIMEOUT_MS = 10_000

/**
 * D.6 — toda llamada de red con cota. Se pone en el `fetch` del cliente y no en
 * cada sitio de llamada por dos razones: cubre también lo que no admite
 * `AbortSignal` (las operaciones de auth, que van por su propio transporte), y
 * **aborta de verdad** la petición al vencer el plazo, en vez de dejarla en
 * vuelo mientras se resuelve una carrera contra reloj.
 *
 * Trece llamadas del render estaban sin acotar; ponerlas una a una habría
 * dejado la siguiente que alguien escriba igual de descubierta.
 */
export function boundedFetch(timeoutMs: number = NETWORK_TIMEOUT_MS): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    // Se respeta la señal de quien llama además de la nuestra: quien ya pasaba
    // un `abortSignal` por consulta sigue mandando.
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return fetch(input, { ...init, signal })
  }
}
