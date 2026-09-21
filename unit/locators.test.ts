import { describe, it, expect } from 'vitest'
import { sinComentarios } from './comentarios'
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/**
 * I2 / J12 / K9 — los nombres de item viven en el `value` de un <input>, que
 * `getByText` nunca casa: una asercion asi no puede fallar. La regla es general
 * a proposito: en cuanto admite excepciones deja de ser comprobable, y
 * `getByRole` es mejor localizador tambien donde `getByText` funcionaria.
 */
const FORBIDDEN = /getByText\(/

/**
 * Un `getByText(` dentro de un comentario o una cadena no es una aserción.
 *
 * Y5 — Esto era un segundo despojador de comentarios, hermano del que
 * `unit/comentarios.ts` ya había tenido que arreglar tres veces, y con la misma
 * ceguera: el `//` final del literal `/\/realtime\/v1\//` de
 * `e2e/resilience.spec.ts` le comía el resto de la línea, así que un
 * `getByText(` detrás era invisible. Dos guardas con el mismo agujero y dos
 * sitios donde arreglarlo. Ahora hay uno.
 */
export function stripNoise(source: string): string {
  // Las cadenas se vacían DESPUÉS de que el compilador haya quitado los
  // comentarios: un `getByText(` dentro de una cadena tampoco es una aserción.
  return sinComentarios(source)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
}

// Todo `e2e/`, no solo los *.spec.ts: fixtures.ts y global-setup.ts escapaban.
const FILES = readdirSync('e2e').filter(f => f.endsWith('.ts'))

describe('K9 la guarda de localizadores', () => {
  it('hay ficheros que vigilar, y estan los que no son spec', () => {
    expect(FILES.length).toBeGreaterThan(0)
    expect(FILES).toContain('fixtures.ts')
    expect(FILES).toContain('global-setup.ts')
  })

  it.each(FILES)('%s no afirma con getByText', (file) => {
    expect(stripNoise(readFileSync(join('e2e', file), 'utf8'))).not.toMatch(FORBIDDEN)
  })

  it('un getByText en un comentario NO cuenta como infraccion', () => {
    const src = "// antes usabamos page.getByText('pan')\nawait expect(x).toBe(1)\n"
    expect(stripNoise(src)).not.toMatch(FORBIDDEN)
  })

  it('un getByText dentro de una cadena tampoco cuenta', () => {
    expect(stripNoise("const ejemplo = \"page.getByText('pan')\"\n")).not.toMatch(FORBIDDEN)
  })

  // Sonda R-B: una infraccion real detras de una cadena que contiene `//`.
  // Antes, ese `//` se comia la linea y la infraccion pasaba inadvertida.
  it('DoD 69: una cadena con // no oculta la infraccion que viene despues', () => {
    const src = "test('a//b', async ({ page }) => {\n  await expect(page.getByText(nombre)).toBeVisible()\n})\n"
    expect(stripNoise(src)).toMatch(FORBIDDEN)
  })

  // Control positivo que recorre el mismo camino que la guarda: se escribe un
  // fichero real y se lee del disco, no una cadena en linea.
  it('la guarda detecta una infraccion real leida de disco', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locators-'))
    const file = join(dir, 'malo.spec.ts')
    writeFileSync(file, "test('x', async ({ page }) => {\n  await expect(page.getByText(nombre)).toBeVisible()\n})\n")
    expect(stripNoise(readFileSync(file, 'utf8'))).toMatch(FORBIDDEN)
  })
})

/**
 * Y5 / DoD 80 — Sonda inyectada en el fichero REAL que tiene el literal de
 * expresión regular. La versión anterior de `stripNoise` se comía el resto de
 * esa línea, así que un `getByText(` detrás era invisible para la guarda.
 */
describe('Y5 la guarda no se ciega tras un literal de expresión regular', () => {
  it('caza un getByText inyectado justo detrás', () => {
    const fuente = readFileSync('e2e/resilience.spec.ts', 'utf8')
    const i = fuente.indexOf('routeWebSocket')
    expect(i, 'el literal de regex ya no está: la sonda mira otra cosa').toBeGreaterThan(0)
    const fin = fuente.indexOf('\n', i)
    const contaminado = fuente.slice(0, fin) + '; page.getByText("pan")' + fuente.slice(fin)
    expect(FORBIDDEN.test(stripNoise(contaminado)), 'el regex volvió a cegar la guarda').toBe(true)
  })

  it('y sigue sin cazar uno que está dentro de un comentario', () => {
    expect(FORBIDDEN.test(stripNoise('// evitar page.getByText("pan")'))).toBe(false)
  })
})
