import ts from 'typescript'
import { readFileSync } from 'node:fs'
import { analizar } from './comentarios'
import { fugasContaminadas, traductoresImportados } from './contaminacion'
import { ficherosDeProducto } from './producto'
import { funcionesQueSanean } from './traductor'

/**
 * AG2 — Lo que exime no es «venir del módulo de errores», es **sanear**. Se
 * calcula una vez leyendo el traductor y se cruza con lo que cada fichero
 * importa: importar `refinarSinSesion` —que devuelve su argumento— ya no limpia
 * nada.
 */
let saneanCache: Set<string> | undefined
export const traductoresQueSanean = (): Set<string> =>
  (saneanCache ??= funcionesQueSanean(readFileSync(DONDE_VIVE_EL_CRUDO, 'utf8'), DONDE_VIVE_EL_CRUDO))

/** Los símbolos que este fichero importa Y que de verdad sanean. */
export function exencionesReales(arbol: Parameters<typeof traductoresImportados>[0]): Set<string> {
  const sanean = traductoresQueSanean()
  return new Set([...traductoresImportados(arbol)].filter(n => sanean.has(n)))
}

/**
 * AD5 — **La guarda que sustituye a once rondas de análisis de contaminación.**
 *
 * De la iteración 3 a la 11 se intentó demostrar que el texto crudo de Postgres
 * no llega al usuario siguiendo el dato por el árbol. Cada ronda cerró una
 * familia de formas y la revisión encontró la siguiente: por la salida, por la
 * entrada, por el módulo de al lado. La razón de fondo la midió la revisión de la
 * 11: `Result.error` (crudo) y `ActionState.error` (ya traducido) tienen el mismo
 * nombre y el mismo tipo, así que decidir cuál es cuál necesita información de
 * tipos entre módulos, que un análisis de un solo fichero no tiene.
 *
 * La iteración 12 retiró el crudo del producto. Con eso la propiedad deja de
 * necesitar análisis: **fuera de `lib/errors.ts`, nadie lee `.message`**. No hay
 * contaminación que seguir, ni exenciones, ni formas que enumerar — no se puede
 * filtrar un texto que no se puede leer.
 *
 * AE3 — Y la primera versión de esta guarda **declaraba menos de lo que el
 * producto promete**: prohibía `.message` y nada más. La revisión midió cuatro
 * formas que se le escapan —`String(error)`, `error.hint`, `JSON.stringify(error)`
 * y `` `${error}` ``—, ninguna de las cuales lee `.message`. Y el campo que peor
 * filtra ni siquiera es el mensaje: el `details` de un `23505` real trae el UUID
 * del grupo y el nombre del producto que escribió **otra persona**.
 *
 * Así que aquí viven dos reglas, que son dos preguntas distintas:
 *
 *  1. `lecturasDeMensaje` — nadie lee `.message`, venga de donde venga. Es
 *     sintáctica y no necesita saber qué es un error.
 *  2. `usosIndebidosDelError` — un error de la base sólo puede pasarse al
 *     traductor, mirarse su verdad, leerse su `code` o atarse a un nombre.
 *     Cualquier otra cosa es una fuga: leer otro campo, convertirlo en texto,
 *     devolverlo o pintarlo.
 *
 * La segunda sólo es exacta porque AE2 dejó `error` con un único significado en
 * código de producto: el objeto crudo. Mientras `ActionState` llamó `error` a su
 * mensaje ya traducido, ninguna regla podía distinguirlos.
 */
const DONDE_VIVE_EL_CRUDO = 'lib/errors.ts'

