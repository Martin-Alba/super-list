# Deudas 63 y 64 — **SIN SELLAR**, para revisión

Escrito el 2026-09-19. No lleva marcador `ACTIVE`: nada de esto entra al bucle hasta que lo
revises, porque dos de las decisiones no son investigables, son tuyas.

---

## 0. Lo que la medida dijo antes de escribir una línea

El encargo pedía medir si son una spec o dos, avisando de que la Spec E acaba de cambiar quién
lee la cola. Lo era: **una de las dos ya no existe como está anotada, y hay un tercer sitio que
no estaba en ninguna de las dos.**

### 0.1 La deuda 63 está cerrada. La anotación que tienes es de antes de la Spec E

El callejón de la 63 era: con el `delete` de la tienda rechazando, la caducada seguía en disco,
`encolar` la veía y contestaba «Ese producto ya está en la lista» contra una lista vacía.
Medido hoy en la definición (`lib/local.ts:245`), `encolar` decide así:

```ts
const hay = reparte((q.result ?? []) as Pendiente[], Date.now()).vivos.some(x =>
  x.usuario === p.usuario && x.grupo === p.grupo && mismoProducto(x.nombre, p.nombre))
```

Contra **lo vivo**, y filtrando por usuario **y grupo** y producto. Una caducada no es vivo, así
que no bloquea: `unit/duplicado.test.tsx` › «i1-3: sin barrer, nadie la ve y no bloquea volver a
apuntarla», con su sonda «i1-3: y una viva del mismo producto lo sigue bloqueando».

Y de paso cayó una sospecha que tenía yo, no la deuda: que el duplicado se decidiera sólo por
usuario y un pendiente de **otro grupo** bloqueara el alta. **No ocurre** — el filtro lleva
`x.grupo === p.grupo`, y lo sostiene `unit/duplicado.test.tsx` › «el mismo nombre en otro grupo
sí entra».

**Lo que sí queda de la 63, y es consecuencia de la 64, no mecanismo propio:** si el almacén
rechaza la baja tras un envío aceptado, la fila sobrevive **viva** en disco mientras la pantalla
ya la soltó (`setPendientes(prev => prev.filter(...))`, `GroupView.tsx:556`). En esa ventana, un
alta sin red del mismo producto vuelve a dar «ya está en la lista» sin ficha en pantalla. Es
estrecho y se cierra solo en la siguiente relectura —`barrerCaducados` la devuelve como viva y la
repinta—, así que va como **borde con decisión escrita**, no como requisito.

### 0.2 La deuda 64 está viva, y su premisa verificada contra la base real

`drenarUnaVez` hace `await quitarDeCola(p.id)` y descarta el booleano
(`app/g/[id]/GroupView.tsx:554`). Y el índice, leído del catálogo de la base, no de una
migración:

```
items_nombre_unico UNIQUE, btree (group_id, translate(lower(btrim(name)), …)) WHERE deleted_at IS NULL
items_pkey         PRIMARY KEY, btree (id)
```

**Parcial el de nombre.** Eso es lo que decide la forma del arreglo, y no estaba medido en la
deuda. *(La primera redacción de esta línea apuntaba a la clave primaria como mecanismo; al
construir se midió que el cliente **no puede escribirla** —privilegio por columna, `42501`— y la
clave acabó en su propia columna, `origen_id`, con `items_origen_unico` no parcial. Corregido en la
iteración 2, que encontró esta afirmación viva.)*

### 0.3 Hay un tercer consumidor del mismo booleano, y no está en ninguna de las dos deudas

| Quién | Qué hace con el booleano | Consecuencia si el almacén rechaza |
|---|---|---|
| `barrerCaducados` (`lib/local.ts:323`) | **lo honra** | ninguna: no cuenta lo que no se fue |
| `drenarUnaVez` (`GroupView.tsx:554`) | lo descarta | **resurrección**: reenvío → fila nueva |
| `olvidarTodo` (`lib/local.ts:406`) | lo descarta, y devuelve `Promise<void>` | **la cola del usuario anterior sobrevive a su salida, en silencio** |

`olvidarTodo` lo llaman `app/BotonSalir.tsx:26` y `app/RecordarUsuario.tsx:46` —el segundo
cuando **llega otro usuario al mismo dispositivo**—. Descarta también el booleano de las
escrituras que borran las claves de `LISTAS`. Es el mecanismo que el proyecto construyó
justamente para no dejar nada detrás, y hoy no puede saber si lo consiguió.

### 0.4 Y un mecanismo más fuerte que el anotado

La deuda dice «honrar el booleano». Medido, hay algo mejor: **`Pendiente.id` ya es un
`crypto.randomUUID()`** (`GroupView.tsx:389` y `app/sin-conexion/page.tsx:376`), y `addItem`
(`lib/items.ts:67`) **no manda `id`**: deja el `gen_random_uuid()` del servidor. Si el envío
lleva el id de la fila de la cola, un reenvío choca contra un índice único **no parcial** —al
construir resultó ser `items_origen_unico` sobre `(group_id, origen_id)`, no `items_pkey`, porque
el cliente no puede escribir la primaria— y por tanto sigue chocando **después de que alguien tache
el producto** — que es exactamente el
caso que el índice de nombre no puede cazar. Y el drenado ya trata ese código como hecho:
`if (r.clase && r.code !== '23505') return`.

O sea: la resurrección se puede cerrar **sin depender del booleano de un almacén que está
fallando**, que es lo que hace frágil al arreglo anotado.

La política `items_insert` lo permite: su `CHECK` es
`is_active_member(group_id) AND created_by = auth.uid()` — leído de `pg_policies` —, y no dice
nada del `id`.

