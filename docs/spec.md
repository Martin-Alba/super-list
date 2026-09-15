# Specs

No queda ninguna spec sellada: el fichero sólo lleva trabajo vivo, y el registro de lo
construido está en `docs/CHECKPOINT.md`.

La **Spec B** y sus seis iteraciones —el ciclo de vida de aviso-y-recuperación, hasta
el eje de la duración— se cerraron el 2026-09-15. Cerraron las deudas 40 a 45 y siete
de las nueve vueltas de ese mecanismo. Las otras dos resultaron ser otro problema, y es
el borrador de abajo.

---

# BORRADOR — Pantalla y estado durable

**SIN SELLAR. Sin marcador.** No entra en el bucle hasta que el usuario lo revise.
Cero secciones ACTIVE: no hay nada en construcción.

## 1. El problema, en una frase

La cola de pendientes vive en IndexedDB —durable, compartida por todas las instancias—
y lo que el usuario ve de ella vive en memoria de una sola. **Nada avisa cuando la cola
cambia**, así que la pantalla sólo es correcta mientras nadie más escriba y mientras
quien deriva lo haga sobre una lectura fresca. Las dos cláusulas son falsas hoy.

Sale de las dos últimas vueltas del ciclo de avisos, que **no eran de aquel mecanismo**:
siete de nueve se reproducían con un solo montaje, y estas dos no. El registro de esa
clasificación está en `docs/CHECKPOINT.md`.

## 2. Los tres caminos medidos

| # | Camino | Qué pasa | ¿Cuándo |
|---|---|---|---|
| 1 | `drenarUnaVez` deriva de `cola` leída en `:406` y usada tras tres `await` | La rama sin red de `onAdd` es la única que encola **sin** tocar `envio.current`, así que la guarda de generación no dispara. El bucle termina sobre su instantánea vieja | **Reproducido 3/3 con UNA instancia.** Era el CRITICAL de la novena vuelta; el arreglo se retiró y por eso hoy no está en el árbol |
| 2 | Nadie vuelve a mirar la cola tras el bucle | `reintentarEnvio` es lo único que la relee y sus esperas suman 23 s (`lib/errors.ts`). Si otra instancia la vacía después, el aviso «se enviará al volver la red» se queda para siempre sobre una cola vacía | **Reproducido 2/2 en navegador con dos pestañas reales** |
| 3 | `meterEnCola` lee la cola en `:340`, decide «duplicado» con `decidirEncolar`, y escribe tras `await encolar` en `:357` | Dos altas concurrentes pasan las dos el chequeo de duplicado | **Anterior a este ciclo.** No medido en ejecución: entra como `[ASSUMPTION]` de §7 |

## 3. Qué no existe hoy, verificado

- **IndexedDB no emite eventos de cambio.** `lib/local.ts` es `get`/`put` plano sobre
  `conTienda`; no hay observador posible en la API.
- **Cero `BroadcastChannel`** en el árbol de la app.
- **Cero listeners de `storage`** — y no servirían: son de `localStorage`, no de
  IndexedDB.
- El único precedente de «volver a mirar» es `app/sin-conexion/page.tsx:227`, con
  `visibilitychange`, y es para su propio sondeo.

**Y hay un segundo escritor de la cola fuera de este componente:** la cáscara sin red
encola en `app/sin-conexion/page.tsx:277`. Cualquier mecanismo que se elija tiene que
contarla, o nace incompleto.

## 4. Las dos formas, medidas — y el hallazgo: no son alternativas

**Forma A — releer en cada punto donde se deriva.**
*Coste:* una lectura de IndexedDB por derivación. Los puntos son tres: la retirada del
aviso, la de las fichas, y el chequeo de duplicado de `meterEnCola`. `leerCola` es un
`getAll` filtrado en memoria; se ejecuta ya cuatro veces en los caminos normales
(`:340`, `:383`, `:406`, `:570`), así que añadir una o dos no cambia el orden de
magnitud.
*Qué arregla:* los caminos **1 y 3**.
*Qué NO arregla:* el **2**. Releer no ayuda si nadie llega a releer: tras el bucle no
queda ningún punto de derivación al que llegar.

