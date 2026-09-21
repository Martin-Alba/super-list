import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createUser, signedInContext, makeGroup } from './fixtures'

/**
 * Spec I — **API de auth colgada con el servidor vivo, recorrido de verdad.**
 *
 * Es el escenario que motivó la spec: el sitio responde y la base no contesta. Antes acababa en el
 * login tras agotar la cota, porque el `status 0` que desvía necesita 25–31 s de reintentos y la
 * cota cortaba a los 12.
 *
 * **Dos formas de montarlo que NO funcionan, medidas, porque la siguiente persona las intentará:**
 *
 * 1. `ctx.route('**\/auth/v1/**')` — intercepta al **navegador**, y la guarda corre en el
 *    **servidor**: su `getUser()` sale de Next a Supabase sin pasar por la pestaña.
 * 2. Levantar un `next start` con `NEXT_PUBLIC_SUPABASE_URL` apuntando a un agujero negro — Next
 *    **inlinea** las `NEXT_PUBLIC_*` en el build, también en código de servidor, así que la variable
 *    no hace nada. Medido: el segundo servidor llegó al grupo en 107 ms hablando con la base real.
 *
 * Lo que sí lo monta: **pausar el contenedor de auth**. `docker pause` congela el proceso, así que
 * Kong acepta la conexión y no llega respuesta — que es lo que hace un proyecto dormido, no uno
 * caído. Todo lo demás sigue en pie.
 */
const AUTH = 'supabase_auth_super'
const docker = (accion: 'pause' | 'unpause') => {
  try { execFileSync('docker', [accion, AUTH], { stdio: 'ignore' }) } catch { /* ya estaba así */ }
}

/**
 * **Devolver el contenedor no basta: hay que esperar a que vuelva a estar sano.** Tras un `unpause`
 * el chequeo de salud de Docker tarda en ponerse al día, y este fichero corre antes que los demás
 * por orden alfabético — dejar la API a medio despertar es dejarle el escenario roto al siguiente,
 * que es la cicatriz que este proyecto ya pagó cuatro veces con sondas que envenenaban a sus
 * vecinas. Se espera a verlo, no un tiempo fijo.
 */
const esperarAuthSana = async () => {
  for (let i = 0; i < 60; i++) {
    const estado = execFileSync('docker', ['ps', '--format', '{{.Status}}', '--filter', `name=${AUTH}`],
      { encoding: 'utf8' }).trim()
    if (estado.includes('healthy') && !estado.includes('unhealthy')) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('la API de auth no volvió a estar sana tras el unpause')
}

// Red de seguridad: si el caso muere a mitad, el contenedor no se queda congelado para el resto de
// la suite. Es la cicatriz de la sonda que dejó un cerrojo tomado y puso rojas a siete filas ajenas.
test.afterAll(async () => { docker('unpause'); await esperarAuthSana() })

test('Spec I: con la API de auth colgada, entrar en un grupo lleva a la cáscara en segundos',
  async ({ browser }) => {
    test.setTimeout(120_000)
    const owner = await createUser('api-colgada')
    const { groupId } = await makeGroup(owner, 'Familia Alba')
    const ctx = await signedInContext(browser, owner)
    const page = await ctx.newPage()

    try {
      docker('pause')
      const t = Date.now()
      await page.goto(`/g/${groupId}`)
      const ms = Date.now() - t

      expect(new URL(page.url()).pathname,
        'acabó en el login: quien tiene sesión se queda fuera de su propia lista').toBe('/sin-conexion')
      await expect(page.getByTestId('sin-red'), 'no se pintó la cáscara').toBeVisible()
      /**
       * «En segundos, no en 25». Margen generoso porque la navegación y el render entran en la
       * cuenta, pero deja fuera el comportamiento anterior, que necesitaba 25 s sólo para el
       * veredicto y encima terminaba en el login.
       */
      expect(ms, `tardó ${ms} ms en llegar a la cáscara`).toBeLessThan(15_000)

      // Y el destino se conserva, que es lo que permite volver al grupo cuando la base despierte.
      expect(new URL(page.url()).searchParams.get('next'),
        'se perdió el destino: al volver la red no se sabe a dónde ir').toBe(`/g/${groupId}`)

      /**
       * j5 — **El punto de entrada de la app instalada.** `start_url` del manifiesto es `/`, y antes
       * de i1-R8 tardaba **15.022 ms** en blanco con la API colgada para acabar pintando la portada
       * de invitado a alguien con sesión: la portada es pública, así que el proxy la dejaba pasar, y
       * el `getUser()` de su render pagaba los 10 s de `NETWORK_TIMEOUT_MS` encima de la cota.
       * Medido con `supabase_auth_super` pausado y los otros diez contenedores arriba.
       */
      const t2 = Date.now()
      await page.goto('/')
      const ms2 = Date.now() - t2
      expect(new URL(page.url()).pathname,
        'la portada se quedó esperando: 15 s en blanco al abrir la app instalada').toBe('/sin-conexion')
      expect(ms2, `la portada tardó ${ms2} ms`).toBeLessThan(10_000)

    } finally {
      docker('unpause')
      await esperarAuthSana()
      await ctx.close()
    }
  })
