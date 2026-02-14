import path from "path"
import { Token } from "@/util/token"
import { Log } from "@/util/log"
import { ShebangDetector } from "./shebang-detector"

/**
 * Fallback Exploration Agent for LCM
 *
 * Handles files that don't have specialized explorers.
 * Provides basic file information like size, line count,
 * and first/last few lines for text files, or hex dump for binary files.
 *
 * IMPORTANT: This explorer now includes content-based type detection.
 * If a file without a clear extension can be identified as a specific type
 * (e.g., a bash script without .sh extension), it will delegate to the
 * appropriate specialized explorer.
 */
export namespace FallbackExplorer {
  const log = Log.create({ service: "lcm.explore.fallback" })
  /**
   * Result of a fallback exploration
   */
  export interface FallbackExplorationResult {
    /** Human-readable summary of the file */
    summary: string
    /** Metadata about the file */
    metadata: {
      /** Whether the file is binary or text */
      isBinary: boolean
      /** File size in bytes */
      size: number
      /** Number of lines (text files only) */
      lineCount?: number
      /** MIME type if detected */
      mimeType?: string
    }
    /** Estimated token count for the summary */
    tokenCount: number
  }

  /**
   * Input for the explore function
   */
  export interface ExploreInput {
    /** File content as string or Buffer */
    content: string | Buffer
    /** Optional file path for display */
    path?: string
    /** Optional MIME type if already known */
    mimeType?: string
    /**
     * Whether to attempt content-based type detection and delegation.
     * When true (default), the explorer will check for shebangs and other
     * patterns to identify file types and delegate to specialized explorers.
     * Set to false to disable delegation and force fallback behavior.
     */
    enableDelegation?: boolean
  }

  /**
   * Result that may come from a delegated explorer
   */
  export interface DelegatedResult {
    /** Whether this result came from a delegated explorer */
    delegated: true
    /** The explorer that was used */
    delegatedTo: string
    /** The result from the delegated explorer */
    result: unknown
  }

  /**
   * Number of lines to show from the start of text files
   */
  const FIRST_LINES_COUNT = 10

  /**
   * Number of lines to show from the end of text files
   */
  const LAST_LINES_COUNT = 5

  /**
   * Number of bytes to show in hex dump for binary files
   */
  const HEX_DUMP_BYTES = 32

  /**
   * Check if content appears to be binary.
   *
   * Heuristic: check for null bytes or high ratio of non-printable characters
   * in the first few KB of content.
   */
  function detectBinary(content: Buffer): boolean {
    // Check first 8KB for binary detection
    const checkBytes = Math.min(content.length, 8192)

    let nullCount = 0
    let nonPrintable = 0

    for (let i = 0; i < checkBytes; i++) {
      const byte = content[i]
      if (byte === 0) {
        nullCount++
      }
      // Non-printable: not tab, newline, carriage return, and outside printable ASCII range
      if (byte !== 9 && byte !== 10 && byte !== 13 && (byte < 32 || byte > 126)) {
        nonPrintable++
      }
    }

    // If we have null bytes, it's likely binary
    if (nullCount > 0) return true

    // If more than 30% non-printable, consider it binary
    const ratio = nonPrintable / checkBytes
    return ratio > 0.3
  }

  /**
   * Format bytes as a hex dump string.
   */
  function formatHexDump(buffer: Buffer, maxBytes: number): string {
    const bytes = buffer.subarray(0, maxBytes)
    const hexParts: string[] = []

    for (let i = 0; i < bytes.length; i++) {
      hexParts.push(bytes[i].toString(16).padStart(2, "0"))
    }

    // Format as groups of 16 bytes per line
    const lines: string[] = []
    for (let i = 0; i < hexParts.length; i += 16) {
      const line = hexParts.slice(i, i + 16).join(" ")
      lines.push(line)
    }

    return lines.join("\n")
  }

  /**
   * Format a number with commas for readability.
   */
  function formatNumber(n: number): string {
    return n.toLocaleString("en-US")
  }

  /**
   * Get a display name for the file.
   */
  function getDisplayName(filePath?: string): string {
    if (!filePath) return "unknown"
    return path.basename(filePath)
  }

