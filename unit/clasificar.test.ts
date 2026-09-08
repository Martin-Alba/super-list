import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { clasificar, claseDe, mensajeDe, haySesionSegun, traducirConSesion, SESION, SIN_ACCESO, DUPLICADO } from '../lib/errors'

/**
 * R1 / DoD 1 — El traductor decidía leyendo el TEXTO del error, y por eso no
 * distinguía "no tienes sesión" de "no tienes acceso": los dos llegan como
 * `permission denied`. El código sí los separa, y `lib/items.ts` lo recibía y lo
 * tiraba.
 *
 * Los códigos de esta tabla están medidos contra la base real, no supuestos.
 */
describe('R1 el traductor decide por código', () => {
  it.each([
    ['PGRST301', 'JWT expired', true, 'sesion'],
    ['PGRST301', 'JWT cryptographic operation failed', true, 'sesion'],
    ['42501', 'permission denied for table items', false, 'sesion'],
    ['42501', 'new row violates row-level security policy for table "items"', true, 'sin-acceso'],
    ['23505', 'duplicate key value violates unique constraint', true, 'duplicado'],
    ['23514', 'violates check constraint "items_name_len"', true, 'texto'],
  ] as const)('%s con sesión=%s → %s', (code, msg, haySesion, esperado) => {
    expect(clasificar(code, msg, haySesion)).toBe(esperado)
  })

  it('sin código, un fallo de red se sigue reconociendo por el texto', () => {
    expect(clasificar(null, 'TypeError: failed to fetch', true)).toBe('red')
  })

  it('lo que no encaja en ninguna clase no se disfraza', () => {
    expect(clasificar('XX999', 'algo raro', true)).toBe('generico')
  })

  // Sonda (§E.2): el mismo código con y sin sesión NO puede dar el mismo mensaje.
  it('42501 dice cosas distintas según haya sesión o no', () => {
    const conSesion = mensajeDe(claseDe({ message: 'permission denied for table items', code: '42501' }, true))
    const sinSesion = mensajeDe(claseDe({ message: 'permission denied for table items', code: '42501' }, false))
    expect(sinSesion).not.toBe(conSesion)
    expect(sinSesion).toBe(SESION)
  })
})