---

## 1. Una o dos: la regla de la Spec E aplicada

| Mecanismo | ¿Cuándo tiene que volver a ocurrir? | Remedio |
|---|---|---|
| **M1** · un reenvío no puede crear fila nueva | **una vez por cada envío**, siempre, incluso el primero | el envío lleva el id de la fila; un índice único no parcial rechaza el repetido (al construir: `items_origen_unico`, no la primaria) |
| **M2** · una baja que el almacén no confirmó no puede pasar por hecha | **una vez por cada intento de baja**, y cada consumidor necesita una respuesta distinta | el booleano se parte en tres estados y cada consumidor decide |

**Dos respuestas distintas, y ninguno necesita al otro.** M1 cierra la resurrección sin tocar la
firma de `quitarDeCola`; M2 cierra el silencio sin tocar el envío. Fusionarlos es lo que la
Spec B pagó cinco vueltas: un solo disparador serviría a uno y el otro se declararía bug la
vuelta siguiente.

Así que **dos specs**, F y G, y **F primero**: cierra la consecuencia que la propia deuda llama
«peor» sin tocar nada compartido.

---

# Spec F — El reenvío no puede crear fila nueva

## F.0 ¿Se alcanza sin sonda? Sí, y el camino dominante no es el que la deuda nombraba

Medido en el código, no razonado. `drenarUnaVez` hace `await addItem(...)` y **sólo después**
`await quitarDeCola(p.id)`. Entre las dos hay un viaje de red con cota de **10 s**
(`TIMEOUT_MS`, `lib/items.ts:36`). Tres caminos llegan al reenvío:

| Camino | Qué hace falta | Ancho de la ventana |
|---|---|---|
| **1 · el proceso muere entre el envío aceptado y la baja local** | nada que falle: que la pestaña se cierre, o que el sistema mate la app de fondo | **hasta 10 s en cada envío**, siempre |
| **2 · dos pestañas drenando la misma cola** | dos pestañas en el mismo dispositivo | hasta 10 s |
| **3 · el almacén rechaza la baja** | condición de dispositivo: cuota, desalojo, modo privado | indefinida: la fila se queda hasta que una baja entre |

**El 1 es el dominante y no es una carrera de milisegundos: es estructural.** Siempre hay un
hueco entre «el servidor ya tiene la fila» y «la cola local lo olvida», porque la baja va después
del `await`. Esto es una PWA que se usa **haciendo la compra**, con la app de fondo
constantemente; que el sistema la mate en ese hueco es la condición normal, no el caso raro. Y lo
que importa para el orden de F frente a G: **ningún booleano cierra el camino 1.** Un proceso
muerto no honra nada. Ésa es la razón de que el dueño tenga que estar en la base.

El 2 está abierto porque **no hay guarda entre pestañas**: `envio` y `drenando` son `useRef`
—por pestaña, por instancia del componente—, y dos pestañas comparten IndexedDB. Las dos leen la
cola, las dos eligen la misma fila con `siguienteEnCola`, las dos envían. Sin nada tachado en
medio el segundo envío choca por nombre (23505) y es inofensivo; con algo tachado en medio, es
fila nueva. El proyecto tiene una fila de navegador de dos pestañas para el **encolado**, ninguna
para el **drenado**.

El 3 es el único que la deuda contemplaba, y es el más estrecho de los tres en cuanto a
probabilidad, pero el más ancho en cuanto a ventana.

**Consecuencia para la urgencia:** F es más urgente de lo que la anotación sugería, no menos. Se
alcanza sin forzar nada, y G no puede arreglarlo.

## F.0bis Las tres formas de impedirlo, medidas

La anotación proponía una. Hay tres, y la diferencia entre ellas no es de gusto:

| | Coste real | Filas que ya existen | ¿Rompe algo que hoy funciona? |
|---|---|---|---|
| **(a) el id de la fila como clave de deduplicación en la base** | un parámetro **y una migración pequeña**, ver corrección de abajo | ninguna se toca | **No** |
| **(b) que `items_nombre_unico` deje de ser parcial** | migración sobre tabla con datos **y** limpieza previa | **482 colisiones medidas** sobre 26.086 filas (4.779 tachadas): `CREATE UNIQUE INDEX` **falla**. Limpiarlas pide `DELETE` físico sobre `public.items`, que **está en `supabase_realtime`** → **fallo duro** de la constitución; la alternativa es renombrar dato del usuario | **Sí, y de raíz:** volver a apuntar algo tachado deja de poder hacerse, que es el caso central de una lista de la compra. Y lo dice su propio test: `unit/duplicados.test.ts` › «el índice existe, es parcial y normaliza», cuyo mensaje es *«un índice total impediría volver a añadir algo borrado»* |
| **(c) deduplicar en la aplicación** | sacar el invariante de la base | ninguna | **Sí:** §D.2 veta el `check-then-act`, y **ya se midió**: el docstring de R7 en `unit/duplicados.test.ts` dice «Medido en el QA antes del cambio, quedaban dos filas» |

**(b) arrastra incomparablemente más que (a), y además está bloqueada por un fallo duro.** No es
un intercambio: es un camino cerrado. **(c) ya se probó y falló, con la medida escrita.** Queda
**(a)**, y no por descarte: es la única que pone el invariante en la base sin tocar el esquema.

Las 482 colisiones se midieron en la instancia local, que es el entorno autoritativo de
desarrollo. **No son datos de producción**, así que la cifra de producción no se conoce; lo que sí
es estructural y no depende del volumen es que basta **una** colisión para que el índice no se
pueda crear, y aquí hay 482.

