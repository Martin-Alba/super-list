<!-- ACTIVE: base -->

# Spec — Esqueleto compartido

Primer corte de Super. Al terminar, una familia puede compartir de verdad una lista: entrar con Google, crear un grupo, invitar, aprobar, y ver los cambios del otro al instante.

## Hechos verificados (no reescribir sin volver a medir)

| Hecho | Cómo se comprobó | Consecuencia |
|---|---|---|
| Realtime autoriza cada evento contra cada suscriptor — **pero sólo INSERT y UPDATE**. Los DELETE están exentos: *"RLS policies are not applied to `DELETE` statements, because there is no way for Postgres to verify that a user has access to a deleted record"* | docs Supabase, Postgres Changes | RLS **no** protege el canal en vivo por sí sola. De aquí sale R18: ninguna tabla publicada se borra físicamente |
| El payload de un DELETE lleva sólo la clave primaria, salvo `replica identity full`; y sin ese ajuste **los filtros no se aplican a los DELETE** | ídem | El arreglo aparente es el peor: `replica identity full` haría que el filtro lo controle el cliente y que el payload lleve la fila entera. Descartado |
| Una tabla no emite eventos hasta ejecutar `alter publication supabase_realtime add table <t>` | ídem | Paso obligatorio de migración (R12). Omitirlo rompe R9 **en silencio** |
| Postgres Changes escala bien hasta ~3.000 suscriptores del mismo cambio | ídem | Correcto para grupos familiares. Broadcast sería complejidad sin beneficio hoy |
| Políticas RLS que consultan su propia tabla lanzan `42P17 infinite recursion detected in policy` | error documentado de Postgres + guía Supabase | Obliga a `is_active_member()` `SECURITY DEFINER` (R11) |
| La documentación **no** establece si una suscripción ya abierta se re-autoriza cuando desaparece el acceso del suscriptor | docs Supabase, Postgres Changes | No se puede depender de ello. R7 y R16 usan un evento positivo, no la ausencia de eventos |
| Plan gratuito Supabase: 500 MB base, 1 GB storage, 200 conexiones concurrentes, 2 M mensajes/mes, y **proyectos pausados tras 1 semana de inactividad** | supabase.com/pricing | Holgado. La pausa por inactividad es el único riesgo operativo real |
| Vercel Hobby: *"restricts users to non-commercial, personal use only"* | docs Vercel, plan Hobby | Válido para uso familiar; deja de serlo si hay usuarios de pago |
| Versiones publicadas: Next 16.3.4, React 19.2.8, `@supabase/supabase-js` 2.115.0, `@supabase/ssr` 0.12.6, Vitest 5.0.0, Playwright 1.62.1 | `npm view <pkg> version` | Son las versiones a instalar |
| Node local v25.2.1; Vercel usa Node 24 LTS | `node -v` + docs Vercel | Divergencia entre build local y deploy: fijar Node 24 (R0) |

## Requisitos

`miembro activo` = fila en `group_members` con `status='active'` cuyo grupo tiene `deleted_at is null`. Cada requisito nombra el mecanismo que lo hace cumplir.

**R0 — Runtime fijado.** `.nvmrc` y el campo `engines` declaran Node 24 LTS. *Mecanismo:* los dos ficheros, leídos por el gate y por Vercel.

**R1 — Login con Google.** Sin sesión, una ruta protegida lleva a `/login` y tras entrar se vuelve **a la ruta pedida**. *Mecanismo:* middleware que compara contra la lista de R2 y conserva el destino; `/auth/callback` intercambia el código por sesión; la fila de `profiles` la crea un **trigger `after insert on auth.users`**, no el código de la app — así no depende de que un camino concreto se ejecute.

**R2 — Rutas públicas enumeradas.** Públicas: `/`, `/login`, `/auth/callback`, `/invite/[token]`. Todo lo demás exige sesión. *Mecanismo:* una lista literal, y un test que afirma que ningún patrón captura una ruta privada.

**R3 — Crear grupo.** El creador queda como `owner` y miembro `active`. *Mecanismo:* una única transacción; un grupo nunca existe sin owner activo.

