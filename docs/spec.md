# Specs

Queda un documento: la **Spec B**, **sin sellar**. No lleva marcador `ACTIVE` y no
entra en el bucle hasta que `/spec` la verifique contra la base y la selle.

Las dos anteriores se construyeron y se cerraron el 2026-09-13, y su registro está
en `docs/CHECKPOINT.md`:

- **Spec A** — «la puerta no pasa con avisos del linter». Cerró la deuda 46.
- **Spec C** — «la cáscara sin red». Cerró la deuda 53, y su motivo era el orden:
  al recargar sin cobertura dentro de un grupo el service worker sirve la cáscara,
  así que el mecanismo que la **B** viene a depurar no está montado. Por eso fue
  primero.

---

# Spec B — el ciclo de vida de aviso-y-recuperación

*(sin sellar: espera a que la Spec A esté construida)*

## Objetivo

Desacoplar el mecanismo, no parchearlo. Cierra las entradas **40, 41, 42 y 43**
de `docs/TECHNICAL_DEBT.md`, que son el mismo problema visto por cuatro sitios.

## Contexto verificado

El diagnóstico salió de las cinco revisiones del ciclo de la deuda 34, donde
cuatro iteraciones seguidas abrieron una regresión en el mismo sitio. **Se ha
vuelto a verificar contra el código de hoy**, que cambió con el arreglo de la 34.
Las tres piezas siguen en pie, y una es peor de lo que se describió.

**Pieza 1 — `secuencia` no sella dos cosas, sella tres.** Medido: los avisos
(`avisarTexto`, `limpiarAviso`), el **afinado por sesión** del `42501`, y el
reintento de **carga**. Un `limpiarAviso()` mata las tres. La descripción original
decía dos.

**Pieza 2 — `avisar` acopla mensaje con bucle.** Sigue exacta: para clase
`servidor` lanza `reintentar` además de pintar. De ahí salió la regresión I1 —
quitarlo de una rama se llevó por delante la recuperación de la lista, y nada lo
dijo.

**Pieza 3 — `loadClase` es una prop.** Confirmado: la pasa el servidor en cada
render (`app/g/[id]/page.tsx:42`), se usa en ocho sitios, y el propio componente
lo documenta. El arreglo de la 34 la metió en las dependencias de **un** sitio; el
resto sigue como estaba.

**Lo que el arreglo de la 34 sí cambió, y sirve de precedente:** el reintento de
**envío** ya tiene su generación propia (`envio`). La separación que esta spec
propone no es nueva: es terminar la que ya se empezó.

**Radio medido, y por eso es acotable:** el mecanismo entero vive en
`app/g/[id]/GroupView.tsx` — `avisar` 5 sitios, `avisarTexto` 12, `limpiarAviso`
9, ninguno fuera. El traductor está en `lib/errors.ts` y no se toca.

## Lo que NO debe cambiar, y qué lo fija hoy

Es un refactor de mecanismo, y la forma de que salga mal es que algo que hoy
funciona deje de hacerlo sin que ningún test lo note. Cada comportamiento va con
la prueba que lo sostiene, comprobada el 2026-09-12 — **los siete tienen una**,
así que ninguno queda desprotegido.

| # | Comportamiento | Lo fija |
|---|---|---|
| 1 | Una mutación denegada pinta su aviso; una que va bien no deja ninguno | `unit/notice-render.test.tsx:83` «una mutacion denegada pinta el aviso» y `:102` «una mutacion que va bien no deja aviso» |
| 2 | El aviso se limpia en la siguiente operación con éxito | `unit/notice-render.test.tsx:109` «el aviso se limpia en la siguiente operacion con exito» |
| 3 | El afinado por sesión distingue el `42501` «no traes token» del «tu token no basta», y el aviso aparece aunque la consulta de sesión cuelgue | `unit/avisos.test.tsx:102` «un 42501 con sesión sigue diciendo que no hay acceso, y NO ofrece entrar», `:224` «con getSession colgado, el aviso aparece igual» y `:237` «y cuando responde que no hay sesión, el aviso se afina» |
| 4 | Un servicio pausado despierta solo, sin que nadie pulse | `unit/drenado.test.tsx:176` «DoD 26: trae la lista y retira el aviso sin que nadie pulse» |
| 5 | El aviso distingue la red del usuario del servidor de datos | `e2e/sin-red.spec.ts:202` «DoD 1 y 2: el aviso distingue tu red del servidor de datos» |
| 6 | La cola sin red entera: apuntar y que llegue al volver, seis seguidas sin duplicar, sobrevivir a cerrar la app, y caducar a las 24 h | `e2e/sin-red.spec.ts:75`, `:109`, `:133` y `:287` |
| 7 | Tras drenar no queda aviso mintiendo, y tras desmontar no hay más llamadas | `unit/drenado.test.tsx:589` «DoD 13: tras drenar no queda aviso mintiendo en pantalla» y `:620` «DoD 15: tras desmontar, el reintento no sigue llamando» |

