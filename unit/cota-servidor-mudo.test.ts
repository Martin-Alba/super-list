import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:net'
import { createClient } from '@supabase/supabase-js'

/**
 * Spec I / I-R3 — **El caso real, no un doble que devuelve el error ya formado.**
 *
 * `unit/guarda-sesion.test.ts` dobla `@supabase/ssr` entero: sus casos entregan `AuthRetryableFetch`
 * con `status 0` ya construido, así que prueban qué hace la guarda **con** esa señal. Lo que no
 * prueban es que la señal llegue: que un servidor que acepta la conexión y no contesta jamás —que es
 * lo que hace un proyecto dormido— acabe en la cáscara dentro de la cota.
 *
 * Esa diferencia es la que esta spec paga: con la cota anterior **no llegaba**. El bucle de
 * reintentos de `getUser` necesita 25–31 s para concluir con `status 0`, la cota cortaba a los 12, y
 * el destino era el login. Un doble no podía enseñarlo porque el doble ya traía el `status 0` hecho.
 *
 * Así que aquí no hay dobles: cliente real de `@supabase/ssr` —el que monta `updateSession`— contra
 * un `net.Server` que acepta y calla.
 *
 * **Lo que hace construible el escenario**, medido: `@supabase/ssr` deriva el nombre de la cookie del
 * **host**, no del puerto — para `127.0.0.1` es `sb-127-auth-token`. Así que una sesión emitida por
 * la instancia local viaja tal cual a un agujero negro en otro puerto del mismo host.
 */
const URL_REAL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SECRET = process.env.SUPABASE_SECRET_KEY!

let agujero: Server | undefined
afterAll(() => { agujero?.close() })

describe('Spec I / I-R3 · un servidor que acepta y no contesta acaba en la cáscara', () => {
  it('i2 · con la sesión puesta y el servidor mudo, la guarda desvía a /sin-conexion', async () => {
    const admin = createClient(URL_REAL, SECRET, { auth: { persistSession: false } })
    const correo = `mudo-${Date.now()}@example.test`
    const { error } = await admin.auth.admin.createUser({
      email: correo, password: 'test-password-1234', email_confirm: true,
    })
    if (error) throw error

    // Sesión real, emitida por la instancia real.
    const cli = createClient(URL_REAL, ANON, { auth: { persistSession: false } })
    const { data: s } = await cli.auth.signInWithPassword({ email: correo, password: 'test-password-1234' })
    const cookie = JSON.stringify({
      access_token: s.session!.access_token, refresh_token: s.session!.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) - 60,   // caducado: obliga a salir a la red
      token_type: 'bearer', user: s.session!.user,
    })

    agujero = createServer(() => { /* acepta y no contesta jamás */ })
    await new Promise<void>(ok => agujero!.listen(0, '127.0.0.1', () => ok()))
    const puerto = (agujero!.address() as { port: number }).port

    const antes = process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${puerto}`
    try {
      const { updateSession } = await import('@/lib/supabase/middleware')
      const { NextRequest } = await import('next/server')
      const req = new NextRequest(new URL('http://localhost:3000/g/abc'))
      req.cookies.set('sb-127-auth-token', `base64-${Buffer.from(cookie).toString('base64')}`)

      const t = Date.now()
      const res = await updateSession(req)
      const ms = Date.now() - t

      expect(res.status, 'no redirigió').toBeGreaterThanOrEqual(300)
      expect(new URL(res.headers.get('location')!).pathname,
        'un servidor mudo acabó en el login: quien tiene sesión se queda fuera de su lista')
        .toBe('/sin-conexion')
      /**
       * Y **dentro de la cota**, que es la mitad que la spec paga: antes esto tardaba 25–31 s y
       * terminaba mal. El margen generoso es a propósito — lo que se afirma es el orden de magnitud,
       * no el número, para que la fila no se vuelva frágil en una máquina cargada.
       */
      expect(ms, `tardó ${ms} ms: la cota no está acotando`).toBeLessThan(8_000)
    } finally {
      /**
       * **No se borra el usuario de prueba, y no es descuido.** `auth.users` cascadea a `profiles` y
       * de ahí a `group_members`, que está publicada en `supabase_realtime`: borrarlo sería un
       * borrado físico sobre una tabla publicada, que es hard fail de la constitución. Lo cazó
       * `unit/harness-no-delete.test.ts`. Los usuarios de prueba se acumulan, como en todo el resto
       * del arnés — `newUser` tampoco borra.
       */
      process.env.NEXT_PUBLIC_SUPABASE_URL = antes
    }
  }, 30_000)

  it('i1 · y la cáscara se sirve sin preguntarle nada al servidor mudo', async () => {
    /**
     * I-R1 — La misma sesión y el mismo agujero negro que el caso de arriba, pero pidiendo
     * `/sin-conexion`. Si la guarda preguntara, esto tardaría la cota entera; como no pregunta,
     * vuelve al instante y sin redirigir.
     *
     * **La primera versión de esta fila no podía fallar**, y conviene que quede escrito porque es el
     * modo de fallo que este proyecto lleva medio ciclo persiguiendo: apuntaba a un puerto muerto
     * **sin poner cookie de sesión**, y `getUser()` sin sesión no sale a la red en absoluto — así que
     * daba verde con I-R1 revertido, 3 de 3. Lo que la hace discriminante es la sesión, no el
     * servidor.
     */
    const admin = createClient(URL_REAL, SECRET, { auth: { persistSession: false } })
    const correo = `mudo2-${Date.now()}@example.test`
    const { error } = await admin.auth.admin.createUser({
      email: correo, password: 'test-password-1234', email_confirm: true,
    })
    if (error) throw error
    const cli = createClient(URL_REAL, ANON, { auth: { persistSession: false } })
    const { data: s } = await cli.auth.signInWithPassword({ email: correo, password: 'test-password-1234' })
    const cookie = JSON.stringify({
      access_token: s.session!.access_token, refresh_token: s.session!.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) - 60,
      token_type: 'bearer', user: s.session!.user,
    })

    const mudo = createServer(() => {})
    await new Promise<void>(ok => mudo.listen(0, '127.0.0.1', () => ok()))
    const puerto = (mudo.address() as { port: number }).port

    const { updateSession } = await import('@/lib/supabase/middleware')
    const { NextRequest } = await import('next/server')
    const antes = process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${puerto}`
    try {
      const req = new NextRequest(new URL('http://localhost:3000/sin-conexion'))
      req.cookies.set('sb-127-auth-token', `base64-${Buffer.from(cookie).toString('base64')}`)
      const t = Date.now()
      const res = await updateSession(req)
      const ms = Date.now() - t
      expect(res.status, 'la cáscara redirigió a alguna parte').toBeLessThan(300)
      expect(ms, `la cáscara tardó ${ms} ms: alguien le preguntó a la base`).toBeLessThan(500)
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = antes
      mudo.close()
    }
  }, 30_000)
})
