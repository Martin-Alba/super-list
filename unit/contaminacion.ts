import ts from 'typescript'

/**
 * X2 — `unit/fugaDeError.ts` y la comprobación de la página tenían el mismo
 * análisis escrito dos veces, y la copia iba por detrás: le faltaban cuatro
 * reglas, entre ellas la desestructuración `const { error: crudo } = …`, que es
 * **como escribe hoy `app/g/[id]/page.tsx`**. Dos copias de un análisis divergen
 * siempre; la que se usa menos es la que se queda atrás.
 */
export const pelar = (e: ts.Node): ts.Node => {
  let n = e
  for (;;) {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isNonNullExpression(n) ||
        ts.isParenthesizedExpression(n) || ts.isTypeAssertionExpression(n) ||
        ts.isAwaitExpression(n)) { n = n.expression; continue }
    return n
  }
}

/** Sólo el módulo real del proyecto, no cualquiera que acabe en `/errors`. */
export const MODULO_DE_ERRORES = /^(@\/lib\/errors|(\.\.?\/)+(lib\/)?errors)$/

/** Nombres importados del módulo de errores: son los únicos que limpian. */
export function traductoresImportados(arbol: ts.SourceFile): Set<string> {
  const nombres = new Set<string>()
  const visitar = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) &&
        MODULO_DE_ERRORES.test(n.moduleSpecifier.text)) {
      const cl = n.importClause?.namedBindings
      if (cl && ts.isNamedImports(cl)) for (const e of cl.elements) nombres.add(e.name.text)
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return nombres
}

export type Contaminacion = {
  manchados: Set<string>
  contamina: (e: ts.Node) => boolean
  /** AG1 — ¿es el error de la base, o algo que lo lleva dentro? */
  esElErrorMismo: (e: ts.Node) => boolean
}

/** Sigue el error de la base por todas sus formas de propagación. */
/**
 * Z4 — Este recorrido estaba escrito **tres veces** (getter, función/flecha y el
 * ayudante local), y la tercera se recreaba en cada nodo visitado. Tres copias de
 * lo mismo divergen: es lo que X2 ya pagó con `pasaCrudoAlCliente`.
 */
function devuelveAlgoManchado(nodo: ts.Node, contamina: (e: ts.Node) => boolean): boolean {
  // AA2 — cuerpo conciso: `() => error` no tiene ningún `return` que mirar, así
  // que era invisible para las dos guardas.
  if ((ts.isArrowFunction(nodo)) && !ts.isBlock(nodo.body)) return contamina(nodo.body)
  let si = false
  const mirar = (m: ts.Node): void => {
    if (ts.isReturnStatement(m) && m.expression && contamina(m.expression)) si = true
    ts.forEachChild(m, mirar)
  }
  ts.forEachChild(nodo, mirar)
  return si
}

/**
 * AC1 — La cota de sesión llevaba su **propio** motor de contaminación escrito a
 * mano (`lleva`), más pobre que éste: la revisión midió catorce formas legales
 * que dejaban retirar el `Promise.race` con la suite en verde, tres de ellas
 * sobre `GroupView.tsx` real. Es la cicatriz X2 —dos copias del mismo análisis,
 * la que se usa menos se queda atrás— una guarda más allá.
 *
 * Lo único que cambiaba entre las dos era **qué se siembra**. Así que se
 * parametriza eso y nada más: `nombreSemilla` para el error de la base,
 * `esSemilla` para la consulta de sesión.
 */
export type Semilla = {
  nombreSemilla?: string | null
  esSemilla?: (e: ts.Node) => boolean
  /**
   * AC1 — La única diferencia real entre las dos preguntas, y por eso es un
   * parámetro y no una copia del motor: la de fuga sigue **el dato** (¿lleva
   * dentro el texto de Postgres?), y `error ? describeError(error) : null` no lo
   * lleva. La de la cota sigue **la dependencia** (¿decide la sesión lo que se
   * ve?), y ahí un ternario gobernado por la sesión sí cuenta.
   */
  porLaCondicion?: boolean
  /**
   * AF1 — El error de la base también llega **por posición**: el parámetro de un
   * `.catch(cb)`, el segundo de `.then(ok, cb)` y la variable de un `catch`. La
   * revisión lo midió sobre los ficheros reales: `.catch(e => avisarTexto(String(e)))`
   * quedaba verde en 21 de los 22, y el test que lo probaba pasaba porque
   * **renombraba el parámetro a `error`**, que es justo la semilla.
   */
  rechazosSonSemilla?: boolean
  /**
   * AI1 — Campos que salen **limpios** de algo sembrado. La semilla natural de
   * esta guarda es el resultado del cliente de datos —`{ data, error, count,
   * status }`—, y de ahí sólo el error lleva texto de Postgres. Sin esta lista,
   * sembrar el origen marcaría `return { token: data }`, que es código legítimo
   * y frecuente.
   */
  camposLimpios?: string[]
}

