import { defineConfig } from '@playwright/test'
import { config } from 'dotenv'
import { appOrigin, appHostname, appPort, esOrigenLocal } from './e2e/appOrigin'

/**
 * X7 — Con `E2E_BASE_URL` apuntando a un despliegue —el caso que motivó arreglar
 * `appPort()`— Playwright seguía lanzando `next start` en local contra ese host
 * y puerto. Si el origen no es local, no hay servidor que levantar.
 */
const esLocal = esOrigenLocal()

config({ path: '.env.local', quiet: true })

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: appOrigin(),
    // R13 — todo el recorrido se prueba a 390 px, no a ancho de escritorio.
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    trace: 'retain-on-failure',
  },
  webServer: !esLocal ? undefined : {
    // W4 — antes era `pnpm start` a secas, que liga siempre `localhost:3000`:
    // mover `E2E_BASE_URL` movía los tests y no el servidor.
    command: `pnpm exec next start --hostname ${appHostname()} --port ${appPort()}`,
    url: appOrigin(),
    // S5 — reusar a ciegas hizo que una revisión midiera un `.next` ya borrado y
    // diera 8 rojos fantasma: la cicatriz del bundle mutado. El "servidor frío"
    // que el runtime check declara sólo es cierto si el arnés lo garantiza.
    reuseExistingServer: process.env.E2E_REUSE === '1',
    timeout: 180_000,
  },
})