  /**
   * Detect MIME type from content and path.
   *
   * This is a simple heuristic-based detection.
   */
  function detectMimeType(content: Buffer, filePath?: string): string | undefined {
    // Check magic bytes for common formats
    if (content.length >= 4) {
      // PNG
      if (content[0] === 0x89 && content[1] === 0x50 && content[2] === 0x4e && content[3] === 0x47) {
        return "image/png"
      }
      // JPEG
      if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) {
        return "image/jpeg"
      }
      // GIF
      if (content[0] === 0x47 && content[1] === 0x49 && content[2] === 0x46) {
        return "image/gif"
      }
      // PDF
      if (content[0] === 0x25 && content[1] === 0x50 && content[2] === 0x44 && content[3] === 0x46) {
        return "application/pdf"
      }
      // ZIP (also covers docx, xlsx, jar, etc.)
      if (content[0] === 0x50 && content[1] === 0x4b && content[2] === 0x03 && content[3] === 0x04) {
        return "application/zip"
      }
      // WebP
      if (
        content.length >= 12 &&
        content[0] === 0x52 &&
        content[1] === 0x49 &&
        content[2] === 0x46 &&
        content[3] === 0x46 &&
        content[8] === 0x57 &&
        content[9] === 0x45 &&
        content[10] === 0x42 &&
        content[11] === 0x50
      ) {
        return "image/webp"
      }
    }

    // Fall back to extension-based detection
    if (filePath) {
      const ext = path.extname(filePath).toLowerCase()
      const mimeMap: Record<string, string> = {
        ".txt": "text/plain",
        ".html": "text/html",
        ".css": "text/css",
        ".js": "application/javascript",
        ".json": "application/json",
        ".xml": "application/xml",
        ".csv": "text/csv",
        ".md": "text/markdown",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".zip": "application/zip",
        ".gz": "application/gzip",
        ".tar": "application/x-tar",
        ".mp3": "audio/mpeg",
        ".mp4": "video/mp4",
        ".wav": "audio/wav",
        ".avi": "video/x-msvideo",
        ".bin": "application/octet-stream",
        ".exe": "application/x-msdownload",
        ".dll": "application/x-msdownload",
        ".so": "application/octet-stream",
        ".dylib": "application/octet-stream",
      }
      if (ext in mimeMap) {
        return mimeMap[ext]
      }
    }

