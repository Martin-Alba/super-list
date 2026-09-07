import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * S3 / DoD 31 — El código afirmaba en dos sitios que un riesgo quedaba anotado
 * en la deuda técnica. No estaba: el fichero no se había tocado. Un comentario
 * que miente sobre el estado de un riesgo es peor que no escribirlo, porque el
 * siguiente que lo lea dará por hecho que alguien se ocupó.
 *
 * Esta guarda no comprueba prosa: comprueba que cada riesgo que el código dice
 * haber registrado tiene entrada.
 */
const DEUDA = readFileSync('docs/TECHNICAL_DEBT.md', 'utf8')

const REGISTRADOS = [
  ['acumulación de verificadores PKCE', /verificadores PKCE se acumulan/i],
  ['la cota del sb_flow_id', /sb_flow_id[\s\S]*romper un login ajeno/i],
  ['lo revertido al reencuadrar', /Lo que se revirtió al reencuadrar/i],
  ['skip_nonce_check', /skip_nonce_check/],
  ['additional_redirect_urls', /additional_redirect_urls/],
  ['el estado real de esa entrada', /RESUELTO al separar los hosts/],
] as const

/**
 * AA11 — La comprobación vive en una función para que la sonda pueda
 * **ejercitarla**, no reimplementarla. Es el patrón que `unit/constitution.test.ts`
 * ya usaba y que estas dos guardas no seguían.
 */
export function exigirSinFalsedades(texto: string): void {
  if (/se genera con `Math\.random\(\)`, no con un CSPRNG/.test(texto)) {
    throw new Error('la deuda afirma que el identificador se genera con Math.random: es falso, usa crypto.getRandomValues')
  }
}

describe('S3 lo que el código dice que está en la deuda, está', () => {
  it.each(REGISTRADOS)('%s tiene entrada', (_nombre, patron) => {
    expect(DEUDA).toMatch(patron)
  })

  it('cada riesgo trae su cota, no sólo el enunciado', () => {
    // T5 — antes esto exigía que la deuda dijera `Math.random`, que es FALSO:
    // el identificador usa `crypto.getRandomValues`. El único test cuyo
    // propósito es que la deuda no mienta estaba fijando el error.
    expect(DEUDA, 'la deuda no dice que el identificador viaja').toMatch(/s[íi] viaja/i)
    // U6 — antes era una alternancia con `|`, y por eso era inerte: un
    // documento que afirmara lo falso Y mencionara `crypto.getRandomValues`
    // pasaba en verde. Verificado. Se parte en dos afirmaciones independientes.
    expect(DEUDA, 'la deuda no nombra el generador real').toMatch(/crypto\.getRandomValues/)
    // La frase FALSA exacta que hubo que retirar. La negación —"no se genera
    // con Math.random"— es la corrección y debe poder convivir, así que el
    // patrón apunta a la afirmación completa, no a la mención del nombre.
    expect(() => exigirSinFalsedades(DEUDA)).not.toThrow()
  })

  /**
   * AA11 — La sonda anterior construía una cadena y afirmaba que un regex la
   * casaba: una tautología sobre la librería estándar, que habría pasado con las
   * aserciones reales borradas (§E.3). Ahora ejercita **la guarda**.
   */
  it('la guarda lanza sobre un documento que miente', () => {
    const miente = [
      '### 13. Un `sb_flow_id` conocido permite romper un login ajeno',
      'El identificador **sí viaja**, y se genera con `Math.random()`, no con un CSPRNG.',
      'crypto.getRandomValues aparece mencionado aquí para despistar.',
    ].join('\n')
    // Aunque mencione el generador real, la afirmación falsa debe delatarlo:
    // ése era exactamente el falso negativo del `|` que U6 retiró.
    expect(() => exigirSinFalsedades(miente)).toThrow(/Math\.random/)
  })
})
