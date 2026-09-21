import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { sql } from './helpers'
import { ficherosDeProducto } from './producto'
import { CANTIDAD, normalizar, TECLEABLE } from '@/lib/cantidad'

/**
 * Spec J / J-R10, j8, j9 — **La regla de la cantidad vive en un sitio por lado, y esta guarda
 * demuestra que los dos dicen lo mismo.**
 *
 * El límite, dicho antes que nada: **no pueden ser literalmente la misma función.** Una corre
 * en SQL dentro de la migración; la otra en TypeScript, en un dispositivo **sin red** —drenar
 * es justamente lo que se hace cuando la base no estaba—, así que no hay frontera por la que
 * compartirla. Lo que sí se puede es esto: una declaración por lado, y una guarda que ejecute
 * la misma tabla de casos por los dos exigiendo el mismo veredicto.
 *
 * **Y su punto ciego, escrito: coincidir no es acertar.** Si los dos lados se equivocan igual
 * —un dígito árabe `٥`, uno de ancho completo `５`, un espacio invisible— esta guarda da verde
 * con los dos mal. Por eso la tabla de casos **no sale de la imaginación de quien la escribe**:
 * sale de los valores que la medida encontró en las bases reales, que es la única fuente de
 * casos que nadie inventó.
 *
 * Ninguno de los dos lados se lee de una copia: la expresión SQL se **extrae de la migración**
 * entre sus marcadores, y el `check` se **lee del catálogo de la base**. Una copia en el test
 * sería la tercera declaración, y entonces la guarda compararía el test consigo mismo.
 */

const MIGRACION = 'supabase/migrations/20260921000200_cantidad_numero.sql'

/** Lo que hay entre dos marcadores de la migración. Lanza si no están: callarse sería peor. */
function entreMarcadores(que: string, texto = readFileSync(MIGRACION, 'utf8')): string {
  const abre = `-- cantidad:${que}:inicio`, cierra = `-- cantidad:${que}:fin`
  /**
   * m9 / i3-R9 — **Se cuenta, no se coge el primero.** Con `indexOf` a secas, un marcador
   * duplicado elegía un par en silencio y la guarda comparaba el trozo equivocado dándose por
   * satisfecha. Es la misma clase que las cuatro anclas muertas que la pasada de mutación
   * destapó al cambiar su `grep -qF` por una cuenta exacta, y era la única que quedaba en el
   * repositorio — barrido hecho sobre `unit/`, `e2e/` y `scripts/`.
   */
  for (const [marca, veces] of [[abre, texto.split(abre).length - 1], [cierra, texto.split(cierra).length - 1]] as const)
    if (veces !== 1) throw new Error(`«${marca}» aparece ${veces} veces en ${MIGRACION}`)
  const desde = texto.indexOf(abre), hasta = texto.indexOf(cierra)
  if (hasta < desde) throw new Error(`marcadores «${que}» al revés en ${MIGRACION}`)
  return texto.slice(desde + abre.length, hasta).trim()
}

/** La expresión de normalización, tal cual está en la migración. */
const normalizacionSQL = () => entreMarcadores('normalizar')

/**
 * i1-R4 — **El `check` tal cual está en el FICHERO**, que es el que llega a producción.
 *
 * La versión anterior sólo leía el del catálogo, y eso comparaba TypeScript con la base
 * local — con lo que alguien había aplicado aquí, no con lo que la migración dice. Medido
 * por el review: ensanchar el regex del fichero a `^[1-9][0-9]{0,2}$` dejaba los cuatro
 * ficheros relevantes en verde. Las dos afirmaciones se conservan y son distintas: ésta
 * mira lo que se va a desplegar, la del catálogo mira lo que ya está puesto.
 */
