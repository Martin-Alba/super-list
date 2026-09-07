import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'

/**
 * W3 / DoD 62 — Van tres iteraciones parcheando a mano las cifras del
 * checkpoint, y las tres veces volvieron a quedar mal: decía 221 tests en 36
 * ficheros y 41 E2E cuando eran 245/37/42, y antes 165/19 mucho después de
 * dejar de serlo.
 *
 * La causa no es el descuido: es que el documento afirmaba en **presente** un
 * número que cambia cada iteración. Un dato así se pudre en horas. La regla que
 * esta guarda impone es la que faltaba: **toda cifra de la suite va fechada**,
 * porque entonces es un registro de lo que se midió aquel día —que es lo que un
 * checkpoint debe conservar— y no una afirmación sobre hoy que nadie renueva.
 */
const CHECKPOINT = readFileSync('docs/CHECKPOINT.md', 'utf8')

/**
 * AA8 — Dos versiones anteriores fueron **listas negras de vocabulario**: una
 * buscaba adverbios (`hoy`, `actualmente`), otra sustantivos (`tests`,
 * `ficheros`). Medido en las dos: `hoy hay 42 E2E en verde`, `la suite corre 464
 * casos` y `**464/464** en verde` pasaban sin fecha, y el documento real ya
 * usaba esa forma. Y al revés, fechar en su propia columna de tabla salía rojo.
 *
 * La regla declarada siempre fue una sola: **toda cifra sobre el tamaño o el
 * resultado de la suite va fechada**. Lo que la identifica no es la palabra, es
 * el contexto: o la cifra lleva pegado un sustantivo de suite, o la línea nombra
 * una puerta. La unidad es la **línea**, no la frase, para que fechar en otra
 * columna de la misma fila cuente.
 */
const SUSTANTIVO_DE_SUITE = /\b\d+\s*\**\s*(tests?|pruebas|ficheros|casos|specs?|archivos)\b/i
/**
 * AB3 — La forma de **ratio** era el literal que el propio DoD nombraba y pasaba
 * en verde: `**464/464** en verde`. Tres iteraciones declarando arreglada esta
 * guarda con la cadena del requisito aún colándose.
 */
const RATIO = /\b\d+\s*(\/|\s+de\s+)\s*\d+\b/
const CIFRA_SUELTA = /\b\d+\b/
const NOMBRE_DE_PUERTA = /pnpm test|test:e2e|\bE2E\b|vitest|playwright|\bla suite\b/i
const FECHA = /20\d\d-\d\d-\d\d/

export function cifrasSinFechar(texto: string): string[] {
  const sinFecha: string[] = []
  const lineas = texto.split('\n')
  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]
    // La fecha cuenta también si está en la línea anterior: la prosa se parte
    // por ancho, y castigar eso empujaría a no fechar.
    if (FECHA.test(linea) || FECHA.test(lineas[i - 1] ?? '')) continue
    const porSustantivo = linea.match(new RegExp(SUSTANTIVO_DE_SUITE, 'gi'))
    if (porSustantivo) { sinFecha.push(...porSustantivo); continue }
    const porRatio = linea.match(new RegExp(RATIO, 'g'))
    if (porRatio && /verde|rojo|pasa|falla|en verde/i.test(linea)) {
      sinFecha.push(...porRatio); continue
    }
    if (NOMBRE_DE_PUERTA.test(linea) && CIFRA_SUELTA.test(linea)) {
      sinFecha.push(linea.trim().slice(0, 60))
    }
  }
  return sinFecha
}

