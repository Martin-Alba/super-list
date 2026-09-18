# ROADMAP

## Siguiente spec — Ciclo de vida del grupo

Salió de alcance del esqueleto compartido de forma **declarada**, no por
omisión, y es lo primero que se construye. Consecuencia asumida mientras tanto:
**en el corte actual un grupo no se puede borrar ni cambiar de manos, y su owner
no puede abandonarlo.**

1. **Transferir la propiedad.** El owner pasa la propiedad a otro miembro activo
   y queda él como miembro. Disponible **sólo si hay más de un miembro activo**;
   la condición se comprueba en el servidor. Una transacción actualiza los dos
   roles: un grupo nunca puede quedar sin owner ni con dos.
2. **Borrar el grupo.** Sólo el owner. Borrado lógico, nunca físico —regla B.3—,
   lo que exige publicar `public.groups` en `supabase_realtime` para que los
   miembros que lo tengan abierto dejen de verlo sin recargar, e `is_active_member`
   pasa a exigir que el grupo no esté borrado.

Ambos requisitos ya tienen su análisis hecho en el histórico del ciclo: la
columna `groups.deleted_at` y la tercera tabla en la publicación se diseñaron y
se retiraron al recortar el alcance, no se improvisaron.

## Las dos specs que salieron medidas del ciclo del duplicado (2026-09-17)

Vienen del fichero de specs, que se borró al cerrar ese ciclo. **No son ideas: están
reproducidas**, con el sitio y la medida. Se copian enteras para que nadie tenga que
volver a medirlas, y porque el texto original no llegó a entrar en la historia del repo.

Las dos salieron del mismo hallazgo: son **pantalla derivada de un estado durable que
cambia sin avisar**, una familia distinta de la del invariante de escritura que el ciclo
sí construyó.

### A. Releer, notificar y ordenar los escritores — **las tres juntas**

Van juntas y el motivo está medido: **la tercera existe por culpa de la segunda.**

- **Releer.** `GroupView:426→466` retira el aviso de la cola decidiendo sobre una lectura
  anterior a tres `await`. Reproducido: «pan» sigue en la cola y el aviso desaparece.
  Era la «Forma A» de la spec anterior, que decía que iba primero, y no se construyó.
- **Notificar**, su mitad que falta: la cáscara recibe por el canal pero **no** escucha
  `visibilitychange`. Medido: perdido el mensaje, cero relecturas al volver, y sin red no
  se recupera nunca. El comentario que dice que no hace falta es falso y está medido como
  tal. Y el mismo efecto está escrito dos veces con **contenido distinto** en las dos
  pantallas — el §2 de arriba, cometido otra vez.
- **Ordenar los escritores del hueco local.** `setPendientes(prev => [...prev, p])`
  (optimista) y `setPendientes(mios)` (autoritativo, desde la relectura) escriben el
  mismo estado sin orden. Y la pestaña **se oye a sí misma**: publicador y suscriptor son
  objetos distintos del mismo canal. Reproducido con entrega síncrona: `fichas=2 cola=1`.
  Hoy no se manifiesta porque la entrega real llega como tarea y el añadido como
  microtarea — o sea, la corrección descansa en un detalle de planificación que nadie
  vigila.

Además, sin resolver de la spec anterior: el canal es global y se declaró «por usuario»;
y la sonda de ausencia del almacén sólo reconoce una forma de escribir (deuda 56).

### B. El estado que caduca con el reloj, sin observador

`reparte` se evalúa en el montaje y la relectura no lo aplica. Reproducido sin red: un
pendiente entra fresco, pasan 25 h con la pestaña abierta, y **su ficha sigue en
pantalla** prometiendo un envío de algo que el próximo arranque descartará en silencio.

Nadie escribió y nada cambió: lo que se movió fue el reloj. No lo arregla releer —trae el
mismo dato—, ni notificar —no hay nada que notificar—, ni el invariante de la escritura.
Es una familia propia, y la más pequeña de las tres.

---

## Las dos specs vivas al cerrar el ciclo de la guarda de ruta (2026-09-18)

Ninguna está sellada. Se copian enteras porque **están medidas**: borrar el fichero de specs
no debe llevarse el trabajo que ya costó medir.

**Orden sugerido: la D primero.** La C se cerró declarando que la API colgada no está
cubierta, y la D es exactamente ese hueco; la B es una familia distinta que puede esperar.

