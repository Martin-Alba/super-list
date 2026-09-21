import ts from 'typescript'
import { analizar } from './comentarios'
import { contaminar, type Semilla } from './contaminacion'

/**
 * AI4 — Por dónde sale un valor de una función. Estaba escrito **dos veces** en
 * este fichero, once líneas cada una, y la segunda copia la escribió la
 * iteración anterior — en el módulo cuyo propio comentario cita la cicatriz X2.
 */
function salidasDeUnCuerpo(cuerpo: ts.Node): ts.Node[] {
  if (!ts.isBlock(cuerpo)) return [cuerpo]
  const fuera: ts.Node[] = []
  const mirar = (m: ts.Node): void => {
    if (ts.isReturnStatement(m) && m.expression) fuera.push(m.expression)
    // No se entra en funciones anidadas: sus `return` son de ellas.
    if (ts.isFunctionDeclaration(m) || ts.isFunctionExpression(m) || ts.isArrowFunction(m)) return
    ts.forEachChild(m, mirar)
  }
  ts.forEachChild(cuerpo, mirar)
  return fuera
}

/**
 * AG2 — La exención del traductor se **heredaba del nombre importado**: cualquier
 * símbolo de `@/lib/errors` limpiaba lo que tocara. La revisión lo midió:
 * `refinarSinSesion` devuelve su propio argumento para seis de las siete clases,
 * así que envolver el texto crudo en ella lo dejaba limpio a ojos de la guarda, y
 * el crudo de Postgres llegaba a la pantalla con la suite entera en verde.
 *
 * Aquí la exención **se gana**: se lee el módulo del traductor y se calcula qué
 * funciones sanean de verdad — las que, con sus parámetros contaminados,
 * devuelven algo que no lo está. Es un punto fijo porque unas llaman a otras:
 * `traducirConSesion` sanea sólo si `traducirError` sanea, y ésa sólo si
 * `clasificar` sanea.
 */
export function funcionesQueSanean(fuente: string, nombre = 'errors.ts'): Set<string> {
  const arbol = analizar(fuente, nombre)

  /** Cada función del módulo con su nombre, sus parámetros y sus salidas. */
  type Funcion = { nombre: string; parametros: string[]; salidas: ts.Node[] }
  const funciones: Funcion[] = []

  const salidasDe = salidasDeUnCuerpo

  const anotar = (nombreFn: string, params: ts.NodeArray<ts.ParameterDeclaration>, cuerpo?: ts.Node) => {
    if (!cuerpo) return
    /**
     * AH6 — Los parámetros desestructurados se filtraban, y luego «sin
     * parámetros ⇒ sanea». Así que `export function envolver({ x }) { return x }`
     * eximía **devolviendo su argumento**: el agujero de `refinarSinSesion`
     * reabierto para otra forma de escribir un parámetro.
     */
    const nombres: string[] = []
    const marcar = (b: ts.BindingName): void => {
      if (ts.isIdentifier(b)) { nombres.push(b.text); return }
      for (const el of b.elements) {
        if (!ts.isOmittedExpression(el)) marcar(el.name)
      }
    }
    for (const par of params) marcar(par.name)
    funciones.push({ nombre: nombreFn, parametros: nombres, salidas: salidasDe(cuerpo) })
  }

  const recoger = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name) anotar(n.name.text, n.parameters, n.body)
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const v = n.initializer
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) anotar(n.name.text, v.parameters, v.body)
    }
    ts.forEachChild(n, recoger)
  }
  ts.forEachChild(arbol, recoger)

  const sanean = new Set<string>()
  for (let cambio = true; cambio; ) {
    cambio = false
    for (const f of funciones) {
      if (sanean.has(f.nombre) || !f.parametros.length) {
        // Sin parámetros no hay nada que sanear: no puede ensuciar lo que no recibe.
        if (!sanean.has(f.nombre) && !f.parametros.length) { sanean.add(f.nombre); cambio = true }
        continue
      }
      // Se contamina el módulo sembrando los parámetros de ESTA función, y se
      // toma por limpias las que ya se sabe que sanean.
      const { contamina } = contaminar(arbol, new Set(sanean), {
        nombreSemilla: null,
        esSemilla: (e) => ts.isIdentifier(e) && f.parametros.includes(e.text),
      })
      if (f.salidas.length && f.salidas.every(s => !contamina(s))) {
        sanean.add(f.nombre); cambio = true
      }
    }
  }
  return sanean
}

