'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { activeItems, addItem, mergeItems, softDeleteItem, updateItem, type Item } from '@/lib/items'
import { describeError, GONE } from '@/lib/errors'
import { useGroupChannel } from '@/lib/useGroupChannel'
import { createInviteAction, decideMemberAction, leaveGroupAction } from '@/app/actions'

type Member = { user_id: string; status: string; role: string }
type Profile = { id: string; display_name: string | null }

export function GroupView({
  group, initialItems, members, profiles, me, loadError,
}: {
  group: { id: string; name: string }
  initialItems: Item[]
  members: Member[]
  profiles: Profile[]
  me: { id: string; role: string }
  loadError?: string | null
}) {
  const router = useRouter()
  const [items, setItems] = useState<Item[]>(initialItems)
  const [name, setName] = useState('')
  const [quantity, setQuantity] = useState('')
  const [invite, setInvite] = useState<string | null>(null)
  // Mientras alguien escribe, su texto manda sobre lo que llegue por el canal;
  // en cuanto suelta el campo, vuelve a mandar el dato del servidor.
  const [draft, setDraft] = useState<{ id: string; value: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // K2 — el botón de borrar no tenía guarda en vuelo: un doble toque lo
  // disparaba dos veces y la segunda pasada, con 0 filas, acusaba a otro
  // usuario del segundo toque del propio.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
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
  const avisoVisible = notice ?? (loadError ? describeError(loadError) : null)

  // R9 — el borrado viaja como UPDATE (deleted_at), por eso va autorizado por
  // RLS. Un DELETE físico no lo estaría: los eventos DELETE están exentos.
  const [eventosPeligrosos, setEventosPeligrosos] = useState(0)

  const channelState = useGroupChannel(group.id, {
    onItem: (row) => setItems(prev => {
      const rest = prev.filter(i => i.id !== row.id)
      return row.deleted_at ? rest : [...rest, row].sort((a, b) => a.created_at.localeCompare(b.created_at))
    }),
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
      void activeItems(createClient(), group.id)
        // `prev` ya incluye los eventos llegados durante la petición: sustituir
        // la lista los borraría hasta el siguiente evento (J6, D.2).
        .then(fresh => setItems(prev => mergeItems(fresh, prev)))
        .catch(() => setNotice('No se ha podido recargar la lista.'))
    },
  })

  async function commitRename(item: Item) {
    const next = draft?.id === item.id ? draft.value.trim() : null
    setDraft(null)
    if (!next || next === item.name) return
    setNotice(null)
    const { data: affected, error } = await updateItem(createClient(), item.id, { name: next })
    // J14 — 0 filas no es un éxito silencioso: es que ya no estaba.
    if (error) setNotice(describeError(error))
    else if (affected === 0) setNotice(GONE)
  }

  async function onAdd(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setNotice(null); setBusy(true)
    try {
      // I12 — vaciar antes de confirmar pierde lo tecleado si el alta falla.
      const { error } = await addItem(createClient(), group.id, me.id, trimmed, quantity.trim() || null)
      if (error) { setNotice(describeError(error)); return }
      setName(''); setQuantity('')
    } finally {
      setBusy(false)
    }
  }

  // J13 — las tres decisiones de membresía eran el mismo bloque repetido.
  function decide(userId: string, decision: 'active' | 'rejected' | 'removed') {
    startTransition(async () => {
      setNotice(null)
      const r = await decideMemberAction(group.id, userId, decision)
      if (r?.error) setNotice(describeError(r.error))
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
        <span role="status" data-testid="channel-live" className="sr-only">Lista en vivo</span>
      )}
      <span data-testid="eventos-membresia-peligrosos" data-n={eventosPeligrosos} className="sr-only" />

      {channelState === 'degraded' && (
        <p role="status" data-testid="channel-degraded"
           className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
          Sin conexión en vivo: puede que no veas los cambios de los demás.
        </p>
      )}

      {avisoVisible && (
        <p role="alert" data-testid="notice" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">
          {avisoVisible}
        </p>
      )}

      <form onSubmit={onAdd} className="flex gap-2">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Producto"
          data-testid="item-name" className="min-h-[44px] w-full min-w-0 rounded-xl border border-neutral-300 px-4" />
        <input value={quantity} onChange={e => setQuantity(e.target.value)} placeholder="Cantidad"
          data-testid="item-qty" className="min-h-[44px] w-24 shrink-0 rounded-xl border border-neutral-300 px-3" />
        <button data-testid="add-item" disabled={busy}
          className="min-h-[44px] shrink-0 rounded-xl bg-neutral-900 px-4 text-white disabled:opacity-50">+</button>
      </form>

      <ul className="flex flex-col gap-2" data-testid="items">
        {items.map(item => (
          <li key={item.id} data-testid="item"
              className="flex items-center gap-2 rounded-xl border border-neutral-200 p-3">
            <input
              aria-label="Nombre"
              value={draft?.id === item.id ? draft.value : item.name}
              onChange={e => setDraft({ id: item.id, value: e.target.value })}
              onBlur={() => void commitRename(item)}
              className="min-h-[44px] w-full min-w-0 bg-transparent" />
            {item.quantity && <span className="shrink-0 text-sm text-neutral-500">{item.quantity}</span>}
            <button aria-label={`Borrar ${item.name}`} data-testid="delete-item"
              disabled={deleting.has(item.id)}
              onClick={() => {
                if (deleting.has(item.id)) return
                setNotice(null)
                setDeleting(prev => new Set(prev).add(item.id))
                void softDeleteItem(createClient(), item.id)
                  .then(r => {
                    if (r.error) setNotice(describeError(r.error))
                    else if (r.data === 0) setNotice(GONE)
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
              setNotice(null)
              const r = await createInviteAction(group.id)
              if (r.error) setNotice(describeError(r.error))
              else if (r.token) setInvite(`${window.location.origin}/invite/${r.token}`)
            })}>
            Generar link de invitación
          </button>
          {invite && <input readOnly value={invite} data-testid="invite-link"
            className="min-h-[44px] w-full rounded-xl border border-neutral-200 bg-neutral-50 px-3 text-xs" />}
        </section>
      )}

      {!isOwner && (
        <form action={leaveGroupAction.bind(null, group.id)} className="border-t border-neutral-200 pt-4">
          <button data-testid="leave" className="min-h-[44px] text-sm text-neutral-500">Salir del grupo</button>
        </form>
      )}
    </main>
  )
}
