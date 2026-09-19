# TECHNICAL_DEBT

Lo que quedó vivo al cerrar el ciclo del esqueleto compartido. Todo está
**medido**, no supuesto: cada entrada dice qué se comprobó y qué lo contiene
mientras tanto. Nada de esto toca A.1, A.2, A.3, aislamiento entre grupos ni
ningún *hard fail*; por eso el ciclo se cerró en vez de seguir iterando.

## Guardas con hueco (segunda línea de defensa medida y en pie)

### 1. La guarda de recursión pierde dos formas de renderizado
`unit/rls-recursion.test.ts` — el patrón acepta paréntesis y calificación de
esquema, pero **no** caza `FROM (items i JOIN group_members m ON …)` cuando
`group_members` va en segunda posición, ni `FROM ONLY group_members m`. Ambas
producen de verdad `42P17`.
**Qué lo contiene:** el test hermano de comportamiento, que consulta
`group_members` como miembro activo y fallaría con cualquiera de las dos.
**Arreglo:** aceptar `group_members` en cualquier posición de `FROM`/`JOIN` y
tras `ONLY`, y ampliar la sonda con las dos formas.

### 2. La matriz de privilegios por defecto no tiene sonda
`unit/grants.test.ts` filtra por prefijo `anon=`/`authenticated=`, así que un
`grant execute on functions to public` la deja verde mientras `anon` hereda
EXECUTE de toda función nueva por PUBLIC — el vector exacto que descubrió L2.
**Qué lo contiene:** el test hermano por `has_function_privilege`, que caza la
primera función real creada bajo ese grant.
**Arreglo:** afirmar la lista completa de `defaclacl` contra un literal, y
añadir una sonda que conceda a PUBLIC en transacción revertida y exija que la
guarda la cace. **Es la tercera guarda que la regla §E.2 nombra, y es la que no
la cumple.**

### 3. El patrón de plantilla cruza líneas
`unit/locators.test.ts` — de las tres expresiones que limpian cadenas, la de
backticks es la única que atraviesa `\n`: un backtick sin cerrar se tragaría las
infracciones posteriores. Latente hoy (los ficheros de `e2e/` tienen paridad
par). Es la imagen especular del defecto que K9 y L7 arreglaron.

## Comportamiento correcto sin test que lo fije

### 4. El 404 que distingue "no existe" de "la consulta falló"
`app/g/[id]/page.tsx` — la línea `if (!group && !error) notFound()` es la que
impide decirle a un miembro legítimo que su grupo no existe por una caída
pasajera. **Funciona**, y ningún test lo fija: revertirla a `if (!group)` no pone
rojo nada. Es la única instancia que sobrevive del defecto que motivó la regla
§E.1, y está en un sitio que la propia spec declaró.

### 5. El nombre del solicitante en la pantalla de aprobación
`e2e/approve.spec.ts` afirma el contador, no el nombre. El `?? 'alguien'` de la
vista absorbería una regresión completa de `owns_group_of` sin poner rojo nada.

## Inconsistencias menores

### 6. `leaveGroupAction` lanzaba en vez de devolver `{error}` — RESUELTO (2026-09-08)
`app/actions.ts` — era la única de las cuatro acciones cuyo fallo salía por un
límite de error en lugar de por el aviso de la vista. Next enmascaraba el mensaje
con un digest y no hay `error.tsx` en la app, así que el usuario veía una pantalla
de error. Ahora devuelve `ActionState` como las otras tres y la vista lo pinta.

### 7. `text.includes('abort')` casa de más — RESUELTO (2026-09-09)
`lib/errors.ts` — atrapaba `current transaction is aborted` de Postgres y lo
anunciaba como "No hay conexión". Resuelto por partida doble: el token salió de la
lista, y `claseDe` pasó a decidir **por el código primero**, así que un error que
la base contesta ya no llega nunca a la rama de texto.

### 8. `groups.owner_id` es una columna muerta
Confirmado contra el catálogo, no por `grep`: sólo la escribe `create_group` y
sólo la referencia su propia clave foránea. La autoridad real es
`group_members.role`. Una columna que puede divergir de la verdad.

### 9. El centinela toca la fila que después afirma
`unit/expel-event.test.ts` — el cambio centinela muta la misma fila sobre la que
luego se asevera, y se desambigua con `.at(-1)`. Tocar la fila del owner dejaría
el conjunto de aserción limpio.

## Decisión de producto pendiente

### 10. La solicitud de ingreso es un efecto de un `GET`
`app/invite/[token]/page.tsx` — abrir el link mete al usuario en `pending` sin
confirmación. Con cookie `Lax`, una navegación de primer nivel basta. **No es un
arreglo, es un cambio de diseño**: merece su propia spec, y decidir si se pide
confirmación explícita antes de solicitar.

## Documentación

### 11. Referencias obsoletas en el histórico del DoD
La spec se borró al cerrar (así lo manda el ciclo), pero si se recupera del
historial: DoD 32 nombraba `unit/profiles-scope.test.ts`, que se borró y
sustituyó `page-payload.test.ts`; DoD 44 nombraba `unit/notice-render.tsx` sin
el `.test`.

## Deuda de entorno, no de código

- **`alter default privileges` para `supabase_admin`** no se puede aplicar desde
  una migración que corre como `postgres` (`42501`). Se intenta y se tolera. La
  entrada de `postgres` —la que gobierna las tablas que crean estas
  migraciones— sí quedó limpia y tiene test.
- **El servicio de Realtime necesita calentar tras `supabase db reset`.** Mordió
  dos veces durante el ciclo y produjo un diagnóstico falso. **El calentamiento**
  (`e2e/global-setup.ts`) manda un cambio centinela y espera a verlo antes de dar
  el entorno por listo; no amplíes márgenes a ciegas, que ya se probó y no
  funciona.

  **Qué NO usa centinela, corregido:** esta entrada afirmaba que lo hacían "los
  tests que dependen de él", y era falso para dos. `e2e/stale-events.spec.ts`
  esperaba 6 s a ciegas —por eso cazaba su defecto 2 de cada 4 veces— y ahora
  exige ver el evento antes de afirmar (V2). `e2e/resilience.spec.ts` **no usa centinela
  y no puede**: mide el paso a `degraded`, o sea la **ausencia** de eventos, y ahí
  no hay nada que esperar a ver. Tampoco espera ya a que expire el latido —eso
  caía 1 de cada 3 pasadas—: intercepta el WebSocket con `page.routeWebSocket`,
  lo **cierra** y bloquea los reintentos mientras dura la caída, así que el
  instante de la degradación lo fija el test y no el reloj del latido (V4). Lo
  que se restaura en el `finally` es el desbloqueo de la ruta, no la red (V5).

---

# Añadido al cerrar el ciclo del login real (2026-09-06)

## Riesgos abiertos, con su cota

### 12. Los verificadores PKCE se acumulan — CONTENIDO POR TOPOLOGÍA
Los huérfanos de carrera del índice de flujos escapan al anillo y a
`removeAllPKCEVerifiers`: cerrar sesión no los limpia. **Medido en navegador con
dos páginas reales:** un huérfano por ronda, determinista, 229 B cada uno; 14
rondas → 4.593 B, que rebasaba el techo del handshake (8.182 B) y mataba el
canal en vivo.

**Ya no importa, y por eso no se contiene en el código.** Ese techo sólo existía
porque en local la app y Supabase compartían el host `127.0.0.1` y las cookies
se acotan por host. Con los hosts separados (T1) el navegador no manda ni una
cookie de la app al endpoint de realtime, igual que en producción, donde los
dominios siempre fueron distintos.

Se intentó contenerlo acotando la vida de las cookies desde un adaptador propio.
**Se revirtió**: produjo dos defectos de producción para resolver un problema
local, y su justificación era falsa — el reloj de la cookie arranca al pulsar el
botón, el de GoTrue al **volver** de Google, y ese tramo lo controla el usuario
(2FA, elegir cuenta, crear cuenta). Una cota de 5 minutos habría roto logins
legítimos.

**Vigilado por:** `e2e/host-separation.spec.ts` — si alguien vuelve a servir la
app en el host de Supabase, se pone rojo.

### 13. Un `sb_flow_id` conocido permite romper un login ajeno
`app/auth/callback/route.ts` — Un GET no autenticado con `?code=basura` y el
`sb_flow_id` de un flujo en vuelo borra su verificador: la víctima vuelve de
Google a `/login?error=auth` con el código quemado. Fijado por test
(`e2e/callback.spec.ts`, DoD 23).

**Cota, corregida dos veces.** El identificador **sí viaja**: en `redirect_to`
hasta el servidor de auth, dentro del `state` que recibe Google, y en la URL de
`/auth/callback` que queda en los registros de la app. Las cookies son
`sameSite=Lax`, así que una navegación de primer nivel basta.

Pero **no** se genera con `Math.random()`, como llegué a escribir aquí y —peor—
a fijar en un test: `generatePKCEFlowId()` usa `crypto.getRandomValues` sobre 16
bytes, y sólo cae a `Math.random` si `crypto` no existe, cosa que no ocurre en un
navegador. Son 128 bits de un CSPRNG. Lo explotable es la fuga por registros y
por el `state`, no la predicción.

### 14. `skip_nonce_check = true`
`supabase/config.toml` — Desactiva la protección de repetición del nonce de
OpenID. El propio fichero lo documenta como requisito del login local con
Google. **Revisar antes de que exista un proyecto hospedado.**

### 15. `additional_redirect_urls` — RESUELTO al separar los hosts
`supabase/config.toml` — Arrastraba `https://127.0.0.1:3000` con `https` mientras
la app servía por `http`. Al separar los hosts (T1) pasó a `http://localhost:3000`
y el defecto desapareció. Se deja registrado porque un test fija esta entrada, y
dejarla afirmando lo viejo convertía en mentira el fichero cuyo propósito es no
mentir sobre riesgos.

