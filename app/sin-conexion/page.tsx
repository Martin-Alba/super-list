'use client'

import { useEffect, useRef, useState } from 'react'
import { encolar, leerCola, leerLista, leerNombre, leerUltimoUsuario } from '@/lib/local'
import { haySesionLocal } from '@/lib/sesionLocal'
import { decidirEncolar } from '@/lib/cola'
import { bannerSinRed, DUPLICADO, ESCRIBE_NOMBRE, esperaDeSondeo, SIN_ALMACEN, SIN_INSTANTANEA,
  SIN_RED_FUERA } from '@/lib/errors'
import type { Item } from '@/lib/items'
import type { Pendiente } from '@/lib/local'

const CLAVE_INTENTO = 'sin-red:intento'
/** Un episodio nuevo empieza rápido; una recarga que falla, no. */
const VIGENCIA_INTENTO = 60_000

/**
 * Respaldo para cuando `sessionStorage` no está —modo privado, cuota, almacén
 * capado—. Medido el 2026-09-13: `window.name` **sí** cruza una recarga en la
 * misma pestaña. `history.state` no vale: es de Next, lleva su
 * `__PRIVATE_NEXTJS_INTERNALS_TREE`, y escribir ahí pisaría su router.
 *
 * Se marca el valor porque `window.name` es una global de la pestaña que puede
 * tener dueño: sin la marca no se lee, y **sólo se escribe** si el almacén normal
 * ha fallado.
 *
 * *Límite:* `window.name` sobrevive también a navegaciones dentro del mismo
 * sitio, así que un valor marcado de una visita anterior puede hacer que la
 * primera sonda llegue tarde. El valor es `{n,t}` y caduca al minuto, así que el
 * coste máximo es una recuperación inicial lenta en un navegador que además tiene
 * el almacén de pestaña capado.
 */
const MARCA_NOMBRE = 'sin-red:'

function intentoGuardado(): number {
  let crudo: string | null = null
  try {
    crudo = sessionStorage.getItem(CLAVE_INTENTO)
  } catch {
    crudo = window.name.startsWith(MARCA_NOMBRE) ? window.name.slice(MARCA_NOMBRE.length) : null
  }
  if (!crudo) return 0
  try {
    const { n, t } = JSON.parse(crudo) as { n: number; t: number }
    if (typeof n !== 'number' || typeof t !== 'number') return 0
    return Date.now() - t < VIGENCIA_INTENTO ? n : 0
  } catch { return 0 }
}

function guardarIntento(n: number): void {
  const marca = JSON.stringify({ n, t: Date.now() })
  try {
    sessionStorage.setItem(CLAVE_INTENTO, marca)
  } catch {
    window.name = MARCA_NOMBRE + marca
  }
}

/** Se lee cada vez: cruzar un `await` puede cambiarlo, y el estrechado no lo sabe. */
const oculta = () => document.visibilityState === 'hidden'

/**
 * D.6 — La sonda lleva su cota, y pregunta por **la URL que se va a navegar**.
 * Con el modo `cors` que `fetch` pone por defecto, en el worker esto no es
 * `esDocumento` ni `esEstatico`, así que ninguna rama la responde de caché y sale
 * a la red. Si se sirviera de caché acertaría siempre sin red, y sería un bucle
 * de recargas.
 */
