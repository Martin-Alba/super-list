import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { analizar } from './comentarios'
import { contaminar, traductoresImportados } from './contaminacion'
import { ficherosDeProducto, ficherosDeProductoEach } from './producto'
import { funcionesQueEntregan } from './traductor'

/**
 * T7 / DoD 37 — Quitar el `Promise.race` no ponía nada rojo, y la revisión lo
 * midió. La razón es honesta: la cota **no cambia lo que el usuario ve** —el
 * aviso ya se pintó antes—, así que ningún test de comportamiento puede cazarla.
 * Lo que garantiza es D.6: ninguna llamada de red sin cota. Eso es una propiedad
 * del código, y se comprueba sobre el árbol, no sobre el texto.
 */

/**
 * AB3 — Tres iteraciones decidiendo por la **forma**: primero el argumento a un
 * traductor, luego el `if` con salida pelada. Once formas medidas se colaban
 * —`Boolean(x)`, `!!x`, ternario izado, `switch`, `||`, `&&`, comparación izada,
 * objeto envoltorio, función auxiliar, la promesa en variable—, y quitar la cota
 * de D.6 del fichero real dejaba 813/813 en verde.
 *
 * Ahora decide la **contaminación**, igual que la guarda de fugas: se sigue el
 * resultado de la consulta, y si se usa para algo que no sea una puerta de
 * navegación, la consulta tiene que ir acotada. Un `getUser()` cuyo único uso es
 * `if (!user) redirect('/login')` es una comprobación de acceso y le basta la
 * cota del transporte; cualquier otro uso significa que alguien está esperando
 * ese dato para saber qué se le enseña.
 */
/** El nombre por el que se invoca algo, sea identificador o método. */
const nombreInvocado = (n: ts.CallExpression): string | null =>
  ts.isIdentifier(n.expression) ? n.expression.text
    : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null

const pelarLlamada = (e: ts.Node): ts.CallExpression | null => {
  const n = ts.isAwaitExpression(e) ? e.expression : e
  return ts.isCallExpression(n) ? n : null
}

/**
 * AH4 — Los accesores de auth que viven en OTRO fichero. El análisis es por
 * fichero, así que sin esto basta con extraer `() => createClient().auth` a
 * `lib/supabase/client.ts` para que la vista deje de mostrar un `.auth` y la
 * cota se calle. Se calcula una vez sobre todo el producto.
 */
const esAuth = (e: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(e) && e.name.text === 'auth') ||
  (ts.isElementAccessExpression(e) && !!e.argumentExpression &&
   ts.isStringLiteral(e.argumentExpression) && e.argumentExpression.text === 'auth')

/** Una consulta de sesión escrita entera: `x.auth.getSession()`. */
const esConsultaDeAuth = (e: ts.Node): boolean => {
  const n = ts.isAwaitExpression(e) ? e.expression : e
  return ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
    (esAuth(n.expression.expression) ||
     (ts.isPropertyAccessExpression(n.expression.expression) &&
      esAuth(n.expression.expression)))
}

let accesoresCache: { clientes: Set<string>; consultas: Set<string> } | undefined

/**
 * AI2 — Lo que otro fichero puede entregarte son **dos** cosas, y las dos apagan
 * la cota si no se miran: el cliente de auth (`() => createClient().auth`) y la
 * consulta entera (`() => createClient().auth.getSession()`), que ni siquiera es
 * un accesor. AH4 cerró la primera.
 */
export function accesoresDeAuth(): { clientes: Set<string>; consultas: Set<string> } {
  if (accesoresCache) return accesoresCache
  const clientes = new Set<string>()
  const consultas = new Set<string>()
  for (const ruta of ficherosDeProducto()) {
    const fuente = readFileSync(ruta, 'utf8')
    for (const n of funcionesQueEntregan(fuente, { nombreSemilla: 'auth', esSemilla: esAuth }, ruta)) {
      clientes.add(n)
    }
    for (const n of funcionesQueEntregan(
      fuente, { nombreSemilla: null, esSemilla: esConsultaDeAuth }, ruta)) consultas.add(n)
  }
  return (accesoresCache = { clientes, consultas })
}