### 16. El límite de correos vive en dos sitios que no coinciden
`supabase/config.toml` dice `email_sent = 30`; el contenedor corre con
`GOTRUE_RATE_LIMIT_EMAIL_SENT=360000`. El test afirma sobre el fichero, que no es
lo que gobierna. Ver si el CLI lo traduce o si la clave es otra.

### 17. La suite no limpia los usuarios que crea
`e2e/pkce.ts` y `unit/helpers.ts` — sin teardown. **Medido el 2026-09-07: +43
usuarios por pasada de e2e y 6.846 filas en `auth.users`** (la entrada decía "~26
por pasada" y "más de 2.000", sin fecha, y llevaba tiempo siendo falsa: la misma
podredumbre que la regla de cifras fechadas vino a cortar). Ruido creciente y
pasadas cada vez más lentas.

### 18. Lo que se revirtió al reencuadrar, y por qué no reconstruirlo
Cuatro iteraciones fueron a afinar un presupuesto de cabecera —constantes,
bisección del techo, peor caso, sembrado sintético, adaptador de cookies propio—
para un límite que **producción no tiene**. Se retiró entero al separar los
hosts en desarrollo.

**Si alguien vuelve a ver un 431 en el endpoint de realtime, la causa no es el
límite: es que la app y Supabase han vuelto a compartir host.** El arreglo es la
topología, no el número. `e2e/host-separation.spec.ts` lo vigila.

### 19. Un borrado DURO de `items` no llega a los clientes conectados
Medido en el runtime check del 7 sep 2026, con dos suscripciones simultáneas:
con el filtro `group_id=eq.<id>` que usa `lib/useGroupChannel.ts:57` llegó
`["INSERT"]` y **ningún** `DELETE`; sin filtro sí llegó, con `old` conteniendo
sólo `{id}` y `new` vacío. La causa es que `items` tiene `relreplident = 'd'`
(identidad de réplica por clave primaria), así que la tupla vieja no lleva
`group_id` y no puede casar con el filtro.

**Hoy no afecta a nada**, y por eso no se arregla: la app **no borra en duro**.
`lib/items.ts` marca `deleted_at` en `softDeleteItem`, y ese camino viaja como UPDATE, lleva
`group_id`, casa con el filtro y va autorizado por RLS —
el comentario de `soltar` en `app/g/[id]/GroupView.tsx` ya lo documenta. Verificado en el navegador: la
fila borrada en suave desaparece sola; la borrada en duro se queda en pantalla
hasta recargar.

**Importa cuando llegue el purgado.** Cualquier trabajo futuro que borre filas de
verdad —retención, derecho de supresión, limpieza de históricos— dejará listas
abiertas mostrando ítems que ya no existen. Entonces habrá que elegir entre
`replica identity full` (que ensancha la exención de RLS sobre DELETE descrita en
B.3: la fila entera viajaría a cualquier suscriptor del grupo) o quitar el filtro
y descartar por `id` en el cliente. No se decide ahora porque no hay caso de uso.

---

# Añadido al cerrar el ciclo del arnés (2026-09-07)

Todo lo de esta sección es **instrumental**: guardas y arnés de pruebas. La
revisión final lo verificó con dos instrumentos independientes de las propias
guardas —barrido AST el 2026-09-07 sobre los 92 ficheros, y catálogo de la base— y confirmó que
**ninguno afecta a corrección, seguridad ni rendimiento del producto**. El ciclo
se cerró por la regla de impacto, no por haberse quedado sin trabajo.

### 20. El fallo cerrado marcará código correcto que aún no existe — CUMPLIDO (2026-09-09)
`unit/borradoFisico.ts` — La guarda marca todo `.delete()` cuyo receptor no pueda
demostrar inofensivo. Se eximieron los accesores de plataforma medidos
(`searchParams`, `cookies`, `headers`, `formData`, almacenamiento) y los `Set`/`Map`
tipados por parámetro. **Lo que no está exento y aparecerá:** un `Set` importado
de otro módulo, un `Map` en propiedad de clase, `useRef(new Set()).current.delete()`,
y cualquier accesor nuevo de Next.
**Qué hacer cuando pase:** añadir el accesor a `ACCESORES_SEGUROS` con una muestra
en `unit/muestras/borrados.ts`, no desactivar la guarda. Es el primer sitio donde
la spec de funcionalidad chocará, porque toca cookies y `searchParams`.

**Pasó, y se hizo lo escrito (2026-09-09).** El primer almacén local —la cola sin
red— trajo un `store.delete(clave)` de IndexedDB y la guarda lo marcó. Se añadió
`IDBObjectStore` a los tipos de colección reconocidos, con las **dos** mitades en
el banco: tipada exime, sin tipar sigue marcándose. La predicción era correcta
hasta en el fichero.

### 21. Formas de borrado que aún escapan a la guarda
- Acceso por corchetes con constante: `const m='delete'; admin.from('items')[m]()`
  y `const k='deleteUser'; admin.auth.admin[k](id)` — falta pasar el contexto de
  plegado en `propiedad()` (un argumento).
- `const { delete: borrar } = admin.from('items'); await borrar()`, y
  `.delete.call/.apply(...)`.
**Cerrado el 2026-09-08**, con la lista medida (V6, W2, X3, Y7): `execute` con
literal, con variable y con concatenación; el cuerpo de función como literal
(`as 'delete …'`); CTE con paréntesis anidados, con lista de columnas y
encadenadas; las estructuras de control de plpgsql —`for`, `foreach`, `while`,
`if`, `elsif`, `case`, `when`, `exception`, `loop` sin cabecera—, que se retiran
**hasta estabilizarse** porque una deja al descubierto la siguiente; y
`merge … when matched then delete`.

**Sigue abierto:** `with d as (delete from … returning *) select …`. El borrado va
**dentro** de la CTE, no después, y el despojado la retira entera. Medido, no
supuesto: la iteración 6 declaró cerrada la categoría entera y la revisión
demostró ocho formas vivas. Ésta queda nombrada en vez de tachada.
- `drop table` y `alter table … drop column` sobre tabla publicada.
**Cota:** ninguna aparece hoy en el repositorio; verificado por AST y catálogo.

### 22. La guarda de cifras da falsos positivos en prosa normal
`unit/checkpoint.test.ts` — Exige fecha a toda línea que nombre una puerta y
contenga un número. Medido: 11 de 14 frases realistas salen rojas, incluidas
`Playwright 1.62 arranca su propio servidor` y `este cambio toca 5 archivos`.
Empuja a fechar frases sin cifra perecedera, que es justo lo que acaba
desactivando una guarda. Y una fecha en la línea anterior exime la línea entera.

### 23. Comentarios que describen el mecanismo retirado
`unit/no-physical-delete.test.ts` y `unit/grants.test.ts` siguen llevando la marca
`guarda-borrado: sonda RLS`, que ya no exime nada —la exención la dan
`LINEAS_EXENTAS` más la marca `borrado-permitido` en la línea que deniega—. El
requisito que iba a arreglarlo (AA9) no tenía fila de DoD, y por eso nadie lo
detectó: **la cicatriz es esa**, no el comentario.

### 24. Tautologías supervivientes
`unit/app-origin.test.ts` y `unit/client-adapter.test.ts` — afirman que un regex
casa una cadena construida al lado: pasarían con las aserciones reales borradas
(§E.3). Es la misma forma que se retiró en otros dos ficheros.

### 25. Huecos de cobertura del barrido
`playwright.config.ts`, `vitest.config.ts` y `next.config.ts` quedan fuera, y
`unit/muestras/` está excluido en bloque.

### 26. El arnés sigue sin recoger los usuarios que crea
Ver entrada 17. Con la prohibición de borrar en duro, la limpieza tendrá que ser
una tarea explícita fuera del arnés, o un borrado suave donde el esquema lo
permita. **Medido el 2026-09-07: 7.922 filas en `auth.users`.**

## Del ciclo «que ningún fallo se quede sin contar» (cierre 2026-09-08)

*Las cuatro entradas siguientes comparten una causa: la iteración 10 convirtió R3
—«ninguna acción enseña el texto crudo»— en «demostrar estáticamente que ningún
refactor futuro podría enseñarlo». El registro de ese salto y su coste está en
`docs/CHECKPOINT.md`. Lo que queda vivo son los huecos de esa demostración, y
todos ellos son **hipotéticos**: ninguno se ha observado en el código que se
ejecuta, y los cuatro caminos de fallo están verificados en navegador.*

### 27. La guarda de contaminación es fail-open por construcción
`unit/contaminacion.ts` + `unit/textoCrudo.ts` (`usosIndebidosDelError`) — 833 +
282 líneas de análisis de flujo sobre el AST, sin información de tipos ni
resolución entre módulos. **Nueve rondas de revisión encontraron nueve familias
de escape distintas** (la forma de la salida, el nombre de la semilla, el
receptor del campo, el objeto que trae el error, el cuerpo de un callback…), y la
última las midió sobre los ficheros reales con la puerta entera en verde.

No hay razón para creer que la décima no exista. **Verde aquí no es prueba**: es
que ninguna de las formas conocidas está presente. Lo que sí es prueba, y es lo
que sostiene R3 de verdad, son dos cosas baratas: `Result` ya no lleva texto
—`avisarTexto(r.error)` no compila (`unit/texto-crudo.test.ts`, DoD 112)— y
`lecturasDeMensaje`, que prohíbe leer `.message` fuera de `lib/errors.ts` en los
22 ficheros de producto sin analizar nada.

