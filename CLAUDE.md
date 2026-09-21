# CLAUDE.md — Super

Lista de compras compartida en tiempo real para grupos (ej. "Familia Alba"): varios miembros editan la misma lista desde el móvil mientras hacen las compras. Next.js 16 + React 19 + TypeScript en Vercel, datos y auth en Supabase (Postgres + Realtime + Storage). Deploy: Vercel Hobby.

## Cycle configuration

- **Authoritative environment:** el proyecto Supabase de la app. Desarrollo: instancia local (`supabase start`). Preview/producción: el proyecto hosted. El esquema se lee **de la base**, nunca de un archivo TypeScript, un tipo generado ni una migración: la migración dice qué se pretendió, la base dice qué hay.
- **Spec path:** `docs/spec.md`
- **Draft source:** entrevista directa con el usuario (no hay etapa previa que genere borradores).
- **Structural instruments:**
  - *forma de datos* → `psql "$DATABASE_URL" -c '\d+ public.<tabla>'` contra la base real.
  - *reglas de acceso* → `psql "$DATABASE_URL" -c "select schemaname,tablename,policyname,cmd,qual from pg_policies where schemaname='public'"`. Una policy que no aparece acá no existe, aunque esté en una migración.
  - *realtime* → `psql "$DATABASE_URL" -c "select * from pg_publication_tables where pubname='supabase_realtime'"`. Una tabla ausente no emite eventos y la app falla en silencio.
  - *unidades invocables* → la definición (`rg -n 'export (async )?function <nombre>'`), nunca el nombre en el sitio de llamada.
  - *superficie de rutas* → el árbol real del App Router: `find app -name 'route.ts' -o -name 'page.tsx'`.
  - *superficie cliente* → `pnpm build`.
- **Constitution sections:** A, B, C, D, E de este archivo.
- **Test host:** Martins-MacBook-Pro (máquina de desarrollo local; Docker + navegadores reales, no hay sandbox que los corra)
- **Gate commands:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- **Runtime check:** `pnpm test:e2e` (Playwright; incluye el test de dos contextos de navegador simultáneos) y `pnpm dev` con verificación manual en viewport móvil de 390px.
  - **El estado del entorno se registra antes de empezar, no se supone.** Qué contenedores están arriba: `docker ps --format '{{.Names}} {{.Status}}' | grep super`. Una medida tomada con el stack a medias no mide el producto, y no se distingue de una que sí — *medido (2026-09-21):* `supabase_edge_runtime_super` llevaba cinco días caído y nadie lo había notado, porque este proyecto no usa Edge Functions; `imgproxy` y `pooler` también estaban parados y tampoco los toca nadie. Saberlo es la diferencia entre «no afecta» y «no miré».
  - **Una caída deliberada se declara: qué contenedor se paró, y la comprobación de que el resto seguía vivo.** «La API caída» no es un estado, son varios: parar `supabase_auth_super` con los otros diez arriba no es lo mismo que un `supabase stop`, y las conclusiones no se trasladan. La sonda que lo haga repara **al entrar** además de al salir — un `docker pause` heredado envenena toda la tanda siguiente sin que nada lo nombre.
  - **Y el camino feliz se recorre en el navegador cuando varias vueltas seguidas han probado el degradado.** Entrar, crear grupo, apuntar, ver la lista. Una suite verde sobre el caso roto no dice nada del normal, y la deriva no avisa.
- **Hard fails:** datos de un grupo visibles para quien no es miembro `active` (incluye `pending`, `rejected` y `removed`) · acceso concedido por poseer un link, sin aprobación del owner · `DELETE` físico sobre una tabla publicada en `supabase_realtime` · claves o cualquier `.env*` dentro del control de versiones · una función `SECURITY DEFINER` sin `search_path` fijado
- **Code languages:** TypeScript / TSX, SQL (migraciones y políticas RLS).
- **Checkpoint file:** `docs/CHECKPOINT.md`
- **Roadmap file:** `docs/ROADMAP.md`
- **Tech debt file:** `docs/TECHNICAL_DEBT.md`

