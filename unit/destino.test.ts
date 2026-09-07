import { describe, it, expect } from 'vitest'
import { hostDelDestino } from '../e2e/destino'

/**
 * W5 / DoD 65 — El helper vivía dentro del fichero de test y nadie lo probaba.
 * Devolvía `null` —"no salta de sitio"— para `/\evil.com/login`, y los seis
 * tests parametrizados por `Host` sólo afirman `null` más `toContain('/login')`:
 * un destino de esa forma pasaba ambas comprobaciones.
 */
describe('W5 el destino delata las dos formas protocol-relative', () => {
  it.each([
    ['//evil.com/login', 'evil.com'],
    ['/\\evil.com/login', 'evil.com'],
    ['//evil.com', 'evil.com'],
    ['/\\evil.com', 'evil.com'],
    ['https://evil.com/x', 'evil.com'],
  ])('delata %j como %s', (location, esperado) => {
    expect(hostDelDestino(location)).toBe(esperado)
  })

  it.each(['/login?error=auth', '/g/abc', '/', '/g/a%20b'])('acepta el destino interno %j', (location) => {
    expect(hostDelDestino(location)).toBe(null)
  })

  it('sin Location no hay salto', () => {
    expect(hostDelDestino(null)).toBe(null)
    expect(hostDelDestino('')).toBe(null)
  })

  // Sonda (§E.2): las dos formas que `safeNext` nombra deben quedar cazadas por
  // el helper, no sólo por la capa de abajo (§E.1 prohíbe apoyarse en ella).
  it('un Location ilegible tampoco pasa por bueno', () => {
    expect(hostDelDestino('http://')).toBe('ilegible')
  })
})