export function lecturasDeMensaje(fuente: string, nombre: string): string[] {
  const arbol = analizar(fuente, nombre)
  const encontradas: string[] = []
  const anotar = (n: ts.Node) => {
    const linea = arbol.getLineAndCharacterOfPosition(n.getStart(arbol)).line + 1
    encontradas.push(`${nombre}:${linea}`)
  }

  const visitar = (n: ts.Node): void => {
    // Los tipos pueden nombrar el campo: declararlo no es leerlo.
    if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return
    // `x.message`
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'message') anotar(n)
    // `x['message']`
    if (ts.isElementAccessExpression(n) && n.argumentExpression &&
        ts.isStringLiteral(n.argumentExpression) &&
        n.argumentExpression.text === 'message') anotar(n)
    // `const { message } = x` y `({ message: m })` en un patrón
    if (ts.isBindingElement(n)) {
      const origen = n.propertyName ?? n.name
      if (ts.isIdentifier(origen) && origen.text === 'message') anotar(n)
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return encontradas
}

/**
 * AE3 — Un error de la base **sólo** puede: pasarse a un símbolo importado del
 * traductor, mirarse su verdad, leerse su `code`, o atarse a un nombre. Lo demás
 * es una fuga. Se siembra por dos vías, que son las dos formas en que un error de
 * PostgREST aparece: atado a un nombre (`const { error } = await …`) y leído como
 * campo de un resultado (`res.error`).
 */
/**
 * Lo que devuelve el cliente de datos. Se reconoce por el **verbo**, que es lo
 * que la biblioteca fija: `rpc`, `from`, `select`, `insert`, `update`… encadenado
 * o no. Un nombre de variable no decide nada aquí.
 */
const ENTRADAS_DEL_CLIENTE = ['rpc', 'from', 'auth', 'functions']
/** AJ2 — `Array.from(m)` no es la biblioteca: los globales no la ofrecen. */
const GLOBALES = ['Array', 'Object', 'Date', 'Number', 'String', 'Buffer', 'Map', 'Set', 'JSON']

function esResultadoDelCliente(e: ts.Node): boolean {
  const n = ts.isAwaitExpression(e) ? e.expression : e
  if (!ts.isCallExpression(n)) return false
  // Se busca la ENTRADA de la biblioteca en la cadena (`.rpc`, `.from`, `.auth`),
  // no un verbo cualquiera: una lista de verbos casaba con `Set.delete(id)` y
  // marcaba código que no toca la base.
  for (let x: ts.Node = n; ;) {
    if (ts.isCallExpression(x)) { x = x.expression; continue }
    if (ts.isPropertyAccessExpression(x)) {
      if (ENTRADAS_DEL_CLIENTE.includes(x.name.text)) {
        const receptor = x.expression
        if (ts.isIdentifier(receptor) && GLOBALES.includes(receptor.text)) return false
        return true
      }
      x = x.expression; continue
    }
    return false
  }
}

export function usosIndebidosDelError(fuente: string, nombre: string): string[] {
  const arbol = analizar(fuente, nombre)
  return fugasContaminadas(arbol, exencionesReales(arbol), {
    nombreSemilla: 'error',
    /**
     * AG3 — `.error` es el campo de un resultado… salvo cuando es el **invocado**
     * de una llamada. Sin esa distinción, `console.error('algo')` —que no toca
     * ningún error de la base— se reportaba como fuga, y la guarda empujaba a
     * cambiarlo por `console.log`, que es la cicatriz AD7. De paso decidía por
     * accidente la política de registro, que ahora está escrita en AG8.
     */
    /**
     * AI1 — **El origen.** Tres rondas cerraron el envoltorio del error y ninguna
     * cerró el objeto que lo trae: `const res = await supabase.rpc(…)` dejaba
     * `res` limpio, y `res` contiene `error.message`, `error.details` y
     * `error.hint`. Medido, seis formas sacaban el crudo con la puerta entera en
     * verde, y la diferencia entre la forma segura y la fuga era destructurar o
     * no destructurar.
     */
    esSemilla: (e) => esResultadoDelCliente(e) ||
      (ts.isPropertyAccessExpression(e) && e.name.text === 'error' &&
       !(e.parent && ts.isCallExpression(e.parent) && e.parent.expression === e)),
    // AF1 — y por posición: el rechazo de una promesa y el `catch`.
    rechazosSonSemilla: true,
    // AI1 — de un resultado del cliente sólo salen limpios estos campos.
    camposLimpios: ['data', 'count', 'status', 'statusText'],
  })
}


const fueraDelTraductor = () => ficherosDeProducto().filter(r => r !== DONDE_VIVE_EL_CRUDO)

/** Todas las lecturas del producto, menos las del fichero donde el crudo vive. */
export function lecturasFueraDelTraductor(): string[] {
  return fueraDelTraductor().flatMap(r => lecturasDeMensaje(readFileSync(r, 'utf8'), r))
}

/** Todo uso indebido del error de la base en el producto. */
export function usosFueraDelTraductor(): string[] {
  return fueraDelTraductor()
    .flatMap(r => usosIndebidosDelError(readFileSync(r, 'utf8'), r).map(k => `${r} → ${k}`))
}

/**
 * AG7 — Un literal de texto que se le enseña a alguien, escrito fuera del
 * traductor. `lib/errors.ts` se declara «la única fuente de texto» desde S14 y la
 * afirmación era falsa: quedaban `'El nombre no puede estar vacío.'` y
 * `'Escribe un nombre de producto.'` sueltos. Una promesa que nada sostiene se
 * pudre; ésta la sostiene esto.
 *
 * Se mira dónde MUERE el texto, no cómo se escribe: el primer argumento de lo que
 * pinta un aviso, y los campos con los que un aviso se construye.
 */
const PINTAN_TEXTO = ['avisarTexto', 'setNotice']
const CAMPOS_DE_AVISO = ['mensaje', 'texto']

export function literalesDeMensaje(fuente: string, nombre: string): string[] {
  const arbol = analizar(fuente, nombre)
  const sueltos: string[] = []
  const anotar = (n: ts.Node, texto: string) => {
    const linea = arbol.getLineAndCharacterOfPosition(n.getStart(arbol)).line + 1
    sueltos.push(`${nombre}:${linea} ${JSON.stringify(texto)}`)
  }
  const literal = (e: ts.Node | undefined): string | null => {
    if (!e) return null
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
    return null
  }
  /**
   * ¿Es un elemento que anuncia algo? AI5 — La versión anterior exigía un `role`
   * **literal** y sólo miraba el texto hijo directo. Medido: nueve de diez formas
   * vecinas escapaban — `{'texto'}`, plantilla, `<p>` anidado, `aria-live` sin
   * `role`, `role={'alert'}`, fragmento, hermano, ternario y `aria-label`.
   */
  const anuncia = (apertura: ts.JsxOpeningLikeElement): boolean =>
    apertura.attributes.properties.some(a => {
      if (ts.isJsxSpreadAttribute(a)) return false
      const nombreAttr = a.name.getText(arbol)
      if (nombreAttr === 'aria-live') return true
      if (nombreAttr !== 'role') return false
      const v = a.initializer
      if (!v) return false
      // `role="alert"` y `role={'alert'}`: el valor se pela igual.
      const texto = ts.isStringLiteral(v) ? v.text
        : ts.isJsxExpression(v) && v.expression && ts.isStringLiteral(v.expression)
          ? v.expression.text : null
      return !!texto && ['status', 'alert'].includes(texto)
    })

  /** Todo el texto literal que cuelga de un nodo, a cualquier profundidad. */
  const textosDentro = (n: ts.Node, fuera: { nodo: ts.Node; texto: string }[]): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.trim()
      if (t) fuera.push({ nodo: n, texto: t })
      return
    }
    if (ts.isJsxExpression(n) && n.expression) {
      const e = n.expression
      const literal = ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null
      if (literal) { fuera.push({ nodo: n, texto: literal }); return }
      // Un ternario entre literales también es texto escrito aquí.
      if (ts.isConditionalExpression(e)) {
        for (const rama of [e.whenTrue, e.whenFalse]) {
          if (ts.isStringLiteral(rama) || ts.isNoSubstitutionTemplateLiteral(rama)) {
            fuera.push({ nodo: rama, texto: rama.text })
          }
        }
        return
      }
      return
    }
    ts.forEachChild(n, (h) => textosDentro(h, fuera))
  }

  const visitar = (n: ts.Node): void => {
    /**
     * AH5 — El texto escrito directamente en el JSX de un aviso. La guarda sólo
     * miraba lo que pasa por `avisarTexto`/`setNotice`, así que dos avisos de
     * canal degradado vivían en las vistas sin que nada los viera.
     */
    if (ts.isJsxElement(n) && anuncia(n.openingElement)) {
      const encontrados: { nodo: ts.Node; texto: string }[] = []
      for (const hijo of n.children) textosDentro(hijo, encontrados)
      for (const { nodo, texto } of encontrados) anotar(nodo, texto)
    }
    /**
     * `aria-label` y `title` **de un anunciador**. Sólo ahí: la etiqueta de un
     * campo («Nombre») es copia de la interfaz, no un mensaje, y llevarla al
     * traductor de errores sería meter dos cosas distintas en el mismo sitio.
     * El límite de esta guarda es lo que se le **anuncia** a alguien.
     */
    if (ts.isJsxAttribute(n) && ['aria-label', 'title'].includes(n.name.getText(arbol)) &&
        n.initializer && ts.isStringLiteral(n.initializer) &&
        ts.isJsxAttributes(n.parent) && anuncia(n.parent.parent)) {
      anotar(n, n.initializer.text)
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) &&
        PINTAN_TEXTO.includes(n.expression.text)) {
      // Sólo el PRIMER argumento: el segundo es la clase, que sí es un literal.
      const t = literal(n.arguments[0])
      if (t) anotar(n, t)
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) &&
        CAMPOS_DE_AVISO.includes(n.name.text)) {
      const t = literal(n.initializer)
      // La cadena vacía no es un mensaje: es el hueco de un `?? \'\'`.
      if (t) anotar(n, t)
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return sueltos
}

/** Todos los mensajes escritos fuera del traductor. */
export const mensajesSueltos = (): string[] =>
  fueraDelTraductor().flatMap(r => literalesDeMensaje(readFileSync(r, 'utf8'), r))