describe('W3 el checkpoint no afirma en presente cifras que caducan', () => {
  it('no queda ninguna cifra en presente', () => {
    expect(cifrasSinFechar(CHECKPOINT), 'una cifra en presente se pudre en la siguiente iteración')
      .toEqual([])
  })

  // Sonda (§E.2): sobre el texto exacto que hubo que retirar tres veces.
  it.each([
    'verde *(al cerrar aquel ciclo; hoy son 221 en 36 ficheros)*',
    'Los 19 tests E2E de entonces —hoy 41— corren contra el build',
    'hoy hay 42 pruebas de navegador',
    'hoy: 349 tests',
    'actualmente 349 tests en 40 ficheros',
    'La suite tiene ahora 349 tests',
    'en este momento hay 40 ficheros',
    // Z7 — la forma que ORIGINÓ la regla, y que el patrón de adverbios no veía.
    '**398 tests en 40 ficheros**, verde',
    'La suite tiene 398 tests en 40 ficheros',
    'existen 398 tests',
    // AA8 — las formas que la lista negra de vocabulario dejaba pasar.
    'hoy hay 42 E2E en verde',
    'la suite corre 464 casos',
    'ahora son 40 specs',
    'hay 40 archivos de prueba',
    '| `pnpm test:e2e` | **42/42** en verde |',
    '| `pnpm test` (Vitest) | **499** casos |',
    // AB3 / DoD 104 — el literal exacto que el requisito nombra, y las formas
    // hermanas. La sonda anterior lo sustituía por otra cadena que colaba por un
    // motivo distinto: pasaba, pero no por lo que el requisito pedía.
    '**464/464** en verde',
    '**506/506** verde',
    '42/42 en el navegador, verde',
    'Todo verde: 506 de 506',
  ])('la guarda caza %j', (muestra) => {
    expect(cifrasSinFechar(muestra).length).toBeGreaterThan(0)
  })

  it.each([
    '**165 tests en 31 ficheros**, verde *(medido el 2026-09-06)*',
    '| `pnpm test` | **165 tests en 31 ficheros**, verde *(2026-09-06)* |',
    // AA8 — fechar en su propia columna deja de castigarse.
    '| `pnpm test` | **464 tests en 40 ficheros** | 2026-09-07 |',
  ])('una cifra fechada sí es legítima: %j', (muestra) => {
    expect(cifrasSinFechar(muestra)).toEqual([])
  })

  // Z7 — y fechar deja de castigarse, igual que la prosa normal.
  it.each([
    'medido hoy 2026-09-07',
    'ahora se usa un solo despojador',
    'La app ahora redirige a /login?next=1',
    'la quinta revisión no encontró nada CRITICAL',
  ])('no castiga %j', (muestra) => {
    expect(cifrasSinFechar(muestra)).toEqual([])
  })
})

/**
 * X4 / DoD 62 — La versión anterior **no comparaba nada**: calculaba el número
 * de ficheros y sólo lo usaba para un `toBeGreaterThan(10)`. La revisión lo
 * midió sustituyendo "165 tests en 31 ficheros" por "9999 tests en 777
 * ficheros" y la guarda siguió verde. Prohibir el presente era necesario, pero
 * no era el requisito.
 *
 * Ahora hay un bloque de estado en el documento que se compara con el árbol.
 */
export function estadoDeclarado(texto: string): { unitarios: number; navegador: number } {
  const bloque = texto.split('<!-- ESTADO-VERIFICABLE -->')[1]
  if (!bloque) throw new Error('el checkpoint no declara estado verificable')
  const uni = bloque.match(/Ficheros de prueba unitaria:\s*(\d+)/)
  const nav = bloque.match(/Ficheros de prueba de navegador:\s*(\d+)/)
  if (!uni || !nav) throw new Error('el bloque de estado no declara ambos recuentos')
  return { unitarios: Number(uni[1]), navegador: Number(nav[1]) }
}

describe('X4 el checkpoint se compara con el árbol', () => {
  const reales = {
    unitarios: readdirSync('unit').filter(f => /\.test\.tsx?$/.test(f)).length,
    navegador: readdirSync('e2e').filter(f => /\.spec\.ts$/.test(f)).length,
  }

  it('hay ficheros que contar', () => {
    expect(reales.unitarios).toBeGreaterThan(10)
    expect(reales.navegador).toBeGreaterThan(5)
  })

  it('lo declarado coincide con lo que hay', () => {
    expect(estadoDeclarado(CHECKPOINT), 'el checkpoint declara un árbol que no es el que hay')
      .toEqual(reales)
  })

  // Sondas (§E.2): la guarda debe cazar tanto una cifra falsa como la ausencia
  // del bloque. Ésta es la que la revisión demostró inexistente.
  it('caza una cifra que no cuadra', () => {
    const mentiroso = CHECKPOINT.replace(/Ficheros de prueba unitaria:\s*\d+/, 'Ficheros de prueba unitaria: 777')
    expect(estadoDeclarado(mentiroso)).not.toEqual(reales)
  })

  it.each([
    ['', /no declara estado verificable/],
    ['<!-- ESTADO-VERIFICABLE -->\nnada aquí', /no declara ambos recuentos/],
  ])('lanza sobre %j', (texto, motivo) => {
    expect(() => estadoDeclarado(texto)).toThrow(motivo)
  })
})
