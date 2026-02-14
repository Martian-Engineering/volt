import { Log } from "@/util/log"

/**
 * Shebang and Content-Based File Type Detection
 *
 * Detects file types from shebang lines (#!) and other content patterns
 * when file extensions are missing or ambiguous.
 */
export namespace ShebangDetector {
  const log = Log.create({ service: "lcm.explore.shebang-detector" })

  /**
   * Detected file type that can be delegated to a specialized explorer
   */
  export type DetectedType =
    | "python"
    | "javascript"
    | "ruby"
    | "perl"
    | "php"
    | "bash"
    | "shell"
    | "node"
    | "lua"
    | "tcl"
    | "awk"
    | "go"
    | "rust"
    | null

  /**
   * Result of shebang detection
   */
  export interface DetectionResult {
    /** Detected file type, or null if unknown */
    type: DetectedType
    /** The interpreter path from the shebang */
    interpreter?: string
    /** Any arguments passed to the interpreter */
    args?: string[]
    /** Detected language name for display */
    languageName?: string
  }

  /**
   * Mapping of shebang patterns to file types
   */
  const SHEBANG_PATTERNS: Array<{
    pattern: RegExp
    type: DetectedType
    languageName: string
  }> = [
    // Python
    { pattern: /python3?(\.\d+)?$/, type: "python", languageName: "Python" },
    { pattern: /\/env\s+python/, type: "python", languageName: "Python" },

    // Node.js / JavaScript
    { pattern: /node(js)?$/, type: "node", languageName: "Node.js" },
    { pattern: /\/env\s+node/, type: "node", languageName: "Node.js" },
    { pattern: /deno$/, type: "javascript", languageName: "Deno" },
    { pattern: /bun$/, type: "javascript", languageName: "Bun" },
    { pattern: /\/env\s+(deno|bun)/, type: "javascript", languageName: "JavaScript" },

    // Ruby
    { pattern: /ruby(\d+\.\d+)?$/, type: "ruby", languageName: "Ruby" },
    { pattern: /\/env\s+ruby/, type: "ruby", languageName: "Ruby" },

    // Perl
    { pattern: /perl(\d+)?$/, type: "perl", languageName: "Perl" },
    { pattern: /\/env\s+perl/, type: "perl", languageName: "Perl" },

    // Shell / Bash
    { pattern: /bash$/, type: "bash", languageName: "Bash" },
    { pattern: /\/env\s+bash/, type: "bash", languageName: "Bash" },
    { pattern: /\/bin\/sh$/, type: "shell", languageName: "Shell" },
    { pattern: /zsh$/, type: "bash", languageName: "Zsh" },
    { pattern: /\/env\s+zsh/, type: "bash", languageName: "Zsh" },
    { pattern: /fish$/, type: "bash", languageName: "Fish" },
    { pattern: /dash$/, type: "shell", languageName: "Dash" },
    { pattern: /ksh$/, type: "shell", languageName: "Korn Shell" },
    { pattern: /csh$/, type: "shell", languageName: "C Shell" },
    { pattern: /tcsh$/, type: "shell", languageName: "TENEX C Shell" },

    // PHP
    { pattern: /php(\d+)?$/, type: "php", languageName: "PHP" },
    { pattern: /\/env\s+php/, type: "php", languageName: "PHP" },

    // Lua
    { pattern: /lua(jit)?(\d+\.\d+)?$/, type: "lua", languageName: "Lua" },
    { pattern: /\/env\s+lua/, type: "lua", languageName: "Lua" },

    // Tcl
    { pattern: /tclsh(\d+\.\d+)?$/, type: "tcl", languageName: "Tcl" },
    { pattern: /wish(\d+\.\d+)?$/, type: "tcl", languageName: "Tcl/Tk" },
    { pattern: /expect$/, type: "tcl", languageName: "Expect" },
    { pattern: /\/env\s+(tclsh|wish|expect)/, type: "tcl", languageName: "Tcl" },

    // AWK
    { pattern: /[gnm]?awk$/, type: "awk", languageName: "AWK" },
    { pattern: /\/env\s+[gnm]?awk/, type: "awk", languageName: "AWK" },

    // Go (gorun or similar tools)
    { pattern: /gorun$/, type: "go", languageName: "Go" },
    { pattern: /\/env\s+gorun/, type: "go", languageName: "Go" },
  ]

