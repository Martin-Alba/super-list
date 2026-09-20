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

- **El salto de alcance de la iteración 10 (2026-09-08).** Este ciclo se selló
  con ocho requisitos de comportamiento visible (R1–R8). R3 decía: *«ninguna
  acción de servidor enseña el texto crudo de la base»*. En la **iteración 10**
  lo convertí, sin declararlo y sin que nadie lo pidiera, en un requisito
  distinto y mucho más duro: **demostrar estáticamente que ningún refactor futuro
  podría enseñarlo**. De ahí salieron ocho iteraciones seguidas sobre
  instrumentos.

  El coste, medido el 2026-09-08:

  | | líneas |
  |---|---|
  | Motor de contaminación y guardas derivadas (`contaminacion`, `textoCrudo`, `traductor`, `muertos`, `fugaDeError`, banco) | **1.511** |
  | Tests que los ejercitan (`texto-crudo`, `acciones`, `cota-sesion`) | **1.973** |
  | Instrumentos de apoyo (`trayectoria`, `producto`) | 123 |
  | **Total instrumental** | **3.607** |
  | Producto, en el mismo ciclo (2026-09-08) | 8 ficheros, +673 / −99 |

  Ninguna de esas 3.607 líneas la ejecuta un usuario. La última iteración que
  arregló un defecto que un usuario podía sufrir en la app funcionando fue la
  **8**; de la 9 a la 17, todos los CRITICAL fueron fugas **hipotéticas** —
  «inyectando esto en una copia, el crudo llegaría a la pantalla con la suite en
  verde»—, nunca observadas en el código que se ejecuta.

  Lo que hay que recordar de esto no es que las guardas sobren: dos de ellas
  encontraron cosas reales. Es que **R3 pedía un comportamiento y yo lo leí como
  un teorema**, y esa lectura no la declaré, así que nadie pudo discutirla hasta
  diecisiete iteraciones después. Si vuelve a pasar, la señal es ésta: varias
  rondas seguidas cuyo hallazgo sólo se puede demostrar mutando el código.

- **Por qué no paró el ciclo en la iteración 5, que es lo que manda su propia
  regla (2026-09-08).** El techo se evaluó **una vez**, en la 11: se paró, se
  presentaron tres salidas y el usuario eligió atacar el origen. Después de eso
  esa elección se trató como mandato permanente y la regla **no se volvió a
  evaluar** en las iteraciones 12 a 17. Dos errores concretos, para no repetirlos:
  el veredicto del revisor («ANOTHER ITERATION») se tomó como una instrucción
  cuando la decisión de parar es del orquestador; y la etiqueta CRITICAL se
  confundió con *impacto declarable*, que es lo que la regla pide de verdad.

- **Qué se puede registrar de un error de la base (AG8, 2026-09-08).** Nada del
  error se escribe en ningún registro de servidor: ni el mensaje, ni `details`,
  ni `hint`, ni el objeto. Sí el **código** (`error.code`), que es un
  identificador de cinco caracteres sin datos de nadie, y la clase. La razón no
  es teórica: el `details` de un `23505` real trae el UUID del grupo y el nombre
  del producto que escribió otra persona, así que un registro «para depurar»
  copia datos de un usuario a un sitio donde no debería estar. La guarda de
  `unit/textoCrudo.ts` lo hace cumplir sin excepción para logs: registrar el
  error entero es una fuga como cualquier otra.
  *Esta decisión existe porque AF9 la pidió y se quedó sin fila de DoD, que es
  exactamente la cicatriz de la deuda 23.*

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

---

### Trayectoria del tercer ciclo — que ningún fallo se quede sin contar

> **Z5** — Esta sección se insertó **delante** del párrafo de cierre del ciclo
> anterior, y con eso ese párrafo pasaba a leerse como el cierre de éste: afirmaba
> que ningún hallazgo pendiente afectaba al producto y que desde la iteración 7 el
> producto no había producido un defecto. Falso para este ciclo — cinco de sus
> iteraciones arreglaron defectos de producto. El fichero cuyo propósito es no
> mentir mentía por reubicación, sin que nadie cambiara una palabra.

Origen: un pase de QA adversario sobre la app funcionando (2026-09-07) que
encontró lo que 520 tests y 42 E2E no veían, porque nadie había escrito el caso.

| Iteración | Fecha | Qué encontró la revisión | Qué cambió el build |
|---|---|---|---|
| base (R) | 2026-09-08 | — | El código del error viaja con el mensaje; los tres caminos de fallo hablan; índice único para duplicados; cantidad editable |
| 1 (S) | 2026-09-08 | Dos ítems de DoD verdes sin estarlo; `getByRole('alert')` chocaba con el anunciador de Next (15 rojos de 30) | Localizador propio; `42501` del trigger separado del de RLS; el aviso se pinta antes de consultar la sesión |
| 2 (T) | 2026-09-08 | La cobertura no cubría: la fila ida se retiraba por un camino de cuatro, el sellado del aviso por uno de cinco | Retirada por cualquier salida; `limpiarAviso` único; guarda de fugas por contaminación |
| 3 (U) | 2026-09-08 | Dos defectos de producto con una raíz común: el borrador era **un objeto para toda la lista** | Borrador por fila; traductor único e importado; el crudo de Postgres deja de viajar al cliente |
| 4 (V) | 2026-09-08 | Con el canal degradado, una edición correcta se revertía en pantalla | La escritura devuelve la fila y se funde; `?next=` en el enlace de volver a entrar |
| 5 (W) | 2026-09-08 | El arreglo de la 4 abrió el inverso: la fusión pisaba el cambio ajeno | La fusión cede por `updated_at`; el despojado de CTE cuenta paréntesis |
| 6 (X) | 2026-09-08 | **La clave de orden no ordenaba**: `now()` es la hora del `BEGIN`, y los pares concurrentes quedaban invertidos — 3 de 300 visibles a resolución de milisegundo; midiendo en microsegundos, **entre 41 y 86 de cada 300** — el rango observado en seis tandas (86, 61, 50, 41, 42, 41). Se da el rango y no un suelo porque el suelo ya no sobrevivió dos veces a la remedición | `clock_timestamp()` en el trigger; una sola contaminación compartida |
| 7 (Y) | 2026-09-08 | El mismo defecto un nivel más arriba: la columna de hora la podía escribir **el cliente**. Y dos mecanismos de producto se podían retirar sin un solo rojo | Trigger `before insert or update` y `grant` por columna; tests de que el trigger está enganchado; la cota de `avisar()` deja de poder desaparecer |
| 8 (Z) | 2026-09-08 | La columna de al lado: `id` seguía siendo escribible, y el comentario de la migración decía lo contrario | `id` fuera del `grant`; banco compartido de 25 formas para las dos guardas |
| 9 (AA) | 2026-09-08 | La guarda del único ítem de producto **no podía ponerse roja**: apuntaba a un uuid fijo que ya existía, dejado por el propio experimento de R-C | Uuid aleatorio y código afirmado; cuerpo conciso e IIFE; la exención de la cota exige el símbolo importado |
| 10 (AB) | 2026-09-08 | Las guardas decidían por la **forma sintáctica** de la salida, no por si el dato estaba contaminado. Demostrado sobre los ficheros reales con la suite en verde: una fuga del crudo de Postgres y la cota de D.6 retirada. Y la cabecera del banco disparaba la guarda ella sola | Las dos guardas deciden con la contaminación; once formas de flujo cazadas; `id` y `deleted_at` fuera del `grant insert` |
| 11 (AC) | 2026-09-08 | El patrón no se rompió, se desplazó: las guardas ya decidían por contaminación **del valor** y seguían enumerando **la salida** —cuatro sitios en una, dos en la otra—, y la cota llevaba un segundo motor escrito a mano. Medido: seis formas sacan el crudo de `app/actions.ts` y catorce retiran la cota de D.6, con la suite en verde | La lista de salidas se borra: la contaminación tiene que morir en el traductor. Un solo motor con dos semillas; punto fijo de verdad; banco con mitad negativa |
| 12 (AD) | 2026-09-08 | El patrón se desplazó de la salida a la **entrada**: la contaminación seguía naciendo de un nombre literal, así que `res.error.message` —la forma idiomática de supabase-js— era invisible, y las guardas de fuga barrían 2 de los 21 ficheros. La raíz no estaba en las guardas: `Result.error` (crudo) y `ActionState.error` (traducido) tenían el mismo nombre y el mismo tipo | Se retira el texto crudo del producto: `Result` lleva la **clase**, no el mensaje. La propiedad deja de necesitar análisis — fuera de `lib/errors.ts` nadie lee `.message`, y el barrido pasa a 21 ficheros |
| 13 (AE) | 2026-09-08 | El invariante declarado era **más estrecho que la promesa**: prohibía `.message` y nada más. Medido con la puerta en verde, 4 de 9 formas escapaban —`String(error)`, `.hint`, `JSON.stringify`, plantilla— y el `details` de un `23505` real trae el UUID del grupo y el producto de otra persona. Y `activeItems` seguía **lanzando el objeto crudo** fuera del módulo | El objeto tampoco sale: `activeItems` devuelve `Result`; `ActionState.error` pasa a `mensaje`, así que `error` en producto significa una sola cosa; y la guarda pasa de un campo a la promesa entera sobre 22 ficheros |
| 14 (AF) | 2026-09-08 | **Una premisa de mi spec era falsa, y la corrección también**: dije que la fuga de `details` no llegaba a la capa que la app lee porque los ocho errores medidos venían con `details: null`. Generalizar eso fue mío y es falso — medido el 2026-09-08 contra el stack local, el `23514` de `create_group` llega con `details = "Failing row contains (23cc0c19-…, zzzz…, 080c7201-…)"`: el identificador del grupo y la fila entera. La fuga existe. Y tres defectos de la misma familia: el test de la fuga por `catch` **renombraba el parámetro a la semilla**, las aserciones del ancla afirmaban sobre copias de sí misma, y el censo de código muerto dejaba escapar 3 de 6 funciones y 8 de 11 campos | El error se siembra por **posición** —rechazo de promesa y `catch`—, no por nombre; el ancla sale a su módulo y se dirige con corpus sintéticos; el censo se hace con el árbol; el e2e del `42501` lo provoca de verdad |
| 15 (AG) | 2026-09-08 | Mi propio arreglo del lavado por `code`, aplicado en un sitio y no en el otro: envolver el crudo en un campo llamado `code` lo llevaba de `createGroupAction` a la pantalla con 1093/1093 en verde. Y tres exenciones que se heredaban en vez de ganarse — el traductor eximía por el nombre importado, `console.error` contaba como error de la base, y `error['code']` no recibía el trato de `error.code` | La exención mira de quién se lee; **se calcula** qué funciones del traductor sanean de verdad; la cota alcanza el parámetro desestructurado, el método y el corchete; el ancla mira tres letras y deja las minúsculas |
| 16 (AH) | 2026-09-08 | AG1 un nivel más adentro, en código que AG1 escribió: `esElErrorMismo` aceptaba **cualquier** `x.error` sin mirar si `x` estaba sucio, así que envolver el crudo en un objeto con un campo `error` lo sacaba a la pantalla — el JSON entero de PostgREST, con la fila de otra persona, y con 60/60 e2e en verde. Y dos aserciones que no podían fallar dentro de los ficheros escritos para cerrar §E.3 | El receptor del `.error` tiene que estar limpio; la cota cruza el fichero para encontrar accesores de auth; la guarda de textos lee el JSX de los avisos; el cálculo de saneamiento cuenta los parámetros desestructurados |
| 17 (AI) | 2026-09-08 | Tres rondas cerrando el envoltorio del error y ninguna cerró **el objeto que lo trae**: `const res = await supabase.rpc(…)` dejaba `res` limpio, y `res` contiene `error.message`, `error.details` y `error.hint`. Seis formas medidas sacaban el crudo con la puerta entera en verde, y la diferencia entre la forma segura y la fuga era destructurar o no. Y `accesoresDeAuth()` devolvía las cuatro acciones de servidor y cero accesores | La semilla es el **origen**, y de un resultado sólo salen limpios `data`, `count`, `status` y `statusText`; la cota reconoce el símbolo importado en sus cinco formas de salir; «entregar» es devolverlo, no contenerlo; la guarda de textos decide por dónde muere el texto |
| 18 (AJ) | 2026-09-08 | **Corrección de la 17, no una vuelta más.** Sembrar el origen dejó la cadena del cliente contaminada, y la regla de «expresión máxima» subía hasta el nodo más externo: una exención de fuera tapaba el cuerpo de un callback, que es otro ámbito. Medido: una fuga dentro del `.then(…)` de `GroupView.tsx` devolvía `[]` y antes de la 17 se cazaba. Y `res.error?.code` pasó a marcarse, contradiciendo la política de registro del propio checkpoint | Cada cuerpo de función es su propia raíz; el receptor que **es** el resultado sigue siendo el error; el parámetro desestructurado de un callback se mancha |

