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

**Datos.** 5 tablas, 7 migraciones, 13 funciones, RLS en todas las tablas,
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

**Terminal.** Antes (2026-09-05): repositorio vacío, 0 tests. Después:

| Verja | Resultado |
|---|---|
| `pnpm typecheck` | verde |
| `pnpm lint` | verde |
| `pnpm test` (Vitest) | **165 tests en 31 ficheros**, verde *(medido el 2026-09-06, al cerrar aquel ciclo)* |
| `pnpm build` | verde, 6 rutas |
| `pnpm test:e2e` (Playwright) | **19 tests**, verde *(medido el 2026-09-06)* |

**Runtime.** Los 19 E2E de entonces (2026-09-06) corren contra el **build de producción** (`pnpm build` +
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

| Ronda | Fecha | Qué encontró la revisión | Qué cambió el build |
|---|---|---|---|
| Base | 2026-09-05 | Esquema, RLS, RPCs, app y 23 ítems de DoD |
| 1 | 2026-09-05 | 3 E2E rojos por localizador ciego y campo no controlado; fuga del nombre de grupo a anónimos; redirección abierta; cookies de sesión en artefactos de test | Campo controlado, localizadores por valor, `invite_preview` sin metadatos, `safeNext`, `.gitignore` |
| 2 | 2026-09-05 | `TRUNCATE` sin gobernar por RLS; autoría falsificable; borrados resucitables; 13 llamadas sin cota; tres tests que pasaban en vacío | Revocación de privilegios, trigger de integridad, `boundedFetch`, tests que montan el artefacto |
| 3 | 2026-09-06 | FAIL duro de idempotencia; regresión que acusaba a otro usuario del propio doble toque; guardas inertes | Migraciones idempotentes, guarda en el borrado, centinela en vez de margen ciego |
| 4 | 2026-09-06 | Diagnóstico de encuadre: los hallazgos se repetían con la misma forma | **La regla R-A/R-B**, ahora en `CLAUDE.md` §E, más 7 instancias |

### Trayectoria del segundo ciclo — el login real con Google

AA10 — La spec se borra al cerrar, así que sin esta tabla siete iteraciones de
aprendizaje no sobrevivirían en ningún sitio. Cada fila es lo que la revisión
midió, no lo que el build creyó haber hecho.

| Iteración | Fecha | Qué encontró la revisión | Qué cambió el build |
|---|---|---|---|
| 5 (N–T) | 2026-09-06 | Dos fallos de producción diagnosticados en el navegador: redirección absoluta que dejaba la cookie en otro origen, y Kong devolviendo 431 porque la cookie de OAuth viajaba al endpoint de realtime | `Location` relativo; separación de hosts (app en `localhost`, Supabase en `127.0.0.1`); se revirtió el adaptador de cookies propio y toda la rama del presupuesto de cabecera |
| 6 (U) | 2026-09-07 | El canal reproduce los eventos del slot tras `SUBSCRIBED`: actuar sobre el primero expulsaba a un miembro activo con su propio `pending` viejo. Medido 6 de 6 | Releer la propia fila antes de navegar; centinela de entrega en el calentamiento; hosts fijados en los scripts |
| 7 (V) | 2026-09-07 | Dos CRITICAL en los instrumentos: el origen se congelaba al importar (`pnpm test` daba 210/211 con un servidor vivo) y el test de eventos viejos cazaba su defecto 2 de cada 4 veces | Origen leído al usarse; precondición observable en el test; corte determinista del WebSocket; **R-C escrita en `CLAUDE.md` §E.4** |
| 8 (W) | 2026-09-07 | *Hard fail* constitucional **en el arnés**: `DELETE` físico sobre tablas publicadas, por tres caminos de cascada; y una sonda tautológica sobre `String.replace` | Banco de calentamiento durable que actualiza en vez de borrar; sonda que ejercita la guarda; cifras del checkpoint fechadas |
| 9 (X) | 2026-09-07 | Las tres guardas nuevas tenían agujeros medidos: la del arnés ignoraba los caminos de cascada, la de literales se cegaba con un `//` dentro de una cadena, y la del checkpoint no comparaba nada | Conjunto peligroso leído del catálogo; despojador por escáner; bloque `ESTADO-VERIFICABLE` comparado con el árbol |
| 10 (Y) | 2026-09-07 | `listUsers` devolvía la página 1 de 7.610 usuarios y el del banco estaba en la 1429: la recuperación llevaba tiempo rota. Seis formas de borrado se colaban | Búsqueda en `auth.users`; sondas **inyectadas en ficheros reales**; despojador por compilador completo |
| 11 (Z) | 2026-09-07 | La regla decía "no borres" y era otra lista de patrones; tres puertas abiertas por resolución incompleta | Detección sobre el AST; lista blanca de RPC; exención por línea |
| 12 (AA) | 2026-09-07 | La resolución seguía fallando **abierta**; la lista blanca daba rojo sobre `leave_group`, que el producto usa | Fallar cerrado: se marca todo `.delete()` no demostrado inofensivo; lista blanca anclada a `pg_proc`; barrido extendido a `app/` y `lib/` |
| 13 (AB) | 2026-09-07 | Dos ítems de DoD incumplidos, y el fallo cerrado daba rojo sobre `cookies().delete()` y `searchParams.delete()` | Resolución **con ámbito**; accesores de plataforma exentos; la guarda de cifras caza la forma de ratio; se afirma que ninguna función de la lista blanca borra |

**Cierre.** La revisión de la iteración 13 verificó la propiedad vigilada con dos
instrumentos independientes de las guardas —el 2026-09-07, barrido AST sobre los
92 ficheros del repositorio, y catálogo de la base— y declaró que **ningún
hallazgo pendiente afecta al
producto**. El ciclo se cerró por la regla de impacto: desde la iteración 7 el
producto no ha producido un defecto, y seguir endureciendo el instrumental ya no
compra corrección, compra más instrumental. Lo pendiente son las entradas 20–26
de `docs/TECHNICAL_DEBT.md`, fechadas.

**Lo que este ciclo enseñó, y está en la constitución:** R-C (§E.4) — un arreglo
que cambia el mecanismo se prueba también por la puerta que abre, y el rojo hay
que verlo **repetido**, no una vez. Cinco iteraciones seguidas la incumplieron
antes de escribirla, y la iteración que la escribió la incumplió al escribirla.

**Y lo que no llegó a regla, pero se pagó cuatro veces:** buscar defectos con
expresiones regulares sobre texto pierde una forma cada vez. Donde hay un árbol,
úsalo; donde el conjunto legítimo es finito, enumera lo permitido.

La severidad decayó de forma monotónica: violación constitucional y redirección
abierta → agujero de privilegios → guardas inertes → un botón atascado. La quinta
revisión de **aquel** ciclo —el del esqueleto compartido— no encontró nada
CRITICAL, y cerró.

**Corregido (V6):** esta frase se leía como si el proyecto entero hubiera quedado
sin CRITICAL, y no es cierto. El ciclo siguiente —el del login real con Google—
encontró CRITICAL en seis iteraciones más, entre ellos dos que este mismo
documento habría dado por cerrados. El alcance de la frase es el ciclo del
esqueleto, no el repositorio.

### Siguiente

`docs/ROADMAP.md` — lo primero es transferir la propiedad y borrar el grupo.
`docs/TECHNICAL_DEBT.md` — lo que quedó vivo, medido y con su motivo.


---

<!-- ESTADO-VERIFICABLE -->
## Estado verificable

X4 — Las cifras de arriba son **registros fechados** de lo que se midió aquel
día, y como tales no caducan. Este bloque es distinto: describe el árbol **tal y
como está**, y `unit/checkpoint.test.ts` lo compara con el árbol de verdad. Si
alguien añade un fichero de prueba y no lo actualiza, la puerta se pone roja.

Existe porque la alternativa ya se probó tres veces y falló las tres: afirmar el
tamaño de la suite en presente y confiar en que alguien lo renueve. La tercera
vez (2026-09-07) el documento decía 221 tests en 36 ficheros cuando eran 245 en
37, y la guarda que debía impedirlo daba verde sobre un documento con cifras
inventadas.

- Ficheros de prueba unitaria: 40
- Ficheros de prueba de navegador: 14


---

# Verificación del cierre (2026-09-07)

## Terminal

| Puerta | Al abrir (2026-09-06) | Al cerrar (2026-09-07) |
|---|---|---|
| `pnpm typecheck` | limpio | limpio |
| `pnpm lint` | limpio | limpio |
| `pnpm test` (Vitest) | 165 en 31 ficheros — 2026-09-06 | **520 en 40 ficheros** — 2026-09-07 |
| `pnpm test:e2e` (Playwright) | 19 — 2026-09-06 | **42** — 2026-09-07 |
| `pnpm build` | verde | verde |

## Runtime — qué se ejercitó y contra qué build

Siempre contra **build de producción con `.next` borrado**, nunca contra el
servidor de desarrollo.

- **Login real de Google, en el navegador.** Sesión cerrada, `Entrar con Google`,
  selector de cuentas, vuelta a `localhost:3000` con sesión y el grupo cargado.
  La URL de autorización confirma la topología: `redirect_to` a `localhost:3000`,
  `redirect_uri` a `127.0.0.1:54321`.
- **El canal entrega.** Fila insertada desde el servidor: aparece sola.
  Actualizada: el nombre cambia solo. Borrada en suave —el camino que usa la
  app—: desaparece sola. Sin recargar.
- **Cabecera real (2026-09-07):** 4.825 B en 3 cookies sobre `localhost:3000`,
  sin aviso degradado y **cero errores de WebSocket en consola**. Antes, 5.430 B
  mataban el canal.
- **R-C, repetida:** con la relectura de `GroupView` revertida y build fresco,
  `e2e/stale-events.spec.ts` cae **4 de 4** (2026-09-07); restaurada, verde. Y
  `unit/stale-membership.test.tsx` cae 1 de sus 4 casos, de forma determinista.
- **Tres pasadas desde frío el 2026-09-07**, las tres 42/42.

## Qué NO se verificó, y qué se hizo en su lugar

- **El tramo de Google no se puede automatizar** (credenciales de un tercero). Se
  ejercita a mano en el navegador —queda arriba— y el flujo PKCE **sí** se
  automatiza entero con un enlace mágico, que recorre el mismo camino:
  `/auth/v1/verify` emite el `code` que `exchangeCodeForSession` canjea.
- **El número de *tests* del checkpoint no lo comprueba ninguna máquina**, sólo el
  de ficheros: haría falta ejecutar las suites desde dentro de una suite. Las
  cifras de prosa son registros fechados.
- **`.env.example` está bajo control de versiones** y los *hard fails* de la
  constitución dicen "cualquier `.env*` dentro del control de versiones", mientras
  `unit/gitignore.test.ts` **exige** que esté seguido. No contiene valores. La
  contradicción es entre la constitución y un test, y **es decisión del usuario**:
  el ciclo no puede resolverla sin cambiar una de las dos.