*Contención:* las dos reglas baratas de arriba, más los cuatro caminos
verificados en Chrome contra build de producción el 2026-09-08.
*Si se retoma:* no ampliar el motor forma a forma. O se apoya en el compilador
(un tipo `Opaco<string>` que sólo `lib/errors.ts` sepa abrir) o se acepta que es
una red, no una demostración.

### 28. La cota de D.6 se apagó por seis vías distintas en seis rondas
`unit/cota-sesion.test.ts` (1.057 líneas) — reconoce el cliente de auth siguiendo
el dato, cruza ficheros para encontrar accesores y exige la cota a quien exporta
algo derivado de la sesión. Aun así, cada revisión encontró una vía nueva: el
nombre del parámetro, la forma de la condición, el izado a variable, el paso como
argumento, las cinco maneras de exportar el símbolo, el parámetro desestructurado
de un callback.

*Contención:* el `Promise.race` de 2 s está puesto y probado en los dos sitios
que lo necesitan (`GroupView.tsx`, `lib/errors.ts`), y `unit/timeouts.test.ts`
vigila la cota de transporte de las tres fábricas.
*Si se retoma:* lo que fallaría en producción es una espera muda de 30 s, que es
observable. Un test de comportamiento con el servicio de auth colgado vale más
que la séptima forma sintáctica.

### 29. El ancla de la trayectoria puede ponerse roja sola
`unit/trayectoria.ts` — busca en todo el repositorio la etiqueta de las tres
rondas siguientes a la última fila escrita. **Tres veces durante este ciclo se
puso roja por su propia documentación**: al escribir una etiqueta futura como
ejemplo en un comentario o en un caso de test. Se resolvió componiendo las
cadenas en vez de escribirlas, pero la trampa sigue puesta para quien no lo sepa.

*Contención:* está dicho en el comentario del propio fichero.
*Coste si se deja:* un rojo desconcertante y cinco minutos de quien lo sufra.

### 30. `funcionesQueSanean` decide sobre el traductor, no sobre quien lo usa
`unit/traductor.ts` — calcula qué exportaciones de `lib/errors.ts` sanean de
verdad, con un punto fijo sobre el módulo. Es la parte del andamiaje que mejor
envejece, pero sólo mira **ese** fichero: un traductor en otro módulo no lo
reconocería nadie.

*Contención:* hoy no existe otro traductor, y `unit/texto-crudo.test.ts` exige
que toda función exportada del traductor la llame alguien.

### 31. `VERSION` del service worker no va atada al build
`public/sw.js:20` — `const VERSION = 'super-v2'` es un literal escrito a mano, y
`sw.js` no se regenera en cada build, así que sus bytes son idénticos entre
despliegues. Dos consecuencias medidas (2026-09-09):

- **El shell se congela en el build de la primera instalación.** El navegador no
  reinstala si los bytes no cambian, y `activate` sólo purga cachés `super-*`
  distintas de la actual, que nunca las hay. Un arreglo en `/sin-conexion` no le
  llega nunca a quien ya lo tiene instalado.
- **La purga de M4 puede llevarse la caché del worker vivo.** Como un instalador
  nuevo abre la **misma** caché que sirve el worker activo, una actualización
  cuyo precacheado falla acaba en `(sin cachés)`: quien tenía modo sin red lo
  pierde. Disparador exacto: cambiar los bytes de `sw.js` sin subir `VERSION`.

*Contención:* `sw.js` no se ha desplegado nunca, así que hoy no hay worker activo
que perder; y subir `VERSION` en el mismo cambio hace que la purga caiga sobre la
caché nueva y la vieja sobreviva.
*Si se retoma:* derivar `VERSION` del `buildId` —sirviendo `sw.js` desde un
manejador de ruta, o inyectando un hash al construir— y atarla con un test al
artefacto. Es también lo que arregla el punto primero.

### 32. La justificación escrita de DoD 66 no se corresponde con el código
`docs/CHECKPOINT.md` y el comentario de `public/sw.js` dicen que un reintento
«sólo pedía los chunks que faltaban». Medido: el `install` **siempre** vuelve a
pedirlo todo; no hay ninguna rama que salte lo ya cacheado. La cadena de
envenenamiento la cierra la comprobación de `content-type` (DoD 67), no la purga
(DoD 66) — quitando sólo la purga, el chunk sigue limpio.

*Contención:* la purga sigue siendo correcta y su test se pone rojo al quitarla;
lo que sobra es la explicación.
*Coste si se deja:* la próxima revisión da por bueno un mecanismo que no existe, y
alguien podría quitar la guarda que sí cierra la cadena creyendo que es la otra.

### 33. La instalación del service worker es todo-o-nada sobre 11 recursos
`public/sw.js` — el `Promise.all` exige los 11 `/_next/static/` que el HTML del
shell referencia (medido sobre `.next/server/app/sin-conexion.html`, 7.878 B). Un
solo 404 o un corte de red durante `install` deja el dispositivo **sin** service
worker, y el reintento sale sólo de `app/RegistrarSW.tsx` (`useEffect([])`): uno
por carga completa de página.

*Contención:* es la decisión de K3/M2 y es la correcta frente a la alternativa —un
worker instalado que no hidrata—, porque este estado se autorrepara con la primera
instalación entera que salga bien.
*No medido:* que el navegador no reintente por su cuenta un `install` que rechaza
está inferido de la especificación, no comprobado en navegador.

### 34. Con red, un alta que falla mientras se teclea se pierde — RESUELTO (2026-09-12)
`app/g/[id]/GroupView.tsx` — era la única pérdida de datos del camino principal:
si el alta con red fallaba y el usuario había tecleado mientras tanto, lo enviado
no volvía al campo ni entraba en cola.

**Resuelto.** Un fallo de clase `servidor` —que es lo que `claseDe` devuelve para
todo error sin código: red caída, pasarela, o el proyecto pausado del plan
gratuito— encola el alta por la misma puerta que la rama sin red, y un reintento
acotado (`esperasDeReintento()`) la drena sin esperar a que cambie `sinRed`. El
contrato cambió a propósito: lo fallido ya **no** vuelve al campo, va a la cola y
se envía solo.

**Medido al construirlo, y conviene que quede:** `'red'` no es alcanzable en este
camino. `addItem` traduce con `claseDe`, que devuelve `'servidor'` para todo lo
que no trae código; `clasificar` —lo único que produce `'red'`— sólo se alcanza
con código. La primera versión aceptaba las dos clases y cuatro ítems del DoD
seguían verdes con un producto que no encolaba nada. Es la segunda vez que este
proyecto retira una rama `'red'` inalcanzable; la primera está en
`lib/items.ts:62`.

**Lo que sigue abierto,** anotado al cerrar: la regla de admisión y la de
retención discrepan. `onAdd` se niega a encolar nada que traiga código, pero
`drenarUnaVez` conserva en cola lo que falle al drenar con cualquier código que no
sea `23505`, incluido un `42501`. Una entrada admitida por fallo de red que luego
tope con un `42501` se reintenta en cada montaje y cada cambio de red hasta que
`reparte` la descarte a las 24 h. Es preexistente; la puerta nueva lo hace más
alcanzable.

### 35. El banco del service worker acepta lo que el producto ya no usa
`unit/sw.test.ts` — el doble de caché conserva `add` y `addAll`, que el producto
dejó de llamar en M4, y son permisivos: ignoran `redirected` y el `content-type`.
Además `match` indexa un `Map` por cadena, pero el manejador `fetch` le pasa el
**objeto** `request`, así que ninguna prueba unitaria puede observar hoy que el
worker **sirva** una entrada envenenada; sólo se observan las escrituras.

*Contención:* medido que el producto no llama a `add`/`addAll`, y las escrituras
sí se afirman.
*Coste si se deja:* es el hueco que dejó pasar el envenenamiento de chunks hasta
que una sonda externa lo midió. Clavear por URL absoluta aceptando cadena u objeto
es el arreglo.

### 36. Las peticiones de la instalación no llevan cota
`public/sw.js` — los 12 `fetch` del `install` no tienen timeout explícito, contra
D.6. Un portal que acepta la conexión y no contesta cuelga la instalación hasta el
límite del navegador.

*Contención:* no rompe nada; retrasa la instalación, y el shell viejo —si lo
hay— sigue sirviendo.

### 37. `haySesionLocal` no deriva el nombre de la cookie del SDK
`lib/sesionLocal.ts` — la expresión acepta cualquier cookie con la forma
`sb-…-auth-token`, sin atarla a `NEXT_PUBLIC_SUPABASE_URL` ni a
`cookieOptions.name`. Probadas 17 formas de tarro (referencia hospedada, trozos
`.0`/`.1`/`.10`, `localhost`, dominio propio, con `-code-verifier` delante): hoy
**no hay falso negativo**, y `@supabase/ssr` no usa prefijos `__Secure-`.

*Coste si se deja:* si alguien fija `cookieOptions.name`, la función devuelve
`false` en silencio y el shell no vuelve a pintar ninguna instantánea.

### 38. `if (busy) return` es un retorno mudo
`app/g/[id]/GroupView.tsx` — justo lo que R2 prohíbe en la línea de al lado, pero
hoy inalcanzable: el botón es `disabled={busy}` y el envío con Enter tampoco
dispara. Queda como defensa sin salida visible; si algún día se quita el
`disabled`, vuelve el silencio.

### 39. Las marcas de ronda de este ciclo chocan con las del primero
El cuarto ciclo etiquetó sus rondas `I`–`M` en el código, y esas letras ya las
había usado el primer ciclo: medido al cerrar, **242 ocurrencias** repartidas
(`I` 62, `J` 77, `K` 52, `L` 31, `M` 20) con los rangos numéricos solapados —
`I10` significa «la conexión de IndexedDB se reutiliza» en `lib/local.ts` y «las
tres consultas van a la vez» en otro fichero. No se puede renombrar con una
expresión regular sin leer cada sitio.

