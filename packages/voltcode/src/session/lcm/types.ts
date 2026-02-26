/**
 * Escape-hatch metadata used by tools that return content already stored in LCM.
 * The processor checks this to avoid re-storing tool output back into LCM.
 */
export interface LcmToolMetadata {
  storedInLcm: boolean
  fileId: string
  originalTokenCount?: number
}
