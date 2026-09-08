import ts from 'typescript'
import { analizar } from './comentarios'

/**
 * AA1 — Las tres versiones anteriores fallaban **abiertas**: marcaban lo que se
 * demostraba peligroso y dejaban pasar todo lo demás. Cada revisión encontró una
 * forma nueva —seis, luego tres— porque la resolución se detenía en cuanto el
 * nodo no tenía la forma prevista y detrás no había nada.
 *
 * Aquí se invierte el sentido, que es lo que A.3 manda: se marca **todo**
 * `.delete()` cuyo receptor no se pueda demostrar inofensivo. Lo inofensivo es un
 * conjunto pequeño y comprobable —un `Set` o un `Map` declarado en el propio
 * fichero—, así que una forma nueva de escribir el borrado ya no es un agujero:
 * es un rojo hasta que alguien la declare segura por escrito.
 */
export const RPC_DEL_PRODUCTO = new Set([
  'create_group', 'create_invite', 'decide_member', 'invite_preview', 'is_active_member',
  'is_group_owner', 'leave_group', 'owns_group_of', 'request_join', 'shares_active_group',
])

const PELIGRO_SQL = /\b(delete\s+from|truncate)\b/i

type Contexto = {
  constantes: Map<string, string>
  /** Nombre → cuántas veces se declara en total, sea del tipo que sea. */
  declaraciones: Map<string, number>
  /** Nombre → cuántas veces se declara. Con más de una, deja de estar demostrado. */
  colecciones: Map<string, number>
  /** Parámetros anotados `Set<…>` o `Map<…>`. */
  parametros: Set<string>
}

/**
 * AB2 — Lo que esta guarda vigila es el borrado **contra la base**. Un
 * `.delete()` sobre un accesor de la plataforma no lo es, y marcarlos daba rojo
 * sobre código correcto: medido en `searchParams`, `cookies()`, `headers` y
 * `formData`. Es el argumento de AA5 del revés — una guarda que marca lo
 * correcto se acaba desactivando — y la spec siguiente toca cookies el primer
 * día.
 */
const ACCESORES_SEGUROS = new Set([
  'searchParams', 'cookies', 'headers', 'formData', 'sessionStorage', 'localStorage',
  'cache', 'caches', 'dataTransfer',
])

/** Quita `as`, `satisfies`, `!` y paréntesis, que ocultaban la cadena real. */
function desenvolver(nodo: ts.Expression): ts.Expression {
  let actual = nodo
  for (;;) {
    if (ts.isAsExpression(actual) || ts.isSatisfiesExpression(actual) ||
        ts.isNonNullExpression(actual) || ts.isParenthesizedExpression(actual) ||
        ts.isTypeAssertionExpression(actual)) {
      actual = actual.expression
      continue
    }
    return actual
  }
}

/** Pliega literales, concatenaciones, plantillas y constantes locales. */
function literal(nodo: ts.Node, ctx?: Contexto): string | null {
  const n = ts.isExpression(nodo) ? desenvolver(nodo) : nodo
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => s.literal.text).join(' ')
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const i = literal(n.left, ctx), d = literal(n.right, ctx)
    if (i !== null && d !== null) return i + d
  }
  // AA2 — `const q = 'delete from …'; pool.query(q)` escapaba.
  if (ts.isIdentifier(n) && ctx?.constantes.has(n.text)) return ctx.constantes.get(n.text)!
  return null
}

function propiedad(nodo: ts.Expression): string | null {
  const n = desenvolver(nodo)
  if (ts.isPropertyAccessExpression(n)) return n.name.text
  if (ts.isElementAccessExpression(n)) return literal(n.argumentExpression)
  return null
}

/** Receptor de `x.delete()`. */
function receptor(nodo: ts.Expression): ts.Expression | null {
  const n = desenvolver(nodo)
  if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) return desenvolver(n.expression)
  return null
}

/**
 * AA1 — Lo único que exime a un `.delete()`: un `Set` o `Map` **declarado en
 * este fichero**. Cualquier otra cosa —una variable de otro sitio, una llamada,
 * un tipo asertado— se marca. Fallar cerrado es la diferencia entre una guarda y
 * una lista de formas ya conocidas.
 */
