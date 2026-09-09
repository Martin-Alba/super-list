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
export type Clase = 'sesion' | 'sin-acceso' | 'integridad' | 'duplicado' | 'texto' | 'red' | 'servidor' | 'generico'

export const SESION = 'Tu sesión ha caducado. Vuelve a entrar para seguir.'
export const SIN_ACCESO = 'Ya no tienes acceso a este grupo.'
export const INTEGRIDAD = 'Ese cambio no está permitido.'
export const DUPLICADO = 'Ese producto ya está en la lista.'
export const TEXTO = 'Ese texto no vale: revisa que no esté vacío y que no sea demasiado largo.'
export const RED = 'No hay conexión ahora mismo. Inténtalo otra vez.'

/**
 * R2 — El plan gratuito pausa el proyecto tras una semana sin uso, y una lista de
 * la compra se abre justo con esa frecuencia. Antes esto salía como «No se ha
 * podido completar la operación», que no dice qué pasa ni que se arregla solo; o
 * como «No hay conexión», que además culpa a quien no tiene la culpa.
 */
export const SERVIDOR = 'El servicio está despertando. Suele tardar unos segundos; lo reintentamos solo.'
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

/**
 * R7 — Sin red se puede apuntar, no corregir ni tachar. Es alcance declarado: son
 * las dos operaciones que abren un conflicto entre dos personas a ciegas, y esta
 * entrega elige no abrirlo. El aviso dice lo que **sí** se puede hacer, porque un
 * «no se puede» a secas deja al usuario sin salida.
 */
export const SIN_RED_ACCION = 'Sin conexión sólo puedes apuntar productos nuevos. Para editar o borrar, espera a tener red.'

/**
 * R1 — El estado se **nombra**, y de forma permanente mientras dura. Sin esto, la
 * única señal de que no hay red es que algo falle: el usuario se entera cuando ya
 * ha perdido el gesto. Dice lo que sí se puede hacer, que es lo accionable.
 */
export const SIN_RED = 'Sin conexión. Puedes apuntar productos: se enviarán al volver la red.'

/**
 * J6 — El almacén del dispositivo no admite la escritura: sin cuota, en modo
 * privado, o sin IndexedDB. Se dice, en vez de pintar una ficha que no existe.
 */
export const SIN_ALMACEN = 'Este dispositivo no puede guardar lo apuntado sin conexión. Vuelve a intentarlo con red.'

/** I2 — Lo que dice el shell que se sirve cuando la navegación no llega. */
export const SIN_RED_SOLO_LECTURA = 'Sin conexión: esto es lo último que vimos. Cuando vuelva la red podrás apuntar y cambiar cosas.'

/** J8 — El shell también se sirve para la portada y para entrar. */
export const SIN_RED_FUERA = 'Necesitas conexión para entrar y ver tus grupos.'

/** I2 / borde 5 — Un grupo que nunca se llegó a abrir no se puede enseñar. */
export const SIN_INSTANTANEA = 'Necesitas conexión para ver este grupo por primera vez.'

/** R3 — Lo que se ve junto a un producto que aún no ha llegado al servidor. */
export const PENDIENTE = 'Se enviará al volver la conexión'

/**
 * R5 — Lo que se descartó por viejo. Lleva el número porque «se han descartado
 * algunas cosas» no permite saber si importaba: con la cifra delante, el usuario
 * decide si vuelve a apuntarlas.
 */
export const caducados = (n: number): string =>
  n === 1
    ? 'Se descartó 1 producto que llevaba más de un día sin poder enviarse.'
    : `Se descartaron ${n} productos que llevaban más de un día sin poder enviarse.`

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
  /**
   * R10 / deuda 7 — Aquí había `text.includes('abort')`, y atrapaba
   * `current transaction is aborted, commands ignored until end of transaction
   * block`: un fallo del servidor anunciado como falta de conexión. Sale, y no
   * hace falta sustituirlo: un `AbortError` de nuestra propia cota llega **sin
   * código**, y ésos los decide `claseDe` por el estado de la red, no por el texto.
   */
  if (text.includes('timeout') || text.includes('timed out')
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
  duplicado: DUPLICADO, texto: TEXTO, red: RED, servidor: SERVIDOR, generico: GENERICO,
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
/**
 * R1 — **El código manda; sin código, decide la red.**
 *
 * Medido contra la base real: todo error de PostgREST trae código —`PGRST202`,
 * `42703`, `23514`—, así que «sin código» significa que no contestó nadie que
 * hable PostgREST. Y medido contra una pasarela caída: un proyecto pausado llega
 * como `{ message: 'Project is paused' }`, sin código y **sin `status`**, y con
 * cuerpo HTML el HTML entero acaba en `message`. Por eso la clase no puede
 * decidirse por el texto.
 *
 * Lo que sí lo decide es de quién es el fallo, y eso lo sabe el navegador: si la
 * red del usuario está bien, no contestó el servidor de datos. Es la misma forma
 * que `traducirConSesion` ya usa para el `42501` — el error más una sonda —, no
 * un mecanismo nuevo.
 *
 * En el servidor no hay navegador que preguntar, y `hayRed` vale `true`: si algo
 * falla ahí, la red del centro de datos no es la sospechosa.
 */
export function claseDe(
  error: unknown, opciones: { haySesion?: boolean } = {},
): Clase | null {
  if (!error) return null
  const e = error as { message?: unknown; code?: unknown }
  const codigo = typeof e.code === 'string' && e.code ? e.code : null
  if (!codigo) return 'servidor'
  const mensaje = typeof e.message === 'string' ? e.message : String(error)
  return clasificar(codigo, mensaje, opciones.haySesion ?? true)
}

/**
 * R1 — Lo único que la red cambia, y por eso es un refinado y no un parámetro:
 * `lib/items.ts` corre en el navegador pero no es un componente, así que no puede
 * leer un hook; pasarle el estado de la red obligaría a fontanería por tres
 * capas. La vista, que sí lo sabe, refina lo que le llega — exactamente como
 * `refinarSinSesion` hace con la sonda de sesión. Un mecanismo por pregunta.
 */
export const refinarSinRed = (clase: Clase | null, hayRed: boolean): Clase | null =>
  !hayRed && clase === 'servidor' ? 'red' : clase

/**
 * R2 / D.6 — Las esperas del reintento, en milisegundos. Van aquí y no en la
 * vista porque son la cota que D.6 exige, y una cota que vive dentro de un
 * componente no la puede afirmar nadie. Cinco intentos, tope de 8 s, menos de
 * medio minuto en total: si el servicio no ha despertado para entonces, insistir
 * no es información, es ruido.
 */
export const esperasDeReintento = (): number[] => [1_000, 2_000, 4_000, 8_000, 8_000]

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
  /**
   * I6 — Y pasa por `claseDe`, que aplica la regla del código primero. Antes iba
   * derecho a `clasificar`, así que un proyecto pausado alcanzado por una acción
   * de servidor seguía diciendo «No se ha podido completar la operación» — la
   * frase exacta que R2 vino a borrar. El servidor no tiene navegador que
   * preguntar, así que la clase sin código es `servidor`, que es lo cierto.
   */
  const clase = claseDe(error, { haySesion }) ?? 'generico'
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
