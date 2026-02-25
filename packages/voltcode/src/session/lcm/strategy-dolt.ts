import { LcmContext } from "./context"
import { LcmDb } from "./db"
import { LcmRetrievalFacade } from "./retrieval-facade"
import type { LcmRuntimeStrategy } from "./strategy"

/**
 * Build the Dolt runtime strategy adapter from the current active LCM path.
 *
 * This intentionally routes through LcmContext's production handlers so Dolt
 * behavior remains identical while living behind the strategy interface.
 */
export function createDoltRuntimeStrategy(): LcmRuntimeStrategy {
  return {
    name: "dolt",
    compactOnThreshold: (input) => LcmContext.onContextThresholdReached(input),
    compactManual: (input) => LcmContext.compactShortBindle(input),
    assembleContext: (conversationId) => LcmDb.getCurrentContext(conversationId),
    resolveRetrieval: (input) => LcmRetrievalFacade.resolveOffContextRetrieval(input, "dolt"),
  }
}