function esColeccionSegura(nodo: ts.Expression | null, ctx: Contexto): boolean {
  if (!nodo) return false
  if (ts.isNewExpression(nodo) && ts.isIdentifier(nodo.expression)) {
    return nodo.expression.text === 'Set' || nodo.expression.text === 'Map'
  }
  // AB2 — `url.searchParams`, `cookies()`, `req.headers`…
  if (ts.isPropertyAccessExpression(nodo) && ACCESORES_SEGUROS.has(nodo.name.text)) return true
  if (ts.isCallExpression(nodo)) {
    const llamada = ts.isIdentifier(nodo.expression) ? nodo.expression.text : propiedad(nodo.expression)
    if (llamada && ACCESORES_SEGUROS.has(llamada)) return true
  }
  if (!ts.isIdentifier(nodo)) return false
  if (ctx.parametros.has(nodo.text)) return true
  /**
   * AB1 — La resolución tiene **ámbito**. Con un conjunto plano de nombres,
   * reutilizar el de un `Set` existente dejaba verde un borrado real —medido en
   * `app/g/[id]/GroupView.tsx`—; y exigir que *todas* las declaraciones del
   * fichero fueran colecciones daba rojo sobre ese mismo fichero, que usa `next`
   * para dos cosas distintas en dos funciones distintas. Se busca la declaración
   * que gobierna **este** uso.
   */
  return declaracionQueGobierna(nodo) === 'coleccion'
}

type Clase = 'coleccion' | 'otra' | 'ambigua' | 'ninguna'

/** Sube por el árbol hasta el ámbito que declara el nombre y clasifica lo que ata. */
function declaracionQueGobierna(uso: ts.Identifier): Clase {
  const nombre = uso.text
  for (let ambito: ts.Node | undefined = uso; ambito; ambito = ambito.parent) {
    const encontradas: ts.VariableDeclaration[] = []
    const buscar = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === nombre) {
        encontradas.push(n)
      }
      // No se entra en ámbitos anidados: sus declaraciones no gobiernan aquí.
      if (n !== ambito && (ts.isFunctionLike(n) || ts.isBlock(n))) return
      ts.forEachChild(n, buscar)
    }
    if (!ts.isSourceFile(ambito) && !ts.isBlock(ambito) && !ts.isFunctionLike(ambito)) continue
    ts.forEachChild(ambito, buscar)
    if (encontradas.length === 0) continue
    if (encontradas.length > 1) return 'ambigua'

    const ini = encontradas[0].initializer ? desenvolver(encontradas[0].initializer) : null
    const esColeccion = !!ini && ts.isNewExpression(ini) && ts.isIdentifier(ini.expression) &&
      (ini.expression.text === 'Set' || ini.expression.text === 'Map')
    return esColeccion ? 'coleccion' : 'otra'
  }
  return 'ninguna'
}

