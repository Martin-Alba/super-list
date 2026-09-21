import { describe, it, expect } from 'vitest'
import { comoLocation, safeNext } from '../lib/routes'

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

/**
 * Q5 / DoD 27 — `encodeURI` a secas doble-codificaba lo ya percent-encoded, y es
 * alcanzable: el middleware escribe `pathname + search` ya codificado. Pero sin
 * codificar nada, un carácter no-ASCII hace que Node rechace la cabecera con un
 * 500 que quema el código de un solo uso. Se codifica sólo cuando hace falta.
 */
describe('Q5 el destino no se codifica dos veces', () => {
  it.each([
    ['/g/a%20b', '/g/a%20b'],
    ['/g/x?q=a%20b', '/g/x?q=a%20b'],
    ['/login?error=auth', '/login?error=auth'],
    ['/', '/'],
  ])('deja intacto %s', (entrada, esperado) => {
    expect(comoLocation(entrada)).toBe(esperado)
  })

  it('sigue codificando lo que rompería la cabecera', () => {
    expect(comoLocation('/\u2044\u2044evil.com')).toBe('/%E2%81%84%E2%81%84evil.com')
    expect(comoLocation('/g/día')).toContain('%')
  })

  it('lo codificado sigue sin salir del sitio', () => {
    expect(comoLocation(safeNext('//example.com'))).toBe('/')
  })

  // S6 / DoD 33 — la puerta que ABRIÓ Q5 y que su propia iteración no probó
  // (R-C). Codificar la cadena entera doble-codificaba; no codificar nada dejaba
  // pasar crudos caracteres que rompen la cabecera.
  it('mezcla de triplete y no-ASCII: conserva uno y codifica el otro', () => {
    const r = comoLocation('/g/a%20b/día')
    expect(r, 'doble-codificó el triplete').toContain('a%20b')
    expect(r, 'dejó pasar la tilde cruda').toContain('%C3%AD')
    expect(r).not.toContain('%2520')
  })

  it('un % suelto no viaja como triplete malformado', () => {
    expect(comoLocation('/g/100%')).toBe('/g/100%25')
    expect(comoLocation('/g/%zz')).toBe('/g/%25zz')
  })

  it.each(['"', '<', '>', '{', '}', '|', '^', '`', ' '])('codifica %j, que rompería la cabecera', (c) => {
    expect(comoLocation(`/g/${c}`)).not.toContain(c)
  })

  // La puerta que abrió el propio arreglo de S6: recorrer unidades UTF-16 parte
  // los pares suplentes y `encodeURIComponent` lanza sobre cada mitad. Es el 500
  // de N1, reintroducido, y alcanzable con un enlace a `/login?next=…`.
  it.each(['/g/😀', '/g/𝕏', '/g/a%20b/😀', '/g/👨‍👩‍👧'])('no lanza con %s', (entrada) => {
    expect(() => comoLocation(entrada)).not.toThrow()
    expect(comoLocation(entrada)).toMatch(/^%|^\//)
  })

  it('un emoji se codifica entero, no por mitades', () => {
    expect(comoLocation('/g/😀')).toBe('/g/%F0%9F%98%80')
  })
})