    return undefined
  }

  /**
   * Explore a file and produce a basic summary.
   *
   * For text files: shows file size, line count, and first/last few lines.
   * For binary files: shows file size, MIME type, and hex dump of first bytes.
   *
   * If enableDelegation is true (default), the explorer will attempt to detect
   * the file type from shebangs and content patterns, and delegate to a
   * specialized explorer if available.
   */
  export async function explore(input: ExploreInput): Promise<FallbackExplorationResult> {
    const buffer = typeof input.content === "string" ? Buffer.from(input.content, "utf-8") : input.content

    const size = buffer.length
    const displayName = getDisplayName(input.path)
    const isBinary = detectBinary(buffer)
    const mimeType = input.mimeType ?? detectMimeType(buffer, input.path)

    if (isBinary) {
      return exploreBinary(buffer, size, displayName, mimeType)
    }

    // Try content-based delegation for text files (unless disabled)
    const enableDelegation = input.enableDelegation !== false
    if (enableDelegation) {
      const textContent = buffer.toString("utf-8")
      const delegatedResult = await tryDelegateToSpecializedExplorer(textContent, input.path)
      if (delegatedResult) {
        return delegatedResult
      }
    }

    return exploreTextBasic(buffer, size, displayName, mimeType)
  }

  /**
   * Try to detect file type and delegate to a specialized explorer.
   * Returns null if no specialized explorer is available or detection fails.
   */
  async function tryDelegateToSpecializedExplorer(
    content: string,
    filePath?: string,
  ): Promise<FallbackExplorationResult | null> {
    const detection = ShebangDetector.detect(content)

    if (!detection.type) {
      return null
    }

    log.info("detected file type from content", {
      type: detection.type,
      languageName: detection.languageName,
      interpreter: detection.interpreter,
      path: filePath,
    })

    // Delegate based on detected type
    switch (detection.type) {
      case "python": {
        const { PythonExplorer } = await import("./python-explorer")
        const result = await PythonExplorer.explore({ content, filePath })
        return convertToFallbackResult(result, detection.languageName ?? "Python")
      }

      case "javascript":
      case "node": {
        const { JavaScriptExplorer } = await import("./javascript-explorer")
        const result = await JavaScriptExplorer.explore({ content, filePath })
        return convertToFallbackResult(result, detection.languageName ?? "JavaScript")
      }

      case "go": {
        const { GoExplorer } = await import("./go-explorer")
        const result = await GoExplorer.explore({ content, filePath })
        return convertToFallbackResult(result, detection.languageName ?? "Go")
      }

      case "rust": {
        const { RustExplorer } = await import("./rust-explorer")
        const result = await RustExplorer.explore({ content, filePath })
        return convertToFallbackResult(result, detection.languageName ?? "Rust")
      }

      case "tcl": {
        const { TclExplorer } = await import("./tcl-explorer")
        const result = await TclExplorer.explore({ content, filePath })
        return convertToFallbackResult(result, detection.languageName ?? "Tcl")
      }

      case "ruby":
      case "perl":
      case "php":
      case "lua":
      case "bash":
      case "shell":
      case "awk": {
        // These languages use the text explorer with language hints
        // Return null to let the basic text exploration handle it,
        // but include the detected language in the result
        return null
      }

      default:
        return null
    }
  }

  /**
   * Convert a specialized explorer result to FallbackExplorationResult format
   */
  function convertToFallbackResult(
    result: { success: boolean; summary: string; tokenCount: number; error?: string },
    languageName: string,
  ): FallbackExplorationResult {
    if (!result.success) {
      // If specialized exploration failed, return a basic result
      return {
        summary: result.error ?? `Failed to explore ${languageName} file`,
        metadata: {
          isBinary: false,
          size: 0,
          mimeType: `text/x-${languageName.toLowerCase()}`,
        },
        tokenCount: result.tokenCount || 0,
      }
    }

    // Estimate size from summary (not ideal, but we don't have the original)
    const estimatedSize = result.summary.length

    return {
      summary: result.summary,
      metadata: {
        isBinary: false,
        size: estimatedSize,
        lineCount: result.summary.split("\n").length,
        mimeType: `text/x-${languageName.toLowerCase()}`,
      },
      tokenCount: result.tokenCount,
    }
  }

  /**
   * Explore a binary file.
   */
  function exploreBinary(
    buffer: Buffer,
    size: number,
    displayName: string,
    mimeType?: string,
  ): FallbackExplorationResult {
    const typeDisplay = mimeType ?? "application/octet-stream"
    const hexDump = formatHexDump(buffer, HEX_DUMP_BYTES)

    const lines: string[] = []
    lines.push(`File: ${displayName} (${formatNumber(size)} bytes)`)
    lines.push(`Type: Binary file (${typeDisplay})`)
    lines.push("")
    lines.push(`First ${Math.min(HEX_DUMP_BYTES, size)} bytes (hex):`)
    lines.push(hexDump)

    const summary = lines.join("\n")

    return {
      summary,
      metadata: {
        isBinary: true,
        size,
        mimeType: mimeType ?? "application/octet-stream",
      },
      tokenCount: Token.estimate(summary),
    }
  }

  /**
   * Explore a text file with basic summary (no delegation).
   */
  function exploreTextBasic(
    buffer: Buffer,
    size: number,
    displayName: string,
    mimeType?: string,
  ): FallbackExplorationResult {
    const text = buffer.toString("utf-8")
    const allLines = text.split("\n")
    const lineCount = allLines.length

    const lines: string[] = []
    lines.push(`File: ${displayName} (${formatNumber(size)} bytes, ${formatNumber(lineCount)} lines)`)
    lines.push(`Type: ${mimeType ?? "Unknown text file"}`)
    lines.push("")

    // First N lines
    const firstLines = allLines.slice(0, FIRST_LINES_COUNT)
    lines.push(`First ${Math.min(FIRST_LINES_COUNT, lineCount)} lines:`)
    for (const line of firstLines) {
      lines.push(line)
    }

    // Last N lines (only if file is long enough)
    if (lineCount > FIRST_LINES_COUNT + LAST_LINES_COUNT) {
      lines.push("")
      lines.push(`Last ${LAST_LINES_COUNT} lines:`)
      const lastLines = allLines.slice(-LAST_LINES_COUNT)
      for (const line of lastLines) {
        lines.push(line)
      }
    }

    const summary = lines.join("\n")

    return {
      summary,
      metadata: {
        isBinary: false,
        size,
        lineCount,
        mimeType,
      },
      tokenCount: Token.estimate(summary),
    }
  }
}
