import type { Clase } from './errors'

/**
 * Spec del reducer — **El aviso, con dueño y con duración.** Seis vueltas sobre este
 * mecanismo dieron siempre el mismo fallo: un arreglo correcto donde caía que abría
 * la puerta de al lado. La causa medida no era la prioridad, era que «qué es un
 * aviso» y «cuánto pesa» viajaban en la misma dimensión.
 *
 * **Un aviso vive mientras su condición sea cierta, o vive hasta que lo lean.** Son
 * dos cosas distintas y no compiten entre sí:
 *
 * - **Una vez** —una mutación fallida, una relectura que falla, lo descartado al
 *   abrir— es la respuesta a algo que acaba de pasar. Nadie lo retira: se va cuando
 *   otro lo sustituye o cuando una operación con éxito lo limpia.
 * - **Nivel** —la condición con la que cargó la página, la cola con pendientes— es el
 *   fondo que sigue siendo verdad debajo. Lo retira **su condición**, por medio de su
 *   dueño, y dos niveles pueden ser ciertos a la vez.
 *
 * La partición está medida, no elegida: los orígenes que alguien retira explícitamente
 * son exactamente los niveles, y los que nadie retira son los de una vez. Derivarla
 * del peso daba una partición distinta en dos de los cinco, y esos dos —`cola` y
 * `apertura`— son los que produjeron los dos últimos fallos.
 */
/**
 * i4-R1 — **`'enlace'` existe porque «Enlace copiado.» no es un fallo, y la única forma de
 * decirlo es el origen.**
 *
 * Se pintaba rojo y se anunciaba con `role="alert"`: a quien usa lector de pantalla se le
 * anunciaba de forma asertiva, como un error, el único mensaje de éxito que tiene esta vista.
 * Es literalmente la cicatriz i1-R4, que ya está documentada en `unit/disparadores.test.tsx`.
 *
 * No se puede resolver por `clase` —el propio i1-R4 lo dice: `'servidor'` la comparten la
 * carga y la edición fallidas— ni reutilizando `'mutacion'`, que es el de los dos fallos del
 * enlace. Un origen discrimina **porque tiene un solo escritor**, y éste lo tiene: el `if
 * (siSaleBien)` de `intentarEnlace`. Los fallos de las dos vías siguen en `'mutacion'`.
 */
export type Origen = 'mutacion' | 'relectura' | 'apertura' | 'carga' | 'cola' | 'enlace'

export type Aviso = { texto: string; clase: Clase; origen: Origen; token?: number }

export type EstadoAviso = {
  unaVez: Aviso | null
  niveles: Partial<Record<Origen, Aviso>>
}

export type Accion =
  | { tipo: 'avisar'; origen: Origen; texto: string; clase: Clase; token?: number }
  | { tipo: 'afinar'; token: number; texto: string; clase: Clase }
  | { tipo: 'retirar'; origen: Origen }
  | { tipo: 'limpiar' }

/** Qué es cada aviso. Dato, no deducción: ver el encabezado. */
export const DURACION: Record<Origen, 'una-vez' | 'nivel'> = {
  mutacion: 'una-vez', relectura: 'una-vez', apertura: 'una-vez', enlace: 'una-vez',
  carga: 'nivel', cola: 'nivel',
}

/**
 * Cuánto pesa cada uno **dentro de su duración**, y sólo ahí. Entre los de una vez
 * decide quién tapa a quién; entre los niveles, cuál se ve primero — nunca cuál
 * sobrevive, porque los niveles no se destruyen entre ellos.
 *
 * Los tres pesos de una vez son distintos, así que **no hay empate posible** y no hay
 * regla de desempate: la que hubo —«a igual peso gana el más reciente»— se midió
 * inalcanzable (cambiar `<` por `<=` dejaba la suite entera verde) y se retiró en vez
 * de dejar una cláusula que ningún test puede poner roja. Si algún día dos comparten
 * peso, hará falta decidirlo y probarlo entonces.
 */
export const PESO: Record<Origen, number> = {
  /**
   * i4-R1 — `enlace` pesa **0**: el más ligero de los de una vez, y distinto de los otros
   * tres, porque el encabezado declara que no hay empates posibles y por eso no hay regla de
   * desempate.
   *
   * El peso lo decidió una prueba, no una intuición. Con 4 —«lo último que hizo el usuario
   * manda»— «Enlace copiado.» **tapaba el fallo del intento siguiente**: copiar bien y volver
   * a copiar con el permiso revocado dejaba en pantalla el acuse de éxito del intento
   * anterior. Un acuse de que algo salió bien es lo menos importante que se puede decir: lo
   * cubre cualquier cosa que haya perdido algo.
   */
  mutacion: 3, relectura: 2, apertura: 1, enlace: 0,
  carga: 2, cola: 1,
}

export const avisoInicial: EstadoAviso = { unaVez: null, niveles: {} }

const nivelVisible = (niveles: EstadoAviso['niveles']): Aviso | null =>
  Object.values(niveles).sort((a, b) => PESO[b.origen] - PESO[a.origen])[0] ?? null

/** Lo que se pinta. Lo de una vez tapa al nivel sin borrarlo. */
export const visible = (e: EstadoAviso): Aviso | null => e.unaVez ?? nivelVisible(e.niveles)

export function reducirAviso(e: EstadoAviso, a: Accion): EstadoAviso {
  switch (a.tipo) {
    case 'avisar': {
      const aviso: Aviso = { texto: a.texto, clase: a.clase, origen: a.origen, token: a.token }
      // Cada nivel tiene su propia casilla, así que aquí no hay nada que comparar:
      // no compiten. La comparación vive sólo donde hay un hueco compartido.
      if (DURACION[a.origen] === 'nivel') return { ...e, niveles: { ...e.niveles, [a.origen]: aviso } }
      if (e.unaVez && PESO[a.origen] < PESO[e.unaVez.origen]) return e
      return { ...e, unaVez: aviso }
    }
    /**
     * Llega tarde por definición: sólo habla si el aviso que salió a afinar sigue
     * siendo el que hay. La identidad viaja dentro de la acción y no se deduce del
     * estado, porque quien despacha no puede saber en qué estado aterrizará.
     *
     * `token` es opcional en el aviso porque la mayoría no afina nunca; no hace falta
     * comprobarlo aparte, porque el de la acción siempre es un número.
     */
    case 'afinar':
      if (!e.unaVez || e.unaVez.token !== a.token) return e
      return { ...e, unaVez: { ...e.unaVez, texto: a.texto, clase: a.clase } }
    case 'retirar': {
      if (DURACION[a.origen] === 'nivel') {
        if (!e.niveles[a.origen]) return e
        const niveles = { ...e.niveles }
        delete niveles[a.origen]
        return { ...e, niveles }
      }
      return e.unaVez?.origen === a.origen ? { ...e, unaVez: null } : e
    }
    /**
     * Una operación del usuario que sale bien se lleva **lo de una vez** —son la
     * respuesta a gestos anteriores y ya no vienen a cuento— y **nunca los niveles**:
     * un alta que sale bien no desmiente «ya no tienes acceso a este grupo», ni que
     * queden pendientes en la cola.
     */
    case 'limpiar':
      return e.unaVez ? { ...e, unaVez: null } : e
  }
}
