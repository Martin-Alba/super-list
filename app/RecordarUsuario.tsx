'use client'

import { useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { haySesionLocal } from '@/lib/sesionLocal'
import { leerUltimoUsuario, guardarUltimoUsuario, olvidarTodo, olvidarUltimoUsuario } from '@/lib/local'

/**
 * I3/J1 — Quién está dentro, registrado en **un solo sitio** que no depende de
 * qué vista gane la rama: el layout, que es por donde pasa todo lo que se
 * rendere. Vivió en la vista del grupo y llegaba tarde —un `pending` no llega a
 * verla, y la página de invitación redirige sin renderizarla—, y medido con dos
 * sesiones reales el segundo usuario del dispositivo veía la lista del primero.
 *
 * K7 — Y la sesión la lee **el navegador**, no el servidor. Preguntarla en el
 * layout añadía dos viajes a `/auth/v1/user` por render sobre los que el proxy y
 * la página ya hacían, y con el servicio de auth colgado doblaba el peor caso a
 * 20 s. Para una clave local no hace falta autoridad: si el id fuera equivocado,
 * lo único que pasa es que no se encuentra ninguna instantánea, que es fallar
 * cerrado.
 */
export function RecordarUsuario() {
  useEffect(() => {
    void (async () => {
      /**
       * L7 — Sin sesión en el dispositivo no se construye el cliente: construirlo
       * arranca el temporizador de refresco, y en el shell sin red eso es un POST
       * a `/auth/v1/token` desde la pantalla que existe porque no hay red. La
       * misma pregunta que hace el shell, por el mismo sitio.
       */
      if (!haySesionLocal()) return
      const { data } = await createClient().auth.getSession()
      const usuario = data.session?.user.id
      if (!usuario) return
      const anterior = await leerUltimoUsuario()
      if (anterior && anterior !== usuario) {
        /**
         * L1 — Primero se quita la marca, después se borra lo del anterior.
         * `olvidarTodo` son N+2 viajes a disco, y durante ese rato la cookie del
         * nuevo convivía con la marca del viejo: el shell responde a *hay
         * sesión*, no a *de quién*, así que en esa ventana enseñaba la lista del
         * anterior. Sin marca no enseña nada, que es fallar cerrado — y es el
         * estado en el que queda esto si algo se interrumpe a mitad.
         */
        await olvidarUltimoUsuario()
        await olvidarTodo(anterior)
      }
      /**
       * K6 — Si el disco no admite la marca nueva, no puede quedarse la vieja: un
       * usuario nuevo delante y la marca del anterior detrás es exactamente la
       * fuga que K4 cierra. Sin marca, el shell no pinta la instantánea de nadie.
       */
      if (!(await guardarUltimoUsuario(usuario))) await olvidarUltimoUsuario()
    })()
  }, [])
  return null
}
