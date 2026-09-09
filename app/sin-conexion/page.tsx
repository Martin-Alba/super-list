'use client'

import { useEffect, useState } from 'react'
import { leerLista, leerUltimoUsuario } from '@/lib/local'
import { haySesionLocal } from '@/lib/sesionLocal'
import { SIN_INSTANTANEA, SIN_RED_FUERA, SIN_RED_SOLO_LECTURA } from '@/lib/errors'
import type { Item } from '@/lib/items'

/**
 * I2 — El shell que el service worker sirve cuando una navegación no llega.
 *
 * Es **estático y sin dato de nadie**: eso es lo que permite guardarlo en un
 * disco que comparten todos los que usen el dispositivo. Los datos siguen donde
 * `olvidarTodo` puede vaciarlos — IndexedDB, claveados por usuario.
 *
 * La URL no cambia al servir esta respuesta, así que aquí se sabe qué grupo se
 * pedía. Se pinta en **sólo lectura**: apuntar sin red existe, pero vive en la
 * vista de verdad; ofrecerlo aquí sería prometer una cola que este shell no tiene.
 */
export default function SinConexion() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [listo, setListo] = useState(false)
  // J8 — fuera de un grupo, decir «este grupo» es mentira: el shell se sirve
  // también para la portada y para entrar.
  const [enUnGrupo, setEnUnGrupo] = useState(false)

  useEffect(() => {
    void (async () => {
      // K5 — Pase lo que pase con el almacén, esta pantalla **termina**. Un
      // rechazo aquí dejaba el shell en blanco: ni lista, ni «necesitas
      // conexión». La guarda vive donde vive el daño, además de en el módulo.
      try {
        const grupo = /\/g\/([0-9a-f-]{36})/i.exec(window.location.pathname)?.[1]
        setEnUnGrupo(!!grupo)
        /**
         * K4 — La marca dice de quién es la instantánea; no dice quién está
         * mirando. Sin sesión en el dispositivo no se pinta la de nadie: medido
         * con el navegador, borradas las cookies y sin red, una pestaña nueva en
         * la URL del grupo enseñaba los productos del anterior.
         */
        const usuario = haySesionLocal() ? await leerUltimoUsuario() : null
        if (grupo && usuario) setItems(await leerLista(usuario, grupo))
      } catch { /* sin instantánea: se dice, que es mejor que una pantalla vacía */ }
      setListo(true)
    })()
  }, [])

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <p role="status" data-testid="sin-red"
         className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
        {SIN_RED_SOLO_LECTURA}
      </p>
      {listo && !items?.length && (
        <p data-testid="sin-instantanea" className="text-neutral-500">
          {enUnGrupo ? SIN_INSTANTANEA : SIN_RED_FUERA}
        </p>
      )}
      {!!items?.length && (
        <ul className="flex flex-col gap-2" data-testid="items">
          {items.map(i => (
            <li key={i.id} data-testid="item"
                className="flex items-center gap-2 rounded-xl border border-neutral-200 p-3">
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              {i.quantity && <span className="shrink-0 text-neutral-500">{i.quantity}</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