Lo cazó `unit/trayectoria.ts`, que exige que el código de la última fila de la
trayectoria sea monótono: al escribir la fila `(M)` el ancla retrocedió por debajo
de `N1`, que ya existía, y se puso roja.

*Contención:* la tabla del checkpoint lleva el **código global** (`AK`–`AO`) y
dice en cada fila qué marca buscar en el código, con un aviso encima.
*Si se retoma:* renombrar leyendo cada ocurrencia, o —más barato— dejar de reusar
letras: el siguiente ciclo empieza en `AP`.

## Del ciclo de la deuda 34 (cierre 2026-09-12)

*Todo lo de esta sección sale de las cinco revisiones del ciclo. Ninguno bloquea
el cierre: se midieron y se dejaron fuera por la regla de impacto o por decisión
del usuario. Los cuatro primeros son **el mismo problema** y tienen spec propia
pendiente: el ciclo de vida de aviso-y-recuperación.*

### 40. El aviso de la cola se retira antes de saber si la relectura acierta
`app/g/[id]/GroupView.tsx` — la limpieza del aviso `deCola` va **antes** de la
relectura. Con `loadClase` nulo no hay aviso derivado que tome el relevo, así que
una relectura fallida deja la pantalla sin ninguna señal.
**Cota medida:** sin red aparece el banner de sin red; con el canal caído aparece
el de canal degradado y `onResync` avisa. La ventana descubierta es «red arriba +
canal vivo + sólo PostgREST cayendo», y ahí el canal sigue entregando los cambios
ajenos, así que la lista no se queda rancia de verdad.

### 41. `secuencia` sella dos cosas distintas a la vez
Es la generación de los **avisos** y también la del reintento de **carga**. De ahí
salieron tres de las cuatro regresiones de este ciclo: tocar el alta mataba el
reintento, o al revés. Separarlas es el núcleo de la spec pendiente.

### 42. `avisar` acopla «enseñar un mensaje» con «arrancar un bucle»
Para clase `servidor` lanza además `reintentar`. Por eso quitarlo de un sitio se
llevó por delante la recuperación de la lista, sin que nada lo dijera.

### 43. El refinado por red no se aplicó a los gemelos
`sinRedVivo` sólo lo usa la rama de la cola. `avisar` sigue refinando con el
`sinRed` del render, así que la edición y el borrado siguen diciendo «el servicio
está despertando» a quien acaba de quedarse sin conexión. Medido con dos sondas.

### 44. `setNotice` suelto en el drenado
`GroupView.tsx` — es el único sitio que limpia el aviso sin sellar `secuencia`,
que U3 tiene escrito como regla. Hoy inalcanzable: la guarda `deCola` impide
limpiar justo los avisos sobre los que puede haber un afinado en vuelo. Si alguien
quita esa guarda, el defecto de U3 vuelve y no hay prueba encima.

### 45. La prueba del DoD 26 es menos específica que su nombre
`unit/drenado.test.tsx` — afirma que hay aviso, y monta con `loadClase='servidor'`,
así que la satisface el aviso **derivado** tomando el relevo. No distingue «el
aviso de la cola sobrevivió» de «otro lo sustituyó». Es válida —su sonda la pone
roja— pero para cerrar la 40 hace falta el gemelo con `loadClase` nulo.

### 46. `eslint` corre sin `--max-warnings` — RESUELTO (2026-09-13)
Cualquier número de avisos salía con código 0, así que la puerta pasaba mientras
el linter nombraba un defecto. Pasó durante cuatro iteraciones del ciclo de la
deuda 34. El arreglo mecánico fue `--max-warnings 0`; el de criterio, leer la
salida y no sólo el código.

`unit/puerta-lint.test.ts` lo vigila por cuatro sitios: que un aviso sembrado
ponga la puerta roja, que las supresiones en línea estén declaradas una a una,
que ninguna directiva silencie sin nombrar su regla, y que toda configuración de
eslint escrita en el código esté en un inventario declarado.

## Del ciclo «la puerta no pasa con avisos del linter» (cierre 2026-09-13)

### 47. Nada ejecuta la puerta salvo una persona que la teclea
No hay `.github/` y no hay hook de git instalado: `.git/hooks` sólo tiene los
`.sample` y `core.hooksPath` está sin fijar. La §C de `CLAUDE.md` dice «los hooks
son ley», y no hay hook que sea ley: endurecer el script es real, pero su
cumplimiento es voluntario. Medido el 2026-09-13.

Un matiz que la primera redacción de esta entrada se dejó, y que apunta al
contrario: `unit/puerta-lint.test.ts` ejecuta `pnpm lint` y `npx eslint`, así que
**`pnpm test` sí corre el linter**. La mitad `lint` de la puerta va enganchada a
la suite; lo que no ejecuta nadie automáticamente es la suite.

Se dejó fuera a propósito: instalar un hook o un CI cambia el flujo de trabajo
del usuario, que es quien commitea, y eso es decisión suya y no del ciclo.

### 48. La configuración de eslint no está gobernada por nada
Medido el 2026-09-13, y **corregido** el mismo día: la primera redacción decía
que apagar `@typescript-eslint/no-unused-vars` en `eslint.config.mjs` no lo cazaba
**ninguna** de las guardas. Es falso, y se comprobó apagándola: caen **2 de 3**
(la del aviso sembrado y la de la supresión sembrada), porque las dos siembran
usando esa regla.

El hueco real es más estrecho y sigue abierto: apagar —o ignorar el fichero de—
una regla **de la que ninguna guarda dependa**, como `no-console` o
`@next/next/no-img-element`, deja las guardas en verde. La puerta gobierna lo que
el linter dice, no lo que al linter se le manda decir desde su configuración.

Se rechazó cerrarlo en el mismo ciclo por dos motivos escritos: la Spec A pone
«cambiar qué reglas de eslint están activas» fuera de alcance por su nombre, y
«qué reglas son portantes» no tiene final — se responde otra vez con cada regla
nueva. Quien lo retome, que le ponga ese límite por escrito antes de empezar.

### 50. Un plugin puede silenciar sin que eslint se entere
Medido el 2026-09-13. `eslint-plugin-react-hooks` (7.1.1) busca
`$FlowFixMe[react-rule-hook]` o `$FlowFixMe[react-rule-unsafe-ref]` en **cualquier
comentario** y hace `continue` sobre el diagnóstico en vez de reportarlo. No hay
mensaje, no hay `suppressedMessages`, y el código de salida no se mueve: un
`react-hooks/rules-of-hooks` pasa de 1 error a 0 y `pnpm lint` sale 0.

Alcance real, también medido: silencia `rules-of-hooks`; **no** silencia
`exhaustive-deps` ni `set-state-in-effect` puesta sobre el efecto. La marca
concreta está en el inventario de `unit/puerta-lint.test.ts` y sale roja sembrada,
3 de 3.

**Lo que queda abierto es la clase, no la instancia.** El inventario cierra la
familia de comentarios de configuración *de eslint*; no puede cerrar un canal que
un plugin futuro invente sin pasar por eslint, porque no habría nada que observar
salvo el código del plugin. Quien añada un plugin de lint a este proyecto: mirar
si trae su propio mecanismo de silenciado, y si lo trae, añadirlo al inventario.

### 51. `DoD 44` de la separación de hosts nació rojo y se contó como verde — RESUELTO (2026-09-13)
Medido el 2026-09-13. `e2e/host-separation.spec.ts:105` —«la app no atiende en el
host de Supabase»— **no puede pasar en esta máquina, y no ha pasado nunca.**

**La causa.** El arnés arranca `next start --hostname localhost`. En macOS
`localhost` resuelve a `127.0.0.1` —lo hacen igual las tres versiones de Node
instaladas, 24.14.0, 24.14.1 y 25.2.1— así que el servidor liga `127.0.0.1:3000`,
comprobado con `lsof`. Y `NEXT_PUBLIC_SUPABASE_URL` es `http://127.0.0.1:54321`.
O sea: la app **sí** atiende en el host de Supabase, porque `localhost` y
`127.0.0.1` son la misma interfaz. La aserción es imposible por construcción.

**Lo que el test creía proteger no se protege así.** La separación que importa es
la del **tarro de cookies del navegador**, que sí trata `localhost` y `127.0.0.1`
como hosts distintos. Eso lo comprueban los otros tres casos del mismo fichero, y
están verdes. `DoD 44` pide una separación a nivel de TCP para proteger una
propiedad de cookies: son capas distintas (§E.1).

**Desde cuándo, comprobado y no estimado.** Se montó un árbol de trabajo aparte en
`d1a19d6` (2026-09-07, el commit que creó el test), con `pnpm install
--frozen-lockfile` sobre el mismo lock, y **falla ahí igual**, con el mismo
mensaje. El fichero y `playwright.config.ts` no se han tocado desde ese día, y
`pnpm-lock.yaml` no tiene un solo cambio desde entonces.

**Y el checkpoint lo declaró verde tres veces.** «42 — 2026-09-07», «EXIT=0 las
tres, 81/81 — 2026-09-09». Las cifras de total son correctas —42, 60, 81 y 82
casos, contados con `playwright test --list` en cada commit—, así que no es un
«81 de 82» mal leído: es una afirmación de verde sobre una suite que tenía un
rojo. El 2026-09-12 la suite ya no se ejecutó, declarado.

**Límite de esta investigación:** `.env.local` está fuera del control de versiones
y `E2E_BASE_URL` es una variable de entorno, así que no puedo reconstruir qué
valores tenían aquellos días. Todo lo que **sí** se puede inspeccionar —el test,
la configuración de Playwright, las dependencias, `supabase/config.toml`,
`.env.example`, `/etc/hosts` y las tres versiones de Node— es incapaz de haber
hecho pasar ese caso. No puedo probar que el verde de entonces fuera falso; sí
puedo decir que ninguna palanca inspeccionable lo explica.