**R4 — Link de invitación revocable y con caducidad.** Token aleatorio ≥128 bits con `expires_at`; regenerarlo invalida el anterior. *Mecanismo:* `revoked_at` y `expires_at` comprobados **en el servidor**, nunca en el cliente.

**R5 — Solicitar ingreso.** Quien abre un link vigente pasa a `pending` y ve "Esperando aprobación"; no ve la lista, los miembros ni el contenido. *Mecanismo:* la PK `(group_id, user_id)` con `ON CONFLICT` hace idempotente la solicitud; el aislamiento lo da RLS (R10).

**R6 — Aprobar o rechazar.** El owner ve el número de solicitudes y las resuelve. Aprobar → `active`; rechazar → `rejected`, y la persona puede volver a solicitar. *Mecanismo:* `UPDATE` a un estado fijo, idempotente por construcción.

**R7 — Expulsar.** El owner pasa a un miembro a `removed`; éste deja de ver el grupo **sin recargar**. *Mecanismo:* no es un borrado — es un `UPDATE` de estado, y una política que permite a cada usuario leer **su propia** fila de `group_members` en cualquier estado hace que el evento le llegue filtrado por RLS. El owner no puede expulsarse a sí mismo (R15, R16 son sus salidas).

**R8 — Lista compartida.** Un miembro activo agrega, edita y borra ítems. `quantity` es texto libre opcional. Borrar es lógico. *Mecanismo:* `CHECK (btrim(name) <> '')` en la tabla — no validación de cliente; `created_by` por defecto desde la sesión; borrar es `UPDATE deleted_at`, y toda lectura filtra `deleted_at is null`.

**R9 — Tiempo real.** Alta, edición y borrado hechos por un miembro activo aparecen en la sesión de otro **sin recargar**. *Mecanismo:* suscripción a Postgres Changes; el borrado viaja como `UPDATE`, por lo que va autorizado por RLS (ver R18).

**R10 — Aislamiento entre grupos.** Quien no es miembro activo no lee ni escribe ítems, miembros ni metadatos — ni por la UI ni llamando a la API con su propio token. Cubre a no-miembros, `pending`, `rejected` y `removed`. *Mecanismo:* RLS en la base.

**R11 — Pertenencia sin recursión.** *Mecanismo:* `public.is_active_member(uuid)`, `SECURITY DEFINER`, `set search_path = ''`, nombres cualificados. Ninguna política consulta `group_members` en su propio `USING`.

**R12 — Publicación realtime.** `public.items`, `public.group_members` y `public.groups` están en `supabase_realtime`. *Mecanismo:* sentencia explícita en la migración, verificable en `pg_publication_tables`.

**R13 — Móvil.** A 390 px no hay scroll horizontal y los controles de acción miden ≥44 px.

**R14 — Cerrar sesión.** Un usuario cierra sesión y vuelve a `/login`; la siguiente persona en ese teléfono no ve nada del anterior. *Mecanismo:* `signOut` y borrado de las cookies de sesión en el servidor.

**R15 — Transferir la propiedad.** El owner pasa la propiedad a otro miembro activo; queda él mismo como `member` activo. Disponible **sólo si hay más de un miembro activo**. *Mecanismo:* una transacción que actualiza `groups.owner_id` y los dos roles; la condición se comprueba en el servidor.

**R16 — Borrar el grupo.** Sólo el owner. Los miembros que lo tengan abierto dejan de verlo **sin recargar**. *Mecanismo:* `UPDATE groups.deleted_at`; `groups` está publicada (R12), así que el evento llega a los miembros activos filtrado por RLS. `is_active_member` devuelve falso para un grupo borrado, con lo que ítems, miembros e invitaciones quedan inaccesibles sin borrar una sola fila.

**R17 — Salir del grupo.** Un miembro no-owner se pasa a sí mismo a `removed` y deja de ver el grupo. *Mecanismo:* el mismo de R7, con una política que permite al usuario cambiar el estado **de su propia fila** a `removed` y nada más. El owner queda excluido: su salida es R15 o R16.

**R18 — Sin borrado físico en tablas publicadas.** Ninguna operación de la app ejecuta `DELETE` sobre `items`, `group_members` o `groups`; toda desaparición es un cambio de estado. *Mecanismo:* es la regla que neutraliza la exención de RLS en los DELETE — el hecho verificado nº1. Sin ella, cualquier suscriptor recibe los borrados de todos los grupos.