function contexto(arbol: ts.SourceFile): Contexto {
  const constantes = new Map<string, string>()
  const colecciones = new Map<string, number>()
  const declaraciones = new Map<string, number>()
  const parametros = new Set<string>()
  const sumar = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)

  const visitar = (nodo: ts.Node): void => {
    if (ts.isVariableDeclaration(nodo) && ts.isIdentifier(nodo.name)) {
      sumar(declaraciones, nodo.name.text)
      if (nodo.initializer) {
        const ini = desenvolver(nodo.initializer)
        const texto = literal(ini)
        if (texto !== null) constantes.set(nodo.name.text, texto)
        if (ts.isNewExpression(ini) && ts.isIdentifier(ini.expression) &&
            (ini.expression.text === 'Set' || ini.expression.text === 'Map')) {
          sumar(colecciones, nodo.name.text)
        }
      }
    }
    // AB2 — un `Set`/`Map` recibido por parámetro está tipado, y eso basta.
    if (ts.isParameter(nodo) && ts.isIdentifier(nodo.name) && nodo.type &&
        ts.isTypeReferenceNode(nodo.type) && ts.isIdentifier(nodo.type.typeName) &&
        (nodo.type.typeName.text === 'Set' || nodo.type.typeName.text === 'Map')) {
      parametros.add(nodo.name.text)
    }
    ts.forEachChild(nodo, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return { constantes, colecciones, declaraciones, parametros }
}

export type Hallazgo = { tipo: string; linea: number }

export function hallazgosDetallados(
  fuente: string, nombre = 'entrada.ts', rpcPermitidas: ReadonlySet<string> = RPC_DEL_PRODUCTO,
): Hallazgo[] {
  const arbol = analizar(fuente, nombre)
  const ctx = contexto(arbol)
  const hallazgos: Hallazgo[] = []
  const anotar = (nodo: ts.Node, tipo: string) => {
    const linea = arbol.getLineAndCharacterOfPosition(nodo.getStart(arbol)).line + 1
    if (!hallazgos.some(h => h.tipo === tipo && h.linea === linea)) hallazgos.push({ tipo, linea })
  }

  const mirarSql = (nodo: ts.Node, valor: ts.Node) => {
    const texto = literal(valor, ctx)
    // Se trocea en sentencias igual que el SQL de las migraciones: un `select`
    // del catálogo que **menciona** TRUNCATE como dato no es un borrado, y
    // `unit/grants.test.ts` tiene exactamente esa consulta.
    if (texto && sqlPeligroso(texto)) anotar(nodo, 'SQL que borra')
  }

  const visitar = (nodo: ts.Node): void => {
    if (ts.isBindingElement(nodo)) {
      const origen = nodo.propertyName ?? nodo.name
      if (ts.isIdentifier(origen) && origen.text === 'deleteUser') anotar(nodo, 'deleteUser')
    }

    if (ts.isCallExpression(nodo)) {
      const expr = desenvolver(nodo.expression)
      const nombreLlamada = propiedad(expr) ?? (ts.isIdentifier(expr) ? expr.text : null)

      if (nombreLlamada === 'delete' && !esColeccionSegura(receptor(expr), ctx)) {
        anotar(nodo, '.delete() sobre un receptor no demostrado inofensivo')
      }
      if (nombreLlamada === 'deleteUser') anotar(nodo, 'deleteUser')

      if (nombreLlamada === 'rpc') {
        const cual = nodo.arguments[0] ? literal(nodo.arguments[0], ctx) : null
        if (cual === null || !rpcPermitidas.has(cual)) {
          anotar(nodo, `rpc no reconocida: ${cual ?? '(dinámica)'}`)
        }
      }

      for (const arg of nodo.arguments) {
        mirarSql(nodo, arg)
        // AA2 — `pool.query({ text: 'delete from …' })`: la forma de
        // configuración de `pg`, que es la librería que este arnés usa.
        const a = desenvolver(arg)
        if (ts.isObjectLiteralExpression(a)) {
          for (const prop of a.properties) {
            if (!ts.isPropertyAssignment(prop)) continue
            const clave = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)
              ? prop.name.text
              : literal(prop.name)
            if (clave === 'text' || clave === 'sql' || clave === 'query') mirarSql(nodo, prop.initializer)
          }
        }
      }
    }

    // AA7 — clave computada y valor en variable incluidos.
    if (ts.isPropertyAssignment(nodo)) {
      const clave = ts.isIdentifier(nodo.name) || ts.isStringLiteral(nodo.name)
        ? nodo.name.text
        : ts.isComputedPropertyName(nodo.name) ? literal(nodo.name.expression, ctx) : null
      if (clave === 'method' && literal(nodo.initializer, ctx)?.toUpperCase() === 'DELETE') {
        anotar(nodo, "method: 'DELETE'")
      }
    }

    ts.forEachChild(nodo, visitar)
  }

  ts.forEachChild(arbol, visitar)
  return hallazgos
}

/**
 * AA4 — La exención necesita las tres cosas: fichero en la lista explícita de la
 * guarda, marca en **esa** línea, y que la línea eximida sea ella misma la que
 * afirma la denegación. Antes bastaban las dos primeras, y la marca valía desde
 * la línea anterior: escribirla delante de un borrado nuevo lo eximía.
 */
const MARCA_LINEA = /borrado-permitido:\s*sonda/

export function borradosFisicos(
  fuente: string,
  nombre = 'entrada.ts',
  exencion: { activa: boolean; deniega?: RegExp } = { activa: false },
  rpcPermitidas: ReadonlySet<string> = RPC_DEL_PRODUCTO,
): string[] {
  const lineas = fuente.split('\n')
  const permitida = (n: number) => {
    if (!exencion.activa) return false
    const propia = lineas[n - 1] ?? ''
    const anterior = lineas[n - 2] ?? ''
    if (!MARCA_LINEA.test(anterior) && !MARCA_LINEA.test(propia)) return false
    // La línea eximida tiene que ser la que deniega, no una cualquiera detrás
    // de la marca.
    return exencion.deniega ? exencion.deniega.test(propia) : true
  }
  return [...new Set(hallazgosDetallados(fuente, nombre, rpcPermitidas)
    .filter(h => !permitida(h.linea))
    .map(h => h.tipo))]
}

