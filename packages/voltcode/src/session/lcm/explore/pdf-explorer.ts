import { Log } from "@/util/log"
import { TextExplorer } from "./text-explorer"
import type { Provider } from "@/provider/provider"

/**
 * PDF Exploration Agent for LCM
 *
 * Handles PDF files by extracting text using pdftotext (from poppler-utils),
 * then delegating to TextExplorer for analysis. Falls back with an error
 * if text extraction fails (missing tool, encrypted PDF, image-only PDF).
 */
export namespace PdfExplorer {
  const log = Log.create({ service: "lcm.explore.pdf" })

  /**
   * Result of PDF exploration
   */
  export interface PdfExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Exploration summary from TextExplorer (if successful) */
    summary?: string
    /** Metadata from TextExplorer (if successful) */
    metadata?: TextExplorer.ExplorationMetadata
    /** Estimated token count for the summary */
    tokenCount?: number
    /** Error message if extraction failed */
    error?: string
    /** Number of pages extracted (if available) */
    pagesExtracted?: number
  }

  /**
   * Extract text from a PDF using pdftotext command-line tool.
   *
   * @param filePath - Path to the PDF file
   * @returns Object with extracted text and page count, or error
   */
  async function extractTextFromPdf(
    filePath: string,
  ): Promise<{ text: string; pageCount?: number } | { error: string }> {
    try {
      // Run pdftotext with -layout flag to preserve formatting
      // Output to stdout (-)
      const proc = Bun.spawn(["pdftotext", "-layout", filePath, "-"], {
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])

      const exitCode = await proc.exited

      if (exitCode !== 0) {
        const errorMsg = stderr.trim()
        log.warn("pdftotext failed", { filePath, exitCode, stderr: errorMsg })

        // Check for specific error patterns
        if (errorMsg.includes("Incorrect password") || errorMsg.includes("encrypted")) {
          return { error: "PDF is encrypted or password-protected. Cannot extract text." }
        }

        return { error: `pdftotext failed: ${errorMsg || `exit code ${exitCode}`}` }
      }

      const text = stdout.trim()

      // Check if we got any meaningful text
      if (!text || text.length < 10) {
        return { error: "PDF appears to be image-only or encrypted. OCR support coming soon." }
      }

      // Try to get page count using pdfinfo if available
      let pageCount: number | undefined
      try {
        const infoProc = Bun.spawn(["pdfinfo", filePath], {
          stdout: "pipe",
          stderr: "pipe",
        })

        const infoOutput = await new Response(infoProc.stdout).text()
        await infoProc.exited

        const pageMatch = infoOutput.match(/Pages:\s+(\d+)/)
        if (pageMatch) {
          pageCount = parseInt(pageMatch[1], 10)
        }
      } catch {
        // pdfinfo not available, that's fine
      }

      return { text, pageCount }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)

      // Check if pdftotext is not installed
      if (
        errorMessage.includes("ENOENT") ||
        errorMessage.includes("not found") ||
        errorMessage.includes("No such file")
      ) {
        return {
          error: "pdftotext not installed. Install poppler-utils to enable PDF text extraction.",
        }
      }

      log.error("failed to extract text from PDF", { filePath, error: errorMessage })
      return { error: `Failed to extract text: ${errorMessage}` }
    }
  }

  /**
   * Explore a PDF file and produce a summary.
   *
   * Extracts text from the PDF using pdftotext, then delegates to TextExplorer
   * for analysis. Returns an error result if text extraction fails.
   *
   * @param input - Configuration for the exploration
   * @param input.filePath - Path to the PDF file
   * @param input.model - The provider model to use for the LLM call
   * @param input.abort - Optional abort signal for cancellation
   * @returns The exploration result with summary and metadata
   */
  export async function explore(input: {
    filePath: string
    model: Provider.Model
    abort?: AbortSignal
  }): Promise<PdfExplorationResult> {
    log.info("exploring PDF file", { filePath: input.filePath })

    // Check if file exists
    const file = Bun.file(input.filePath)
    const exists = await file.exists()
    if (!exists) {
      log.warn("PDF file not found", { filePath: input.filePath })
      return {
        success: false,
        error: `File not found: ${input.filePath}`,
      }
    }

    // Extract text from PDF
    const extractResult = await extractTextFromPdf(input.filePath)

    if ("error" in extractResult) {
      return {
        success: false,
        error: extractResult.error,
      }
    }

    const { text, pageCount } = extractResult

    log.info("PDF text extracted", {
      filePath: input.filePath,
      textLength: text.length,
      pageCount,
    })

    // Delegate to TextExplorer for analysis
    try {
      const textResult = await TextExplorer.explore({
        content: text,
        path: input.filePath,
        mimeType: "application/pdf",
        model: input.model,
        abort: input.abort,
      })

      log.info("PDF exploration complete", {
        filePath: input.filePath,
        summaryTokenCount: textResult.tokenCount,
        pageCount,
      })

      return {
        success: true,
        summary: textResult.summary,
        metadata: textResult.metadata,
        tokenCount: textResult.tokenCount,
        pagesExtracted: pageCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to explore PDF text", { filePath: input.filePath, error: errorMessage })

      return {
        success: false,
        error: `Failed to analyze PDF content: ${errorMessage}`,
      }
    }
  }
}
