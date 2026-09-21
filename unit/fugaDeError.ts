import { analizar } from './comentarios'
import { fugasContaminadas, type Exencion } from './contaminacion'
import { exencionesReales } from './textoCrudo'

/**
 * U4 / AC2 — Sexta versión. Historia, porque explica el diseño:
 *  1ª  expresión regular sobre el texto → cazaba 1 de 6 formas.
 *  2ª  lista de seis formas conocidas → se colaron cinco más.
 *  3ª  contaminación con exención "por símbolo" que no lo era.
 *  4ª  propagación por asignación, spread, cast, ternario, `||`, array y paso
 *      por función; exención anclada al módulo de errores.
 *  5ª  (AB2) la decisión pasó del valor a la contaminación de lo que sale — pero
 *      **los sitios por donde sale seguían enumerados**: cuatro. La revisión
 *      sacó el crudo de `app/actions.ts` por seis caminos con la suite verde.
 *  6ª  ésta: no hay lista de salidas. Se pregunta dónde MUERE la contaminación,
 *      y sólo la salvan el traductor, una lectura de verdad y una atadura a un
 *      nombre que no se exporta. Vive en `unit/contaminacion.ts`, compartida con
 *      la guarda de la página: una sola regla, dos semillas.
 *
 * La regla, dicha en una línea: nada que salga de una acción puede venir del
 * error de la base sin pasar por el traductor.
 */
export function fugasDeError(
  fuente: string, nombre = 'actions.ts', sinExencion?: Exencion,
): string[] {
  const arbol = analizar(fuente, nombre)
  // AF1 — el error también llega por el rechazo de una promesa y por `catch`.
  // AG2 — exime lo que sanea, no lo que se importa. Una sola definición para
  // las tres guardas: dos respuestas a la misma pregunta divergen (X2).
  return fugasContaminadas(arbol, exencionesReales(arbol),
    { rechazosSonSemilla: true }, sinExencion)
}
