import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { rondaSinFila, siguiente, ultimaRondaConFila, corpusDelRepositorio } from './trayectoria'

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

/**
 * AB7 / DoD 98 — Las filas 7, 8 y 9 de la trayectoria **no se aplicaron**: el
 * ancla no casaba tras corregir las cifras, y las di por escritas sin mirar. La
 * spec se borra al cerrar, así que sin ellas desaparecían las tres iteraciones
 * que arreglaron la autoridad de columna.
 *
 * La guarda no comprueba que estén las filas de hoy —eso sería una cifra que se
 * pudre—, sino que la numeración **no tiene huecos**: un hueco es exactamente lo
 * que deja una escritura que se creyó hecha.
 */
describe('AB7 la trayectoria no pierde iteraciones', () => {
  // Hay una tabla por ciclo, con numeraciones que arrancan donde arrancan. Lo
  // que se exige es lo que un hueco rompe: dentro de cada bloque contiguo de
  // filas, el número sube de uno en uno.
  const bloques: number[][] = []
  for (const linea of CHECKPOINT.split('\n')) {
    const m = /^\| (\d+)(?: \([^)]*\))? \| \d{4}-/.exec(linea)
    if (!m) { if (bloques.at(-1)?.length) bloques.push([]) ; continue }
    if (!bloques.length) bloques.push([])
    bloques.at(-1)!.push(Number(m[1]))
  }
  const conFilas = bloques.filter(b => b.length > 1)

  it('las tablas de trayectoria se reconocen', () => {
    expect(conFilas.length, 'no se reconoció ninguna tabla de trayectoria').toBeGreaterThan(0)
  })

  it.each(conFilas.map((b, i) => [i, b] as const))('la tabla %i no tiene huecos', (_i, b) => {
    expect(b).toEqual(b.map((_, j) => b[0] + j))
  })
})

/**
 * AC4 / DoD 105 — La guarda de AB7 cazaba **huecos interiores** y el defecto que
 * la motivó era una **cola truncada**: la revisión midió que borrando las filas
 * 7-10 quedaba verde. Un hueco es lo que deja una escritura fallida en medio;
 * una escritura fallida al final no deja hueco, deja menos tabla.
 *
 * El ancla tiene que ser algo que la propia obra produzca, no un número que
 * alguien recuerde actualizar. En este repositorio lo hay: cada ronda de revisión
 * deja su etiqueta en los comentarios del código (`AB2 —`, `AA1 —`, `Z3 —`). No
 * se puede escribir una ronda nueva sin dejarla, así que **la etiqueta más alta
 * que aparece en el código tiene que tener su fila en la trayectoria**.
 */
/**
 * AC4 / AD9 / AF3 — La guarda de AB7 cazaba huecos interiores y el defecto que la
 * motivó era una cola truncada. AD9 la ancló a la etiqueta de ronda, y AF3 sacó
 * la lógica del test —donde afirmaba sobre copias de sí misma— a
 * `unit/trayectoria.ts`, de forma que se pueda dirigir con un corpus.
 *
 * Se mira una sola etiqueta: la que sigue a la última fila escrita. Si esa ronda
 * ya está en el repositorio, la tabla se quedó corta. Mirar sólo la sucesora hace
 * que ningún token accidental de otras letras intervenga.
 *
 * Límite declarado: una ronda nueva que reutilice la letra de la anterior en vez
 * de subir a la siguiente esquiva el ancla, y eso es indistinguible de seguir
 * trabajando en la misma ronda, que es legítimo.
 *
 * Y una consecuencia de barrer todo: **esta documentación no puede deletrear la
 * etiqueta de una ronda futura**. Escribirla aquí como ejemplo la ponía roja, que
 * es lo que pasó al redactar este párrafo.
 */
describe('AC4 la trayectoria no se queda corta por el final', () => {
  it('la ronda que sigue a la última fila no existe todavía en el código', () => {
    const falta = rondaSinFila(CHECKPOINT, corpusDelRepositorio())
    expect(falta,
      `la ronda ${falta} ya está en el código y no tiene fila: la trayectoria se quedó corta`)
      .toBeNull()
  })
})

/**
 * AF3 / DoD 139-140 — Las aserciones que la versión anterior no podía hacer.
 * Dirigen el ancla con corpus sintéticos, así que se ponen rojas si la marca
 * vuelve a estrecharse; antes redeclaraban la regex dentro del test y afirmaban
 * sobre la copia, y revertir la mejora no ponía rojo nada.
 */
