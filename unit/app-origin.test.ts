import { describe, it, expect, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { sinComentarios } from './comentarios'
import { appOrigin, appHostname, appPort, DEFECTO, esHostLocal } from '../e2e/appOrigin'

/**
 * V1 / DoD 45 — El origen se congelaba al importar el módulo, así que la
 * variable que un test fija dentro del `it` no llegaba. La aserción de
 * `unit/global-setup.test.ts` era inerte: pasaba porque no había servidor en
 * `localhost:3000`, no porque el puerto que fijaba estuviera muerto.
 */
describe('V1 el origen se lee cuando se usa', () => {
  afterEach(() => { delete process.env.E2E_BASE_URL })

  it('refleja lo que se fija DESPUÉS de importar el módulo', () => {
    expect(appOrigin()).toBe(DEFECTO)
    process.env.E2E_BASE_URL = 'http://127.0.0.1:9'
    expect(appOrigin(), 'el valor quedó congelado en el import').toBe('http://127.0.0.1:9')
    expect(appHostname()).toBe('127.0.0.1')
    expect(appPort()).toBe(9)
  })

  // Sonda (§E.2): sin esto, lo de arriba no distingue "lee tarde" de "siempre
  // devuelve lo que le pidas".
  it('sin variable vuelve al valor por defecto, no al último fijado', () => {
    process.env.E2E_BASE_URL = 'http://otro.test:1234'
    expect(appOrigin()).toBe('http://otro.test:1234')
    delete process.env.E2E_BASE_URL
    expect(appOrigin()).toBe(DEFECTO)
  })
})

/**
 * V9 / DoD 55 — El comentario del módulo afirma que el origen vive en un solo
 * sitio. Sin esta guarda era falso: quedaban doce literales.
 */
/**
 * AA11 — La guarda, extraída para que su sonda pueda ejercitarla en vez de
 * reimplementar el regex al lado (§E.3).
 */
export function exigirOrigenDerivado(fuente: string): void {
  const codigo = sinComentarios(fuente)
  if (/http:\/\/localhost:3000/.test(codigo)) throw new Error('literal del origen fijado a mano')
  if (/['"`]localhost:3000['"`]/.test(codigo)) throw new Error("literal 'host:puerto' fijado a mano")
  if (/domain:\s*'localhost'/.test(codigo)) throw new Error("domain: 'localhost' fijado a mano")
}

describe('V9 el origen no está fijado a mano en ningún otro sitio', () => {
  const FICHEROS = ['playwright.config.ts', ...readdirSync('e2e')
    .filter(f => f.endsWith('.ts') && f !== 'appOrigin.ts')
    .map(f => `e2e/${f}`)]

  it('hay ficheros que revisar', () => {
    expect(FICHEROS.length, 'el conjunto está vacío: la guarda no mira nada').toBeGreaterThan(5)
  })

  it.each(FICHEROS)('%s no fija el origen a mano', (f) => {
    expect(() => exigirOrigenDerivado(readFileSync(f, 'utf8'))).not.toThrow()
    const fuente = sinComentarios(readFileSync(f, 'utf8'))
    expect(fuente, 'literal del origen fuera de appOrigin.ts').not.toMatch(/http:\/\/localhost:3000/)
    // W4 — el patrón anterior exigía el esquema, así que no veía `'localhost:3000'`
    // suelto, y quedaban dos en `callback.spec.ts`. El comentario de appOrigin.ts
    // decía "es la única fuente" y era falso.
    expect(fuente, "literal 'host:puerto' de la app fijado a mano").not.toMatch(/['\"`]localhost:3000['\"`]/)
    expect(fuente, "domain: 'localhost' fijado a mano").not.toMatch(/domain:\s*'localhost'/)
  })

  // AA11 — antes esto afirmaba que un regex casaba una cadena: una tautología
  // que habría pasado con la guarda borrada. Ahora corre **la guarda**.
  it.each([
    "await page.goto('http://localhost:3000/g/1')",
    "expect(h).toBe('localhost:3000')",
    "const c = { domain: 'localhost', path: '/' }",
  ])('la guarda lanza sobre %j', (muestra) => {
    expect(() => exigirOrigenDerivado(muestra)).toThrow(/fijado a mano/)
  })

  // Sonda de la sonda: un literal en un comentario NO es una infracción, pero
  // uno en código sí. Sin esto, `sinComentarios` podría vaciarlo todo y la
  // guarda quedaría siempre verde.
  it.each([
    ['// antes ligaba `localhost:3000` siempre', false],
    ['/* liga `localhost:3000` */ const x = 1', false],
    ["const h = 'localhost:3000'", true],
    // X3 — los tres casos que la revisión midió como ciegos: una cadena que
    // contiene `//` o `/*` NO abre un comentario, y lo que venga detrás sigue
    // siendo código.
    ["const a = ['//protocol-relative'].concat(['localhost:3000'])", true],
    ['const a = ["/*"], b = \'localhost:3000\'', true],
    ["const u = 'http://x' // y aquí sí es comentario: 'localhost:3000'", false],
  ])('%j ¿infringe? %s', (muestra, infringe) => {
    expect(/['\"`]localhost:3000['\"`]/.test(sinComentarios(muestra))).toBe(infringe)
  })
})

/** DoD 47 — la configuración de Playwright bebe de la misma fuente. */
describe('V1 la configuración de Playwright deriva del mismo origen', () => {
  const CONFIG = readFileSync('playwright.config.ts', 'utf8')

  it('baseURL y webServer.url salen de appOrigin()', () => {
    expect(CONFIG).toMatch(/baseURL:\s*appOrigin\(\)/)
    expect(CONFIG).toMatch(/url:\s*appOrigin\(\)/)
  })

  // W4 / DoD 63 — sin esto, mover `E2E_BASE_URL` cambiaba los tests y dejaba el
  // servidor ligando el puerto de siempre: la variable mentía.
  it('el comando del servidor recibe host y puerto del mismo origen', () => {
    expect(CONFIG, 'webServer.command no propaga el host/puerto de appOrigin()')
      .toMatch(/--hostname \$\{|--port \$\{/)
  })

  it('la guarda caza una configuración con el origen fijado', () => {
    expect("baseURL: 'http://localhost:3000',").not.toMatch(/baseURL:\s*appOrigin\(\)/)
  })
})

/**
 * Z6 / DoD 89 — `esHostLocal` es la parada en seco que impide que el arnés cree
 * una cuenta permanente y un grupo dentro de un proyecto hospedado, y no tenía
 * ni una prueba: ni de que admita las formas locales reales, ni —lo que de
 * verdad importa— de que **rechace** un host remoto. Una guarda sin sonda no se
 * distingue de una que devuelve siempre lo mismo (§E.2).
 */
describe('Z6 la parada en seco distingue local de hospedado', () => {
  it.each(['localhost', '127.0.0.1', '127.5.0.1', '0.0.0.0', '::1', '[::1]', 'LOCALHOST'])(
    'admite %j', (host) => {
      expect(esHostLocal(host), `${host} es local y se rechazó`).toBe(true)
    })

  it.each([
    'db.abcdefgh.supabase.co',
    'aws-0-eu-west-1.pooler.supabase.com',
    'localhost.evil.com',
    'evil.com',
    '10.0.0.1',
    '192.168.1.10',
    '127.0.0.1.evil.com',
    '',
  ])('rechaza %j', (host) => {
    expect(esHostLocal(host), `${host} NO es local y se admitió: el banco se montaría fuera`).toBe(false)
  })
})