export function contaminar(
  arbol: ts.SourceFile, traductores: Set<string>, semilla: Semilla = {},
): Contaminacion {
  const { nombreSemilla = 'error', esSemilla, porLaCondicion = false,
    rechazosSonSemilla = false, camposLimpios = [] } = semilla
  const manchados = new Set<string>(nombreSemilla ? [nombreSemilla] : [])
  /**
   * AG1 — Los nombres atados **directamente** a una semilla, frente a los que se
   * ensucian por derivación. La diferencia decide quién puede eximir su `code`:
   * el `code` de un error de la base no lleva texto, pero el `code` de un objeto
   * que alguien fabricó lleva lo que le hayan metido. Medido: sin distinguirlos,
   * `const bruto = { code: String(error) }` y luego `bruto.code` sacaba el crudo
   * de Postgres a la pantalla con la suite entera en verde.
   */
  const semillasDirectas = new Set<string>(nombreSemilla ? [nombreSemilla] : [])
  /** Y6 — funciones cuyo cuerpo devuelve algo manchado: llamarlas mancha. */
  const devuelvenManchado = new Set<string>()
  /** Y6 — campos de clase manchados: leerlos por `.nombre` mancha. */
  const camposManchados = new Set<string>()

  /**
   * AG1 — ¿Es esto el error de la base, y no algo derivado de él? Un nombre atado
   * directamente a la semilla, o el campo `error` de un resultado. `bruto`, que
   * se ensució por llevar dentro un `String(error)`, no lo es.
   */
  /** ¿Es esto, tal cual o por su nombre, un resultado del cliente de datos? */
  const esSemillaDeOrigen = (e: ts.Node): boolean => {
    const n = pelar(e)
    if (esSemilla?.(n)) return true
    return ts.isIdentifier(n) && semillasDirectas.has(n.text)
  }

  const esElErrorMismo = (e: ts.Node): boolean => {
    const n = pelar(e)
    if (ts.isIdentifier(n)) return semillasDirectas.has(n.text)
    /**
     * AH1 — `x.error` sólo es el error de la base si **`x` está limpio**. La
     * versión anterior aceptaba cualquier receptor, así que
     * `const w = { error: { code: JSON.stringify(error) } }` leído como
     * `w.error.code` lavaba el crudo: el `.error` de un objeto que ya lleva el
     * error dentro no es el error, es su envoltorio. Medido, escapaba en 21 de
     * los 22 ficheros y por `createGroupAction` el navegador pintaba el JSON
     * entero de PostgREST con la fila de otra persona.
     */
    /**
     * AJ2 — «Receptor limpio» era demasiado estrecho desde que se siembra el
     * origen: un resultado del cliente está sucio **por definición**, así que
     * `res.error` dejó de ser «el error mismo» y `res.error?.code` —la lectura
     * que el proyecto declara legítima desde S14, y que la política de registro
     * del checkpoint permite— se marcaba como fuga.
     *
     * La distinción real es de dónde viene la suciedad: el receptor vale si está
     * limpio **o si es el resultado que trae el error**. No vale si es un objeto
     * que se ensució por llevarlo dentro.
     */
    const receptorValido = (e2: ts.Node): boolean =>
      esSemillaDeOrigen(e2) || !contamina(e2)
    if (ts.isPropertyAccessExpression(n)) {
      return n.name.text === 'error' && receptorValido(n.expression)
    }
    if (ts.isElementAccessExpression(n)) {
      const k = n.argumentExpression
      return !!k && ts.isStringLiteral(k) && k.text === 'error' && receptorValido(n.expression)
    }
    return false
  }

  const contamina = (e: ts.Node): boolean => {
    const n = pelar(e)
    if (esSemilla?.(n)) return true
    if (ts.isIdentifier(n)) return manchados.has(n.text)
    if (ts.isPropertyAccessExpression(n)) {
      /**
       * AE3 — El `code` **corta** la contaminación, no sólo se permite leerlo.
       * La regla de `soloSeMira` sólo actúa cuando la lectura es la expresión
       * máxima; `code: error?.code ?? null` la mete dentro de un `??` y de un
       * objeto, así que la mancha subía hasta el `return`.
       * AG1 — Pero sólo cuando se lee **del error mismo**. El corte era ciego al
       * receptor y cualquiera podía llamar `code` a su campo para lavarlo.
       */
      if (n.name.text === 'code' && esElErrorMismo(n.expression)) return false
      /**
       * AI1 — `res.data` no lleva el error dentro; `res.error` sí, y `res.loQueSea`
       * también, porque de un resultado del cliente sólo se sabe que los campos
       * declarados limpios lo están. Falla cerrado.
       */
      if (camposLimpios.includes(n.name.text) && esElErrorMismo(n.expression)) return false
      if (camposManchados.has(n.name.text)) return true
      return contamina(n.expression)
    }
    if (ts.isElementAccessExpression(n)) {
      // AG1 — `error['code']` recibe el mismo trato que `error.code`, y
      // `bruto['code']` el mismo que `bruto.code`. El desequilibrio entre punto
      // y corchete marcaba la lectura legítima y dejaba pasar la sucia.
      const clave = n.argumentExpression
      if (clave && ts.isStringLiteral(clave) && clave.text === 'code' &&
          esElErrorMismo(n.expression)) return false
      return contamina(n.expression)
    }
    if (ts.isSpreadAssignment(n) || ts.isSpreadElement(n)) return contamina(n.expression)
    if (ts.isObjectLiteralExpression(n)) return n.properties.some(p =>
      // Y6 — un getter que devuelve el error.
      (ts.isGetAccessorDeclaration(p) && devuelveAlgoManchado(p, contamina)) ||
      // Z3 — un método del literal de objeto que lo devuelva.
      (ts.isMethodDeclaration(p) && devuelveAlgoManchado(p, contamina)) ||
      (ts.isSpreadAssignment(p) && contamina(p.expression)) ||
      (ts.isPropertyAssignment(p) && contamina(p.initializer)) ||
      (ts.isShorthandPropertyAssignment(p) && manchados.has(p.name.text)))
    if (ts.isArrayLiteralExpression(n)) return n.elements.some(contamina)
    // `new Error(error.message)` — la forma que T9 retiró de leaveGroupAction.
    if (ts.isNewExpression(n)) return (n.arguments ?? []).some(contamina)
    /**
     * AC1 — `!x` y `!!x`: la negación no borra de dónde VIENE el dato, y la cota
     * pregunta justo eso. AF6 — pero sí borra lo que el dato ES: un booleano no
     * lleva texto dentro, así que para la guarda de fuga `!!error` está limpio.
     * Es la misma frontera que el ternario y `typeof`: dependencia sí, dato no.
     */
    if (ts.isPrefixUnaryExpression(n)) return porLaCondicion && contamina(n.operand)
    // `typeof x` no lleva el texto dentro, pero sí depende de él: cuenta para la
    // cota (¿decide la sesión lo que se ve?) y no para la fuga (¿viaja el crudo?).
    if (ts.isTypeOfExpression(n)) return porLaCondicion && contamina(n.expression)
    if (ts.isConditionalExpression(n)) {
      return contamina(n.whenTrue) || contamina(n.whenFalse) ||
        (porLaCondicion && contamina(n.condition))
    }
    if (ts.isBinaryExpression(n)) return contamina(n.left) || contamina(n.right)
    if (ts.isTemplateExpression(n)) return n.templateSpans.some(sp => contamina(sp.expression))
    // AB6 — `` tag`${error}` ``: el valor pasa por la plantilla etiquetada.
    if (ts.isTaggedTemplateExpression(n)) return contamina(n.template)
    if (ts.isCallExpression(n)) {
      // AF6 — `Boolean(error)` devuelve un booleano: no lleva texto. Cuenta
      // como dependencia (cota) y no como dato (fuga), igual que `typeof`.
      if (ts.isIdentifier(n.expression) && n.expression.text === 'Boolean') {
        return porLaCondicion && n.arguments.some(contamina)
      }
      // AA2 — llamada inmediata: `(() => error)()`. Sin esto caía al examen de
      // argumentos, que no mira el invocado.
      const invocado = pelar(n.expression)
      if (ts.isArrowFunction(invocado) || ts.isFunctionExpression(invocado)) {
        // También sus argumentos: `((g) => g())(() => error)`.
        return devuelveAlgoManchado(invocado, contamina) || n.arguments.some(contamina)
      }
      /**
       * AG2 — Sólo por identificador. Se aceptaba también el nombre del método,
       * así que `o.mensajeDe(res.error.hint)` —un método cualquiera que se llame
       * igual— apagaba la contaminación. Lo que exime es el **símbolo importado**
       * del traductor, y un símbolo importado se invoca por su nombre.
       */
      const f = ts.isIdentifier(n.expression) ? n.expression.text : null
      if (f && traductores.has(f)) return false
      // El invocado que devuelve algo manchado sí cuenta por su nombre de
      // método: `o.g()` donde `g` devuelve el error es una fuga, y ahí el nombre
      // no exime nada, contamina.
      const invocadoPorNombre = f ?? (ts.isPropertyAccessExpression(n.expression)
        ? n.expression.name.text : null)
      if (invocadoPorNombre && devuelvenManchado.has(invocadoPorNombre)) return true
      // `error.toString()`: el receptor manchado mancha el resultado.
      if (ts.isPropertyAccessExpression(n.expression) && contamina(n.expression.expression)) return true
      return n.arguments.some(contamina)
    }
    if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
      // Y6 — `function f() { return error }` y luego `f()`.
      return devuelveAlgoManchado(n, contamina)
    }
    return false
  }

  const sembrar = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isObjectBindingPattern(n.name)) {
        /**
         * AD7 — Aquí había un `continue` cuando el elemento no era un
         * identificador, así que `const { a: { b } } = error` se saltaba entero:
         * el patrón anidado dejaba de manchar nada. Se recorre.
         */
        // AI1 — De un resultado del cliente, `data` sale limpio y el resto no.
        const deUnResultado = esElErrorMismo(n.initializer) || !!esSemilla?.(pelar(n.initializer))
        const marcar = (pat: ts.BindingPattern, sucio: boolean): void => {
          for (const el of pat.elements) {
            if (ts.isOmittedExpression(el)) continue
            const origen = el.propertyName ?? el.name
            const nombreOrigen = ts.isIdentifier(origen) ? origen.text : null
            if (deUnResultado && nombreOrigen && camposLimpios.includes(nombreOrigen)) continue
            // AF6 — `const { code } = error`: el código no lleva texto, así que
            // no mancha lo que se ata. La regla de arriba ya lo dice para
            // `error.code`; aquí se decía lo contrario y se marcaba la forma
            // limpia.
            if (nombreOrigen === 'code') continue
            const aqui = sucio || nombreOrigen === nombreSemilla ||
              // AA2 — valor por defecto: `const { z = error } = p`.
              !!(el.initializer && contamina(el.initializer))
            if (ts.isIdentifier(el.name)) {
              if (aqui) manchados.add(el.name.text)
              // Sólo es semilla directa si viene del campo semilla, no de que el
              // objeto entero esté sucio.
              if (nombreOrigen === nombreSemilla) semillasDirectas.add(el.name.text)
            }
            else marcar(el.name, aqui)
          }
        }
        // X2 — `const { error: crudo } = …`: el nombre de ORIGEN es lo que
        // mancha, no el que se le ponga al atarlo.
        marcar(n.name, contamina(n.initializer))
      } else if (ts.isIdentifier(n.name)) {
        if (n.name.text === nombreSemilla || contamina(n.initializer)) manchados.add(n.name.text)
        // AI1 — y un nombre atado directamente a la semilla ES la semilla: sin
        // esto, `const res = await sb.rpc(...)` no contaba como resultado y
        // `res.data` se marcaba como fuga.
        /**
         * AI1 — Un nombre atado directamente a la semilla ES la semilla. Pero la
         * vía de `esSemilla` se limita a lo que **no** es una lectura de campo:
         * para `x.error` manda `esElErrorMismo`, que mira si el receptor está
         * limpio. Sin ese límite, `const q = w.error` —con `w` ya sucio— volvía a
         * ser «el error mismo» y su `.code` lavaba el crudo otra vez.
         */
        const ini = pelar(n.initializer)
        const porLaVíaGeneral = !ts.isPropertyAccessExpression(ini) &&
          !ts.isElementAccessExpression(ini) && !!esSemilla?.(ini)
        if (n.name.text === nombreSemilla || esElErrorMismo(n.initializer) || porLaVíaGeneral) {
          semillasDirectas.add(n.name.text)
        }
      } else if (ts.isArrayBindingPattern(n.name) && contamina(n.initializer)) {
        /**
         * AI1 — `const [a, b] = await Promise.all([r1, r2])`: cada nombre hereda
         * **el sitio que ocupa**. Sin esto, un resultado del cliente dejaba de
         * serlo al pasar por `Promise.all`, y `a.data` se marcaba como fuga.
         */
        const dentroDeTodoJunto = (() => {
          const ini = pelar(n.initializer!)
          if (!ts.isCallExpression(ini) || !ts.isPropertyAccessExpression(ini.expression)) return null
          if (!['all', 'allSettled'].includes(ini.expression.name.text)) return null
          const lista = ini.arguments[0] && pelar(ini.arguments[0])
          return lista && ts.isArrayLiteralExpression(lista) ? lista.elements : null
        })()
        if (dentroDeTodoJunto) {
          n.name.elements.forEach((el, i) => {
            if (ts.isOmittedExpression(el) || !ts.isIdentifier(el.name)) return
            const trozo = dentroDeTodoJunto[i]
            if (!trozo) return
            if (contamina(trozo)) manchados.add(el.name.text)
            if (esSemilla?.(pelar(trozo)) || esElErrorMismo(trozo)) {
              semillasDirectas.add(el.name.text)
            }
          })
        } else {
          // Y6 — `const [a] = [error]`. AD7 — y `const [[c]] = [[error]]`.
          // Sin `else`, el reparto por posición se ejecutaba y **después** se
          // manchaban todos igualmente: el sitio que ocupa cada nombre no servía
          // de nada y `activeItems(...)` acababa marcado como resultado sucio.
          const marcarArray = (pat: ts.BindingPattern): void => {
            for (const el of pat.elements) {
              if (ts.isOmittedExpression(el)) continue
              if (ts.isIdentifier(el.name)) manchados.add(el.name.text)
              else marcarArray(el.name)
            }
          }
          marcarArray(n.name)
        }
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const izq = pelar(n.left)
      if (ts.isIdentifier(izq) && contamina(n.right)) manchados.add(izq.text)
      // Z3 — `o.e = error`: se mancha el campo, que es como se lee después.
      // AC2 — y el contenedor, porque `r.error = crudo; return r` sacaba el
      // crudo con `r` limpio: el campo estaba marcado y nadie leía el campo.
      if (ts.isPropertyAccessExpression(izq) && contamina(n.right)) {
        camposManchados.add(izq.name.text)
        const base = pelar(izq.expression)
        if (ts.isIdentifier(base)) manchados.add(base.text)
      }
      /**
       * AD7 — `a[0] = error` estaba **eximida** por (c) —«se está atando a un
       * nombre»— y no manchaba ningún nombre: la contaminación se evaporaba
       * dentro de la exención. Un solo agujero rompía las dos guardas.
       */
      if (ts.isElementAccessExpression(izq) && contamina(n.right)) {
        const base = pelar(izq.expression)
        if (ts.isIdentifier(base)) manchados.add(base.text)
      }
      // AB6 — desestructuración en asignación: `({ a: o.a } = { a: error })` y
      // `[v] = [error]`.
      if (contamina(n.right)) {
        const marcarPatron = (pat: ts.Node): void => {
          if (ts.isObjectLiteralExpression(pat)) {
            for (const pr of pat.properties) {
              if (ts.isPropertyAssignment(pr)) marcarPatron(pr.initializer)
              else if (ts.isShorthandPropertyAssignment(pr)) manchados.add(pr.name.text)
            }
          } else if (ts.isArrayLiteralExpression(pat)) pat.elements.forEach(marcarPatron)
          else if (ts.isIdentifier(pat)) manchados.add(pat.text)
          else if (ts.isPropertyAccessExpression(pat)) camposManchados.add(pat.name.text)
        }
        marcarPatron(izq)
      }
    }
    // AB6 — un getter de clase que lo devuelve.
    if (ts.isGetAccessorDeclaration(n) && ts.isIdentifier(n.name) &&
        devuelveAlgoManchado(n, contamina)) camposManchados.add(n.name.text)
    // AB6 — `Object.defineProperty(o, 'e', { value: error })`.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'defineProperty' && n.arguments.length >= 3 &&
        contamina(n.arguments[2])) {
      const clave = n.arguments[1]
      if (ts.isStringLiteral(clave)) camposManchados.add(clave.text)
      if (ts.isIdentifier(n.arguments[0])) manchados.add(n.arguments[0].text)
    }
    /**
     * AF1 — El parámetro que recibe el **rechazo** de una promesa: `.catch(cb)` y
     * el segundo de `.then(ok, cb)`. Es la posición, no el nombre, y no exige que
     * el receptor esté manchado: cualquier promesa puede rechazar con el error de
     * la base, que es exactamente lo que hacía `activeItems` antes de AE1.
     */
    if (rechazosSonSemilla && ts.isCallExpression(n) &&
        ts.isPropertyAccessExpression(n.expression)) {
      const metodo = n.expression.name.text
      const rechazo = metodo === 'catch' ? n.arguments[0]
        : metodo === 'then' ? n.arguments[1] : undefined
      if (rechazo) {
        const f = pelar(rechazo)
        if (ts.isArrowFunction(f) || ts.isFunctionExpression(f)) {
          for (const par of f.parameters) {
            if (ts.isIdentifier(par.name)) {
              manchados.add(par.name.text); semillasDirectas.add(par.name.text)
            }
            else if (ts.isObjectBindingPattern(par.name) || ts.isArrayBindingPattern(par.name)) {
              for (const el of par.name.elements) {
                if (!ts.isOmittedExpression(el) && ts.isIdentifier(el.name)) manchados.add(el.name.text)
              }
            }
          }
        }
      }
    }
    // AB6 — el parámetro de un callback que recorre algo manchado.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        ['forEach', 'map', 'then', 'filter', 'find'].includes(n.expression.name.text) &&
        contamina(n.expression.expression)) {
      for (const a of n.arguments) {
        const f = pelar(a)
        if (!ts.isArrowFunction(f) && !ts.isFunctionExpression(f)) continue
        // AJ3 — y el parámetro **desestructurado**: `.then(({ data }) => …)` es
        // el idioma que el propio producto usa, y no se manchaba.
        const marcarPar = (b: ts.BindingName): void => {
          if (ts.isIdentifier(b)) { manchados.add(b.text); return }
          for (const el of b.elements) if (!ts.isOmittedExpression(el)) marcarPar(el.name)
        }
        for (const par of f.parameters) marcarPar(par.name)
      }
    }
    // Z3 — un método de clase que devuelve el error.
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name) && devuelveAlgoManchado(n, contamina)) {
      camposManchados.add(n.name.text)
      devuelvenManchado.add(n.name.text)
    }
    // Z3 — `a.push(error)` / `m.set('e', error)` manchan el contenedor.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        ['push', 'set', 'add', 'unshift'].includes(n.expression.name.text) &&
        n.arguments.some(contamina) && ts.isIdentifier(n.expression.expression)) {
      manchados.add(n.expression.expression.text)
    }
    // X2 — `catch (e)` también ata un error. Sólo cuando lo que se sigue ES el
    // error: para la cota de sesión, una variable de `catch` no es una sesión.
    // AF1 — y ya no depende del nombre: la posición basta.
    if (rechazosSonSemilla && ts.isCatchClause(n) && n.variableDeclaration &&
        ts.isIdentifier(n.variableDeclaration.name)) {
      manchados.add(n.variableDeclaration.name.text)
      semillasDirectas.add(n.variableDeclaration.name.text)
    }
    // AA2 — `yield error`.
    if (ts.isYieldExpression(n) && n.expression && contamina(n.expression)) {
      // AB4 — subía sólo hasta una función DECLARADA, así que
      // `const g = function*(){ yield error }` y `{ *g(){…} }` se colaban a las
      // dos guardas. Se sube por cualquier función y se mancha el nombre atado.
      for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
        if (ts.isFunctionDeclaration(p) && p.name) { devuelvenManchado.add(p.name.text); break }
        if (ts.isMethodDeclaration(p) && ts.isIdentifier(p.name)) {
          devuelvenManchado.add(p.name.text); camposManchados.add(p.name.text); break
        }
        if (ts.isFunctionExpression(p) || ts.isArrowFunction(p)) {
          const a = p.parent
          if (a && ts.isVariableDeclaration(a) && ts.isIdentifier(a.name)) {
            devuelvenManchado.add(a.name.text); break
          }
          // AC6 — `{ g: function*(){…} }`, `o.g = function*(){…}` y
          // `g = function*(){…}` sobre una variable ya declarada: tres formas
          // más que AB4 dejó fuera y que se colaban a las DOS guardas.
          if (a && ts.isPropertyAssignment(a) && ts.isIdentifier(a.name)) {
            devuelvenManchado.add(a.name.text); camposManchados.add(a.name.text); break
          }
          if (a && ts.isBinaryExpression(a) && a.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
            const iz = pelar(a.left)
            if (ts.isIdentifier(iz)) devuelvenManchado.add(iz.text)
            if (ts.isPropertyAccessExpression(iz)) {
              devuelvenManchado.add(iz.name.text); camposManchados.add(iz.name.text)
            }
            break
          }
          break
        }
      }
    }
    if (ts.isParameter(n) && ts.isIdentifier(n.name)) {
      // Y6 — parámetro por defecto: `function f(e = error)`.
      if (n.name.text === nombreSemilla || (n.initializer && contamina(n.initializer))) manchados.add(n.name.text)
    }
    // Y6 — campo de clase y `for (const e of [error])`.
    if (ts.isPropertyDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        contamina(n.initializer)) { manchados.add(n.name.text); camposManchados.add(n.name.text) }
    // Y6 — una función declarada (o atada a un nombre) que devuelve algo manchado.
    if (ts.isFunctionDeclaration(n) && n.name && devuelveAlgoManchado(n, contamina)) {
      devuelvenManchado.add(n.name.text)
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      const cuerpo = n.initializer.body
      const devuelve = ts.isBlock(cuerpo) ? devuelveAlgoManchado(n.initializer, contamina) : contamina(cuerpo)
      if (devuelve) devuelvenManchado.add(n.name.text)
    }
    if (ts.isForOfStatement(n) && contamina(n.expression) &&
        ts.isVariableDeclarationList(n.initializer)) {
      for (const d of n.initializer.declarations) {
        if (ts.isIdentifier(d.name)) manchados.add(d.name.text)
      }
    }
    // Y6 — `Object.assign(destino, error)` mancha el destino.
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
        n.expression.name.text === 'assign' && n.arguments.length > 1 &&
        n.arguments.slice(1).some(contamina) && ts.isIdentifier(n.arguments[0])) {
      manchados.add(n.arguments[0].text)
    }
    ts.forEachChild(n, sembrar)
  }
  /**
   * AC5 — Aquí había `i < 3`. Un número mágico no es un punto fijo: la revisión
   * midió que una cadena de alias declarada hacia atrás de cuatro eslabones se
   * colaba, y basta mover un `const a = b` de sitio para apagar la guarda. Se
   * itera hasta que el conjunto deja de crecer.
   */
  for (let antes = -1, ahora = 0; antes !== ahora; ) {
    antes = manchados.size + devuelvenManchado.size + camposManchados.size + semillasDirectas.size
    ts.forEachChild(arbol, sembrar)
    ahora = manchados.size + devuelvenManchado.size + camposManchados.size + semillasDirectas.size
  }

  return { manchados, contamina, esElErrorMismo }
}

