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

- Ficheros de prueba unitaria: 51
- Ficheros de prueba de navegador: 15


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