**Cómo se arregló.** `DoD 44` y su sonda `DoD 53` se retiraron de
`e2e/host-separation.spec.ts`, y la propiedad se comprueba donde vive su
requisito (§E.1): `hostCompartido()` en `e2e/appOrigin.ts`, ejercitada desde
`unit/app-origin.test.ts`. Afirma lo que de verdad separa las cookies —que el
host de la app y el de Supabase son **nombres** distintos—, no una separación de
TCP que dos alias de loopback no pueden dar.

Puesta roja por mutación, 3 de 3 pasadas, por las dos variables que pueden
juntarlos: `NEXT_PUBLIC_SUPABASE_URL=http://localhost:54321` y
`E2E_BASE_URL=http://127.0.0.1:3000`. Lleva sonda de lector con cuatro casos que
debe cazar —incluidos `LOCALHOST` y `[::1]`— y dos que no debe.

Los tres casos de cookies de `host-separation.spec.ts` siguen donde estaban: son
los que miden el efecto en el navegador, y son los que nunca fallaron.

**`pnpm test:e2e` sale EXIT=0 el 2026-09-13, 80 casos.** Es el primer verde de la
suite comprobado por mí de punta a punta.

### 52. Nadie abre la app y la usa como una persona desde el 2026-09-09
Leído del propio `docs/CHECKPOINT.md`, no estimado:

- **2026-09-07** y **2026-09-08**: login real de Google en el navegador, build de
  producción, sesión real del usuario.
- **2026-09-09**: «Chrome real, a mano, con la app apagada». Última vez.
- **2026-09-12** (deuda 34): declarado que **nadie** lo miró a mano; en su lugar,
  Playwright a 390×844 con `isMobile`.
- **2026-09-13** (puerta del linter): tampoco, y declarado, con el motivo de que
  el cambio no tiene superficie de navegador — que es cierto para *ese* cambio.

Cuatro días y dos ciclos con la app ejercitada sólo por la suite. El motivo de
cada salto era bueno por separado; el efecto acumulado no lo es, y **el defecto de
la deuda 51 es de esa familia**: una guarda que lleva seis días roja mientras el
registro decía verde tres veces. La suite mide lo que alguien escribió que
midiera; una persona usando la app mide lo que nadie escribió.

Concreto, para que no sea una buena intención: la próxima vez que se cierre un
ciclo que toque superficie de navegador, la pasada a mano no se sustituye por
Playwright; y si se salta, el motivo va con fecha, como aquí.

### 53. Sin cobertura y recargando, el mecanismo de la app no está montado
Medido en Chrome el 2026-09-13, a 390×844, contra build de producción y con sesión
real sembrada. Recargando dentro de un grupo sin red, el service worker sirve
`app/sin-conexion/page.tsx`: la URL sigue siendo `/g/<id>` pero **`GroupView` no
se monta**, así que `avisar`, `reintentar`, `useSinRed` y la cola **no existen en
pantalla**. Por `data-testid`: hay `sin-red`, `items`, `item`; no hay `item-name`
ni `add-item`.

Con la pestaña ya abierta sí funciona entero: el aviso pasa a «puedes apuntar», se
tecleó un producto con el gesto, y al volver la red llegó a la base y el aviso se
retiró solo.

**Por qué importa el orden de trabajo:** la cabecera del propio worker dice que
existe porque el App Shell «no sobrevive a cerrar la app, que es justo lo que pasa
entre una compra y la siguiente». En ese camino exacto —el que motivó construirlo—
la cola no está. Y la cáscara no se entera de que vuelve la red: ocho segundos
medidos con el servidor ya levantado, mismo banner.

Esto **reordenó el trabajo**: la Spec C (la cáscara) va antes que la Spec B (el
mecanismo de aviso-y-recuperación), porque depurar un mecanismo ausente antes de
arreglar su ausencia es el orden equivocado. La C está sellada en `docs/spec.md`.

### 54. El sondeo del framework y el propio conviven — ACOTADO (2026-09-13)
`next/dist/esm/client/app-index.js:248` hace `require('./components/offline')` en
**toda** página del App Router cuando `__NEXT_USE_OFFLINE`, y ese módulo registra
`window.addEventListener('offline', …)` y entra en su bucle desde cualquier fetch
del framework que falle. **No depende de que `useSinRed` esté montado**: el hook
es sólo el lado de lectura.

**Historial de esta entrada, porque importa cómo se llegó aquí.** La revisión de
la iteración 2 midió el bucle; yo escribí que no se reproducía apoyándome en tres
mediciones propias que daban cero, y **sustituí una explicación correcta por una
equivocada**. Mis ceros eran honestos para la condición que medí —documento ya
cargado sin red, y el ratón *por encima* de la salida— y falsos como conclusión.
Pulsando, sale a la primera:

    63ms  GET  /          ← la recarga        3581ms  HEAD /g/…
    69ms  HEAD /g/…                           6027ms  GET  /g/…  ← sonda propia
   573ms  HEAD /g/…                           6584ms  HEAD /g/…
  1576ms  HEAD /g/…                           9588ms  HEAD /g/…
  2023ms  GET  /g/…  ← sonda propia           → 6 HEAD en 10 s

**Acotado, no cerrado.** La salida de la cáscara pasó a ser un enlace normal en
vez de `next/link`: así la navegación la intercepta el service worker y el
framework no ve ningún fetch fallado. Medido: **0 HEAD**, dos pasadas; volviendo a
`next/link`, **6 HEAD**, dos pasadas. Lo vigila
`e2e/sin-red.spec.ts` («no despierta el sondeo del framework»), y la supresión del
linter que eso exige está declarada en el inventario de `unit/puerta-lint.test.ts`.

**Lo que queda abierto:** cualquier otro fetch del framework que falle sin red
—una navegación desde otro sitio de la app, un reintento de RSC— vuelve a
arrancarlo. Esta entrada acota **la salida de la cáscara**, que es el camino que
se midió. Quien toque la cáscara: si añade otra navegación, medir primero con
`page.on('request')`, que es de una línea.

### 55. Una recarga se lleva el borrador sin enviar
Medido en la revisión de la iteración 4. La sonda recarga en cuanto acierta si no
hay un envío en vuelo, pero el texto **tecleado y no enviado** se va con la
recarga: sin ficha, sin aviso y sin rastro. Con la cadencia en su techo de 30 s y
unos 5 s de tecleo por producto, del orden de **1 de cada 6 recuperaciones**.

Se dejó fuera de la Spec C por su nombre: persistir el borrador y rehidratarlo al
volver a la vista cruza a `app/g/[id]/GroupView.tsx`, que es la Spec B. La otra
opción —posponer la recarga mientras el campo no esté vacío— ancla al usuario en
la cáscara si se olvida texto escrito, y es una decisión de producto.

### 49. El inventario de supresiones no ve un movimiento dentro del mismo fichero
Es un multiconjunto de pares *(fichero, regla)*: a propósito, porque fijar la
línea haría que cualquier edición por encima lo moviera. El precio, medido: mover
una supresión dentro del mismo fichero y con la misma regla no se distingue.
Importa para la Spec B, que reescribe justo `app/g/[id]/GroupView.tsx`. Está
declarado en el propio fichero de la guarda.

---

## 55 — Afirmar por razonamiento lo que se comprueba ejecutando (2026-09-15)

**No es deuda de producto: es de método, y se anota aquí porque todavía no tiene regla
escrita.** Se deja con los tres casos nombrados para que, si vuelve a pasar, el
argumento esté hecho y no haya que reconstruirlo.

Tres veces en el mismo ciclo, la misma forma: una conclusión correcta en sus hechos y
falsa en su alcance, sacada de enumerar el código en vez de ejecutarlo.

1. **Retirar R6** (spec de la duración, §9b). Se enumeraron las dos escrituras de
   `envio.current` y se concluyó que el camino era inalcanzable. Cierto **dentro de una
   instancia**; falso en cuanto hay dos, que es lo que §D.3 obliga a asumir. La revisión
   lo reprodujo 4 de 4.
2. **Declarar no probado el camino 3** (spec «pantalla y estado durable», §3). Se
   escribieron dos sondas, ninguna reprodujo, y se dedujo que hacía falta aislar tres
   cosas. La revisión lo reprodujo cambiando dos: solapar las pulsaciones dentro de una
   tarea, y que el doble de `encolar` **escribiera** en la cola. `encolar` 2, cola con
   el producto duplicado.
3. **El comentario de `app/sin-conexion/page.tsx`** que afirmaba que la cáscara no
   necesitaba `visibilitychange` «porque el sondeo ya escucha la visibilidad». Medido
   falso: el sondeo sólo recarga **cuando vuelve la red**, y esa pantalla existe porque
   no hay red. Tras `visibilitychange`, cero relecturas.

**Lo que los tres comparten:** la enumeración era correcta y la conclusión no, y en los
tres el coste de ejecutarla era minutos. El primero costó una vuelta entera; el segundo
selló una spec sobre una premisa falsa; el tercero dejó media pantalla sin arreglar.

**Por qué no se escribe como regla todavía:** `spec` ya lleva la cicatriz de la
inalcanzabilidad probada en un solo sitio, y ensancharla sin un cuarto caso sería
escribir dos veces lo mismo con otras palabras. Si vuelve a ocurrir, esta entrada es el
caso que lo justifica.

## 56 — La regla de la ausencia vive donde se gradúa, no donde se escribe (2026-09-15)

`review` lleva escrito que **una afirmación de ausencia no se comprueba con `grep`**:
exige el instrumento estructural correspondiente. Pero esa regla está donde se gradúan
afirmaciones, y las guardas de ausencia se **escriben** durante `build`.

