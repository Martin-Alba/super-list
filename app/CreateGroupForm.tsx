'use client'

import { useActionState } from 'react'
import Link from 'next/link'
import { createGroupAction, type ActionState } from './actions'

export function CreateGroupForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createGroupAction, {})
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input name="name" placeholder="Nombre del grupo" required
          className="min-h-[44px] w-full min-w-0 rounded-xl border border-neutral-300 px-4" data-testid="group-name" />
        <button disabled={pending} data-testid="create-group"
          className="min-h-[44px] shrink-0 rounded-xl bg-neutral-900 px-4 text-white disabled:opacity-50">
          Crear
        </button>
      </div>
      {/* S1 — `role="alert"` lo emite también el anunciador de ruta de Next, y un
          test que lo busque por rol casa con los dos: medido, 15 rojos de 30. */}
      {state.mensaje && (
        <p role="alert" data-testid="group-notice" className="text-sm text-red-600">
          {state.mensaje}
          {state.clase === 'sesion' && (
            <Link href="/login" data-testid="volver-a-entrar" className="ml-2 underline">Volver a entrar</Link>
          )}
        </p>
      )}
    </form>
  )
}