export function consultasDeSesionSinCota(
  fuente: string, nombre = 'x.tsx',
  deFuera: { clientes: Set<string>; consultas: Set<string> } = accesoresDeAuth(),
): string[] {
  const accesores = deFuera.clientes
  const arbol = analizar(fuente, nombre)
  const sueltas: string[] = []

  /**
   * AD6 — Era una lista de nombres: `getSession | getUser | sonda`. La revisión
   * midió que **renombrar el parámetro `sonda` a `probe`** apagaba la guarda
   * entera de `lib/errors.ts`. Un nombre no es una propiedad del código.
   *
   * Lo que sí lo es: una consulta de sesión es una llamada **al cliente de
   * auth** —`algo.auth.loQueSea()`—, o la invocación de un parámetro cuyo
   * contrato declara que devuelve una sesión. Ese contrato está escrito en la
   * anotación de tipo, que es donde vive de verdad, y no cambia al renombrar.
   */
  const declaraSesion = (t: ts.Node | undefined): boolean =>
    !!t && /\b(user|session)\b/i.test(t.getText(arbol))

  const esParametroDeSonda = (nombre: string, desde: ts.Node): boolean => {
    for (let p: ts.Node | undefined = desde; p; p = p.parent) {
      const params = (p as ts.Node & { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters
      if (!params) continue
      for (const par of params) {
        if (ts.isIdentifier(par.name) && par.name.text === nombre && declaraSesion(par.type)) return true
      }
    }
    return sondasPorUso.has(nombre)
  }

  /**
   * AD6 — La anotación de tipo es el contrato, pero puede faltar. La segunda vía
   * no depende de nada escrito a mano: se siembra la llamada y se mira si de ella
   * sale un `.user` o un `.session`. Si de llamar a `f()` sale una sesión, `f` es
   * una sonda de sesión, se llame `sonda`, `probe` o `x`.
   */
  const sondasPorUso = new Set<string>()
  {
    const candidatos = new Set<string>()
    const buscar = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const nombre = n.expression.text
        for (let p: ts.Node | undefined = n; p; p = p.parent) {
          const params = (p as ts.Node & { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters
          if (params?.some(par => ts.isIdentifier(par.name) && par.name.text === nombre)) {
            candidatos.add(nombre); break
          }
        }
      }
      ts.forEachChild(n, buscar)
    }
    ts.forEachChild(arbol, buscar)

    for (const nombre of candidatos) {
      const { contamina } = contaminar(arbol, new Set(), {
        nombreSemilla: null,
        esSemilla: (e) => ts.isCallExpression(e) && ts.isIdentifier(e.expression) &&
          e.expression.text === nombre,
      })
      let da = false
      const mirar = (n: ts.Node): void => {
        if (ts.isPropertyAccessExpression(n) && /^(user|session)$/.test(n.name.text) &&
            contamina(n.expression)) da = true
        ts.forEachChild(n, mirar)
      }
      ts.forEachChild(arbol, mirar)
      if (da) sondasPorUso.add(nombre)
    }
  }

  /**
   * AE4 — Reconocer el cliente de auth por la FORMA `X.auth.m()` era una lista de
   * formas donde antes había una de nombres. La revisión lo midió: izar el
   * cliente a una variable —`const auth = createClient().auth`— y quitar el
   * `Promise.race` dejaba `typecheck`, `lint` y 1025/1025 en verde, restituyendo
   * la espera muda de 30,6 s que S4 arregló.
   *
   * Se sigue el dato: lo que mancha es **leer `.auth`**, y cualquier llamada
   * sobre algo manchado es una consulta de sesión, se escriba en una línea o en
   * cinco.
   */
  const { contamina: esCosaDeAuth, manchados: cosasDeAuth } = contaminar(arbol, new Set(), {
    // Las dos formas de tener el cliente de auth delante: leerlo como campo
    // (`c.auth`) y desestructurarlo (`const { auth } = c`). AH4 — y la tercera:
    // llamar a un accesor que vive en otro fichero.
    nombreSemilla: 'auth',
    // AG4 — y por corchete: `c['auth']` es el mismo cliente que `c.auth`.
    /**
     * AI2 — El símbolo importado, no sólo su llamada: escapan el import de
     * espacio de nombres (`C.authDe()`) y el **valor** exportado
     * (`export const cli = createClient().auth`, usado como `cli.getSession()`).
     */
    esSemilla: (e) => esAuth(e) ||
      (ts.isIdentifier(e) && accesores.has(e.text)) ||
      (ts.isCallExpression(e) && nombreInvocado(e) !== null &&
       (accesores.has(nombreInvocado(e)!) || deFuera.consultas.has(nombreInvocado(e)!))),
  })

  /**
   * AF5 — El cliente también viaja **como argumento**. Medido sobre
   * `GroupView.tsx` real: `const leer = async (a) => a.getSession()` seguido de
   * `leer(createClient().auth)` retiraba el `Promise.race` con la guarda muda.
   * Se propaga al parámetro en el sitio de llamada, que es donde se sabe qué se
   * le está pasando.
   */
  {
    const propagar = (n: ts.Node): void => {
      // AG4 — También la llamada por método: `api.leer(cliente)`. Se compara por
      // el nombre invocado, que es lo que ata con la declaración del ayudante.
      if (ts.isCallExpression(n) &&
          (ts.isIdentifier(n.expression) || ts.isPropertyAccessExpression(n.expression))) {
        const invocado = ts.isIdentifier(n.expression) ? n.expression.text
          : n.expression.name.text
        const indices = n.arguments
          .map((a, i) => (esCosaDeAuth(a) ? i : -1)).filter(i => i >= 0)
        if (indices.length) {
          const mirar = (m: ts.Node): void => {
            const params = (m as ts.Node & { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters
            // AG4 — el ayudante también puede ser una propiedad de un objeto
            // (`const api = { leer: async (a) => … }`) o un método suyo.
            const nombre = ts.isFunctionDeclaration(m) ? m.name?.text
              : ts.isVariableDeclaration(m) && ts.isIdentifier(m.name) ? m.name.text
                : ts.isPropertyAssignment(m) && ts.isIdentifier(m.name) ? m.name.text
                  : ts.isMethodDeclaration(m) && ts.isIdentifier(m.name) ? m.name.text : undefined
            const cuerpoFn = ts.isVariableDeclaration(m) ? m.initializer
              : ts.isPropertyAssignment(m) ? m.initializer : undefined
            const fn = cuerpoFn && (ts.isArrowFunction(cuerpoFn) || ts.isFunctionExpression(cuerpoFn))
              ? cuerpoFn : m
            const ps = params ?? (fn as ts.Node & { parameters?: ts.NodeArray<ts.ParameterDeclaration> }).parameters
            if (nombre === invocado && ps) {
              for (const i of indices) {
                const par = ps[i]
                if (!par) continue
                // AG4 — y el parámetro desestructurado: `async ({ cli }) => …`.
                if (ts.isIdentifier(par.name)) cosasDeAuth.add(par.name.text)
                else {
                  for (const el of par.name.elements) {
                    if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name)) {
                      cosasDeAuth.add(el.name.text)
                    }
                  }
                }
              }
            }
            ts.forEachChild(m, mirar)
          }
          ts.forEachChild(arbol, mirar)
        }
      }
      ts.forEachChild(n, propagar)
    }
    /**
     * AG4 — Eran dos pasadas fijas, que es el número mágico que AC5 quitó del
     * otro motor y volvió a aparecer aquí. Se itera hasta el punto fijo: tres
     * saltos de ayudante se colaban.
     */
    for (let antes = -1; antes !== cosasDeAuth.size; ) {
      antes = cosasDeAuth.size
      ts.forEachChild(arbol, propagar)
    }
  }

  const esConsulta = (e: ts.Node): boolean => {
    const n = ts.isAwaitExpression(e) ? e.expression : e
    if (!ts.isCallExpression(n)) return false
    /**
     * AI2 — La consulta entera extraída a otro fichero: `await leerSesion()`. No
     * es un accesor —no entrega el cliente, entrega la sesión ya consultada—, así
     * que la puerta que AH4 cerró no la veía.
     */
    const invocadoAqui = nombreInvocado(n)
    if (invocadoAqui && deFuera.consultas.has(invocadoAqui)) return true
    // El cliente de auth, se llame como se llame el método y esté donde esté.
    if (ts.isPropertyAccessExpression(n.expression) &&
        esCosaDeAuth(n.expression.expression)) return true
    if (ts.isIdentifier(n.expression) && esParametroDeSonda(n.expression.text, n)) return true
    const f = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
      : ts.isIdentifier(n.expression) ? n.expression.text : null
    if (f === 'traducirConSesion') return true
    if (f === 'race' && n.arguments[0] && ts.isArrayLiteralExpression(n.arguments[0])) {
      return n.arguments[0].elements.some(esConsulta)
    }
    return false
  }

  /**
   * AC1 — Aquí vivía `lleva`, un segundo motor de contaminación escrito a mano,
   * más pobre que el compartido: la revisión midió **catorce** formas legales que
   * dejaban retirar el `Promise.race` con la suite en verde —plantilla, array
   * intermedio, `typeof`, `satisfies`, método sobre la sesión, spread, `.join()`,
   * `Map.set/get`, desestructuración de array, `for..of`, campo por asignación,
   * `.then()` y dos extracciones de ayudante—, tres de ellas demostradas sobre
   * `GroupView.tsx` real. Es la cicatriz X2 exacta: dos copias del mismo análisis,
   * y la que se usa menos se queda atrás.
   *
   * Ahora es **el mismo motor** que las guardas de fuga, con otra semilla: no el
   * error de la base, sino el resultado de la consulta de sesión.
   */
  const { contamina: lleva } = contaminar(arbol, new Set(), {
    nombreSemilla: null, esSemilla: esConsulta, porLaCondicion: true,
  })

  /**
   * AD6 — Eran siete nombres a mano. Ahora se derivan de dos hechos del código:
   * cualquier símbolo importado del módulo de errores —que es, por definición,
   * quien decide el mensaje— y cualquier `setX` de React, que es quien lo pone
   * en pantalla. Añadir un traductor o un estado nuevo ya no exige tocar la
   * guarda, que es exactamente como se le escapaban.
   */
  const PINTAN = ['setNotice', 'describeError', 'clasificar', 'haySesionSegun',
    'traducirError', 'traducirConSesion', 'avisarTexto', 'mensajeDe', 'claseDe',
    'refinarSinSesion', ...traductoresImportados(arbol)]
  /**
   * AD6 — El estado de React se reconoce por dónde NACE, no por el prefijo
   * `set`: `supabase.realtime.setAuth(token)` casaba con `/^set[A-Z]/` y hacía
   * que `lib/useGroupChannel.ts` —que usa la sesión para autenticar el socket,
   * no para decir nada— exigiera una carrera que no necesita.
   */
  const estadosDeReact = new Set<string>()
  {
    const buscar = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isArrayBindingPattern(n.name) && n.initializer) {
        const c = pelarLlamada(n.initializer)
        const f = c && ts.isIdentifier(c.expression) ? c.expression.text : null
        if (f === 'useState' || f === 'useReducer') {
          const segundo = n.name.elements[1]
          if (segundo && !ts.isOmittedExpression(segundo) && ts.isIdentifier(segundo.name)) {
            estadosDeReact.add(segundo.name.text)
          }
        }
      }
      ts.forEachChild(n, buscar)
    }
    ts.forEachChild(arbol, buscar)
  }
  const esPintor = (f: string): boolean => PINTAN.includes(f) || estadosDeReact.has(f)
  /**
   * Y las funciones locales que pintan cuentan como pintar: si no, un
   * `function redirect(x) { setNotice(x) }` local apagaba la guarda con sólo
   * llamarse como algo que navega.
   */
  const localesQuePintan = new Set<string>()
  const recogerLocales = (n: ts.Node): void => {
    const cuerpo = ts.isFunctionDeclaration(n) ? n.body
      : ts.isVariableDeclaration(n) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
        ? n.initializer.body : undefined
    const nombre = ts.isFunctionDeclaration(n) ? n.name?.text
      : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : undefined
    if (cuerpo && nombre) {
      let si = false
      const mirar = (m: ts.Node): void => {
        if (ts.isCallExpression(m)) {
          const f = ts.isIdentifier(m.expression) ? m.expression.text
            : ts.isPropertyAccessExpression(m.expression) ? m.expression.name.text : null
          if (f && esPintor(f)) si = true
        }
        ts.forEachChild(m, mirar)
      }
      mirar(cuerpo)
      if (si) localesQuePintan.add(nombre)
    }
    ts.forEachChild(n, recogerLocales)
  }
  ts.forEachChild(arbol, recogerLocales)
  const pinta = (n: ts.Node): boolean => {
    let si = false
    const mirar = (m: ts.Node): void => {
      if (ts.isCallExpression(m)) {
        const f = ts.isIdentifier(m.expression) ? m.expression.text
          : ts.isPropertyAccessExpression(m.expression) ? m.expression.name.text : null
        if (f && (esPintor(f) || localesQuePintan.has(f))) si = true
      }
      ts.forEachChild(m, mirar)
    }
    mirar(n)
    return si
  }

  /**
   * AB3 — Lo que exige cota propia no es *usar* la sesión: es que el dato decida
   * **qué se le enseña al usuario**. `useGroupChannel` la usa para autenticar el
   * socket y `page.tsx` para redirigir; ninguno hace esperar a nadie mirando una
   * pantalla muda. Se reconoce de dos maneras, y las dos siguen el dato:
   *
   *  (a) llega como argumento a algo que pinta o traduce; o
   *  (b) gobierna un `if` cuya rama pinta, o cuya rama es una salida pelada y el
   *      aviso viene después — que es exactamente la forma de `avisar()`.
   */
  const esExportado = (n: ts.Node): boolean => {
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined
    return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  }
  const dentroDeExportado = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isFunctionDeclaration(p) || ts.isVariableStatement(p)) return esExportado(p)
      if (ts.isArrowFunction(p) || ts.isFunctionExpression(p)) {
        const st = p.parent?.parent?.parent
        if (st && ts.isVariableStatement(st)) return esExportado(st)
      }
    }
    return false
  }

  let decideElMensaje = false
  const mirarUsos = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const f = ts.isIdentifier(n.expression) ? n.expression.text
        : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null
      if (f && (esPintor(f) || localesQuePintan.has(f)) && n.arguments.some(lleva)) decideElMensaje = true
    }
    if (ts.isIfStatement(n) && lleva(n.expression)) {
      const rama = n.thenStatement
      const esSalidaPelada = (r: ts.Statement): boolean => {
        const uno = ts.isBlock(r) && r.statements.length ? r.statements[r.statements.length - 1] : r
        return ts.isReturnStatement(uno)
      }
      if (pinta(rama) || (n.elseStatement && pinta(n.elseStatement))) decideElMensaje = true
      else if (esSalidaPelada(rama)) {
        // El aviso viene después, en el mismo cuerpo.
        for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
          if (ts.isBlock(p)) {
            const i = p.statements.indexOf(n as ts.Statement)
            if (i >= 0 && p.statements.slice(i + 1).some(pinta)) decideElMensaje = true
            break
          }
        }
      }
    }
    if (ts.isSwitchStatement(n) && lleva(n.expression) && pinta(n.caseBlock)) decideElMensaje = true
    /**
     * AD6 — El flujo sólo se contaba por `if` y `switch`. La revisión midió tres
     * refactores legales que retiran el `Promise.race` con la guarda muda:
     * escribir el mismo `if` como ternario, como `&&`, o como `while`.
     */
    if (ts.isConditionalExpression(n) && lleva(n.condition) &&
        (pinta(n.whenTrue) || pinta(n.whenFalse))) decideElMensaje = true
    if (ts.isBinaryExpression(n) &&
        (n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         n.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
         n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) &&
        lleva(n.left) && pinta(n.right)) decideElMensaje = true
    if ((ts.isWhileStatement(n) || ts.isDoStatement(n)) &&
        lleva(n.expression) && pinta(n.statement)) decideElMensaje = true
    /**
     * AJ3 — Si el dato de la sesión **sale del módulo**, alguien lo va a usar
     * para decidir algo y este fichero no puede saber quién. La revisión midió
     * dos extracciones que apagaban la cota por completo: exportar
     * `haySesion(): boolean` o `miId(): string | null` desde otro fichero deja de
     * ser accesor y deja de ser consulta, y en su módulo no pinta nadie. Exportar
     * lo derivado de una sesión obliga a acotarla aquí, que es donde se consulta.
     */
    if (ts.isReturnStatement(n) && n.expression && lleva(n.expression) &&
        dentroDeExportado(n)) decideElMensaje = true
    if (ts.isVariableStatement(n) && esExportado(n) &&
        n.declarationList.declarations.some(d => d.initializer && lleva(d.initializer))) {
      decideElMensaje = true
    }
    ts.forEachChild(n, mirarUsos)
  }
  ts.forEachChild(arbol, mirarUsos)
  if (!decideElMensaje) return []

  const dentroDeCarrera = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) &&
          p.expression.name.text === 'race' &&
          ts.isIdentifier(p.expression.expression) && p.expression.expression.text === 'Promise') return true
    }
    return false
  }
  const esSondaDelTraductor = (n: ts.Node): boolean => {
    if (!traductoresImportados(arbol).has('traducirConSesion')) return false
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) &&
          p.expression.text === 'traducirConSesion') return true
    }
    return false
  }

  const visitar = (n: ts.Node): void => {
    // AD6 — y aquí estaba la MISMA lista otra vez. Se pregunta lo mismo que en
    // la siembra: si es una consulta de sesión, y no por cómo se llame.
    const llamado = ts.isCallExpression(n) ? n.expression : undefined
    const invocado = llamado && ts.isPropertyAccessExpression(llamado) ? llamado.name.text
      : llamado && ts.isIdentifier(llamado) ? llamado.text : null
    // `Promise.race` es la cota, y el traductor acota la suya dentro: ninguno de
    // los dos es una consulta que reportar, son los que la envuelven.
    // AD6 — `supabase.auth.signOut()` es una llamada al cliente de auth cuyo
    // valor nadie lee: no puede decidir ningún mensaje, y exigirle carrera sería
    // ruido. Se mira si el valor se consume.
    const seDescarta = (c: ts.Node): boolean => {
      const p = ts.isAwaitExpression(c.parent) ? c.parent.parent : c.parent
      return !!p && (ts.isExpressionStatement(p) || ts.isVoidExpression(p))
    }
    if (ts.isCallExpression(n) && esConsulta(n) && !seDescarta(n) &&
        !(invocado && (invocado === 'race' || traductoresImportados(arbol).has(invocado))) &&
        !dentroDeCarrera(n) && !esSondaDelTraductor(n)) {
      const como = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text
        : ts.isIdentifier(n.expression) ? n.expression.text : 'consulta'
      sueltas.push(`${como} (línea ${arbol.getLineAndCharacterOfPosition(n.getStart(arbol)).line + 1})`)
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return sueltas
}

/** W5 — se barre todo el producto: el detector decide, por flujo, a quién exigir. */

describe('U5 la consulta de sesión que el usuario espera va acotada (D.6)', () => {
  const TODOS = ficherosDeProductoEach()
  // W5 — se barren TODOS: el propio detector decide, por flujo de datos, si
  // esa consulta necesita cota corta.
  it('el barrido mira todo el producto', () => {
    expect(TODOS.length, 'el barrido no mira nada').toBeGreaterThan(10)
  })

  it.each(TODOS)('%s no consulta la sesión sin cota', (ruta: string) => {
    expect(consultasDeSesionSinCota(readFileSync(ruta, 'utf8'), ruta.split('/').pop()!)).toEqual([])
  })

  it('las consultas que NO deciden el mensaje van por el transporte', () => {
    for (const f of ['lib/supabase/client.ts', 'lib/supabase/server.ts']) {
      expect(readFileSync(f, 'utf8'), `${f} dejó de instalar la cota de transporte`)
        .toMatch(/global:\s*\{\s*fetch:\s*boundedFetch\(\)/)
    }
  })

  // W5 — la sonda del alcance: el detector sólo exige carrera cuando el dato de
  // la sesión llega a decidir el mensaje, y lo sabe siguiéndolo, no por el nombre.
  it('una consulta que sólo decide una redirección no necesita carrera', () => {
    expect(consultasDeSesionSinCota(
      `async function f() { const { data } = await supabase.auth.getUser()
        if (!data.user) redirect('/login') }`)).toEqual([])
  })

  it('la misma consulta, si decide el mensaje, sí la necesita', () => {
    expect(consultasDeSesionSinCota(
      `async function f() { const { data, error: e } = await supabase.auth.getUser()
        return describeError('x', '42501', haySesionSegun(data.user, e)) }`)).not.toEqual([])
  })

  // X4 / DoD 72 — la forma real de las acciones: la consulta va en la sonda, y
  // la carrera vive en el destinatario, que este mismo barrido comprueba.
  it('la forma de app/actions.ts no se marca, porque la acota el destinatario', () => {
    expect(consultasDeSesionSinCota(
      `import { traducirConSesion } from '@/lib/errors'
       async function f() { return traducirConSesion(error, () => supabase.auth.getUser()) }`))
      .toEqual([])
  })

  // Z7 — aquí había una aserción sobre la propia constante: sólo podía fallar
  // editándose a sí misma (§E.3). El test del homónimo, que sí analiza, ya se
  // pone rojo si se quita `traducirConSesion` de la lista.

  // AA3 / DoD 89 — un `redirect` local no puede apagar la guarda.
  it.each(['redirect', 'notFound'])('un %s local no exime', (nombre) => {
    expect(consultasDeSesionSinCota(
      `function ${nombre}(x) { setNotice({ texto: x }) }
       async function avisar() { const { data } = await createClient().auth.getSession()
        if (!data.session) ${nombre}('x')
        setNotice({ texto: 'y' }) }`), 'un homónimo local apagó la guarda').not.toEqual([])
  })

  it('un homónimo local no exime', () => {
    expect(consultasDeSesionSinCota(
      `function traducirConSesion(e, hay) { return e }
       async function f() { const { data } = await supabase.auth.getUser()
         return traducirConSesion(error, data.user) }`)).not.toEqual([])
  })

  it('pero si el destinatario pierde su carrera, se pone rojo ALLÍ', () => {
    expect(consultasDeSesionSinCota(
      `async function traducirConSesion(error, sonda) {
        const { data, error: e } = await sonda()
        return describeError('x', '42501', haySesionSegun(data.user, e)) }`)).not.toEqual([])
  })

  // Y3 / DoD 77 — la forma de `avisar()`: el dato decide por flujo de control.
  it('no marca el `if` que gobierna una redirección', () => {
    expect(consultasDeSesionSinCota(
      `import { redirect } from 'next/navigation'
       async function pagina() { const { data } = await supabase.auth.getUser()
        if (!data.user) redirect('/login')
        return describeError('x', null) }`)).toEqual([])
  })

  // Z2 / DoD 83 — los cinco refactores legales que apagaban la guarda.
  it.each([
    ['pinta dentro de la rama', `if (!data.session) setNotice({ texto: 'x' })`],
    ['pinta y sale', `if (!data.session) { setNotice({ texto: 'x' }); return }`],
    ['return con valor', `if (data.session) return null
        setNotice({ texto: 'x' })`],
    ['ternario en el aviso', `setNotice({ texto: data.session ? 'a' : 'b' })`],
    ['traduce en la rama', `if (!data.session) setNotice({ texto: describeError('x','42501',false) })`],
  ])('caza %s', (_n, cuerpo) => {
    expect(consultasDeSesionSinCota(
      `async function avisar() { const { data } = await createClient().auth.getSession()
        ${cuerpo} }`), 'un refactor legal apaga la guarda').not.toEqual([])
  })

  it('caza la consulta que decide por un `if`, no por argumento', () => {
    expect(consultasDeSesionSinCota(
      `async function avisar() { const { data } = await createClient().auth.getSession()
        if (data.session) return
        setNotice({ texto: 'x' }) }`)).not.toEqual([])
  })

  it('y con la carrera, tampoco esa se marca', () => {
    expect(consultasDeSesionSinCota(
      `async function avisar() { const { data } = await Promise.race([
          createClient().auth.getSession(),
          new Promise((_, no) => setTimeout(() => no(new Error('x')), 2000)),
        ])
        if (data.session) return
        setNotice({ texto: 'x' }) }`)).toEqual([])
  })

  it('y con la carrera, no', () => {
    expect(consultasDeSesionSinCota(
      `async function f() { const { data, error: e } = await Promise.race([
          supabase.auth.getUser(),
          new Promise((_, no) => setTimeout(() => no(new Error('x')), 2000)),
        ])
        return describeError('x', '42501', haySesionSegun(data.user, e)) }`)).toEqual([])
  })

  // DoD 57 — la cota tiene que ser una cota: 30 s no lo es.
  it('la cota por defecto del traductor está muy por debajo del transporte', () => {
    const fuente = readFileSync('lib/errors.ts', 'utf8')
    const m = fuente.match(/cotaMs\s*=\s*([\d_]+)/)
    expect(m, 'el traductor dejó de declarar su cota').not.toBeNull()
    const ms = Number(m![1].replace(/_/g, ''))
    expect(ms, 'una cota de más de 3 s es la espera muda que S4 midió').toBeLessThanOrEqual(3_000)
    expect(ms).toBeGreaterThan(0)
  })

  // Sonda (§E.2): la guarda tiene que cazar exactamente lo que se retiró.
  // Las sondas llevan la traducción: sin ella la consulta NO decide ningún
  // mensaje y, con la regla nueva, no necesita cota corta — es una comprobación
  // de acceso y le basta el transporte.
  it.each([
    ['await pelado', 'const { data } = await createClient().auth.getSession()'],
    ['getUser suelto', 'const { data } = await supabase.auth.getUser()'],
  ])('caza %s cuando decide el mensaje', (_n, forma) => {
    expect(consultasDeSesionSinCota(
      `async function f() { ${forma}
        return describeError('x', '42501', haySesionSegun(data.user, null)) }`)).not.toEqual([])
  })

  it('no marca la que sí va en carrera', () => {
    expect(consultasDeSesionSinCota(`async function f() {
      const { data } = await Promise.race([
        createClient().auth.getSession(),
        new Promise((_, no) => setTimeout(() => no(new Error('x')), 2000)),
      ])
      return data
    }`)).toEqual([])
  })
})

/**
 * AB3 / DoD 94, 95 — Las once formas que la revisión midió sin disparar la
 * guarda, y la que demostró sobre el fichero real: quitar la cota de D.6 con un
 * `Boolean(...)` de por medio dejaba 813/813 en verde.
 */
describe('AB3 las once formas de flujo se cazan', () => {
  const conCuerpo = (cuerpo: string) =>
    `async function avisar() { const { data } = await createClient().auth.getSession()
      ${cuerpo} }`

  it.each([
    ['Boolean() intermedio', 'const hay = Boolean(data.session)\n      if (hay) return\n      setNotice({ texto: "x" })'],
    ['doble negación', 'const hay = !!data.session\n      if (hay) return\n      setNotice({ texto: "x" })'],
    ['ternario izado', 'const t = data.session ? 1 : 2\n      setNotice({ texto: String(t) })'],
    ['switch', 'switch (data.session) { case null: setNotice({ texto: "x" }); break }'],
    ['coalescencia', 'const hay = data.session || null\n      if (hay) return\n      setNotice({ texto: "x" })'],
    ['conjunción', 'const hay = data.session && true\n      if (hay) return\n      setNotice({ texto: "x" })'],
    ['comparación izada', 'const hay = data.session === null\n      if (hay) setNotice({ texto: "x" })'],
    ['objeto envoltorio', 'const env = { s: data.session }\n      if (env.s) return\n      setNotice({ texto: "x" })'],
    ['función auxiliar', 'const decide = (s) => setNotice({ texto: String(s) })\n      decide(data.session)'],
    ['rama que pinta', 'if (!data.session) setNotice({ texto: "x" })'],
    ['pinta y sale', 'if (!data.session) { setNotice({ texto: "x" }); return }'],
  ])('caza %s', (_n, cuerpo) => {
    expect(consultasDeSesionSinCota(conCuerpo(cuerpo)), 'un refactor legal apagó la cota')
      .not.toEqual([])
  })

  it('la promesa guardada en variable tampoco escapa', () => {
    expect(consultasDeSesionSinCota(
      `async function avisar() { const pr = createClient().auth.getSession()
        const { data } = await pr
        if (data.session) return
        setNotice({ texto: 'x' }) }`)).not.toEqual([])
  })

  // El control: con la carrera puesta, ninguna de las once se marca.
  it.each([
    ['Boolean() intermedio', 'const hay = Boolean(data.session)\n      if (hay) return\n      setNotice({ texto: "x" })'],
    ['rama que pinta', 'if (!data.session) setNotice({ texto: "x" })'],
  ])('con la carrera, %s no se marca', (_n, cuerpo) => {
    expect(consultasDeSesionSinCota(
      `async function avisar() { const { data } = await Promise.race([
          createClient().auth.getSession(),
          new Promise((_, no) => setTimeout(() => no(new Error('x')), 2000)),
        ])
        ${cuerpo} }`)).toEqual([])
  })
})

/**
 * AC1 / DoD 103 — Las catorce formas que la revisión midió contra el motor
 * casero (`lleva`): todas dejaban retirar el `Promise.race` de D.6 con la suite
 * entera en verde, y tres estaban demostradas sobre `GroupView.tsx` real.
 *
 * Ninguna es exótica. Son las formas en que una persona escribe cuando extrae un
 * ayudante o guarda un valor intermedio, que es justo cuando una guarda callada
 * hace daño: el refactor parece inocente y la cota desaparece con él.
 */
describe('AC1 el motor compartido caza las catorce formas del flujo de sesión', () => {
  const conFlujo = (forma: string) => `async function f() {
  const { data } = await supabase.auth.getSession()
  const hay = ${forma}
  setNotice(hay ? 'sí' : 'no')
}`
  it.each([
    ['plantilla', '`${data.session}`'],
    ['array intermedio', '[data.session][0]'],
    ['typeof', 'typeof data.session'],
    ['satisfies', '(data.session satisfies unknown)'],
    ['método sobre la sesión', 'data.session?.toString()'],
    ['spread en un objeto', '({ ...data }).session'],
    ['join', '[data.session].join("")'],
    ['desestructuración de array', '[data.session][0] as unknown'],
    ['negación doble', '!!data.session'],
    ['comparación', 'data.session !== null'],
    ['objeto envoltorio', '({ s: data.session }).s'],
    ['ayudante declarado', 'leer(data)'],
    ['ayudante flecha', 'leer2(data)'],
    ['cast', 'data.session as unknown'],
  ])('exige cota con %s', (_n, forma) => {
    const fuente = `function leer(x: any) { return x.session }
const leer2 = (x: any) => x.session
${conFlujo(forma)}`
    expect(consultasDeSesionSinCota(fuente), 'esta forma apagaba la cota de D.6')
      .not.toEqual([])
  })

  it.each([
    ['Map', 'const m = new Map(); m.set("s", data.session); const hay = m.get("s")'],
    ['for..of', 'let s: any; for (const x of [data.session]) { s = x } const hay = s'],
    ['campo por asignación', 'const o: any = {}; o.s = data.session; const hay = o.s'],
  ])('exige cota con %s', (_n, cuerpo) => {
    expect(consultasDeSesionSinCota(`async function f() {
  const { data } = await supabase.auth.getSession()
  ${cuerpo}
  setNotice(hay ? 'sí' : 'no')
}`), 'esta forma apagaba la cota de D.6').not.toEqual([])
  })

  it('y con la carrera puesta, ninguna de las diecisiete la exige', () => {
    expect(consultasDeSesionSinCota(`async function f() {
  const { data } = await Promise.race([supabase.auth.getSession(), tarde()])
  const hay = \`\${data.session}\`
  setNotice(hay ? 'sí' : 'no')
}`)).toEqual([])
  })
})

/**
 * AD6 / DoD 117-118 — Los cuatro refactores que la revisión midió sobre los
 * ficheros reales: los cuatro retiraban el `Promise.race` de D.6 y dejaban la
 * guarda muda. Tres son la misma condición escrita de otra manera; el cuarto es
 * cambiarle el nombre a un parámetro.
 */
describe('AD6 la cota no depende de cómo se escriba la condición ni de cómo se llame nada', () => {
  const conFlujo = (cuerpo: string) => `async function f() {
  const { data } = await supabase.auth.getSession()
  ${cuerpo}
}`
  it.each([
    ['ternario en vez de if', "const t = data.session ? 'a' : setNotice('caducó')"],
    ['&& en vez de if', "!data.session && setNotice('caducó')"],
    ['|| en vez de if', "data.session || setNotice('caducó')"],
    ['?? en vez de if', "data.session ?? setNotice('caducó')"],
    ['while en vez de if', "while (!data.session) { setNotice('caducó'); break }"],
    ['do..while', "do { setNotice('caducó') } while (!data.session)"],
  ])('exige cota con %s', (_n, cuerpo) => {
    expect(consultasDeSesionSinCota(conFlujo(cuerpo)),
      'este refactor retiraba la cota de D.6 sin que nada se pusiera rojo').not.toEqual([])
  })

  // DoD 118 — el parámetro se llamaba `sonda` y la guarda buscaba ese nombre.
  it.each(['sonda', 'probe', 'q', 'dameLaSesion'])(
    'la sonda del traductor se reconoce llamándose %s', (nombre) => {
      expect(consultasDeSesionSinCota(
        `async function traducirConSesion(error, ${nombre}) {
          const { data, error: e } = await ${nombre}()
          return describeError('x', '42501', haySesionSegun(data.user, e)) }`),
        `renombrar el parámetro a ${nombre} apagaba la guarda entera del fichero`)
        .not.toEqual([])
    })

  it('y con su carrera puesta, ninguno de los cuatro nombres se marca', () => {
    for (const nombre of ['sonda', 'probe', 'q', 'dameLaSesion']) {
      expect(consultasDeSesionSinCota(
        `async function traducirConSesion(error, ${nombre}) {
          const { data, error: e } = await Promise.race([${nombre}(), tarde()])
          return describeError('x', '42501', haySesionSegun(data.user, e)) }`)).toEqual([])
    }
  })

  // La llamada al cliente de auth cuyo valor nadie lee no decide ningún mensaje.
  it('cerrar sesión no es una consulta que decida nada', () => {
    expect(consultasDeSesionSinCota(
      `async function f() { const { data } = await supabase.auth.getSession()
        if (!data.session) setNotice('caducó')
        await supabase.auth.signOut() }`))
      .toEqual(['getSession (línea 1)'])
  })
})

/**
 * AE4 / DoD 129 — El refactor que la revisión midió: izar el cliente de auth a
 * una variable dejaba la guarda muda y el `Promise.race` se podía retirar con
 * `typecheck`, `lint` y 1025/1025 en verde.
 */
describe('AE4 el cliente de auth se reconoce esté izado como esté', () => {
  it.each([
    ['izado a una variable', `const auth = createClient().auth
      async function f() { const { data } = await auth.getSession()
        if (!data.session) setNotice('caducó') }`],
    ['izado dentro de la función', `async function f() {
      const a = createClient().auth
      const { data } = await a.getUser()
      if (!data.user) setNotice('caducó') }`],
    ['izado por desestructuración', `async function f() {
      const { auth } = createClient()
      const { data } = await auth.getSession()
      if (!data.session) setNotice('caducó') }`],
    ['a través de un alias', `const c = createClient(); const q = c.auth
      async function f() { const { data } = await q.getSession()
        if (!data.session) setNotice('caducó') }`],
  ])('exige cota con el cliente %s', (_n, fuente) => {
    expect(consultasDeSesionSinCota(fuente),
      'izar el cliente apagaba la cota de D.6').not.toEqual([])
  })

  it('y con la carrera puesta, el izado tampoco se marca', () => {
    expect(consultasDeSesionSinCota(`const auth = createClient().auth
      async function f() { const { data } = await Promise.race([auth.getSession(), tarde()])
        if (!data.session) setNotice('caducó') }`)).toEqual([])
  })
})

/**
 * AF5 / DoD 142 — El refactor que la revisión midió sobre `GroupView.tsx` real:
 * extraer la consulta a un ayudante y pasarle el cliente como argumento retiraba
 * el `Promise.race` de D.6 con la guarda muda.
 */
describe('AF5 el cliente de auth se sigue hasta el argumento', () => {
  it.each([
    ['ayudante flecha', `const leer = async (a) => a.getSession()
      async function f() { const { data } = await leer(createClient().auth)
        if (!data.session) setNotice('caducó') }`],
    ['ayudante declarado', `async function leer(a) { return a.getSession() }
      async function f() { const { data } = await leer(createClient().auth)
        if (!data.session) setNotice('caducó') }`],
    ['ayudante que recibe el cliente entero', `const leer = async (c) => c.auth.getUser()
      async function f() { const { data } = await leer(createClient())
        if (!data.user) setNotice('caducó') }`],
  ])('exige cota con la sonda extraída a un %s', (_n, fuente) => {
    expect(consultasDeSesionSinCota(fuente),
      'extraer la sonda a un ayudante apagaba la cota de D.6').not.toEqual([])
  })

  it('y con la carrera dentro del ayudante, no se marca', () => {
    expect(consultasDeSesionSinCota(`const leer = async (a) => Promise.race([a.getSession(), tarde()])
      async function f() { const { data } = await leer(createClient().auth)
        if (!data.session) setNotice('caducó') }`)).toEqual([])
  })
})

/**
 * AG4 / DoD 152 — Las cuatro formas que la revisión midió sobre `GroupView.tsx`
 * real, todas con el `Promise.race` de D.6 retirado y 1093/1093 en verde. Tres
 * son maneras de escribir el mismo ayudante; la cuarta es un corchete.
 */
describe('AG4 la cota alcanza las cuatro formas que faltaban', () => {
  it.each([
    ['parámetro desestructurado', `const leer = async ({ cli }) => cli.getSession()
      async function f() { const { data } = await leer({ cli: createClient().auth })
        if (!data.session) setNotice('caducó') }`],
    ['llamada por método', `const api = { leer: async (a) => a.getSession() }
      async function f() { const { data } = await api.leer(createClient().auth)
        if (!data.session) setNotice('caducó') }`],
    ['acceso por corchete', `async function f() { const c = createClient()
      const { data } = await c['auth'].getSession()
      if (!data.session) setNotice('caducó') }`],
    /**
     * AH3 — En orden directo esto ya se cazaba **antes** del punto fijo: la
     * aserción no podía fallar por el cambio que nombraba. Declarados hacia
     * atrás —que es como queda un fichero cuando alguien mueve un ayudante— dos
     * pasadas no llegan.
     */
    ['tres saltos declarados hacia atrás', `const a3 = (z) => z.getSession()
      const a2 = (y) => a3(y)
      const a1 = (x) => a2(x)
      async function f() { const { data } = await a1(createClient().auth)
        if (!data.session) setNotice('caducó') }`],
    ['cinco saltos hacia atrás', `const b5 = (v) => v.getSession()
      const b4 = (u) => b5(u)
      const b3 = (t) => b4(t)
      const b2 = (r) => b3(r)
      const b1 = (q) => b2(q)
      async function f() { const { data } = await b1(createClient().auth)
        if (!data.session) setNotice('caducó') }`],
  ])('exige cota con %s', (_n, fuente) => {
    expect(consultasDeSesionSinCota(fuente),
      'este refactor retiraba la cota de D.6 sin que nada se pusiera rojo').not.toEqual([])
  })
})

/**
 * AH4 / DoD 162 — El accesor que vive en otro fichero. La revisión lo midió
 * sobre los ficheros reales: `export const authDe = () => createClient().auth`
 * en `lib/supabase/client.ts` y `await authDe().getSession()` en la vista
 * retiraban el `Promise.race` de D.6 con **los dos ficheros en verde**, porque el
 * análisis es por fichero y `.auth` deja de verse donde se usa.
 */
describe('AH4 la cota cruza el fichero para encontrar el cliente', () => {
  const accesores = (fuente: string) =>
    funcionesQueEntregan(fuente, { nombreSemilla: 'auth', esSemilla: esAuth }, 'client.ts')

  it.each([
    ['una flecha exportada', 'export const authDe = () => createClient().auth'],
    ['una función declarada', 'export function authDe() { return createClient().auth }'],
    ['un campo desestructurado', 'export const authDe = () => { const { auth } = createClient(); return auth }'],
  ])('reconoce el accesor escrito como %s', (_n, modulo) => {
    expect([...accesores(modulo)], 'este accesor pasaba desapercibido').toContain('authDe')
  })

  it('y con él, la vista que lo usa exige cota', () => {
    const vista = `import { authDe } from '@/lib/supabase/client'
      async function f() { const { data } = await authDe().getSession()
        if (!data.session) setNotice('caducó') }`
    expect(consultasDeSesionSinCota(vista, 'v.tsx', { clientes: new Set(['authDe']), consultas: new Set<string>() }),
      'el accesor de otro fichero apagaba la cota de D.6').not.toEqual([])
    // Y con la carrera puesta, no se marca.
    expect(consultasDeSesionSinCota(`import { authDe } from '@/lib/supabase/client'
      async function f() { const { data } = await Promise.race([authDe().getSession(), tarde()])
        if (!data.session) setNotice('caducó') }`, 'v.tsx', { clientes: new Set(['authDe']), consultas: new Set<string>() })).toEqual([])
  })

  it('sin accesores conocidos, esa misma vista se cuela: por eso se cruzan', () => {
    const vista = `import { authDe } from '@/lib/supabase/client'
      async function f() { const { data } = await authDe().getSession()
        if (!data.session) setNotice('caducó') }`
    expect(consultasDeSesionSinCota(vista, 'v.tsx', { clientes: new Set<string>(), consultas: new Set<string>() })).toEqual([])
  })
})

/**
 * AI2 / DoD 171 — Las cinco maneras de sacar el mismo símbolo a otro fichero. La
 * revisión midió que AH4 cerró **una** de cinco: escapaban el `export` en
 * sentencia aparte, el `export default`, el espacio de nombres, el **valor**
 * exportado —que no es una llamada— y extraer la consulta entera, que ni siquiera
 * es un accesor.
 */
describe('AI2 el accesor se reconoce por el símbolo, no por su forma de salir', () => {
  const desde = (modulo: string) => {
    const semillaCliente = { nombreSemilla: 'auth', esSemilla: esAuth }
    const semillaConsulta = { nombreSemilla: null, esSemilla: esConsultaDeAuth }
    return {
      clientes: funcionesQueEntregan(modulo, semillaCliente, 'client.ts'),
      consultas: funcionesQueEntregan(modulo, semillaConsulta, 'client.ts'),
    }
  }
  const vistaQueLoUsa = (uso: string) => `import { authDe } from '@/lib/supabase/client'
    async function f() { const { data } = await ${uso}
      if (!data.session) setNotice('caducó') }`

  it.each([
    ['export en línea', 'export const authDe = () => createClient().auth', 'authDe().getSession()'],
    ['export en sentencia aparte', 'const authDe = () => createClient().auth\nexport { authDe }', 'authDe().getSession()'],
    ['export con renombrado', 'const interno = () => createClient().auth\nexport { interno as authDe }', 'authDe().getSession()'],
    ['valor exportado, no función', 'export const authDe = createClient().auth', 'authDe.getSession()'],
  ])('caza el accesor sacado por %s', (_n, modulo, uso) => {
    const fuera = desde(modulo)
    expect([...fuera.clientes].length, 'el accesor no se reconoció en el módulo').toBeGreaterThan(0)
    expect(consultasDeSesionSinCota(vistaQueLoUsa(uso), 'v.tsx', fuera),
      'el accesor de otro fichero apagaba la cota de D.6').not.toEqual([])
  })

  it('caza la consulta entera extraída, que ni siquiera es un accesor', () => {
    const fuera = desde('export const leerSesion = () => createClient().auth.getSession()')
    expect([...fuera.consultas], 'la consulta extraída no se reconoció').toContain('leerSesion')
    expect(consultasDeSesionSinCota(`import { leerSesion } from '@/lib/supabase/client'
      async function f() { const { data } = await leerSesion()
        if (!data.session) setNotice('caducó') }`, 'v.tsx', fuera),
      'extraer la consulta entera apagaba la cota').not.toEqual([])
  })

  it('y con la carrera puesta, ninguna de las cinco se marca', () => {
    const fuera = desde('export const authDe = () => createClient().auth')
    expect(consultasDeSesionSinCota(`import { authDe } from '@/lib/supabase/client'
      async function f() { const { data } = await Promise.race([authDe().getSession(), tarde()])
        if (!data.session) setNotice('caducó') }`, 'v.tsx', fuera)).toEqual([])
  })
})

/**
 * AI3 / DoD 172 — «Entregar» es devolverlo, no contenerlo. Medido antes del
 * cambio: `accesoresDeAuth()` daba las **cuatro acciones de servidor** —por el
 * `traducirConSesion(error, () => supabase.auth.getUser())` que todas llevan— y
 * cero accesores, así que cada `createGroupAction(...)` era semilla del cliente
 * de auth en los 22 ficheros.
 */
describe('AI3 entregar el cliente no es llevarlo dentro', () => {
  it('las acciones de servidor no son accesores de auth', () => {
    const { clientes, consultas } = accesoresDeAuth()
    for (const accion of ['createGroupAction', 'createInviteAction', 'decideMemberAction', 'leaveGroupAction']) {
      expect([...clientes], `${accion} no entrega el cliente: lo usa dentro`).not.toContain(accion)
      expect([...consultas], `${accion} no entrega una consulta de sesión`).not.toContain(accion)
    }
  })

  it('pero un accesor de verdad sí', () => {
    const m = 'export const authDe = () => createClient().auth\nexport const usa = (e: any) => trad(e, () => createClient().auth.getUser())'
    const set = funcionesQueEntregan(m, { nombreSemilla: 'auth', esSemilla: esAuth }, 'c.ts')
    expect([...set]).toContain('authDe')
    expect([...set], 'usar el cliente dentro no es entregarlo').not.toContain('usa')
  })
})

/**
 * AJ3 — Corrección de la 17. Tres puertas medidas sobre los ficheros reales: el
 * parámetro **desestructurado** de un `.then(({ data }) => …)` —el idioma que el
 * propio `GroupView.tsx` usa— no se manchaba, y dos extracciones a otro fichero
 * detrás de un valor **derivado** de la sesión no eran ni accesor ni consulta, así
 * que nadie exigía la cota en ninguno de los dos ficheros.
 */
describe('AJ3 la sesión que sale del módulo se acota donde se consulta', () => {
  /**
   * El aviso se pinta **dentro** del callback, que es donde la forma importa: si
   * se pinta fuera, la desestructuración exterior ya mancha el dato y la prueba
   * pasa sin que el parámetro del callback tenga nada que ver. Medido: escrita
   * así, quitar la propagación al parámetro desestructurado no ponía rojo nada.
   */
  it('el parámetro desestructurado de un then se mancha', () => {
    expect(consultasDeSesionSinCota(`function f() {
      void createClient().auth.getSession().then(({ data }: any) => {
        if (!data.session) setNotice('caducó')
      }) }`),
      'el idioma que el propio producto usa apagaba la cota').not.toEqual([])
  })

  it.each([
    ['un booleano derivado', 'export const haySesion = async () => (await createClient().auth.getSession()).data.session != null'],
    ['un identificador derivado', 'export async function miId() { const { data } = await createClient().auth.getUser(); return data.user?.id ?? null }'],
  ])('exige cota al exportar %s', (_n, modulo) => {
    expect(consultasDeSesionSinCota(modulo, 'c.ts'),
      'exportar lo derivado de la sesión sin acotarla dejaba a los dos ficheros mudos').not.toEqual([])
  })

  it('y con la carrera puesta, exportarlo no se marca', () => {
    expect(consultasDeSesionSinCota(
      'export const haySesion = async () => (await Promise.race([createClient().auth.getSession(), t()])).data.session != null',
      'c.ts')).toEqual([])
  })
})
