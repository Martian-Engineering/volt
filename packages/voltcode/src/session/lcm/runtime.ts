import { Log } from "@/util/log"
import { LcmDb } from "./db"
import { ensureEmbeddedPostgresRunning, isEmbeddedPostgresSupported } from "./embedded-postgres"
import { LCM_EXTERNAL_DATABASE } from "./config"

const log = Log.create({ service: "lcm.runtime" })

let ready = false
let initPromise: Promise<boolean> | null = null

export function isLcmReady() {
  return ready
}

export async function ensureLcmReady(): Promise<boolean> {
  if (ready) return true
  if (!initPromise) {
    initPromise = (async () => {
      // When using external database, skip embedded postgres setup
      if (LCM_EXTERNAL_DATABASE) {
        log.info("using external database for LCM")
        await LcmDb.initialize()
        ready = true
        return true
      }

      // Local development: use embedded postgres
      if (!isEmbeddedPostgresSupported()) {
        log.warn("LCM unavailable: embedded postgres unsupported on platform")
        return false
      }
      const running = await ensureEmbeddedPostgresRunning()
      if (!running) return false
      await LcmDb.initialize()
      ready = true
      return true
    })()
      .catch((e) => {
        log.error("failed to initialize LCM", {
          error: e,
          platform: process.platform,
          arch: process.arch,
        })
        throw e
      })
      .finally(() => {
        if (!ready) initPromise = null
      })
  }
  return initPromise
}
