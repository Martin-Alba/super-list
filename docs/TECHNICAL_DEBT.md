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

### 6. `leaveGroupAction` lanza en vez de devolver `{error}`
`app/actions.ts` — es la única de las cuatro acciones de mutación cuyo fallo sale
por un límite de error en lugar de por el aviso de la vista. Quedó fuera del
criterio que unificó a las demás.

### 7. `text.includes('abort')` casa de más
`lib/errors.ts` — atrapa `current transaction is aborted` de Postgres y lo
anuncia como "No hay conexión". Mensaje equivocado en un camino raro.

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
`lib/items.ts:62` marca `deleted_at`, y ese camino viaja como UPDATE, lleva
`group_id`, casa con el filtro y va autorizado por RLS —
`app/g/[id]/GroupView.tsx:60` ya lo documenta. Verificado en el navegador: la
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

### 20. El fallo cerrado marcará código correcto que aún no existe — MORDERÁ PRIMERO
`unit/borradoFisico.ts` — La guarda marca todo `.delete()` cuyo receptor no pueda
demostrar inofensivo. Se eximieron los accesores de plataforma medidos
(`searchParams`, `cookies`, `headers`, `formData`, almacenamiento) y los `Set`/`Map`
tipados por parámetro. **Lo que no está exento y aparecerá:** un `Set` importado
de otro módulo, un `Map` en propiedad de clase, `useRef(new Set()).current.delete()`,
y cualquier accesor nuevo de Next.
**Qué hacer cuando pase:** añadir el accesor a `ACCESORES_SEGUROS` con una muestra
en `unit/muestras/borrados.ts`, no desactivar la guarda. Es el primer sitio donde
la spec de funcionalidad chocará, porque toca cookies y `searchParams`.

### 21. Formas de borrado que aún escapan a la guarda
- Acceso por corchetes con constante: `const m='delete'; admin.from('items')[m]()`
  y `const k='deleteUser'; admin.auth.admin[k](id)` — falta pasar el contexto de
  plegado en `propiedad()` (un argumento).
- `const { delete: borrar } = admin.from('items'); await borrar()`, y
  `.delete.call/.apply(...)`.
- SQL dinámico: `execute format('delete from %I', …)` y `execute '…'` dentro de
  plpgsql, que es *la* forma de borrar desde una función.
- `with d as (delete from … returning *) select …`, porque `with` se descarta
  como verbo inofensivo.
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

### 24. Dos tautologías supervivientes
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
