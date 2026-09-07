import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * V6 / DoD 51 — R-C se pidió en tres iteraciones seguidas (S14, T6, U12) y en
 * las tres se quedó en la spec, que se borra al cerrar el ciclo. La constitución
 * es lo único que sobrevive, así que aquí se fija que está.
 */
const CONSTITUCION = readFileSync('CLAUDE.md', 'utf8')

/**
 * W2 — La comprobación vive en una función para que la sonda pueda EJERCITARLA.
 * La versión anterior mutaba el texto con `String.replace` y afirmaba que ya no
 * casaba: una tautología sobre la librería estándar, que pasaba incluso con la
 * constitución vacía. Era el "test que no puede fallar" de §E.3, escrito por la
 * iteración cuya meta era que cada guarda se pusiera roja cuando debe.
 */
export function exigeRC(texto: string): void {
  if (!/puerta que\s+abre/i.test(texto)) {
    throw new Error('R-C no está en la constitución: se pierde al borrar la spec')
  }
  if (!/se conserva/.test(texto)) {
    throw new Error('R-C no dice que el test de la puerta que se cierra se conserva')
  }
  if (!/falla siempre y no la mitad/.test(texto)) {
    throw new Error('R-C no exige demostrar el rojo de forma repetida')
  }
}

describe('V6 la constitución conserva las reglas que el ciclo aprendió', () => {
  it('§E contiene R-C completa', () => {
    expect(() => exigeRC(CONSTITUCION)).not.toThrow()
  })

  it.each([
    ['E.1', /capa que su requisito nombra/],
    ['E.2', /sonda que debe ser cazada/],
    ['E.3', /no puede fallar es peor que ninguno/],
  ])('§%s sigue en pie', (_n, patron) => {
    expect(CONSTITUCION).toMatch(patron)
  })

  // Sonda (§E.2): se ejercita LA GUARDA sobre textos construidos para violarla.
  it.each([
    ['', /no está en la constitución/],
    ['§E.4 probar por la puerta que abre. Y ya.', /se conserva/],
    ['puerta que abre; el test se conserva.', /rojo de forma repetida/],
  ])('la guarda lanza sobre %j', (mutante, motivo) => {
    expect(() => exigeRC(mutante)).toThrow(motivo)
  })
})
