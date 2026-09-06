import { describe, it, expect } from 'vitest'
import globalSetup from '../e2e/global-setup'

/**
 * J15 / DoD 49 — un calentamiento que devuelve exito cuando no ha calentado
 * nada convierte 18 fallos en un misterio: la suite falla por un motivo que no
 * es el suyo. Debe fallar donde esta el problema.
 */
describe('J15 el calentamiento falla ruidosamente', () => {
  it('si el servidor no responde, lanza en vez de devolver exito', async () => {
    process.env.E2E_WARMUP_MS = '400'
    // Puerto sin nada escuchando: el fallo es real, no simulado.
    process.env.E2E_BASE_URL = 'http://127.0.0.1:9'
    await expect(globalSetup()).rejects.toThrow(/No se pudo calentar/)
    delete process.env.E2E_BASE_URL
    delete process.env.E2E_WARMUP_MS
  })
})