**Lo que este ciclo enseñó, y no estaba escrito:** R-C se cumple hacia abajo. Un
arreglo puede ser correcto y apoyarse en algo que no lo es — la fusión de la
iteración 4 era buena y su clave de orden no ordenaba. Preguntar "¿qué puerta
abre?" no basta: hay que preguntar también "¿sobre qué se apoya?".

**Cierre del segundo ciclo** (el del arnés que falla cerrado). La revisión de su iteración 13 verificó la propiedad vigilada con dos
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

---

## 2026-09-09 — Que la app funcione donde se usa (PWA con cola local + la pausa del plan gratuito)

Entrega pedida por el usuario: la app se queda en el plan gratuito de Supabase, y
la lista se abre en un supermercado. Dos cosas: **apuntar sin conexión** y
**explicar el primer acceso tras la pausa** del proyecto, aprovechando para saldar
la deuda 7 de `lib/errors.ts`.

### Qué se construyó

- **Un traductor de errores que clasifica por código, no por texto** (`lib/errors.ts`).
  Toda respuesta de PostgREST trae código; **no traer ninguno** es la firma fiable
  de que no ha contestado nadie que hable PostgREST. Con eso más el estado de red
  del navegador salen tres estados distinguibles: sin red del usuario, servidor
  dormido, y fallo real. El mensaje de proyecto pausado no se puede clasificar por
  texto: llega como `{message:"Project is paused"}`, sin código y sin estado.
- **Cola local en IndexedDB** (`lib/local.ts`): apuntar sin red, caducidad a 24 h,
  drenado FIFO de uno en uno al volver la conexión. La idempotencia no la pone el
  bucle: la pone el índice único de la base — reenviar un alta que ya entró
  devuelve `23505`, y eso es éxito.
- **Service worker escrito a mano** (`public/sw.js`) y **shell estático**
  (`app/sin-conexion/`) para el arranque en frío sin red. El shell **no lleva
  dato de nadie**: lo estático va a Cache Storage, lo del usuario a IndexedDB,
  que es lo único que `olvidarTodo` puede vaciar.
- **PWA instalable** (`app/manifest.ts`, iconos generados sin dependencias).

### Decisiones que conviene no volver a discutir

- **Ninguna navegación se cachea.** La primera versión guardaba el documento y eso
  resultó ser un fallo duro de A.1: medido, 9.851 B con el nombre del grupo y sus
  ítems, sobreviviendo al cierre de sesión y legibles por otro usuario del mismo
  dispositivo con sólo navegar. Un documento renderizado con sesión es dato de
  alguien; en un disco compartido no entra.
- **Quién está dentro se registra en el layout, y en ningún otro sitio.** Estuvo en
  la vista del grupo y llegaba tarde; se movió a las páginas con sesión y seguía
  llegando tarde, porque la rama `pending` gana antes y la página de invitación
  redirige sin renderizar. Medido con dos sesiones reales: un `pending` abría sin
  red la URL del grupo de otro y veía su lista.
- **El shell exige sesión en el dispositivo antes de pintar la instantánea.** La
  marca dice *de quién* es la foto, no *quién* está mirando. Medido con Chromium:
  borradas las cookies y sin red, una pestaña nueva pintaba la lista del anterior.
  Fuera de alcance, escrito: quien pueda fabricar la cookie o abrir el almacén con
  las herramientas del navegador ya tiene el dispositivo.
- **La sesión la lee el navegador, no el servidor.** Preguntarla en el layout
  añadía dos viajes a `/auth/v1/user` por render sobre los que ya hacen el proxy y
  la página: medido en el mismo camino autenticado, **15 → 11** peticiones, y con
  el servicio de auth colgado el peor caso bajaba de 20,0 s a 10 s. Para una clave
  local no hace falta autoridad: un id equivocado sólo encuentra cero
  instantáneas, que es fallar cerrado.
- **Nada entra en la caché sin decir qué es, y una instalación a medias no deja
  nada escrito.** Un portal cautivo contesta 200 y HTML para todo: sin
  comprobarlo, un chunk pedido bajo esa wifi se guardaba como si fuera código, y
  como los estáticos se sirven de caché sin revalidar, el dispositivo quedaba con
  una app que no arranca ni con red ni sin ella.

### El techo del ciclo disparó, y se escaló

En la quinta iteración la revisión seguía devolviendo HIGH. La regla dice parar y
escalar, y se paró: **no se decidió seguir por criterio propio**. El usuario eligió
una vuelta acotada a dos hallazgos, y esa vuelta —la sexta— destapó un CRÍTICO que
ella misma había introducido, que también se arregló por ser suyo, no alcance
nuevo.

Los dos recuentos, leídos en cada vuelta: **iteraciones que arreglaron algo que un
usuario sufre en el producto funcionando: 6 de 6**. Ninguna vuelta fue de
instrumentos solos, y el segundo número no adelantó al primero en ninguna ronda.
Es lo contrario del ciclo de 18 iteraciones de 2026-09-08, donde el último defecto
alcanzable por un usuario se arregló en la octava.

### Trayectoria del cuarto ciclo — la app sin conexión

> **Aviso de etiquetas.** Las marcas que este ciclo dejó **en el código** son
> `I`–`M` (`I1`…`I10`, `J1`…`J8`, `K1`…`K8`, `L1`…`L7`, `M1`…`M4`), y esas letras
> ya las había usado el primer ciclo: `I10` significa dos cosas distintas en dos
> ficheros. Se descubrió al cerrar, con 242 ocurrencias repartidas y rangos
> numéricos que se solapan, así que renombrarlas con una expresión regular no es
> posible sin leer cada sitio. La columna de esta tabla lleva el **código global**,
> que es el que el ancla de la trayectoria exige monótono; la última columna dice
> qué marca buscar en el código. Anotado en `docs/TECHNICAL_DEBT.md` 39.

| # | Fecha | Qué encontró la revisión | Qué cambió (marca en el código) |
|---|---|---|---|
| base | 2026-09-08 | — | Traductor por código, cola local, service worker, shell, manifiesto, indicador de red (sin marca) |
| 2 (AK) | 2026-09-08 | El worker cacheaba el documento: 9.851 B con datos de un grupo legibles por otro usuario del dispositivo | Ninguna navegación se cachea; shell estático; instantánea sólo con red; reintento del servicio dormido (marcas `I…`) |
| 3 (AL) | 2026-09-09 | `/sin-conexion` no era pública: el precacheado guardaba el 307 al login, y el arranque en frío daba `ERR_FAILED` a todo usuario real. Y un `pending` veía sin red la lista de otro | Ruta pública; el precacheado rechaza redirecciones; registro de usuario al layout; el cerrojo del drenado deja de tragarse trabajo (marcas `J…`) |
| 4 (AM) | 2026-09-09 | La puerta de terminal estaba **roja** y se declaró verde: se leyó el recuento, no el código de salida. Y el shell pintaba la instantánea sin comprobar que quedara sesión | La puerta se lee por su código de salida; el shell exige cookie de sesión; el almacén informa en vez de romper; el layout deja de preguntar por la sesión (marcas `K…`) |
| 5 (AN) | 2026-09-09 | Tres requisitos de la vuelta anterior resueltos a medias: `open()` que lanza, la cantidad cruzada, y el arnés arreglado en un sitio y no en su estructura | `try` dentro del ejecutor; se devuelve el alta entera o nada; la marca del anterior se quita antes de borrar; dos tests que no podían fallar, arreglados (marcas `L…`) |
| 6 (AO) | 2026-09-09 | **Techo disparado y escalado.** El usuario acotó a dos: el vaciado con red pisaba lo tecleado, y los recursos del shell se daban por buenos | Una sola forma para los dos caminos; los recursos del shell son el shell; y lo que la propia vuelta abrió: nada entra en caché sin decir qué es, y una instalación fallida se purga (marcas `M…`) |

### Siguiente

`docs/ROADMAP.md` — lo primero es transferir la propiedad y borrar el grupo.
`docs/TECHNICAL_DEBT.md` — lo que quedó vivo, medido y con su motivo; las entradas
31 a 38 salieron de este ciclo.


---

# 2026-09-18 — Lo pendiente sale solo, y la pantalla no dice lo contrario (Spec B, base + 5 iteraciones)

Sexto ciclo. Sale de la pasada manual de la deuda 52 y se selló **acotando el borrador al
medirlo**: la afirmación que lo sostenía —«lo que se teclea se pierde, cuatro de cinco
productos desaparecen»— resultó ser **el mismo artefacto de clics por coordenada que devolvió
la Spec A**. Con el teclado, nada se pierde.

## Qué se construyó

**Producto.** Dos disparadores nuevos del drenado —la cola que cambia, y el canal que vuelve a
estar vivo— · «Lista en vivo» calla mientras haya pendientes sin enviar · texto propio para el
hecho «encolado», que no promete un reintento muerto ni culpa a nadie · lo caducado deja de
publicarse al grupo · el aviso de lo encolado y el del descarte se anuncian como **estado**, no
como alerta roja · una sola puerta de lectura de la cola en la vista · y el descarte deja de
anunciarse cuando el almacén no lo aceptó.

**Lo que se retiró del borrador, por medición.** «Local primero» entera: su argumento era que
la vista pierde lo tecleado y la cáscara no, y las dos hacen lo mismo. Vuelve al roadmap con la
única pregunta que le queda viva y sin medir.

## Decisiones que conviene no volver a discutir

- **El disparador del canal es evidencia, no un reloj.** La suscripción aceptada es el servidor
  contestando. Es la distinción que la Spec D lleva tres vueltas pagando, y aquí salió gratis.
- **R1 promete un intento por disparador, no una cola siempre vacía.** El límite está escrito
  en el requisito, y por eso ninguna vuelta intentó alargar el bucle de reintento.
- **El aviso que gana es el que contesta al gesto.** De las tres salidas de `meterEnCola`, el
  descarte sólo se anuncia donde no compite. Escrito con su argumento, no heredado.
- **El índice `items_nombre_unico` es PARCIAL.** `WHERE deleted_at IS NULL`. La iteración 1
  metió un arreglo justificado por escrito con lo contrario —«el reenvío choca con 23505»— y
  con el producto tachado ese reenvío **crea fila nueva**: resurrección. Lo peor es que
  `unit/duplicados.test.ts` ya lo afirmaba **y explicaba por qué**, doce meses antes de que yo
  escribiera lo contrario sin leerlo.

## Los dos números del ciclo

**51 hallazgos de revisión en cinco vueltas: 22 de producto y 29 de sostén.** (La clasificación
es mía, no del revisor.)

| Vuelta revisada | Producto | Sostén |
|---|---|---|
| base | 3 | 4 |
| iteración 1 | 5 | 6 |
| iteración 3 | 4 | 7 |
| iteración 4 | 5 | 6 |
| iteración 5 | 5 | 6 |
| **Total** | **22** | **29** |