**R19 — Fichero de exclusión.** `.gitignore` excluye `node_modules`, `.next`, y **todo `.env*` salvo un `.env.example` sin valores**. *Mecanismo:* el fichero, comprobado con `git check-ignore`. El repositorio ya está inicializado y sin commits: las claves de Supabase llegan antes que el primer commit.

## Modelo de datos

- `profiles` — `id` (PK, → `auth.users`), `display_name`, `avatar_url`, `created_at`
- `groups` — `id`, `name`, `owner_id` (→ `profiles`), `created_at`, `deleted_at` (nullable)
- `group_members` — PK `(group_id, user_id)`, `status` (`pending` | `active` | `rejected` | `removed`), `role` (`owner` | `member`), `requested_at`, `decided_at`, `decided_by`
- `group_invites` — `id`, `group_id`, `token` (único), `expires_at`, `revoked_at`, `created_by`, `created_at`
- `items` — `id`, `group_id`, `name` (`CHECK (btrim(name) <> '')`), `quantity` (nullable), `created_by`, `created_at`, `updated_at`, `deleted_at` (nullable)

## Ciclo de vida

| Cosa que la spec crea | Nace | Cambia de dueño | Muere | Qué pasa con lo que dependía |
|---|---|---|---|---|
| sesión | R1 | — | R14 | — |
| `profiles` | R1, por trigger al primer login | — | **fuera de alcance** (borrar cuenta), declarado abajo | — |
| `groups` | R3 | R15, sólo con ≥2 miembros activos | R16 (lógico) | ítems, miembros e invitaciones quedan inaccesibles vía `is_active_member`; ninguna fila se borra (R18) |
| `group_members` | R5 | — | R6 (rechazo), R7 (expulsión), R17 (salida) — todo por estado | — |
| `group_invites` | R4 | — | caducidad o revocación (R4) | dejan de servir al morir el grupo (R16) |
| `items` | R8 | — | R8, borrado lógico | — |
| ficheros del repo | los crea `/build` | — | — | R19: las claves nunca entran al control de versiones |

## Casos borde

Cada uno indica qué lo prueba, o por qué no necesita prueba propia.

| # | Caso | Prueba |
|---|---|---|
| 1 | Link expirado o revocado → mensaje claro, **sin** crear membresía | DoD 5 |
| 2 | Un miembro ya activo abre el link → entra directo, no vuelve a `pending` | DoD 6 |
| 3 | Un `pending` reabre el link → una sola solicitud | DoD 7 |
| 4 | Alguien rechazado vuelve a abrir un link vigente → puede volver a solicitar | DoD 7 |
| 5 | Un no-miembro pide la URL del grupo → tratado como inexistente, no como prohibido | DoD 9 (base) y DoD 10 (UI) |
| 6 | Sesión ausente o expirada → se deniega y se redirige a login | DoD 1 — *misma guarda que el caso sin sesión, cubierta en el mismo test* |
| 7 | Dos miembros agregan ítems a la vez → sobreviven ambos | DoD 15 |
| 8 | Un miembro edita un ítem que otro acaba de borrar → 0 filas afectadas, sin éxito falso | DoD 16 |
| 9 | El owner intenta transferir siendo el único miembro → bloqueado | DoD 19 |
| 10 | Token inexistente o malformado → misma respuesta que uno expirado | DoD 5 |
| 11 | El owner borra el grupo con miembros dentro → dejan de verlo en vivo | DoD 20 |
| 12 | Tras transferir, el antiguo owner queda como miembro activo | DoD 19 |
| 13 | Cerrar sesión en un móvil compartido → el siguiente no ve nada del anterior | DoD 22 |
| 14 | Sale el último miembro no-owner → el grupo queda con el owner solo, utilizable | DoD 21 |
| 15 | El grupo está borrado y llega un evento en vivo de uno de sus ítems | *No necesita prueba propia: R18 garantiza que no hay borrado físico y `is_active_member` ya devuelve falso, condición que cubre DoD 9* |

## Fuera de alcance