/**
 * AH4 — La cota de sesión analiza **fichero a fichero**, así que sacar el accesor
 * a otro módulo la deja muda: `export const authDe = () => createClient().auth`
 * en `lib/supabase/client.ts`, y `await authDe().getSession()` en la vista,
 * retiraba el `Promise.race` de D.6 con los dos ficheros en verde.
 *
 * Esto devuelve los nombres exportados que **entregan** lo que se siembra. Es la
 * misma técnica que `funcionesQueSanean`, con el signo cambiado: allí interesa
 * quién limpia, aquí quién reparte.
 */
const pelarSalida = (e: ts.Node): ts.Node => {
  let n = e
  for (;;) {
    if (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) ||
        ts.isAsExpression(n) || ts.isNonNullExpression(n)) { n = n.expression; continue }
    return n
  }
}

export function funcionesQueEntregan(
  fuente: string, semilla: Semilla, nombre = 'm.ts',
): Set<string> {
  const arbol = analizar(fuente, nombre)
  const { contamina } = contaminar(arbol, new Set(), semilla)
  const semillaDirecta = (n: ts.Node) => !!semilla.esSemilla?.(n)
  const entregan = new Set<string>()
  const anotar = (n: string) => { entregan.add(n); const a = alias.get(n); if (a) entregan.add(a) }

  /**
   * AI2 — Exportar no es sólo `export const`. La versión anterior sólo miraba el
   * modificador en línea, así que `export { authDe }` en sentencia aparte,
   * `export default` y el renombrado se colaban: cinco maneras de sacar el mismo
   * símbolo, una reconocida.
   */
  const sueltos = new Set<string>()
  const alias = new Map<string, string>()
  const recogerExports = (n: ts.Node): void => {
    if (ts.isExportDeclaration(n) && n.exportClause && ts.isNamedExports(n.exportClause)) {
      for (const el of n.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text
        sueltos.add(local)
        // `export { interno as authDe }`: fuera se importa `authDe`, así que es
        // ese nombre el que hay que devolver.
        if (el.propertyName) alias.set(local, el.name.text)
      }
    }
    if (ts.isExportAssignment(n) && ts.isIdentifier(n.expression)) sueltos.add(n.expression.text)
    ts.forEachChild(n, recogerExports)
  }
  ts.forEachChild(arbol, recogerExports)

  const exportado = (n: ts.Node, nombreDeclarado?: string) => {
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined
    if (mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return true
    return !!nombreDeclarado && sueltos.has(nombreDeclarado)
  }
  const salidas = salidasDeUnCuerpo

  /**
   * AI3 — «Entregar» es **devolverlo**, no contenerlo. La versión anterior daba
   * por accesor a toda función cuya salida contuviera un `.auth` en cualquier
   * posición, incluido un argumento de callback: medido, `accesoresDeAuth()`
   * devolvía las cuatro acciones de servidor —por el
   * `traducirConSesion(error, () => supabase.auth.getUser())` que todas tienen—
   * y **cero accesores**. Se exige que la salida, pelada, sea la semilla o algo
   * que la propague directamente.
   */
  const entrega = (salida: ts.Node): boolean => {
    const n = pelarSalida(salida)
    if (semillaDirecta(n)) return true
    // `() => c.auth` y `() => { const { auth } = c; return auth }`: lo que sale
    // ES el cliente. Un objeto que lo lleva dentro, no.
    if (ts.isIdentifier(n)) return contamina(n)
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) return contamina(n)
    if (ts.isCallExpression(n)) return contamina(n.expression)
    return false
  }

  ts.forEachChild(arbol, (n) => {
    // `export default () => createClient().auth`: sin nombre, pero se exporta.
    if (ts.isExportAssignment(n) && !ts.isIdentifier(n.expression)) {
      const v = pelarSalida(n.expression)
      const cuerpo = (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) ? v.body : v
      if (salidas(cuerpo).some(entrega)) entregan.add('default')
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body && exportado(n, n.name.text)) {
      if (salidas(n.body).some(entrega)) anotar(n.name.text)
      return
    }
    if (!ts.isVariableStatement(n)) return
    for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue
      if (!exportado(n, d.name.text)) continue
      const v = d.initializer
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) {
        if (salidas(v.body).some(entrega)) anotar(d.name.text)
      } else if (entrega(v)) anotar(d.name.text)
    }
  })
  return entregan
}
