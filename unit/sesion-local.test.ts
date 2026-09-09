import { describe, it, expect } from 'vitest'
import { haySesionLocal } from '@/lib/sesionLocal'

/**
 * K4 — La pregunta que el shell tenía que hacerse y no se hacía. Es una función
 * pura sobre la cadena de cookies a propósito: la respuesta tiene que existir sin
 * red —el escenario entero de esta entrega— y poder afirmarse sin navegador.
 */
describe('K4 hay sesión en el dispositivo', () => {
  it.each([
    ['la cookie tal cual', 'sb-127-auth-token=eyJhbGci'],
    ['partida en trozos', 'sb-127-auth-token.0=eyJhbG; sb-127-auth-token.1=Ci'],
    ['con otras delante', 'ph_x=1; sb-abcdefgh-auth-token=eyJ; otra=2'],
  ])('%s cuenta como sesión', (_n, cookies) => {
    expect(haySesionLocal(cookies)).toBe(true)
  })

  it.each([
    ['sin cookies', ''],
    ['sólo cookies ajenas', 'ph_x=1; theme=dark'],
    // Las sondas: parecerse no basta.
    ['un nombre que la contiene', 'no-sb-127-auth-token-viejo=1'],
    ['la cookie vacía', 'sb-127-auth-token='],
    ['sólo el nombre, sin valor', 'sb-127-auth-token'],
  ])('%s NO cuenta como sesión', (_n, cookies) => {
    expect(haySesionLocal(cookies), 'se dio por buena una sesión que no está').toBe(false)
  })
})