## F.0ter Las tres condiciones del encargo, situadas contra el código

**1 · El dueño es la base.** Si al construir hace falta que un llamador se acuerde de algo, el
invariante volvió a la aplicación y esto vuelve a `/spec`. Aceptado como condición de parada, no
como consejo.

**2 · Cota de veredicto, no de intento.** Medido: `esperasDeReintento()` devuelve
`[1.000, 2.000, 4.000, 8.000, 8.000]` (`lib/errors.ts:312`) y `reintentarEnvio` recorre esa lista
y **termina** — 23 s y nadie reintenta después. O sea que **hoy la cota ya es de veredicto**: el
bucle completo acaba, no sólo cada intento. F **no toca** ese bucle, así que la condición se
cumple por herencia. Se anota porque si al construir apareciera un camino que reintenta sin cota
de veredicto, es hallazgo y no ajuste. *(Nota de alcance: la numeración del encargo dice «R3»; el
requisito 3 de esta spec es el trato del 23505. La cota vive en `reintentarEnvio`, y es lo que se
ha medido.)*

**3 · La ventana de 2 s la abre el reintento, y el arreglo la cierra, no la estrecha.** Es la
segunda espera de esa lista. Durante ella la fila sigue en la cola y otro disparador puede llamar
a `drenar()`. **Lo que hace a (a) la forma correcta es justo esto:** la base rechaza el repetido
**por igualdad de clave**, no por llegar tarde o pronto, así que la ventana no se hace más
pequeña — deja de existir. Cualquier arreglo que dependa de un plazo, un cerrojo en memoria o un
orden de llegada estrecha y no cierra, y por esta condición no vale.

## F.0quater El hallazgo: el código lleva escrita la premisa que esta spec desmiente

`app/g/[id]/GroupView.tsx`, docstring de R4, dice hoy:

> *La idempotencia no la pone este bucle: la pone la base. Reenviar un alta que ya entró devuelve
> `23505` por el índice único de nombre normalizado, y eso es éxito… Sin esa constraint habría que
> inventar aquí una clave de deduplicación, y sería peor.*

**Las dos frases son falsas en el caso que importa.** El índice de nombre es parcial, así que en
cuanto alguien tacha el producto el reenvío **no** devuelve 23505: inserta. Y la clave de
deduplicación no hay que inventarla ni ponerla «aquí»: la fila ya trae un uuid. *(Y no va en la
clave primaria, como decía esta línea: el cliente no puede escribirla.)* Es un documento que describe el mecanismo retirado, y es **el que haría que alguien
revirtiera F** leyéndolo de buena fe. Corregirlo es requisito, no cortesía.

## Requisitos

1. **`addItem` acepta el id de la fila y lo manda como `origen_id`.** Mecanismo que lo hace
   cumplir: `items_origen_unico`, UNIQUE sobre `(group_id, origen_id)` y **no parcial**. No es
   una convención del cliente: es la base la que rechaza.

   **Corregido al construir, y la corrección importa.** La spec decía «contra `items_pkey`,
   ninguna migración, ningún cambio de esquema». **Falso, y lo dijo la base con un `42501`:** el
   privilegio de INSERT de `authenticated` es por columna y **no incluye `id`**, a propósito y
   con dos guardas que lo declaran —`unit/grants.test.ts` › «la matriz de privilegios es
   exactamente la declarada» y › «un miembro no puede reescribir el id de un ítem»—. La clave
   primaria es autoridad del servidor. Así que la clave de deduplicación vive en **su propia
   columna**, con su índice y su privilegio, y §B.5 queda intacta: el cliente manda intención.
   Coste real: una migración forward-only que añade una columna nullable, un índice y un grant;
   **26.111 filas existentes quedan en NULL y los NULL no colisionan** — medido.

   Y un efecto secundario que mejora el diseño: al acotar la clave a `(group_id, origen_id)`, el
   borde de «un uuid que ya existe en otro grupo» **deja de existir** en vez de aceptarse por
   nombre. Lo sostiene `unit/duplicados.test.ts` › «F1bis: la misma clave de origen en otro grupo
   sí entra».
2. **El id no es un parámetro que el llamador pueda olvidar: viaja dentro de la fila.**
   `addItem` deja de aceptar un nombre suelto y acepta la **fila** —`{ id, nombre, cantidad }`—,
   así que no hay forma de pedir un envío sin decir de qué fila es. Es la lección de la Spec E
   aplicada al otro extremo: allí el dueño de la regla se metió **dentro de la lectura** porque
   lo que no se puede pedir no se puede olvidar pedir; aquí el dueño del id se mete **dentro de
   la firma**, y un llamador que lo olvide **no compila**.

   La redacción anterior de este requisito decía «el drenado manda `p.id`; el alta directa manda
   uno nuevo». Eso es exactamente lo que la E enseñó a no hacer: dependía de que cada llamador
   se acordara, y los llamadores nuevos nacen sin acordarse. Queda escrito porque el fallo de la
   E fue **no verlo escrito**.

   **Lo que la firma todavía no impide**, y va dicho en vez de descubierto: un llamador puede
   construir una fila con un id inventado en cada intento y perder la idempotencia. La firma
   hace imposible **olvidar** el id, no **falsearlo**. De ahí el requisito 6.