export function dentroDeTraductor(n: ts.Node, traductores: Set<string>): boolean {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if (!ts.isCallExpression(p)) continue
    // AG2 — por identificador: un método homónimo no es el traductor.
    const f = ts.isIdentifier(p.expression) ? p.expression.text : null
    if (f && traductores.has(f)) return true
  }
  return false
}

/**
 * AC2 — **La lista de salidas se borra.**
 *
 * Cinco versiones de la guarda de fugas y tres de la de la página enumeraban por
 * dónde sale el dato: `return`, `throw`, propiedad `error:`, atributo `loadError`,
 * spread. La iteración 10 quitó la enumeración del *valor* —ahora se decide por
 * contaminación— y la dejó intacta en la salida, así que el patrón siguió: la
 * revisión sacó el crudo de Postgres de `app/actions.ts` por seis caminos con la
 * suite entera en verde, y `<div>{error.message}</div>`, que se pinta en pantalla,
 * no se miraba siquiera.
 *
 * Se invierte la pregunta. No «¿sale por alguno de estos sitios?», sino **«¿dónde
 * MUERE la contaminación?»**. Se toma cada expresión contaminada *máxima* —la más
 * externa que sigue contaminada— y se pregunta qué la consumió. Sólo tres
 * respuestas la salvan:
 *
 *  (a) la consumió un traductor importado del módulo de errores;
 *  (b) sólo se leyó su verdad — condición de `if`/`while`/`for`/`switch`/ternario,
 *      operando de `!` o de `typeof` —, que no mueve el texto a ninguna parte;
 *  (c) se está atando a un nombre, y entonces la contaminación sigue por el
 *      nombre y se juzga donde ese nombre se use. Salvo que el nombre se
 *      **exporte**, porque exportar ya es cruzar el límite del módulo.
 *
 * Cualquier otra cosa es una fuga. No hay lista que ampliar: una forma de salida
 * nueva es, por construcción, «cualquier otra cosa».
 */
