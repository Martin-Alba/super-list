'use client'

import { olvidarTodo } from '@/lib/local'
import { signOutAction } from './actions'

/**
 * R5/R6 — Cerrar sesión borra lo que la app guardó **en el dispositivo**: la cola
 * pendiente y la última lista conocida. Sin esto, quien entre después en el mismo
 * móvil encuentra la lista del anterior, que es justo lo que A.1 prohíbe en el
 * servidor y no tendría sentido permitir aquí.
 *
 * Tiene que ser un componente de cliente porque una acción de servidor no puede
 * tocar IndexedDB. Se borra **antes** de cerrar la sesión: si se hiciera después,
 * la redirección ya se habría llevado la página por delante.
 *
 * Y sólo el cierre explícito: una sesión caducada es el mismo usuario, y tirarle
 * lo que apuntó sin red sería perder datos por un tecnicismo.
 */
export function BotonSalir({ usuario }: { usuario: string }) {
  return (
    <form
      action={async () => {
        // Se espera de verdad: `onSubmit` no esperaba, y el redirect podía
        // llevarse la página antes de que el borrado terminara. El comentario
        // decía «antes de cerrar la sesión» y no era cierto.
        await olvidarTodo(usuario)
        await signOutAction()
      }}
    >
      <button className="min-h-[44px] px-3 text-sm text-neutral-500" data-testid="signout">Salir</button>
    </form>
  )
}
