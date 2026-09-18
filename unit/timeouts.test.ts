import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { boundedFetch } from '../lib/boundedFetch'

/**
 * J4 / DoD 38 — D.6. No se comprueba con un grep sobre 13 sitios de llamada:
 * se levanta un servidor que no contesta nunca y se mide que la llamada
 * **rechaza**, que es lo que el requisito promete.
 */
let server: Server
const hangingUrl = async () => {
  server = createServer(() => { /* nunca responde: eso es el punto */ })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return `http://127.0.0.1:${port}/`
}

afterAll(() => { server?.close() })

describe('J4 toda llamada de red tiene cota', () => {
  it('una petición que no responde rechaza en vez de colgarse', async () => {
    const url = await hangingUrl()
    const started = Date.now()
    await expect(boundedFetch(300)(url)).rejects.toThrow()
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  it('respeta también la señal de quien llama', async () => {
    const url = await hangingUrl()
    const ac = new AbortController()
    const promise = boundedFetch(60_000)(url, { signal: ac.signal })
    ac.abort()
    await expect(promise).rejects.toThrow()
  })

  it('una petición que sí responde pasa sin estorbo', async () => {
    const ok = createServer((_req, res) => { res.end('bien') })
    await new Promise<void>(r => ok.listen(0, '127.0.0.1', r))
    const { port } = ok.address() as { port: number }
    const res = await boundedFetch(5_000)(`http://127.0.0.1:${port}/`)
    expect(await res.text()).toBe('bien')
    ok.close()
  })

  // Estructural: la cota sólo sirve si los clientes reales la usan. Con un
  // control positivo, para que el banco distinga detectar de no detectar nada.
  const FACTORIES = ['lib/supabase/client.ts', 'lib/supabase/server.ts', 'lib/supabase/middleware.ts']

  it.each(FACTORIES)('%s construye su cliente con el fetch acotado', (file) => {
    const src = readFileSync(file, 'utf8')
    expect(src).toContain('boundedFetch')
    // iter4 R4 — Y el patrón se ciñe a lo que promete: medido, la versión anterior
    // aceptaba `NETWORK_TIMEOUT_MS * 100` —cota de 1.000 s, o sea ninguna—, `+ 3_600_000`
    // y hasta otro identificador que empezara igual. Las tres están abajo como sondas.
    // Spec C / iter3 R2 — Se acepta también `boundedFetch(NETWORK_TIMEOUT_MS, …)`: la
    // guarda de ruta le pasa además una señal de corte para abortar la operación entera
    // cuando vence el veredicto. Se admite la constante declarada, **no** un número
    // cualquiera: un `boundedFetch(999_999)` sigue poniendo esto rojo.
    expect(src).toMatch(/global:\s*\{\s*fetch:\s*boundedFetch\(\s*(\)|NETWORK_TIMEOUT_MS\s*[,)])/)
  })

  it('control positivo: el patrón detecta su ausencia', () => {
    const sinCota = 'const c = createServerClient(url, key, { cookies })'
    expect(sinCota).not.toMatch(/global:\s*\{\s*fetch:\s*boundedFetch\(\s*(\)|NETWORK_TIMEOUT_MS\s*[,)])/)

    /**
     * iter4 R4 — Sondas (§E.2): tres formas que **parecen** la cota declarada y no lo son.
     * El control de arriba sólo probaba que el patrón exige la palabra `boundedFetch`, así
     * que no distinguía el patrón estrecho del ancho: éstas sí.
     */
    for (const falsa of [
      'global: { fetch: boundedFetch(NETWORK_TIMEOUT_MS * 100) }',
      'global: { fetch: boundedFetch(NETWORK_TIMEOUT_MS + 3_600_000) }',
      'global: { fetch: boundedFetch(NETWORK_TIMEOUT_MSX) }',
    ]) {
      expect(falsa, `la guarda acepta una cota que no es la declarada: ${falsa}`)
        .not.toMatch(/global:\s*\{\s*fetch:\s*boundedFetch\(\s*(\)|NETWORK_TIMEOUT_MS\s*[,)])/)
    }
  })
})