Medido en este ciclo: la sonda del ítem 6 de la spec «pantalla y estado durable»
afirmaba que ningún escritor de la cola puede saltarse el aviso, leyendo el módulo con
una expresión que sólo reconoce la forma `escribir(COLA, …)`. La revisión sembró
`conTienda<undefined>(COLA, 'readwrite', t => t.clear())`: compila, lintea con cero
avisos, y los 1.533 tests siguen verdes. La guarda afirma una ausencia y sólo mira una
forma de estar presente.

Queda anotado, sin regla, por el mismo motivo que la 55: un caso no basta para decidir
si la regla debe mudarse a `build`, duplicarse, o si basta con que las guardas de
ausencia enumeren sus formas.

**DECIDIDA (2026-09-17), y la respuesta no era ninguna de las tres.** El ciclo «el
duplicado lo impide la escritura» dio los otros dos casos, en el mismo fichero y sobre la
misma afirmación: el inventario de menciones de línea que sustituyó al patrón cazaba 7 de
11 —se le escapaban plantilla, comillas dobles, concatenación y una coartada—, y el lector
AST que sustituyó al inventario caza las once sembradas pero se le escapan un comentario o
una cadena que nombren `avisarDeLaCola` en el cuerpo, y **un solo salto de indirección**.

Tres instrumentos, cada uno mejor que el anterior, y los tres cortos. Lo que decide no es
dónde vive la regla: es que **una afirmación de ausencia universal no la sostiene ningún
instrumento particular**, así que la guarda debe **acotar su enunciado a lo que comprueba**
y declarar qué queda fuera, igual que un falso declara en qué no es fiel. Enumerar formas
—la tercera opción de arriba— es la carrera que el que escribe código gana siempre.


## 57 — Lo que la revisión de la iteración 2 dejó sin construir (2026-09-17)

Nueve hallazgos, **todos de sostén**, anotados al cerrar el ciclo «el duplicado lo impide
la escritura». Ninguno toca A.1, A.2, A.3 ni ningún *hard fail*: el producto pasó las tres
revisiones sin un solo hallazgo de comportamiento.

**Por qué no entran en una cuarta vuelta, incluidos los dos HIGH.** La regla de impacto
manda parar: el producto lleva **tres vueltas correcto** —24 mutaciones cazadas, las dos
mitades del caso de navegador rojas sin su mecanismo— y lo que se iteraría es el **cuarto
instrumento sobre el mismo enunciado universal**, después de que los tres anteriores se
quedaran cortos. Una cuarta versión encontraría su propio escape, que es lo que dice la
56. Lo que sí se hizo en su lugar, y cuesta una línea en vez de una vuelta: **acotar el
enunciado de la guarda a lo que de verdad comprueba y declarar lo que queda fuera**
(`unit/almacen.test.ts`, cabecera del describe de R3). Las dos formas que se le escapan
—57.1 y 57.2— están escritas ahí, en el sitio donde alguien las va a leer antes de
añadir un escritor, y no sólo aquí.

Un guarda que promete lo que cubre vale más que uno que promete el universo y se lo cree.

### 57.1 El lector AST da por anunciada una escritura si el texto de su función menciona al avisador
`unit/almacen.test.ts:489` — `anuncia` es `getText().includes('avisarDeLaCola')`, o sea un
substring sobre el **texto fuente**. Probado: un comentario dentro del cuerpo
(`/* no hace falta avisarDeLaCola */`) y una cadena (`const nota = 'no llamamos a
avisarDeLaCola'`) marcan como anunciada una escritura muda. Es la clase de defecto
—comentarios y cadenas engañando al escáner— que motivó tirar la guarda léxica, dentro del
parser que vino a arreglarla.
**Qué lo contiene:** las once siembras, que sí se cazan; y que ninguna escritura real del
módulo usa esa forma.
**Arreglo:** resolver el aviso por AST — una `CallExpression` cuyo callee sea el
identificador— en vez de por texto. Dos líneas.

### 57.2 Un salto de indirección derrota al lector entero
`unit/almacen.test.ts:442` — `const guardar = (t, f) => escribir(t, f)` seguido de
`guardar(COLA, cb)` produce **cero sitios**: sólo se ven llamadas directas a las cuatro
puertas con nombre resoluble.
**Qué lo contiene:** hoy no existe esa indirección en el módulo, y la sonda del propio
lector afirma las tres puertas reales.
**Arreglo — y aquí la recomendación es NO perseguir la forma:** acotar el enunciado del
test a lo que comprueba y declarar lo que queda fuera. Ver la 56, que este ciclo decide.

### 57.3 La sonda del clasificador puede desaparecer en silencio
`pasada.sh:275-279` — la comprobación de que la mutación NEUTRA sobrevive sólo recorre la
lista de cazadas. Si la NEUTRA cae en «no aplicables» porque su ancla se movió, nadie dice
nada y la pasada se da por buena **sin sonda de clasificador**.
**Arreglo:** afirmar que la NEUTRA está *en* supervivientes, no que falta de cazadas.

### 57.4 Falso positivo del lector sobre lecturas por transacción cruda
`unit/almacen.test.ts:483` — `db.transaction(COLA,'readonly')` + `tx.objectStore(COLA)`
sale marcada como escritura muda: el sitio de `objectStore` no lleva modo y se clasifica
como escritura (fallar cerrado). Una lectura legítima futura pondría la guarda roja con un
mensaje que señala otra cosa.
**Arreglo:** heredar el modo de la transacción que envuelve.

### 57.5 Una sombra local de `COLA` ciega al lector
`unit/almacen.test.ts:445` — el mapa de constantes es plano, sin ámbito: un
`const COLA = 'otra'` local en cualquier función deja el lector sin ver la cola.
**Qué lo contiene:** la sonda del propio lector se pone roja (afirma las tres puertas),
así que no es un hueco silencioso — pero el mensaje apunta al sitio equivocado.

### 57.6 El falso de `almacen.test.ts` no declara en qué no es fiel
`unit/almacen.test.ts:44-52` — ahora modela la vida de la transacción, pero no dice que
`put`/`delete` **no** cuentan como peticiones vivas, al revés que IndexedDB real. El otro
falso de la suite sí lleva su declaración desde la iteración 1.

### 57.7 `viva` no libera si `hacer` lanza
`unit/almacen.test.ts:52` — se incrementa antes de llamar; una excepción dejaría la
transacción sin cerrar y el caso colgado hasta el timeout de 20 s en vez de fallar legible.

### 57.8 El `3` del punto fijo no dice por qué 3
`unit/almacen.test.ts:461` — medido: las cadenas de alias en orden de fuente resuelven en
una vuelta, así que es holgura sin justificar.

### 57.9 La lista del DoD admite una lectura generosa de su propio orden
`scratchpad/dod-iter2.md:5` — dice «no se había corrido `typecheck && lint && test &&
build`», que se lee como que `typecheck` no corrió. Corrió suelto, como comprobación de
compilación, antes de cerrar la lista. El instrumento contra el maquillaje no puede
permitirse una redacción elástica.

## 58 — Un `put` que lanza sale como error no capturado (2026-09-17)

**El único hallazgo de producto de todo el ciclo, y es de ruido.** `lib/local.ts:229-237`
— al mudarse el `put` dentro del `onsuccess` del `getAll`, dejó de estar cubierto por el
`try/catch` de `escribir`: un `put` que lance (cuota, por ejemplo) sale como excepción no
capturada en el callback en vez de por el `catch`.
**Qué lo contiene:** el resultado para el usuario **no cambia** —la transacción aborta,
`onabort` resuelve `false`, `encolar` devuelve `rechazado` y la vista avisa—; lo único que
se añade es una excepción suelta en la consola.
**Arreglo:** envolver el cuerpo del `onsuccess` en su propio `try/catch`.


## 59 — Lo que el ciclo de la guarda de ruta dejó abierto (2026-09-18)

### 59.1 Una copia local sobrevive a dejar de ser miembro
`lib/local.ts:303` — nada borra la instantánea `<usuario>:<grupo>` cuando ese usuario deja de
ser miembro `active`: `olvidarTodo` sólo corre al cambiar de usuario y al salir. Hallazgo
adyacente, **preexistente**, reportado y no entrado en el ciclo.
**Qué cambió, y por eso se anota ahora:** la entrada nueva hace esa copia alcanzable **con el
servidor vivo**, no sólo bajo un corte total. Si §A.1 alcanza o no a una copia local de lo
que la persona vio legítimamente no está escrito en ningún sitio; la alcanzabilidad sí
cambió.

### 59.2 El ítem 2 de la Spec C no tiene guarda automática
El requisito es que **el servidor**, al no poder comprobar la sesión, mande a la cáscara. El
arnés de navegador no puede cortar lo que el servidor de Next le pide a Supabase, y hacerlo
exigiría parar un contenedor desde la suite. Guardado en su capa por unidad y cruzado a mano
en la pasada con el gesto; **lo que falta es la red que se pone roja sola dentro de un año.**

### 59.3 La API colgada no está cubierta, y el destino depende de la edad del token
Medido: token vigente → cáscara a los 10.004 ms; token caducado → login a los 12.005 ms, con
la misma API colgada. Está declarado en la Spec C §8b antes de cerrarla, y es el hueco que la
**Spec D** (en el roadmap) existe para cerrar. No es deuda de ejecución: es un requisito que
falta.

## 60 — El docstring de `useSinRed` describe un sondeo que Next no hace (2026-09-18)

El docstring de `useSinRed` dice que `useOffline()` «sondea el origen de la app y **cuenta como en
línea** cualquier petición que siga pendiente a los 200 ms: eso es lo que le permite cazar un
portal cautivo». Leído en el código de Next
(`node_modules/next/dist/esm/client/components/offline.js`), es falso en la parte que importa:
`useOffline()` es un contexto que sólo cambia por `dispatchOfflineChange`, y a `notifyOffline()`
se entra por **dos** puertas — el evento `offline` del sistema, que es la misma señal que
`navigator.onLine`, y `checkOfflineError(err)`, que sólo llaman los fetch del router de Next.
El sondeo de 200 ms existe, pero **sólo corre cuando ya se está en estado offline**, para salir
de él; nunca entra.

