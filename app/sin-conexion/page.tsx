'use client'

import { useEffect, useRef, useState } from 'react'
import { alCambiarLaCola, encolar, leerCola, leerLista, leerNombre, leerUltimoUsuario } from '@/lib/local'
import { haySesionLocal } from '@/lib/sesionLocal'
import { decidirEncolar } from '@/lib/cola'
import { safeNext } from '@/lib/routes'
import { bannerSinRed, DUPLICADO, ESCRIBE_NOMBRE, esperaDeSondeo, sinInstantanea, SIN_ALMACEN,
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
/**
 * Spec C / iter3 R1 — **A dónde queremos llegar**, que desde la entrada nueva no es donde
 * estamos. La guarda de ruta manda aquí con el destino en `next`, y `/sin-conexion` es ruta
 * **pública**: preguntarle al servidor por la URL actual la contesta 200 siempre, así que la
 * pantalla se recargaba sobre sí misma en bucle —medido: 4–5 recargas en 20–30 s, y lo que
 * la persona estaba escribiendo perdido en cada una— sin volver al grupo ni con la API ya
 * de vuelta.
 */
/**
 * iter3 R6 — Haber llegado **por la guarda** es prueba de que el servidor de la app
 * contestó: fue él quien redirigió aquí. O sea que la red está en pie y quien no responde
 * es el servicio de datos, y el banner puede decirlo en vez de hablar de conexión.
 */
function nextConservado(): string {
  return safeNext(new URLSearchParams(window.location.search).get('next'))
}

function destinoDeSalida(): string {
  if (window.location.pathname !== '/sin-conexion') return window.location.href
  const next = nextConservado()
  /**
   * #8 — Un `next` que apunta a la **propia cáscara** no es un destino: sondearlo da una
   * respuesta que el criterio de abajo descarta por su ruta, y la pantalla no se recupera
   * jamás. La guarda nunca lo escribe, pero a mano se alcanza.
   */
  if (next === '/' || next.startsWith('/sin-conexion')) return window.location.href
  return new URL(next, window.location.origin).href
}

/** #9 — El mismo hecho, derivado y no releído: dos lecturas podían discrepar. */
const llegadaPorLaGuarda = (): boolean => destinoDeSalida() !== window.location.href

/**
 * iter4 R2 — La sonda dice **por qué**, no sólo sí o no. `sin-red` es el caso en que la
 * petición ni sale: es la única señal fiable de que la red se fue, y con ella el banner
 * puede dejar de afirmar que el servidor contestó.
 */
type Desenlace = 'salida' | 'sin-salida' | 'sin-red'

async function haySalida(): Promise<Desenlace> {
  const ctrl = new AbortController()
  const reloj = setTimeout(() => ctrl.abort(), 2_000)
  try {
    /**
     * Se pregunta por **la URL que se va a navegar**, no por `/`. Medido en la
     * revisión: con la sonda en `/`, un origen que contesta mientras `/g/<id>`
     * sigue cayendo recarga cada 2 s para siempre.
     */
    const res = await fetch(destinoDeSalida(), { cache: 'no-store', signal: ctrl.signal })
    if (!res.ok) return 'sin-salida'
    /**
     * No se rechaza *toda* redirección: sin sesión, `proxy.ts` manda `/g/<id>` a
     * `/login`, y exigir `!res.redirected` dejaba la cáscara encerrada para
     * siempre — medido, 40 s con la red ya de vuelta. Lo que se exige es que el
     * destino siga siendo **nuestro origen**: un portal cautivo que redirige
     * fuera sigue rechazado, y el login propio no.
     */
    if (new URL(res.url).origin !== window.location.origin) return 'sin-salida'
    /**
     * iter3 R1 — Y acabar **en la cáscara** no es haber salido. Con la API caída, el
     * destino redirige aquí: aceptarlo como salida es el bucle de recargas que esta
     * iteración cierra.
     */
    if (new URL(res.url).pathname === '/sin-conexion') return 'sin-salida'
    /**
     * R5 — Un portal cautivo contesta 200 a todo, y este repositorio ya paga esa
     * defensa dos veces en el worker. Límite escrito: un portal que sirva 200 y
     * HTML **en nuestra URL** sigue siendo indistinguible sin leer el cuerpo en
     * cada sonda, y eso cuesta más de lo que ahorra; el daño duradero —guardar su
     * HTML— lo impide el worker, que es donde estaba el problema.
     */
    return /text\/html/i.test(res.headers.get('content-type') ?? '') ? 'salida' : 'sin-salida'
  } catch {
    // Ni salió la petición: la red se fue. Distinto de «salió y no hay salida».
    return 'sin-red'
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
  const [porLaGuarda, setPorLaGuarda] = useState(false)
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
        /**
         * Spec C / iteración 2 — El grupo sale de la ruta **o del destino conservado**.
         * La guarda de ruta manda aquí cuando no puede comprobar la sesión, y entonces la
         * ruta es `/sin-conexion`: el grupo al que se iba viaja en `next`. Medido con el
         * gesto: sin esto la cáscara decía «necesitas conexión» teniendo la copia delante.
         *
         * `next` es **intención, no autoridad** (§B.5). Sólo dice *qué buscar*: lo que
         * decide qué se puede leer sigue siendo la marca de último usuario, porque la
         * clave de la instantánea lleva dentro al usuario del dispositivo
         * (`<usuario>:<grupo>`). Un `next` fabricado hacia el grupo de otra persona no
         * encuentra clave. Y pasa por `safeNext` como en los otros sitios que lo consumen.
         */
        // #11 — anclado: el requisito dice «éste es el destino», no «en algún sitio de esta
        // cadena». Sin el ancla, `next=/login?volver=/g/<uuid>` entregaba ese grupo.
        const delCamino = (ruta: string) => /^\/g\/([0-9a-f-]{36})/i.exec(ruta)?.[1] ?? null
        setPorLaGuarda(llegadaPorLaGuarda())
        const g = delCamino(window.location.pathname)
          ?? delCamino(nextConservado())
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
   * Spec «pantalla y estado durable» / R5 — La cáscara también pinta fichas de una
   * cola que otra instancia puede vaciar, y nada se lo decía: es el mismo defecto
   * que en la vista del grupo, en la otra pantalla. Recibe la señal del almacén y
   * **relee**, igual que allí — el mensaje no lleva dato.
   *
   * No hace falta añadir `visibilitychange`: esta pantalla ya lo escucha para su
   * sondeo (más abajo), y el sondeo recarga la página entera cuando la red vuelve.
   * Lo que faltaba era enterarse **sin** que la red vuelva.
   */
  useEffect(() => {
    if (!usuario || !grupo) return
    return alCambiarLaCola(() => {
      void (async () => {
        setPendientes((await leerCola(usuario)).filter(p => p.grupo === grupo))
      })()
    })
  }, [usuario, grupo])

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
      const desenlace = await haySalida()
      const hay = desenlace === 'salida'
      // Se vuelve a mirar **después** del await: la pestaña pudo ocultarse, el
      // componente desmontarse, o esta rama quedar obsoleta mientras se esperaba.
      if (!vivo || mia !== generacion || oculta()) return
      /**
       * iter4 R2 — Llegar por la guarda probaba que el servidor contestó **entonces**, y
       * una URL sobrevive a una recarga en la que no participó: medido, cortando la red y
       * recargando, el service worker sirve la cáscara de caché y el banner seguía
       * afirmando que el servicio era el que fallaba. La primera sonda que ni sale lo
       * desmiente, y cuesta menos de un ciclo (≤2 s).
       */
      if (desenlace === 'sin-red') setPorLaGuarda(false)
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
        // iter3 R1 — Se navega **al destino**, no se recarga la URL actual: recargar
        // `/sin-conexion?next=…` vuelve a la cáscara aunque la API ya conteste.
        const destino = destinoDeSalida()
        if (destino === window.location.href) window.location.reload()
        else window.location.assign(destino)
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
      /**
       * Spec E / R4 — Por la puerta. Esta pantalla **no conocía la regla en absoluto**
       * —su línea de importación no traía `reparte` ni `VIDA_COLA_MS`—, así que pintaba
       * como pendiente una entrada caducada y rechazaba volver a apuntar ese producto
       * contra ella, sin salida: aquí esa pantalla no descarta nunca. Ahora la recibe
       * sin pedirla, que es de lo que va esta spec.
       */
      const cola = await leerCola(usuario)
      const decision = decidirEncolar({
        usuario, grupo, nombre, cantidad: cantidadAhora,
        visibles: items ?? [], cola,
        id: crypto.randomUUID(), ahora: Date.now(),
      })
      // R4 — Un solo sitio para el duplicado, igual que en la vista del grupo: lo
      // ve `decidirEncolar` o lo ve el almacén, y el usuario lee lo mismo.
      const esDuplicado = () => { devolver(); setAviso(DUPLICADO) }
      if (decision.accion === 'duplicado') { esDuplicado(); return }
      /**
       * J6 — si el almacén no admite la escritura no se pinta ficha: el usuario vería
       * su producto, recargaría, y no estaría.
       *
       * R2 — Y se distingue de «ya estaba», igual que en la vista del grupo: el
       * almacén es la red para lo que `decidirEncolar` no pudo ver. Esta pantalla entra
       * en la spec porque es uno de los dos llamadores; dejarla con el contrato viejo
       * la haría decir «no se pudo guardar» sobre algo que sí está guardado.
       */
      const puesto = await encolar(decision.pendiente)
      if (puesto === 'rechazado') { devolver(); setAviso(SIN_ALMACEN); return }
      if (puesto === 'ya-estaba') { esDuplicado(); return }
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
    <main className="mx-auto flex w-full min-h-dvh max-w-md flex-col gap-4 p-4">
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
        {bannerSinRed({ enUnGrupo: !!grupo, haySesion: !!usuario, hayCopia: items !== null,
          servicioCaido: porLaGuarda })}
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
          {grupo ? sinInstantanea(porLaGuarda) : SIN_RED_FUERA}
        </p>
      )}

      {(!!items?.length || !!pendientes.length) && (
        <ul className="flex flex-col gap-2" data-testid="items">
          {items?.map(i => (
            <li key={i.id} data-testid="item"
                className="flex items-center gap-2 rounded-xl border border-neutral-200 p-3">
              <span className="flex-1 truncate">{i.name}</span>
              {i.quantity && <span className="shrink-0 text-neutral-500">{i.quantity}</span>}
            </li>
          ))}
          {pendientes.map(p => (
            <li key={p.id} data-testid="pendiente"
                className="flex items-center gap-2 rounded-xl border border-dashed border-neutral-400 p-3">
              <span className="flex-1 truncate">{p.nombre}</span>
              {p.cantidad && <span className="shrink-0 text-neutral-500">{p.cantidad}</span>}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