## Commands

- Install: `pnpm install` (pnpm 10, Node 24 LTS)
- Dev: `pnpm dev` · Build: `pnpm build`
- **Gate before commit:** `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
- DB: `supabase start` · `supabase migration new <nombre>` · `supabase db reset`
- Tests: `pnpm test` (Vitest) · `pnpm test:e2e` (Playwright)

## Working agreement

- **Pensar antes de codear.** Declarar supuestos; si hay dudas, preguntar. Si hay varias interpretaciones, exponerlas — no elegir en silencio.
- **No asumir, verificar.** Comprobar el código y la base con los instrumentos de arriba. Los nombres y los docs no son evidencia.
- **Honestidad.** Si algo está mal o hay un camino más simple, decirlo. No aceptar por defecto.
- **Simplicidad primero.** El mínimo código que resuelve el problema. Sin features especulativas ni abstracciones de un solo uso.
- **Cambios quirúrgicos.** Tocar sólo lo que el pedido exige; no reformatear código adyacente.
- **Probar antes de commitear** (terminal y, para UI, navegador).

---

## A. Reglas de dominio — NUNCA violar

1. **Un grupo es un límite de datos.** Ningún usuario lee ni escribe ítems, miembros o metadatos de un grupo donde no sea miembro `active`. `pending`, rechazado y expulsado cuentan como no-miembros. Se hace cumplir en la base con RLS, no en el cliente ni en el componente.
2. **La aprobación es la única puerta.** Poseer un link de invitación válido nunca otorga acceso: sólo permite *solicitarlo*. El acceso lo concede el owner, explícitamente.
3. **Fallar cerrado.** Ante error, ambigüedad o sesión ausente en cualquier chequeo de acceso, se deniega. Nunca se degrada a "mostrar igual".

## B. Arquitectura — decisiones congeladas

1. **La pertenencia se resuelve en `public.is_active_member(uuid)`**, función `SECURITY DEFINER` con `set search_path = ''` y todos los nombres cualificados por esquema. Ninguna política RLS consulta `group_members` directamente en su propio `USING`: eso produce `42P17 infinite recursion detected in policy` y deja la app inservible. Una `SECURITY DEFINER` sin `search_path` fijado es escalada de privilegios.
2. **Toda tabla que la UI observa en vivo debe estar en la publicación `supabase_realtime`.** Sin eso no hay eventos y el fallo es silencioso: la app parece funcionar hasta que dos personas la usan a la vez.
3. **Realtime usa Postgres Changes, que autoriza cada evento contra cada suscriptor — pero sólo los INSERT y los UPDATE.** Los DELETE están exentos: *"RLS policies are not applied to `DELETE` statements, because there is no way for Postgres to verify that a user has access to a deleted record"*. De ahí una decisión congelada: **ninguna tabla publicada se borra físicamente.** Toda desaparición es un cambio de estado — `deleted_at`, `status` — que viaja como UPDATE y sí va autorizado. El arreglo aparente está descartado: poner `replica identity full` para poder filtrar los DELETE deja el filtro en manos del cliente y hace que el payload lleve la fila entera, que es peor que el problema. Postgres Changes es correcto hasta ~3.000 suscriptores concurrentes sobre el mismo cambio; por encima, migrar a Broadcast.
4. **Verificar el esquema contra la base real antes de escribir consultas.** No confiar en tipos generados, docs ni nombres.
5. **El cliente envía intención, nunca autoridad.** El `group_id`, el rol y el estado de membresía se derivan siempre en el servidor a partir de la sesión; jamás se confía en un id o un rol que venga del cliente.

## C. Proceso

- **Branches:** `main` estable. Ramas por tarea. Los commits y los push los hace el usuario, no el agente.
- **Sin `--no-verify`.** Los hooks son ley.
- **Runtime pinneado:** Node 24 LTS. El Node local (v25.x) no coincide con el de Vercel; fijarlo en `.nvmrc` y en `engines` para que build local y deploy no diverjan.
- **Migraciones:** forward-only, idempotentes, commiteadas en la misma sesión en que se aplican.

## D. Ingeniería de producción — prioridad máxima

1. **Enfocado a producción.** Todo camino commiteado es uno que correría contra usuarios reales. Sin mocks, datos de relleno ni valores placeholder en caminos ejecutados. Lo incompleto va detrás de un flag.
2. **Sin condiciones de carrera.** Toda lectura-modificación-escritura es concurrente. Nada de check-then-act cruzando un `await`. Los invariantes se hacen cumplir en la base — `UPDATE ... WHERE`, `INSERT ... ON CONFLICT`, constraints únicas — no en memoria del proceso.
3. **Sin fugas entre grupos; asumir ≥2 instancias.** Toda consulta va acotada por grupo y verificada en el servidor. Ningún estado mutable de proceso ligado a un usuario, ninguna caché global compartida.
4. **Efectos idempotentes.** Aceptar una invitación, aprobar un miembro o expulsar tolera entregas duplicadas sin doble aplicación — clave estable o constraint única.
5. **Migraciones expand/contract**, compatibles hacia atrás y verificadas contra el esquema real.
6. **Timeouts y reintentos acotados.** Toda llamada de red tiene timeout explícito. Un fallo aguas arriba degrada con elegancia; no cuelga al usuario ni rompe la request.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## E. Pruebas — qué cuenta como prueba

<!-- Estas dos reglas salieron de cuatro rondas de revisión en las que el mismo
     defecto reapareció con formas distintas: una garantía implementada y
     probada una capa por debajo de la superficie que el requisito nombraba.
     Cerrar instancias una a una garantizaba otra ronda idéntica. -->

1. **Toda prueba ataca la capa que su requisito nombra.** Si el requisito dice
   "la vista lo dice", la prueba monta la vista. Si dice "el servidor lo
   impide", la prueba llama al servidor sin pasar por la interfaz. Si dice "la
   base lo rechaza", la prueba ataca la base con el token del usuario. Una
   prueba en una capa inferior es evidencia de apoyo, **nunca** la prueba
   principal: pasa mientras la superficie prometida sigue rota.
2. **Toda guarda viaja con una sonda que debe ser cazada.** Un test que sólo
   comprueba casos limpios no distingue "detecta" de "no detecta nada": una
   base sin políticas no viola la regla, pero tampoco la cumple. Cada guarda
   —regex sobre políticas, barrido de ficheros, matriz de privilegios— incluye
   un caso construido para violarla, y el test falla si no lo caza.
3. **Un test que no puede fallar es peor que ninguno**, porque ocupa el sitio
   del que sí probaría. Al escribir un test, decir en una línea qué cambio del
   producto lo pondría rojo; si no hay ninguno, el test sobra o está mal.
4. **Un arreglo que cambia el mecanismo se prueba TAMBIÉN por la puerta que
   abre.** El test de la puerta que se cierra **se conserva**: es el que se pone
   rojo cuando alguien revierte. Pero el mecanismo nuevo habilita caminos que el
   viejo no tenía, y ésos no los mira nadie. Antes de dar por bueno el cambio:
   **(a)** nombrar por escrito el camino nuevo; **(b)** probarlo en la capa donde
   ese camino existe (§E.1) — si el requisito dice "dos pestañas", dos corrutinas
   no valen; **(c)** demostrar que ese test se pone rojo sin la guarda,
   **repitiéndolo hasta ver que falla siempre y no la mitad de las veces**.

   <!-- Cinco iteraciones seguidas la incumplieron, cada una arreglando lo que
        abrió la anterior: un redirect que quitó la normalización de URL (500 y
        código de sesión quemado); una codificación por carácter que partió pares
        suplentes (el mismo 500); un lector de cookies propio que se atragantaba
        con un `%` de una cookie ajena. Y la iteración que escribió esta regla la
        incumplió al escribirla: su test cazaba el defecto 2 de cada 4 veces,
        porque dependía de que el slot de replicación entregara un evento que no
        siempre entrega. De ahí el "hasta ver que falla siempre". -->
