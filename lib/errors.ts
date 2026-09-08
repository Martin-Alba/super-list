/**
 * J9 — al usuario no se le enseña el texto crudo de Postgres. Un mensaje como
 * `new row violates row-level security policy for table "items"` le dice el
 * nombre de la tabla y de la política, y no le dice qué hacer.
 *
 * R1 — Y hasta ahora decidía leyendo ese texto, que es la razón de fondo de los
 * tres síntomas que encontró el QA: `permission denied` llega tanto cuando no
 * tienes sesión como cuando no eres miembro, así que al usuario sin sesión se le
 * decía que había perdido el acceso al grupo. El **código** sí los separa, y
 * `lib/items.ts` lo recibía y lo descartaba.
 */
export type Clase = 'sesion' | 'sin-acceso' | 'integridad' | 'duplicado' | 'texto' | 'red' | 'generico'

export const SESION = 'Tu sesión ha caducado. Vuelve a entrar para seguir.'
export const SIN_ACCESO = 'Ya no tienes acceso a este grupo.'
export const INTEGRIDAD = 'Ese cambio no está permitido.'
export const DUPLICADO = 'Ese producto ya está en la lista.'
export const TEXTO = 'Ese texto no vale: revisa que no esté vacío y que no sea demasiado largo.'
export const RED = 'No hay conexión ahora mismo. Inténtalo otra vez.'
export const GENERICO = 'No se ha podido completar la operación.'

/**
 * AF7 — `'No se ha podido recargar la lista.'` vivía suelto en `GroupView.tsx`,
 * o sea un octavo texto de usuario fuera del fichero que se declara «la única
 * fuente de texto». Aquí está, con los otros.
 */
export const RELECTURA = 'No se ha podido recargar la lista.'

/**
 * AG7 — Los dos últimos textos que se le enseñan a alguien y vivían fuera de
 * aquí: uno en `app/actions.ts` y otro en `GroupView.tsx`. La afirmación de este
 * fichero —«la única fuente de texto»— era falsa mientras estuvieran allí, y
 * `unit/texto-crudo.test.ts` la sostiene ahora con una guarda.
 */
export const NOMBRE_VACIO = 'El nombre no puede estar vacío.'

/**
 * AH5 — Los avisos de estado del canal. Vivían en el JSX de dos vistas, con
 * redacciones distintas, y la guarda de AG7 no miraba el JSX: sólo veía lo que
 * pasaba por `avisarTexto`/`setNotice`. Siguen diciendo cosas distintas **a
 * propósito** —una lista que no se actualiza y una espera que no avanza no se
 * resuelven igual—, pero se escriben aquí, donde se pueden leer juntas.
 */
export const LISTA_EN_VIVO = 'Lista en vivo'
export const SIN_CONEXION_LISTA = 'Sin conexión en vivo: puede que no veas los cambios de los demás.'
export const SIN_CONEXION_ESPERA = 'Sin conexión en vivo. Recarga la página para comprobar si ya te han aceptado.'
export const ESCRIBE_NOMBRE = 'Escribe un nombre de producto.'

/** Lo que se dice cuando la fila ya no estaba: 0 filas afectadas (J14). */
export const GONE = 'Alguien lo quitó de la lista antes que tú.'

/**
 * `haySesion` no se adivina del error: lo sabe quien hace la llamada, porque
 * tiene el cliente delante. Es lo único que distingue `42501` "no tienes token"
 * de `42501` "tu token no basta para esta fila", y esa diferencia es la que el
 * usuario nota.
 */
/** Lo que el trigger de integridad dice, en su propio idioma. */
const ES_INTEGRIDAD = /immutable|cannot be restored/