**Consecuencia:** las «dos señales independientes» del hook son **una sola** mientras nadie
navegue, y el portal cautivo no lo caza nadie hasta que el router pide algo.

**Por qué es deuda y no requisito:** medido el 2026-09-18, con la API caída y `sinRed` en
`false` todo el rato, la app **encoló, pintó la ficha y avisó igual** — la clasificación por
`refinarSinRed` acierta sin necesidad de `sinRed`. No hay comportamiento roto que cerrar: hay
un comentario que dice de un mecanismo ajeno lo que ese mecanismo no hace, y que es
exactamente lo que induciría a apoyarse en él la próxima vez. Declarado fuera de alcance en la
Spec B §3.

## 61 — «si la sonda ni sale…» de `unit/shell.test.tsx` pasa 3 de 5 veces, y es de la Spec C (2026-09-18)

**Medido.** `npx vitest run unit/shell.test.tsx` cinco veces seguidas: **2 rojas**, siempre el
mismo caso —«si la sonda ni sale, el texto deja de culpar al servicio»— y siempre agotando su
`waitFor` de 4 s (4012 ms, 4015 ms). El mismo caso **solo**, con `-t`, pasa **6 de 6**: lo que
falla es la interferencia con los otros 54 casos del fichero, no el caso.

**No lo introdujo el ciclo de la Spec B.** `unit/shell.test.tsx` y `app/sin-conexion/page.tsx`
están byte a byte como en `HEAD`; lo único que cambió en su cadena de importación es una
constante exportada nueva en `lib/errors.ts`, que esa pantalla no usa. El fallo existe desde
el ciclo de la guarda de ruta y su corrida de cierre lo pasó por suerte.

**CERRADA el 2026-09-18, y mi diagnóstico era el equivocado.** Escribí que apuntaba a
`document.visibilityState`. Medido por la revisión sobre una copia limpia de `HEAD`: la causa
es la **siembra de `sessionStorage`**. El caso «DoD 10: tras una recarga que vuelve a caer, la
cadencia sigue donde estaba» siembra `sin-red:intento` con `{n: 4}`, y vive en el único bloque
cuyo `beforeEach` hacía `sessionStorage.clear()`; los bloques posteriores la heredaban. Con
`n = 4`, `esperaDeSondeo(4)` son 30 s, así que la primera sonda de ese caso salía fuera
de su `waitFor` de 4 s. Y sólo mientras durase `VIGENCIA_INTENTO`, que es por qué dependía de
lo rápido que corriera el fichero: **5 rojas de 8** sin el arreglo, **8 verdes de 8** con
`sessionStorage.clear()` en el `beforeEach` de fichero. Arreglado ahí.

**Lo que la decisión de anotar y parar acertó y en qué falló.** Acertó en no arrastrar un
fichero ajeno a la iteración. Falló en el motivo escrito: dije «perseguirlo es ensanchar el
alcance» apoyándome en un diagnóstico que no había medido, y el arreglo real era **una línea**.
Un motivo para no hacer algo también es una afirmación, y también hay que medirla.

**La forma canónica, que es lo que vale para la próxima.** Un test que pasa la mitad de las
veces es el espejo de lo que §E.4(c) prohíbe: allí se exige ver un rojo **siempre** antes de
creerse una guarda; aquí un verde intermitente se contó como guarda durante un ciclo entero.
Las dos mitades son la misma regla — **una corrida no es una medida** — y ninguna de las dos
la vigila nada automático hoy.


## 62 — ~~La cáscara sin red no conoce la regla de caducidad~~ — **SALDADA** (2026-09-19)

**La cerró la Spec E.** La cáscara ya no puede ver una caducada: `leerCola` filtra en cada
lectura, así que esa pantalla recibe la regla **sin pedirla**, que era el problema de fondo —
no que le faltara una llamada, sino que aplicarla fuera responsabilidad suya. Guardado en
`unit/shell.test.tsx` › «DoD 9: no pinta como pendiente una entrada caducada, y sí la viva» y
«DoD 10: y deja volver a apuntar el producto cuya entrada caducó», con su sonda. Y comprobado
a mano en las dos pantallas: `.claude/fathom/spec-e/gesto-2026-09-19.md`.

**Lo que NO se cerró y sigue siendo cierto de aquella entrada:** la cáscara **no barre**, así
que una caducada se queda en disco mientras esa sea la única pantalla que se abra. Es el borde
B6 de la Spec E y está declarado en su §7: recibe la seguridad, no la cortesía de anunciar.

*(Texto original, para el que quiera la medida de entonces:)*



`app/sin-conexion/page.tsx` lee la cola **cruda** y se la da a `decidirEncolar`: no importa
`reparte`, ni `VIDA_COLA_MS`, ni `caducados` — verificado en su lista de importaciones, que es
el instrumento estructural de ese fichero, y con una sonda de la revisión. Consecuencias
medidas ahí:

- Apuntar un producto del que queda una entrada de 25 h se rechaza con «Ese producto ya está en
  la lista», y `encolar` no llega a llamarse. **Allí el callejón es permanente:** esa pantalla
  no descarta nunca, así que ninguna señal lo cura.
- Pinta la entrada caducada como ficha pendiente, prometiendo «Se enviará al volver la
  conexión» un envío que `siguienteEnCola` garantiza que no va a ocurrir.

**Por qué no entró en la Spec B.** Es otra pantalla, y arreglar la regla sitio a sitio es
exactamente lo que llevó tres iteraciones descubriendo el siguiente sitio. La forma canónica:
**la regla de caducidad no tiene dueño**. Está escrita en `lib/local.ts` como función pura y
aplicada a mano en cada lector — tres veces en la vista (unificadas en la iteración 4 de la
Spec B) y **cero** en la cáscara. Mientras la aplicación siga siendo responsabilidad de cada
lector, cada lector nuevo nace sin ella.

Eso es una spec —la regla con un solo dueño, sobre las dos pantallas—, y está en el roadmap.
Lo que se anota aquí es que **hoy**, en producción, la cáscara tiene ese callejón.


*(Las citas por número que quedan en las entradas 52–59 son de ciclos anteriores y algunas ya
están desfasadas. Se reportan y no se arrastran: la lección de citar por nombre la estrenó el
ciclo de la Spec B en su valla y en sus propias entradas.)*

## 63 — ~~Con el almacén rechazando escrituras, la caducada bloquea volver a apuntar~~ — **SALDADA** (2026-09-19)

**La cerró la Spec E por el otro extremo.** El mecanismo era `encolar`, que decidía el
duplicado contra la cola **cruda** y por eso seguía viendo una entrada que ninguna pantalla
enseñaba. Ahora decide contra lo vivo (R3), así que el producto entra aunque su caducada siga
en disco: `unit/duplicado.test.tsx` › «i1-3: sin barrer, nadie la ve y no bloquea volver a
apuntarla», con la sonda de que un duplicado **vivo** sí sigue bloqueando. Comprobado a mano en
la cáscara, que era donde el callejón era permanente.

*(Texto original:)*



**Medido en navegador real por la revisión de la iteración 5**, con el `delete` de la tienda
`cola` rechazando: la entrada caducada **se despinta igual** —`releerLaCola` y el efecto de
apertura pintan `vivos`, que la excluye se haya podido borrar o no, así que la resta que
`leerColaViva` hace queda pisada—, no hay aviso, la entrada sigue en disco, y al apuntar ese
producto sale **«Ese producto ya está en la lista.» frente a una lista vacía**.

La iteración 5 sí cerró la mitad que perseguía: el aviso dejó de mentir, no se anuncia un
descarte que no ocurrió, y esa guarda es real. Lo que no cerró es el callejón, y **el argumento
con que lo di por aceptable era falso**: escribí «con la ficha todavía en pantalla, "ya está en
la lista" deja de ser falso», y la ficha no se queda.

**Dos formas de cerrarlo, sin medir cuál cuesta menos:** que `vivos` deje fuera sólo lo
confirmado —y entonces la ficha, que promete un envío imposible, necesita otro texto—, o que el
mensaje del `'ya-estaba'` sobre una caducada no borrada sea `SIN_ALMACEN` en vez de
`DUPLICADO`, que es lo que de verdad está pasando.

## 64 — El drenado ignora el mismo booleano, y ahí la consecuencia es peor (2026-09-18)

`drenarUnaVez` hace `await quitarDeCola(p.id)` tras un envío aceptado y **descarta el
resultado**, igual que hacía `leerColaViva` antes de la iteración 5. Si el almacén rechaza ese
borrado, la fila sobrevive en disco y una pasada posterior **la reenvía**. Y como
`items_nombre_unico` es **parcial** —`WHERE deleted_at IS NULL`, comprobado en el catálogo—, un
reenvío después de que alguien tache el producto **crea fila nueva**: resurrección visible para
todo el grupo.

Es exactamente la forma que la iteración 2 de la Spec B documentó como defecto al retirar un
arreglo equivocado, alcanzable por otra puerta que nadie miró. No entró porque el techo del
ciclo ya se había alcanzado.

## 65 — La pasada de mutación no es reproducible, y eso la vuelve del revés (2026-09-18)

Tres corridas del mismo `pasada.sh` sobre una copia fiel dieron **20/1, 20/1 y 19/2**. El
mutante en disputa es la NEUTRA de renombrado, que aplicada a solas **sobrevive 6 de 6** y con
la suite sin mutar da verde 14 de 14. O sea que en una de las tres corridas un rojo que el
mutante no causó se apuntó como «cazada».

