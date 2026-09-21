import { describe, it, expect } from 'vitest'
import { SIN_ACCESO, GONE, RELECTURA, SERVIDOR, SESION } from '@/lib/errors'
import { avisoInicial, reducirAviso, visible, type EstadoAviso } from '@/lib/aviso'

/**
 * Spec del reducer — La tabla de prioridad, atacada en la capa que el requisito
 * nombra (§E.1): es una regla del reducer, no de la vista. Sin jsdom, como
 * `unit/cola.test.ts`, que es el precedente de regla pura sacada de este mismo
 * componente.
 *
 * Lo que NO se prueba aquí, y por qué: que el componente sepa qué identidad
 * presentar al afinar. El reducer la recibe ya calculada, así que una prueba suya
 * pasaría con ese defecto puesto — vive en `unit/avisos.test.tsx`.
 */
const suceso = (origen: 'mutacion' | 'relectura' | 'apertura', texto: string) =>
  ({ tipo: 'avisar', origen, texto, clase: 'generico' }) as const
const estado = (origen: 'carga' | 'cola', texto: string) =>
  ({ tipo: 'avisar', origen, texto, clase: 'generico' }) as const
const tras = (...acciones: Parameters<typeof reducirAviso>[1][]): EstadoAviso =>
  acciones.reduce(reducirAviso, avisoInicial)
const conToken = (a: ReturnType<typeof suceso>, token: number) => ({ ...a, token })
const afinar = (token: number) => ({ tipo: 'afinar', token, texto: SESION, clase: 'sesion' }) as const

