/**
 * Spec J / J-R1, J-R10 — **La cantidad de un ítem es un entero de 1 a 99, o nada.**
 *
 * Este módulo es **la única declaración del lado TypeScript**. La otra vive en SQL,
 * dentro de `supabase/migrations/20260921000200_cantidad_numero.sql`, y no puede ser
 * la misma función: la normalización de la cola corre en un dispositivo **sin red**
 * —drenar es justamente lo que se hace cuando la base no estaba—, así que no hay
 * frontera por la que compartirla. Lo que sí hay es una guarda, `unit/cantidad.test.ts`,
 * que ejecuta la misma tabla de casos por los dos lados y exige el mismo veredicto.
 *
 * **Y su límite, dicho en voz alta: coincidir no es acertar.** Si los dos lados
 * comparten un punto ciego —un dígito árabe `٥`, uno de ancho completo `５`— la guarda
 * da verde con los dos mal. Por eso su tabla de casos no sale de la imaginación de
 * quien la escribe: sale de los valores que la medida encontró en las bases reales.
 */

/** El invariante, tal cual lo dice el `check` de la base: 1..99, o nulo. */
export const CANTIDAD = /^[1-9][0-9]?$/

/**
 * (a) Un separador decimal —punto o coma— seguido de dígito. Deja la cantidad **vacía**.
 *
 * Es el mismo principio que hace que `299` no se convierta en `29`: un número fuera de
 * rango no es un número dentro de rango, y `1.5` no es un entero. Convertirlo en `1`
 * sería inventar otro dato, y en una lista de la compra `1.5` son casi siempre 1,5
 * kilos o litros — el `1` no es «la parte que se salva», es una cifra falsa.
 *
 * La coma va con el punto porque es lo que teclea un teclado español. Y el separador
 * **sólo cuenta si va seguido de dígito**: en «2, briks» la coma no separa decimales,
 * sólo va detrás del número, y ahí la respuesta sigue siendo `2`.
 */
const DECIMAL = /^[0-9]+[.,][0-9]/

/** (b) El entero inicial de 1 a 99, cuando le sigue algo que no es dígito, o el final. */
const ENTERO_INICIAL = /^([1-9][0-9]?)(?:[^0-9]|$)/

/**
 * Qué hacer con una cantidad que ya está escrita y no cumple: la de una entrada de la
 * cola guardada antes de este cambio, o la de una fila que la migración encuentra.
 *
 * **No se usa en el campo mientras se teclea** — para eso está `soloCantidad`, y la
 * diferencia está explicada ahí.
 */
export function normalizar(texto: string | null | undefined): string | null {
  if (texto == null) return null
  if (DECIMAL.test(texto)) return null
  return ENTERO_INICIAL.exec(texto)?.[1] ?? null
}

/**
 * i1-R1 — Lo que el campo deja teclear: **dígitos y separadores decimales**. Pegar
 * «2 briks» deja `2`; pegar «briks» no deja nada; pegar «1.5» deja `1.5`.
 *
 * **La versión anterior tiraba también los separadores, y eso inventaba un dato.**
 * `'1.5'.replace(/[^0-9]/g,'')` es `'15'`, que además **pasa el `check`**: la base lo
 * aceptaba y en la lista aparecía una cantidad diez veces la real. Es el mismo defecto
 * que la regla del decimal cerró para la cola —convertir `1.5` en `1` es inventar—, y
 * peor, porque allí se descarta y aquí se falseaba. Medido en navegador: la fila entró
 * con `quantity='15'`.
 *
 * **No recorta al rango, a propósito**: `0` y `100` se pueden teclear. Recortar «100» a
 * «10» sería la misma invención. Quien decide si eso se manda es `valeComoCantidad`.
 */
export function soloCantidad(texto: string): string {
  return texto.replace(/[^0-9.,]/g, '')
}

/**
 * i1-R1 — **El `pattern` del campo, derivado del mismo conjunto que el filtro.**
 *
 * No es decoración: `pattern` es **validación nativa del formulario**, y un valor que no
 * casa **bloquea el envío**. Con el filtro dejando pasar `.` y `,` y el `pattern` limitado
 * a `[0-9]*`, pulsar «+» con «1.5» en el campo no hacía nada: ni ítem, ni aviso, ni error
 * — el «return mudo» que este código ya tiene dos cicatrices por, ahora puesto por el
 * navegador. Cazado por `unit/shell.test.tsx` › i3, que pulsa el botón; el test de la vista
 * no lo vio porque enviaba el formulario directamente y eso salta la validación nativa.
 *
 * Quien decide si la cantidad vale es `valeComoCantidad`, que sabe decirlo. El `pattern`
 * sólo declara qué teclado pedir, y para eso tiene que admitir todo lo que el campo admite.
 */
export const TECLEABLE = '[0-9.,]*'

/**
 * i1-R2 — **¿Va a aceptar la base esta cantidad?** Una sola declaración, usada por los
 * tres caminos que mandan: el alta con red, el alta sin red y la edición por fila.
 *
 * Existe porque sin ella los dos caminos respondían distinto al mismo gesto. Con red,
 * teclear `100` llegaba a la base y volvía un error visible. **Sin red se encolaba
 * crudo, y al drenar `normalizar` lo dejaba en nulo sin decir nada**: el producto entraba
 * en la lista sin su cantidad y nadie se enteraba. La decisión 2 autoriza descartar lo
 * que se escribió **antes** de que esta regla existiera —eso lo sigue haciendo el
 * drenado—, no lo que alguien acaba de teclear con la pantalla delante.
 *
 * Vacía vale: la columna es nullable y los datos reales tienen filas sin cantidad.
 */
export function valeComoCantidad(texto: string): boolean {
  const limpio = texto.trim()
  return limpio === '' || CANTIDAD.test(limpio)
}