**Y ése es el sentido que importa:** el error hace *parecer presente* una guarda que está
ausente. Con 21 mutantes, las 19 «cazadas» descansan hoy en una muestra de una. El arreglo es
el mismo que §E.4(c) exige para los rojos —repetir hasta que el veredicto sea estable— más
registrar **qué test** caza a cada mutante, que es lo que convierte «cazada» en comprobable.

## 66 — Nada vigila las citas `fichero:línea` (2026-09-18)

Dos vueltas seguidas fallaron su propia fila de citas, y el desplazamiento **lo causaba el
mismo ciclo que las escribía**: `lib/errors.ts` cita `unit/drenado.test.tsx:798` y este ciclo
metió 13 líneas más arriba en ese fichero, así que el caso está en `:811` y `:798` cae dentro de
otro. `.claude/fathom/spec-b/dod.md` conserva 29 citas por número, y al menos cuatro resuelven a
una línea en blanco o al test equivocado.

La valla de la spec se pasó a **citar por nombre** y eso no se desplaza. Lo que falta es la
guarda: una prueba que extraiga `ruta:NNN` del árbol y falle si la línea está vacía o si el
nombre citado no aparece cerca —con su sonda, que debe ser cazada—, o directamente que prohíba
la cita por número en los comentarios. Sin ella, la lección se va con la spec que se borra.

## 64 bis — El arreglo de la 64 se volvió más difícil, y eso lo hizo la Spec E (2026-09-19)

La deuda 64 dice que `drenarUnaVez` descarta el booleano de `quitarDeCola` tras un envío
aceptado, y que por el índice parcial un reenvío después de que alguien tache el producto crea
fila nueva. Sigue igual de abierta. **Lo que cambió es el material con el que habrá que
arreglarla.**

`quitarDeCola` devolvía «la escritura entró». Ahora devuelve «**había** fila que borrar», que es
lo que cerró el borde B7 —dos barridos solapados contando las mismas filas— y está medido en
unidad y en navegador. Para `barrerCaducados` la fusión es correcta: sólo necesita saber si la
retiró él. Pero **fusiona dos hechos que la 64 necesita separados**: hoy `false` significa «el
almacén rechazó» **o** «no había fila», y un drenado que honrara ese booleano trataría «otra
pestaña ya la drenó» —que es normal y no es un fallo— como «el disco la rechazó».

Es el único cambio de este ciclo que deja una deuda declarada fuera de alcance **más difícil
que antes**, y por eso se escribe aquí en vez de descubrirse al abrirla. Quien la arregle
necesita los dos hechos por separado: o un valor de tres estados, o que el drenado pregunte por
su cuenta. No se hizo aquí porque fusionar la regla de caducidad con la del comprobante del
borrado es exactamente lo que costó cinco vueltas en la Spec B.

## 67 — Los escapes que la guarda de la Spec E no cierra, medidos (2026-09-19)

La guarda estructural de `unit/almacen.test.ts` demuestra que ninguna fila de la cola se usa
sin la regla **en las quince formas medidas**, y el límite de R2 dice que eso es la prueba
suficiente porque el **perímetro** —un solo fichero del producto abre IndexedDB— la hace
alcanzar a todo. Lo que la última revisión midió y **no** se cerró, con su forma exacta, para
que nadie lo vuelva a descubrir:

- **Un envoltorio con nombre alrededor de la puerta.** El reconocimiento sólo acepta una
  llamada directa a `conTienda`/`escribir`. Verificado de punta a punta: con un
  `leerTiendaCola` privado y un `export leerColaCruda` que entrega caducadas, la guarda
  devuelve `[]` y la verja entera queda verde. Lo único que se pone rojo es el inventario de
  puertas, que invita en su mensaje a actualizarse.
- **`EXENTAS` se indexa por nombre y se consulta con `in`.** Tres huecos: una función *local*
  llamada `quitarDeCola` hereda la exención; `in` ve `Object.prototype`, así que un método
  `toString` queda exento; y nada comprueba que la exenta siga cumpliendo su motivo —un
  `quitarDeCola` sembrado que devolviera la fila seguiría exento—.
- **La resolución de identificadores no tiene ámbito**: barre el fichero y se queda con la
  última declaración del nombre. Seis escapes medidos —receptor asignado después, receptor en
  propiedad de objeto, nombre de tienda tras una llamada, `for…of` sobre tiendas, plantilla con
  sustitución, callback como propiedad—.
- **Cuatro falsos positivos nuevos** de la misma clase que los tres que sí se arreglaron: una
  local o un parámetro llamados `deEsteUsuario` marcan a su anfitrión; un contador con
  `openCursor`; un `existeEnCola()` legítimo con la forma de la exenta y otro nombre.

**Y dos más, que la revisión del cierre encontró atacando el modelo en vez de las formas.**
Son de la misma clase y no estaban aquí:

- **La propagación va por el grafo de llamadas, y una caché no es una llamada.** Un
  `refrescar()` que aplica la regla correctamente pero deja las filas crudas en un `let` de
  módulo, y un `pendientes()` exportado que las devuelve: la guarda da `[]` y `pendientes` no
  aparece ni en el inventario. Compila con `--strict`. Importa más que las otras porque una
  caché es la razón número uno por la que nace un lector nuevo, que es el defecto que R2
  existe para impedir.
- **`export default { async leerColaCruda(){…} }`**: entrega crudo y sale del módulo, y
  `verExportaciones` no lo ve porque no conoce `ts.isExportAssignment`.

El patrón común de los dos, que es la forma útil de anotarlos: el modelo sigue las filas por
donde **vuelven** (`return`) y no por donde se **quedan** (una variable de módulo) ni por donde
el módulo **sale** (`export default`).

**Y lo que quedó suelto alrededor del perímetro**, ya con su arreglo puesto donde sí se hizo
(vuelta 4 del 2026-09-19): `TOCA` en `pasada.sh` es un **tercer inventario a mano** —tras
`PUERTAS` y las raíces del perímetro—, así que un mutante futuro que toque un cuarto fichero
deja la precondición de entrada ciega justo donde se cerró el agujero; y dos frases de las
deudas 62 y 63 de este mismo fichero describen en presente `leerColaViva`, borrada, a 15 y 45
líneas de su marcador de «texto original».

**Por qué se anota y no se arregla.** Los seis sólo se pueden enseñar **añadiendo código que
no existe**, y la regla del ciclo dice que una regresión hipotética no gana por sí sola otra
vuelta. Además llevaban tres rondas seguidas de instrumento, que es donde el ciclo manda parar.
Quien los cierre debería hacerlo junto con el arreglo de la clase —resolución con ámbito,
clave por nodo, y propagación que siga también las asignaciones a binding de módulo—, no uno a
uno: cada arreglo por instancia ha destapado el siguiente.

## 68 — La ronda de navegador de la pasada corre una sola vez (2026-09-19)

Las mutaciones de unidad corren tres veces y sólo fijan veredicto por acuerdo —es la deuda 65
aplicada—, y la ronda de navegador de `pasada.sh` corre **una**, sin baseline verde de esa
fila. El resultado aguanta —la revisión la corrió tres veces y salió roja 3/3— pero hoy
descansa en una muestra de una, que es exactamente lo que la cabecera del propio script dice
que no vale.

## 69 — Una pasada muerta a media faena sólo se detecta en la corrida siguiente (2026-09-19)

Medido en la revisión del cierre, con las dos muertes hechas de verdad:

| | `SIGTERM` | `SIGKILL` |
|---|---|---|
| Corre la trampa | sí, tras 4–12 s (espera a que el hijo suelte el control) | no, por diseño |
| Árbol | restaurado | **mutado**, con su `.bak` |
| En el log | `TRAMPA: …` como última línea | nada: el log se corta |
| Código de salida | 143 | 137 |

La pieza que salva el escenario es la **precondición de entrada**, y funciona: se le sembraron
tres respaldos —uno distinto del fichero, uno idéntico, y uno de un fichero que la pasada no
toca— y abortó con exit 1 en los dos primeros y siguió en el tercero, que es lo correcto.

**Lo que sigue abierto:** eso detecta el destrozo **la próxima vez que alguien pase**, no
cuando ocurre. Con `SIGKILL` lo único que aparece en el árbol es una línea nueva de
`git status` (`?? lib/local.ts.bak`), porque los ficheros mutados ya figuraban como ` M` — la
rama lleva la obra sin commitear—. Y se reprodujo el silencio completo con el mutante que la
mató de verdad, la **NEUTRA**: `typecheck` 0, `lint` 0, la suite de la pasada 0, `pnpm test`
0 y `pnpm build` 0, **las cinco puertas verdes con el árbol mutado**. Cerrarlo de verdad pide
un canal que no dependa de que el proceso siga vivo —un fichero centinela escrito antes de
mutar y borrado al restaurar, que la verja o el arranque de la siguiente orden miren— y eso ya
no es una línea: es una pieza, y se decide aparte.

**Y el mismo centinela resuelve un segundo problema medido, que conviene atender de una vez.**
El 2026-09-19 quedó un vigilante de la pasada corriendo **5 h 46 min** —`until grep -q "^DONE"
pasada.log; do sleep 45; done`— esperando una línea que el script **no imprime**: acaba en
`== N mutaciones ==` y `PASADA: OK`, nunca en `DONE`. Era inofensivo (sólo leía) pero no podía
terminar jamás. Es la misma carencia por el otro lado: **la pasada no publica su final en
ninguna forma estable**, así que ni quien la espera sabe que acabó ni quien llega después sabe
que murió. Un centinela con dos estados —«mutando» y ausente— sirve para las dos cosas, y
entonces el vigilante espera *su desaparición* en vez de una cadena que alguien tuvo que
adivinar.
