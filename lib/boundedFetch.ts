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
export function boundedFetch(
  timeoutMs: number = NETWORK_TIMEOUT_MS, externa?: AbortSignal,
): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    // Se respeta la señal de quien llama además de la nuestra: quien ya pasaba
    // un `abortSignal` por consulta sigue mandando.
    //
    // Spec C / iter3 R2 — Y una señal **externa** opcional, para quien necesita cortar la
    // operación entera y no cada intento: `getUser` reintenta por su cuenta, así que sin
    // esto una petición abandonada podía completar una rotación de token después de que
    // la respuesta ya hubiera salido, consumiendo el refresh token sin entregarlo.
    const propias = externa ? AbortSignal.any([timeout, externa]) : timeout
    const signal = init?.signal ? AbortSignal.any([init.signal, propias]) : propias
    return fetch(input, { ...init, signal })
  }
}