const checkSQL = () => entreMarcadores('check').replace(/^check\s*\(/i, '(')

/**
 * Los casos. Las dieciséis formas de la izquierda son **valores reales medidos** contra la base
 * local (42.232 ítems, 2.762 cantidades por decidir); las cuatro de abajo se añaden porque la
 * medida no las contenía y la regla las nombra.
 */
const CASOS: string[] = [
  // Medidos en la base local, con su número de filas al lado.
  '2 kg',                  // 589
  'qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', // 581 — el dato de prueba de la cota
  '299',                   // 518 — fuera de rango: NO se trunca a 29 ni a 2
  '12 unidades',           // 380
  '1 kg', '3 barras', '2 briks', '1 bote', '2 barras',
  '165', '99999999999999999999', '-5', 'q299', 'CANT-B', 'doce',
  '1.5',                   // 1 — decimal: vacío, no 1
  // No estaban en la medida, y la regla los nombra.
  '1,5',                   // el separador que teclea un teclado español
  '2, briks',              // la coma que NO separa decimales: sigue dando 2
  '1', '99',               // los extremos válidos
  '0', '100', '007', ' 5', '5 ', '00',
]

/**
 * m9 / i4-R2 — **La guarda de los marcadores, con su sonda.**
 *
 * i3-R9 escribió el conteo y no lo probó: `entreMarcadores` leía el fichero por una ruta fija,
 * así que no había forma de sembrar un marcador duplicado y la columna «por qué no puede estar
 * verde antes» no tenía demostración. Con la fuente por parámetro —dos líneas— las tres formas
 * de romperlo se cazan, y la fila deja de afirmar un mecanismo que nadie ejercitaba.
 */
describe('Spec J · m9 los marcadores de la migración', () => {
  const CON = (cuerpo: string) => `x\n-- cantidad:check:inicio\n${cuerpo}\n-- cantidad:check:fin\ny`

  it('con un par bien puesto, devuelve lo de dentro', () => {
    expect(entreMarcadores('check', CON('  (quantity is null)  '))).toBe('(quantity is null)')
  })

  it.each([
    ['duplicado', `${CON('(a)')}\n${CON('(b)')}`],
    ['sin el de apertura', 'x\n(a)\n-- cantidad:check:fin\ny'],
    ['sin el de cierre', 'x\n-- cantidad:check:inicio\n(a)\ny'],
    ['al revés', 'x\n-- cantidad:check:fin\n(a)\n-- cantidad:check:inicio\ny'],
  ])('la sonda — un marcador %s se caza', (_n, fuente) => {
    expect(() => entreMarcadores('check', fuente),
      'la guarda extrajo un trozo sin quejarse de unos marcadores rotos').toThrow()
  })
})

describe('Spec J · j8/j9 la regla de la cantidad dice lo mismo en los dos lados', () => {
  it('j9: la tabla de casos trae los valores que la medida encontró, no sólo los imaginados', () => {
    // Sin esto, la tabla podría encogerse hasta los casos cómodos y la guarda seguiría verde.
    for (const real of ['2 kg', '299', '12 unidades', '1.5', '-5', 'doce', '165'])
      expect(CASOS, `${real} salió de la medida de la base y desapareció de la tabla`).toContain(real)
    expect(CASOS, 'falta la coma decimal, que la medida no tenía y la regla nombra').toContain('1,5')
    expect(CASOS, 'falta «2, briks»: el caso que NO es decimal y distingue la regla').toContain('2, briks')
    // i1-R10 — Y los bordes del rango por su nombre: el suelo numérico anterior (24 sobre 26)
    // dejaba quitar `'0'` y `'100'` sin que nada se pusiera rojo.
    for (const borde of ['0', '100', '007', '1', '99'])
      expect(CASOS, `falta el borde ${borde}, que es donde la regla se rompe`).toContain(borde)
  })

  it('j8: normalizar da el mismo veredicto en SQL y en TypeScript, caso por caso', async () => {
    const filas = await sql<{ v: string; sql: string | null }>(
      `select t.quantity as v, (${normalizacionSQL()}) as sql
         from unnest($1::text[]) as t(quantity)`, [CASOS])
    expect(filas, 'la base no evaluó ningún caso: la guarda no mide nada').toHaveLength(CASOS.length)

    const divergen = filas
      .map(f => ({ valor: f.v, sql: f.sql, ts: normalizar(f.v) }))
      .filter(x => x.sql !== x.ts)
    /**
     * Si esto se pone rojo, **el defecto es de una de las dos declaraciones, no de la tabla.**
     * Tocar el caso para que pase es apagar la única señal de divergencia que hay.
     */
    expect(divergen, 'SQL y TypeScript normalizan distinto: arregla una de las dos declaraciones')
      .toEqual([])
  })

  it('i1-R4: el `check` DE LA MIGRACIÓN acepta lo mismo que el regex de TypeScript', async () => {
    const filas = await sql<{ v: string; ok: boolean }>(
      `select t.quantity as v, ${checkSQL()} as ok from unnest($1::text[]) as t(quantity)`, [CASOS])
    const divergen = filas
      .map(f => ({ valor: f.v, migracion: f.ok, ts: CANTIDAD.test(f.v) }))
      .filter(x => x.migracion !== x.ts)
    expect(divergen, 'la migración y TypeScript no coinciden en qué cantidad es válida').toEqual([])
  })

  it('i1-R4: la sonda — ensanchar el regex de la migración se caza', async () => {
    // Exactamente la mutación que el review midió pasando: 1..999 en vez de 1..99.
    // El reemplazo va por función: en un literal de reemplazo, `$'` significa «lo que va
    // detrás de la coincidencia», y el regex de la migración acaba justo en `$'`.
    const ancho = checkSQL().replace("'^[1-9][0-9]?$'", () => "'^[1-9][0-9]{0,2}$'")
    expect(ancho, 'la mutación no cambió el regex: la sonda no prueba nada').not.toBe(checkSQL())
    const filas = await sql<{ v: string; ok: boolean }>(
      `select t.quantity as v, ${ancho} as ok from unnest($1::text[]) as t(quantity)`, [['299', '165']])
    expect(filas.map(f => [f.v, f.ok, CANTIDAD.test(f.v)]),
      'ensanchar el regex de la migración no produjo divergencia: la guarda está ciega')
      .toEqual([['299', true, false], ['165', true, false]])
  })

  it('j8: y el `check` instalado acepta lo mismo que el regex de TypeScript', async () => {
    // El `check` se lee del catálogo: es lo que de verdad está puesto, no lo que un fichero dice.
    const [{ def }] = await sql<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.items'::regclass and conname = 'items_quantity_num'`)
    const cuerpo = def.replace(/^CHECK\s*/, '')
    const filas = await sql<{ v: string; ok: boolean }>(
      `select t.quantity as v, (${cuerpo}) as ok
         from unnest($1::text[]) as t(quantity)`, [CASOS])

    const divergen = filas
      .map(f => ({ valor: f.v, base: f.ok, ts: CANTIDAD.test(f.v) }))
      .filter(x => x.base !== x.ts)
    expect(divergen, 'la base y TypeScript no coinciden en qué cantidad es válida').toEqual([])
    /**
     * La sonda: si el `check` aceptara todo, la comparación de arriba seguiría verde con un
     * regex de TypeScript que también acepta todo. Alguno tiene que sobrar y alguno faltar.
     *
     * i1-R10 — **Se cuenta, no se enumera.** La versión anterior fijaba `['1','99']` y eso
     * castigaba justo lo que j9 exige: añadir un caso válido a la tabla la ponía roja
     * acusando a la base de aceptar lo que no debe.
     */
    const aceptados = filas.filter(f => f.ok).length
    expect(aceptados, 'la base no acepta ninguna cantidad de la tabla').toBeGreaterThan(0)
    expect(aceptados, 'la base acepta todos los casos, incluidos los que no valen')
      .toBeLessThan(CASOS.length)
  })

  it('j8: la sonda — una divergencia sembrada se caza', async () => {
    // Se ataca el instrumento, no el producto: la expresión de la migración con la exclusión
    // del decimal quitada. Si la guarda no viera esto, no vería nada.
    // `[\s\S]` y no el flag `s`: el target de este proyecto es anterior a es2018 y `tsc` lo
    // rechaza, aunque vitest lo transpile sin quejarse. La verja la lee `tsc`.
    const roto = normalizacionSQL().replace(/case when [\s\S]*? then null\s*\n\s*else /, '')
      .replace(/\s*end\s*$/, '')
    expect(roto, 'la mutación no cambió la expresión: la sonda no prueba nada')
      .not.toBe(normalizacionSQL())
    const filas = await sql<{ v: string; sql: string | null }>(
      `select t.quantity as v, (${roto}) as sql from unnest($1::text[]) as t(quantity)`,
      [['1.5', '1,5']])
    // Sin la exclusión, SQL dice `1` donde TypeScript dice nada. Eso es lo que hay que ver.
    expect(filas.map(f => [f.v, f.sql, normalizar(f.v)]),
      'quitar la exclusión del decimal no produjo divergencia: la guarda está ciega')
      .toEqual([['1.5', '1', null], ['1,5', '1', null]])
  })
})

/**
 * Spec J / j5 — **El barrido, que es lo que las tres pruebas de vista no pueden hacer.**
 *
 * Cada una de ellas mira una entrada por su identidad, y eso es lo correcto para lo que
 * afirman. Pero ninguna ve una **cuarta** entrada de cantidad añadida el mes que viene, y ése
 * es exactamente el fallo de esta clase: la spec dice «las tres, no una» porque la vez anterior
 * se olvidó una. Así que además de las tres, un barrido por el árbol del producto.
 *
 * Se hace con el AST y no con un `grep`: un `grep` de `inputMode` da verde con la palabra
 * escrita en un comentario, y da rojo por una que esté en otra línea del mismo elemento.
 */
type Entrada = { donde: string; identidad: string; inputMode: string | null; pattern: string | null; tipo: string | null }

/**
 * i2-R6 — **Los campos de TEXTO del producto, por su nombre y con su motivo.**
 *
 * La regla se invierte: **todo `<input>` del producto exige teclado numérico salvo los que
 * estén aquí.** La versión anterior reconocía la cantidad por su ortografía —`-qty`,
 * `placeholder="Cantidad"`, `aria-label` empezando por «Cantidad»—, y eso es reconocer las
 * formas que se le ocurrieron a quien lo escribió: `item-count`, `aria-label="Cuántos"` o
 * `placeholder="Unidades"` seguían siendo invisibles, y la guarda existe **exactamente** para
 * la entrada que alguien añada mañana.
 *
 * Fallar cerrado cuesta esto: quien añada un campo tiene que clasificarlo. Es el coste que se
 * quiere, porque el olvido que esta guarda persigue es justo el de no clasificarlo.
 */
const CAMPOS_DE_TEXTO: Record<string, string> = {
  'group-name': 'el nombre de un grupo es texto libre',
  'item-name': 'el nombre de un producto es texto libre — el alta, en la vista y en la cáscara',
  Nombre: 'el nombre de un producto, editable por fila',
}

/**
 * i3-R10 — La exención se busca **por prefijo**, no por el literal exacto. Medido: cambiar
 * `aria-label="Nombre"` por `` aria-label={`Nombre de ${item.name}`} `` —que es como ya está
 * escrito el campo de cantidad de al lado— hacía que el barrido exigiera teclado numérico a un
 * campo de texto **y** pusiera roja la fila de exenciones muertas. Una mejora de accesibilidad
 * no puede romper una guarda que no habla de accesibilidad.
 */
const esCampoDeTexto = (identidad: string) =>
  Object.keys(CAMPOS_DE_TEXTO).some(nombre => identidad.startsWith(nombre))

/**
 * Lo que falla: sin `inputMode`, sin `pattern`, con un `pattern` **copiado** en vez de el
 * compartido, o con el `type=number` que la spec descarta.
 *
 * i1-R1 — Que el `pattern` venga de `TECLEABLE` y no de una copia **no es estilo**. `pattern`
 * es validación nativa: un patrón más estrecho que el filtro del campo **bloquea el envío en
 * silencio**, sin ítem y sin aviso. Pasó: el filtro empezó a admitir `.` y `,` y el `pattern`
 * se quedó en `[0-9]*`, y pulsar «+» con «1.5» dentro no hacía absolutamente nada. Por eso
 * aquí se exige la declaración compartida, que es lo único que impide que vuelvan a
 * divergir; un literal que hoy coincide es el mismo defecto esperando al próximo cambio.
 */
const noDeclara = (e: Entrada) =>
  e.inputMode !== 'numeric' || e.pattern !== 'TECLEABLE' || e.tipo === 'number'

/**
 * Los `<input>` de cantidad, con lo que declaran. **Toma la fuente**, no sólo la ruta, para
 * que la sonda pueda atacar este mismo analizador con la forma del olvido en vez de filtrar
 * un objeto escrito a mano — que es un test que no puede fallar.
 */
function entradasEn(ruta: string, fuente: string): Entrada[] {
  const salida: Entrada[] = []
  {
    const sf = ts.createSourceFile(ruta, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const ver = (n: ts.Node) => {
      const abre = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxOpeningElement(n) ? n : null
      if (abre && ts.isIdentifier(abre.tagName) && abre.tagName.text === 'input') {
        const attr = (nombre: string): string | null => {
          for (const a of abre.attributes.properties) {
            if (!ts.isJsxAttribute(a) || a.name.getText() !== nombre) continue
            const v = a.initializer
            if (v && ts.isStringLiteral(v)) return v.text
            if (v && ts.isJsxExpression(v) && v.expression) {
              const e = v.expression
              if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
              // `aria-label={`Cantidad de ${x}`}` — la cabecera de la plantilla es texto
              // literal y basta para reconocerla. Sin esto, la entrada que este repo ya
              // tiene escrita así era invisible para el barrido.
              if (ts.isTemplateExpression(e)) return e.head.text
              // `pattern={TECLEABLE}` — el nombre de la declaración compartida es lo que
              // hay que reconocer: es la forma correcta, no una que haya que adivinar.
              if (ts.isIdentifier(e)) return e.text
            }
            return '<expresión>'
          }
          return null
        }
        /**
         * Cómo se llama esta entrada. Se toma el primer atributo que la identifique, y si
         * no hay ninguno queda `'<sin identificar>'` — que **no** está en la lista de texto,
         * así que un `<input>` anónimo tiene que declarar teclado numérico o clasificarse.
         */
        const identidad = attr('data-testid') ?? attr('aria-label') ?? attr('placeholder')
          ?? attr('name') ?? attr('id') ?? '<sin identificar>'
        salida.push({
          donde: `${ruta}:${sf.getLineAndCharacterOfPosition(abre.getStart(sf)).line + 1}`,
          identidad,
          inputMode: attr('inputMode'), pattern: attr('pattern'), tipo: attr('type'),
        })
      }
      ts.forEachChild(n, ver)
    }
    ts.forEachChild(sf, ver)
  }
  return salida
}

/** Todos los `<input>` del producto. */
const todasLasEntradas = (): Entrada[] =>
  ficherosDeProducto().filter(r => r.endsWith('.tsx'))
    .flatMap(r => entradasEn(r, readFileSync(r, 'utf8')))

/** Las que no están declaradas como texto: ésas son las que tienen que pedir teclado numérico. */
const entradasDeCantidad = (): Entrada[] =>
  todasLasEntradas().filter(e => !esCampoDeTexto(e.identidad))

/**
 * m7 / i3-R7 — **Lo que el barrido NO ve, y que hay que cerrar por otro lado.**
 *
 * El analizador busca la etiqueta JSX `input` en minúscula. Un componente propio
 * —`<Campo name="cantidad" />`— o un `React.createElement('input', …)` son invisibles para él,
 * y son justamente cómo se escribe una cuarta entrada cuando ya hay tres iguales. No se puede
 * resolver ensanchando el reconocimiento —habría que resolver qué renderiza cada componente—,
 * así que se cierra por la puerta de al lado: **en este producto no hay ninguna de las dos
 * formas**, y si aparece una, esta guarda lo dice y obliga a decidir.
 */
function formasQueElBarridoNoVe(ruta: string, fuente: string): string[] {
  const sf = ts.createSourceFile(ruta, fuente, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hallado: string[] = []
  const linea = (nodo: ts.Node) => sf.getLineAndCharacterOfPosition(nodo.getStart(sf)).line + 1
  const ver = (n: ts.Node) => {
    // Una etiqueta JSX capitalizada que se comporta como un campo: lleva `value` y `onChange`.
    const abre = ts.isJsxSelfClosingElement(n) ? n : ts.isJsxOpeningElement(n) ? n : null
    /**
     * i4-R5 — `getText()` y no `isIdentifier`: una etiqueta **cualificada** —`<UI.Input …>`—
     * no es un identificador, así que la forma que esta misma guarda declara perseguir se le
     * escapaba. Medido.
     */
    if (abre && /^[A-Z]/.test(abre.tagName.getText())) {
      const props = abre.attributes.properties
        .filter(ts.isJsxAttribute).map(a => a.name.getText())
      if (props.includes('value') && props.includes('onChange'))
        hallado.push(`${ruta}:${linea(abre)} <${abre.tagName.getText()}> parece un campo y el barrido no lo ve`)
    }
    // `createElement('input', …)`, con o sin `React.` delante.
    if (ts.isCallExpression(n) && /(^|\.)createElement$/.test(n.expression.getText())) {
      const primero = n.arguments[0]
      if (primero && ts.isStringLiteral(primero) && primero.text === 'input')
        hallado.push(`${ruta}:${linea(n)} createElement('input') y el barrido no lo ve`)
    }
    ts.forEachChild(n, ver)
  }
  ts.forEachChild(sf, ver)
  return hallado
}

describe('Spec J · m7 lo que el barrido no puede ver', () => {
  it('el producto no escribe ninguna entrada de esas dos formas', () => {
    // i4-R5 — También los `.ts`: `createElement('input')` no necesita JSX, y los veinte
    // ficheros de producto que no son `.tsx` no los miraba nadie.
    const fuera = ficherosDeProducto()
      .flatMap(r => formasQueElBarridoNoVe(r, readFileSync(r, 'utf8')))
    expect(fuera, 'hay un campo que el barrido de teclado numérico no alcanza a mirar').toEqual([])
  })

  it.each([
    ['un componente propio con value y onChange', '<Campo name="cantidad" value={q} onChange={f} />'],
    ['uno capitalizado cualquiera', '<Entrada value={q} onChange={f} />'],
    ["createElement('input')", "React.createElement('input', { value: q })"],
    ["createElement sin React delante", "createElement('input', { value: q })"],
    ['una etiqueta cualificada, que es la forma que esta guarda declara',
      '<UI.Input value={q} onChange={f} />'],
  ])('la sonda — %s se caza', (_n, fuente) => {
    expect(formasQueElBarridoNoVe('sonda.tsx', fuente),
      'esta forma escapa al barrido y tampoco la caza esta guarda').not.toEqual([])
  })

  it.each([
    ['un componente que no es un campo', '<Cabecera titulo={t} />'],
    ['un input normal, que sí ve el barrido', '<input data-testid="item-qty" value={q} onChange={f} />'],
    ['otro createElement', "createElement('div', { className: c })"],
  ])('la sonda al revés — %s no se reporta', (_n, fuente) => {
    expect(formasQueElBarridoNoVe('sonda.tsx', fuente),
      'la guarda acusa a algo que no es un campo invisible').toEqual([])
  })
})

describe('Spec J · j5 el barrido de las entradas de cantidad', () => {
  it('k7: la lista de campos de texto no tiene exenciones muertas', () => {
    // Una exención que ya no corresponde a ningún campo es una puerta abierta esperando a
    // que alguien reutilice el nombre. Se comprueba contra lo que hay, no contra la memoria.
    const vivas = new Set(todasLasEntradas().map(e => e.identidad))
    for (const nombre of Object.keys(CAMPOS_DE_TEXTO))
      expect([...vivas].filter(v => v.startsWith(nombre)),
        `«${nombre}» está exento y ya no corresponde a ningún campo: la exención sobra`)
        .not.toHaveLength(0)
  })

  it('k7: todo `<input>` del producto está clasificado', () => {
    const entradas = todasLasEntradas()
    expect(entradas.length, 'el barrido no encuentra ningún input: no mide nada').toBeGreaterThan(5)
    const sinIdentidad = entradas.filter(e => e.identidad === '<sin identificar>')
    expect(sinIdentidad,
      'hay un input que no se puede nombrar: clasifícalo o dale un identificador').toEqual([])
  })

  it('i1-R1: el `pattern` compartido admite todo lo que el filtro deja escribir', async () => {
    const { soloCantidad } = await import('@/lib/cantidad')
    const patron = new RegExp(`^${TECLEABLE}$`)
    for (const crudo of [...CASOS, '1.5 kg', '0,0', '..,,', '12']) {
      const enElCampo = soloCantidad(crudo)
      expect(patron.test(enElCampo),
        `el filtro deja «${enElCampo}» en el campo y el pattern lo rechaza: el envío se bloquea en silencio`)
        .toBe(true)
    }
  })

  it('encuentra las tres que la spec nombra, y ninguna menos', () => {
    // Si el instrumento deja de encontrarlas, no mide nada y el resto de la fila es decorado.
    expect(entradasDeCantidad().length,
      'el barrido no encuentra las tres entradas que la medida de §1 contó').toBeGreaterThanOrEqual(3)
  })

  it('todas piden teclado numérico, y ninguna usa type=number', () => {
    expect(entradasDeCantidad().filter(noDeclara),
      'una entrada de cantidad no pide teclado numérico: en el móvil sale el teclado entero')
      .toEqual([])
  })

  /**
   * §E.2 — La sonda va por el **mismo analizador**, no por un objeto a mano: lo que hay que
   * demostrar es que este instrumento caza el olvido, y filtrar una lista escrita por el test
   * demuestra que `Array.filter` funciona.
   *
   * Las cuatro formas son las cuatro maneras de olvidarlo, incluida la de reconocer la entrada
   * por su `placeholder` cuando no lleva `data-testid` — que es como se escribiría una cuarta
   * a mano alzada.
   */
  /**
   * i3-R10 — **El banco, después de invertir la regla.** Doce de las dieciséis filas anteriores
   * pasaban por la **misma** razón —identidad no exenta— y sólo cuatro ejercitaban `noDeclara`:
   * medían doce veces lo mismo y afirmaban un mecanismo de reconocimiento que ya no existe.
   *
   * Lo que queda son las dos clases que de verdad hay: **no está clasificada** (un
   * representante, porque para la regla nueva todas son idénticas) y **está clasificada y le
   * falta algo** (las cuatro formas del olvido, que sí son distintas entre sí).
   */
  it.each([
    ['sin clasificar y sin nada', '<input data-testid="item-count" value={q} />'],
    ['sin nada', '<input data-testid="item-qty" placeholder="Cantidad" value={q} />'],
  ])('la sonda — una entrada %s se caza', (_n, fuente) => {
    const vistas = entradasEn('sonda.tsx', fuente)
      .filter(e => !esCampoDeTexto(e.identidad))
    expect(vistas, 'el barrido no vio la entrada: no la habría mirado nunca').toHaveLength(1)
    expect(vistas.filter(noDeclara), 'el barrido vio la entrada y dio por bueno el olvido')
      .toHaveLength(1)
  })

  it('la sonda al revés — una entrada bien declarada NO se caza', () => {
    // Sin esto, «caza los olvidos» lo cumpliría también un barrido que marcara todo.
    const buena = entradasEn('sonda.tsx',
      '<input data-testid="item-qty" inputMode="numeric" pattern={TECLEABLE} value={q} />')
    expect(buena).toHaveLength(1)
    expect(buena.filter(noDeclara), 'el barrido marca como olvido una entrada correcta').toEqual([])
  })

  /**
   * Y la otra mitad de la sonda al revés, que el ensanchado de i1-R8 hace necesaria: un
   * barrido más goloso puede empezar a reclamar teclado numérico a campos que no son
   * cantidades. Éstos son los que hay al lado en las mismas vistas.
   */
  it.each([
    ['el nombre del producto', '<input data-testid="item-name" placeholder="Producto" value={n} />'],
    ['el nombre del grupo', '<input data-testid="group-name" placeholder="Nombre del grupo" value={g} />'],
    ['el nombre de una fila', '<input aria-label="Nombre" value={n} />'],
  ])('la sonda al revés — %s no se confunde con una cantidad', (_n, fuente) => {
    expect(entradasEn('sonda.tsx', fuente).filter(e => !esCampoDeTexto(e.identidad)),
      'el barrido reclama teclado numérico a un campo declarado de texto').toEqual([])
  })
})
