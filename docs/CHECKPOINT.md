# CHECKPOINT

## 2026-09-06 — Esqueleto compartido (spec base + 4 iteraciones)

Primer corte de Super, construido con el ciclo spec → build → review. Al terminar,
una familia puede entrar con Google, crear un grupo, invitar por link, aprobar
solicitudes y editar una lista de la compra que se sincroniza en vivo entre
móviles.

### Qué se construyó

**Producto.** Login con Google · guarda de rutas con destino conservado ·
crear grupo (grupo y membresía de owner en la misma transacción) · link de
invitación revocable y con caducidad · solicitud de ingreso con aprobación
explícita del owner · lista compartida con alta, edición y borrado · tiempo
real entre miembros · expulsar · salir del grupo · cerrar sesión · móvil a
390 px.

**Datos.** 5 tablas, 6 migraciones, 13 funciones, RLS en todas las tablas,
escrituras de pertenencia por RPC `SECURITY DEFINER`.

### Decisiones que conviene no volver a discutir

1. **Los eventos DELETE de Realtime están exentos de RLS.** Es el hecho que
   estructura el diseño entero: ninguna tabla publicada se borra físicamente,
   toda desaparición es un cambio de estado. Está congelado en `CLAUDE.md` B.3.
   El arreglo aparente —`replica identity full` para poder filtrar— es peor que
   el problema: deja el filtro en manos del cliente y el payload lleva la fila
   entera. Descartado con medición.
2. **La pertenencia se resuelve en `is_active_member()`**, `SECURITY DEFINER`
   con `search_path` fijado. Una política que consulta su propia tabla lanza
   `42P17` y deja la app inservible.
3. **El expulsado se entera por un evento positivo sobre su propia fila**, no
   por la ausencia de eventos: la documentación no establece que una suscripción
   abierta se re-autorice al perder el acceso, así que no se depende de ello.
4. **`getSession()` + `setAuth()` antes de suscribirse es necesario**, aunque
   parezca redundante. `createBrowserClient` lee la sesión de las cookies de
   forma asíncrona; sin esperarla, el socket se autentica como anónimo, RLS
   deniega todo y el canal informa `SUBSCRIBED` igualmente. Se quitó, falló, y
   se restituyó con la razón escrita en `lib/useGroupChannel.ts`.
5. **`btrim(x)` con un solo argumento sólo recorta espacios.** El `CHECK` de
   nombre usa `name ~ '\S'`.
6. **`group_members` tiene dos claves foráneas a `profiles`.** Todo embebido de
   PostgREST debe nombrar la relación (`profiles!group_members_user_id_fkey`) o
   devuelve error y deja la lista de miembros vacía.
7. **Las funciones de Postgres nacen ejecutables por `PUBLIC`.** Revocar de
   `anon` no basta; hay que revocar de `PUBLIC` y reconceder lo justo.

### Verificación

**Terminal.** Antes: repositorio vacío, 0 tests. Después:

| Verja | Resultado |
|---|---|
| `pnpm typecheck` | verde |
| `pnpm lint` | verde |
| `pnpm test` (Vitest) | **165 tests en 31 ficheros**, verde |
| `pnpm build` | verde, 6 rutas |
| `pnpm test:e2e` (Playwright) | **19 tests**, verde |

**Runtime.** Los 19 E2E corren contra el **build de producción** (`pnpm build` +
`pnpm start`), no contra el servidor de desarrollo, y desde servidor frío con
`.next` borrado. Lo ejercitado y observado:

- Recorrido completo a 390 px: home, grupo, login, invitación con sesión y sin
  ella, espera de aprobación.
- **Dos contextos de navegador simultáneos**: alta, edición y borrado de un
  ítem llegan al otro sin recargar; el expulsado pierde la lista sin recargar;
  el aprobado pasa de la espera a la lista sin recargar.
- **Red cortada y restaurada** (`setOffline`): la vista anuncia que no está en
  vivo, y al reconectar recupera lo ocurrido durante la desconexión.
- Doble toque real en los botones de añadir y borrar.

**Lo que NO se verificó, por qué, y qué se hizo en su lugar:**

| Sin verificar | Por qué | Qué se hizo |
|---|---|---|
| El flujo real de Google OAuth | No se puede automatizar el login de un tercero | Las sesiones de test se serializan con la propia `@supabase/ssr`, no con cookies fabricadas a mano. Lo que se prueba es el comportamiento de esta app ante una sesión válida |
| Despliegue en Vercel | El proyecto nunca se ha desplegado | Node fijado a 24 LTS en `.nvmrc` y `engines` para que build local y deploy no diverjan |
| El proyecto Supabase hospedado | Sólo se ha usado la instancia local | Las migraciones son idempotentes y se reaplican en transacción revertida |
| El umbral de ~3.000 suscriptores de Postgres Changes | No reproducible aquí | Documentado en `CLAUDE.md` B.3 el punto en que habría que migrar a Broadcast |
| `alter default privileges` para `supabase_admin` | Las migraciones corren como `postgres`, y un rol no puede alterar los de otro (`42501`) | Se intenta y se tolera; la entrada de `postgres`, que es la que gobierna estas tablas, sí quedó limpia y tiene test |

### Trayectoria del ciclo

| Ronda | Qué encontró la revisión | Qué cambió el build |
|---|---|---|
| Base | — | Esquema, RLS, RPCs, app y 23 ítems de DoD |
| 1 | 3 E2E rojos por localizador ciego y campo no controlado; fuga del nombre de grupo a anónimos; redirección abierta; cookies de sesión en artefactos de test | Campo controlado, localizadores por valor, `invite_preview` sin metadatos, `safeNext`, `.gitignore` |
| 2 | `TRUNCATE` sin gobernar por RLS; autoría falsificable; borrados resucitables; 13 llamadas sin cota; tres tests que pasaban en vacío | Revocación de privilegios, trigger de integridad, `boundedFetch`, tests que montan el artefacto |
| 3 | FAIL duro de idempotencia; regresión que acusaba a otro usuario del propio doble toque; guardas inertes | Migraciones idempotentes, guarda en el borrado, centinela en vez de margen ciego |
| 4 | Diagnóstico de encuadre: los hallazgos se repetían con la misma forma | **La regla R-A/R-B**, ahora en `CLAUDE.md` §E, más 7 instancias |

La severidad decayó de forma monotónica: violación constitucional y redirección
abierta → agujero de privilegios → guardas inertes → un botón atascado. La
quinta revisión no encontró nada CRITICAL ni ningún hard fail, y cerró el ciclo.

### Siguiente

`docs/ROADMAP.md` — lo primero es transferir la propiedad y borrar el grupo.
`docs/TECHNICAL_DEBT.md` — lo que quedó vivo, medido y con su motivo.
