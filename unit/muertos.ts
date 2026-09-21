import ts from 'typescript'
import { analizar } from './comentarios'

/**
 * AF4 — La guarda de AE6 hacía el censo con una expresión regular y decidía
 * «consumido» preguntando si **la palabra aparecía** en algún fichero de
 * producto. La revisión sembró seis funciones muertas y **tres sobrevivieron**:
 * una citada en un comentario de línea, otra en la primera línea de un bloque, y
 * `export const f: T = (x) => x`, que el censo ni siquiera contaba. De once
 * campos del payload, ocho escapaban — `errorCode` se cazó por suerte del nombre.
 *
 * Aquí se hace con el árbol: el censo mira las declaraciones exportadas, y el
 * consumo mira **referencias reales**, no texto.
 */

/** Funciones exportadas de un módulo, sea cual sea la forma de declararlas. */
export function funcionesExportadas(fuente: string, nombre = 'm.ts'): string[] {
  const arbol = analizar(fuente, nombre)
  const salida: string[] = []
  const exportado = (n: ts.Node) => {
    const mods = ts.canHaveModifiers(n) ? ts.getModifiers(n) : undefined
    return !!mods?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
  }
  ts.forEachChild(arbol, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && exportado(n)) { salida.push(n.name.text); return }
    if (!ts.isVariableStatement(n) || !exportado(n)) return
    for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue
      // `export const f = (x) => x` y `export const f: T = (x) => x`: la
      // anotación de tipo hacía invisible a la segunda para la regex.
      const v = ts.isAsExpression(d.initializer) ? d.initializer.expression : d.initializer
      if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) salida.push(d.name.text)
    }
  })
  return salida
}

/** Nombres a los que un fuente hace referencia de verdad: llamadas y lecturas. */
export function referencias(fuente: string, nombre = 'm.ts'): Set<string> {
  const arbol = analizar(fuente, nombre)
  const vistos = new Set<string>()
  const visitar = (n: ts.Node): void => {
    // Un import no es un uso: importar algo y no llamarlo es código muerto con
    // una línea de más, no código vivo.
    if (ts.isImportDeclaration(n)) return
    if (ts.isIdentifier(n)) {
      const p = n.parent
      const esNombreDeclarado = p && (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p) ||
        ts.isClassDeclaration(p) || ts.isParameter(p)) &&
        (p as ts.Node & { name?: ts.Node }).name === n
      if (!esNombreDeclarado) vistos.add(n.text)
    }
    // `x.campo` cuenta como referencia al campo.
    if (ts.isPropertyAccessExpression(n)) vistos.add(n.name.text)
    if (ts.isBindingElement(n)) {
      const origen = n.propertyName ?? n.name
      if (ts.isIdentifier(origen)) vistos.add(origen.text)
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return vistos
}

/** Campos declarados en un `type X = { … }`. */
export function camposDelTipo(fuente: string, tipo: string, nombre = 'm.ts'): string[] {
  const arbol = analizar(fuente, nombre)
  const salida: string[] = []
  ts.forEachChild(arbol, (n) => {
    if (!ts.isTypeAliasDeclaration(n) || n.name.text !== tipo) return
    if (!ts.isTypeLiteralNode(n.type)) return
    for (const m of n.type.members) {
      if (ts.isPropertySignature(m) && ts.isIdentifier(m.name)) salida.push(m.name.text)
    }
  })
  return salida
}
