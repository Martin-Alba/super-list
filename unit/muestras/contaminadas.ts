/**
 * Z3 — Un solo banco para las dos guardas de contaminación. Compartían el motor
 * (X2) y no la cobertura: cinco formas que la del arnés cazaba se le colaban a la
 * de la página, y tres se les colaban a las dos. Un banco compartido hace que la
 * asimetría no pueda volver: cualquiera que se añada la corren ambas.
 *
 * `{E}` es donde va la expresión que sale — `return { error: {E} }` en un caso,
 * `loadError={{E}}` en el otro.
 */
export const FORMAS_CONTAMINADAS: ReadonlyArray<readonly [string, string, string]> = [
  ['directa', '', 'error'],
  ['mensaje', '', 'error.message'],
  ['plantilla', '', '`${error}`'],
  ['ternario', '', 'error ? error : null'],
  ['coalescencia', '', 'error ?? null'],
  ['String()', '', 'String(error)'],
  ['toString', '', 'error.toString()'],
  ['concatenación', '', '"x" + error'],
  ['variable intermedia', 'const a1 = error;', 'a1'],
  ['cadena de variables', 'const b1 = error; const b2 = b1;', 'b2'],
  ['desestructurado con alias', 'const { error: c1 } = p;', 'c1'],
  ['capturado', 'let d1; try { f() } catch (e) { d1 = e }', 'd1'],
  ['asignado después', 'let e1; e1 = error;', 'e1'],
  ['Object.assign', 'const f1 = {}; Object.assign(f1, error);', 'f1'],
  ['getter', 'const g1 = { get e() { return error } };', 'g1.e'],
  ['destructuring de array', 'const [h1] = [error];', 'h1'],
  ['for...of', 'let i1; for (const x of [error]) { i1 = x }', 'i1'],
  ['campo de clase', 'class J1 { e = error }; const j1 = new J1();', 'j1.e'],
  ['parámetro por defecto', 'function k1(e = error) { return e }', 'k1()'],
  ['función declarada', 'function l1() { return error }', 'l1()'],
  ['función flecha', 'const m1 = () => error;', 'm1()'],
  ['asignación a propiedad', 'const n1 = {}; n1.e = error;', 'n1.e'],
  ['método de clase', 'class O1 { e() { return error } }; const o1 = new O1();', 'o1.e()'],
  ['push a un array', 'const p1 = []; p1.push(error);', 'p1[0]'],
  ['método de literal', 'const q1 = { e() { return error } };', 'q1.e()'],
  // AA2 — las cinco que se colaban a LAS DOS guardas. La IIFE la nombraba Z3 y
  // no llegó a sembrarse: nombrar una forma no la prueba.
  ['IIFE', '', '(() => error)()'],
  ['IIFE con cuerpo', '', '(() => { return error })()'],
  ['callback en línea', 'const r1 = ((g) => g())(() => error);', 'r1'],
  ['valor por defecto al desestructurar', 'const { z1 = error } = p;', 'z1'],
  ['generador', 'function* y1() { yield error }', '[...y1()][0]'],
  // AB6 — ocho formas que el arnés cazaba y a la página se le colaban: la
  // asimetría volvió por el otro lado. Con el banco compartido, cualquiera que se
  // añada la corren las dos.
  ['tagged template', 'const t1 = (s, ...v) => v[0]; const r2 = t1`${error}`;', 'r2'],
  ['getter de clase', 'class S1 { get e() { return error } }; const s1 = new S1();', 's1.e'],
  ['desestructuración a propiedad', 'const u1 = {}; ({ a: u1.a } = { a: error });', 'u1.a'],
  ['desestructuración de array a variable', 'let v1; [v1] = [error];', 'v1'],
  ['defineProperty', 'const w1 = {}; Object.defineProperty(w1, "e", { value: error });', 'w1.e'],
  ['callback de forEach', 'let x1; [error].forEach(v => { x1 = v });', 'x1'],
  ['generador atado a const', 'const y2 = function* () { yield error };', '[...y2()][0]'],
  ['método generador', 'const z2 = { *g() { yield error } };', '[...z2.g()][0]'],
  // AC5 / DoD 106 — cadena de alias declarada HACIA ATRÁS. El punto fijo era un
  // número mágico (`i < 3`), así que a partir del cuarto eslabón la guarda se
  // quedaba fuera y bastaba mover un `const a = b` de sitio para apagarla.
  ['cadena de 6 alias hacia atrás',
    'const k6 = k5; const k5 = k4; const k4 = k3; const k3 = k2; const k2 = k1; const k1 = error;', 'k6'],
  // AC6 / DoD 107 — las tres formas de generador que AB4 dejó fuera: el `yield`
  // sólo subía a una función declarada, a un método y a una atada por `const`.
  ['generador en propiedad de literal', 'const o1 = { g: function* () { yield error } };', '[...o1.g()][0]'],
  ['generador asignado a propiedad', 'const o2: any = {}; o2.g = function* () { yield error };', '[...o2.g()][0]'],
  ['generador asignado a variable', 'let g3: any; g3 = function* () { yield error };', '[...g3()][0]'],
]

/**
 * AC9 — La mitad negativa. Invertir la regla por defecto (AC2) —todo lo
 * contaminado es fuga salvo tres consumos— sólo es una mejora si se demuestra
 * que la guarda no marca **todo**. Sin este banco no se distingue «detecta» de
 * «detecta todo», y una guarda que dice que sí a cualquier cosa es tan inútil
 * como la que decía que no.
 *
 * Mismo formato y mismas dos puertas que `FORMAS_CONTAMINADAS`.
 */
export const FORMAS_LIMPIAS: ReadonlyArray<readonly [string, string, string]> = [
  ['texto fijo', '', "'sin novedad'"],
  ['traducido', '', 'claseDe(error)'],
  ['traducido a través de una variable', 'const t1 = claseDe(error);', 't1'],
  ['variable con literal', "const l1 = 'x';", 'l1'],
  ['ternario entre literales', '', "error ? 'sí' : 'no'"],
  ['función que devuelve un literal', "function lim() { return 'x' }", 'lim()'],
  ['dato ajeno con el mismo campo', "const otro = { message: 'y' };", 'otro.message'],
  ['objeto de literales', '', "{ a: 1 } as unknown as string"],
  // AD8 — Estas tres apuntan a una exención cada una: si se quita la que las
  // deja pasar, la fila se pone roja. Sin ellas el banco negativo era verde
  // pasara lo que pasara, que es la misma tautología por el lado limpio.
  ['(a) consumido por el traductor anidado', '', 'claseDe(error)'],
  ['(b) sólo se mira su verdad', "let n1 = 0; if (error) { n1 = 1 }", "String(n1)"],
  ['(c) atado a un nombre que no sale', 'const a9 = error; const b9 = a9 ? 1 : 2;', 'String(b9)'],
]