/**
 * AA3 — El despojador de SQL borraba desde `grant` hasta el **primer** punto y
 * coma, que podía ser el del borrado; y la palabra `grant` escrita dentro de un
 * comentario en un cuerpo `$$` se tragaba la sentencia siguiente. Ahora se
 * trocea de verdad y se descarta sólo la sentencia cuyo primer token concede o
 * retira un privilegio.
 */
export function sentenciasSql(fuente: string): string[] {
  const sentencias: string[] = []
  let actual = ''
  let i = 0
  while (i < fuente.length) {
    const resto = fuente.slice(i)

    if (resto.startsWith('--')) { while (i < fuente.length && fuente[i] !== '\n') i++; continue }
    if (resto.startsWith('/*')) {
      const fin = fuente.indexOf('*/', i + 2)
      i = fin === -1 ? fuente.length : fin + 2
      continue
    }

    const etiqueta = resto.match(/^\$[A-Za-z_]*\$/)
    if (etiqueta) {
      const cierre = fuente.indexOf(etiqueta[0], i + etiqueta[0].length)
      const fin = cierre === -1 ? fuente.length : cierre + etiqueta[0].length
      // El cuerpo se analiza aparte, con sus propios comentarios quitados.
      sentencias.push(...sentenciasSql(fuente.slice(i + etiqueta[0].length, Math.max(i, fin - etiqueta[0].length))))
      i = fin
      continue
    }

    if (fuente[i] === "'" || fuente[i] === '"') {
      const comilla = fuente[i]
      let j = i + 1
      while (j < fuente.length) {
        if (fuente[j] === comilla && fuente[j + 1] === comilla) { j += 2; continue }
        if (fuente[j] === comilla) { j++; break }
        j++
      }
      actual += comilla.repeat(2); i = j
      continue
    }

    if (fuente[i] === ';') { sentencias.push(actual); actual = ''; i++; continue }
    actual += fuente[i]; i++
  }
  if (actual.trim()) sentencias.push(actual)
  return sentencias
}

/**
 * AA3 — Una sentencia `grant`/`revoke` nombra el verbo, no lo ejecuta… pero sólo
 * en su **lista de privilegios**, que va antes del ` on `. Medido: descartar la
 * sentencia entera dejaba pasar `grant select on public.items to anon` seguido,
 * sin punto y coma, de un borrado real.
 */
const VERBOS_SQL = new Set([
  'select', 'insert', 'update', 'delete', 'truncate', 'with', 'create', 'alter', 'drop',
  'grant', 'revoke', 'set', 'do', 'begin', 'comment', 'declare', 'call', 'execute', 'copy',
])

/**
 * W2 — El despojado de CTE se paraba en el **primer** paréntesis, así que
 * `with dup as (select … row_number() over (…) …) delete from …` se colaba — y
 * ésa es la forma canónica de una migración de deduplicación. La única sonda que
 * cazaba era la que no tenía paréntesis anidados. Aquí se cuentan.
 */
function sinCte(sentencia: string): string {
  const m = sentencia.match(/^\s*with\b\s+(recursive\s+)?/i)
  if (!m) return sentencia
  let i = m[0].length
  /**
   * X3 — Una CTE puede declarar sus columnas: `with dup(id, r) as (…)`. Contando
   * paréntesis a secas, el primer grupo que se cerraba era esa lista y el verbo
   * quedaba en `as`. Se salta el nombre y su lista opcional antes de empezar.
   */
  const cabecera = sentencia.slice(i).match(/^\s*[a-z_][\w]*\s*(\([^)]*\))?\s*as\s*/i)
  if (cabecera) i += cabecera[0].length
  let profundidad = 0
  for (; i < sentencia.length; i++) {
    const c = sentencia[i]
    if (c === '(') profundidad++
    else if (c === ')') {
      profundidad--
      if (profundidad === 0) {
        // Tras cerrar una CTE puede venir una coma (otra más) o ya el verbo.
        const resto = sentencia.slice(i + 1)
        const coma = resto.match(/^\s*,/)
        if (!coma) return resto
        i += coma[0].length
      }
    }
  }
  return sentencia
}

