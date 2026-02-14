import { generateText } from "ai"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { ShebangDetector } from "./shebang-detector"
import EXPLORE_TEXT_PROMPT from "../prompts/explore-text.txt"

/**
 * LCM Text File Exploration Module
 *
 * Provides the explore() function that analyzes text files (source code,
 * markdown, configuration, etc.) and produces a concise exploration summary
 * that can be used in context instead of the full file content.
 *
 * IMPORTANT: This explorer now includes content-based type detection.
 * If a file without a clear extension can be identified as a specific type
 * (e.g., a bash script without .sh extension, a Python script without .py),
 * it will delegate to the appropriate specialized explorer for better analysis.
 */
export namespace TextExplorer {
  const log = Log.create({ service: "lcm.text-explorer" })

  /**
   * Metadata extracted from file exploration
   */
  export interface ExplorationMetadata {
    /** Detected programming language or file type */
    language?: string
    /** Number of lines in the original file */
    lineCount: number
    /** Whether the file contains code */
    hasCode: boolean
    /** Key structures found (classes, functions, sections, etc.) */
    keyStructures: string[]
  }

  /**
   * Result of exploring a text file
   */
  export interface ExplorationResult {
    /** The exploration summary */
    summary: string
    /** Extracted metadata about the file */
    metadata: ExplorationMetadata
    /** Estimated token count of the summary */
    tokenCount: number
  }