async function haySalida(): Promise<boolean> {
  const ctrl = new AbortController()
  const reloj = setTimeout(() => ctrl.abort(), 2_000)
  try {
    /**
     * Se pregunta por **la URL que se va a navegar**, no por `/`. Medido en la
     * revisión: con la sonda en `/`, un origen que contesta mientras `/g/<id>`
     * sigue cayendo recarga cada 2 s para siempre.
     */
    const res = await fetch(window.location.href, { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return false
    /**
     * No se rechaza *toda* redirección: sin sesión, `proxy.ts` manda `/g/<id>` a
     * `/login`, y exigir `!res.redirected` dejaba la cáscara encerrada para
     * siempre — medido, 40 s con la red ya de vuelta. Lo que se exige es que el
     * destino siga siendo **nuestro origen**: un portal cautivo que redirige
     * fuera sigue rechazado, y el login propio no.
     */
    if (new URL(res.url).origin !== window.location.origin) return false
    /**
     * R5 — Un portal cautivo contesta 200 a todo, y este repositorio ya paga esa
     * defensa dos veces en el worker. Límite escrito: un portal que sirva 200 y
     * HTML **en nuestra URL** sigue siendo indistinguible sin leer el cuerpo en
     * cada sonda, y eso cuesta más de lo que ahorra; el daño duradero —guardar su
     * HTML— lo impide el worker, que es donde estaba el problema.
     */
    return /text\/html/i.test(res.headers.get('content-type') ?? '')
  } catch {
    return false
  } finally {
    clearTimeout(reloj)
  }
}

/**
 * I2 — El shell que el service worker sirve cuando una navegación no llega.
 *
 * Es **estático y sin dato de nadie**: eso es lo que permite guardarlo en un
 * disco que comparten todos los que usen el dispositivo. Los datos siguen donde
 * `olvidarTodo` puede vaciarlos — IndexedDB, claveados por usuario.
 *
 * Spec C — Y deja de ser un callejón. Medido en el navegador el 2026-09-13:
 * recargando sin cobertura dentro de un grupo esto es lo único que se monta, así
 * que `GroupView` —con la cola, los avisos y el canal— no existe. Que aquí no se
 * pudiera apuntar dejaba la app resolviendo sólo el caso en que la red cae con el
 * grupo ya abierto, que es el menos frecuente. Ahora se apunta a **la misma
 * cola**, con **la misma regla** (`lib/cola.ts`), y la drena `GroupView` cuando
 * vuelve. Lo que no se comparte es `avisar`: es el mecanismo de la Spec B.
 */
export default function SinConexion() {
  const [items, setItems] = useState<Item[] | null>(null)
  const [listo, setListo] = useState(false)
  const [nombreGrupo, setNombreGrupo] = useState<string | null>(null)
  const [grupo, setGrupo] = useState<string | null>(null)
  const [usuario, setUsuario] = useState<string | null>(null)
  const [pendientes, setPendientes] = useState<Pendiente[]>([])
  const [texto, setTexto] = useState('')
  const [cantidad, setCantidad] = useState('')
  const [aviso, setAviso] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)
  const enviandoRef = useRef(false)

  useEffect(() => {
    void (async () => {
      // K5 — Pase lo que pase con el almacén, esta pantalla **termina**. Un
      // rechazo aquí dejaba el shell en blanco: ni lista, ni «necesitas
      // conexión». La guarda vive donde vive el daño, además de en el módulo.
      try {
        const g = /\/g\/([0-9a-f-]{36})/i.exec(window.location.pathname)?.[1] ?? null
        setGrupo(g)
        /**
         * K4 — La marca dice de quién es la instantánea; no dice quién está
         * mirando. Sin sesión en el dispositivo no se pinta la de nadie: medido
         * con el navegador, borradas las cookies y sin red, una pestaña nueva en
         * la URL del grupo enseñaba los productos del anterior. El **nombre**
         * entra por la misma puerta, y por el mismo motivo.
         */
        const u = haySesionLocal() ? await leerUltimoUsuario() : null
        setUsuario(u)
        if (g && u) {
          setItems(await leerLista(u, g))
          setNombreGrupo(await leerNombre(u, g))
          setPendientes((await leerCola(u)).filter(p => p.grupo === g))
        }
      } catch { /* sin instantánea: se dice, que es mejor que una pantalla vacía */ }
      setListo(true)
    })()
  }, [])

  /**
   * R1/R2 — El sondeo. No se ata al evento `online`: con el servidor caído
   * `navigator.onLine` sigue en `true`, que es exactamente el caso del plan
   * gratuito pausado. Se pausa con la pestaña oculta —el móvil en el bolsillo no
   * sondea— y al volver a verse reinicia la cadencia, porque quien saca el móvil
   * quiere que compruebe ya.
   */
  useEffect(() => {
    let vivo = true
    let reloj: ReturnType<typeof setTimeout> | undefined
    let intento = intentoGuardado()
    /**
     * R3 — Una generación, el patrón que el proyecto ya usa (`envio`,
     * `secuencia`). Sin ella, un cambio de visibilidad con una sonda en vuelo
     * dejaba el temporizador anterior huérfano y armado: medido, el régimen
     * pasaba de 4 sondas por 120 s a 7, y se quedaba así.
     */
    let generacion = 0

    const ciclo = async (mia: number) => {
      if (!vivo || mia !== generacion || oculta()) return
      const hay = await haySalida()
      // Se vuelve a mirar **después** del await: la pestaña pudo ocultarse, el
      // componente desmontarse, o esta rama quedar obsoleta mientras se esperaba.
      if (!vivo || mia !== generacion || oculta()) return
      if (hay) {
        /**
         * R5 — Pero no encima de una escritura a medias. Recargar entre
         * `leerCola` y `encolar` aborta el apunte: el usuario acaba en la vista y
         * su producto no está, sin ficha y sin aviso. El Borde 1 licencia perder
         * el desplazamiento, no una escritura. Se pospone a la vuelta siguiente,
         * que llega en segundos.
         */
        if (enviandoRef.current) {
          reloj = setTimeout(() => void ciclo(mia), esperaDeSondeo(intento))
          return
        }
        /**
         * Se guarda **incrementado**: si la navegación vuelve a caer en esta
         * misma pantalla, la cadencia escala hasta sostenerse en 30 s en vez de
         * repetir a los mismos 2 s indefinidamente.
         */
        guardarIntento(intento + 1)
        window.location.reload()
        return
      }
      intento += 1
      guardarIntento(intento)
      reloj = setTimeout(() => void ciclo(mia), esperaDeSondeo(intento))
    }

    const arrancar = (desde: number) => {
      generacion += 1
      intento = desde
      clearTimeout(reloj)
      const mia = generacion
      reloj = setTimeout(() => void ciclo(mia), esperaDeSondeo(intento))
    }

    const alCambiarVisibilidad = () => {
      if (document.visibilityState !== 'visible') {
        generacion += 1
        clearTimeout(reloj)
        return
      }
      // Quien saca el móvil del bolsillo quiere que compruebe ya.
      arrancar(0)
    }

    arrancar(intento)
    document.addEventListener('visibilitychange', alCambiarVisibilidad)
    return () => {
      vivo = false
      generacion += 1
      clearTimeout(reloj)
      document.removeEventListener('visibilitychange', alCambiarVisibilidad)
    }
  }, [])

  const sePuedeApuntar = !!grupo && !!usuario

  /**
   * R3 — La regla es la de `lib/cola.ts`, la misma que usa la vista. Los efectos
   * son de aquí: esta pantalla no tiene `avisar` y no debe tenerlo.
   */
  const apuntar = async () => {
    // La guarda va en una ref, no en el estado: dos toques seguidos ocurren antes
    // de que React vuelva a pintar, y `enviando` todavía valdría `false`.
    if (enviandoRef.current) return
    const nombre = texto.trim()
    // R2 de `GroupView` — esto era un `return` mudo allí, y lo volvió a ser aquí:
    // el usuario pulsa y no pasa nada, ni ítem ni explicación.
    if (!nombre) { setAviso(ESCRIBE_NOMBRE); return }
    if (!grupo || !usuario) return
    const cantidadAhora = cantidad.trim() || null

    /**
     * I4 de `GroupView` — El campo se vacía **antes** de esperar al almacén.
     * Medido allí: apuntando seis productos seguidos entraban tres, porque lo
     * tecleado entre el `await` y el vaciado se iba con él.
     */
    setTexto(''); setCantidad(''); setAviso(null)
    enviandoRef.current = true
    setEnviando(true)
    // Y si no se pudo, se devuelve — salvo que ya se esté tecleando otra cosa.
    const devolver = () => {
      setTexto(prev => prev || nombre)
      setCantidad(prev => prev || (cantidadAhora ?? ''))
    }

    try {
      const cola = await leerCola(usuario)
      const decision = decidirEncolar({
        usuario, grupo, nombre, cantidad: cantidadAhora,
        visibles: items ?? [], cola,
        id: crypto.randomUUID(), ahora: Date.now(),
      })
      if (decision.accion === 'duplicado') { devolver(); setAviso(DUPLICADO); return }
      // J6 — si el almacén no admite la escritura no se pinta ficha: el usuario
      // vería su producto, recargaría, y no estaría.
      if (!(await encolar(decision.pendiente))) { devolver(); setAviso(SIN_ALMACEN); return }
      setPendientes(prev => [...prev, decision.pendiente])
    } catch {
      // R3 — sin esto, un throw del almacén se llevaba lo tecleado sin decir
      // nada: la cicatriz del `return` mudo por otra puerta.
      devolver(); setAviso(SIN_ALMACEN)
    } finally {
      enviandoRef.current = false
      setEnviando(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col gap-4 p-4">
      <div className="flex items-center justify-between gap-2">
        {/**
          * R6 — La salida. La navegación la intercepta el service worker y, si
          * sigue sin haber red, devuelve esta misma pantalla en `/`: fuera de un
          * grupo y sin prometer memoria.
          *
          * R1 de la iteración 5 — Y es un enlace **normal**, no `next/link`, con
          * su regla silenciada aquí y sólo aquí. Motivo medido el 2026-09-13:
          * con `next/link`, pulsar sin red hace fallar un fetch del framework, y
          * eso arranca el bucle de `next/dist/esm/client/components/offline.js`
          * —6 HEAD en 10 s al documento autenticado del grupo, cadencia
          * 500ms/1s/2s/3s, sin rendirse— encima de las 2 sondas por minuto que
          * esta pantalla ya hace. Con un enlace normal el framework no ve ningún
          * fetch fallado. La supresión está declarada en el inventario de
          * `unit/puerta-lint.test.ts`, como exige la Spec A.
          */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" data-testid="salida"
           className="flex min-h-11 items-center text-sm text-neutral-400">← Grupos</a>
        {nombreGrupo && (
          <span data-testid="nombre-grupo" className="truncate font-semibold">{nombreGrupo}</span>
        )}
      </div>

      <p role="status" data-testid="sin-red"
         className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800">
        {bannerSinRed({ enUnGrupo: !!grupo, haySesion: !!usuario, hayCopia: items !== null })}
      </p>

      {sePuedeApuntar && (
        <form className="flex gap-2"
              onSubmit={e => { e.preventDefault(); void apuntar() }}>
          <input data-testid="item-name" placeholder="Producto" value={texto}
                 onChange={e => setTexto(e.target.value)}
                 className="min-w-0 flex-1 rounded-xl border border-neutral-700 p-3" />
          <input data-testid="item-qty" placeholder="Cantidad" value={cantidad}
                 onChange={e => setCantidad(e.target.value)}
                 className="w-24 rounded-xl border border-neutral-700 p-3" />
          <button type="submit" data-testid="add-item" disabled={enviando}
                  className="min-h-11 rounded-xl border border-neutral-700 px-4">+</button>
        </form>
      )}

      {aviso && <p role="alert" data-testid="aviso-local" className="text-sm text-amber-800">{aviso}</p>}

      {/**
        * El mismo criterio que el banner: «no hay copia» es `items === null`, no
        * «la copia está vacía». Un grupo abierto y sin productos tiene copia, y
        * decir «necesitas conexión para verlo por primera vez» ahí contradice al
        * banner de encima, palabra por palabra. Medido en la iteración 4.
        */}
      {listo && items === null && !pendientes.length && (
        <p data-testid="sin-instantanea" className="text-neutral-500">
          {grupo ? SIN_INSTANTANEA : SIN_RED_FUERA}
        </p>
      )}

      {(!!items?.length || !!pendientes.length) && (
        <ul className="flex flex-col gap-2" data-testid="items">
          {items?.map(i => (
            <li key={i.id} data-testid="item"
                className="flex items-center gap-2 rounded-xl border border-neutral-200 p-3">
              <span className="min-w-0 flex-1 truncate">{i.name}</span>
              {i.quantity && <span className="shrink-0 text-neutral-500">{i.quantity}</span>}
            </li>
          ))}
          {pendientes.map(p => (
            <li key={p.id} data-testid="pendiente"
                className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-400 p-3">
              <span className="min-w-0 flex-1 truncate">{p.nombre}</span>
              {p.cantidad && <span className="shrink-0 text-neutral-500">{p.cantidad}</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