export function sqlPeligroso(fuente: string): boolean {
  /**
   * V6 — `execute '…'` es LA forma de borrar desde plpgsql, y el despojador vacía
   * los literales: el peligro desaparecía justo donde vive. Aquí el literal **es**
   * la sentencia, así que se mira en el texto original.
   */
  for (const m of fuente.matchAll(/\bexecute\s+(?:format\s*\(\s*)?'([^']*)'/gi)) {
    if (PELIGRO_SQL.test(m[1])) return true
  }
  /**
   * X3 — `execute q` con la sentencia en una variable: el literal peligroso está
   * en la asignación, no en el `execute`. Si el cuerpo ejecuta SQL dinámico y en
   * algún literal suyo hay un borrado, cuenta.
   */
  if (/\bexecute\s+[a-z_][\w]*/i.test(fuente)) {
    // Y7 — la sentencia puede construirse por concatenación: se juntan los
    // literales de la asignación antes de mirarlos.
    for (const m of fuente.matchAll(/:=\s*((?:'[^']*'\s*(?:\|\|\s*)?)+)/g)) {
      const junto = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]).join('')
      if (PELIGRO_SQL.test(junto)) return true
    }
  }
  // Y7 — el cuerpo de una función SQL es un literal: `as 'delete from …'`.
  for (const m of fuente.matchAll(/\bas\s+'([^']*)'/gi)) if (PELIGRO_SQL.test(m[1])) return true
  // Y7 — `merge … when matched then delete`.
  if (/\bmerge\b[\s\S]*?\bthen\s+delete\b/i.test(fuente)) return true
  return sentenciasSql(fuente).some(sentencia => {
    // `begin`, `declare` y compañía no separan con punto y coma dentro de un
    // cuerpo plpgsql, así que el borrado queda pegado a ellos en la misma
    // sentencia. Se retiran para llegar al verbo que de verdad manda.
    /**
     * Y7 — Los verbos de control se retiran **hasta estabilizarse**: en
     * `begin loop delete …` el primero deja al descubierto el segundo, y con una
     * sola pasada el primer token seguía siendo `loop`.
     */
    let limpia = sentencia.replace(/\bfor\s+delete\b/gi, '')
    for (;;) {
      const antes = limpia
      limpia = limpia
        .replace(/^\s*(begin|declare|do|language\s+\w+|end|loop|end\s+loop|then|else|exit)\b/i, '')
        .replace(/^\s*for\b[^;]*?\bloop\b/i, '')
        .replace(/^\s*foreach\b[^;]*?\bloop\b/i, '')
        .replace(/^\s*if\b[^;]*?\bthen\b/i, '')
        .replace(/^\s*elsif\b[^;]*?\bthen\b/i, '')
        .replace(/^\s*while\b[^;]*?\bloop\b/i, '')
        .replace(/^\s*case\b[^;]*?\bthen\b/i, '')
        .replace(/^\s*when\b[^;]*?\bthen\b/i, '')
        .replace(/^\s*exception\b[^;]*?\bthen\b/i, '')
      if (limpia === antes) break
    }
    limpia = sinCte(limpia)
    // Y `execute '…'` es LA forma de borrar desde plpgsql: se destapa.
    limpia = limpia.replace(/^\s*execute\s+/i, '')
    const primerToken = limpia.trim().split(/\s+/)[0]?.toLowerCase() ?? ''

    // Prosa: los títulos de los tests dicen "un TRUNCATE como anon es
    // rechazado", y eso no es una sentencia. Si no empieza por un verbo de SQL,
    // no se está ejecutando nada.
    if (!VERBOS_SQL.has(primerToken)) return false

    if (primerToken === 'delete' || primerToken === 'truncate') return true

    // El peligro cuenta al **principio de una línea**: así se caza el caso sin
    // punto y coma —`grant … to anon` y debajo un borrado— sin confundir la
    // lista de privilegios de un `grant select, truncate on …`.
    return limpia.split('\n').slice(1).some(l => PELIGRO_SQL.test(l.trimStart().slice(0, 20)))
  })
}

export function borradosEnSql(fuente: string): string[] {
  return sqlPeligroso(fuente) ? ['SQL que borra'] : []
}