2bis. **Una clave por gesto de alta, compartida por el envío inmediato y la entrada de la cola.**
   `meterEnCola` toma la fila, no un nombre y una cantidad, y la fila se acuña **una vez** en el
   gesto.

   **Esto lo destapó la fila F6 en navegador, y desmiente una frase que esta spec tenía escrita:**
   «el alta directa manda un id nuevo: no tiene fila de cola y **no hay nada que deduplicar**».
   Falso. El alta directa acuñaba un uuid para su envío y `meterEnCola` acuñaba **otro** para la
   cola, así que en el caso que F existe para cerrar —el envío llega al servidor y su respuesta no
   vuelve— el reenvío llevaba una clave distinta de la que el servidor guardó, y la base no podía
   reconocerlo: **fila nueva**. El envío inmediato y la entrada de la cola son dos intentos de la
   **misma** intención, y por eso comparten clave.
3. **Un reenvío de la misma fila devuelve 23505 y el drenado lo trata como hecho** — el camino
   ya existe y no se toca; lo que cambia es que ahora ese 23505 llega también cuando el producto
   está tachado.
4. **`created_by` y `group_id` siguen derivándose donde se derivan hoy** (§B.5): el id es una
   clave de deduplicación, no autoridad. La política sigue exigiendo `auth.uid()`.
5. **El docstring de R4 deja de afirmar lo que F desmiente** (§F.0quater): que la idempotencia
   la pone el índice de nombre, y que una clave de deduplicación «sería peor». Con el mecanismo
   nuevo dicho en su sitio.
6. **Una guarda estructural afirma que el envío del drenado manda la fila que leyó**, no una
   construida en el sitio. Es la mitad que la firma no cubre, y el proyecto ya tiene el
   instrumento —el lector AST de `unit/almacen.test.ts`—. Con su sonda: un envío que invente el
   id tiene que ponerse rojo.

## Definición de hecho

| # | Comprobación | Capa | Por qué no puede estar verde antes |
|---|---|---|---|
| F1 | Dos `addItem` con el **mismo id**: el segundo da 23505 | la **base**, con el token del usuario (como `unit/mutation-errors.test.ts`) | hoy `addItem` no manda id: los dos insertan y salen dos filas |
| F2 | Y **con el primero tachado** (`deleted_at` puesto), el segundo **sigue** dando 23505 | la base, con token | es el caso que el índice parcial no caza; hoy crea fila nueva. Es la fila que prueba el requisito, no F1 |
| F3 | Envío aceptado + baja rechazada por el almacén + segunda pasada → **una sola fila** en el grupo | el **drenado**, con el almacén rechazando el `delete` | hoy la segunda pasada reenvía y, si el producto se tachó, crea otra |
| F4 | El alta directa sigue entrando, y dos altas del mismo producto siguen dejando una fila | la vista | [REGRESIÓN] — red de seguridad de la firma nueva |
| F5 | Navegador: con el `delete` rechazando y el producto tachado entre pasadas, la lista no gana una fila | navegador real | el arreglo vive en el envío, y el servidor es quien rechaza: ninguna prueba de unidad ve el par completo |
| F6 | **El camino dominante:** envío aceptado y el proceso muere antes de la baja; al volver, el reenvío no crea fila aunque el producto esté tachado | navegador real, matando el contexto entre el envío y la baja | es el camino que ningún booleano cierra; hoy no hay ninguna fila que lo mire |
| F7 | La guarda ve que el drenado manda la fila leída, y caza un envío con id inventado | el **módulo**, con el lector AST | la firma impide olvidar el id, no falsearlo: sin esta fila esa mitad no la mira nadie |
| F8 | **Un reenvío durante la espera de 2 s del reintento no duplica la fila en la base** | navegador real, con la espera del reintento en curso | es la ventana que el propio reintento abre; hoy el segundo envío inserta si el producto se tachó |
| F9 | Ningún documento sigue afirmando que la idempotencia la pone el índice de nombre | barrido de ficheros | hoy el docstring de R4 lo afirma, y es lo que haría revertir F |

**Cota de veredicto (condición 2 del encargo):** `reintentarEnvio` ya termina —23 s y para—, y F
no toca ese bucle. No hay fila propia porque no hay cambio; si al construir aparece un reintento
sin cota de veredicto, es hallazgo.

**F2 es la fila que importa.** F1 pasaría también con el índice de nombre haciendo el trabajo, y
entonces el requisito estaría verde por el mecanismo equivocado.

## La valla — lo que NO puede cambiar, con el test que lo sostiene hoy

| Comportamiento | Test, por nombre |
|---|---|
| El duplicado por nombre sigue rechazándose con 23505, y sólo por diferencias que no cuentan | `unit/duplicados.test.ts` › «rechaza el duplicado con 23505, y sólo por diferencias que NO cuentan» |
| Un 23505 al añadir sigue diciendo que ya está en la lista | `unit/avisos.test.tsx` › «un 23505 al añadir dice que ya está en la lista» |
| Un 23505 al drenar sigue sacando la entrada de la cola | `unit/drenado.test.tsx` › «DoD 32: un 23505 al drenar saca la entrada de la cola» |
| Sale el más antiguo primero, y sólo un envío en vuelo | `unit/drenado.test.tsx` › «DoD 28: sale el más antiguo primero, y sólo un envío en vuelo» |
| Quien no es miembro no puede insertar | `unit/mutation-errors.test.ts` — llama a `addItem` con el token del intruso, así que **la firma nueva pasa por ahí**: si cambia mal, este test no compila |

## Bordes

- **~~Un id repetido de otro grupo.~~ Este borde NO existe**, y decirlo importa porque la
  §Decisión 2 pedía tu mano sobre un peligro inexistente. Al medir los privilegios la clave acabó
  en `(group_id, origen_id)`, acotada al grupo, así que la misma clave en otro grupo entra sin
  chocar — y lo prueba `unit/duplicados.test.ts` › «F1bis». Lo que **sí** queda sin decidir es su
  hermano: un `origen_id` repetido **dentro del mismo grupo**, donde el drenado da el 23505 por
  hecho sin haber insertado nada. Reenunciado así en la iteración 2.