describe('AF3 el ancla se prueba contra un corpus, no contra una copia', () => {
  const conFila = (codigo: string) => `| 1 (${codigo}) | 2026-09-08 | x | y |`

  it('la sucesora se calcula bien, incluida la vuelta de letra', () => {
    expect(['S', 'Y', 'Z', 'AB', 'AZ'].map(siguiente)).toEqual(['T', 'Z', 'AA', 'AC', 'BA'])
  })

  it('la última fila se lee, y un rango cuenta por su final', () => {
    expect(ultimaRondaConFila(conFila('AE'))).toBe('AE')
    expect(ultimaRondaConFila(conFila('N–T'))).toBe('T')
  })

  it.each([
    ['raya larga', '1 — algo'], ['guion', '-1 — algo'], ['punto', '.1 algo'],
    ['guion bajo', '_1 algo'], ['dos espacios', '  1 algo'],
    ['con ceros', '0001 algo'], ['almohadilla', '#1 algo'],
    ['dos puntos', ':1 algo'], ['paréntesis', '(1) algo'], ['barra', '/1 algo'],
    ['separador de tres', ' - 1 algo'], ['raya con espacios', ' — 1 algo'],
    ['guion no-ASCII', '‑1 algo'], ['sin separador', '1'],
  ])('caza la ronda escrita %s', (_n, cola) => {
    // Igual que arriba: la etiqueta se compone para no meterla en el corpus.
    const proxima = siguiente('AE')
    expect(rondaSinFila(conFila('AE'), `${proxima}${cola}`),
      'esta grafía esquivaba el ancla y dejaba la tabla corta').toBe(proxima)
  })

  /**
   * AG5 / DoD 153 — Saltarse una letra la esquivaba: con la última fila en AF,
   * una ronda etiquetada AH o AI pasaba sin fila. Se miran las tres siguientes.
   */
  it.each([1, 2, 3])('caza el salto de %i letras', (saltos) => {
    // Las etiquetas se COMPONEN: escribirlas en literal aquí las mete en el
    // corpus real y pondría roja la guarda por culpa de su propio test. Ya pasó
    // dos veces.
    let codigo = 'AF'
    for (let i = 0; i < saltos; i++) codigo = siguiente(codigo)
    expect(rondaSinFila(conFila('AF'), `${codigo}1 — algo`),
      'saltarse una letra esquivaba el ancla').toBe(codigo)
  })

  /**
   * AG5 / DoD 154 — Y **no** casa en minúsculas, a propósito: las etiquetas de
   * ronda son mayúsculas, y con la bandera `i` la marca de la ronda AV casaba con
   * las etiquetas `av4`/`av6` que `e2e/avisos.spec.ts` usa para nombrar sus
   * usuarios. Era un falso positivo esperando a que el ciclo llegara a esa letra:
   * la guarda se habría puesto roja sin faltar ninguna fila.
   */
  it('no confunde las etiquetas en minúsculas de los e2e', () => {
    expect(rondaSinFila(conFila('AU'), "await entrar(browser, 'av4')"),
      'la marca en minúsculas convertía un nombre de test en una ronda').toBeNull()
    expect(rondaSinFila(conFila('AF'), `${siguiente('AF').toLowerCase()}1 algo`)).toBeNull()
  })

  it('y no confunde una ronda que sí tiene fila', () => {
    expect(rondaSinFila(`${conFila('AE')}\n${conFila('AF')}`, 'AF1 — algo')).toBeNull()
  })

  it('ni una etiqueta de otras letras', () => {
    expect(rondaSinFila(conFila('AE'), 'DB2 — una tabla cualquiera')).toBeNull()
  })

  it('el corpus no depende de un catálogo de extensiones', () => {
    /**
     * AG6 puso aquí `toContain('Definition of Done')` y **no podía fallar**: esa
     * cadena sólo está en `docs/spec.md` —que el ciclo borra al cerrar— y en la
     * propia línea del test, que entra en el corpus.
     *
     * AH2 — Se ancla a ficheros que **sólo** un corpus sin catálogo de
     * extensiones aporta (`.json`, `.toml`), con un trozo leído en tiempo de
     * ejecución: el test no puede satisfacerlo escribiéndolo, y si vuelve el
     * catálogo se pone rojo.
     */
    const texto = corpusDelRepositorio()
    expect(texto.length, 'el corpus se quedó vacío').toBeGreaterThan(100_000)
    for (const fuera of ['package.json', 'supabase/config.toml']) {
      const trozo = readFileSync(fuera, 'utf8').slice(20, 70)
      expect(trozo.length, `${fuera} es demasiado corto para anclar nada`).toBe(50)
      expect(texto, `el corpus no alcanza ${fuera}: volvió el catálogo de extensiones`)
        .toContain(trozo)
    }
  })
})

/**
 * AH7 / DoD 166 — AG8 escribió la política de registro en el checkpoint y **no
 * dejó nada que la sostuviera**: es literalmente la cicatriz de la deuda 23 —«el
 * requisito que iba a arreglarlo no tenía fila de DoD»— repetida en el requisito
 * que la cita. Una decisión que sólo vive en un párrafo se borra en el primer
 * reordenado del documento.
 */
describe('AH7 la política de registro no se puede perder sin ruido', () => {
  it('el checkpoint declara qué se puede registrar de un error de la base', () => {
    expect(CHECKPOINT, 'la decisión sobre qué registrar desapareció del checkpoint')
      .toMatch(/registrar[\s\S]{0,400}error de la base/i)
    /**
     * AI7 — Esta aserción miraba todo el documento, y la satisfacía la fila 15 de
     * la trayectoria, que también nombra `error.code`: borrar la política entera
     * la dejaba verde. Se mira **el bloque de decisiones**, que es donde vive.
     */
    const bloque = /- \*\*Qué se puede registrar de un error de la base[\s\S]*?(?=\n- \*\*|\n#)/
      .exec(CHECKPOINT)?.[0] ?? ''
    expect(bloque, 'la decisión desapareció del bloque de decisiones').not.toBe('')
    expect(bloque, 'la decisión ya no dice qué SÍ se puede registrar')
      .toMatch(/error\.code|el código/i)
  })

  it('y la guarda que la hace cumplir sigue existiendo', () => {
    const guarda = readFileSync('unit/textoCrudo.ts', 'utf8')
    expect(guarda, 'la guarda que impide registrar el error entero se retiró')
      .toContain('usosIndebidosDelError')
  })
})