**Forma B — notificación entre instancias (`BroadcastChannel`).**
*Coste:* un canal, un listener y un `postMessage` por escritor. **Cero dependencias
nuevas**: es API del navegador. Verificado que existe en `jsdom` y en `node`, así que
es **probable con dos raíces en el arnés unitario**, sin navegador.
*Qué arregla:* el **2**.
*Qué NO arregla:* el **1**. Verificado ejecutando: `BroadcastChannel` **no entrega al
que publica** (medido: `el emisor recibe su propio mensaje: false`), así que la
escritura concurrente de la propia instancia no se notifica a sí misma. Y aunque lo
hiciera, la instantánea local seguiría rancia: haría falta releer igual.

**La decisión, con su motivo: las dos, y en este orden.** No son dos opciones para el
mismo defecto: cada una cubre un camino que la otra deja abierto, y eso está medido, no
razonado. Elegir una sola sería cerrar la mitad y declarar el problema resuelto — que es
exactamente el error que produjo las dos últimas vueltas.

**A va primero** porque es la que evita **pérdida de señal para el usuario**: el camino 1
borra de la pantalla algo que sigue pendiente de enviar, y si el usuario lo reescribe,
`decidirEncolar` le contesta «ya está en la lista» sobre una pantalla donde no está. El
camino 2 deja un aviso de más, que es mentira pero no esconde nada.

**B va después y con `visibilitychange` como red**, porque un canal sólo entrega a
quien está escuchando: una pestaña que se abre más tarde no recibe lo que se emitió
antes. Al montar ya se relee (`:570`), así que el hueco real es la pestaña que estaba
abierta y en segundo plano — y ésa sí recibe. `visibilitychange` cubre el caso de un
mensaje perdido y el de un escritor que no publique.

## 5. Requisitos

**R1 — Toda derivación de la pantalla a partir de la cola parte de una lectura que no
cruza un `await`.** Los tres caminos de §2.

**R2 — Cuando otra instancia cambia la cola, ésta se entera.** Un canal por usuario;
todo escritor publica —incluida la cáscara sin red—; quien recibe, **relee y re-deriva**,
no aplica el mensaje. El mensaje es una señal de «mira otra vez», nunca un dato.

**R3 — La señal sobrevive a no haberla oído.** Al volver la visibilidad se relee, por si
el mensaje se perdió o lo escribió alguien que no publica.

**R4 — El chequeo de duplicado deja de ser check-then-act.** Camino 3. La forma exacta
se decide al sellar: puede ser releer justo antes de escribir, o una clave única en el
almacén, que es lo que §D.2 prefiere.

## 6. Fuera de alcance, por su nombre

- **El mecanismo de avisos.** El reducer, la duración, el peso y la identidad en la
  acción están cerrados y no se tocan. Esta spec **usa** `despachar`, no lo modifica.
- **La lista de productos.** Sólo la cola de pendientes y lo que de ella se muestra.
- **Sincronizar entre dispositivos.** Esto es entre pestañas del mismo navegador; entre
  dispositivos ya lo hace Realtime, y es otra cosa.
- **La caducidad de la cola**, su orden y su idempotencia.

## 7. Suposiciones a resolver al sellar

- **`[ASSUMPTION]`** — que el camino 3 es alcanzable de verdad. Está razonado sobre el
  código y **no ejecutado**, y esta spec nace de dos vueltas perdidas por concluir sin
  ejecutar: se prueba con una sonda que dispare dos altas concurrentes, o se declara no
  probado.
- **`[ASSUMPTION]`** — que `BroadcastChannel` funciona en el arnés de navegador con dos
  contextos. Verificado en `jsdom` y `node`; falta verificarlo en Playwright con dos
  páginas.
- **`[ASSUMPTION]`** — que la cáscara sin red puede publicar sin arrastrar el mecanismo
  de avisos consigo. La Spec C la dejó con su propio `setAviso` a propósito, y hay que
  comprobar que el canal no la reacopla.

## 8. Lo que ya está escrito y espera a esta spec

Dos pruebas se retiraron del ciclo anterior **conservando su texto** en
`unit/drenado.test.tsx`, porque vigilan exactamente esto: «si otra pestaña drena la cola,
ésta retira su aviso igual» y su gemela de las fichas. Son la **primera comprobación en
rojo** de esta spec, y ya se sabe que fallan.
