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
  dos veces durante el ciclo y produjo un diagnóstico falso. Los tests que
  dependen de él mandan un cambio centinela y esperan a verlo antes de medir; no
  amplíes márgenes a ciegas, que ya se probó y no funciona.