- **Un cliente eligiendo ids a propósito.** Puede aprender que un uuid existe provocando un
  23505. Para saberlo tiene que conocer el uuid, que él mismo generó. Se acepta y se nombra.
- **La fila de la cola nace en dos pantallas** (`GroupView` y la cáscara) y las dos ya usan
  `crypto.randomUUID()`. Si mañana nace en una tercera sin uuid, F se rompe en silencio: el
  requisito necesita que el id **sea** un uuid, no que alguien se acuerde.

## Fuera de alcance, por nombre

Honrar el booleano de `quitarDeCola` en ningún sitio (eso es G) · el texto que ve el usuario
cuando la baja no se confirma (G) · `olvidarTodo` (G) · la deuda 67 y sus escapes de la guarda.

---

# Spec G — Una baja que el almacén no confirmó no puede pasar por hecha

## Requisitos

1. **`quitarDeCola` devuelve tres estados**, no un booleano: la fila **se fue**, **no estaba**,
   o el almacén **rechazó**. Hoy `return ok && habia` fusiona los dos últimos, y eso es la
   deuda 64 bis: un drenado que honrara el booleano de hoy trataría «otra pestaña ya la
   drenó» —normal— como «el disco la rechazó».
2. **`barrerCaducados` cuenta sólo «se fue»** — comportamiento idéntico al de hoy, expresado
   sobre el tipo nuevo.
3. **El drenado, ante «rechazó», no suelta la fila de la pantalla** y vuelve a intentar la baja
   en la pasada siguiente. Ante «no estaba», sigue en silencio.
4. **`olvidarTodo` dice si lo consiguió todo**, y sus dos llamadores actúan en consecuencia.
   ← **Este requisito es la decisión de abajo: puede que no deba viajar en G.**

## Definición de hecho

| # | Comprobación | Capa | Por qué no puede estar verde antes |
|---|---|---|---|
| G1 | Con el `delete` rechazando: «rechazó». Con la fila ausente: «no estaba». Con la fila presente: «se fue» | el **almacén** | hoy los dos primeros son el mismo `false` |
| G2 | El barrido cuenta lo mismo que hoy en los tres casos | el almacén | [REGRESIÓN] |
| G3 | Envío aceptado + baja rechazada → la ficha **sigue** en pantalla | la **vista** | hoy `setPendientes` la suelta sin mirar |
| G4 | Envío aceptado + la fila ya no está (otra pestaña) → **ningún** aviso, ninguna ficha | la vista | hoy no se distingue de G3, así que el arreglo ingenuo avisaría de un fallo que no hubo |
| G5 | `olvidarTodo` con el almacén rechazando: lo dice, y el llamador no afirma que se fue todo | la vista, en las **dos** pantallas que lo llaman | hoy devuelve `void`: no hay nada que mirar |

## La valla

| Comportamiento | Test, por nombre |
|---|---|
| `quitarDeCola` borra lo que `encolar` puso, por su id | `unit/duplicado.test.tsx` › «quitarDeCola borra lo que encolar puso, con su id» |
| Dos barridos a la vez no sobrecuentan ni dejan la cola inconsistente (el borde B7) | `unit/duplicado.test.tsx` › «i2-4: dos barridos a la vez no sobrecuentan ni dejan la cola inconsistente» |
| `olvidarTodo` se lleva la cola del usuario | `unit/duplicado.test.tsx` › «olvidarTodo se lleva la cola del usuario» |
| Y también la lista y el nombre | `unit/duplicado.test.tsx` › «olvidarTodo se lleva también la lista y el nombre del usuario» |
| Una caducada no bloquea volver a apuntar; una viva sí | `unit/duplicado.test.tsx` › «i1-3: sin barrer, nadie la ve y no bloquea volver a apuntarla» y su sonda |

`quitarDeCola` es mecanismo compartido por tres consumidores: la valla es lo que impide que
arreglar al segundo rompa al primero.

## Bordes

- **La ventana del callejón de la 63** (§0.1): entre la baja rechazada y la relectura siguiente,
  un alta sin red del mismo producto dice «ya está en la lista» sin ficha en pantalla. Con G3 la
  ficha **no se suelta**, así que el borde se cierra como efecto — y eso hay que probarlo, no
  suponerlo: es una fila de la DoD de G, no una nota.
- **Reintentar una baja para siempre.** Si el almacén rechaza siempre, el drenado reintenta en
  cada pasada. Con F puesto eso es inofensivo (el reenvío choca), pero sin F es el bucle de la
  resurrección. **Es la dependencia de orden: G sin F es peor que ninguno de los dos.**

## Fuera de alcance

El texto exacto de los avisos nuevos, si la decisión de abajo saca `olvidarTodo` de aquí · la
deuda 68 y 69 (la pasada) · la 67.

---

## Orden de llegada — y qué se rompe si llegan separados

**F antes que G.** G3 hace que el drenado reintente la baja; sin F, cada reintento es un reenvío
y el reenvío es la resurrección. F sola es completa y segura. G sola **empeora** la 64.

---

## Puerta de constitución

- **§B.5 el cliente envía intención, nunca autoridad** — F manda un `id`. No es autoridad:
  `group_id` y `created_by` se siguen derivando, y la política los sigue exigiendo. Nombrado
  arriba porque es la regla que un revisor tiene que ver discutida, no dada por buena.