## Requisitos

**R1 — Cada generación sella una sola cosa.**
*Mecanismo:* `secuencia` se divide en `secuenciaAviso` —avisos y afinado por
sesión, que son la misma conversación con el usuario— y `recuperacion` —el
reintento de carga—. `envio` se queda como está.
*Rojo si se revierte:* el ítem 1.

**R2 — `avisar` sigue arrancando la recuperación, pero sellada aparte.** Decisión
del usuario: mantener el arranque automático. Que cada uno de los cinco sitios
decida es el desacople más puro y también la forma exacta en que nació I1 —
olvidarse en uno.
*Mecanismo:* `avisar` lanza `reintentar` sellado por `recuperacion`, no por la
generación de avisos.
*Rojo si se revierte:* los ítems 1 y 2.

**R3 — Un solo origen para el aviso visible.** Decisión del usuario: colapsar las
dos capas. Hoy `avisoVisible` es el estado `notice` **o** uno derivado de
`loadClase` mientras `resueltaPara` no lo cancele; de esa doble fuente salió la
deuda 40.
*Mecanismo:* la clase que trae el servidor se convierte en un aviso normal, y
`resueltaPara` desaparece. Un cambio de `loadClase` posterior al montaje produce
un aviso nuevo; que no cambie no lo repone.
*Rojo si se revierte:* el ítem 3.

**R4 — La prop se lee viva en todos los sitios, no en uno.**
*Mecanismo:* el mismo que el arreglo de la 34 usó en el drenado, aplicado al
resto: dependencias correctas, o una ref viva donde se lea dentro de un manejador
asíncrono.
*Rojo si se revierte:* el ítem 4.

**R5 — El refinado por red se aplica a los cuatro caminos, no a uno.** Deuda 43:
`sinRedVivo` sólo lo usa la rama de la cola; la edición y el borrado siguen
diciendo «el servicio está despertando» a quien acaba de quedarse sin conexión.
*Mecanismo:* `avisar` refina con la red viva.
*Rojo si se revierte:* los ítems 5 y 6, uno por camino.

**R6 — El aviso se retira después de saber, no antes.** Deuda 40: la limpieza va
antes de la relectura, así que una relectura fallida puede dejar la pantalla sin
ninguna señal.
*Mecanismo:* invertir el orden; la limpieza ocurre en la rama que confirmó.
*Rojo si se revierte:* el ítem 7, que cubre el hueco por el que la prueba actual
pasa verde (deuda 45).

## Restricción de orden

**R1 y R2 tienen que llegar juntos, y en el mismo cambio.** Razonado sobre el
código, no supuesto:

- R1 sin R2: `avisar` seguiría lanzando el reintento con la generación de avisos,
  que ya no sella el reintento — el bucle quedaría sin quien lo mate, o muerto a
  destiempo.
- R2 sin R1: el reintento seguiría sellado por la generación de avisos, así que
  limpiar un aviso lo mataría. **Es exactamente la regresión I1.**

Cada mitad por separado deja el sistema peor que hoy. R3 a R6 sí pueden llegar
después, cada una por su cuenta.

## Casos borde