**La iteración 2 no tiene revisión independiente**, y se declara: quien encontró su defecto fue
**la comprobación a mano**, que midió falsa la frase «con i2-R2 el callejón se cierra». Ese es
el argumento más fuerte que deja este ciclo a favor de la pasada manual.

## Terminal

| | Antes del ciclo | Después |
|---|---|---|
| Casos unitarios | 1.605 | **1.639** |
| Ficheros unitarios | 67 | **68** |
| Casos de navegador | 89 | **91** |

Medido el **2026-09-18**, al cerrar: `pnpm typecheck` 0 · `pnpm lint` 0 warnings ·
`pnpm test` 1.639 de 1.639 · `pnpm build` 0 con `.next` borrado · `pnpm test:e2e` 91 de 91,
exit 0. Y la suite unitaria verde en **tres corridas seguidas** (2026-09-18), tras cerrar la no
determinación de `unit/shell.test.tsx` (deuda 61).

**Pasada de mutación:** 21 mutantes, 19 cazados, 2 supervivientes —las dos NEUTRA declaradas—,
0 no aplicables, con baseline verde comprobado antes de mutar. **Y una segunda pasada, de
navegador**, que la de unidad no puede alcanzar: apaga cada disparador por separado y corre la
única fila que prueba R1 en su capa. Medido el 2026-09-18: sin el disparador del canal, **roja las tres vueltas**; sin el de la
cola, verde las tres — o sea que esa fila no depende de él, y ahora está **dicho** en vez de
supuesto.

## Runtime — qué se ejercitó y contra qué build

Siempre contra `next start` sobre un `pnpm build` con `.next` borrado, con Supabase local
entero, y **direccionando cada elemento por identidad, nunca por coordenada**.

- **El defecto original, reproducido:** API parada, producto apuntado con el teclado, 72 s con
  la cola llena —el bucle de reintento dura 23—, la API vuelve, y a los **5 segundos** el
  producto está en la base sin que nadie recargue ni pulse. Antes: **seis minutos** de muestreo
  continuo con la cola intacta, el canal vivo y un alta nueva viajando por esa misma conexión.
- **El callejón del duplicado**, encontrado a mano y cerrado: una caducada del mismo nombre ya
  no bloquea volver a apuntar el producto.
- **El reparto de avisos**: con una caducada de por medio y el servicio caído, en pantalla queda
  `EN_COLA` —la respuesta al gesto— y no el descarte.

## Qué NO se verificó, y qué se hizo en su lugar

- **La rama «sin red» de la decisión de avisos no se pudo forzar desde la página** (haría falta
  `navigator.onLine` en `false`). Cubierta en unidad por i4-1 y cazada por la pasada.
- **La cáscara sin red no se tocó.** No conoce la regla de caducidad y allí el callejón es
  permanente. Deuda 62 y **Spec E**.
- **El bundle viejo costó una medición.** La primera vuelta de la comprobación a mano midió
  sobre la pestaña abierta desde antes del `build` y dio un falso negativo. Es la cicatriz del
  bundle mutado, pagada entera.

## El hallazgo que cierra el ciclo: aplicar la regla no es haberla aplicado

Cinco vueltas, la misma familia: **la regla de caducidad no tiene dueño.** Vive como función
pura en `lib/local.ts` y **aplicarla es responsabilidad de cada lector**, así que cada lector
nuevo nace sin ella. Cada iteración arregló un sitio y descubrió el siguiente: el drenado, la
relectura, el duplicado, el reparto de avisos, y por fin **el comprobante** — los dos sitios que
borran de la cola descartaban el booleano del almacén.

Ahí se alcanzó el techo y se escaló. El usuario acotó a una vuelta más. Lo que queda —el
callejón con el almacén rechazando (63), la resurrección por el drenado (64)— sale como deuda y
tiene su marco en la **Spec E**, que es el diagnóstico y no el síntoma.

## La otra lección, esta del método

**Una referencia que se dirige por posición mide otra cosa en cuanto el fichero se reflowa.** Es
la misma forma que el artefacto de coordenadas de la Spec A, y este ciclo la pagó cuatro veces:
siete de las doce filas de la valla se rompieron cuando una iteración añadió diez líneas a un
fichero de tests; una acabó señalando la aserción del test contrario; la pasada de navegador
arrancó gritando «baseline rojo» sobre un árbol bueno porque se dirigía al caso por número; y la
vuelta que arregló las citas se dejó 29 en su propio registro. La valla se pasó a **citar por
nombre de test**, que no se desplaza. Lo que falta es la guarda automática: deuda 66.

Y la segunda: **un motivo para no hacer algo también es una afirmación.** Declaré que perseguir
un test intermitente era «ensanchar el alcance», apoyándome en un diagnóstico que no había
medido; el arreglo real era **una línea**, y el diagnóstico escrito era falso.



---

# 2026-09-19 — La regla de caducidad con un solo dueño (Spec E, base + 3 iteraciones)

Séptimo ciclo, y el primero cuyo problema **no era un defecto sino una forma de fallar**: la
regla de las 24 h vivía como función pura y aplicarla era responsabilidad de cada lector, así
que cada lector nuevo nacía sin ella. El ciclo anterior lo pagó cinco vueltas seguidas, cada
una arreglando un sitio y descubriendo el siguiente.

## Qué se construyó

**La puerta.** `leerCola` filtra en cada lectura y **no borra**; `barrerCaducados` barre, honra
el booleano del almacén y devuelve también lo vivo. Son dos mecanismos distintos porque no
disparan a la vez: filtrar toca en **cada** lectura, barrer toca **una vez y en alguien que
pueda hablar**. `encolar` decide el duplicado contra lo vivo. `quitarDeCola` dice si **había**
fila. Y una guarda estructural sobre el AST prueba que ninguna fila se usa sin la regla.

**Medido al empezar, y corrigió al borrador:** no eran «tres sitios en la vista y un cuarto en
la cáscara», eran **ocho lectores**, de los que sólo dos aplicaban la regla. El octavo —
`encolar`, con su propio `getAll` dentro de su transacción— no llama a `leerCola`, así que
ninguna búsqueda por ese nombre lo encontraba, y era el mecanismo exacto de la deuda 63.

## Decisiones que conviene no volver a discutir

- **El dueño vive dentro de la lectura**, por el mismo argumento que puso el anuncio dentro de
  la escritura: lo que no se puede pedir no se puede olvidar pedir.
- **Filtrar y barrer son dos.** Fusionarlos hizo que los lectores que no anuncian se quedaran
  la cuenta, y una caducada desaparecía del disco **sin que nadie se lo dijera al usuario**.
- **`encolar` no puede dejar de leer por su cuenta** sin romper el invariante del duplicado,
  que exige leer dentro de su misma transacción de escritura. Por eso la puerta no es única:
  lo único que puede ser único es **el sitio donde la regla se aplica**.
- **B7 no era un límite.** «Cerrarlo exigiría que `IDBObjectStore.delete` dijera si la fila
  existía» es cierto de `delete` y falso del almacén: `encolar` lleva tres specs leyendo y
  escribiendo dentro de una misma transacción.

## Los dos números del ciclo

**39 hallazgos de revisión en cuatro vueltas: 12 de producto y 27 de sostén.**

| Vuelta revisada | Producto | Sostén |
|---|---|---|
| base | 5 | 6 |
| iteración 1 | 4 | 10 |
| iteración 2 | 2 | 9 |
| iteración 3 | 1 | 2 |
| **Total** | **12** | **27** |

**Y la proporción es el motivo de que el ciclo pare donde para.** La base y la iteración 1
arreglaron cosas que un usuario toca. Las iteraciones 2 y 3 fueron casi enteras de instrumento,
y la vuelta que la última revisión proponía habría sido la tercera seguida: la regla de las dos
cuentas dice parar y decirlo. Se dijo.

## Terminal

| | Antes del ciclo | Después |
|---|---|---|
| Casos unitarios | 1.639 | **1.684** |
| Ficheros unitarios | 68 | 68 |
| Casos de navegador | 91 | **92** |

Medido el **2026-09-19**, tras la cuarta vuelta: `pnpm typecheck` 0 · `pnpm lint` 0 avisos ·
`pnpm test` 1.684 de 1.684 · `pnpm build` 0 con `.next` borrado · `pnpm test:e2e` 92 de 92,
exit 0. (Al cerrar la tercera eran 1.678; las seis que faltan son la valla nueva del perímetro.)

**Pasada de mutación:** 13 mutantes, 12 cazados, 1 superviviente —la NEUTRA declarada—, 0 no
aplicables, con línea base verde, **veredicto por repetición — 3 de 3 el 2026-09-19**, **testigo
nombrado** en
cada captura, y una **ronda de navegador** que reconstruye antes de correr. Y dos piezas nuevas
que salieron de un accidente: una **trampa de señales** que devuelve los `.bak` y una
**precondición de entrada** que se niega a mutar encima de lo que dejó otra corrida. Corrida
tres veces el **2026-09-19** con el mismo resultado, la última con el script ya corregido, que
cierra con `PASADA: OK` y **un código de salida que transporta el hallazgo** — antes era 0
siempre, ver abajo.

## Runtime — qué se ejercitó y contra qué build

Contra `next start` sobre un `pnpm build` con `.next` borrado, Supabase local, y **cada elemento
por identidad, nunca por coordenada**. Sembrados en la misma cola un pendiente de 25 h y uno
vivo, y comprobadas **las dos pantallas**: ni la vista ni la cáscara enseñan el caducado; la
vista lo descarta y lo dice con `role="status"`; la cáscara no lo enseña y **no lo barre**, que
es el límite declarado en §7. Y el callejón que allí era permanente —volver a apuntar ese
producto— entra. Artefacto: `.claude/fathom/spec-e/gesto-2026-09-19.md`.

## Qué NO se verificó, y qué se hizo en su lugar

- **Los cuatro escapes que la guarda no cierra.** Sólo se pueden enseñar añadiendo código que
  no existe; anotados con su forma exacta en la **deuda 67**. La cuarta vuelta tampoco los
  persiguió: repara la valla del límite, no las formas de dentro.
- **La ronda de navegador de la pasada corre una vez**, no tres como las de unidad: deuda 68.
- **Una pasada muerta a media faena se detecta en la corrida siguiente, no cuando ocurre**:
  deuda 69, con las dos muertes medidas y el silencio de las cinco puertas reproducido.
- **La cáscara no barre.** Declarado en §7, y comprobada a mano la mitad que sí recibe.

## El hallazgo que cierra el ciclo: una ausencia sellada sin su límite

R2 pedía demostrar que **ninguna fila se usa sin la regla** — una ausencia sobre todo lo que el
lenguaje admite. `spec` tiene la regla exacta para eso: *un requisito que pide demostrar que
algo no ocurre necesita, antes de sellar, qué cuenta como prueba suficiente y qué queda fuera;
la ausencia no tiene final natural.* **No se aplicó al sellar**, y el precio fueron tres vueltas
persiguiendo formas: cada ronda cerraba unas y la siguiente encontraba más.

El límite está escrito ahora, y su forma es la que hace el problema finito: **el perímetro**.
`lib/local.ts` es el único fichero del producto que abre IndexedDB —comprobado, con su sonda—,
así que la guarda que lee ese fichero alcanza a todo; dentro, cubre las quince formas medidas y
no todas las posibles. Perseguir formas dentro era infinito; afirmar el perímetro es finito.

## La otra lección, ésta de la pasada

Una pasada de mutación **muta ficheros del repositorio**, así que puede morir a media faena, y
lo que deja es indistinguible de trabajo hecho. Pasó: la mató **el techo de diez minutos del
comando que la lanzó** —no un timeout ajeno, como decía la primera redacción de esta línea: la
pasada no cabía, y llamarlo «ajeno» escondía la causa— y dejó
`lib/local.ts` mutado con un respaldo suelto — y como el mutante en vuelo era **el que no cambia
comportamiento**, todas las puertas daban verde y la entrega habría pasado por buena. La regla
está ahora en `build`: la comprobación del árbol es **dos**, una trampa a la salida y una
precondición a la entrada, porque la salida es justo lo que un proceso muerto no puede honrar. Y
se compara por **huella**, no corriendo la suite: una suite verde dice que el árbol funciona, no
que sea el mismo.

