/**
 * Large File Threshold Detection Module
 *
 * This module provides utilities for detecting when a file is too large
 * to include directly in the conversation context and should instead be
 * stored as a large file in the database.
 *
 * When a large file is detected:
 * 1. The file content is stored in PostgreSQL (via LcmDb.insertLargeFile)
 * 2. A compact marker with the file ID is placed in context instead
 * 3. The model can retrieve file content via tools using the file ID
 *
 * Token estimation uses a simple heuristic of ~4 characters per token,
 * which is a reasonable approximation for most text content.
 */
export namespace LargeFileThreshold {
  /**
   * Default token threshold for large file detection.
   * Files with estimated token counts above this are considered large.
   */
  export const DEFAULT_TOKEN_THRESHOLD = 25000

  /**
   * Default byte threshold for large file detection.
   * Approximately 25k tokens assuming ~4 characters per token.
   * Files larger than this in bytes are considered large.
   */
  export const DEFAULT_BYTE_THRESHOLD = 100000

  /**
   * Average characters per token for estimation.
   * This is a rough approximation that works reasonably well
   * for English text across most tokenizers.
   */
  const CHARS_PER_TOKEN = 4

  export interface ThresholdOptions {
    /** Token count threshold. Defaults to DEFAULT_TOKEN_THRESHOLD */
    tokenThreshold?: number
    /** Byte size threshold. Defaults to DEFAULT_BYTE_THRESHOLD */
    byteThreshold?: number
  }

  /**
   * Estimate the token count for a string content.
   *
   * Uses a simple heuristic of content.length / 4, which provides
   * a reasonable approximation for most text content.
   *
   * @param content - The text content to estimate
   * @returns Estimated token count (integer)
   */
  export function estimateTokenCount(content: string): number {
    return Math.ceil(content.length / CHARS_PER_TOKEN)
  }

  /**
   * Check if content should be considered a large file.
   *
   * Returns true if the content exceeds either the byte threshold
   * OR the estimated token threshold. This dual-check ensures we
   * catch large files regardless of content density.
   *
   * @param content - The file content to check
   * @param options - Optional threshold overrides
   * @returns true if the file should be stored as a large file
   */
  export function isLargeFile(content: string, options?: ThresholdOptions): boolean {
    const tokenThreshold = options?.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD
    const byteThreshold = options?.byteThreshold ?? DEFAULT_BYTE_THRESHOLD

    // Check byte size first (faster)
    if (content.length > byteThreshold) {
      return true
    }

    // Check estimated token count
    const estimatedTokens = estimateTokenCount(content)
    return estimatedTokens > tokenThreshold
  }
}