### Spec D — La guarda no sabe quién cortó, y por eso cualquier cota mueve el problema

**SIN SELLAR.** Draft del 2026-09-18. Sale de los hallazgos #1 y #3 de la segunda revisión
de la Spec C, y del patrón que dejaron tres vueltas seguidas.

## 1. El diagnóstico, que es el motivo de que sea spec propia

Tres revisiones consecutivas, tres HIGH, **la misma forma: un reloj confundido con
evidencia.**

| Vuelta | El HIGH | El arreglo |
|---|---|---|
| iter1 | La cota de 3 s leía «tarda» como «no contesta»: cuatro casos de navegador rojos, tres tardando 15–16 min | Subir la cota a la de red |
| iter2 | Agotar la cota **desviaba**, y eso relajaba R3: sesiones inválidas acababan en la cáscara, con una fila de la valla roja | El timeout cae al destino cerrado |
| iter3 | Poner la cota **por encima** del transporte hace que el reloj del transporte gane siempre y **fabrique** `status 0`: la API colgada desvía otra vez, y el destino depende de la edad del token | *(éste)* |

Cada arreglo movió el problema en vez de cerrarlo, y el tercero lo movió a un umbral —10 s—
**por encima de las latencias del arnés**, así que las filas de la valla que lo cazaron en
la segunda vuelta ya no pueden cazarlo.

**La causa está en el enunciado, no en el valor.** R4 de la Spec C pide *acotar el
veredicto* y no da a la guarda ninguna forma de saber **quién cortó**: si el reloj propio, el
reloj del transporte, o un rechazo de verdad. Los tres llegan como el mismo objeto. Mientras
eso siga así, **cualquier** valor de cota reparte mal alguno de los tres casos.

## 2. Lo medido

- Con la API colgada y token vigente: `/sin-conexion` a los **10.004 ms**, **un solo**
  intento visto en la API. Quien resolvió fue el reloj de `boundedFetch`.
- Con el token **caducado**: `/login` a los **12.005 ms**, con **dos** intentos. Quien
  resolvió fue la carrera del veredicto.
- Un rechazo real y un timeout del transporte llegan **indistinguibles**: mismo `name`
  (`AuthRetryableFetchError`), mismo `status` (0), mismo veredicto. Sólo cambia `message`
  (`"fetch failed"` frente a `"The operation was aborted due to timeout"`), y olfatear el
  texto de un error es lo que `lib/errors.ts` prohíbe por escrito.

## 3. El requisito que falta

**La guarda distingue su propio reloj de un rechazo real**, y decide con eso en vez de con
una clase que no separa los dos casos.

`[OPEN]` **La forma.** El revisor esboza un **segundo controlador**: el intento lleva el
suyo, de modo que la guarda sepa si el corte vino de su reloj, del reloj del intento, o de
la red. **Que la spec lo mida antes de fijarlo** — hay al menos una alternativa (que el
transporte no acote esta llamada y la cota sea sólo la del veredicto), y cuál cuesta menos
no está medido.

## 4. Lo que hereda de la Spec C y no se renegocia

- **R3 sigue sin negociarse:** nadie sin sesión entra. Medido: sin cookies `getUser()` ni
  sale a la red.
- **Un timeout no es evidencia de nada.** Es la frase que la Spec C incorporó en su
  iteración 2 y la que esta spec tiene que hacer cierta también cuando el reloj que vence es
  el del transporte.
- Las **siete filas de la valla** de la Spec C §6 siguen siendo la verja.

## 5. Bordes conocidos, de la revisión

