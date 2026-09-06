/**
 * J9 — al usuario no se le enseña el texto crudo de Postgres. Un mensaje como
 * `new row violates row-level security policy for table "items"` le dice el
 * nombre de la tabla y de la política, y no le dice qué hacer.
 */
export function describeError(raw: string | null | undefined): string {
  if (!raw) return 'No se ha podido completar la operación.'
  const text = raw.toLowerCase()
  if (text.includes('row-level security') || text.includes('permission denied')) {
    return 'Ya no tienes acceso a este grupo.'
  }
  if (text.includes('immutable') || text.includes('cannot be restored')) {
    return 'Ese cambio no está permitido.'
  }
  if (text.includes('check constraint') || text.includes('violates check')) {
    return 'Ese texto no vale: revisa que no esté vacío y que no sea demasiado largo.'
  }
  // `failed to fetch` es el texto del navegador; en servidor, Node produce
  // `TypeError: fetch failed`. Sin las dos formas, el fallo real del servidor
  // caia al mensaje generico.
  if (text.includes('abort') || text.includes('timeout') || text.includes('timed out')
      || text.includes('failed to fetch') || text.includes('fetch failed')
      || text.includes('networkerror')) {
    return 'No hay conexión ahora mismo. Inténtalo otra vez.'
  }
  return 'No se ha podido completar la operación.'
}

/** Lo que se dice cuando la fila ya no estaba: 0 filas afectadas (J14). */
export const GONE = 'Alguien lo quitó de la lista antes que tú.'