## La cuarta vuelta, y por qué se hizo después de haber cerrado

El cierre se declaró con el límite de R2 escrito. Una revisión independiente lo atacó y midió
que **la valla de ese límite no podía fallar en la dirección que importa**: la sonda del
perímetro inyectaba el fichero sembrado con `.concat()`, o sea **después** del recorrido y del
filtro de extensión — las dos piezas que deciden el alcance—, así que reducir el recorrido a
`lib` sola, dejando de mirar toda la capa de vista, dejaba las dos filas verdes. Lo comprobado
no era el perímetro: era que `lib/local.ts` contiene la cadena `indexedDB`.

Eso no es una mejora opcional: es la premisa con la que se cerró. De ahí una cuarta vuelta,
**declarada como lo que es —la cuarta seguida de puro instrumento, sin una línea de producto—**
y acotada a la valla y a la pasada.

**Lo que se arregló, y lo que se puso rojo antes de arreglarlo:**

- **El recorrido se afirma.** Tiene que llegar a las cuatro capas —vista, cáscara, módulo,
  service worker y el `proxy.ts` de la raíz—. Rojo contra el recorrido de entonces, que no
  miraba `public/sw.js` ni `proxy.ts`; y encogido a `['lib']` da **2 filas rojas, 3 de 3**.
- **El nivel superior del repo se enumera entero**, cada entrada dentro o fuera con su motivo.
  Es lo que hace **finita** la afirmación del perímetro, que era el argumento del límite: un
  directorio nuevo con código no puede quedarse fuera en silencio.
- **El detector es el compilador, no un regex.** La misma regla que este fichero ya aplicaba a
  `puertas()` — una ausencia no se comprueba con `grep` — llegó por fin al perímetro. Antes
  fallaba en las dos direcciones: marcaba un **comentario** que nombrara la API, y no veía
  `import { openDB } from 'idb'` ni `g['indexed' + 'DB']`. Los comentarios y las cadenas no son
  nodos del AST, así que el falso positivo se cierra por construcción.
- **Las sondas siembran en disco**, en un árbol temporal, para pasar por el recorrido y por el
  filtro de extensión. Incluida una en `.js`, que es la extensión del service worker.
- **Las tres puertas del almacén siguen sin exportar**, afirmado. Es lo que de verdad hace
  cierto el perímetro: con `conTienda` exportada, un fichero nuevo leería la tienda **sin
  nombrar `indexedDB` jamás**, y entonces las dos mitades de la prueba fallan a la vez.

**Y los dos defectos de la pasada, que son la regla nueva de `build` en su primera aplicación:**

- **La mitad de la trampa no existía.** `trap … INT` es inerte cuando el script se lanza de
  forma asíncrona: bash le pone `SIG_IGN` a `SIGINT` en un shell no interactivo de fondo, y una
  señal **ignorada al entrar no se puede atrapar**. Medido 3 de 3: el `.bak` se quedaba en
  disco y la pasada **seguía juzgando mutantes**. La garantía vive ahora en `TERM`/`HUP`, con la
  medida escrita al lado; `INT` se conserva porque en primer plano sí funciona.
- **El código de salida era 0 siempre.** La cola acababa en `if/else` y en
  `correr && echo || echo`: las dos formas devuelven 0, así que imprimía
  `EL ARBOL NO QUEDO COMO ESTABA` y salía 0 igual. Comprobado extrayendo la cola verbatim con
  la huella forzada a diferir: antes 0, ahora **1**, y cierra con una línea de veredicto.
  Los dos logs anteriores terminaban en `P=0` y ese cero no desmentía nada.

**La lección, que es la de siempre y esta vez me tocó a mí:** el límite que cierra un requisito
de ausencia **es él mismo una afirmación que necesita su sonda**. Escribí «el perímetro es
finito y se comprueba» y lo respaldé con una prueba que no podía fallar si el perímetro se
encogía a cero. La regla de §E.3 —*decir en una línea qué cambio del producto pondría rojo este
test*— es exactamente la que no apliqué a la fila que sellaba el ciclo.


---

# 2026-09-20 — El reenvío no crea fila nueva (Spec F, base + 3 iteraciones) y el ciclo que paró por su propia regla

Octavo ciclo. Cierra el mecanismo y **para el bucle antes de cerrar el reintento**, que sale a su
propia spec: tres vueltas seguidas lideradas por el sostén son la señal que `cycle` describe, y
esta vez se leyó en vez de ignorarse.

## Qué se construyó

**La clave de deduplicación del envío, en su propia columna.** `items_nombre_unico` es parcial, así
que un reenvío deja de chocar en cuanto alguien tacha el producto: inserta, y lo que el usuario
quitó vuelve. El hueco es estructural —la baja local va después del `await`, con cota de 10 s— y
por tanto **ningún booleano del cliente lo cierra**: un proceso muerto no honra nada. `origen_id`
con índice único **no parcial** sobre `(group_id, origen_id)`, parcial sólo sobre la propia clave.

**En su columna y no en `items.id`** porque la clave primaria es autoridad del servidor: el
privilegio de INSERT es por columna y no la incluye. Lo dijo la base con un `42501` al construir, y
mi comparación de formas había medido índices y migraciones **sin mirar los privilegios**.

**Una clave por gesto de alta**, compartida por el envío inmediato y la entrada de la cola. Lo
destapó una fila de navegador: el alta acuñaba un uuid para su envío y `meterEnCola` **otro** para
la cola, así que en el caso exacto que esto cierra —el envío llega y su respuesta no vuelve— el
reenvío llevaba una clave distinta de la guardada.

## Los dos números, medidos en líneas y no por impresión

Producto = `app/ lib/ supabase/` · sostén = `unit/ e2e/ docs/`. Contado con
`git show --numstat` por commit:

| Vuelta | Producto | Sostén | Proporción |
|---|---|---|---|
| Spec E, cierre (`cee461b`) | 126 | 1.369 | 1 : 10,9 |
| Spec F, base (`3566406`+`1acf149`) | 94 | 800 | 1 : 8,5 |
| Spec F, iteración 1 (`02bf4ac`+`a993807`) | 76 | 362 | 1 : 4,8 |
| Spec F, iteraciones 2 y 3 | 53 | 671 | 1 : 12,7 |

**Cuatro vueltas seguidas lideradas por el sostén, y las cuatro por un factor de entre 5 y 13.** En
hallazgos, la Spec E fue 12 de producto contra 27 de sostén; las cuatro revisiones de la F
devolvieron 14, 14, 20 y 12 mejoras, y la última **no tocó producto en absoluto**: su único cambio
de producto estaba congelado.

**Y el patrón dentro de eso, que es lo que decidió parar.** Tres vueltas seguidas con el mismo modo
de fallo: una guarda que afirma tener dientes y no puede fallar. La sonda de F9 —tautología
medida—, su arreglo, y el test que demostraba ese arreglo, verde con la lista vacía. Cada arreglo
cambió un agujero por otros: el del AST quitó un falso positivo y metió **cuatro falsos negativos**
medidos; el inventario arregló el total y **rompió la detección de la pérdida** que existía antes de
partir la pasada. Eso es «cada arreglo destapa el de al lado», y significa que el bucle dejó de
construir la spec.

## Decisiones que conviene no volver a discutir

- **El invariante va en la base, no en un booleano del cliente.** El hueco entre «el servidor tiene
  la fila» y «la cola lo olvida» no se puede cerrar desde dentro del proceso que puede morir.
- **La clave pertenece a la intención, no al intento.** Una clave por gesto, y muere cuando el
  producto acaba en algún sitio —enviado o encolado—.
- **El límite de un instrumento se escribe, no se persigue.** Es la lección de R2 en la Spec E,
  reaprendida por las malas: cuatro instrumentos sobre la misma pregunta, cada uno mejor y los
  cuatro cortos. La deuda 72 la aplica a las tres guardas que quedan.
- **La pasada de mutación corre en primer plano y se parte para caber.** Desacoplarla no la hace
  caber: le quita el único lector.

## Terminal

| | Antes del ciclo | Después |
|---|---|---|
| Casos unitarios | 1.684 | **1.721** |
| Ficheros unitarios | 68 | 68 |
| Casos de navegador | 92 | **95** |

Medido el **2026-09-20** con la base local caliente y en dos órdenes, no en una.
2026-09-20: `pnpm typecheck` 0 · `pnpm lint` 0 avisos · `pnpm test` 1.721 de 1.721.
2026-09-20: `pnpm build` 0 con `.next` borrado · `pnpm test:e2e` 95 de 95.

**Pasada de mutación, en dos partes y en primer plano.** Medido el 2026-09-20: diez mutaciones
sobre 529 casos no caben en una orden de diez minutos, a 48 s por mutación. Cada parte con su base verde, su huella
y **el control**, que corre en las dos. Con inventario declarado que compara **casos y no sumas**, y
con su límite escrito: caza una parte perdida, añadida o reordenada, y **no** una edición doble
coherente, porque una declaración y lo declarado editados juntos son indistinguibles de un cambio
legítimo — lo que cierra ese caso es que la declaración vive en un fichero que se revisa.

## Qué NO se verificó, y qué se hizo en su lugar

- **El reintento acotado no se arregló, a propósito.** Dos defectos medidos —dispara en el
  duplicado de todos los días y se lleva la relectura; su `'servidor'` pierde el producto bajo un
  aviso que promete un reintento que nadie hace— y un tercero que la última revisión localizó un
  nivel más abajo: la fusión está en `devolver()`, que devuelve el texto en **todo** fallo y
  recuerda la clave, que sólo tiene sentido cuando el resultado es **desconocido**. Sale a la
  **Spec G2**, sin sellar, con la pregunta hecha antes del requisito.
- **Las once formas que las tres guardas dejan abiertas**: deuda 72, con la conclusión del perímetro
  —acotar el enunciado— en vez de perseguirlas.
- **Lo que le queda a la pasada**: deuda 73. El suelo no discrimina, `na`/`sup` no invalidan, la
  ronda de navegador no tiene testigo medido, y ninguna corrida propia está acotada.
- **Dos registros que nada vigila**: deuda 74. El requisito 5 de la iteración 2 no tiene fila de
  DoD, y sus correcciones son prosa que el barrido excluye a propósito.
- **Un test de la verja sin cota**, capaz de tardar quince minutos con la base fría: deuda 71.

## La lección, que es la misma tres veces seguidas

**Una afirmación sobre la propia evidencia es una afirmación, y va medida como cualquier otra.** Lo
escribí como causa común en la iteración 2 y lo incumplí en la 3 dos veces: la fila que decía «una
lista de basura pone roja esa fila» —falso, medido— y un comentario que decía que la unión de las
dos particiones «se comprueba aparte porque es estático», comprobación que no existía. Las dos las
encontró una revisión en contexto limpio, y ninguna puerta podía verlas: una guarda que miente
sobre sí misma da verde por definición.

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

- Ficheros de prueba unitaria: 68
- Ficheros de prueba de navegador: 16


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


# Verificación del cierre (2026-09-08)

Ciclo: **que ningún fallo se quede sin contar** (R1–R8). Dieciocho iteraciones,
la última de ellas una corrección de la anterior, no una vuelta más.

## Terminal

Medido el 2026-09-08, con `.next` borrado antes del build:

- `pnpm typecheck` — limpio.
- `pnpm lint` — 0 errores, 0 avisos.
- `pnpm test` (2026-09-08) — **1.204 casos en 51 ficheros**, todos en verde. Al
  sellar la spec eran 813.
- `pnpm build` — compila; 6 rutas.

## Runtime — qué se ejercitó y contra qué build

- `pnpm test:e2e`, **tres pasadas desde frío** (`rm -rf .next && pnpm build`
  antes de cada una): **60/60, 60/60, 60/60**.