| # | Caso | Qué pasa | Cómo se comprueba |
|---|---|---|---|
| 1 | Limpiar un aviso con un reintento de carga en vuelo | El reintento sobrevive | Ítem 1 |
| 2 | `loadClase` cambia tras el montaje | Produce un aviso nuevo | Ítem 4 |
| 3 | `loadClase` sigue igual tras retirar el aviso | No lo repone | Ítem 3 |
| 4 | Relectura fallida con `loadClase` nula | Queda señal en pantalla | Ítem 7 |
| 5 | Red cayendo durante una edición | Se culpa a la red, no al servidor | Ítem 5 |
| 6 | Red cayendo durante un borrado | Ídem | Ítem 6 |
| 7 | Afinado por sesión en vuelo cuando se limpia el aviso | Se cancela, como hoy | Razón escrita: es comportamiento que **no** debe cambiar, fila 3 de la tabla de arriba, y lo fija `unit/avisos.test.tsx:237`. Cubierto por el ítem 8 |
| 8 | Servicio pausado sin que nadie pulse | Despierta solo | Ítem 2 |
| 9 | Desmontar con recuperación en vuelo | No hay más llamadas | Razón escrita: lo cerró el ciclo de la deuda 34 y lo fija `unit/drenado.test.tsx:620`. Cubierto por el ítem 8 |

## Fuera de alcance, por su nombre

Esto es un refactor de mecanismo entrelazado, que es la clase de spec que se
ensancha sola. Lo que **no** entra:

- **`lib/errors.ts`.** El traductor no se toca: clasifica, y eso funciona.
- **Qué dice cada mensaje.** Ni los textos ni las clases cambian.
- **El comportamiento de la cola.** Encolar, drenar, orden, caducidad e
  idempotencia se quedan exactamente como los dejó el ciclo de la deuda 34.
- **La deuda 44** (`setNotice` suelto en el drenado). Hoy es inalcanzable, y lo
  que la haría alcanzable es quitar una guarda que esta spec no toca.
- **La deuda 45** (la prueba del DoD 26, menos específica que su nombre) entra
  **sólo** como la mitad que R6 necesita, no como revisión de la suite.
- **Extraer el mecanismo a un hook o a un módulo propio.** Puede ser la salida
  correcta, pero es una decisión distinta y no se toma desde aquí.
- **Los caminos de edición y borrado**, más allá del refinado por red de R5.

## Definición de Hecho

| # | Comprobación | Capa | Por qué no puede estar verde antes | Rojo si se revierte |
|---|---|---|---|---|
| 1 | Limpiar un aviso no mata un reintento de carga en vuelo | vista | Hoy lo mata: una sola generación sella las tres cosas | Unir las generaciones lo pone rojo |
| 2 | Tras un aviso de servidor, el servicio despierta solo | vista | `[REGRESIÓN]` — verde hoy; es la red de seguridad de R2 | Es lo que caza olvidarse del arranque |
| 3 | Retirado el aviso, un `loadClase` sin cambiar no lo repone | vista | Hoy el derivado reaparece | Reponer la doble capa lo pone rojo |
| 4 | Un `loadClase` que cambia tras el montaje produce aviso | vista | Hoy depende de qué sitio lo lea | Capturarlo al montar lo pone rojo |
| 5 | Red cayendo en una edición: se culpa a la red | vista | Hoy dice «el servicio está despertando» | Quitar el refinado lo pone rojo |
| 6 | Red cayendo en un borrado: se culpa a la red | vista | Ídem | Ídem |
| 7 | Relectura fallida **con `loadClase` nula** deja señal en pantalla | vista | Hoy deja la pantalla muda, y la prueba actual no lo ve porque monta con la prop puesta | Volver a limpiar antes de releer lo pone rojo |
| 8 | Los siete comportamientos de «lo que NO debe cambiar» siguen verdes, con las mismas diez pruebas que los fijan hoy | vista y navegador | `[REGRESIÓN]` — verdes de partida. No son progreso: son la verja del refactor, y si uno se pone rojo el refactor está mal | — |
| 9 | `typecheck && lint && test && build` → EXIT=0 | terminal | `[REGRESIÓN]` | — |

**Primera comprobación en rojo:** el ítem 1.

## Suposiciones bloqueantes

Ninguna. Las tres decisiones de diseño las tomó el usuario antes de escribir:
generación propia con `avisar` lanzando, colapsar a una capa, y `--max-warnings`
en spec aparte y antes que ésta.

## Aviso sobre el alcance

El alcance **sí se deja acotar**, y la medida que lo permite es que el mecanismo
entero vive en un componente y no lo comparte nadie. Si al construir aparece la
necesidad de tocar `lib/errors.ts` o de extraer un hook, eso no es parte de esta
spec: es el hallazgo de que el acotamiento era falso, y vuelve a `/spec`.
