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
  inactividad.** Para una lista de la compra familiar el uso es semanal, así que
  el primer acceso tras un parón puede fallar hasta reactivar.
- **Plan Hobby de Vercel: uso personal, no comercial** (*"restricts users to
  non-commercial, personal use only"*). Válido para uso familiar; deja de serlo
  el día que haya usuarios de pago.