- **Navegador real (Chrome, sesión de Google del usuario, build de producción
  servido por `pnpm start`)**, los cuatro caminos por los que una acción puede
  fallar:

  | Camino | Lo que se vio |
  |---|---|
  | Nombre vacío | «Escribe un nombre de producto.» |
  | Texto que la base rechaza (`23514`) | «Ese texto no vale: revisa que no esté vacío y que no sea demasiado largo.» |
  | Sesión caducada (`42501` afinado con la sonda de 2 s) | «Tu sesión ha caducado. Vuelve a entrar para seguir.» + enlace con `?next=` |
  | Duplicado real (`23505`) | «Ese producto ya está en la lista.» |

  En los cuatro, barrido de la pantalla entera buscando `already exists`,
  `Key (`, `translate(`, `Failing row`, `violates`, `row-level`, `PostgrestError`
  y los códigos: **cero coincidencias**.
- La señal positiva del canal (`Lista en vivo`) se afirma ahora por su **texto**,
  no sólo por su localizador, y el e2e se puso rojo al divergir el literal —
  comprobado revirtiendo.

## Qué NO se verificó, y qué se hizo en su lugar

- **Dos cuentas de Google reales a la vez.** No hay una segunda cuenta
  disponible, así que ningún flujo de dos personas se ejerció con login real de
  Google. En su lugar: los e2e usan dos contextos de navegador simultáneos con
  PKCE real por magic link, que recorre el mismo canje de código, y el flujo de
  aprobación se ejercita entero con dos usuarios de prueba.
- **La completitud de las guardas de contaminación.** Está declarada como no
  demostrada, con sus medidas, en `docs/TECHNICAL_DEBT.md` 27–30. Verde ahí
  significa «ninguna de las formas conocidas está presente», no «no hay ninguna».
- **`details` en producción.** La medida de que el `23514` de `create_group`
  llega con `details` poblado —UUID del grupo y fila entera— se tomó contra el
  stack **local**. No se ha comprobado contra el proyecto hospedado.

---

# Verificación del ciclo de la app sin conexión (2026-09-09)

## Terminal

Leída **por su código de salida**, no por el recuento impreso. Ése fue el defecto
de la cuarta vuelta (2026-09-09): la suite decía «passed» y el proceso salía con
1, por una promesa sin dueño en el banco del service worker.