- El caso que hoy defiende «agotar la cota cae al login» (`unit/guarda-sesion.test.ts`)
  conduce la espera con un `getUser` que no resuelve nunca, y el cliente real **no hace
  eso** con una API colgada: el transporte rechaza a los 10 s. Ese caso se rehace cuando el
  mecanismo distinga quién cortó (es el hallazgo #3).

---

### Spec B — La app sabe cuándo no la escuchan, y lo pendiente sale solo

**SIN SELLAR.** Draft del 2026-09-17.

## 1. El problema

La app sólo reconoce **«el sistema operativo dice que no hay red»**. No reconoce el caso
más probable de esta familia: **hay wifi, y el servidor no contesta** — el plan gratuito
pausado, el despliegue caído, el portal cautivo del súper. En ese estado la app se cree
conectada, no encola, no avisa, y lo que se teclea se pierde. Y lo que sí llegó a la cola
se queda ahí **minutos**, mientras la pantalla dice **«Lista en vivo»**.

*Corregido respecto al primer informe:* la cola **no** se queda parada para siempre —
«Mostaza» y «Papel film» llegaron a la base unos 13 minutos después de volver la red. El
defecto no es que no drene: es que **drena cuando le toca a un disparador que la persona
no provoca ni ve**, y que mientras tanto la pantalla afirma estar al día.

## 2. Lo medido

Con el servidor de la app y la API de Supabase parados, y la pestaña ya abierta:

| Qué hice | Qué esperaba | Qué pasó |
|---|---|---|
| Esperar 36 s | El aviso de sin red | **Nada.** `sinRed` nunca se activó. `fetch('/')` falla en **6 ms**; `navigator.onLine` sigue en `true` |
| Apuntar «Lejia» | Ficha pendiente y «se enviará al volver la red» | Campo vacío, sin ficha, sin pendiente, sin mensaje. Perdido |
| Apuntar «Mostaza» | Lo mismo | **Sí** se encoló, con aviso «El servicio está despertando…» |
| Apuntar «Vinagre» | Lo mismo | Perdido |
| **Recargar** | — | La cáscara aparece y **hace todo bien**: avisa, conserva, deja apuntar, y marca lo pendiente con borde discontinuo |
| Restaurar la red entera | Que la cola saliera sola | A los **2,5 minutos**: cola intacta en disco, nada en la base, pantalla diciendo «Lista en vivo». Salió sola **unos 13 minutos** después, por un disparador que el usuario no provoca ni ve |

**El mecanismo de la detección, medido:** `lib/useSinRed.ts` une dos señales —
`navigator.onLine`, que es `true` porque la máquina sí tiene red, y `useOffline()` de
Next, que **no se disparó en 36 s** pese a que el origen falla rápido. El único aviso que
salió fue el del canal: *«Sin conexión en vivo: puede que no veas los cambios de los
demás»* — tranquilizador y falso por omisión, porque tampoco se puede **guardar**.

**El mecanismo del drenado, medido:** ver «Por qué dos y no tres» arriba.

## 3. Alcance

**Entra:** la detección de «no me contestan», el disparador del drenado, y los textos de
los avisos implicados.

**No entra:** la guarda que se traga las altas (Spec A). Tampoco el tiempo de reintento ni
la caducidad de la cola.

## 4. Requisitos (borrador)

**R1 — «No me contestan» es un estado que la app reconoce.** Una API que no responde pone
a la app en el mismo modo que la falta de red: encola, avisa y lo dice. La señal no puede
depender sólo de `navigator.onLine`, que es `true` exactamente en el caso que más importa.

**R2 — El drenado se dispara cuando la cola cambia**, no sólo al montar o cuando `sinRed`
cambia. Una fila que entra en la cola por el camino de fallo con red tiene hoy **cero**
disparadores hasta el próximo arranque.

**R3 — La pantalla no dice «Lista en vivo» mientras haya pendientes sin enviar.** Decir
que la lista está viva con dos productos parados en disco es la pantalla mintiendo sobre
el estado, que es lo que §A.3 prohíbe en el servidor y no tiene sentido permitir aquí.

**R4 — Los mensajes describen la causa y el remedio reales.** «El servicio está
despertando. Suele tardar unos segundos; lo reintentamos solo» se enseñó con la conexión
muerta: promete un reintento que no llegó, y **no dice lo único que tranquiliza** — que el
producto está guardado en el móvil y saldrá al volver la red.

## 5. La decisión de forma: local primero (DECIDIDA, con su coste)

**La vista pasa a ser local-primero, como la cáscara.** Escribir en la cola, pintar la
ficha como pendiente, y drenar. No «intentar el servidor y caer a la cola si acierto a
clasificar el fallo».

**El argumento, y no es de elegancia:** la cáscara no puede equivocarse clasificando
**porque no hay fallo que clasificar** — nunca llama al servidor
(`app/sin-conexion/page.tsx` no importa `addItem`). La vista lleva **dos fallos seguidos
por esa misma dependencia**, ambos escritos en el propio código: `'red'` era una rama
inalcanzable y hubo que sustituirla por `'servidor'` (`GroupView.tsx:982`), y ahora
`'servidor'` tampoco se alcanza cuando la API no contesta. Cada arreglo ha sido **acertar
la clasificación una vez más**. Local primero **elimina la clase**: no hay nada que
acertar, porque el producto ya está guardado antes de que el servidor opine.

Es también lo que la pasada manual enseñó del modo más crudo: con la **misma** conexión
muerta, antes de recargar la vista pierde lo que escribes; después de recargar, la cáscara
te lo guarda y te lo dice. No son dos situaciones: es el mismo estado con dos
implementaciones, y sólo una funciona.

### El coste, declarado

- **Cambia el camino feliz**, que es el que usa todo el mundo y el único que no ha dado un
  solo hallazgo en tres revisiones. El checkpoint tiene cicatrices de tocar justo eso.
- **Cambia el orden en que el usuario ve su producto**: primero local, luego confirmado.
- Los dos caminos ya comparten la **regla** (`lib/cola.ts`) pero no los **efectos** — el
  reparto que la spec del duplicado señaló como causa de escribir dos veces el mismo
  defecto. Unificar los efectos es precisamente lo que faltaba.

Se acepta a cambio de **eliminar la clase de fallo**, no de acertar la clasificación a la
tercera.

### La pregunta que hay que contestar antes de construir — MEDIDA

**¿Qué ve el usuario entre que apunta y que se guarda, y es eso peor que lo de hoy?**

Medido en el navegador contra Supabase **local** —el mejor caso posible, misma máquina,
sin salto de red— cronometrando desde la pulsación hasta que la ficha aparece, con un
observador del DOM y no con temporizadores:

| Muestra | Campo vacío | Ficha en pantalla |
|---|---|---|
| 1 | 1 ms | **401 ms** |
| 2 | 1 ms | **445 ms** |
| 3 | 1 ms | **397 ms** |

**El parpadeo que me preocupaba no aparece, y el argumento se da la vuelta.** Cuatrocientos
milisegundos es el **suelo** —contra la Supabase hospedada, desde un móvil en el súper, son
múltiplos de eso— y está muy por encima del umbral en que algo se percibe instantáneo. Un
pendiente que dura 400 ms no es un destello: es medio segundo de información.

Y lo que hay hoy en esos 400 ms **es nada**: el campo se vacía en 1 ms y luego no ocurre
absolutamente nada hasta que la fila aparece. Local primero no añadiría un estado a un
hueco vacío: lo **llenaría**.

`[OPEN]` Lo que sigue sin medir, y no bloquea la decisión pero sí el diseño:
- Con una red muy rápida y una lista larga, ¿el reordenado al confirmar da un salto visual?
- Si el envío lo rechaza el servidor —no por red, sino por regla—, ¿qué pasa con una ficha
  que la persona ya vio en su lista? La cáscara nunca ha tenido ese caso, porque no habla
  con el servidor.

---

## Después, por orden de valor

3. **"En carrito".** Reserva visible de un ítem mientras alguien va a por él.
   Es una condición de carrera de manual: la reserva se gana con un
   `UPDATE ... WHERE reserved_by IS NULL` atómico, nunca en el cliente.
4. **Cierre de compra.** Marcar como comprado, precio unitario y total, tienda,
   e imagen del ticket (Storage de Supabase, 1 GB en plan gratuito).
5. **Escaneo del ticket con la cámara.** OCR que rellene el cierre de compra.
6. **Analítica de gastos.** Productos frecuentes, afinidad entre productos
   ("siempre que compras zanahorias, también cebollas"), comparación de precios
   por tienda. Es la razón por la que los datos viven en Postgres y no en un
   almacén sin SQL.

## Sin fecha, y declarados fuera

Borrar la cuenta y llevarse los datos · purgar de verdad lo borrado lógicamente ·
papelera o deshacer · notificaciones push · múltiples owners · escritorio.

**Borrar la cuenta merece una nota:** hasta que exista, nadie puede irse del
sistema ni llevarse sus datos. Es una decisión tomada a conciencia para acotar
el primer corte, no un olvido.

## Dos avisos operativos

- **Plan gratuito de Supabase: los proyectos se pausan tras una semana de
  inactividad.** Desde el 2026-09-12, un alta hecha contra el proyecto dormido
  **no se pierde**: entra en la cola local y se envía sola al despertar. Para una lista de la compra familiar el uso es semanal, así que
  el primer acceso tras un parón puede fallar hasta reactivar.
- **Plan Hobby de Vercel: uso personal, no comercial** (*"restricts users to
  non-commercial, personal use only"*). Válido para uso familiar; deja de serlo
  el día que haya usuarios de pago.
