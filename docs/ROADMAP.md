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
