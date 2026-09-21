import { describe, it, expect } from 'vitest'
import { normNombre, mismoProducto } from '../lib/items'

/**
 * R7 / DoD 9 — Espejo del `translate` de la base. Se prueba en las dos
 * direcciones: lo que debe fundirse y lo que NO. Sin la segunda mitad, una
 * normalización que devolviera siempre la cadena vacía pasaría la primera.
 */
describe('R7 mismas letras, misma palabra', () => {
  it.each([
    ['Cebolla', 'cebolla'], ['  cebolla  ', 'cebolla'], ['CEBOLLA', 'cebolla'],
    ['Plátano', 'platano'], ['plátano', 'PLATANO'], ['Açúcar', 'acucar'],
  ])('%j y %j son el mismo producto', (a, b) => {
    expect(mismoProducto(a, b)).toBe(true)
  })

  it.each([
    ['Piña', 'pina'], ['año', 'ano'], ['ñoquis', 'noquis'],
    ['cebolla', 'cebollas'], ['pan', 'pan integral'],
  ])('%j y %j NO son el mismo producto', (a, b) => {
    expect(mismoProducto(a, b)).toBe(false)
  })

  it('la ñ sobrevive a la normalización', () => {
    expect(normNombre('Piña')).toBe('piña')
    expect(normNombre('AÑO')).toBe('año')
  })
})