- **§D.2 sin condiciones de carrera** — F pone el invariante en la base
  (`INSERT` contra un índice único de la base) en vez de en memoria del proceso, que es lo que
  §D.2 pide. **No contra la clave primaria**: ésta es la afirmación de la puerta de constitución, o
  sea la que un revisor lee primero, y estuvo mal una iteración entera.
- **§D.4 efectos idempotentes** — F es exactamente esto: «clave estable o constraint única».
- **§A.1 un grupo es un límite de datos** — G4/G5 tocan lo que sobrevive a una salida. Ninguna
  de las dos specs afloja RLS ni añade un camino de lectura.
- **§A.3 fallar cerrado** — G5 es la aplicación: si no se puede confirmar que se borró, no se
  afirma que se borró.

---

## Decisiones que necesitan tu mano antes de sellar

1. **¿`olvidarTodo` viaja en G, o es su propia spec?** Tiene otro disparador —una vez por salida
   o por cambio de usuario, no una por baja—, otra consecuencia —lo que queda en un dispositivo
   compartido, no una fila de más— y otro remedio. Por la regla de la E, eso son dos. Va escrito
   como requisito 4 de G porque **comparte el mecanismo** (los tres estados), pero si lo separas,
   G queda más limpia y `olvidarTodo` se lleva su propia valla. **Mi recomendación: separarla**,
   y hacerla la siguiente, porque su eje es privacidad y no integridad.
2. **El borde del id repetido de otro grupo** (F): ¿se acepta por nombre con el argumento del
   uuid v4, o el drenado comprueba que la fila que ya existía es suya? Lo segundo cuesta una
   lectura más por cada 23505 y cierra un fallo silencioso que hoy nadie puede distinguir.

Ninguna de las dos es investigable: las dos son tuyas.

---

## Lo que NO se verificó al escribir esto

- **No hay prueba en navegador de que el `delete` de IndexedDB se pueda hacer rechazar a
  voluntad en el arnés de Playwright.** La 63 original dice que la revisión de la iteración 5 lo
  midió en navegador real, así que el camino existe; no lo he repetido yo. F5 y G5 dependen de
  ello, y si no se puede, la fila lo dice en vez de degradarse a unidad.
- **No he medido cuánto cuesta la lectura extra del borde 2**, porque la decisión es tuya y la
  medida depende de cuál elijas.

---

## Iteración 1 — lo que la revisión midió, y dos errores míos de registro

Origen: revisión de la base de la Spec F. Entran los dos HIGH, la fila del DoD que desapareció,
y los registros falsos. Lo que queda fuera va nombrado al final.

**Los dos errores de registro, que son la parte incómoda y la que ordena el resto:**

1. **El docstring de reemplazo dice que la idempotencia la pone «la clave primaria».** Falso: el
   cliente no puede escribir `items.id` —es el `42501` que este mismo ciclo se comió— y quien
   rechaza es `items_origen_unico`. La frase se escribió cuando el mecanismo iba a ser la
   primaria y **no se actualizó al cambiar de mecanismo**. Peor: la sonda negativa de F9 cita esa
   frase exacta como «el texto corregido», así que **la guarda certifica el error**. Sustituir una
   afirmación falsa por otra y escribir el test que la bendice es el defecto, no el descuido.
2. **La fila F5 de esta misma spec desapareció sin declararse.** Está en §Definición de hecho y
   no está en la lista del DoD ni en la suite. Y su única excusa escrita —«no he comprobado que
   el `delete` de IndexedDB se pueda hacer rechazar desde Playwright»— la desmiente F8, que lo
   hace abortando la transacción de escritura. La condición se cumplió y la fila se cayó.

### Requisitos

1. **El docstring nombra el mecanismo real** y la guarda deja de certificar lo contrario: el caso
   negativo de F9 usa el texto corregido **de verdad**, y se añade una afirmación positiva de que
   el fichero nombra `items_origen_unico`.
2. **F5 se cubre**: navegador, con la escritura sobre `cola` abortada y el producto tachado entre
   pasadas, la lista no gana fila. El arnés existe —lo usa F8—.
3. **Los demás documentos dejan de afirmar lo retirado**: `GroupView.tsx` noventa líneas más
   abajo, dentro del fichero que F9 barre; y las deudas 64 y 64 bis, que declaran viva una
   resurrección que F cierra. Y el alcance del barrido se iguala a lo que su fila afirma.
4. **Una clave por intención, también cuando el gesto se reinicia.** Si el envío falló con
   `servidor` y `encolar` devuelve `'rechazado'` o `'ya-estaba'`, hoy la clave se tira y el
   siguiente intento acuña otra, con el servidor posiblemente guardando la fila bajo la primera.
   Es el último camino donde una intención tiene dos claves — la clase exacta que F6 encontró.
5. **El índice se acota a lo que tiene clave.** `where origen_id is not null`: mismo invariante
   —los NULL no colisionan nunca— y 1.056 kB de entradas NULL que dejan de existir. Partial sobre
   `deleted_at` está prohibido; partial sobre `origen_id is not null` es gratis, y el comentario
   tiene que separar los dos ejes para que nadie lo lea como una regresión.
6. **La guarda del AST cubre lo que su requisito dice cubrir, o se retira diciéndolo.** Sigue una
   forma en la posición 3 y la derrotan tres variantes que compilan limpias, la más barata de una
   línea: `{ ...p, id: crypto.randomUUID() }`. Sigue el binding un salto, o se retira y R6 pasa a
   descansar en F3 y F6 **por escrito**.