describe('el reducer del aviso · la tabla de prioridad', () => {
  // DoD 1 de la spec del reducer — una aserción por casilla de la tabla de §2.
  it('mutacion gana a carga: un estado no pisa un suceso', () => {
    expect(visible(tras(suceso('mutacion', GONE), estado('carga', SIN_ACCESO)))?.texto).toBe(GONE)
  })

  /**
   * SUSTITUIDAS por el eje de la duración: «cola y mutacion empatan y gana el más
   * reciente» y «cola gana a carga» describían a `cola` como un aviso de una vez.
   * Medido, es un nivel —alguien lo retira cuando su condición deja de ser cierta—,
   * así que una mutación lo **tapa** sin destruirlo y con `carga` no compite: cada
   * uno tiene su casilla. Los dos comportamientos siguen probados, en «una mutación
   * fallida tapa el aviso de la cola» y en «carga y cola conviven».
   */

  it('mutacion gana a relectura: el gesto del usuario manda sobre una lista rancia', () => {
    expect(visible(tras(suceso('mutacion', GONE), suceso('relectura', RELECTURA)))?.texto).toBe(GONE)
  })

  it('relectura gana a carga', () => {
    expect(visible(tras(estado('carga', SERVIDOR), suceso('relectura', RELECTURA)))?.texto).toBe(RELECTURA)
  })

  /**
   * Iteración 1 / R4 — La prioridad ENTRE estados. La lista que no está pesa más
   * que un aviso de apertura: sin esto, abrir con el servicio dormido y la cola
   * caducada borraba «el servicio está despertando» para siempre.
   */
  /**
   * SUSTITUIDA: «carga gana a apertura» era el arreglo de la vuelta anterior, y era
   * el fallo — cerró «apertura pisa a carga» y abrió «carga se traga a apertura».
   * Con duraciones distintas no comparten hueco y el par deja de existir. Lo prueban
   * los dos tests de «un aviso de apertura se ve aunque la carga haya fallado».
   */

  // Sucesos y estados no se tocan, por los dos lados.
  it('el estado sigue debajo mientras el suceso dura, y reaparece al retirarse', () => {
    const s = tras(estado('carga', SIN_ACCESO), suceso('mutacion', GONE))
    expect(visible(s)?.texto).toBe(GONE)
    expect(visible(reducirAviso(s, { tipo: 'retirar', origen: 'mutacion' }))?.texto).toBe(SIN_ACCESO)
  })

  it('limpiar un suceso no borra el estado', () => {
    const s = tras(estado('carga', SIN_ACCESO), suceso('mutacion', GONE), { tipo: 'limpiar' })
    expect(visible(s)?.texto, 'la operación con éxito se llevó una condición que sigue siendo cierta')
      .toBe(SIN_ACCESO)
  })

  it('limpiar se lleva cualquier suceso, sea de la clase que sea', () => {
    expect(visible(tras(suceso('mutacion', GONE), { tipo: 'limpiar' }))).toBeNull()
    expect(visible(tras(suceso('relectura', RELECTURA), { tipo: 'limpiar' }))).toBeNull()
  })

  /**
   * La comparación de origen al retirar lo de una vez. El caso tiene que usar OTRO
   * origen de una vez: con un nivel, la acción se va por la rama de los niveles y
   * no toca este código — así dejó de vigilar cuando `cola` pasó a ser nivel, y lo
   * cazó la pasada de mutación.
   */
  it('retirar lo de una vez sólo alcanza a su propio origen', () => {
    expect(visible(tras(suceso('mutacion', GONE), { tipo: 'retirar', origen: 'relectura' }))?.texto)
      .toBe(GONE)
  })

  it('retirar un nivel sólo alcanza a su propia casilla', () => {
    const s = tras(estado('cola', 'pendiente'), { tipo: 'retirar', origen: 'carga' })
    expect(visible(s)?.texto, 'la retirada de la carga se llevó la cola').toBe('pendiente')
  })

  /**
   * El sello. La identidad viaja **dentro de la acción**: el afinado dice de quién
   * habla, en vez de contar cuántas cosas han pasado. Contar obligaba a quien
   * despacha a saber en qué estado aterrizaría, y no puede.
   */
  it('un afinado alcanza al aviso que lo lanzó', () => {
    const s = reducirAviso(avisoInicial, conToken(suceso('mutacion', SIN_ACCESO), 7))
    expect(visible(reducirAviso(s, afinar(7)))?.texto).toBe(SESION)
  })

  it('un afinado no alcanza a un aviso que no es el suyo', () => {
    const s = reducirAviso(avisoInicial, conToken(suceso('mutacion', GONE), 8))
    expect(visible(reducirAviso(s, afinar(7)))?.texto, 'el afinado de otro aviso repintó éste').toBe(GONE)
  })

  it('un afinado no alcanza a un aviso que nunca lanzó ninguno', () => {
    const s = tras(suceso('mutacion', GONE))
    expect(visible(reducirAviso(s, afinar(0)))?.texto,
      'un aviso sin token recibió un afinado ajeno').toBe(GONE)
  })

  it('un afinado no reaparece sobre una escritura que fue bien', () => {
    const s = reducirAviso(avisoInicial, conToken(suceso('mutacion', SIN_ACCESO), 7))
    expect(visible(reducirAviso(reducirAviso(s, { tipo: 'limpiar' }), afinar(7)))).toBeNull()
  })

  it('un afinado no crea un suceso donde no había ninguno', () => {
    expect(visible(reducirAviso(avisoInicial, afinar(1))),
      'el afinado se inventó un aviso sobre una pantalla limpia').toBeNull()
  })

  it('un afinado no revive un suceso que ya no está', () => {
    const s = reducirAviso(reducirAviso(avisoInicial, conToken(suceso('mutacion', SIN_ACCESO), 7)),
      { tipo: 'retirar', origen: 'mutacion' })
    expect(visible(reducirAviso(s, afinar(7)))).toBeNull()
  })
})

/**
 * Spec «el eje que faltaba es la duración» — Un aviso vive **mientras su condición
 * sea cierta** (nivel) o **hasta que lo lean** (una vez). Medido: de los cinco
 * orígenes, los dos que alguien retira explícitamente son niveles y los tres que
 * nadie retira son de una vez, y esa partición NO es la que el peso daba.
 */