  /**
   * Detect the programming language from file path or content
   */
  function detectLanguage(path?: string, mimeType?: string, content?: string): string | undefined {
    if (mimeType) {
      const mimeMap: Record<string, string> = {
        "text/javascript": "JavaScript",
        "application/javascript": "JavaScript",
        "text/typescript": "TypeScript",
        "application/typescript": "TypeScript",
        "text/x-python": "Python",
        "text/x-java": "Java",
        "text/x-go": "Go",
        "text/x-rust": "Rust",
        "text/x-c": "C",
        "text/x-c++": "C++",
        "text/markdown": "Markdown",
        "text/html": "HTML",
        "text/css": "CSS",
        "application/json": "JSON",
        "text/yaml": "YAML",
        "text/x-yaml": "YAML",
      }
      if (mimeMap[mimeType]) return mimeMap[mimeType]
    }

    if (path) {
      const ext = path.split(".").pop()?.toLowerCase()
      const extMap: Record<string, string> = {
        ts: "TypeScript",
        tsx: "TypeScript (React)",
        js: "JavaScript",
        jsx: "JavaScript (React)",
        mjs: "JavaScript (ESM)",
        cjs: "JavaScript (CommonJS)",
        py: "Python",
        java: "Java",
        go: "Go",
        rs: "Rust",
        c: "C",
        cpp: "C++",
        cc: "C++",
        h: "C/C++ Header",
        hpp: "C++ Header",
        rb: "Ruby",
        php: "PHP",
        swift: "Swift",
        kt: "Kotlin",
        scala: "Scala",
        cs: "C#",
        fs: "F#",
        hs: "Haskell",
        ml: "OCaml",
        ex: "Elixir",
        exs: "Elixir Script",
        erl: "Erlang",
        clj: "Clojure",
        lua: "Lua",
        sh: "Shell",
        bash: "Bash",
        zsh: "Zsh",
        fish: "Fish",
        ps1: "PowerShell",
        sql: "SQL",
        md: "Markdown",
        mdx: "MDX",
        html: "HTML",
        htm: "HTML",
        css: "CSS",
        scss: "SCSS",
        sass: "Sass",
        less: "Less",
        json: "JSON",
        jsonc: "JSON with Comments",
        yaml: "YAML",
        yml: "YAML",
        toml: "TOML",
        ini: "INI",
        xml: "XML",
        vue: "Vue",
        svelte: "Svelte",
        astro: "Astro",
      }
      if (ext && extMap[ext]) return extMap[ext]
    }

    // Try to detect from content patterns
    if (content) {
      const firstLines = content.slice(0, 500)
      if (firstLines.includes("#!/usr/bin/env python") || firstLines.includes("#!/usr/bin/python")) return "Python"
      if (firstLines.includes("#!/bin/bash") || firstLines.includes("#!/usr/bin/env bash")) return "Bash"
      if (firstLines.includes("#!/bin/sh")) return "Shell"
      if (firstLines.includes("package main") && firstLines.includes("import")) return "Go"
      if (firstLines.match(/^import\s+.*\s+from\s+['"]/) || firstLines.includes("export default")) return "JavaScript"
      if (firstLines.includes("interface ") || firstLines.includes(": string") || firstLines.includes(": number"))
        return "TypeScript"
    }

    return undefined
  }

  /**
   * Detect if content contains code
   */
  function hasCodeContent(content: string, language?: string): boolean {
    if (language && !["Markdown", "YAML", "JSON", "TOML", "INI", "XML"].includes(language)) {
      return true
    }

    // Check for common code patterns
    const codePatterns = [
      /function\s+\w+\s*\(/,
      /class\s+\w+/,
      /const\s+\w+\s*=/,
      /let\s+\w+\s*=/,
      /var\s+\w+\s*=/,
      /def\s+\w+\s*\(/,
      /import\s+.*\s+from/,
      /export\s+(default\s+)?/,
      /=>\s*\{/,
      /\bif\s*\(.+\)\s*\{/,
      /\bfor\s*\(.+\)\s*\{/,
      /\bwhile\s*\(.+\)\s*\{/,
    ]

    return codePatterns.some((pattern) => pattern.test(content))
  }

  /**
   * Extract key structure names from the exploration summary
   */
  function extractKeyStructures(summary: string): string[] {
    const structures: string[] = []

    // Look for patterns like "Class X", "function Y", "interface Z"
    const patterns = [
      /(?:class|Class)\s+(\w+)/g,
      /(?:function|Function)\s+(\w+)/g,
      /(?:interface|Interface)\s+(\w+)/g,
      /(?:type|Type)\s+(\w+)/g,
      /(?:namespace|Namespace)\s+(\w+)/g,
      /(?:module|Module)\s+(\w+)/g,
      /(?:export(?:ed)?)\s+(?:const|let|var|function|class|interface|type)\s+(\w+)/g,
    ]

    for (const pattern of patterns) {
      let match
      while ((match = pattern.exec(summary)) !== null) {
        if (match[1] && !structures.includes(match[1])) {
          structures.push(match[1])
        }
      }
    }

    // Also look for markdown-style structure listings
    const listPattern = /[-*]\s+`?(\w+)`?\s*(?:\(|:)/g
    let match
    while ((match = listPattern.exec(summary)) !== null) {
      if (match[1] && !structures.includes(match[1]) && match[1].length > 2) {
        structures.push(match[1])
      }
    }

    return structures.slice(0, 20) // Limit to 20 structures
  }

  /**
   * Input configuration for the explore function
   */
  export interface ExploreInput {
    /** The text content to explore (may be sampled for large files) */
    content: string
    /** Optional file path for context */
    path?: string
    /** Optional MIME type for better detection */
    mimeType?: string
    /** The provider model to use for the LLM call */
    model: Provider.Model
    /** Session ID for spawning exploration agents */
    sessionID?: string
    /** Optional abort signal for cancellation */
    abort?: AbortSignal
    /** Whether the content is a sample of a larger file */
    isSampled?: boolean
    /** Original file size in bytes (if sampled) */
    originalFileSize?: number
    /**
     * Whether to attempt content-based type detection and delegation.
     * When true (default), the explorer will check for shebangs and other
     * patterns to identify file types and delegate to specialized explorers.
     * Set to false to disable delegation and use LLM-based text exploration.
     */
    enableDelegation?: boolean
  }

  /**
   * Explore a text file and produce a summary.
   *
   * If enableDelegation is true (default), the explorer will first try to detect
   * the file type from shebangs and content patterns. If a specialized explorer
   * is available for the detected type, it will delegate to that explorer for
   * better structured analysis.
   *
   * @param input - Configuration for the exploration
   * @returns The exploration result with summary and metadata
   */
  export async function explore(input: ExploreInput): Promise<ExplorationResult> {
    const lineCount = input.content.split("\n").length

    // Try content-based delegation first (unless disabled)
    const enableDelegation = input.enableDelegation !== false
    if (enableDelegation) {
      const delegatedResult = await tryDelegateToSpecializedExplorer(input)
      if (delegatedResult) {
        return delegatedResult
      }
    }

    // Fall back to LLM-based text exploration
    return exploreWithLLM(input, lineCount)
  }

  /**
   * Try to detect file type and delegate to a specialized explorer.
   * Returns null if no specialized explorer is available or detection fails.
   */
  async function tryDelegateToSpecializedExplorer(input: ExploreInput): Promise<ExplorationResult | null> {
    const detection = ShebangDetector.detect(input.content)

    if (!detection.type) {
      return null
    }

    log.info("detected file type from content, attempting delegation", {
      type: detection.type,
      languageName: detection.languageName,
      interpreter: detection.interpreter,
      path: input.path,
    })

    try {
      // Delegate based on detected type
      switch (detection.type) {
        case "python": {
          const { PythonExplorer } = await import("./python-explorer")
          const result = await PythonExplorer.explore({
            content: input.content,
            filePath: input.path,
            model: input.model,
            sessionID: input.sessionID,
            abort: input.abort,
          })
          return convertSpecializedResult(result, detection.languageName ?? "Python", input.content)
        }

        case "javascript":
        case "node": {
          const { JavaScriptExplorer } = await import("./javascript-explorer")
          const result = await JavaScriptExplorer.explore({
            content: input.content,
            filePath: input.path,
            model: input.model,
            sessionID: input.sessionID,
            abort: input.abort,
          })
          return convertSpecializedResult(result, detection.languageName ?? "JavaScript", input.content)
        }

        case "go": {
          const { GoExplorer } = await import("./go-explorer")
          const result = await GoExplorer.explore({
            content: input.content,
            filePath: input.path,
            model: input.model,
            sessionID: input.sessionID,
            abort: input.abort,
          })
          return convertSpecializedResult(result, detection.languageName ?? "Go", input.content)
        }

        case "rust": {
          const { RustExplorer } = await import("./rust-explorer")
          const result = await RustExplorer.explore({
            content: input.content,
            filePath: input.path,
            model: input.model,
            sessionID: input.sessionID,
            abort: input.abort,
          })
          return convertSpecializedResult(result, detection.languageName ?? "Rust", input.content)
        }

        case "tcl": {
          const { TclExplorer } = await import("./tcl-explorer")
          const result = await TclExplorer.explore({
            content: input.content,
            filePath: input.path,
            model: input.model,
            sessionID: input.sessionID,
            abort: input.abort,
          })
          return convertSpecializedResult(result, detection.languageName ?? "Tcl", input.content)
        }

        case "ruby":
        case "perl":
        case "php":
        case "lua":
        case "bash":
        case "shell":
        case "awk": {
          // These languages don't have dedicated explorers with structural parsing,
          // so we'll use the LLM-based exploration but with enhanced language hint
          log.info("no specialized explorer for detected type, using LLM exploration", {
            type: detection.type,
            languageName: detection.languageName,
          })
          return null
        }

        default:
          return null
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.warn("delegation to specialized explorer failed, falling back to LLM", {
        type: detection.type,
        error: errorMessage,
      })
      return null
    }
  }

  /**
   * Convert a specialized explorer result to TextExplorer.ExplorationResult format
   */
  function convertSpecializedResult(
    result: { success: boolean; summary: string; tokenCount: number; error?: string },
    languageName: string,
    content: string,
  ): ExplorationResult | null {
    if (!result.success) {
      log.warn("specialized explorer returned unsuccessful result", {
        language: languageName,
        error: result.error,
      })
      return null // Fall back to LLM exploration
    }

    const lineCount = content.split("\n").length
    const keyStructures = extractKeyStructures(result.summary)

    log.info("successfully delegated to specialized explorer", {
      language: languageName,
      tokenCount: result.tokenCount,
      structuresFound: keyStructures.length,
    })

    return {
      summary: result.summary,
      metadata: {
        language: languageName,
        lineCount,
        hasCode: true,
        keyStructures,
      },
      tokenCount: result.tokenCount,
    }
  }

  /**
   * Perform LLM-based text exploration (the original explore logic)
   */
  async function exploreWithLLM(input: ExploreInput, lineCount: number): Promise<ExplorationResult> {
    // Use shebang detection to enhance language detection
    const detection = ShebangDetector.detect(input.content)
    const detectedFromShebang = detection.languageName

    // Try extension-based detection, fall back to shebang detection
    const language = detectLanguage(input.path, input.mimeType, input.content) ?? detectedFromShebang
    const hasCode = hasCodeContent(input.content, language)

    log.info("exploring text file with LLM", {
      path: input.path,
      lineCount,
      language,
      hasCode,
      contentLength: input.content.length,
      isSampled: input.isSampled,
      originalFileSize: input.originalFileSize,
      detectedFromShebang,
    })

    // Build context message for the LLM
    const contextParts: string[] = []
    if (input.path) contextParts.push(`File path: ${input.path}`)
    if (language) contextParts.push(`Detected language: ${language}`)
    if (detection.interpreter) contextParts.push(`Interpreter: ${detection.interpreter}`)
    if (input.isSampled && input.originalFileSize) {
      const sizeMB = (input.originalFileSize / (1024 * 1024)).toFixed(1)
      contextParts.push(`Original file size: ${sizeMB} MB (SAMPLED - showing beginning, middle, and end portions)`)
      contextParts.push(`Sample line count: ${lineCount}`)
    } else {
      contextParts.push(`Line count: ${lineCount}`)
    }

    const userMessage = `
${contextParts.join("\n")}

## File Content

<file-content>
${input.content}
</file-content>
`.trim()

    const promptTemplate = EXPLORE_TEXT_PROMPT

    // Get language model for the provider
    const languageModel = await Provider.getLanguage(input.model)

    // Call the LLM to generate the exploration
    const result = await generateText({
      model: languageModel,
      abortSignal: input.abort,
      messages: [
        {
          role: "system",
          content: promptTemplate,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
      temperature: 0.3, // Lower temperature for consistent analysis
    })

    const summary = result.text.trim()
    const tokenCount = Token.estimate(summary)
    const keyStructures = extractKeyStructures(summary)

    log.info("completed text exploration with LLM", {
      path: input.path,
      summaryTokenCount: tokenCount,
      structuresFound: keyStructures.length,
    })

    return {
      summary,
      metadata: {
        language,
        lineCount,
        hasCode,
        keyStructures,
      },
      tokenCount,
    }
  }
}