7. **El orden de despliegue deja de depender de que alguien se acuerde.** Con el código delante de
   la migración, cada alta da «No se ha podido completar la operación.», la cola no drena y a las
   24 h se descarta. Una guarda que lea el catálogo del entorno de destino, o un arranque que
   falle cerrado. *(La mitad de infraestructura —paso de CI o de despliegue— necesita tu mano y
   queda fuera.)*
8. **`Item` declara `origen_id`** —el payload de realtime ya lo lleva— y la fila F4 de la lista se
   reetiqueta a la capa que de verdad la cubre.

### Definición de hecho

| # | Comprobación | Capa | Por qué no puede estar verde antes |
|---|---|---|---|
| i1-1 | El fichero nombra `items_origen_unico` y no atribuye la idempotencia a la primaria | barrido | hoy lo atribuye, y la sonda negativa lo bendice |
| i1-2 | F5: escritura abortada + producto tachado entre pasadas → la lista no gana fila | navegador real | la fila no existe |
| i1-3 | Ninguna de las tres fuentes contiene ya las frases retiradas, ni la de 90 líneas abajo | barrido | hoy `GroupView.tsx:563` la contiene y F9 está verde |
| i1-4 | Reiniciado el gesto tras `'rechazado'`, el segundo intento lleva **la misma** clave | la vista | hoy acuña otra |
| i1-5 | El índice es parcial sobre `origen_id is not null` y F2 sigue roja sin él | la base | hoy es total |
| i1-6 | La guarda caza `{ ...p, id: … }`, `p.id = …` y el ayudante local — o R6 dice por escrito que no cubre esas tres | el módulo | hoy las tres pasan y compilan |
| i1-7 | Con la columna ausente, algo se pone rojo antes de que un usuario lo vea | la base / arranque | hoy sólo se ve como «No se ha podido completar la operación.» |
| i1-8 | `Item` declara `origen_id` | tipos | hoy no |

### Fuera, por nombre

El paso de CI o de despliegue (requisito 7, mitad de infraestructura) · el borde del `origen_id`
repetido **dentro del mismo grupo**, que es la §Decisión 2 que sigue sin contestar · la deuda de
NFC/NFD, que va al fichero de deuda y **no** se arregla sólo en el cliente, porque eso crearía la
divergencia que hoy no existe.

---

## Iteración 2 — la excusa, la guarda que no puede fallar, y una regresión que introduje

Origen: revisión de la iteración 1. Entran los dos HIGH y la regresión de usabilidad que nadie
había declarado. **Y entra un patrón que ya lleva dos vueltas seguidas**, escrito aquí porque es
la causa común de los dos HIGH:

> Las dos veces afirmé algo sobre **mi propia evidencia** sin medirlo: «rojo antes: sí» cuando el
> barrido daba 0 ocurrencias, y «el arnés no compone hoy este caso» cuando lo compone en la línea
> 1720 del fichero que esa misma lista cita para otra fila. Una afirmación sobre la evidencia es
> una afirmación, y va medida como cualquier otra.

### Requisitos

1. **La guarda que impide volver a atribuir la idempotencia a la clave primaria tiene que poder
   cazarlo.** Hoy no puede: medido, su regex da `False` contra el texto viejo —el que existe para
   condenar— y `False` si se cambia una palabra. Es el defecto del punto que corta la ventana,
   repetido dentro de su propio arreglo. La propiedad pasa a ser **positiva y literal** —el
   párrafo contiene la frase correcta *y* el nombre del mecanismo— y llega con **sondas que deben
   ser cazadas**: la frase histórica, la de una palabra cambiada, `items_pkey` y «la PK».
2. **i1-4 deja de ser UNCOVERED, porque la excusa es falsa.** El caso se escribe en
   `unit/drenado.test.tsx`, que ya compone `encolar → 'rechazado'` con `addItem → 'servidor'`. Y
   el mutante que la pasada etiquetaba «debe SOBREVIVIR» pasa a ser una captura.
3. **La clave heredada no puede convertir un alta legítima en un callejón.** Regresión que
   introduje y que nadie declaró: si el intento anterior **sí** llegó al servidor y alguien tachó
   el producto, el reintento hereda la clave, choca con el índice de origen —que no es parcial— y
   el usuario lee «ya está en la lista» sobre algo que no está, sin ficha que enfocar y sin salida
   salvo renombrar. Antes del cambio ese re-apunte **funcionaba**, porque el índice de nombre sí
   es parcial. Mecanismo: **un reintento acotado con clave nueva** cuando el 23505 llega sobre una
   clave heredada. No se olfatea el texto del error —lo prohíbe la constitución—: el cliente sabe
   si heredó, y con eso basta.
4. **La clave no sobrevive a su intención, y hay una por producto.** Hoy no se limpia en el camino
   `'servidor'` + encolado con éxito, y la casilla es única: intercalar otro producto que falle
   pierde la del primero. Las dos medidas rojas por la revisión.
5. **Los registros falsos, corregidos**: la columna «rojo antes» de i1-3, que era falsa; las
   cuatro afirmaciones **vivas** de `docs/spec.md` que siguen atribuyendo el invariante a la
   primaria —incluida la puerta de constitución—; el borde «un id repetido de otro grupo», que con
   `(group_id, origen_id)` **no existe**; el marcador de la pasada, que cuenta la NEUTRA como parte
   atacada; y la cita de F4, que se apoya en un caso que sólo afirma la ausencia de aviso.
6. **El falso positivo nuevo de la guarda del AST**: `const p = siguienteEnCola(cola, group.id,
   Date.now())` se marca como fila fabricada porque `INVENTA` se aplica al texto entero del
   inicializador. Es la clase que su propio docstring declara peligrosa.