Se declaran fuera **por su nombre**, no por omisión: borrar la cuenta y llevarse los datos (hasta que exista, nadie puede irse del sistema); purgar de verdad lo borrado lógicamente; papelera o deshacer; "en carrito"; marcar como comprado; precio unitario y total; tienda; imagen del ticket; escaneo OCR; analítica de gastos; productos frecuentes; afinidad entre productos; comparación de precios; notificaciones push; múltiples owners; que un `rejected` no pueda volver a solicitar; escritorio.

## Puerta constitucional

- **A.1** (el grupo es un límite de datos; `pending`, `rejected` y `removed` son no-miembros) → R5, R7, R10, R17, R18.
- **A.2** (el link permite solicitar, nunca acceder) → R4, R5, R6.
- **A.3** (fallar cerrado) → bordes 5, 6 y 10.
- **B.1** (`is_active_member` `SECURITY DEFINER` con `search_path` fijado) → R11.
- **B.2** (toda tabla observada en vivo, en la publicación) → R12.
- **B.5** (el cliente envía intención, no autoridad) → R3, R6, R7, R15, R16, R17.
- **C** (runtime pinneado; los commits son del usuario) → R0, R19.
- **D.2** (sin condiciones de carrera; invariantes en la base) → R3, R8, R15, borde 7.
- **D.3** (sin fugas entre grupos) → R10, R18.
- **D.4** (efectos idempotentes) → R5, R6.

> **Corrección pendiente en la constitución:** B.3 afirma que Postgres Changes "respeta RLS" sin matices. El hecho verificado nº1 lo desmiente para los DELETE. Debe corregirse, o inducirá el mismo error en cada ciclo futuro.

## Definition of Done

Repo nuevo: todo arranca en rojo. Por eso cada ítem declara **qué comportamiento concreto falta** — cada test tiene que seguir fallando aunque el resto de la app ya esté construida.

