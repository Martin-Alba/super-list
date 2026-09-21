import ts from 'typescript'

/**
 * Z4 — `reportDiagnostics: false` y devolver lo que saliera significaba fallar
 * **abierto**: un fichero con un `/*` sin cerrar se emitía recortado y la guarda
 * lo declaraba limpio. Medido. Ahora se piden diagnósticos y se lanza: A.3 manda
 * fallar cerrado, y una guarda que no puede leer su entrada no ha comprobado
 * nada.
 *
 * Y4 — Cuarta versión del despojador, y la primera que no persigue casos:
 * 1ª  dos `String.replace` — un `//` dentro de una cadena se comía la línea.
 * 2ª  recorrido por caracteres respetando comillas — ciego a los literales de
 *     expresión regular, y hay uno vivo: el `//` final de `/\/realtime\/v1\//`.
 * 3ª  `ts.createScanner` — **tampoco basta**: un escáner sin analizador no
 *     distingue división de regex y come igual. Medido, no supuesto.
 * 4ª  el compilador completo, que sí tiene el contexto.
 *
 * Lo que esta versión **sí** garantiza: que cadenas, plantillas, expresiones
 * regulares y división se resuelven como los resuelve TypeScript. Lo que **no**
 * garantiza es nada sobre ficheros que no compilan, y por eso lanza en vez de
 * devolver un texto recortado que parecería limpio.
 */
export function analizar(fuente: string, nombre = 'entrada.ts'): ts.SourceFile {
  const arbol = ts.createSourceFile(nombre, fuente, ts.ScriptTarget.ESNext, true,
    nombre.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)

  // `parseDiagnostics` no es público, pero es la única señal de que el árbol
  // que se va a recorrer no representa el fichero.
  // AA12 — `?? []` fallaba abierto: si TypeScript renombra este campo interno,
  // la guarda dejaría de ver errores de sintaxis sin que nadie se entere. Es el
  // mismo defecto que Z4 vino a cerrar, un nivel más abajo.
  const errores = (arbol as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics
  if (!Array.isArray(errores)) {
    throw new Error('TypeScript ya no expone `parseDiagnostics`: la guarda no puede saber si el fichero compila')
  }
  const graves = errores.filter(d => d.category === ts.DiagnosticCategory.Error)
  if (graves.length > 0) {
    const primero = ts.flattenDiagnosticMessageText(graves[0].messageText, ' ')
    throw new Error(`no se pudo analizar ${nombre}: ${primero}. Una guarda que no lee su entrada no ha comprobado nada`)
  }
  return arbol
}

/** Texto sin comentarios, para las guardas que aún trabajan sobre texto. */
export function sinComentarios(fuente: string, nombre = 'entrada.ts'): string {
  analizar(fuente, nombre)
  return ts.transpileModule(fuente, {
    compilerOptions: {
      removeComments: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText
}