export function clasificar(
  code: string | null | undefined, raw: string | null | undefined, haySesion = true,
): Clase {
  const texto = (raw ?? '').toLowerCase()
  if (code === 'PGRST301' || code === 'PGRST302') return 'sesion'
  if (code === '42501') {
    /**
     * S3 — R1 daba por hecho que cada clase tiene su código, y **es falso**: el
     * trigger `items_guard()` levanta `42501`, el mismo que RLS. Verificado en el
     * catálogo: sus cuatro `raise exception` lo usan. Sin este desvío, "este ítem
     * borrado no se puede resucitar" se le anuncia al usuario como que ha perdido
     * el acceso al grupo — falso, y sin nada que pueda hacer al respecto.
     */
    if (ES_INTEGRIDAD.test(texto)) return 'integridad'
    return haySesion ? 'sin-acceso' : 'sesion'
  }
  if (code === '23505') return 'duplicado'
  if (code === '23514' || code === '23502' || code === '22001') return 'texto'

  // Sin código: sólo queda el texto. Los fallos de red no traen código porque no
  // llegan a la base.
  const text = texto
  if (!text) return 'generico'
  if (text.includes('abort') || text.includes('timeout') || text.includes('timed out')
      || text.includes('failed to fetch') || text.includes('fetch failed')
      || text.includes('networkerror')) return 'red'
  if (text.includes('row-level security') || text.includes('permission denied')) {
    return haySesion ? 'sin-acceso' : 'sesion'
  }
  if (ES_INTEGRIDAD.test(text)) return 'integridad'
  if (text.includes('check constraint') || text.includes('violates check')) return 'texto'
  return 'generico'
}

// AE6 — Deja de exportarse: la única puerta al texto es `mensajeDe`, y con dos
// puertas la vista usaba la de atrás mientras la spec declaraba la de delante.
const MENSAJE: Record<Clase, string> = {
  sesion: SESION, 'sin-acceso': SIN_ACCESO, integridad: INTEGRIDAD,
  duplicado: DUPLICADO, texto: TEXTO, red: RED, generico: GENERICO,
}

/**
 * AD1 — **Aquí muere el texto crudo.** Once rondas de guardas intentaron demostrar
 * que el mensaje de Postgres no llega al usuario; la revisión de la 11 midió que
 * no se puede con análisis de un solo fichero, porque `Result.error` (crudo) y
 * `ActionState.error`.mensaje` (ya traducido) tenían el mismo nombre y el mismo tipo, y
 * confundirlos es un cambio de una palabra.
 *
 * Así que el crudo deja de existir fuera de este fichero. `claseDe` clasifica el
 * error **donde nace** y devuelve una etiqueta de siete valores; nadie más vuelve
 * a leer `.message`. Lo que no se puede leer no se puede filtrar.
 */
export function claseDe(error: unknown, haySesion = true): Clase | null {
  if (!error) return null
  const e = error as { message?: unknown; code?: unknown }
  const mensaje = typeof e.message === 'string' ? e.message : String(error)
  const codigo = typeof e.code === 'string' ? e.code : null
  return clasificar(codigo, mensaje, haySesion)
}

/** El mensaje que le corresponde a una clase. La única fuente de texto. */
export const mensajeDe = (clase: Clase | null | undefined): string | null =>
  clase ? MENSAJE[clase] : null

/**
 * AD1 — Lo ÚNICO que la sonda de sesión cambia. `clasificar(code, raw, false)` se
 * diferenciaba de `clasificar(code, raw, true)` exactamente en esto: un `42501`
 * (o un `permission denied` sin código) es «no tienes acceso» si hay sesión y
 * «tu sesión ha caducado» si no la hay. Sin el crudo delante, el afinado es esa
 * regla y no una segunda clasificación.
 */
export const refinarSinSesion = (clase: Clase | null): Clase | null =>
  clase === 'sin-acceso' ? 'sesion' : clase

/**
 * AE6 — Aquí vivía `describeError(raw, code, haySesion)`, la traducción de un
 * tiro. Desde AD1 el producto no la llama: clasifica donde el error nace
 * (`claseDe`) y pinta donde el aviso se ve (`mensajeDe`). Lo único que la
 * mantenía viva eran sus propios tests, que es la forma en que el código muerto
 * se defiende. Sus casos siguen probados sobre el camino que el producto sí
 * recorre.
 */