describe('el reducer del aviso · duración y peso son dos ejes', () => {
  /**
   * DoD 4b — La sonda de la regla, atacada donde la regla actúa (§E.1): el
   * **encaminamiento**, no la tabla. Afirmar `PESO.carga > PESO.apertura` y
   * `DURACION.carga === 'nivel'` era una tautología sobre constantes: medido,
   * reintroducir `esSuceso = PESO >= 2` la dejaba verde.
   *
   * `carga` pesa 2 y `apertura` 1: si alguien vuelve a deducir «qué es» del número
   * con un umbral, uno de los dos cae del lado equivocado y este caso lo caza,
   * porque un nivel y un aviso de una vez **conviven** y uno de una vez y otro se
   * **sustituyen**.
   */
  it('la duración decide el hueco, no el peso', () => {
    const s = tras(estado('carga', SERVIDOR), suceso('apertura', 'se descartó 1'))
    expect(visible(s)?.texto, 'apertura y carga acabaron en el mismo hueco')
      .toBe('se descartó 1')
    expect(visible(reducirAviso(s, { tipo: 'limpiar' }))?.texto,
      'la carga no sobrevivió debajo: se la clasificó como de una vez').toBe(SERVIDOR)
    const dos = tras(suceso('apertura', 'se descartó 1'), suceso('relectura', RELECTURA))
    expect(visible(reducirAviso(dos, { tipo: 'limpiar' })),
      'dos de una vez convivieron: se clasificó alguno como nivel').toBeNull()
  })

  // DoD 1 — El fallo medido, por sus dos lados.
  it('un aviso de apertura se ve aunque la carga haya fallado, y la carga queda debajo', () => {
    const s = tras(estado('carga', SERVIDOR), suceso('apertura', 'se descartó 1'))
    expect(visible(s)?.texto, 'la condición de carga se tragó el aviso de apertura')
      .toBe('se descartó 1')
    expect(visible(reducirAviso(s, { tipo: 'limpiar' }))?.texto,
      'leído el de apertura, la condición de carga no estaba debajo').toBe(SERVIDOR)
  })

  it('un aviso de apertura no destruye la condición de carga', () => {
    const s = tras(suceso('apertura', 'se descartó 1'), estado('carga', SERVIDOR))
    expect(visible(reducirAviso(s, { tipo: 'limpiar' }))?.texto).toBe(SERVIDOR)
  })

  // DoD 3 — `cola` es un nivel: una mutación lo tapa, no lo destruye.
  it('una mutación fallida tapa el aviso de la cola, y al limpiarse reaparece', () => {
    const s = tras(estado('cola', 'se enviará al volver la red'), suceso('mutacion', GONE))
    expect(visible(s)?.texto).toBe(GONE)
    expect(visible(reducirAviso(s, { tipo: 'limpiar' }))?.texto,
      'la cola seguía teniendo pendientes y su aviso se destruyó').toBe('se enviará al volver la red')
  })

  // DoD 4 — Dos niveles ciertos a la vez: es el par que obliga al conjunto.
  it('carga y cola conviven: se ve carga, y al retirarla aparece cola', () => {
    const s = tras(estado('cola', 'se enviará al volver la red'), estado('carga', SERVIDOR))
    expect(visible(s)?.texto).toBe(SERVIDOR)
    expect(visible(reducirAviso(s, { tipo: 'retirar', origen: 'carga' }))?.texto,
      'retirar la carga se llevó también la cola: los niveles comparten hueco')
      .toBe('se enviará al volver la red')
  })

  it('retirar un nivel no toca al otro, venga en el orden que venga', () => {
    const s = tras(estado('carga', SERVIDOR), estado('cola', 'pendiente'),
      { tipo: 'retirar', origen: 'cola' })
    expect(visible(s)?.texto).toBe(SERVIDOR)
  })

  // Los de una vez siguen compitiendo por peso, y a igual peso gana el reciente.
  it('entre los de una vez manda el peso, y el más reciente a igual peso', () => {
    expect(visible(tras(suceso('mutacion', GONE), suceso('relectura', RELECTURA)))?.texto).toBe(GONE)
    expect(visible(tras(suceso('apertura', 'abierto'), suceso('relectura', RELECTURA)))?.texto)
      .toBe(RELECTURA)
  })
})
