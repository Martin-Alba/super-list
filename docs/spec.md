# Specs

Un borrador vivo: **«El duplicado lo impide la escritura»**, sin sellar y sin marcador,
a la espera de revisión. No hay ninguna sección `ACTIVE`: no hay nada en construcción.

Al final, dos specs futuras con lo ya medido.

---

# BORRADOR — El duplicado lo impide la escritura

**SIN SELLAR. Sin marcador.**

## 1. El problema

Dos instancias del navegador pueden meter **el mismo producto dos veces** en la cola de
pendientes. Cada una lee la cola, decide que no hay duplicado, y escribe: entre la
lectura y la escritura hay un `await`, y en esa ventana la otra escribió.

**Reproducido** —y esto importa, porque dos intentos anteriores concluyeron lo
contrario: dos raíces montadas, la misma palabra, sin red, con las pulsaciones
**solapadas dentro de una misma tarea** y un doble de almacén que **escribe** en la cola
compartida. Resultado: `leerCola` 4 · `encolar` **2** · cola `['leche','leche']`. El
control seriado —un `act` por pulsación— da `encolar` 1, así que el arnés distingue.

Es §D.2 literal: *los invariantes se hacen cumplir en la base —`INSERT ... ON CONFLICT`,
constraints únicas— no en memoria del proceso.*

## 2. Es un defecto en dos pantallas, y el arreglo va donde las dos pasan

| Camino | Dónde | Forma |
|---|---|---|
| 3 | `app/g/[id]/GroupView.tsx:340→357` | `leerCola` → `decidirEncolar` → `await encolar` |
| 4 | `app/sin-conexion/page.tsx:287→296` | idéntica, palabra por palabra |

Los dos son **el mismo defecto escrito dos veces**, y eso tiene una explicación que ya
está medida y escrita: la Spec C sacó la **regla** a `lib/cola.ts` —`decidirEncolar`, que
las dos pantallas comparten— y dejó los **efectos** en cada pantalla. El check-then-act
no vive en la regla: `decidirEncolar` recibe la cola ya leída y decide sin efectos. La
ventana vive entre esa lectura y la escritura, o sea **en el efecto**, o sea en cada
llamador. Compartir la decisión y no el efecto duplicó el hueco mientras se declaraba
haber unificado la lógica.

**Por eso el arreglo va en `lib/local.ts`**, que es por donde pasan las dos: los cuatro
escritores de la cola usan `encolar`, y ese módulo es el único que toca la tienda
`COLA`. Poner el invariante en cada llamador sería repetir el error que causó esto.

## 3. Qué invariante, exactamente

Hoy la tienda `COLA` usa `keyPath: 'id'`, y el `id` lo genera quien encola con
`crypto.randomUUID()`: dos altas del mismo producto tienen ids distintos, así que la
clave no las distingue y el almacén las acepta las dos.

La regla de igualdad **ya existe y es compartida**: `mismoProducto(a, b)` en
`lib/items.ts` compara nombres normalizados, y `decidirEncolar` la usa para la cola con
`p.grupo === grupo && mismoProducto(p.nombre, nombre)`. **La spec no inventa un criterio
nuevo:** el invariante es exactamente el que la regla ya declara — *un producto, por
nombre normalizado, por grupo, por usuario, no puede estar dos veces en la cola*.

**Lo que la spec no decide todavía y hay que resolver al sellar** es la forma, porque
las dos que se ven tienen coste distinto y hay que medirlo:

- **Clave derivada:** que el `keyPath` sea una clave que ya contenga el invariante. Un
  `put` con la misma clave sobrescribe en vez de duplicar. Coste: es una **migración de
  la tienda** —`onupgradeneeded`, versión nueva, y qué hacer con las colas que ya
  existen en disco de los usuarios—.
- **Re-chequeo dentro de la misma transacción `readwrite`:** leer y escribir sin soltar
  la transacción, que es lo que la hace atómica. Coste: `encolar` pasa de una escritura
  a una lectura más una escritura, y hay que comprobar que `escribir` —que hoy sólo
  sabe de sí o no— puede devolver «ya estaba».

## 4. El arnés, que entra en la spec

Las dos sondas anteriores fallaron por no tener **las tres cosas a la vez**, y por eso
el arnés va escrito aquí y no se deja a quien construya:

1. **Dos raíces montadas** sobre la misma cola.
2. **Las pulsaciones solapadas dentro de una misma tarea** —un solo `act`—. Serializadas
   no reproducen: la primera termina antes de que empiece la segunda.
3. **Un doble de `encolar` que escribe de verdad** en la cola compartida del arnés. Sin
   eso, la segunda lectura no puede ver lo que la primera escribió y el caso se disuelve.

Y el **control** es parte del arnés, no un extra: el mismo caso serializado tiene que dar
una sola escritura. Sin él, la sonda no distingue «lo impidió el invariante» de «nunca
ocurrió».