2026-09-09 — `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → **EXIT=0**.

2026-09-09 — 1.349 casos en 61 ficheros unitarios y 16 de navegador; al empezar el
ciclo (2026-09-08) eran 1.204 en 51 y 16.

2026-09-09 — coste medido sobre el diff sin commitear: producto 639 líneas nuevas
en 9 ficheros y +485/−29 sobre 8 existentes; pruebas 2.067 nuevas en 11 ficheros y
+88/−23 sobre 10. Razón pruebas:producto **1,9:1**, frente a 5,4:1 (2026-09-08).

## Runtime — qué se ejercitó y contra qué build

2026-09-09 — `pnpm test:e2e` **tres veces desde frío** contra un artefacto recién
construido, con `.next` borrado y Playwright levantando su propio `next start`:
EXIT=0 las tres (2026-09-09), 81/81. Antes de la primera pasada se mató un `next-server`
huérfano del puerto 3000 que servía un build anterior — el fallo que el propio
ciclo advierte de no cometer.

2026-09-09 — **Chrome real, a mano, con la app apagada** (sesión real sembrada,
`next start` detenido a propósito):

- arranque en frío en `/g/<id>` → el shell pinta «aceitunas · 1 bote» y «pan»;
- borrada la cookie de sesión, los datos **siguen** en IndexedDB y no se pinta
  ninguna fila: sale «Necesitas conexión para ver este grupo por primera vez»;
- en `/` → «Necesitas conexión para entrar y ver tus grupos»;
- instalación del worker entrando **anónimo por la portada**: `super-v2` con el
  shell dentro.

2026-09-09 — coste de sesión por render, contando peticiones a `/auth/v1/user` en
el contenedor de auth sobre el mismo camino autenticado: **15 → 11**, determinista
en dos vueltas de cada variante.

## Qué NO se verificó, y qué se hizo en su lugar

- **La cola sin red, a mano en Chrome.** Apagar el servidor no pone al navegador
  sin red: `navigator.onLine` sigue en `true` y la sonda de `useOffline` no
  dispara con la pestaña quieta. Eso es «servidor caído», que es otro estado. En
  su lugar (2026-09-09): los casos de `e2e/sin-red.spec.ts` usan
  `context.setOffline(true)`, que es un navegador realmente desconectado.
- **El viewport de 390 px en Chrome real.** La herramienta de redimensionar
  informa éxito y la anchura de ventana no cambia. En su lugar (2026-09-09): la
  suite de Playwright corre **todos** sus casos a 390×844 con `isMobile`.
- **El proyecto hospedado.** Todo se midió contra la instancia local de Supabase.
  La pausa del plan gratuito —el escenario que R2 nombra— se reprodujo apagando
  el contenedor, no esperando una semana.
- **Que el navegador reintente un `install` que rechaza.** Está inferido de la
  especificación de service workers, no medido en navegador. Anotado en la deuda
  33 junto con el único reintento que sí está medido: uno por carga de página,
  desde `app/RegistrarSW.tsx`.
- **Un despliegue real.** `public/sw.js` no se ha desplegado nunca, así que el
  comportamiento entre versiones —lo que las deudas 31 y 32 describen— no se ha
  observado; se dedujo del código y se midió en banco.

---

# Verificación del ciclo de la deuda 34 (2026-09-12)

**Qué se construyó.** Un alta que falla porque no contestó nadie —clase
`servidor`, que es lo que `claseDe` devuelve para todo error sin código: red
caída, pasarela, o el proyecto pausado del plan gratuito— entra en la cola en vez
de perderse, y un reintento acotado la envía sin esperar a que cambie `sinRed`.
Era la única pérdida de datos del camino principal.

**Contrato cambiado a propósito.** Lo fallido ya **no** vuelve al campo: va a la
cola y se envía solo. Invierte la aserción de `unit/drenado.test.tsx` que fijaba
lo contrario, y está declarado en la spec y en la deuda 34.

## Terminal

Leída por código de salida **y por su salida impresa** — ver la cicatriz de abajo.

2026-09-12 — `pnpm typecheck && pnpm lint && pnpm test && pnpm build` → **EXIT=0**,
y `pnpm lint` con **0 avisos**.

2026-09-12 — **1.369 casos en 61 ficheros**; al empezar el ciclo (2026-09-09) eran
1.349 en 61. Producto: 1 fichero, +619/−43 contando pruebas y documentos.

## Runtime — qué se ejercitó y contra qué build

Contra `next start` sobre build fresco con `.next` borrado antes; nunca contra
`pnpm dev`.

- **El caso de la deuda, con gesto y no por API:** `e2e/sin-red.spec.ts`, «la red
  cae entre pulsar y responder». **No** usa `setOffline` a propósito: eso prueba
  «sin red al pulsar», que ya funcionaba. Corta la petición dejando al navegador
  creyéndose conectado —el caso afirma que el banner de sin red *no* aparece—,
  teclea con `pressSequentially` y pulsa el botón. **Verde con el arreglo y rojo
  al revertirlo**, comprobado.
- **El camino clásico siguió intacto:** el 2026-09-12, los 22 casos de
  `sin-red.spec.ts` —que cortan y restauran la red del navegador de verdad—
  pasaron tras extraer la puerta común de la cola.
- **Sondas de mutación, una por requisito**, todas reproducidas por el revisor de
  forma independiente con los recuentos exactos.

## Qué NO se verificó, y qué se hizo en su lugar

- **La suite e2e completa.** El 2026-09-12 tardaba más de 15 minutos y colgó a
  dos revisores. Se ejercitó `sin-red.spec.ts` entero, que es el fichero que esta
  deuda toca.
- **El proyecto hospedado.** Todo contra la instancia local, como en los ciclos
  anteriores. La pausa del plan gratuito se reprodujo cortando la petición.
- **Verificación manual a 390 px.** Según `playwright.config.ts` del 2026-09-12,
  la suite corría todos sus casos a 390×844 con `isMobile` y `hasTouch`, pero
  nadie lo miró a mano en esta vuelta.

## Cicatriz del ciclo — la puerta verde que escondía el defecto

Durante cuatro iteraciones se reportó `pnpm lint` como «EXIT=0» sin leer su
salida. El linter llevaba desde la iteración 4 nombrando el defecto que la quinta
vino a arreglar —`react-hooks/exhaustive-deps: missing dependency 'loadClase'`—
y la verja pasaba igual, porque un *warning* de eslint no cambia el código de
salida y este proyecto no fija `--max-warnings`.

La regla de leer una puerta por su código de salida nació del caso opuesto: una
suite que imprimía «passed» y salía con 1. Aplicada a una herramienta cuyo código
es optimista por diseño, dice lo contrario de lo que hace falta. **El código de
salida es el suelo, no el techo:** dice si terminó bien, no qué encontró.

## Trayectoria

| Vuelta | Qué encontró la revisión | Qué cambió el build |
|---|---|---|
| 1 | `clase === 'red'` era rama inalcanzable: cuatro de los ocho ítems quedaban verdes con un producto que no encolaba nada. Y el reintento sellado con la secuencia de los **avisos** | Condición a `'servidor'`, pruebas atacando por `claseDe`, ref propia del envío |
| 2 | Dos bucles de recuperación donde antes había uno; el aviso podía quedarse mintiendo por otra vía | Un solo bucle; el drenado retira el aviso |
| 3 | Quitar `avisar` dejó sin alcanzar el único sitio que re-armaba `reintentar`: aviso derivado permanente | Limpieza por identidad (`deCola`), refinado por red con la red **viva** |
| 4 | Dos regresiones respecto a HEAD: la lista no se releía nunca, y el drenado leía un `loadClase` caduco | Una relectura al vaciar la cola; `loadClase` en las dependencias |
| 5 | Cinco ítems PASS, ninguna regresión que sufra un usuario | Comentario obsoleto que argumentaba a favor del defecto, borrado |

El ciclo se detuvo en la cuarta vuelta por la **regla del techo** y se escaló al
usuario: cuatro iteraciones seguidas habían introducido una regresión en el mismo
sitio. El diagnóstico —y la decisión del usuario— fue acotar la quinta a las dos
regresiones y llevar el problema real a una spec aparte.

---

# Verificación del ciclo «la puerta no pasa con avisos del linter» (2026-09-13)

Cierra la entrada **46** de `docs/TECHNICAL_DEBT.md`. Cuatro vueltas; la cuarta
la autorizó el usuario expresamente tras avisarle del techo que él mismo puso.

## Qué se construyó

| Mecanismo | Dónde |
|---|---|
| `--max-warnings 0`: un aviso pone la puerta roja | `package.json:9` |
| Inventario de supresiones: las que eslint reporta coinciden con las declaradas | `unit/puerta-lint.test.ts` |
| Toda directiva `disable` nombra la regla que silencia | ídem |
| Inventario de toda configuración de eslint escrita en el código, familia entera más el canal del plugin | ídem |

## Terminal

| | Antes | Después |
|---|---|---|
| Ficheros de prueba unitaria | 61 | 62 |
| Casos unitarios | 1.369 | 1.394 |
| `pnpm typecheck` · `lint` · `test` · `build` | 0 · 0 · 0 · 0 | 0 · 0 · 0 · 0 |

`pnpm build` se corrió sobre un `.next` borrado antes, no contra un servidor de
desarrollo.

## Runtime — qué se ejercitó y contra qué build

La capa que el requisito nombra es la **terminal** (§E.1): «`pnpm lint` sale ≠ 0».
Se atacó ahí directamente y por mutación, no por lectura. Cada guarda se vio roja
sembrando su defecto, **3 pasadas de 3** en todas:

| Sonda sembrada | Resultado |
|---|---|
| Un aviso (`const` sin usar) | rojo 3/3; sin el flag, verde — 2026-09-13 |
| Una supresión en línea sin declarar | rojo 3/3 — 2026-09-13 |
| Una directiva sin regla nombrada | rojo 3/3 — 2026-09-13 |
| Configuración en línea poniendo una regla en `"off"` | rojo 3/3 — 2026-09-13 |
| La misma, **partida en dos líneas** | rojo 3/3 — 2026-09-13 |
| La marca de plugin `$FlowFixMe[react-rule-hook]` | rojo 3/3 — 2026-09-13 |
| Revertir `docs/TECHNICAL_DEBT.md` a `HEAD` | 2 tests rojos, 3/3 — 2026-09-13 |
| Quitar `--cached` del barrido | rojo: 131 ficheros analizados y no mirados — 2026-09-13 |

`pnpm test:e2e` se ejecutó completo el **2026-09-13**: 81 pasan, 1 falla. El fallo
es `e2e/host-separation.spec.ts:105`, y es **pre-existente**: reproduce idéntico
con el árbol limpio en `HEAD`, y también en un árbol de trabajo montado sobre
`d1a19d6` —el commit que creó el test, el 2026-09-07— con el mismo lock instalado
desde cero. Diagnóstico y alcance, en la deuda 51.

**Primer diagnóstico mío de ese fallo, y era falso.** El 2026-09-13 dije que ese
caso pasaba corriendo su fichero solo, 3 de 3, y que fallaba sólo acompañado. No:
falla siempre. El error fue de lectura, no de medición — Playwright imprime la
línea de fallos y después la de aciertos, y mi comando se quedaba con la última.
Conté el verde y tiré el rojo, en el mismo ciclo cuya cicatriz es exactamente
ésa.

## Qué NO se verificó, y qué se hizo en su lugar

- **Navegador a 390 px:** no se ejercitó. El cambio no tiene superficie de
  navegador —un script de `package.json`, dos ficheros de prueba, tres documentos
  y una línea de exclusión—, y `pnpm build` emite las mismas 8 rutas que antes.
- **La causa del fallo de `host-separation`:** no se diagnosticó hasta el final.
  Se acotó a un caso mínimo que reproduce en 3 segundos y se anotó. Arreglarlo
  habría sido ensanchar el ciclo a código que esta spec no tocó.
- **Que no quede una quinta forma de silenciar:** no se puede demostrar, y así se
  declara. El límite está escrito: la guarda cubre la familia de configuración en
  línea de eslint más los canales de plugin conocidos; no cubre `eslint.config.mjs`
  (deuda 48), ni la ausencia de hook o CI (deuda 47), ni un canal que un plugin
  futuro invente sin reportar a eslint (deuda 50).

## Cicatriz del ciclo — cuatro frases falsas, todas mías

Las cuatro revisiones encontraron algo real cada una. Tres de los hallazgos eran
**afirmaciones falsas que yo había escrito** en la spec o en la deuda: que ninguna
guarda cazaba una regla apagada (cazaban dos de tres), que `package.json` era el
único sitio que llamaba a `eslint` (mi propio test lo llamaba), y que
`unit/debt.test.ts` vigilaba dos entradas nuevas — revertir la deuda lo dejaba en
8/8 verde, medido el 2026-09-13. La cuarta fue decir «enumeración cerrada» cuando
el barrido leía línea a línea un comentario que eslint lee a través de ellas.

El patrón: **copiar una medición ajena, o deducir una propia, en vez de repetir el
comando.** La regla del proyecto ya lo dice —«no asumir, verificar»— y la
incumplí escribiendo documentos, que es donde menos se nota y más dura.

## Trayectoria

| Vuelta | Qué encontró la revisión | Qué cambió |
|---|---|---|
| 1 | — (construcción) | `--max-warnings 0` y su sonda |
| 2 | La puerta se salta silenciando en línea; `pnpm test` rojo por el contador del checkpoint | Inventario de supresiones; 61 → 62 — 2026-09-13 |
| 3 | Un `disable` general vacía un fichero de linter y el inventario no lo distingue; la deuda decía lo contrario de la realidad | Barrido de directivas; deuda 46 cerrada, 47–49 abiertas |
| 4 | La configuración en línea escapa a las tres guardas; cuatro frases falsas en el registro | Inventario de la familia entera; luego, sobre el texto completo y con el canal del plugin |

---

# Cierre de la deuda 51 (2026-09-13)

La guarda de la separación de hosts llevaba **seis días roja** —desde el commit
que la creó, el 2026-09-07— y el registro la había declarado verde tres veces.
Diagnóstico completo en la entrada 51 de `docs/TECHNICAL_DEBT.md`.

## Qué se cambió

| | |
|---|---|
| Retirado | `DoD 44` y su sonda `DoD 53` de `e2e/host-separation.spec.ts`: pedían separación de TCP, que dos alias de loopback no pueden dar — 2026-09-13 |
| Añadido | `hostCompartido()` en `e2e/appOrigin.ts`, ejercitada desde `unit/app-origin.test.ts` |
| Intacto | Los tres casos de cookies del mismo fichero: son los que miden el efecto en el navegador |

## Terminal y runtime

- El 2026-09-13: `pnpm typecheck` 0 · `pnpm lint` 0 · `pnpm test` 0 (1.403 casos
  en 62 ficheros) · `pnpm build` 0 sobre un `.next` borrado antes.
- **`pnpm test:e2e` EXIT=0, 80 casos — 2026-09-13.** Primer verde de la suite
  comprobado de punta a punta en este ciclo; los dos anteriores la declararon sin
  que lo fuera, o no la ejecutaron.
- Mutación: juntar los hosts por cualquiera de las dos variables pone roja la
  guarda, 3 de 3 pasadas — 2026-09-13.

## De paso, una demostración no buscada

Al retirar el test viejo quedaron tres imports huérfanos. `pnpm lint` salió **≠ 0**
y los nombró. Con el `package.json` de ayer habría salido 0 y habrían viajado en
el commit: es el defecto que la deuda 46 describía, cazado en vivo el mismo día
que se cerró.

## Qué NO se verificó

- **La app abierta a mano.** Nadie la usa como una persona desde el 2026-09-09
  (deuda 52). Este cambio no toca superficie de navegador —un helper de
  configuración y dos tests—, pero el hallazgo es de la app, no de este cambio.

---

# Verificación del ciclo «la cáscara sin red» (2026-09-13)

Cinco vueltas. La quinta la autorizó el usuario tras una escalada por el techo del
ciclo, con el encargo de cerrarla y cerrar.

## Por qué existió esta spec

Una pasada manual a 390 px descubrió que **al recargar sin cobertura dentro de un
grupo, el service worker sirve la cáscara**, así que `GroupView` no se monta y el
mecanismo de aviso-y-recuperación —la cola incluida— **no existe en pantalla**. El
propio worker dice que existe porque el App Shell «no sobrevive a cerrar la app,
que es justo lo que pasa entre una compra y la siguiente»: en ese camino exacto,
el que motivó construirlo, no se podía apuntar. Eso reordenó el trabajo: la
cáscara pasó delante de la Spec B (deuda 53).

## Qué se construyó

| | |
|---|---|
| Sondeo propio | `location.href`, cadencia 2/4/8/16/30 s sostenida, cota de 2 s por sonda, pausa con la pestaña oculta, generación para no duplicarse |
| Recuperación | Al acertar la sonda, recarga — salvo con un envío en vuelo. El contador cruza la recarga por `sessionStorage`, y por `window.name` si está capado |
| Apuntar sin red | La regla de la cola sale a `lib/cola.ts` y la comparten las dos pantallas; los efectos se quedan en cada una. `avisar` **no se tocó** |
| Textos | El banner deja de ser incondicional: tres estados, y la línea de debajo con el mismo criterio |
| Identidad | La cáscara dice de qué grupo es, leyendo un nombre que la instantánea empezó a guardar bajo clave propia dentro del prefijo del usuario |
| Salida | Enlace normal —no `next/link`— con la regla del linter silenciada, su motivo escrito y declarada en el inventario |

## Terminal

| | Antes | Después |
|---|---|---|
| Ficheros de prueba unitaria | 62 | 63 — 2026-09-13 |
| Casos unitarios | 1.403 | 1.465 — 2026-09-13 |
| Casos de navegador | 80 | 88 — 2026-09-13 |
| `typecheck` · `lint` · `test` · `build` · `test:e2e` | — | 0 · 0 · 0 · 0 · 0 — 2026-09-13 |

## Runtime — qué se ejercitó y contra qué build

El 2026-09-13, a 390×844, contra `next start` sobre un `.next` borrado antes, con
sesión real sembrada por el camino del arnés. Escenario completo y **con el
gesto**: entrar al grupo · cortar la red · recargar —sirve la cáscara, con nombre
de grupo, lista y formulario— · apuntar con la **tecla «ir»** · restaurar la red ·
y **sin tocar nada**, vuelta a `GroupView`. Los dos productos apuntados sin red
—«Cebollas» y «Naranjas»— llegaron a la base.

Mutaciones, cada guarda contra su defecto, repetidas donde había duda:

| Sonda | Resultado |
|---|---|
| `/g/` metido en `esEstatico` del worker | rojo **por la aserción de §A.1**: el documento del grupo acaba en la caché compartida — 2026-09-13 |
| Volver a `!res.redirected` | rojo: la sesión caducada dejaba la cáscara encerrada — 2026-09-13 |
| Quitar la generación del sondeo | 8 sondas contra 11 en 120 s — 2026-09-13 |
| Quitar la `ref` de envío dejando `disabled` | rojo 3/3 por formulario; por el botón `disabled` basta — 2026-09-13 |
| Volver a `next/link` en la salida | **6 HEAD del framework en 10 s** contra 0 — 2026-09-13 |
| Quitar la lectura de `window.name` | rojo — 2026-09-13 |
| Quitar las restauraciones del banco | 2 rojos — 2026-09-13 |

## Qué NO se verificó, y qué se hizo en su lugar

- **La iteración 5 no la revisó nadie de forma independiente.** El usuario
  autorizó cerrar tras ella. En su lugar: sonda de mutación por guarda, la puerta
  completa, y la pasada a mano de arriba. Es la única vuelta de las cinco sin
  calificación externa, y las cuatro anteriores encontraron algo real cada una.
- **La deuda 31 se vio en vivo y no se arregló.** `sw.js` no cambia de bytes, así
  que el navegador **no reinstala**: hubo que registrar `/sw.js?pasada-final=1` a
  mano para poder probar. Traducido: **este arreglo no le llega a quien ya tenga
  la cáscara instalada**. Está fuera de alcance y sigue anotado.
- **El proyecto hospedado.** Todo contra la instancia local.

## Cicatriz del ciclo — cuatro guardas que no podían ponerse rojas

En cuatro vueltas escribí cuatro guardas que pasaban con el defecto puesto: una
que miraba una constante del estándar Fetch; un techo de «≤ 7» cuando los valores
reales eran 2 contra 3; un `dblclick` que reparte los clics en tareas distintas; y
un test que probaba que `window.name` se **escribe** pero no que se **lee**. Tres
las cazó la revisión, una yo.

**Corregido el 2026-09-13 al revisarlo con el fichero delante:** la primera
redacción decía que la causa era la misma las cuatro veces. Es cierta en **tres de
cuatro** —el `Request.mode`, el techo «≤ 7» y el `dblclick` se escribieron después
del código, y un test escrito después está moldeado por el código al que tiene que
juzgar—. El cuarto es distinto y es el que enseña algo: el de `window.name` **se
escribió primero y se vio rojo por el motivo correcto**, y salió inerte igual.

Porque «rojo antes» demuestra que el test nota **el cambio**, no cada una de sus
partes. El mecanismo tenía dos mitades —escribir y leer—; antes del cambio no
había ninguna, así que el test era rojo; después, verde. Borrando sólo la lectura,
la suite entera seguía en verde.

Lo que sí funcionó fue mutar antes de dar nada por bueno — y ahí apareció lo
contrario: buscando el camino que aísla la `ref` de envío se descubrió que
`disabled` basta por el botón y **no** por el formulario, que es la tecla «ir» del
teclado móvil. La guarda hacía falta, pero por un motivo distinto del que yo había
escrito.

De aquí salió una regla nueva en `build` del método, fuera de este repositorio:
quitar cada parte añadida, una a una, y exigir un rojo antes de entregar.

Y cuatro afirmaciones falsas mías en el registro, la peor en la deuda 54:
sustituí una explicación correcta de la revisión por una equivocada, apoyándome en
tres mediciones propias que daban cero. Los ceros eran ciertos para la condición
que medí —el ratón *por encima* de la salida—; pulsando, el bucle sale a la
primera. Medir una condición y concluir sobre todas es el mismo error que la
cicatriz del ciclo anterior.

## Trayectoria

| Vuelta | Qué encontró la revisión | Qué cambió |
|---|---|---|
| 1 | — (construcción) | Sondeo, recuperación, apuntar, banner, nombre, salida |
| 2 | Bucle de recargas por la puerta que la spec no miró; tres cicatrices de `GroupView` repetidas | Sonda a `location.href`, contador que escala, generación, las tres cicatrices |
| 3 | La regresión de la sesión caducada; tres guardas que no guardaban | Redirección al propio origen; `DoD 14` mide comportamiento |
| 4 | Contradicción banner/línea; la lectura de `window.name` sin vigilar | `window.name` medido; no recargar con envío en vuelo |
| 5 | *(escalada al usuario: tres HIGH)* | Salida sin `next/link` — 6 HEAD → 0; la lectura vigilada; cinco frases falsas corregidas |

---

# Una regla que previno en vez de diagnosticar (2026-09-15)

Se anota aparte del ciclo porque no es un hallazgo de producto: es la primera
evidencia medida de que una regla nueva del método **impide** un defecto en lugar de
explicarlo después.

## Qué pasó

La regla es de `build`, escrita el 2026-09-14: *la pasada de mutación se entrega en
forma reproducible, fuera del árbol, con las mutaciones tal como se aplicaron*. Su
motivo era de coste — correr una mutación es barato, **verificarla** obliga a quien
revisa a reconstruirla, así que se verifica por muestreo, y una regla que sólo se
verifica por muestreo se degrada sola.

Primera aplicación, en la vuelta del eje de la duración. La pasada se entregó como un
script de zsh ejecutable. Dentro, esta mutación pretendía borrar las **dos** retiradas
del aviso de la cola:

    s/            despachar\(\{ tipo: 'retirar', origen: 'cola' \}\)\n//g

Exige **12 espacios** de sangría. `GroupView.tsx:461` tiene 12; `:467` tiene **10**.
Borraba una, no dos. Y la guarda de «⚠️ sin efecto» no lo cazaba, porque el fichero sí
cambiaba.

De ahí salió una conclusión falsa: que las dos retiradas estaban sin vigilar porque el
fichero seguía entero en verde. Medido de verdad —con ` *despachar` en vez de doce
espacios— borrar las dos daba **6 rojos** y borrar sólo la primera, ninguno. Las dos
eran guardias vivos; la segunda tenía prueba y la primera no. La conclusión falsa llegó a escribirse **dentro del
repositorio**, como comentario de `unit/drenado.test.tsx`, invitando a la siguiente
iteración a borrar ese guardia por inerte.

## Por qué cuenta como prevención y no como diagnóstico

La revisión **ejecutó el script** y vio que no hacía lo que decía. Con la pasada
entregada en prosa habría reconstruido la mutación *correctamente* —un `perl` con la
sangría bien, o una edición a mano— habría obtenido 6 rojos, y habría concluido que la
entrega decía la verdad. **El fallo no estaba en la mutación descrita, estaba en la
ejecutada**, y ésa sólo existe si se entrega ejecutable.

Dicho al revés: la prosa describe la intención; el script describe el hecho. Un
instrumento roto sólo se caza entregando el instrumento.

## Lo que esto sugiere sobre el método, sin generalizar de más

Es **un** caso, y la evidencia de una regla nueva es siempre un caso hasta que son
varios. Pero la forma es la que se buscaba al escribirla: la regla no sirvió para
explicar mejor un defecto ya ocurrido, sirvió para que el defecto no saliera de la
vuelta. Anotado aquí para poder comparar cuando haya un segundo caso — o para
retirarla con motivo si resulta que éste fue suerte.

**Coste medido de aplicarla, para que la comparación sea honesta:** escribir el script
costó unos minutos más que narrar la pasada; ejecutarlo, lo mismo que correrla. La
revisión lo corrió entero —19 mutaciones— en vez de muestrear 4 de 24, que es lo que
hizo la vuelta anterior con la pasada en prosa.

---

# Verificación del ciclo «el eje que faltaba es la duración» (2026-09-15)

Nueve vueltas sobre el mismo mecanismo. Cierra **siete** y abre una spec nueva con lo
que resultó ser otro problema.

## Qué se construyó

El aviso pasa a un reducer puro en `lib/aviso.ts`, con dos ejes **independientes** y
los dos escritos como dato:

- **Duración.** Un aviso vive *mientras su condición sea cierta* (nivel: `carga`,
  `cola`) o *hasta que lo lean* (una vez: `mutacion`, `relectura`, `apertura`). La
  partición se **midió**, no se eligió: los orígenes que alguien retira explícitamente
  son exactamente los niveles. Derivarla del peso daba una partición distinta en dos de
  cinco, y esos dos —`cola` y `apertura`— son los que produjeron los dos últimos fallos
  del ciclo.
- **Peso**, sólo dentro de su duración. Entre los de una vez decide quién tapa a quién;
  entre los niveles, cuál se ve primero — nunca cuál sobrevive.

`visible = unaVez ?? nivelVisible(niveles)`. Los niveles tienen casilla propia porque
dos pueden ser ciertos a la vez.

Lo demás que entra: la identidad del afinado **viaja dentro de la acción** (un token
despachado con ella) en vez de deducirse del estado, porque quien despacha no puede
saber en qué estado aterrizará — los manejadores limpian antes del `await`. Dos
generaciones de recuperación con dueño, `recCarga` y `recMutacion`, cada una invalidada
por quien la armó.

## Terminal

| | Antes del ciclo | Después |
|---|---|---|
| Casos unitarios | 1.478 | 1.518 |
| Ficheros unitarios | 63 | 64 |
| Casos de navegador | 88 | 88 |

Al cerrar el ciclo, el 2026-09-15: `typecheck`, `lint` con cero avisos, `test`,
`build` sobre `.next` borrado y `test:e2e`, los cinco con código de salida cero.

## Runtime — qué se ejercitó y contra qué build

La suite de navegador entera contra `next start` sobre un build con `.next` borrado, a
390 px. Además, la revisión de la octava vuelta ejercitó **dos pestañas reales sobre la
misma IndexedDB** a 390 px: el camino feliz pasa, y los dos bordes que fallan son los
que abren la spec nueva.

## Qué NO se verificó, y qué se hizo en su lugar

- **La pasada manual con el gesto, a 390 px, por una persona.** No se hizo: el ciclo
  paró por el umbral antes de llegar ahí. La cubre estructuralmente la suite de
  navegador, que corre en ese viewport y contra el build de producción, pero no es lo
  mismo y queda pendiente.
- **La retirada del aviso y de las fichas cuando otra instancia vacía la cola.** Se
  intentó en este ciclo y se retiró: el arreglo derivaba de una copia de la cola leída
  antes de tres `await` y borraba la ficha de lo apuntado sin red mientras seguía
  pendiente, medido 3/3. Sale del alcance **por su nombre** y es la spec nueva.

## El hallazgo que cierra el ciclo: eran dos familias, no una

Clasificadas las nueve vueltas por si el defecto **se reproduce con una sola instancia
montada**:

| Vueltas | Defecto | ¿Una instancia basta? | Familia |
|---|---|---|---|
| 1 a 7 | aviso sin dueño, re-anuncio, sello, prioridades | sí, todas | el hueco del aviso |
| 8 y 9 | otra pestaña vacía la cola; lectura rancia; ventana de 23 s | no, o exige un escritor concurrente | pantalla derivada de estado durable |

**Siete de nueve eran el hueco del aviso, y ese problema queda cerrado.** Las dos
últimas no lo eran, y por eso cada arreglo abría la puerta de al lado: se estaban
arreglando dos problemas creyendo que era uno.

La frontera **no es «entre instancias»**, y conviene decirlo porque fue la primera
formulación y era imprecisa: el defecto de la novena vuelta se reproduce con una sola
instancia — lo que lo rompe es que el bucle lee la cola una vez, cruza tres `await`, y
durante ese viaje la propia app escribe por la rama sin red. La propiedad común es
**pantalla derivada de un estado durable que cambia sin avisar**; quién lo cambia —otra
pestaña o un camino concurrente— es secundario.

## La señal que estuvo a la vista siete vueltas

**Cambió la clase de arnés necesario para reproducir el fallo.** Las siete primeras se
reproducían con un `montar()`; las dos últimas necesitaron dos raíces, o una escritura
concurrente durante un envío en vuelo. Eso no se leyó como lo que era.

De ahí la regla que se lleva el método: **cuando la sonda que reproduce un fallo cambia
de forma, probablemente el fallo cambió de familia.** Es barata de comprobar —se mira el
arnés del último test escrito y se compara con los anteriores— y habría ahorrado dos
vueltas aquí.

## Trayectoria

| Vuelta | Qué encontró la revisión | Qué cambió |
|---|---|---|
| 1 | — (construcción de la Spec B) | Generaciones separadas, refinado con la red viva |
| 2 | El aviso sin dueño; la recuperación sin rearmarse | Marca del aviso de carga; `sinRed` en dependencias |
| 3 | La regla de prioridad cubría escrituras, no retiradas | Retirada selectiva; el mensaje que prometía un reintento |
| 4 | La limpieza mata cualquier recuperación | Dos generaciones con dueño |
| 5 | El sello pasó a estado y el afinado se descartaba siempre | La identidad viaja en la acción |
| 6 | `carga > apertura` dejó apertura inalcanzable | Duración y peso, dos ejes; niveles con casilla propia |
| 7 | R6 retirada sobre un camino no ejecutado | R6 repuesta; instrumento de mutación con recuento |
| 8 | Lectura rancia de la cola: la ficha desaparecía | *(umbral: se para y se reparte en dos specs)* |


---

# Verificación del ciclo «el duplicado lo impide la escritura» (2026-09-17)

Dos iteraciones sobre un invariante de una línea. El producto se arregló en la primera
y no volvió a fallar; **todo lo demás del ciclo fue sostén**.

## Qué se construyó

**El invariante vive en el almacén, no en el llamador** (§D.2). Dos instancias podían
leer la cola, decidir las dos que no había duplicado, y escribir las dos: entre la
lectura y la escritura hay un `await`. El re-chequeo pasa a ir **dentro de la misma
transacción** de IndexedDB —`getAll` y, desde su `onsuccess`, el `put`—, y `encolar`
devuelve tres estados (`entro` · `ya-estaba` · `rechazado`) en vez de un booleano, para
que las dos pantallas puedan distinguir «ya estaba» de «no se pudo guardar». La forma
alternativa —clave derivada— se descartó midiendo: obligaba a migrar la tienda y rompía
el borrado por `id` en tres sitios, uno de ellos cerrar sesión.

## Los dos números del ciclo

**28 hallazgos de revisión en tres vueltas. Uno era del producto.**

| | Hallazgos |
|---|---|
| **De producto** | **1** — y de severidad LOW: al mudarse el `put` dentro del `onsuccess`, un `put` que lance sale como error no capturado en el callback en vez de por el `catch`. El resultado para el usuario no cambia (`rechazado` igual), sólo el ruido. **Abierto.** |
| **De sostén** | **27** — guardas que prometían más de lo que cazaban, falsos infieles, instrumentos de medida que no distinguían «lo impidió» de «nunca ocurrió», y el orden en que se escriben las listas |

**De los 27 de sostén: 16 se cerraron dentro del ciclo y 11 quedaron como deuda** (10
tras cerrar hoy el de los artefactos). El reparto por vuelta:

| Vuelta | Producto | Sostén | Sostén cerrados | Sostén en deuda |
|---|---|---|---|---|
| Revisión de la spec sellada → iteración 1 | 0 | 10 | 10 | 0 |
| Revisión de la iteración 1 → iteración 2 | 1 | 8 | 6 | 2 |
| Revisión de la iteración 2 → cierre | 0 | 9 | 0 | 9 |
| **Total** | **1** | **27** | **16** | **11** |

Dicho sin adornos: **el producto aguantó 24 mutaciones y las dos sondas de navegador; el
andamio no aguantó una sola revisión que lo atacara en serio.** Ninguna de las tres
vueltas encontró un fallo de comportamiento visible para un usuario.

## Terminal

| | Antes del ciclo | Después |
|---|---|---|
| Casos unitarios | 1.518 | **1.571** |
| Ficheros unitarios | 64 | **65** |
| Casos de navegador | 88 | **89** |

Al cerrar, el 2026-09-17: `typecheck`, `lint` con cero avisos, `test`, `build` sobre
`.next` borrado y `test:e2e`, los cinco con código de salida cero.

## Runtime — qué se ejercitó y contra qué build

La suite de navegador entera contra `next start` sobre un build con `.next` borrado, a
390 px. El caso nuevo usa **dos páginas del mismo contexto** —no dos contextos, que
están aislados y no comparten IndexedDB: ahí el invariante no llegaría a ejercitarse y
el caso pasaría en verde sin invariante ninguno—. Las pulsaciones se alinean en un
instante de reloj común y la CPU va frenada 20× para que la ventana entre lectura y
escritura sea de milisegundos.

**Las dos mitades del caso están demostradas por separado**, cada una con su mutación y
repitiendo hasta ver que falla siempre (§E.4(c)), medido el 2026-09-16: quitar el
invariante lo pone rojo 5 de 5; callar el aviso de duplicado lo pone rojo 3 de 3.

## Qué NO se verificó, y qué se hizo en su lugar

- **La pasada manual con el gesto, a 390 px, por una persona.** Tercer ciclo seguido sin
  hacerla. La cubre estructuralmente la suite de navegador —ese viewport, ese build—,
  pero no es lo mismo. Es la deuda 52 y sigue viva.
- **Los nueve hallazgos de la última revisión** no se construyeron: el ciclo se cierra
  con ellos anotados como deuda, no arreglados.

## El hallazgo del ciclo: la escalada del instrumento tiene un techo

Tres versiones de la misma guarda —«ninguna escritura a la cola se salta el aviso»— y
las tres se quedaron cortas, cada una por menos:

| Versión | Cazaba | Lo que se le escapó |
|---|---|---|
| Patrón `escribir(COLA, …)` | 2 de 7 | `let`, `async function`, transacción directa, alias, literal |
| Inventario de menciones de línea | 7 de 11 | plantilla, comillas dobles, concatenación, y una coartada (`// VIDA_COLA_MS`) que además **no excluía nada**: era una puerta sin cerradura |
| Lector AST (`typescript`) | 11 de 11 sembradas | un comentario o una cadena en el cuerpo que nombre `avisarDeLaCola`, y **un solo salto de indirección** |