describe('R3/R4 lo que ve el usuario', () => {
  it('nunca ve el texto crudo de la base', () => {
    for (const [raw, code] of [
      ['new row for relation "groups" violates check constraint "groups_name_len"', '23514'],
      ['duplicate key value violates unique constraint "items_nombre_unico"', '23505'],
      ['new row violates row-level security policy for table "items"', '42501'],
    ] as const) {
      const visto = mensajeDe(claseDe({ message: raw, code: code }, true))
      expect(visto).not.toMatch(/violates|constraint|relation |row-level|policy|table "/i)
    }
  })

  it('la sesión caducada se nombra como tal, no como falta de acceso', () => {
    expect(mensajeDe(claseDe({ message: 'JWT expired', code: 'PGRST301' }, true))).toBe(SESION)
    expect(SESION).toMatch(/sesión/i)
    expect(SESION).not.toMatch(/acceso a este grupo/i)
  })

  it('el duplicado tiene su propio mensaje', () => {
    expect(mensajeDe(claseDe({ message: 'duplicate key value', code: '23505' }, true))).toBe(DUPLICADO)
    expect(DUPLICADO).toMatch(/ya est/i)
  })
})

/**
 * S3 / DoD 19, 20 — La base reutiliza `42501` para RLS **y** para el trigger de
 * integridad: verificado en el catálogo, sus cuatro `raise exception` usan ese
 * código. Sin distinguirlos, un rechazo de integridad se anuncia como pérdida de
 * acceso al grupo.
 */
describe('S3 el 42501 del trigger no es el 42501 de RLS', () => {
  it.each([
    'created_by is immutable', 'group_id is immutable', 'created_at is immutable',
    'a deleted item cannot be restored',
  ])('%j es integridad, no falta de acceso', (msg) => {
    expect(clasificar('42501', msg, true)).toBe('integridad')
    expect(mensajeDe(claseDe({ message: msg, code: '42501' }, true))).toBe('Ese cambio no está permitido.')
  })

  it('el 42501 de RLS sigue siendo falta de acceso', () => {
    expect(clasificar('42501', 'new row violates row-level security policy', true)).toBe('sin-acceso')
  })

  it('y sin sesión sigue ganando la sesión', () => {
    expect(clasificar('42501', 'permission denied for table items', false)).toBe('sesion')
  })
})

/**
 * T5 / DoD 35 — Un servicio de auth caído no es una sesión caducada. `getUser()`
 * no lanza: devuelve el usuario a `null` **y** un error, y mirar sólo el usuario
 * acusaba en falso justo del problema que esta spec vino a arreglar.
 */
describe('T5 el auth caído no se confunde con la sesión caducada', () => {
  const authError = (nombre: string, mensaje: string) => Object.assign(new Error(mensaje), { name: nombre })

  it.each([
    ['usuario presente, sin error', { id: 'u1' }, null, true],
    ['sin usuario, sin error', null, null, false],
    // Medido contra el stack real: es lo que devuelve `getUser()` sin sesión
    // guardada, y ni siquiera llega a la red.
    ['sin sesión guardada', null, authError('AuthSessionMissingError', 'Auth session missing!'), false],
    ['servicio de auth caído', null, authError('AuthRetryableFetchError', 'Failed to fetch'), true],
    ['cota agotada', null, authError('AuthRetryableFetchError', 'AbortError'), true],
    ['error inesperado', null, authError('AuthApiError', 'Internal Server Error'), true],
  ])('%s → hay sesión: %s', (_n, usuario, error, esperado) => {
    expect(haySesionSegun(usuario, error)).toBe(esperado)
  })

  it('el traductor usa esta regla y no `!!user` a pelo', () => {
    const fuente = readFileSync('lib/errors.ts', 'utf8')
    expect(fuente).toMatch(/haySesionSegun\(data\.user, eAuth\)/)
    expect(fuente, 'volvió a mirar sólo el usuario').not.toMatch(/haySesion = !!data\.user/)
  })
})

/**
 * U5 / DoD 49 — Sin cota propia, cada `42501` de una acción de servidor arrastra
 * al usuario hasta los 10 s de `boundedFetch`: es el defecto de S4 —esperar a una
 * consulta de sesión mirando una pantalla muda— trasladado al servidor, donde no
 * hay ninguna carrera que lo rescate.
 */
describe('U5 la sonda de sesión del traductor va acotada', () => {
  it('con la sonda colgada, responde dentro de la cota', async () => {
    const inicio = Date.now()
    const r = await traducirConSesion(
      { message: 'permission denied for table items', code: '42501' },
      () => new Promise(() => {}), 80)
    expect(Date.now() - inicio, 'se quedó esperando a la sonda').toBeLessThan(1_500)
    expect(r.mensaje, 'ante la duda no se acusa de sesión caducada').toBe(SIN_ACCESO)
  })

  it('si la sonda responde a tiempo, se usa su respuesta', async () => {
    const r = await traducirConSesion(
      { message: 'permission denied for table items', code: '42501' },
      async () => ({ data: { user: null }, error: null }), 500)
    expect(r.mensaje).toBe(SESION)
  })

  it('un error que no es 42501 no consulta la sesión siquiera', async () => {
    let consultada = false
    const r = await traducirConSesion({ message: 'duplicate key', code: '23505' },
      async () => { consultada = true; return { data: { user: null }, error: null } })
    expect(consultada, 'consultó la sesión para un error que no la necesita').toBe(false)
    expect(r.clase).toBe('duplicado')
  })
})

/**
 * W4 / DoD 66 — El `clearTimeout` de V8 no lo vigilaba nadie: quitarlo dejaba la
 * suite entera verde. Un temporizador pendiente por cada `42501` mantiene viva
 * una invocación sin servidor.
 */
describe('W4 el traductor del servidor no deja temporizadores pendientes', () => {
  it('tras varias traducciones no queda ninguno', async () => {
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 5; i++) {
        await traducirConSesion({ message: 'permission denied for table items', code: '42501' },
          async () => ({ data: { user: { id: 'u' } }, error: null }), 2_000)
      }
      expect(vi.getTimerCount(), 'un temporizador por cada 42501 traducido').toBe(0)
    } finally { vi.useRealTimers() }
  })
})
