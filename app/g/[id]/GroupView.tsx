'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { activeItems, addItem, mergeItems, mismoProducto, softDeleteItem, updateItem, type Item } from '@/lib/items'
import { ESCRIBE_NOMBRE, GONE, LISTA_EN_VIVO, mensajeDe, refinarSinSesion, RELECTURA,
  SIN_CONEXION_LISTA, type Clase } from '@/lib/errors'
import { useGroupChannel } from '@/lib/useGroupChannel'
import { createInviteAction, decideMemberAction, leaveGroupAction } from '@/app/actions'

type Member = { user_id: string; status: string; role: string }
type Profile = { id: string; display_name: string | null }

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
  const [items, setItems] = useState<Item[]>(initialItems)
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
  const [notice, setNotice] = useState<{ texto: string; clase: Clase } | null>(null)
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
  // una mutacion llamaba a `setNotice(null)` desaparecia aunque el fallo
  // siguiera vigente. Derivado en cada render, un aviso de mutacion lo tapa
  // mientras dura, pero nunca lo borra.
  // U6 / AD3 — Del servidor llega la **clase**, no un mensaje: el texto crudo de
  // Postgres ya no existe fuera de `lib/errors.ts`, así que no hay nada que
  // traducir aquí ni nada que reclasificar a partir del código.
  const avisoVisible = notice ?? (loadClase
    ? { texto: mensajeDe(loadClase) ?? '', clase: loadClase }
    : null)

  /**
   * R1/R4 — Un único sitio por el que sale todo fallo. `haySesion` no se adivina
   * del error: lo sabe el cliente, y es lo único que separa `42501` "no traes
   * token" de `42501` "tu token no basta para esta fila". Sin esa pregunta, a
   * quien se le caduca la sesión se le dice que ha perdido el acceso al grupo.
   */
  const secuencia = useRef(0)

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
    secuencia.current++
    if (!clase) return
    setNotice({ texto: mensajeDe(clase) ?? '', clase })

    // Sólo `42501` cambia de significado según haya sesión o no: es el único
    // código que la base reutiliza para las dos cosas.
    if (code !== '42501') return
    // T7 — El afinado llega tarde por definición, así que se sella: si desde que
    // salió ha pasado cualquier otra cosa —otro aviso, o una escritura correcta
    // que lo limpió—, ya no le toca hablar. Sin el sello, medido, "tu sesión ha
    // caducado" reaparecía hasta 2 s después sobre una escritura que fue bien.
    const mio = ++secuencia.current
    let reloj: ReturnType<typeof setTimeout> | undefined
    try {
      // D.6 — toda llamada de red con cota. Sin ella, esto es la espera de 30 s.
      const { data } = await Promise.race([
        createClient().auth.getSession(),
        new Promise<never>((_, no) => { reloj = setTimeout(() => no(new Error('sin respuesta')), 2_000) }),
      ])
      if (data.session || mio !== secuencia.current) return
      // AD1 — el afinado es una regla sobre la clase, no una segunda
      // clasificación: sin sesión, «no tienes acceso» es «se te ha caducado».
      const afinada = refinarSinSesion(clase)
      if (afinada) setNotice({ texto: mensajeDe(afinada) ?? '', clase: afinada })
    } catch { /* se queda el aviso ya pintado: menos preciso, pero visible */
    } finally { if (reloj) clearTimeout(reloj) }
  }

  const avisarTexto = (texto: string, clase: Clase = 'generico') => {
    secuencia.current++
    setNotice({ texto, clase })
  }
  /**
   * U3 — Cuatro de los cinco sitios que limpiaban el aviso no sellaban, así que
   * el afinado en vuelo reaparecía encima: 42501 → alta correcta → "tu sesión ha
   * caducado" otra vez. Reproducido determinista. Limpiar es una operación, no un
   * `setNotice(null)` suelto.
   */
  const limpiarAviso = () => { secuencia.current++; setNotice(null) }

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
        avisarTexto(GONE)
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
        if (r.clase) { avisarTexto(RELECTURA, r.clase); return }
        // `prev` ya incluye los eventos llegados durante la petición: sustituir
        // la lista los borraría hasta el siguiente evento (J6, D.2).
        setItems(prev => mergeItems(r.data, prev))
      })
    },
  })

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
      avisarTexto(GONE)
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
    if (!trimmed) { avisarTexto(ESCRIBE_NOMBRE, 'texto'); return }
    limpiarAviso(); setBusy(true)
    try {
      // I12 — vaciar antes de confirmar pierde lo tecleado si el alta falla.
      const { clase, code } = await addItem(createClient(), group.id, me.id, trimmed, quantity.trim() || null)
      if (clase) {
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
      setName(''); setQuantity('')
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
      if (r?.mensaje) avisarTexto(r.mensaje, r.clase ?? 'generico')
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
      {channelState === 'live' && (
        <span role="status" data-testid="channel-live" className="sr-only">{LISTA_EN_VIVO}</span>
      )}
      <span data-testid="eventos-membresia-peligrosos" data-n={eventosPeligrosos} className="sr-only" />

      {channelState === 'degraded' && (
        <p role="status" data-testid="channel-degraded"
           className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          {SIN_CONEXION_LISTA}
        </p>
      )}

      {avisoVisible && (
        <p role="alert" data-testid="notice" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
          {avisoVisible.texto}
          {/* R4 — "tu sesión ha caducado" sin manera de volver a entrar es un
              callejón: el usuario se queda en una pantalla que ya no puede usar.
              El enlace sólo aparece cuando el problema es la sesión; para un
              fallo de acceso real no habría nada que reintentar entrando. */}
          {/* V7 — sin `next` el usuario vuelve a entrar y aterriza en la raíz,
              lejos del grupo que estaba mirando. La convención ya existe. */}
          {avisoVisible.clase === 'sesion' && (
            <Link href={`/login?next=${encodeURIComponent(`/g/${group.id}`)}`}
              data-testid="volver-a-entrar"
              className="ml-2 inline-block min-h-[44px] underline">Volver a entrar</Link>
          )}
        </p>
      )}

      <form onSubmit={onAdd} className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Producto"
          data-testid="item-name" className="min-h-[44px] w-full min-w-0 rounded-xl border border-neutral-300 px-4" />
        <input value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="Cantidad"
          data-testid="item-qty" className="min-h-[44px] w-24 shrink-0 rounded-xl border border-neutral-300 px-3" />
        <button data-testid="add-item" disabled={busy}
          /* R9 — medido 41x44: declaraba alto mínimo pero no ancho. */
          className="min-h-[44px] min-w-[44px] shrink-0 rounded-xl bg-neutral-900 px-4 text-white disabled:opacity-50">+</button>
      </form>

      <ul className="flex flex-col gap-2" data-testid="items">
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
                limpiarAviso()
                setDeleting(prev => new Set(prev).add(item.id))
                void softDeleteItem(createClient(), item.id)
                  .then(r => {
                    if (r.clase) void avisar(r.clase, r.code)
                    else if (r.data === 0) avisarTexto(GONE)
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
              if (r.mensaje) avisarTexto(r.mensaje, r.clase ?? 'generico')
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
              if (r?.mensaje) avisarTexto(r.mensaje, r.clase ?? 'generico')
            })}>
            Salir del grupo
          </button>
        </div>
      )}
    </main>
  )
}
