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

### Spec B — SELLADA el 2026-09-18, acotada al medirla

El borrador entero está en el historial de este fichero (commit anterior a esta línea). Lo
que se selló vive en `docs/spec.md` como **«Lo pendiente sale solo, y la pantalla no dice lo
contrario»**, con tres requisitos: los disparadores del drenado, la afirmación «Lista en
vivo», y el texto del aviso de lo encolado.

**Lo que se cayó al medirlo con el teclado**, y por qué esto queda escrito aquí: la fila
«cuatro de cinco productos desaparecen» era **el mismo artefacto de clics por coordenada que
devolvió la Spec A**. Medido hoy, con la API caída, «Lejia» y «Vinagre» se encolan, pintan su
ficha y avisan. La vista no pierde nada.

### Local primero, retirada de la Spec B y sin decidir

La decisión de hacer la vista local-primero **se retira**: su argumento era que con la
conexión muerta la vista pierde lo tecleado y la cáscara no, y eso es falso. Vuelve aquí como
opción abierta, con la única pregunta que le queda viva y que **no está medida**:

> Contra una API que **cuelga** en vez de rechazar, el alta espera hasta la cota del
> transporte (10 s) con el botón deshabilitado antes de pintar la ficha. Contra un puerto
> cerrado son 54 ms, medidos. ¿Cuánto es contra la Supabase hospedada desde un móvil, y es
> ese hueco suficiente para tocar el camino feliz del alta?

Medir eso es el paso previo a volver a plantearla. Si el hueco es pequeño, la opción muere.

---

### Spec E — La regla de caducidad con un solo dueño, sobre las dos pantallas

**SIN SELLAR.** Sale del ciclo de la Spec B (2026-09-18), y sale **medida**.

**El diagnóstico, que es el motivo de que sea spec propia.** Tres iteraciones seguidas
arreglaron un sitio y descubrieron el siguiente:

| Vuelta | El sitio | Lo que se descubrió al arreglarlo |
|---|---|---|
| iter 1 | El drenado enviaba lo caducado | …y la relectura lo seguía contando como pendiente |
| iter 2 | La relectura | …y el duplicado se decidía contra la cola cruda |
| iter 3 | El duplicado | …y la cáscara no conoce la regla en absoluto |

**La causa no es ninguno de los cuatro sitios: es que la regla no tiene dueño.**
`reparte`/`VIDA_COLA_MS` viven en `lib/local.ts` como función pura, y **aplicarla es
responsabilidad de cada lector**. Así que cada lector nuevo nace sin ella. La iteración 4
unificó los tres de la vista en una función; la cáscara sigue fuera, y con ella un callejón
permanente (deuda 62).

**Lo que la spec tendría que decidir:** si la cola se lee siempre por una puerta que ya
devuelve lo vivo —de modo que leer lo caducado sea imposible en vez de improbable—, y qué pasa
con quien la lea desde un contexto sin React. Medir antes de fijar: hay al menos dos formas
—la puerta en `lib/local.ts` devolviendo ya sólo lo vivo, o un tipo que distinga «cola cruda»
de «cola viva»— y cuál cuesta menos no está medido.

**Lo que el ciclo deja medido y que esta spec hereda** (no vive sólo en la spec borrada):

- **Dos lecturas crudas quedan en la vista**, y están ahí a propósito: `drenarUnaVez` lee cruda
  y su corte lo pone `siguienteEnCola`; `reintentarEnvio` pregunta «¿queda algo de este grupo?»
  sobre la cruda. La segunda **sí gira en vano** cuando el almacén rechaza el borrado: medido,
  10 lecturas en 25 s frente a 2 cuando la entrada se pudo borrar. Se dejó por coste, no por
  inexistente.
- **No hay guarda estructural** que impida una lectura cruda nueva. La fila i4-5 de la Spec B
  declaró esa capa y nadie la atacó; la afirmación se retiró.
- **Aplicar la regla no es haberla aplicado** (deudas 63 y 64): los dos sitios que borran de la
  cola descartan el booleano del almacén, y uno de ellos —el drenado— puede resucitar con eso un
  producto tachado, porque el índice único es parcial.

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
