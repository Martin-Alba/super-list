'use client'

import { useCallback, useEffect, useReducer, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useSinRed } from '@/lib/useSinRed'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { activeItems, addItem, mergeItems, mismoProducto, softDeleteItem, updateItem,
  type FilaAEnviar, type Item } from '@/lib/items'
import { caducados, EN_COLA, ESCRIBE_NOMBRE, esperasDeReintento, GONE, LISTA_EN_VIVO, mensajeDe,
  PENDIENTE, refinarSinRed, refinarSinSesion, RELECTURA, SIN_ALMACEN, SIN_CONEXION_LISTA, SIN_RED,
  SIN_RED_ACCION, type Clase } from '@/lib/errors'
import { avisoInicial, reducirAviso, visible, type Origen } from '@/lib/aviso'
import { decidirEncolar } from '@/lib/cola'
import { alCambiarLaCola, barrerCaducados, encolar, guardarLista, guardarNombre, leerCola, leerLista, quitarDeCola, siguienteEnCola,
  type Pendiente } from '@/lib/local'
import { useGroupChannel } from '@/lib/useGroupChannel'
import { createInviteAction, decideMemberAction, leaveGroupAction } from '@/app/actions'

type Member = { user_id: string; status: string; role: string }
type Profile = { id: string; display_name: string | null }

/**
 * Spec B / iteración 2 · i2-R4 — Los orígenes cuyo aviso **no es un fallo**: lo
 * encolado dice dónde quedó el producto, y el descarte por caducidad es la app
 * informando de su propia regla. Los demás sí perdieron algo, y siguen siendo
 * alertas. Se discrimina por origen y no por `clase`: `'servidor'` la comparten la
 * carga y la edición fallidas, que son errores de verdad.
 */
const ES_ESTADO = new Set<Origen>(['cola', 'apertura'])