/**
 * AD8 — `sinExencion` apaga una de las tres a propósito. No es una puerta
 * trasera: es la sonda que §E.2 exige. El banco negativo sólo demuestra algo si
 * **muere** al quitar la exención que lo deja pasar, y medir eso a mano se
 * olvida. Aquí lo mide un test en cada pasada.
 */
export type Exencion = 'traductor' | 'lectura' | 'atadura'

export function fugasContaminadas(
  arbol: ts.SourceFile, traductores: Set<string>, semilla: Semilla = {},
  sinExencion?: Exencion,
): string[] {
  const { contamina } = contaminar(arbol, traductores, semilla)
  const camposLimpiosDelPadre = semilla.camposLimpios ?? []
  /** ¿Es esta expresión, tal cual, lo que se sembró? */
  const esSemillaDirecta = (e: ts.Node): boolean => {
    if (!semilla.esSemilla) return false
    if (semilla.esSemilla(e)) return true
    return ts.isAwaitExpression(e) && semilla.esSemilla(e.expression)
  }
  const fugas: string[] = []

  const anotar = (n: ts.Node, que: string) => {
    const linea = arbol.getLineAndCharacterOfPosition(n.getStart(arbol)).line + 1
    const clave = `${que} (línea ${linea})`
    if (!fugas.includes(clave)) fugas.push(clave)
  }

  /** (b) — sólo se leyó su verdad. */
  const soloSeMira = (t: ts.Node, p: ts.Node): boolean => {
    if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p) ||
        ts.isSwitchStatement(p)) return p.expression === t
    if (ts.isForStatement(p)) return p.condition === t
    if (ts.isConditionalExpression(p)) return p.condition === t
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken
    /**
     * AD7 — Leer el código de un valor contaminado no mueve el texto a ninguna
     * parte: es la lectura que el proyecto declara legítima desde S14. Va aquí y
     * no en `contamina` para que el valor entero siga contaminado — si no, el
     * hijo ascendía a máximo y la lectura del código se contaba como fuga.
     */
    /**
     * Leer el código no mueve el texto. AF9 — pero sólo cuando se lee del error
     * mismo: `x.details.code` es el código *dentro* de otro campo, y esa lectura
     * lavaba la contaminación de `details`, que sí es texto.
     */
    if ((ts.isPropertyAccessExpression(p) && p.name.text === 'code') ||
        (ts.isElementAccessExpression(p) && p.argumentExpression &&
         ts.isStringLiteral(p.argumentExpression) && p.argumentExpression.text === 'code')) {
      /**
       * AG1 — Aquí había una segunda comprobación del receptor, y **cada una de
       * las dos bastaba por su cuenta**: quitar cualquiera dejaba la suite verde,
       * que es la definición de duplicado (X2). La pregunta se responde una vez,
       * en `contamina`, donde además evita el falso positivo. Aquí sólo queda la
       * posición: que lo que se lee sea el receptor de este `.code`.
       */
      return p.expression === t
    }
    /**
     * AI1 — Leer un campo declarado limpio (`res.data`) tampoco mueve el texto.
     * Va aquí por la misma razón que el `code`: al no manchar el resultado, el
     * receptor asciende a expresión máxima y la lectura legítima se contaba como
     * fuga. Tres veces el mismo patrón, tres veces la misma solución.
     */
    if ((ts.isPropertyAccessExpression(p) && camposLimpiosDelPadre.includes(p.name.text)) ||
        (ts.isElementAccessExpression(p) && p.argumentExpression &&
         ts.isStringLiteral(p.argumentExpression) &&
         camposLimpiosDelPadre.includes(p.argumentExpression.text))) {
      return p.expression === t
    }
    // AF6 — `Boolean(error)`: como `typeof`, sólo lee su verdad. Va aquí además
    // de en `contamina` porque al no manchar el resultado el hijo asciende a
    // máximo, y sin esto la lectura limpia se contaba como fuga.
    if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) &&
        p.expression.text === 'Boolean') return p.arguments.some(a => a === t)
    return ts.isTypeOfExpression(p)
  }

  /**
   * ¿Se exporta ESTA atadura? Exportar ya es cruzar el límite del módulo, así que
   * `export const mensaje = error.message` es una fuga aunque nadie más lo lea.
   * Se mira la sentencia propia y **no se sube más**: preguntar por cualquier
   * ancestro marcaba `const a = error` dentro de una función exportada, que es
   * propagación normal y se juzga donde `a` se use.
   */
  const seExportaLaAtadura = (p: ts.Node): boolean => {
    if (!ts.isVariableDeclaration(p)) return false
    const st = p.parent?.parent
    if (!st || !ts.canHaveModifiers(st)) return false
    return !!ts.getModifiers(st)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  }

  /**
   * AI1 — El valor que se **tira**. `void createClient().from(…).then(…)` no
   * lleva el resultado a ninguna parte: se lanza la petición y se descarta lo que
   * vuelva. Sin esto, sembrar el origen marcaba como fuga cada disparo de
   * consulta del producto. Sólo vale para la semilla misma: `console.error(res)`
   * no es un descarte, es un envío, y la llamada que lo envuelve no es un
   * resultado del cliente.
   */
  const seTira = (t: ts.Node, p: ts.Node): boolean => {
    if (!esSemillaDirecta(t)) return false
    if (ts.isVoidExpression(p)) return true
    if (ts.isExpressionStatement(p)) return true
    if (ts.isAwaitExpression(p) && p.parent && ts.isExpressionStatement(p.parent)) return true
    return false
  }

  /** (c) — se está atando a un nombre: la contaminación sigue por ahí. */
  /** Nombres que el módulo exporta: atarles algo contaminado ya es cruzar. */
  const exportados = new Set<string>()
  {
    const recoger = (n: ts.Node): void => {
      const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined
      if (mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (ts.isVariableStatement(n)) {
          for (const d of n.declarationList.declarations) {
            if (ts.isIdentifier(d.name)) exportados.add(d.name.text)
          }
        }
        if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) {
          exportados.add(n.name.text)
        }
      }
      ts.forEachChild(n, recoger)
    }
    ts.forEachChild(arbol, recoger)
  }

  /** La base de `o.x`, `o[0]` o `this.x`, para saber a quién se le ata. */
  const raizDe = (e: ts.Node): string | null => {
    let n = pelar(e)
    for (;;) {
      if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
        n = pelar(n.expression); continue
      }
      if (ts.isIdentifier(n)) return n.text
      if (n.kind === ts.SyntaxKind.ThisKeyword) return 'this'
      return null
    }
  }

  const dentroDeClaseExportada = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      if (ts.isClassDeclaration(p) || ts.isClassExpression(p)) {
        const mods = ts.canHaveModifiers(p) ? ts.getModifiers(p) : undefined
        return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
      }
    }
    return false
  }

  const seEstaAtando = (t: ts.Node, p: ts.Node): boolean => {
    if (ts.isVariableDeclaration(p) || ts.isBindingElement(p) ||
        ts.isPropertyDeclaration(p) || ts.isParameter(p)) {
      return p.initializer === t && !seExportaLaAtadura(p)
    }
    // `o.e = crudo` / `v = crudo`: la asignación entera es lo contaminado, y el
    // destino queda manchado, así que la fuga se juzga donde el destino se use.
    if (!ts.isBinaryExpression(t) || t.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        !ts.isExpressionStatement(p)) return false
    /**
     * AD7 — Salvo que el destino ya esté al otro lado del límite. La excepción
     * que (c) declara —«salvo que el nombre se exporte»— sólo miraba el
     * inicializador de una `const`, así que `export let x; x = error`,
     * `export const cache = {}; cache.ultimo = error` y `this.m = error` en una
     * clase exportada se colaban por debajo.
     */
    const raiz = raizDe(t.left)
    if (raiz && exportados.has(raiz)) return false
    if (raiz === 'this' && dentroDeClaseExportada(t)) return false
    return true
  }

  const etiqueta = (p: ts.Node): string =>
    ts.isReturnStatement(p) ? 'return'
      : ts.isThrowStatement(p) ? 'throw'
        : ts.isYieldExpression(p) ? 'yield'
          : ts.isJsxExpression(p) ? 'jsx'
            : ts.isJsxSpreadAttribute(p) ? 'jsx'
              : ts.isExportAssignment(p) ? 'export'
                : 'salida'

  /**
   * Un identificador en posición de **nombre** no es un valor: `{ error: 'texto
   * fijo' }` declara una propiedad que se llama así, y `const { data, error } =`
   * la ata. Medido sobre los ficheros reales: sin esto la regla invertida marcaba
   * las seis desestructuraciones de `app/actions.ts` y su propio `type
   * ActionState`. Los tipos no se recorren por la misma razón.
   */
  const esNombre = (n: ts.Node): boolean => {
    const p = n.parent
    if (!p) return false
    if (ts.isPropertyAccessExpression(p) && p.name === n) return true
    if (ts.isQualifiedName(p)) return true
    /**
     * AD7 — `const { data, error: fallo } = …`: el `error` de la izquierda es el
     * nombre del campo de ORIGEN, no un valor. Marcarlo hacía que la guarda
     * castigara la forma limpia con alias, que es la que hay que fomentar.
     */
    if (ts.isBindingElement(p) && p.propertyName === n) return true
    const conNombre = p as ts.Node & { name?: ts.Node }
    return conNombre.name === n && !ts.isShorthandPropertyAssignment(p)
  }
  const esTipo = (n: ts.Node): boolean =>
    ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n) ||
    ts.isTypeParameterDeclaration(n)

  const visitar = (n: ts.Node): void => {
    if (esTipo(n)) return
    if (!esNombre(n) && contamina(n)) {
      /**
       * Máxima: ningún ancestro sigue contaminado. Así se anota una vez por árbol
       * de contaminación y no una por cada hoja que lo alimenta.
       *
       * AJ1 — Pero el ascenso **se corta en el borde de una función**. Al sembrar
       * el origen (AI1), la cadena entera del cliente quedó contaminada, y una
       * exención del nodo de fuera —el descarte de `void chain`, la atadura a un
       * nombre— tapaba todo lo que hubiera dentro, **incluido el cuerpo de un
       * callback**, que es otro ámbito y otro momento. Medido sobre
       * `GroupView.tsx` real: una fuga dentro del `.then(…)` devolvía `[]`, y con
       * la semilla anterior se cazaba. Cada cuerpo de función es su propia raíz.
       */
      let masArriba = false
      for (let p: ts.Node | undefined = n.parent; p && !ts.isSourceFile(p); p = p.parent) {
        if (ts.isFunctionDeclaration(p) || ts.isFunctionExpression(p) ||
            ts.isArrowFunction(p) || ts.isMethodDeclaration(p) ||
            ts.isGetAccessorDeclaration(p)) break
        if (contamina(p)) { masArriba = true; break }
      }
      const p = n.parent
      // (a) `dentroDeTraductor` cubre el argumento directo y el anidado; había
      // una segunda función que sólo cubría el directo, y se enmascaraban: borrar
      // cualquiera de las dos no ponía roja ni una fila del banco negativo.
      const limpia = (sinExencion !== 'traductor' && dentroDeTraductor(n, traductores)) ||
        (sinExencion !== 'lectura' && (soloSeMira(n, p) || seTira(n, p))) ||
        (sinExencion !== 'atadura' && seEstaAtando(n, p))
      if (!masArriba && p && !limpia) {
        anotar(n, etiqueta(p))
      }
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return fugas
}
