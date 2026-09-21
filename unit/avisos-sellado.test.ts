import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { analizar } from './comentarios'

/**
 * U3 / DoD 45 — Cuatro de los cinco sitios que limpiaban el aviso no sellaban la
 * secuencia, así que el afinado en vuelo reaparecía encima: 42501 → alta correcta
 * → "tu sesión ha caducado" otra vez. Limpiar el aviso es una operación con una
 * responsabilidad, no un `setNotice(null)` suelto.
 */
export function limpiezasSinSellar(fuente: string, nombre = 'GroupView.tsx'): number[] {
  const arbol = analizar(fuente, nombre)
  const sueltas: number[] = []
  const dentroDeLimpiar = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
      if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.name.text === 'limpiarAviso') return true
    }
    return false
  }
  const visitar = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'setNotice' &&
        n.arguments.length === 1 && n.arguments[0].kind === ts.SyntaxKind.NullKeyword &&
        !dentroDeLimpiar(n)) {
      sueltas.push(arbol.getLineAndCharacterOfPosition(n.getStart(arbol)).line + 1)
    }
    ts.forEachChild(n, visitar)
  }
  ts.forEachChild(arbol, visitar)
  return sueltas
}

describe('U3 limpiar el aviso pasa siempre por el mismo sitio', () => {
  it('no queda ningún setNotice(null) suelto', () => {
    expect(limpiezasSinSellar(readFileSync('app/g/[id]/GroupView.tsx', 'utf8'))).toEqual([])
  })

  it('la guarda caza uno suelto', () => {
    expect(limpiezasSinSellar('function f() { setNotice(null) }', 'x.tsx')).not.toEqual([])
  })

  it('y no marca el que está dentro de limpiarAviso', () => {
    expect(limpiezasSinSellar(
      'const limpiarAviso = () => { secuencia.current++; setNotice(null) }', 'x.tsx')).toEqual([])
  })
})