Cada vuelta subió el listón y cada vuelta encontró un escape nuevo, porque la afirmación
que se intenta sostener es universal —«ninguna forma»— y el instrumento siempre es
particular. **La conclusión que el ciclo se lleva no es «hace falta un parser mejor»:
es que el enunciado debe acotarse a lo que el instrumento comprueba**, y decir en el
propio test qué queda fuera — igual que un falso declara en qué no es fiel.

Esto **decide la deuda 56**, que quedó anotada «sin regla» el 2026-09-15 porque un caso
no bastaba. Ya son tres, medidos, en el mismo fichero.

**Y decide dónde para el ciclo.** Los nueve hallazgos de la última revisión —los dos HIGH
incluidos— quedan como deuda 57 en vez de abrir una cuarta iteración, por la regla de
impacto: el producto lleva tres vueltas correcto y lo que se iteraría es el cuarto
instrumento sobre el mismo enunciado universal. En su lugar se aplicó el veredicto del
revisor, que cuesta una línea y no una vuelta: **la guarda acota su enunciado a lo que
comprueba y declara lo que queda fuera** —comentarios y cadenas que nombren al avisador, y
un salto de indirección—, escrito en la cabecera de su propio describe para que lo lea
quien vaya a añadir un escritor. Una promesa falsa se convierte así en una comprobación
honesta, que es lo que la 56 concluye.