## 5. Requisitos

**R1 — El almacén impide el duplicado, no el llamador.** `encolar` rechaza —o absorbe—
un pendiente cuyo producto ya está en la cola para ese usuario y ese grupo, según
`mismoProducto`. Los llamadores no cambian su forma de pedirlo.

**R2 — El llamador se entera de qué pasó.** `encolar` hoy devuelve `boolean`: entró o no
entró. «No entró porque el disco dijo que no» y «no entró porque ya estaba» son cosas
distintas y la pantalla dice cosas distintas —`SIN_ALMACEN` frente a `DUPLICADO`—, así
que el contrato tiene que distinguirlas.
*Nota de alcance:* esto toca la firma que **cuatro** sitios usan. Enumerarlos y
comprobar qué hace cada uno con el `false` de hoy es trabajo de sellado.

**R3 — `decidirEncolar` no se toca.** Sigue decidiendo lo mismo para lo que ve, y sigue
siendo la puerta que da el mensaje al usuario en el caso normal. El invariante del
almacén es la **red** para lo que la decisión no puede ver: lo que otra instancia
escribió en la ventana.

**R4 — La migración de la tienda, si la forma elegida la necesita, es expand/contract y
tolera colas ya existentes en disco.** §C: forward-only, idempotente. Una cola con
duplicados ya escritos no puede dejar la app sin arrancar.

## 6. Fuera de alcance, por su nombre

- **Las otras dos familias** (§8 y §9). En particular: esta spec **no** arregla que la
  pantalla muestre lo que otra instancia cambió, ni la copia rancia del drenado.
- **La lista de productos** y la tienda `LISTAS`. Sólo la cola.
- **El aviso de duplicado en pantalla**, más allá de que R2 permita distinguirlo.
- **La caducidad**, el orden y el drenado.

## 7. Suposiciones a resolver al sellar

- **`[ASSUMPTION]`** — que la sonda del §4 corre en el arnés unitario con dos raíces. Lo
  reprodujo la revisión ahí; falta comprobar que sobrevive fuera del árbol del revisor.
- **`[ASSUMPTION]`** — que ninguna de las dos formas del §3 rompe `olvidarTodo`, que
  barre por clave (`esClaveDe`) y que hoy no toca la tienda `COLA`. Hay que verificarlo
  contra el código, no suponerlo.
- **`[OPEN]`** — cuál de las dos formas. Se decide midiendo, no por gusto: qué cuesta la
  migración frente a qué cuesta la transacción larga.

---

# Specs futuras, con lo ya medido

## 8. Releer, notificar y ordenar los escritores — **las tres juntas**

Van juntas y el motivo está medido: **la tercera existe por culpa de la segunda.**

- **Releer.** `GroupView:406→446` retira el aviso de la cola decidiendo sobre una lectura
  anterior a tres `await`. Reproducido: «pan» sigue en la cola y el aviso desaparece.
  Era la «Forma A» de la spec anterior, que decía que iba primero, y no se construyó.
- **Notificar**, su mitad que falta: la cáscara recibe por el canal pero **no** escucha
  `visibilitychange`. Medido: perdido el mensaje, cero relecturas al volver, y sin red no
  se recupera nunca. El comentario que dice que no hace falta es falso y está medido como
  tal. Y el mismo efecto está escrito dos veces con **contenido distinto** en las dos
  pantallas — el §2 de arriba, cometido otra vez.
- **Ordenar los escritores del hueco local.** `setPendientes(prev => [...prev, p])`
  (optimista) y `setPendientes(mios)` (autoritativo, desde la relectura) escriben el
  mismo estado sin orden. Y la pestaña **se oye a sí misma**: publicador y suscriptor son
  objetos distintos del mismo canal. Reproducido con entrega síncrona: `fichas=2 cola=1`.
  Hoy no se manifiesta porque la entrega real llega como tarea y el añadido como
  microtarea — o sea, la corrección descansa en un detalle de planificación que nadie
  vigila.

Además, sin resolver de la spec anterior: el canal es global y se declaró «por usuario»;
y la sonda de ausencia del almacén sólo reconoce una forma de escribir (deuda 56).

## 9. El estado que caduca con el reloj, sin observador

`reparte` se evalúa en el montaje y la relectura no lo aplica. Reproducido sin red: un
pendiente entra fresco, pasan 25 h con la pestaña abierta, y **su ficha sigue en
pantalla** prometiendo un envío de algo que el próximo arranque descartará en silencio.

Nadie escribió y nada cambió: lo que se movió fue el reloj. No lo arregla releer —trae el
mismo dato—, ni notificar —no hay nada que notificar—, ni el invariante de la escritura.
Es una familia propia, y la más pequeña de las tres.