export function GroupView({
  group, initialItems, members, profiles, me, loadClase,
}: {
  group: { id: string; name: string }
  initialItems: Item[]
  members: Member[]
  profiles: Profile[]
  me: { id: string; role: string }
  /**
   * AD3 — Aquí había `loadError` (texto) y `loadErrorCode` (para reclasificarlo).
   * Los dos han desaparecido: del servidor llega la clase ya decidida, así que no
   * queda nada que traducir ni que volver a clasificar en el cliente.
   */
  loadClase?: Clase | null
  /** S10 — sin el código, el único error de servidor que se pinta decide por texto. */
}) {
  const router = useRouter()
  /**
   * R1 — Mide **la red de quien usa la app**, no la base: por eso sirve para
   * distinguir «tu red está caída» de «la base no contesta», que son dos fallos
   * distintos con dos salidas distintas para el usuario.
   */
  const sinRed = useSinRed()
  /**
   * N5 — La red **viva**. `onAdd` se cierra sobre el `sinRed` del render en que
   * se pulsó, y entre pulsar y responder es justo cuando la red se cae: el
   * refinado leía un valor caduco y le decía «el servicio está despertando» a
   * quien acababa de quedarse sin conexión.
   */
  const sinRedVivo = useRef(sinRed)
  sinRedVivo.current = sinRed
  const [items, setItems] = useState<Item[]>(initialItems)
  /** R3 — Lo apuntado sin red, aún sin llegar al servidor. */
  const [pendientes, setPendientes] = useState<Pendiente[]>([])
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [invite, setInvite] = useState<string | null>(null)
  // Mientras alguien escribe, su texto manda sobre lo que llegue por el canal;
  // en cuanto suelta el campo, vuelve a mandar el dato del servidor.
  /**
   * S2 — Esto guardaba UN campo por fila, y editar el nombre y después la
   * cantidad de la misma fila perdía la cantidad: al confirmar el nombre se
   * soltaba el borrador entero. Medido en navegador, y es R5 al revés — en el
   * camino feliz, que es peor.
   */
  type Borrador = { nombre?: string; cantidad?: string }
  const [draft, setDraft] = useState<Record<string, Borrador>>({})
  const escrito = (id: string, campo: 'nombre' | 'cantidad') => draft[id]?.[campo]
  const anotar = (id: string, campo: 'nombre' | 'cantidad', value: string) => {
    /**
     * U2 — Retirar la fila ida sólo en su `blur` no basta: si el usuario nunca
     * vuelve a ella, ese `blur` no llega **nunca** y la fila se queda para
     * siempre. Medido en navegador: 2 en pantalla, 1 viva en la base. Irse a
     * otra fila es la señal de que ya no está en ésa.
     */
    for (const ido of idas) if (ido !== id) retirarSiIda(ido)
    setDraft(prev => ({ ...prev, [id]: { ...prev[id], [campo]: value } }))
  }
  /**
   * U9 — Un solo reducer. `valor` opcional: si se pasa, sólo se suelta cuando el
   * borrador sigue siendo ése — si el usuario ha seguido tecleando durante el
   * `await`, tirarlo sería R5 en el camino feliz.
   */
  const soltar = (id: string, campo: 'nombre' | 'cantidad', valor?: string) =>
    setDraft(prev => {
      const fila = prev[id]
      if (!fila || (valor !== undefined && fila[campo] !== valor)) return prev
      const resto: Borrador = { ...fila, [campo]: undefined }
      const siguiente = { ...prev }
      if (resto.nombre === undefined && resto.cantidad === undefined) delete siguiente[id]
      else siguiente[id] = resto
      return siguiente
    })
  const olvidarFila = (id: string) =>
    setDraft(prev => { const n = { ...prev }; delete n[id]; return n })
  // R4 — el aviso lleva su CLASE, no sólo su texto: es lo que decide si además
  // hay que ofrecer volver a entrar. Sin la clase, distinguir "sesión caducada"
  // de "sin acceso" se quedaría en el texto y nadie podría actuar sobre ello.
  /**
   * N5 — El **origen** marca de quién es cada aviso. Identificarlo por su CLASE no
   * valía: `servidor` la comparten este aviso, una edición fallida, un borrado
   * fallido y el «no se ha podido recargar la lista» del resync, y el drenado los
   * borraba todos sin haber recuperado nada de eso.
   */
  const [aviso, despachar] = useReducer(reducirAviso, avisoInicial)
  const notice = visible(aviso)
  /**
   * Spec B / R3.2 y R3.3 — Las dos preguntas que separan un nivel de un evento:
   * qué clase está anunciada ya, y qué clase de carga resolvió la recuperación.
   * Sin la segunda, «resuelta» y «aún no anunciada» son el mismo estado —
   * `loadClase` es una prop del render del servidor y no cambia cuando la lista
   * llega por el reintento—, y el siguiente parpadeo repone el aviso sobre una
   * lista buena. Es I6, y es la tercera vez que esta pieza hace falta.
   */
  const cargaResuelta = useRef<Clase | null>(null)
  // K2 — el botón de borrar no tenía guarda en vuelo: un doble toque lo
  // disparaba dos veces y la segunda pasada, con 0 filas, acusaba a otro
  // usuario del segundo toque del propio.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  /** T1 — filas que otro borró mientras se editaban: se retiran al soltar. */
  const [idas, setIdas] = useState<ReadonlySet<string>>(new Set())

  // J10 — en táctil a 390 px el doble toque es el gesto accidental habitual.
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const isOwner = me.role === 'owner'
  const nameOf = (id: string) => profiles.find(p => p.id === id)?.display_name ?? 'alguien'

  // Cuando el servidor re-renderiza (router.refresh) hay que resincronizar.
  // Se ajusta durante el render, no en un efecto: un setState dentro de un
  // efecto provoca un render en cascada por cada refresco.
  const [syncedFrom, setSyncedFrom] = useState(initialItems)
  if (syncedFrom !== initialItems) {
    setSyncedFrom(initialItems)
    setItems(initialItems)
  }

  // L3 — el fallo de carga es una LINEA BASE, no un valor inicial de estado.
  // Sembrado como estado inicial no se pintaba en el primer render, y en cuanto
  /**
   * Spec B / R3 — **Un solo origen para el aviso visible.** Aquí había una
   * segunda capa: `avisoVisible` era el estado `notice` **o** uno derivado de
   * `loadClase` mientras `resueltaPara` no lo cancelara. De esa doble fuente
   * salió la deuda 40, y con ella `resueltaPara`, que existía sólo para
   * cancelarla. Un solo aviso visible se conserva; lo que se retiró es la idea de
   * que bastaba con fundirlo todo en una puerta. La clase que trae el servidor
   * tiene **su propio disparador**, que sólo pinta; rearmar la recuperación tiene
   * otro; y ninguno de los dos retira por `limpiarAviso`, sino por una retirada
   * selectiva que respeta lo que haya puesto una mutación.
   *
   * Lo que esto arregla de paso, medido: el derivado pintaba `mensajeDe(loadClase)`
   * en crudo, así que a quien estaba sin red se le culpaba al servidor de su
   * propia conexión.
   *
   * Y lo que cuesta, escrito porque tres iteraciones lo pagaron: un derivado se
   * apaga solo cuando su fuente deja de venir, y un estado no. El aviso de carga
   * lleva por eso su origen declarado, y **todo** el que escriba o retire en el
   * hueco declara si es suyo. Ésa es la regla entera, y las retiradas cuentan
   * tanto como las escrituras: dejarlas fuera fue el cuarto fallo de esta misma
   * familia.
   *
   * Límite conocido, del bloque J7, que se perdió al reescribir y vuelve aquí: la
   * **misma** clase llegando otra vez **sin pasar por null** no se distingue de la
   * ya resuelta —la página no manda identidad por carga— y sigue callada. Con
   * `null` en medio sí se distingue, y eso es lo que las dos refs reinician.
   */

  /**
   * R1/R4 — Un único sitio por el que sale todo fallo. `haySesion` no se adivina
   * del error: lo sabe el cliente, y es lo único que separa `42501` "no traes
   * token" de `42501` "tu token no basta para esta fila". Sin esa pregunta, a
   * quien se le caduca la sesión se le dice que ha perdido el acceso al grupo.
   */
  /**
   * Spec B / R1 — **Cada generación sella una sola cosa.** `secuencia` sellaba
   * tres: los avisos, el afinado por sesión —que es la misma conversación con el
   * usuario— y el reintento de **carga**, que no lo es. Un `limpiarAviso()` mataba
   * las tres, y de ahí salió la regresión I1: apuntar algo se llevaba por delante
   * la recuperación en vuelo sin que nada lo dijera.
   *
   * `envio` ya tenía la suya desde el ciclo de la deuda 34. Esto termina la
   * separación que aquél empezó.
   */
  /**
   * Dos generaciones, no una. La recuperación que arma el disparador de carga debe
   * morir cuando cambia lo que la justificaba —se va la red, la carga deja de ser
   * `servidor`—; la que arma una mutación fallida **no**: nada de eso invalida el
   * gesto del usuario. Las respuestas difieren, luego no es un mecanismo, son dos.
   * Compartirlas fue el CRITICAL de la vuelta anterior.
   */
  const recCarga = useRef(0)
  const recMutacion = useRef(0)
  /**
   * Iteración 1 / R1 — Identidades para los avisos que van a afinarse. Esto NO es el
   * sello: el sello es la comparación, y vive dentro del suceso, en el estado. Aquí
   * sólo se generan números que no deciden nada y que por tanto no pueden quedar
   * desfasados. La época que había antes obligaba a quien despacha a saber en qué
   * estado aterrizaría —y con un `limpiarAviso()` antes del `await`, no podía—.
   */
  const tokenAviso = useRef(0)


  /**
   * T6 — La fila cuya cantidad hay que enfocar viaja en una **ref**, no en
   * estado: pedir el foco justo tras `setItems` fallaba porque React aún no
   * había pintado la fila —en la carrera real el perdedor no la tiene hasta ese
   * render—, y guardarlo en estado obliga a un `setState` dentro del efecto, que
   * el propio linter prohíbe por los renders en cascada.
   */
  const pendienteFoco = useRef<string | null>(null)
  useEffect(() => {
    const id = pendienteFoco.current
    if (!id) return
    pendienteFoco.current = null
    document.querySelector<HTMLInputElement>(`[data-cantidad-de="${id}"]`)?.focus()
    // Sin lista de dependencias: la fila puede existir ya —y entonces `items` no
    // cambia— o llegar con la relectura. Lo que importa es que el nodo esté
    // pintado, y eso se sabe después de cualquier render.
  })

  /**
   * AD4 — Recibía el texto crudo y lo traducía aquí. Ahora recibe la **clase**,
   * que `lib/items.ts` ya calculó donde el error nace. Lo que hace esta función
   * sigue siendo lo mismo: pintar ya, y afinar después con la sonda de sesión.
   */
  async function avisar(clase: Clase | null, code: string | null) {
    /**
     * S4 — Primero se pinta con lo que ya se sabe. Antes se preguntaba por la
     * sesión y sólo después se pintaba: con el servicio de auth colgado, medido,
     * el usuario pasaba **30,6 s** sin ver nada. Un aviso que tarda medio minuto
     * es un aviso que no existe.
     */
    if (!clase) return
    /**
     * R1 — `lib/items.ts` no puede leer un hook, así que devuelve `servidor` para
     * todo lo que llega sin código. Aquí, que sí se sabe el estado de la red, se
     * refina: si la red del usuario está caída, el fallo es suyo y no del
     * servidor. Es la misma forma que el afinado por sesión de más abajo.
     */
    /**
     * Spec B / R4 — Con la red **viva**, no con la del render. La rama de la cola
     * ya usaba `sinRedVivo.current` (deuda 43); aquí seguía el valor capturado
     * cuando se creó el manejador, así que en la ventana que la deuda 34 nombró
     * —la red cae entre pulsar y responder— se culpaba al servidor de la red del
     * usuario. Vale para los tres caminos: alta, edición y borrado.
     */
    const real = refinarSinRed(clase, !sinRedVivo.current) ?? clase
    // Origen `mutacion`: es la respuesta al gesto que el usuario acaba de hacer.
    const token = ++tokenAviso.current
    despachar({ tipo: 'avisar', origen: 'mutacion', texto: mensajeDe(real) ?? '', clase: real, token })

    // R2 — el servicio pausado despierta solo, sin que nadie pulse, y el bucle va
    // sellado por su propia generación: limpiar un aviso ya no lo mata.
    if (real === 'servidor') { void reintentar(++recMutacion.current, recMutacion); return }

    // Sólo `42501` cambia de significado según haya sesión o no: es el único
    // código que la base reutiliza para las dos cosas.
    if (code !== '42501') return
    // T7 — El afinado llega tarde por definición, así que se sella: si desde que
    // salió ha pasado cualquier otra cosa —otro aviso, o una escritura correcta
    // que lo limpió—, ya no le toca hablar. Sin el sello, medido, "tu sesión ha
    // caducado" reaparecía hasta 2 s después sobre una escritura que fue bien.
    let reloj: ReturnType<typeof setTimeout> | undefined
    try {
      // D.6 — toda llamada de red con cota. Sin ella, esto es la espera de 30 s.
      const { data } = await Promise.race([
        createClient().auth.getSession(),
        new Promise<never>((_, no) => { reloj = setTimeout(() => no(new Error('sin respuesta')), 2_000) }),
      ])
      if (data.session) return
      // AD1 — el afinado es una regla sobre la clase, no una segunda
      // clasificación: sin sesión, «no tienes acceso» es «se te ha caducado».
      const afinada = refinarSinSesion(real)
      if (afinada) despachar({ tipo: 'afinar', token, texto: mensajeDe(afinada) ?? '', clase: afinada })
    } catch { /* se queda el aviso ya pintado: menos preciso, pero visible */
    } finally { if (reloj) clearTimeout(reloj) }
  }

  /**
   * R2 / D.6 — El plan gratuito pausa el proyecto tras una semana sin uso, que es
   * justo la frecuencia con que se abre una lista de la compra. Despierta solo en
   * unos segundos, así que la app espera por el usuario en vez de pedirle que
   * recargue. Las esperas viven en el traductor porque son la cota que D.6 exige,
   * y una cota dentro de un componente no la puede afirmar nadie.
   *
   * Spec B / R1 — Se sella con **su** generación, `recuperacion`. Antes compartía
   * la de los avisos, así que `limpiarAviso()` —que corre al principio de cada
   * alta— lo mataba a mitad.
   */
  const reintentar = async (mio: number, gen: { current: number }) => {
    for (const espera of esperasDeReintento()) {
      await new Promise(r => setTimeout(r, espera))
      if (mio !== gen.current) return
      const r = await activeItems(createClient(), group.id)
      if (mio !== gen.current) return
      if (!r.clase) {
        // R3.3 — Y se apunta qué clase de carga quedó resuelta: la prop no se
        // entera de que la lista llegó, así que sin esto el siguiente cambio de
        // red vuelve a anunciar lo que ya no pasa.
        cargaResuelta.current = loadClase ?? null
        setItems(prev => mergeItems(r.data, prev))
        /**
         * R4.1 — Retira **lo suyo**, no lo que haya. `limpiarAviso()` se llevaba
         * por delante el aviso de la mutación que el usuario acababa de provocar
         * —medido con «Alguien lo quitó de la lista» y con «Tu sesión ha
         * caducado» y su enlace—.
         *
         * Y **no sella**, al contrario que `limpiarAviso`. El sello existe para
         * que un afinado por sesión en vuelo no reaparezca sobre un hueco que
         * alguien vació, y un afinado en vuelo implica un aviso que NO es
         * de origen `carga` — exactamente el que esta retirada no toca. Se puso por
         * simetría; la pasada de mutación del ítem 7 lo midió inerte con los
         * 1.488 tests en verde, y se quita en vez de inventarle una prueba.
         */
        despachar({ tipo: 'retirar', origen: 'carga' })
        return
      }
    }
  }
  /**
   * R3.1 — En ref viva por el mismo motivo que `avisar`: es un arrow recreado en
   * cada render, y listarlo como dependencia relanzaría el bucle sin parar. Va
   * aquí y no arriba porque antes de esta línea el `const` está en zona muerta.
   */
  const reintentarVivo = useRef(reintentar)
  reintentarVivo.current = reintentar

  /**
   * N3 — Una sola puerta a la cola. Las dos ramas —sin red al pulsar, y fallo en
   * vuelo— tenían el mismo bloque escrito dos veces, y ya habían divergido: sin
   * red un duplicado no se encolaba, y con el servidor caído sí, con ficha doble.
   * N4 — Y pone su propio aviso: dejarlo fuera obligaba a repetir el mapeo
   * fallo→aviso en las dos ramas, escrito en distinto orden, que es justo la
   * deriva que unificar la puerta venía a matar.
   */
  /**
   * Spec E — **La puerta a la cola desde esta vista.** Lee por `leerCola`, que filtra, y
   * barre con `barrerCaducados` **sólo porque esta rama habla**: el `onAdd` sin red
   * anuncia el descarte después de `limpiarAviso()`. Los lectores que no anuncian
   * —`drenarUnaVez`, `reintentarEnvio`— sólo filtran, y por eso ya no pueden quedarse
   * con una cuenta que nadie va a decir.
   */

  /**
   * Spec F / R2bis — Toma **la fila**, no un nombre y una cantidad. La clave de la fila se
   * acuña una sola vez por gesto de alta y la comparten el envío inmediato y la entrada de la
   * cola. Lo destapó la fila F6: antes, el alta acuñaba un uuid para su envío y esta función
   * acuñaba **otro** para la cola, así que cuando el envío llegaba al servidor y su respuesta
   * no volvía —el caso que F existe para cerrar—, el reenvío llevaba una clave distinta de la
   * que el servidor había guardado, y la base no podía reconocerlo: fila nueva. La spec decía
   * «el alta directa no tiene nada que deduplicar», y era falso.
   */
  const meterEnCola = async (
    fila: FilaAEnviar, desde: number,
  ): Promise<{ ok: boolean; descartadas: number }> => {
    const { nombre, cantidad } = fila
    /**
     * Spec B / iteración 3 · i3-R1 — **Lo caducado se quita antes de decidir.**
     *
     * Éste era el tercer sitio que leía la cola cruda, y el único que quedaba.
     * Medido a mano: con una entrada de 25 h del mismo producto, apuntarlo daba «Ese
     * producto ya está en la lista» sobre algo que ninguna pantalla enseña — y el
     * rechazo no escribe en la cola, así que no dispara relectura y el intento
     * siguiente da lo mismo. Sin salida salvo recargar.
     *
     * Se **quita**, no sólo se filtra: filtrando, el almacén la seguiría viendo en
     * `encolar` y devolvería `'ya-estaba'` sobre lo que `decidirEncolar` acababa de
     * aprobar. La regla de `lib/cola.ts` no se toca: sigue siendo pura y sigue
     * decidiendo sobre la lista que se le da.
     */
    /**
     * Spec E / i1-R1 — Barre **y** lee. Esta rama es una superficie que puede hablar
     * —el `onAdd` sin red anuncia el descarte después de `limpiarAviso()`, que es lo
     * que la Spec B / i4-R1 fijó—, así que le toca el barrido. Los lectores que no
     * hablan sólo filtran, y por eso ya no pueden quedarse con la cuenta.
     */
    const { vivos: cola, descartadas } = await barrerCaducados(me.id)
    // Y si barrió, se cura la pantalla: `pendientes` es estado de esta instancia y el
    // almacén no lo conoce. Se re-deriva de lo que acaba de leer, que es lo vivo.
    if (descartadas) setPendientes(cola.filter(x => x.grupo === group.id))
    /**
     * Spec C / R3 — La **regla** vive en `lib/cola.ts` porque la cáscara sin red
     * tiene que decidir lo mismo. Lo que se queda aquí son los efectos: devolver
     * el texto, avisar y pintar la ficha. `avisar` es el mecanismo de la Spec B y
     * no sale de este componente.
     */
    const decision = decidirEncolar({
      usuario: me.id, grupo: group.id, nombre, cantidad,
      visibles: items, cola, id: fila.id, ahora: Date.now(),
    })
    /**
     * R4 — Un solo sitio para el duplicado, las dos veces que se detecta: la que
     * `decidirEncolar` ve y la que sólo ve el almacén. El docstring de esta función
     * existe porque este bloque **ya estuvo escrito dos veces y ya divergió** — «sin
     * red un duplicado no se encolaba, y con el servidor caído sí, con ficha doble»—,
     * y la vuelta anterior lo reintrodujo dentro de la propia función que lo
     * documenta. Con un solo sitio la igualdad es estructural y no hay nada que
     * comprobar a mano.
     */
    const esDuplicado = () => {
      devolver(nombre, cantidad, desde); void avisar('duplicado', '23505')
      return { ok: false, descartadas }
    }
    if (decision.accion === 'duplicado') return esDuplicado()
    const p: Pendiente = decision.pendiente
    /**
     * J6 — si el almacén no admite la escritura no se pinta ficha: el usuario vería
     * su producto, recargaría, y no estaría.
     *
     * R2 — Y se distingue de «ya estaba». El almacén es la red para lo que
     * `decidirEncolar` no pudo ver —lo que otra instancia escribió entre la lectura y
     * la escritura—, así que cuando dice `ya-estaba` el mensaje es el del duplicado,
     * no el del disco lleno. Decir «no se pudo guardar» cuando el producto está
     * guardado es una pantalla mintiendo sobre la causa.
     */
    const puesto = await encolar(p)
    if (puesto === 'rechazado') {
      devolver(nombre, cantidad, desde); avisarTexto(SIN_ALMACEN, 'generico', 'mutacion')
      return { ok: false, descartadas }
    }
    if (puesto === 'ya-estaba') return esDuplicado()
    setPendientes(prev => [...prev, p])
    return { ok: true, descartadas }
  }

  /**
   * N2/N3 — El gemelo de `reintentar` para el envío. `reintentar` recupera una
   * **carga** fallida; éste empuja una **cola** que nadie va a drenar, porque el
   * único disparador del drenado es el cambio de `sinRed` o el montaje.
   *
   * N3 — Y lleva su propia generación, no la de los avisos. Sellarlo con
   * `secuencia` lo mataba dos veces: `limpiarAviso()` corre al principio de cada
   * alta, así que la segunda cosa que apuntabas dejaba varada la primera; y el
   * incremento mataba también el `reintentar` que `avisar` acababa de lanzar, con
   * lo que el producto aparecía en la lista mientras la alerta seguía diciendo
   * que el servidor no contesta.
   */
  const envio = useRef(0)
  const reintentarEnvio = async (mio: number) => {
    for (const espera of esperasDeReintento()) {
      await new Promise(r => setTimeout(r, espera))
      if (mio !== envio.current) return
      await drenar()
      if (mio !== envio.current) return
      // Spec E / R4 — Por la puerta: preguntaba sobre la cola cruda, así que el bucle
      // podía seguir girando sobre entradas que nunca se enviarán.
      if (!(await leerCola(me.id)).some(p => p.grupo === group.id)) return
    }
  }
  // N3 — Y no sobrevive al desmontaje: el bucle dura hasta 23 s, y remontar
  // dentro de esa ventana dejaba dos drenados sobre una sola cola, que es el
  // solape que el cerrojo de R4 existe para impedir (D.2).
  useEffect(() => () => { envio.current++ }, [])

  /**
   * R4 — Drena la cola: el más antiguo primero y **uno cada vez**. Dos envíos
   * simultáneos sobre el mismo grupo son la carrera que D.2 prohíbe resolver en
   * memoria del proceso.
   *
   * La idempotencia no la pone este bucle: la pone la base. Y **por la clave
   * primaria**, no por el índice de nombre: `items_nombre_unico` es parcial
   * —`WHERE deleted_at IS NULL`—, así que en cuanto alguien tacha el producto un
   * reenvío ya no choca por nombre, **inserta**, y lo que el usuario quitó vuelve.
   * La versión anterior de este comentario afirmaba lo contrario, y además daba
   * por peor la idea de deduplicar con una clave propia. Las dos afirmaciones
   * eran falsas, y eran las que harían revertir la Spec F a quien las leyera de
   * buena fe. No hay nada que inventar aquí: la fila ya trae su uuid y viaja
   * dentro de `addItem`, así que el reenvío choca contra `items_origen_unico`
   * —`(group_id, origen_id)`, no parcial—, también con el producto tachado.
   */
  const drenarUnaVez = useCallback(async () => {
    // N4 — La generación se mira en CADA vuelta: desmontar con un envío en vuelo
    // dejaba el bucle vaciando la cola entera sobre un árbol muerto.
    const mio = envio.current
    let envioHecho = false
    // Un solo reloj por pasada: `siguienteEnCola` decide con la misma regla que el
    // descarte de apertura, así que lo caducado no se envía aunque siga en disco.
    const ahora = Date.now()
    let cola = await leerCola(me.id)
    for (;;) {
      if (mio !== envio.current) return
      const p = siguienteEnCola(cola, group.id, ahora)
      /**
       * N4 — Quien **vacía** la cola retira el aviso, no quien la encuentra
       * vacía: el drenado corre también al montar y en cada cambio de red, y
       * limpiar ahí se llevaba por delante el aviso de una edición fallida.
       * Medido: tres pruebas de `unit/avisos.test.tsx` en rojo.
       */
      if (!p) {
        if (envioHecho) {
          /**
           * N6 — Y se RELEE la lista. Marcarla resuelta sin leerla era fallar
           * abierto: el envío llegaba, el aviso se iba, y el usuario se quedaba
           * mirando la instantánea vieja de IndexedDB creyéndola fresca.
           *
           * Una relectura, no el bucle de cinco que R13 quitó: aquí el servidor
           * acaba de contestar, así que no hay nada que reintentar. Y si aun así
           * falla, el aviso **se queda**: dar por resuelto lo que no se pudo leer
           * es exactamente lo que A.3 prohíbe.
           */
          const relectura = await activeItems(createClient(), group.id)
          if (mio !== envio.current) return
          /**
           * Spec B / R5 — Aquí se decide **después de saber**, y son dos hechos
           * distintos, no uno:
           *
           * - La cola se vació: su aviso ya no es verdad y se retira
           *   pase lo que pase. Decirle a alguien que su producto «se enviará al
           *   volver la red» cuando ya está en la lista es mentir (DoD 17).
           * - La relectura falló: la lista puede estar rancia, y eso **sí** hay
           *   que decirlo. Antes se limpiaba antes de releer y con `loadClase`
           *   nulo no quedaba ninguna señal: la deuda 40, y lo que la 45 pedía
           *   probar con el gemelo de `loadClase` nulo.
           */
          // La cola se vació y su aviso ya no es verdad (Spec B / R5). Vive en las
          // dos ramas y no antes del `if (envioHecho)`: retirar sin haber enviado
          // deriva de la copia de la cola leída antes de los `await`, y eso es lo
          // que la spec de «pantalla y estado durable» se lleva a su alcance.
          despachar({ tipo: 'retirar', origen: 'cola' })
          if (relectura.clase) {
            // Si falló, el aviso de la relectura toma el relevo: sobrescribe al de
            // la cola, así que retirarlo antes era una línea que nadie podía
            // observar — lo midió la pasada de mutación de la iteración 2.
            /**
             * R4.2 — El mismo texto que su gemelo de la resincronización usa
             * para este hecho. `avisar` pintaría `SERVIDOR` —«lo reintentamos
             * solo»— y desde que este camino dejó de rearmar, nadie lo
             * reintenta: el mensaje mentía. Se pierde aquí el afinado por sesión
             * del 42501, y se acepta: el gemelo ya lo acepta, y dos caminos
             * diciendo cosas distintas del mismo fallo es peor.
             */
            avisarTexto(RELECTURA, relectura.clase, 'relectura')
            return
          }
          setItems(prev => mergeItems(relectura.data, prev))
        }
        return
      }
      const r = await addItem(createClient(), group.id, me.id, p)
      // Cualquier otro fallo deja la cola como está: se reintentará. Parar en el
      // primero conserva el orden, que es lo que el usuario apuntó.
      if (r.clase && r.code !== '23505') return
      envioHecho = true
      /**
       * Spec B / iteración 2 · i2-R1 — **Aquí NO se mira la generación**, y está
       * escrito para que nadie lo vuelva a añadir.
       *
       * La iteración 1 lo añadió razonando que el reenvío devolvería `23505`. Es
       * falso: `items_nombre_unico` es **parcial** —`WHERE deleted_at IS NULL`,
       * verificado en el catálogo y afirmado desde antes en
       * `unit/duplicados.test.ts:19`, que además explica por qué tiene que serlo—,
       * así que en cuanto alguien tacha el producto el reenvío **crea fila nueva**.
       * Un desmontaje a mitad de envío resucitaba lo que alguien había quitado.
       *
       * Los dos chequeos que sí se quedan —al empezar la vuelta y tras la
       * relectura— impiden que un drenado de un árbol muerto **siga drenando**, que
       * es lo que la cicatriz N3 protege. Rematar una vuelta cuyo envío el servidor
       * ya aceptó no es eso: `quitarDeCola` va por `id` y es idempotente.
       */
      await quitarDeCola(p.id)
      cola = cola.filter(x => x.id !== p.id)
      setPendientes(prev => prev.filter(x => x.id !== p.id))
      if (r.data) setItems(prev => mergeItems([r.data as Item], prev))
    }
    /**
     * N6 dejó aquí `loadClase` porque el drenado marcaba la carga resuelta con
     * él, y capturado al montar resolvía con un valor caduco. Spec B / R3 se
     * llevó esa marca —`resueltaPara` ya no existe—, así que el drenado no lee la
     * prop en absoluto y la dependencia sobraba. El linter lo dijo en cuanto pasó.
     */
  }, [group.id, me.id])

  const drenando = useRef(false)
  const pedido = useRef(false)
  /**
   * I7/J3 — El cerrojo evita el **solape**, no el trabajo. `sinRed` parpadea por
   * diseño, y dos drenados a la vez invierten el orden que R4 promete; pero la
   * primera versión descartaba el segundo en silencio, y como el bucle trabaja
   * sobre la cola leída al principio, lo apuntado durante un envío en vuelo no se
   * mandaba nunca — se quedaba hasta el siguiente cambio de red, y a las 24 h se
   * descartaba con aviso. Se cambió un defecto por otro.
   *
   * Ahora el que llega tarde deja constancia, y quien tiene el cerrojo vuelve a
   * mirar la cola antes de soltarlo.
   */
  /**
   * R6 / iteración 1 de la duración — **Un nivel lo retira su condición, no el flujo
   * de control de quien la cambió.** El aviso de la cola es un nivel: es cierto
   * mientras queden pendientes de este grupo. Cuando dejan de quedar, deja de ser
   * cierto, se haya vaciado la cola por el drenado de esta instancia, por el de otra
   * pestaña —la cola vive en IndexedDB y la comparten todas (§D.3)— o por el
   * descarte de caducados.
   *
   * Esto **deroga N4** —«quien vacía la cola retira el aviso, no quien la encuentra
   * vacía»—, que existía porque limpiar al encontrarla vacía barría el aviso de una
   * edición fallida. Con origen declarado no puede barrer nada ajeno: `retirar cola`
   * sólo toca la casilla de la cola.
   *
   * Medido antes de escribirlo, ejecutando el camino y no enumerándolo: con dos
   * vistas montadas sobre la misma cola, la que no drenó se quedaba con «el servicio
   * está despertando, lo reintentamos solo» para siempre, sobre una cola vacía y con
   * el producto ya en la lista.
   *
   * Y la condición se lee **donde se observa la cola compartida**, no en el estado
   * local: `pendientes` es de esta instancia y no se entera de lo que hace otra.
   */
  /**
   * Spec «pantalla y estado durable» / R3 y R4 — **Releer cuando la cola cambió.**
   *
   * La cola vive en IndexedDB y la comparten todas las pestañas; IndexedDB no emite
   * eventos, así que el almacén avisa por un canal. Lo que llega es una señal de
   * «mira otra vez», **nunca un dato**: se relee y se re-deriva, porque aplicar el
   * contenido sería confiar en la copia de otro.
   *
   * Y la señal sobrevive a no haberla oído: al volver la visibilidad se relee igual,
   * por si el mensaje se perdió o lo escribió un contexto sin canal.
   *
   * Lo que se deriva es **todo lo que la cola sostiene**: las fichas y el aviso. Que
   * el aviso sea un nivel es lo que permite retirarlo sin tocar nada más — lo cerró
   * la spec de la duración y aquí se usa, no se modifica.
   */
  const releerLaCola = useCallback(async () => {
    /**
     * Spec B / iteraciones 1, 2 y 4 — Por la función única: descarta lo que la regla
     * condena y devuelve lo vivo. Aquí **sí** se anuncia, porque esta relectura no la
     * provoca un gesto que esté esperando su propia respuesta: no compite con nadie.
     *
     * `quitarDeCola` vuelve a emitir y esto se ejecuta otra vez: la segunda vuelta ya
     * no encuentra caducadas, no anuncia nada, y para.
     */
    const { vivos, descartadas } = await barrerCaducados(me.id)
    const mios = vivos.filter(x => x.grupo === group.id)
    setPendientes(mios)
    if (descartadas) despachar({ tipo: 'avisar', origen: 'apertura', texto: caducados(descartadas), clase: 'texto' })
    if (mios.length === 0) despachar({ tipo: 'retirar', origen: 'cola' })
  }, [me.id, group.id])

  const drenar = useCallback(async () => {
    if (drenando.current) { pedido.current = true; return }
    drenando.current = true
    try {
      do {
        pedido.current = false
        await drenarUnaVez()
      } while (pedido.current)
    } finally { drenando.current = false }
  }, [drenarUnaVez])

  /**
   * Spec B / R1 — **La cola que cambia también drena, no sólo se relee.**
   *
   * Hasta aquí, una fila que entraba por el camino de fallo con red tenía dos
   * disparadores: el bucle acotado de `reintentarEnvio` —`esperasDeReintento()`
   * suma 23 s— y el próximo montaje. Medido el 2026-09-18 contra el build de
   * producción: agotado el bucle, con la API ya contestando, el canal vivo y un
   * alta nueva viajando por esa misma conexión, la cola se quedó **seis minutos**
   * en disco.
   *
   * Vale también para lo que escribe esta pestaña: `BroadcastChannel` entrega a
   * cualquier otro objeto del mismo canal, incluido uno de este documento, y
   * `alCambiarLaCola` crea el suyo (comprobado en el navegador). La vuelta que
   * produce vaciar la cola encuentra la cola vacía y para.
   *
   * `sinRedVivo` y no `sinRed`: el valor del render en que se suscribió estaría
   * caducado cuando llegue la señal, que es la cicatriz N5 de este fichero.
   */
  useEffect(() => {
    const dejarDeOir = alCambiarLaCola(() => {
      void releerLaCola()
      if (!sinRedVivo.current) void drenar()
    })
    const alVolver = () => { if (document.visibilityState === 'visible') void releerLaCola() }
    document.addEventListener('visibilitychange', alVolver)
    return () => { dejarDeOir(); document.removeEventListener('visibilitychange', alVolver) }
  }, [releerLaCola, drenar])


  /**
   * K2/L4 — Devuelve al campo el alta que no llegó a entrar, **sólo si nadie ha
   * tecleado desde que salió**.
   *
   * El campo se vacía antes del `await` para que apuntar dos cosas seguidas no
   * obligue a esperar —es el gesto normal en un pasillo—, así que entre el vaciado
   * y la vuelta hay tiempo de sobra para escribir otra cosa. La primera versión
   * pisaba lo tecleado (I4: de seis altas seguidas entraban tres). La segunda miró
   * cada campo por su cuenta y cruzó dos productos: se pedía «pan» y salía
   * «pan, 2». Nombre y cantidad son **un** alta, así que la pregunta es una sola,
   * y se hace sobre el gesto —¿ha tecleado alguien?— y no sobre el contenido.
   */
  const tecleado = useRef(0)
  const devolver = (nombre: string, cantidad: string | null, desde: number) => {
    if (tecleado.current !== desde) return
    setName(nombre); setQuantity(cantidad ?? '')
  }

  const avisarTexto = (texto: string, clase: Clase, origen: Origen) => {
    despachar({ tipo: 'avisar', origen, texto, clase })
  }
  /**
   * U3 — Cuatro de los cinco sitios que limpiaban el aviso no sellaban, así que
   * el afinado en vuelo reaparecía encima: 42501 → alta correcta → "tu sesión ha
   * caducado" otra vez. Reproducido determinista. Limpiar es una operación, no un
   * `setNotice(null)` suelto.
   */
  const limpiarAviso = () => despachar({ tipo: 'limpiar' })

  /**
   * R5/R6 — Al abrir: se descarta lo que lleva más de un día en la cola y se dice
   * cuánto, y si no hay red se pinta la última lista conocida. La instantánea sólo
   * se lee cuando hace falta: con red manda el servidor, siempre.
   */
  useEffect(() => {
    void (async () => {
      // I3/K7 — quién está dentro lo registra `RecordarUsuario`, que corre en
      // **toda** página desde el layout: un segundo usuario del mismo dispositivo
      // entra por la portada o por una invitación, no por aquí. Por eso este
      // efecto no comprueba el cambio de usuario: cuando llega, ya está hecho.
      const { vivos, descartadas } = await barrerCaducados(me.id)
      setPendientes(vivos.filter(x => x.grupo === group.id))
      if (descartadas) avisarTexto(caducados(descartadas), 'texto', 'apertura')
      const guardada = await leerLista(me.id, group.id)
      if (guardada?.length) setItems(prev => (prev.length ? prev : guardada))
    })()
    // Sólo al montar: lo que pase después lo llevan los otros dos efectos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * R6 — La instantánea guarda lo que **el servidor** dijo, así que sólo se
   * escribe con red. Si se escribiera sin ella, un arranque en frío con la lista
   * aún vacía la borraría justo cuando hace falta.
   */
  /**
   * I5 — Sólo cuando el servidor **contestó**. Medido en la revisión: con la base
   * pausada, `loadGroupPayload` devuelve la lista vacía junto a su clase de error,
   * y guardar eso borraba la instantánea justo en el escenario para el que existe.
   */
  useEffect(() => {
    if (sinRed || loadClase) return
    void guardarLista(me.id, group.id, items)
  }, [items, sinRed, loadClase, group.id, me.id])

  /**
   * Spec C / R5 — El nombre va a la instantánea por la misma puerta y con el
   * mismo gate que la lista, pero en **su propio efecto**: colgado del de la
   * lista reescribía la misma cadena en disco con cada cambio de un ítem, que en
   * una compra son decenas de transacciones que no cambian nada. Clave propia,
   * dentro del prefijo del usuario, para que `olvidarTodo` se la lleve (A.1).
   */
  useEffect(() => {
    if (sinRed || loadClase) return
    void guardarNombre(me.id, group.id, group.name)
  }, [sinRed, loadClase, group.id, group.name, me.id])

  /**
   * Spec B / R3.1 — **Rearmar.** Un disparador propio, y no escribe avisos.
   *
   * I6 lo nombró: el primer acceso tras la pausa decía «lo reintentamos solo» y
   * no lo reintentaba nadie. Tiene que volver a dispararse cuando vuelve la red,
   * y por eso `sinRed` está en las dependencias.
   *
   * Estuvo fundido con el anuncio y ésa fue la regresión: los dos consumidores
   * piden lo contrario de la misma dependencia —rearmar sí debe redispararse al
   * volver la red, anunciar no—, así que ninguna lista de dependencias los
   * satisface a los dos y cada vuelta elegía cuál sacrificar.
   *
   * `reintentar` viaja en ref viva para no declararlo dependencia: es un arrow
   * que se recrea en cada render, y listarlo relanzaría el bucle sin parar.
   */
  useEffect(() => {
    // R4.3 — Y mira la memoria: una carga ya resuelta no se rearma. Sin esto,
    // medido, cada parpadeo sondeaba otra vez durante toda la vida de la pestaña.
    if (loadClase !== 'servidor' || sinRed || cargaResuelta.current === loadClase) return
    void reintentarVivo.current(++recCarga.current, recCarga)
  }, [loadClase, sinRed])

  /**
   * R4.3 — Y el bucle que deja en vuelo no sobrevive a que cambien las condiciones
   * que lo justificaban: irse la red, dejar de ser `servidor` la carga, o
   * desmontar. Medido: seguía sondeando a un servidor inalcanzable hasta agotar
   * sus cinco esperas.
   *
   * Va en su propio efecto, sin cuerpo, por la misma forma que usan las dos
   * invalidaciones de más arriba: leer `recCarga.current` dentro de la
   * limpieza del efecto que también lo incrementa hace saltar
   * `react-hooks/exhaustive-deps`, y la puerta del linter no admite avisos.
   * Sustituye a la invalidación sólo-al-desmontar que puso la iteración 2: estas
   * dependencias incluyen el desmontaje.
   */
  useEffect(() => () => { recCarga.current++ }, [loadClase, sinRed])
  /** Y la que arma una mutación muere sólo al desmontar: nada más la invalida. */
  useEffect(() => () => { recMutacion.current++ }, [])

  /**
   * Spec B / R3.2 y R3.3 — **Anunciar.** El otro disparador. Escribe sólo cuando
   * cambia lo que se anunciaría, y calla para una carga ya resuelta.
   *
   * **Una** puerta, y cierra un fallo medido: *resuelta* — la recuperación trajo
   * la lista y `loadClase` sigue diciendo lo contrario, porque es una prop del
   * render del servidor. Aquí hubo otras dos y las dos se fueron al separar la
   * duración del peso: comparar la clase con la anterior dejó de hacer falta
   * cuando reescribir el mismo nivel pasó a ser inobservable, y la prioridad la
   * decide el reducer, no este sitio.
   *
   * Y **sí restaura**: el aviso de carga es un nivel, así que una mutación lo tapa
   * sin destruirlo y vuelve a verse en cuanto lo de encima se limpia, si sigue
   * siendo cierto. Aquí decía lo contrario —«no restaura»— desde antes de que el
   * eje de la duración existiera; hoy hay test que exige justo lo que negaba.
   */
  useEffect(() => {
    if (!loadClase) {
      cargaResuelta.current = null
      /**
       * La carga dejó de fallar: se retira su aviso, y sólo el suyo. Va diferido
       * por el mismo motivo que el drenado —poner estado en el cuerpo de un
       * efecto encadena renders, y el linter lo dice—; aquí además no corre
       * prisa, porque la clase ya se resolvió.
       */
      void (async () => {
        await Promise.resolve()
        despachar({ tipo: 'retirar', origen: 'carga' })
      })()
      return
    }
    if (cargaResuelta.current === loadClase) return
    const refinada = refinarSinRed(loadClase, !sinRed) ?? loadClase
    /**
     * R4.4 — La prioridad se decide **dentro** del actualizador, que es donde el
     * estado que protege está vivo. Antes se leía de una ref escrita en el cuerpo
     * del render, y este componente usa `useTransition`: un render descartado la
     * dejaba apuntando a un estado nunca confirmado.
     *
     * Sin sello: cuando esto aterriza, el hueco estaba vacío o tenía un aviso de
     * carga, y todo camino que vacía el hueco teniendo un afinado en vuelo ya
     * incrementa el sello. Estaba, se midió inerte, y se quita en vez de
     * inventarle una prueba.
     *
     * Síncrono a propósito, al contrario que la retirada: hay pruebas de la verja
     * que leen el aviso en el mismo tick del montaje.
     */
    despachar({ tipo: 'avisar', origen: 'carga', texto: mensajeDe(refinada) ?? '', clase: refinada })
  }, [loadClase, sinRed])

  /**
   * R4 — Al volver la red se drena. También al montar, por lo que quedó de ayer.
   *
   * Va dentro de una función asíncrona a propósito: llamar a `drenar()` en el
   * cuerpo del efecto pone estado de forma síncrona y encadena renders — lo dice
   * el linter, y tiene razón.
   */
  useEffect(() => {
    if (sinRed) return
    void (async () => { await drenar() })()
  }, [sinRed, drenar])

  // R9 — el borrado viaja como UPDATE (deleted_at), por eso va autorizado por
  // RLS. Un DELETE físico no lo estaría: los eventos DELETE están exentos.
  const [eventosPeligrosos, setEventosPeligrosos] = useState(0)

  const channelState = useGroupChannel(group.id, {
    onItem: (row) => {
      /**
       * R6 — Una fila que desaparece MIENTRAS la editas se llevaba lo tecleado
       * sin decir nada: el componente se desmontaba y `confirmar` no llegaba a
       * ejecutarse, así que el mensaje de "alguien lo quitó" —que existe— no se
       * disparaba nunca por este camino. Ahora la fila se queda hasta que el
       * usuario suelta el campo, y se le dice qué ha pasado.
       */
      if (row.deleted_at && draft[row.id]) {
        // T1 — Se MARCA. Retirarla sólo desde la rama de "0 filas afectadas"
        // dejaba dos salidas sin cubrir: soltar sin cambiar nada, y vaciar el
        // nombre. Medido: la fila se quedaba en pantalla con texto que no está
        // guardado en ninguna parte.
        setIdas(prev => new Set(prev).add(row.id))
        avisarTexto(GONE, 'generico', 'mutacion')
        return
      }
      setItems(prev => {
        const rest = prev.filter(i => i.id !== row.id)
        return row.deleted_at ? rest : [...rest, row].sort((a, b) => a.created_at.localeCompare(b.created_at))
      })
    },
    // R7 — el cambio de estado de la propia fila es lo que entrega la expulsión
    // al expulsado, filtrado por RLS. Cuando la fila que cambia es la mía y ya
    // no soy `active`, se vacía la vista y se sale: A.3 manda fallar cerrado, y
    // dejarlo en manos de que un refresco produzca un 404 es más frágil que
    // actuar sobre el dato que acaba de llegar.
    onMembership: (row) => {
      if (row.user_id !== me.id) { router.refresh(); return }
      // V2 — Costura de medición, no comportamiento. `e2e/stale-events.spec.ts`
      // esperaba 6 s a ciegas y daba verde contra el defecto sólo 2 de 4 veces:
      // cuando el slot ya se había drenado, afirmaba sobre una página a la que
      // no había llegado nada.
      //
      // Cuenta sólo los eventos PELIGROSOS —los que dicen que ya no soy
      // `active`—, porque son los únicos que pueden expulsar. Contar también los
      // `active` dejaba la precondición demasiado floja: la cumplía el evento
      // inofensivo, y el test seguía dando verde 2 de 4 con U1 revertido.
      if (row.status !== 'active') setEventosPeligrosos(n => n + 1)
      // U1 — el canal entrega, tras `SUBSCRIBED`, los cambios anteriores que
      // siguen en el slot de replicación. Actuar sobre el PRIMER evento expulsa
      // a un miembro activo con su propio `pending` viejo: medido 6 de 6. Esta
      // propiedad ya estaba escrita en `unit/expel-event.test.ts` —"mirar el
      // ÚLTIMO estado, no el primero"—, sólo que el producto no la aplicaba.
      // Por eso se confirma contra la fuente antes de vaciar y navegar.
      if (row.status === 'active') { router.refresh(); return }
      void createClient()
        .from('group_members').select('status')
        .eq('group_id', group.id).eq('user_id', me.id).maybeSingle()
        .then(({ data }) => {
          if (data?.status === 'active') { router.refresh(); return }
          setItems([])
          router.replace('/')
        })
    },
    // I7 — lo ocurrido entre el render del servidor y la suscripción no llegó
    // por el canal a nadie; se relee al quedar suscrito.
    onResync: () => {
      // AE1 — `activeItems` ya no lanza, así que aquí no hay ningún objeto de
      // error que recoger: llega su clase, como en cualquier otra mutación.
      void activeItems(createClient(), group.id).then(r => {
        if (r.clase) { avisarTexto(RELECTURA, r.clase, 'relectura'); return }
        // `prev` ya incluye los eventos llegados durante la petición: sustituir
        // la lista los borraría hasta el siguiente evento (J6, D.2).
        setItems(prev => mergeItems(r.data, prev))
      })
    },
  })

  /**
   * Spec B / R1 — **El servicio que vuelve también drena.**
   *
   * El canal quedando suscrito es el servidor contestando: **evidencia**, no un
   * reloj. Es la distinción que la Spec D lleva tres vueltas pagando, y aquí sale
   * gratis porque el estado ya está calculado.
   *
   * Cuelga de la **transición**, no del nivel: del nivel se dispararía en cada
   * render con el canal vivo, y del cambio a secas se dispararía también al
   * degradarse, que es exactamente cuando no hay a quién mandar nada.
   *
   * Lo que este disparador promete es **un intento por vuelta del canal**, no una
   * cola siempre vacía: un servicio que acepta la suscripción y rechaza la
   * escritura consume el disparo sin vaciar nada, y espera al siguiente cambio de
   * cola. Alargar el bucle de reintento cerraría ese resto y está fuera de alcance.
   */
  const canalPrevio = useRef(channelState)
  useEffect(() => {
    const antes = canalPrevio.current
    canalPrevio.current = channelState
    if (channelState !== 'live' || antes === 'live' || sinRedVivo.current) return
    void drenar()
  }, [channelState, drenar])

  /**
   * R5 — El borrador ya no se suelta ANTES de saber si la escritura fue bien.
   * Se soltaba, y entonces el campo volvía al valor del servidor mientras el
   * aviso decía "inténtalo otra vez": no quedaba nada que reintentar, porque lo
   * tecleado se había perdido. Ahora sólo se suelta cuando ha ido bien.
   */
  /** T1 — sea cual sea la salida, una fila que ya no existe se retira. */
  function retirarSiIda(id: string): boolean {
    if (!idas.has(id)) return false
    setItems(prev => prev.filter(i => i.id !== id))
    olvidarFila(id)
    setIdas(prev => { const n = new Set(prev); n.delete(id); return n })
    return true
  }

  async function confirmar(item: Item, campo: 'nombre' | 'cantidad') {
    // U2 — Esto salía por `valor === undefined` ANTES de comprobar si la fila ya
    // no existe, así que soltar un campo sin borrador la dejaba en pantalla para
    // siempre. Medido 3/3 en navegador: dos filas visibles, una viva en la base.
    if (retirarSiIda(item.id)) return
    const valor = escrito(item.id, campo)
    if (valor === undefined) return
    const limpio = valor.trim()
    const actual = campo === 'nombre' ? item.name : (item.quantity ?? '')
    if (campo === 'nombre' && !limpio) { soltar(item.id, campo); return }
    if (limpio === actual) { soltar(item.id, campo); return }

    /**
     * R7 — Alcance declarado: sin red se apunta, no se corrige. Son las dos
     * operaciones que abren conflicto entre dos personas a ciegas.
     *
     * **El borrador se queda.** La primera versión soltaba el campo aquí y R5 se
     * puso rojo con razón: «un guardado fallido no se lleva lo escrito» sigue en
     * vigor, y quedarse sin red es un guardado fallido como cualquier otro. Lo
     * tecleado espera a que vuelva la red.
     */
    if (sinRed) { avisarTexto(SIN_RED_ACCION, 'red', 'mutacion'); return }
    limpiarAviso()
    const patch = campo === 'nombre' ? { name: limpio } : { quantity: limpio || null }
    const { data: fila, clase, code } = await updateItem(createClient(), item.id, patch)
    // J14 — 0 filas no es un éxito silencioso: es que ya no estaba.
    if (clase) { await avisar(clase, code); return }
    if (!fila) {
      /**
       * S7 — R6 conserva la fila para no perder lo tecleado, y eso está bien.
       * Lo que faltaba era retirarla cuando el usuario suelta el campo: se
       * quedaba en pantalla con el texto editado, como si estuviera guardado y
       * compartido, mientras en la base no quedaba ninguna fila viva. Eso es
       * fallar abierto, que es lo que A.3 prohíbe.
       */
      avisarTexto(GONE, 'generico', 'mutacion')
      setItems(prev => prev.filter(i => i.id !== item.id))
      olvidarFila(item.id)
      return
    }
    /**
     * V1 — La fila se funde ANTES de soltar el borrador: antes se esperaba al
     * canal y, con el canal degradado, el cambio no llegaba nunca.
     *
     * W1 — Y la fusión **cede**. Pisar incondicionalmente abrió el defecto
     * inverso: si otro miembro cambia la cantidad mientras tú renombras, su
     * cambio llega por el canal durante el `await` y la respuesta de tu escritura
     * lo revierte. Medido. El criterio es el que `mergeItems` usa desde J6: gana
     * la versión más reciente.
     */
    // X5 — se usa `mergeItems`, que es donde J6 escribió el criterio. Aquí había
    // una comparación propia con los operandos espejados: coincidían por suerte.
    setItems(prev => mergeItems([fila], prev))
    // T3b — sólo se suelta si sigue siendo lo que se confirmó: si el usuario ha
    // seguido escribiendo durante el `await`, tirarlo es R5 en el camino feliz.
    soltar(item.id, campo, valor)
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (busy) return
    // R2 — esto era un `return` mudo. El usuario pulsaba y no pasaba nada: ni
    // ítem, ni explicación. Medido en el navegador: "NADA CAMBIO".
    if (!trimmed) { avisarTexto(ESCRIBE_NOMBRE, 'texto', 'mutacion'); return }
    /**
     * R3 — Sin red, lo apuntado entra en cola y se ve. El campo se vacía para
     * poder seguir apuntando, que es el gesto real en un lineal: se apuntan tres
     * cosas seguidas, no una.
     *
     * El duplicado se mira aquí contra lo que hay en pantalla, y es una excepción
     * declarada a la regla de que lo decide la base: sin red no hay base a la que
     * preguntar. Cuando la haya, el índice único vuelve a mandar.
     */
    /**
     * M1 — La marca se toma **antes de cualquier rama**: los dos caminos esperan,
     * y en los dos manda lo que el usuario teclee mientras tanto. Estuvo sólo en
     * la rama sin red durante tres iteraciones, y el camino con red —el que usa
     * todo el mundo— seguía borrando lo tecleado al volver de la base.
     */
    const desde = tecleado.current
    /**
     * Spec F / R2bis — **Una clave por gesto de alta**, aquí y no en cada rama. El envío
     * inmediato y la entrada de la cola son dos intentos de **la misma** intención, así que
     * comparten clave: es lo que permite a la base reconocer el segundo. Construirla dos veces
     * es el defecto que F6 midió.
     */
    const cantidadAhora = quantity.trim() || null
    const fila: FilaAEnviar = { id: crypto.randomUUID(), nombre: trimmed, cantidad: cantidadAhora }
    if (sinRed) {
      /**
       * I4 — El campo se vacía **antes** de esperar al almacén, y la guarda
       * `busy` vale también aquí. Medido en la revisión: apuntando seis productos
       * seguidos entraban tres, porque lo tecleado entre el `await` y el vaciado
       * se iba con él.
       *
       * Y el duplicado se mira contra el almacén, no contra la copia en memoria
       * del cierre: entre dos altas seguidas, `pendientes` es la de antes.
       */
      setName(''); setQuantity(''); setBusy(true)
      try {
        const r = await meterEnCola(fila, desde)
        if (!r.ok) return
        limpiarAviso()
        /**
         * Spec B / iteración 4 · i4-R1 — **Después de `limpiarAviso()`, no antes.**
         * `apertura` es `una-vez` y `limpiar` se lleva el `una-vez`: anunciarlo dentro
         * de `meterEnCola` lo borraba esta misma línea, y una entrada caducada
         * desaparecía en silencio. Aquí no compite con nadie —sin red el alta que
         * entra no pinta aviso propio—, así que aquí es donde se dice.
         */
        if (r.descartadas) avisarTexto(caducados(r.descartadas), 'texto', 'apertura')
      } finally { setBusy(false) }
      return
    }
    limpiarAviso()
    /**
     * M3 — Con red se vacía **antes** de esperar, igual que sin red, y lo que
     * falla vuelve por `devolver`.
     *
     * I12 dejó escrito lo contrario —«vaciar antes de confirmar pierde lo
     * tecleado si el alta falla»— y era cierto **entonces**: no existía forma de
     * devolverlo sin pisar. M1 puso la guarda del gesto y con ella la razón de
     * I12 desaparece; lo que quedaba era el defecto simétrico, medido: como el
     * campo seguía lleno durante el viaje, cada tecla se **añadía** al producto en
     * vuelo, y el siguiente «+» metía `lentejasgarbanzos` en la lista que ve toda
     * la familia. Se cambió perder texto por escribir texto pegado, que es peor.
     *
     * Ahora los dos caminos tienen una sola forma: vaciar, esperar, devolver si
     * falló y nadie ha tecleado.
     */
    setName(''); setQuantity(''); setBusy(true)
    try {
      const { clase, code } = await addItem(createClient(), group.id, me.id, fila)
      if (clase) {
        /**
         * N1 — Deuda 34. `clasificar` devuelve `servidor` exactamente cuando el
         * error **no trae código**, o sea cuando no contestó nadie que hable
         * PostgREST: red caída, pasarela, o el proyecto pausado del plan
         * gratuito. Un rechazo real de la base —23505, 42501— sí trae código y
         * cae en otra clase, y ésos no se encolan: reintentarlos fallaría igual.
         *
         * Antes se devolvía al campo, y sólo si nadie había tecleado mientras
         * tanto. Quien apunta tres cosas seguidas en un lineal teclea siempre, y
         * ahí lo enviado se perdía: la única pérdida de datos del camino
         * principal.
         */
        if (clase === 'servidor') {
          /**
           * N3 — `'servidor'` y no `'red'`. Medido: `addItem` traduce con
           * `claseDe`, que devuelve `'servidor'` para TODO error sin código, y
           * `clasificar` —lo único que produce `'red'`— sólo se alcanza con
           * código. `'red'` aquí era una rama inalcanzable, igual que la que
           * `lib/items.ts:62` ya retiró una vez.
           */
          /**
           * Spec B / iteración 4 · i4-R1 — Aquí el descarte **no se anuncia**, y se
           * acepta con su argumento: el aviso que la persona necesita es el de su
           * gesto —`EN_COLA`, que le dice dónde quedó su producto—, y la
           * desaparición de lo caducado ya se ve, porque su ficha se fue con ella.
           * Anunciarlo taparía `EN_COLA`: `apertura` es `una-vez` y `cola` es
           * `nivel`, y lo de una vez gana.
           */
          if (!(await meterEnCola(fila, desde)).ok) return
          /**
           * N4 — El aviso se pinta directo, sin `avisar`. `avisar` lanza además
           * un `reintentar` de **carga**, y con `reintentarEnvio` ya en marcha
           * eran dos bucles con el mismo calendario: 5 `addItem` + 5
           * `activeItems` en 23 s contra un servidor que por definición no
           * contesta. La relectura sobra: `drenarUnaVez` ya mezcla la fila que
           * devuelve el propio `addItem`.
           */
          /**
           * Spec B / R3 — **Texto propio del hecho «encolado».** Antes se pintaba
           * `mensajeDe` refinado por red, y eso eran dos problemas en una línea.
           *
           * Uno: `SERVIDOR` dice «lo reintentamos solo», y el reintento dura 23 s
           * —`esperasDeReintento()`— y después no lo reintenta nadie; el aviso
           * seguía en pantalla con el servicio ya contestando.
           *
           * Dos: el refinado existía (N5) para no enseñar «Sin conexión» y «el
           * servicio está despertando» a la vez cuando la red caía entre pulsar y
           * responder. Con un texto que no culpa ni a la red ni al servicio de
           * datos —sólo dice dónde está el producto y que sale solo— esa colisión
           * no puede volver: no hay a quién culpar mal.
           *
           * Y `SERVIDOR` se queda intacto para la carga y la edición fallidas, que
           * es donde sigue siendo cierto que no hay nada guardado.
           */
          despachar({ tipo: 'avisar', origen: 'cola', texto: EN_COLA, clase: 'servidor' })
          void reintentarEnvio(++envio.current)
          return
        }
        devolver(trimmed, cantidadAhora, desde)
        // T7 — no se espera al afinado: hacerlo dejaba el botón deshabilitado
        // hasta 2 s tras un 42501, que es lo contrario de lo que S4 buscaba.
        void avisar(clase, code)
        // R7 — el duplicado lo decide el índice único de la base con 23505, no
        // una comprobación previa aquí: dos altas simultáneas no se ven entre
        // ellas, y comprobar antes de insertar es el check-then-act que D veta.
        // Esto sólo lleva el foco a la fila que ya estaba, para editar su
        // cantidad. Lo tecleado en el alta no se aplica: no se pisa lo que puso
        // otra persona.
        if (code === '23505') {
          // S11 — En la carrera real, quien pierde puede no tener todavía la fila
          // del otro: sin releer, no hay foco y nada lo denuncia.
          let ya = items.find(i => mismoProducto(i.name, trimmed))
          if (!ya) {
            const relectura = await activeItems(createClient(), group.id)
            if (!relectura.clase) {
              setItems(prev => mergeItems(relectura.data, prev))
              ya = relectura.data.find(i => mismoProducto(i.name, trimmed))
            }
          }
          // T6 — El foco se pedía con un `setTimeout(0)` justo después de
          // `setItems`, y React todavía no había pintado la fila nueva: en la
          // carrera real el perdedor no la tiene hasta ese render. Se anota y se
          // enfoca en un efecto, cuando el nodo ya existe.
          if (ya) pendienteFoco.current = ya.id
        }
        return
      }
    } finally {
      setBusy(false)
    }
  }

  // J13 — las tres decisiones de membresía eran el mismo bloque repetido.
  function decide(userId: string, decision: 'active' | 'rejected' | 'removed') {
    startTransition(async () => {
      limpiarAviso()
      const r = await decideMemberAction(group.id, userId, decision)
      // R3/S9 — las acciones devuelven el texto traducido **y su clase**, para
      // que un fallo de sesión ofrezca la salida también por este camino.
      if (r?.mensaje) avisarTexto(r.mensaje, r.clase ?? 'generico', 'mutacion')
      else router.refresh()
    })
  }

  const pending = members.filter(m => m.status === 'pending')
  const active = members.filter(m => m.status === 'active')

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-6 p-4">
      <header className="flex items-center justify-between gap-3">
        <Link href="/" className="min-h-[44px] py-3 text-sm text-neutral-500">← Grupos</Link>
        <h1 className="text-xl font-semibold" data-testid="group-name">{group.name}</h1>
      </header>

      {/* N2 — señal POSITIVA: sólo existe cuando el canal está vivo. Afirmar
          la ausencia del aviso de degradado se resuelve en el instante inicial,
          cuando el estado aún es `connecting`, y pasa con el servicio parado. */}
      {/**
        * Spec B / R2 — **Y sin pendientes de este grupo.** `channelState` es un
        * hecho sobre el canal y no dice nada de lo que está parado en disco:
        * medido, el canal se reconectó a los 13:53:59 y la app anunció estar al
        * día con dos productos de la persona sin enviar. Afirmar un estado que no
        * se puede sostener es lo que §A.3 prohíbe.
        *
        * `pendientes` lo mantiene `releerLaCola` desde la cola compartida —no es
        * una copia local que se entere sola—, y ya viene acotado a este grupo
        * tanto al montar como en cada señal.
        */}
      {channelState === 'live' && pendientes.length === 0 && (
        <span role="status" data-testid="channel-live" className="sr-only">{LISTA_EN_VIVO}</span>
      )}
      <span data-testid="eventos-membresia-peligrosos" data-n={eventosPeligrosos} className="sr-only" />

      {/**
        * R1 — El estado de la red se nombra mientras dura, no sólo cuando algo
        * falla. Va antes que el aviso del canal porque sin red el canal está
        * caído por definición, y decir las dos cosas confunde.
        */}
      {sinRed && (
        <p role="status" data-testid="sin-red"
           className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          {SIN_RED}
        </p>
      )}

      {!sinRed && channelState === 'degraded' && (
        <p role="status" data-testid="channel-degraded"
           className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          {SIN_CONEXION_LISTA}
        </p>
      )}

      {/**
        * Spec B / iteración 2 · i2-R4 — Y son **dos** los orígenes que no son
        * fallos: lo encolado («está guardado en el móvil») y el descarte por
        * caducidad («se descartó 1 producto»), que es la app informando de su
        * propia política. El segundo es el único anuncio que la iteración 1
        * decidió conservar, y se quedó pintado como error.
        *
        * La `key` distingue los dos registros: React parcheaba el `role` **en el
        * mismo nodo**, y un `role` que cambia en sitio no lo recogen de forma
        * fiable las ayudas técnicas. Sin ella, i1-7 afirmaba el atributo y no el
        * anuncio, que es lo que el requisito promete.
        */}
      {/**
        * Spec B / iteración 1 · i1-R4 — **El registro, no sólo las palabras.** R3
        * cambió el texto de lo encolado y dejó el `role="alert"` rojo: a quien usa
        * lector de pantalla se le anunciaba de forma asertiva, como un fallo, un
        * mensaje que dice que su producto está guardado.
        *
        * Discrimina por `origen` y no por `clase`: `'servidor'` la comparten la
        * carga y la edición fallidas, que sí son errores y sí pierden algo.
        * `'cola'` tiene un solo escritor.
        */}
      {notice && (
        <p key={ES_ESTADO.has(notice.origen) ? 'estado' : 'alerta'}
           role={ES_ESTADO.has(notice.origen) ? 'status' : 'alert'} data-testid="notice"
           className={ES_ESTADO.has(notice.origen)
             ? 'rounded-xl bg-amber-50 p-3 text-sm text-amber-800'
             : 'rounded-xl bg-red-50 p-3 text-sm text-red-700'}>
          {notice.texto}
          {/* R4 — "tu sesión ha caducado" sin manera de volver a entrar es un
              callejón: el usuario se queda en una pantalla que ya no puede usar.
              El enlace sólo aparece cuando el problema es la sesión; para un
              fallo de acceso real no habría nada que reintentar entrando. */}
          {/* V7 — sin `next` el usuario vuelve a entrar y aterriza en la raíz,
              lejos del grupo que estaba mirando. La convención ya existe. */}
          {notice.clase === 'sesion' && (
            <Link href={`/login?next=${encodeURIComponent(`/g/${group.id}`)}`}
              data-testid="volver-a-entrar"
              className="ml-2 inline-block min-h-[44px] underline">Volver a entrar</Link>
          )}
        </p>
      )}

      <form onSubmit={onAdd} className="flex gap-2">
        <input value={name} onChange={e => { tecleado.current++; setName(e.target.value) }} placeholder="Producto"
          data-testid="item-name" className="min-h-[44px] w-full min-w-0 rounded-xl border border-neutral-300 px-4" />
        <input value={quantity} onChange={e => { tecleado.current++; setQuantity(e.target.value) }} placeholder="Cantidad"
          data-testid="item-qty" className="min-h-[44px] w-24 shrink-0 rounded-xl border border-neutral-300 px-3" />
        <button data-testid="add-item" disabled={busy}
          /* R9 — medido 41x44: declaraba alto mínimo pero no ancho. */
          className="min-h-[44px] min-w-[44px] shrink-0 rounded-xl bg-neutral-900 px-4 text-white disabled:opacity-50">+</button>
      </form>

      <ul className="flex flex-col gap-2" data-testid="items">
        {/**
          * R3 — Los pendientes van arriba y no se pueden editar: no existen aún
          * en el servidor, así que no hay fila que corregir. Se ven porque lo
          * contrario —apuntar algo y que no aparezca— es el silencio que este
          * proyecto lleva un ciclo entero quitando.
          */}
        {pendientes.map(p => (
          <li key={p.id} data-testid="item-pendiente"
              className="flex items-center gap-2 rounded-xl border border-dashed border-amber-300 bg-amber-50 p-3">
            <span className="min-w-0 flex-1 truncate text-neutral-700">{p.nombre}</span>
            {p.cantidad && <span className="shrink-0 text-neutral-500">{p.cantidad}</span>}
            <span className="shrink-0 text-xs text-amber-700">{PENDIENTE}</span>
          </li>
        ))}
        {items.map(item => (
          <li key={item.id} data-testid="item"
              className="flex items-center gap-2 rounded-xl border border-neutral-200 p-3">
            <input
              aria-label="Nombre"
              value={escrito(item.id, 'nombre') ?? item.name}
              onChange={e => anotar(item.id, 'nombre', e.target.value)}
              onBlur={() => void confirmar(item, 'nombre')}
              className="min-h-[44px] w-full min-w-0 bg-transparent" />
            {/* R8 — la cantidad era un `<span>`: no se podía editar, y sin eso
                R7 prometía "avisar y dejar editar la cantidad" sin nada que lo
                implementara. */}
            <input
              aria-label={`Cantidad de ${item.name}`}
              data-cantidad-de={item.id}
              placeholder="Cantidad"
              value={escrito(item.id, 'cantidad') ?? (item.quantity ?? '')}
              onChange={e => anotar(item.id, 'cantidad', e.target.value)}
              onBlur={() => void confirmar(item, 'cantidad')}
              className="min-h-[44px] w-20 shrink-0 bg-transparent text-right text-sm text-neutral-500" />
            <button aria-label={`Borrar ${item.name}`} data-testid="delete-item"
              disabled={deleting.has(item.id)}
              onClick={() => {
                if (deleting.has(item.id)) return
                // R7 — igual que editar: sin red no se tacha.
                if (sinRed) { avisarTexto(SIN_RED_ACCION, 'red', 'mutacion'); return }
                limpiarAviso()
                setDeleting(prev => new Set(prev).add(item.id))
                void softDeleteItem(createClient(), item.id)
                  .then(r => {
                    if (r.clase) void avisar(r.clase, r.code)
                    else if (r.data === 0) avisarTexto(GONE, 'generico', 'mutacion')
                  })
                  .finally(() => {
                    // L1 — sin esto el id no salia nunca del conjunto: tras un
                    // fallo el boton quedaba deshabilitado para siempre mientras
                    // el aviso invitaba a reintentar lo que la interfaz impedia.
                    setDeleting(prev => {
                      const next = new Set(prev)
                      next.delete(item.id)
                      return next
                    })
                  })
              }}
              className="min-h-[44px] min-w-[44px] shrink-0 text-neutral-400">×</button>
          </li>
        ))}
        {items.length === 0 && <li className="text-neutral-500">La lista está vacía.</li>}
      </ul>

      {isOwner && (
        <section className="flex flex-col gap-3 border-t border-neutral-200 pt-4">
          <h2 className="font-medium">
            Miembros{pending.length > 0 && (
              <span data-testid="pending-count" className="ml-2 rounded-full bg-neutral-900 px-2 py-1 text-xs text-white">
                {pending.length}
              </span>
            )}
          </h2>

          {pending.map(m => (
            <div key={m.user_id} data-testid="pending-request" className="flex items-center gap-2">
              <span className="w-full min-w-0 truncate">{nameOf(m.user_id)}</span>
              <button data-testid="approve" className="min-h-[44px] rounded-xl bg-neutral-900 px-3 text-sm text-white"
                onClick={() => decide(m.user_id, 'active')}>
                Aceptar
              </button>
              <button data-testid="reject" className="min-h-[44px] rounded-xl border border-neutral-300 px-3 text-sm"
                onClick={() => decide(m.user_id, 'rejected')}>
                Rechazar
              </button>
            </div>
          ))}

          {active.filter(m => m.user_id !== me.id).map(m => (
            <div key={m.user_id} data-testid="active-member" className="flex items-center gap-2">
              <span className="w-full min-w-0 truncate">{nameOf(m.user_id)}</span>
              <button data-testid="expel" className="min-h-[44px] rounded-xl border border-neutral-300 px-3 text-sm"
                onClick={() => decide(m.user_id, 'removed')}>
                Expulsar
              </button>
            </div>
          ))}

          <button data-testid="create-invite" className="min-h-[44px] rounded-xl border border-neutral-300 px-4 text-sm"
            onClick={() => startTransition(async () => {
              limpiarAviso()
              const r = await createInviteAction(group.id)
              if (r.mensaje) avisarTexto(r.mensaje, r.clase ?? 'generico', 'mutacion')
              else if (r.token) setInvite(`${window.location.origin}/invite/${r.token}`)
            })}>
            Generar link de invitación
          </button>
          {invite && <input readOnly value={invite} data-testid="invite-link"
            className="min-h-[44px] w-full rounded-xl border border-neutral-200 bg-neutral-50 px-3 text-xs" />}
        </section>
      )}

      {/* T9 — antes era un `<form action=…>` con una acción que LANZABA: Next
          enmascaraba el mensaje con un digest y el usuario veía una pantalla de
          error, no el aviso. Ahora se pinta como las otras tres. */}
      {!isOwner && (
        <div className="border-t border-neutral-200 pt-4">
          <button data-testid="leave" className="min-h-[44px] text-sm text-neutral-500"
            onClick={() => startTransition(async () => {
              const r = await leaveGroupAction(group.id)
              if (r?.mensaje) avisarTexto(r.mensaje, r.clase ?? 'generico', 'mutacion')
            })}>
            Salir del grupo
          </button>
        </div>
      )}
    </main>
  )
}