## La segunda señal: el clasificador que no podía dar negativo

La pasada de mutación de la primera iteración (2026-09-16) dio **19 de 19 cazadas** y ese
número no significaba nada: clasificaba «suite roja ⇒ cazada» sin comprobar antes que la suite
estuviera verde. Demostrado a dos caras — la **misma** mutación neutra sale
`SUPERVIVIENTE` con la suite verde y `CAZADA` con un solo fallo ajeno dentro. La regla
está ahora en `build`, y la pasada lleva su propia sonda: una mutación neutra declarada
que **debe** sobrevivir.

## Trayectoria

| Vuelta | Qué encontró la revisión | Qué cambió |
|---|---|---|
| 1 | — (construcción del invariante) | Re-chequeo dentro de la transacción; `encolar` con tres estados |
| 2 | Las guardas prometen más de lo que cazan; las dos medidas no distinguen | Lector AST; control de dos pestañas; baseline en la pasada; falso causal |
| 3 | Lo mismo, un nivel más abajo: el parser también tiene escapes | *(se cierra el ciclo y se anota como deuda)* |


---

# Verificación del ciclo «una API que no contesta no te deja fuera de tu propia lista» (2026-09-18)

Cuatro iteraciones y dos revisiones sobre la guarda de ruta. Sale de la primera pasada
manual en nueve días, y **es el primer ciclo de los tres en que el producto pesa tanto como
el sostén**.

## Qué se construyó

La guarda de ruta (`lib/supabase/middleware.ts`) resolvía «no hay sesión» y «no he podido
comprobarla» en el mismo `user = null` y mandaba las dos al login. Con el plan gratuito
pausado —la web responde, la base no— eso deja a quien **sí** tiene sesión fuera de una
lista que su dispositivo ya guarda, y en una pantalla desde la que tampoco puede entrar.

Ahora lee el `error` que descartaba y sólo la señal de red desvía a la cáscara; la cáscara
deriva el grupo del destino conservado y puede enseñar la lista; el sondeo pregunta por ese
destino en vez de por sí misma; y los textos distinguen «no hay red» de «el servicio no
responde». Las tres clases de error que lo sostienen están **medidas contra el cliente
real**, no supuestas.

## Los dos números del ciclo

**22 hallazgos de revisión en dos vueltas: 11 de producto y 11 de sostén.**

| Vuelta | Producto | Sostén |
|---|---|---|
| Revisión de base + iteraciones 1 y 2 | 7 | 5 |
| Revisión de la iteración 3 | 4 | 6 |
| **Total** | **11** | **11** |

**La proporción se movió, y mucho.** Comparado con los dos ciclos anteriores:

| Ciclo | Producto | Sostén |
|---|---|---|
| «El duplicado lo impide la escritura» (2026-09-17) | **1** | 27 |
| «Una API que no contesta…» (2026-09-18) | **11** | 11 |

Y la explicación no es que se revisara mejor: es **qué se tocó**. El ciclo del duplicado
añadía un invariante de tres líneas bajo una superficie madura, así que casi no había
producto donde equivocarse y los hallazgos caían todos en el andamio. Éste cambió una
**guarda de ruta** —por la que pasa el sitio entero— y abrió un **camino de usuario que no
existía**: la cáscara alcanzada con red. Donde hay superficie nueva, hay producto que
romper, y se rompió: un bucle de recargas que borraba lo tecleado, una rotación de token
abandonada que cerraba la sesión, dos textos que mentían sobre el estado.

Dicho de otro modo: **la proporción no mide la calidad del trabajo, mide cuánta superficie
nueva tocó.** Conviene recordarlo antes de leerla como una nota.

## Terminal

| | Antes del ciclo | Después |
|---|---|---|
| Casos unitarios | 1.571 | **1.605** |
| Ficheros unitarios | 65 | **67** |
| Casos de navegador | 89 | 89 |

Al cerrar, el 2026-09-18: `typecheck`, `lint` con cero avisos, `test`, `build` sobre `.next`
borrado y `test:e2e`, los cinco con código de salida cero. Pasada de mutación con baseline
verde: **16 mutaciones, 16 cazadas, 0 no aplicables**, una superviviente que es la sonda
NEUTRA del propio clasificador, y **3 retiradas que el informe nombra con su motivo**.

## Runtime — qué se ejercitó y contra qué build

La suite de navegador entera contra `next start` sobre un build con `.next` borrado. Y la
pasada con el gesto, **por identidad de elemento y nunca por coordenada** (la razón está en
`skills/DEBT.md` §3): con la API parada y el servidor vivo, recargar dentro del grupo lleva
a la cáscara con las 15 fichas y el texto nuevo, y **un producto a medio escribir sobrevive
38 segundos sin una sola recarga** — antes se perdía cuatro o cinco veces. Con la API de
vuelta, la sonda apunta al grupo y da salida.

## Qué NO se verificó, y qué se hizo en su lugar

- **La navegación automática de vuelta al grupo.** La ventana no estaba visible para el
  sistema y el sondeo se pausa a propósito cuando la pestaña no se ve. Se midió en su lugar
  el veredicto de la sonda —apunta al grupo, 200, no acaba en la cáscara—; la navegación en
  sí la cubren, a 2026-09-18, `unit/shell.test.tsx` y `e2e/sin-red.spec.ts:777`.
- **El ítem 2 de la base no tiene guarda automática** (2026-09-18): el arnés de navegador no
  puede cortar lo que el servidor de Next le pide a Supabase. Guardado en su capa por
  unidad, y cruzado a mano.
- **La API colgada no está cubierta**, y está declarado en la spec antes de cerrarla. Ver
  abajo.

## El hallazgo que cierra el ciclo: un reloj no es evidencia

Tres revisiones seguidas, tres HIGH, **la misma forma**:

| Vuelta | El defecto |
|---|---|
| 1 | La cota de 3 s leía «tarda» como «no contesta» |
| 2 | Agotar la cota **desviaba**, y eso relajaba la condición que no se negocia |
| 3 | La cota por encima del transporte hace que el reloj del transporte **fabrique** la señal de red |

Cada arreglo movió el problema en vez de cerrarlo. La causa no es el valor: es que **el
enunciado pide acotar el veredicto sin dar forma de saber quién cortó** —el reloj propio, el
del transporte, o un rechazo real—, y los tres llegan como el mismo objeto. Mientras eso
siga así, cualquier valor de cota reparte mal alguno de los tres casos.

Por eso **sale a spec propia** en vez de a una quinta iteración, y por eso la Spec C declara
en su §8b, antes de cerrarse, que **la API colgada no está cubierta y que su comportamiento
depende de la edad del token** —medido: 10.004 ms a la cáscara con token vigente, 12.005 ms
al login con token caducado—. Que nadie la lea como si el caso estuviera resuelto.

## La otra lección, esta del método

Declaré un caso «imposible de guardar en esta capa» y **no lo era**: la revisión lo
construyó en veinte líneas. El error fue de encuadre —miré el reintento, que el doble no
puede producir, cuando el requisito hablaba de la petición en vuelo, que sí se observa en la
señal inyectada—. Hoy ese cableado ya no se puede borrar en silencio. Un «no se puede
probar» se gana midiendo, no razonando.
