export * from "./client.js"
export * from "./server.js"

import { createVoltcodeClient } from "./client.js"
import { createVoltcodeServer } from "./server.js"
import type { ServerOptions } from "./server.js"

export async function createVoltcode(options?: ServerOptions) {
  const server = await createVoltcodeServer({
    ...options,
  })

  const client = createVoltcodeClient({
    baseUrl: server.url,
  })

  return {
    client,
    server,
  }
}

export async function createOpencode(options?: ServerOptions) {
  return createVoltcode(options)
}
