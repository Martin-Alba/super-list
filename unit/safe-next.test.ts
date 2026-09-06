import { describe, it, expect } from 'vitest'
import { safeNext } from '../lib/routes'

// I4 — medido antes del cambio: `?next=//example.com/` redirigía a
// http://example.com/. Dominio legítimo, destino ajeno.
describe('I4 destino de redirección acotado', () => {
  it.each([
    ['/g/abc', '/g/abc'],
    ['/login?x=1', '/login?x=1'],
    ['/invite/tok3n', '/invite/tok3n'],
  ])('conserva el destino interno %s', (input, expected) => {
    expect(safeNext(input)).toBe(expected)
  })

  it.each([
    '//example.com/',
    '/\\example.com/',
    'https://example.com',
    '//attacker',
    'javascript:alert(1)',
    'g/abc',
    '',
  ])('neutraliza %j', (input) => {
    expect(safeNext(input)).toBe('/')
  })

  it('neutraliza un carácter de control colado tras la barra', () => {
    expect(safeNext('//example.com')).toBe('/')
    expect(safeNext('/\n//example.com')).toBe('/')
  })

  it.each([null, undefined])('sin destino devuelve la raíz (%s)', (input) => {
    expect(safeNext(input)).toBe('/')
  })
})