| # | Prueba que falla primero | Por qué no puede estar en verde antes del cambio |
|---|---|---|
| 1 | `e2e/auth.spec.ts` — sin sesión y con sesión expirada, `/g/<id>` lleva a `/login` y luego vuelve a `/g/<id>` | Sin guarda ni conservación del destino, el usuario cae en la home tras loguearse (R1, borde 6) |
| 2 | `unit/public-routes.test.ts` — ningún patrón de la lista pública captura `/g/<id>` | Un prefijo ancho deja pasar rutas privadas (R2) |
| 3 | `unit/profile-trigger.test.ts` — insertar en `auth.users` crea la fila en `profiles` | Sin el trigger, el perfil depende de que se ejecute un camino de la app y falta en cuanto se entra por otro (R1) |
| 4 | `unit/create-group.test.ts` — tras crear, existe la membresía `owner`/`active` | Crear el grupo sin la membresía en la misma transacción deja un grupo que ni su creador ve (R3) |
| 5 | `unit/invite.test.ts` — token regenerado, vencido, inexistente y malformado: misma respuesta y **ninguna** membresía creada | Sin comprobar `revoked_at`/`expires_at` en servidor el link viejo sirve; y si las cuatro respuestas difieren, el token filtra si existió (R4, bordes 1 y 10) |
| 6 | `e2e/join.spec.ts` — el invitado queda en "Esperando aprobación" y **no ve ningún ítem**; un miembro activo que abre el link entra directo | Si el pendiente ve la lista, la aprobación no es una puerta (R5, borde 2) |
| 7 | `unit/join-idempotent.test.ts` — doble apertura deja **una** fila; un `rejected` que reabre vuelve a `pending` | Sin `ON CONFLICT` sobre la PK el owner ve dos veces a la misma persona; y sin la transición el rechazado queda excluido para siempre (R5, D.4, bordes 3 y 4) |
| 8 | `e2e/approve.spec.ts` — el owner ve el contador, aprueba, y recién entonces el invitado ve la lista | Sin el paso de aprobación nada separa `pending` de `active` (R6) |
| 9 | `unit/rls-isolation.test.ts` — con el token de un `pending`, un `rejected`, un `removed`, un no-miembro y un miembro de un grupo borrado, `select` sobre `items` devuelve **0 filas** | Ataca la base saltándose la UI: sólo pasa si el aislamiento vive en RLS (R10, D.3, bordes 5 y 15) |
| 10 | `e2e/group-404.spec.ts` — un no-miembro recibe "no existe", no "prohibido" | Un 403 confirma que el grupo existe; sólo falla este test (borde 5, A.3) |
| 11 | `unit/rls-recursion.test.ts` — consultar `group_members` como miembro activo no lanza `42P17` | La política ingenua hace fallar este test; sólo pasa con `is_active_member()` (R11) |
| 12 | `unit/realtime-publication.test.ts` — `pg_publication_tables` contiene `items`, `group_members` y `groups` | Es el fallo silencioso: sin esto R9, R7 y R16 no funcionan y ningún otro test se entera (R12) |
| 13 | `e2e/realtime.spec.ts` — **dos contextos**: A agrega, edita y borra; B lo ve en las tres sin recargar | Requisito central, y el único que un test de un solo cliente no puede demostrar (R9) |
| 14 | `unit/items-crud.test.ts` — `name` vacío o de sólo espacios rechazado por la base; `created_by` registrado; borrar deja la fila con `deleted_at` y fuera de las lecturas | R8 no tenía ninguna prueba propia. Con validación sólo de cliente, una llamada directa a la API mete el nombre vacío (R8) |
| 15 | `unit/concurrent-add.test.ts` — dos altas simultáneas: sobreviven las dos | Un patrón leer-modificar-escribir pierde una de las dos y nada más lo delata (borde 7, D.2) |
| 16 | `unit/edit-deleted-item.test.ts` — editar un ítem ya borrado afecta 0 filas y la UI no informa éxito | Un `UPDATE` sin filtrar `deleted_at` resucita el ítem para todos (borde 8) |
| 17 | `e2e/expel.spec.ts` — dos sesiones: el owner expulsa a B y la vista de B se vacía sin recargar | Depende del evento positivo sobre la propia fila; si se implementa como borrado, B no recibe nada y se queda leyendo (R7) |
| 18 | `unit/no-physical-delete.test.ts` — tras expulsar, borrar un ítem y borrar el grupo, las tres filas siguen existiendo con su marca de estado | Es el invariante que neutraliza la exención de RLS en los DELETE; un borrado real pasa todos los demás tests y abre la fuga (R18, D.3) |
| 19 | `e2e/transfer.spec.ts` — con un solo miembro la transferencia está bloqueada; con dos, el antiguo owner queda `member` activo | Sin la comprobación en servidor, un grupo puede quedar sin owner o con dos (R15, bordes 9 y 12) |
| 20 | `e2e/delete-group.spec.ts` — dos sesiones: el owner borra y el miembro deja de ver el grupo sin recargar | Sin `groups` publicada el miembro sigue viendo un grupo que ya no existe (R16, borde 11) |
| 21 | `e2e/leave.spec.ts` — un miembro sale y deja de ver el grupo; el owner no puede usar esa acción | Sin la política acotada, o el miembro no puede salir o puede tocar la fila de otro (R17, borde 14) |
| 22 | `e2e/logout.spec.ts` — tras cerrar sesión, `/g/<id>` lleva a `/login` y no queda rastro del usuario anterior | Un `signOut` sólo de cliente deja la cookie de servidor viva y la siguiente persona entra como la anterior (R14, borde 13) |
| 23 | `e2e/mobile.spec.ts` — a 390 px ninguna pantalla del flujo tiene scroll horizontal | Un layout de escritorio pasa todo lo demás y falla sólo acá (R13) |
| 24 | `unit/runtime.test.ts` — `.nvmrc` y `engines` declaran Node 24 | R0 no tenía ninguna prueba propia; sin ella la divergencia con Vercel se descubre en el deploy (R0) |
| 25 | `unit/gitignore.test.ts` — `git check-ignore` confirma `node_modules`, `.next` y `.env.local`; `.env.example` **no** está ignorado | Sin el fichero, el primer commit se lleva las claves de Supabase, y eso no se deshace borrándolas después (R19) |

**Puerta de terminal:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build` en verde.

**Runtime check:** `pnpm test:e2e` completo y, a mano, `pnpm dev` con dos navegadores en viewport de 390 px haciendo el recorrido entero — crear grupo, invitar, aprobar, editar la lista a cuatro manos, transferir y borrar.