7. **La ronda de navegador de la pasada repite como la de unidad**, comprueba el `$?` de sus dos
   `pnpm build`, y cualquier salida ≠ 0 del sembrador cuenta como «no aplica» y no como
   superviviente.

### Definición de hecho

| # | Comprobación | Capa | Por qué no puede estar verde antes |
|---|---|---|---|
| i2-1 | La guarda caza las cuatro reintroducciones medidas | barrido | hoy no caza ninguna, ni el texto viejo |
| i2-2 | Reiniciado el gesto tras `'rechazado'`, el segundo intento lleva la misma clave | la vista | hoy no lo mira nada, y el mutante sobrevive |
| i2-3 | Con la clave heredada chocando, el producto **entra** y el usuario no lee «ya está en la lista» | la vista | hoy lee eso y no tiene salida |
| i2-4 | La clave se olvida al encolarse con éxito, y dos productos fallidos conservan la suya | la vista | hoy sobrevive y la casilla es única |
| i2-5 | El falso positivo de `Date.now()` en el inicializador no se marca | el módulo | hoy se marca |
| i2-6 | La ronda de navegador fija veredicto por repetición | la pasada | hoy es muestra de 1 |

### Fuera, por nombre

El paso de CI o de despliegue · la §Decisión 2 reenunciada —el `origen_id` repetido **dentro del
mismo grupo**— · el registro de `supabase_migrations`, que es de entorno · la sonda de §E.2 para
las dos filas de catálogo, que va a deuda.

---

## Spec G2 — `devolver` hace dos trabajos con calendarios distintos · **SIN SELLAR**

Sale del ciclo de la Spec F, y sale **medida**: el reintento acotado se congeló tras dos vueltas
en las que cada arreglo abría el agujero de al lado. La revisión localizó la causa un nivel más
abajo de donde yo la había puesto — no está en la rama del `23505`, está en `devolver()`.

### La pregunta, hecha antes de escribir el requisito

*¿Qué tendría que pasar para que `devolver()` se separe en dos y el fallo ocurra igual?* **Tres
respuestas construidas, y las tres son cosas que este ciclo ya hizo sin haberse hecho la
pregunta.** Ésa es la razón de que la spec empiece aquí y no por el requisito.

1. **Se separa en dos funciones y la fusión se muda al sitio de llamada.** Partir el nombre no
   parte la decisión: si el llamador sigue llamando a «recuerda la clave» en una rama donde el
   servidor **probó** que no hay fila —porque en esa rama también quiere el texto de vuelta—, el
   defecto es el mismo con dos nombres. Medido hoy: la clave se recuerda tras `42501` y tras
   `23505`, y el bloque del reintento dispara sobre una clave que el servidor rechazó.
   → El corte no es por función: es **por quién decide**. Recordar tiene que derivarse de la
   **clase del resultado**, no elegirse en la rama.
2. **Se separa bien y la clave sigue viviendo más que su intención.** «Recordar sólo cuando el
   resultado es desconocido» no dice nada de cuándo muere. Medido: tres gestos seguidos dan seis
   envíos y **cuatro claves distintas**, porque la salida no feliz del reintento vuelve a sembrar
   el mapa. → La spec tiene que decir **cómo muere la clave**, no sólo cuándo nace.
3. **Se separa bien, la clave muere bien, y el reintento sigue disparando en el duplicado de todos
   los días.** `23505` no dice qué índice chocó y el cliente no puede preguntarlo. → Entonces el
   disparador no puede ser «23505 + heredada»: tiene que ser «el resultado anterior es desconocido
   **y** el producto no está vivo», y «no está vivo» **exige una lectura** — precisamente la
   relectura de R7 que el código actual se salta al volver antes de ella.

**La tercera es la que cambia el diseño:** el mecanismo necesita *leer*, no *adivinar*. Y por eso
esta spec no puede escribirse como un ajuste de la rama.

### Lo que hay que decidir, y no decido yo

- **El coste de esa lectura.** R7 ya relee tras un `23505`; usarla antes de reintentar es
  reordenar, no añadir. Pero con la red caída no hay lectura posible: ahí el mecanismo tiene que
  elegir entre no reintentar (y dejar el callejón) o reintentar a ciegas (y arriesgar la fila
  nueva). **Sin decidir.**
- **Si `origen_id` debería poder leerse.** Con una lectura por clave de origen, «¿aterrizó mi
  intento?» se contesta sin adivinar nada. Hoy el cliente tiene `SELECT` sobre la columna; lo que
  no hay es un camino que la consulte. Eso es una superficie nueva, y es tuya.

### La valla, por nombre de test

`unit/drenado.test.tsx` › «i2-2: reintentado el mismo producto, el segundo envío lleva la misma
clave» · › «i2-4: dos productos fallidos conservan cada uno su clave» · › «i2-4: la clave se olvida
cuando el envío entra en el servidor» · › «i2-4: y la clave se olvida cuando el producto acabó
encolado» · › «i2-3: con la clave heredada chocando, el producto entra con clave nueva» · › «i2-7:
con clave heredada y el producto tachado, acaba una sola fila» · `unit/duplicado.test.tsx` ›
«un duplicado no entra, no avisa, y lo dice».

Las siete sostienen comportamiento que esta spec **puede** romper sin querer, y las siete existen
hoy en esos ficheros.

### Fuera, por nombre

El índice, la columna y el privilegio —eso es la Spec F y está cerrado— · el drenado, que trata el
`23505` como hecho y no acuña nada · las once formas de la deuda 72 · el paso de despliegue.