/**
 * T5 — `getUser()`/`getSession()` devuelven `{user: null, error}` **sin lanzar**
 * ante un fallo de red o una cota agotada. Mirando sólo el usuario, a alguien con
 * sesión perfectamente válida se le decía "tu sesión ha caducado" porque el que
 * estaba caído era el servicio de auth. Ante la duda se asume que hay sesión: el
 * aviso será menos preciso, pero no acusará en falso.
 */
export const haySesionSegun = (usuario: unknown, error: unknown): boolean => {
  if (!error) return !!usuario
  /**
   * Medido contra el stack real: sin sesión guardada, `getUser()` devuelve
   * `AuthSessionMissingError` **sin llegar a la red**, y eso sí es "no hay
   * sesión". Cualquier otro error —red caída, cota agotada, 5xx— es el servicio
   * de auth fallando, y ahí acusar de sesión caducada a quien la tiene válida es
   * el diagnóstico equivocado que esta spec vino a eliminar.
   */
  const nombre = (error as { name?: string })?.name ?? ''
  const mensaje = String((error as { message?: string })?.message ?? '').toLowerCase()
  if (nombre === 'AuthSessionMissingError' || mensaje.includes('session missing')) return false
  return true
}

/**
 * U4 — La traducción de un error de la base a lo que se le devuelve al usuario
 * vive **aquí**, con el traductor. Estaba en `app/actions.ts` como función local,
 * y eso obligaba a la guarda de fugas a eximir "cualquier función declarada" —
 * con lo que `function loQueSea(…)` la apagaba entera. Importada, la exención es
 * el símbolo y no hace falta ninguna excepción.
 */
export function traducirError(
  error: { message: string; code?: string }, haySesion = true,
): { mensaje: string; clase: Clase } {
  // AE9 — clasificaba dos veces el mismo error: `describeError` llama a
  // `clasificar` y aquí se volvía a llamar. Dos caminos al mismo hecho pueden
  // divergir; se calcula una vez.
  const clase = clasificar(error.code, error.message, haySesion)
  return { mensaje: MENSAJE[clase], clase }
}

/**
 * U4/U5 — La versión que necesita saber si hay sesión. Vive aquí y no en las
 * acciones para que el traductor siga siendo **uno solo e importado**: una
 * segunda función local reabría la exención de la guarda de fugas, que es como
 * `function loQueSea(…)` llegó a apagarla entera.
 *
 * La sonda entra como función, no como cliente, y va **acotada**: sin cota, cada
 * `42501` de una acción de servidor arrastraba al usuario hasta los 10 s de
 * `boundedFetch` — el defecto de S4 trasladado al servidor, donde no hay ninguna
 * carrera que lo rescate.
 */
export async function traducirConSesion(
  error: { message: string; code?: string },
  sonda: () => Promise<{ data: { user: unknown }; error: unknown }>,
  cotaMs = 2_000,
): Promise<{ mensaje: string; clase: Clase }> {
  if (error.code !== '42501') return traducirError(error, true)
  let haySesion = true
  // V8 — el temporizador se limpia: uno pendiente por cada `42501` mantiene viva
  // una invocación sin servidor. Es el mismo defecto que T7 cerró en el cliente.
  let reloj: ReturnType<typeof setTimeout> | undefined
  try {
    const { data, error: eAuth } = await Promise.race([
      sonda(),
      new Promise<never>((_, no) => { reloj = setTimeout(() => no(new Error('sin respuesta')), cotaMs) }),
    ])
    haySesion = haySesionSegun(data.user, eAuth)
  } catch { haySesion = true } finally { if (reloj) clearTimeout(reloj) }
  return traducirError(error, haySesion)
}