  /**
   * Content patterns for detecting file type when no shebang is present
   */
  const CONTENT_PATTERNS: Array<{
    pattern: RegExp
    type: DetectedType
    languageName: string
    /** Only match if pattern appears near the start of the file */
    nearStart?: boolean
  }> = [
    // PHP opening tag
    { pattern: /^<\?php\s/, type: "php", languageName: "PHP", nearStart: true },
    { pattern: /^<\?=/, type: "php", languageName: "PHP", nearStart: true },

    // XML declaration (to avoid false positives with PHP)
    // This is handled by not matching <?xml as PHP

    // Ruby patterns (when no shebang)
    { pattern: /^require\s+['"]/, type: "ruby", languageName: "Ruby", nearStart: true },
    { pattern: /^require_relative\s+['"]/, type: "ruby", languageName: "Ruby", nearStart: true },
    { pattern: /\bclass\s+\w+\s*<\s*/, type: "ruby", languageName: "Ruby" },
    { pattern: /\bdef\s+\w+\s*\(?\s*\w*\s*\)?\s*$/, type: "ruby", languageName: "Ruby" },
    { pattern: /\bdo\s*\|[^|]+\|/, type: "ruby", languageName: "Ruby" },

    // Perl patterns
    { pattern: /^use\s+strict\s*;/, type: "perl", languageName: "Perl", nearStart: true },
    { pattern: /^use\s+warnings\s*;/, type: "perl", languageName: "Perl", nearStart: true },
    { pattern: /^package\s+\w+(::\w+)*\s*;/, type: "perl", languageName: "Perl", nearStart: true },
    { pattern: /\$\w+\s*=~\s*[sm]?\//, type: "perl", languageName: "Perl" },

    // Lua patterns
    { pattern: /^local\s+\w+\s*=\s*require\s*\(?\s*['"]/, type: "lua", languageName: "Lua", nearStart: true },
    { pattern: /\bfunction\s+\w+\s*\([^)]*\)\s*$/, type: "lua", languageName: "Lua" },
    { pattern: /\bend\s*$/, type: "lua", languageName: "Lua" },

    // Tcl patterns
    { pattern: /^package\s+require\s+/, type: "tcl", languageName: "Tcl", nearStart: true },
    { pattern: /\bproc\s+\w+\s*\{[^}]*\}\s*\{/, type: "tcl", languageName: "Tcl" },
    { pattern: /\bset\s+\w+\s+\[/, type: "tcl", languageName: "Tcl" },

    // AWK patterns
    { pattern: /^BEGIN\s*\{/, type: "awk", languageName: "AWK", nearStart: true },
    { pattern: /^END\s*\{/, type: "awk", languageName: "AWK" },
    { pattern: /^\s*\/[^\/]+\/\s*\{/, type: "awk", languageName: "AWK", nearStart: true },
  ]

  /**
   * Parse a shebang line and extract interpreter information
   */
  function parseShebang(shebangLine: string): { interpreter: string; args: string[] } | null {
    if (!shebangLine.startsWith("#!")) return null

    const content = shebangLine.slice(2).trim()
    const parts = content.split(/\s+/)

    if (parts.length === 0) return null

    const interpreter = parts[0]
    const args = parts.slice(1)

    return { interpreter, args }
  }

  /**
   * Detect file type from a shebang line
   */
  function detectFromShebang(shebangLine: string): DetectionResult {
    const parsed = parseShebang(shebangLine)
    if (!parsed) return { type: null }

    const { interpreter, args } = parsed

    // Handle /usr/bin/env - the actual interpreter is in args
    if (interpreter.endsWith("/env") && args.length > 0) {
      // Reconstruct for pattern matching
      const envLine = `${interpreter} ${args[0]}`
      for (const { pattern, type, languageName } of SHEBANG_PATTERNS) {
        if (pattern.test(envLine)) {
          return {
            type,
            interpreter: args[0],
            args: args.slice(1),
            languageName,
          }
        }
      }
    }

    // Direct interpreter match
    for (const { pattern, type, languageName } of SHEBANG_PATTERNS) {
      if (pattern.test(interpreter)) {
        return {
          type,
          interpreter,
          args,
          languageName,
        }
      }
    }

    return { type: null, interpreter, args }
  }

  /**
   * Detect file type from content patterns
   */
  function detectFromContent(content: string): DetectionResult {
    // Get first 1000 characters for "near start" patterns
    const nearStart = content.slice(0, 1000)

    for (const { pattern, type, languageName, nearStart: checkNearStart } of CONTENT_PATTERNS) {
      const textToCheck = checkNearStart ? nearStart : content
      if (pattern.test(textToCheck)) {
        // Avoid matching <?xml as PHP
        if (type === "php" && content.trimStart().startsWith("<?xml")) {
          continue
        }
        return { type, languageName }
      }
    }

    return { type: null }
  }

  /**
   * Detect file type from content (shebang + content patterns)
   *
   * @param content The file content to analyze
   * @returns Detection result with type and metadata
   */
  export function detect(content: string): DetectionResult {
    const lines = content.split("\n")
    const firstLine = lines[0]?.trim() ?? ""

    // Try shebang detection first
    if (firstLine.startsWith("#!")) {
      const result = detectFromShebang(firstLine)
      if (result.type) {
        log.debug("detected type from shebang", {
          type: result.type,
          interpreter: result.interpreter,
        })
        return result
      }
    }

    // Try content pattern detection
    const contentResult = detectFromContent(content)
    if (contentResult.type) {
      log.debug("detected type from content patterns", {
        type: contentResult.type,
        languageName: contentResult.languageName,
      })
      return contentResult
    }

    return { type: null }
  }

  /**
   * Check if a detected type has a specialized explorer available
   */
  export function hasSpecializedExplorer(type: DetectedType): boolean {
    if (!type) return false

    // Types that have specialized explorers
    const specializedTypes = new Set<DetectedType>([
      "python",
      "javascript",
      "node",
      "go",
      "rust",
      "tcl",
      "lua",
      // These delegate to text explorer with language hint
      "bash",
      "shell",
      "ruby",
      "perl",
      "php",
      "awk",
    ])

    return specializedTypes.has(type)
  }

  /**
   * Get the explorer name for a detected type
   */
  export function getExplorerName(type: DetectedType): string | null {
    if (!type) return null

    const explorerMap: Record<string, string> = {
      python: "PythonExplorer",
      javascript: "JavaScriptExplorer",
      node: "JavaScriptExplorer",
      go: "GoExplorer",
      rust: "RustExplorer",
      tcl: "TclExplorer",
      // These use TextExplorer with language hints
      bash: "TextExplorer",
      shell: "TextExplorer",
      ruby: "TextExplorer",
      perl: "TextExplorer",
      php: "TextExplorer",
      lua: "TextExplorer",
      awk: "TextExplorer",
    }

    return explorerMap[type] ?? null
  }
}
