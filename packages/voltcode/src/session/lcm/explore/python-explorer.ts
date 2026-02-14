import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateAgentSummary } from "./agent-summary"

/**
 * Python File Exploration Agent
 *
 * Analyzes Python files (.py, .pyi, .pyw) and produces structured summaries
 * including imports, classes, functions, decorators, docstrings, and exports.
 *
 * When a model is provided, uses an LLM to generate a high-quality summary
 * that explains the file's purpose and architecture. Without a model, falls
 * back to a deterministic template-based summary.
 */
export namespace PythonExplorer {
  const log = Log.create({ service: "lcm.explore.python" })

  /**
   * Maximum number of sample items to show per category
   */
  const MAX_SAMPLE_ITEMS = 20

  /**
   * Maximum docstring length to show in samples
   */
  const MAX_DOCSTRING_LENGTH = 100

  /**
   * Built-in Python modules (standard library)
   */
  const BUILTIN_MODULES = new Set([
    // Core
    "abc",
    "aifc",
    "argparse",
    "array",
    "ast",
    "asynchat",
    "asyncio",
    "asyncore",
    "atexit",
    "audioop",
    "base64",
    "bdb",
    "binascii",
    "binhex",
    "bisect",
    "builtins",
    "bz2",
    "calendar",
    "cgi",
    "cgitb",
    "chunk",
    "cmath",
    "cmd",
    "code",
    "codecs",
    "codeop",
    "collections",
    "colorsys",
    "compileall",
    "concurrent",
    "configparser",
    "contextlib",
    "contextvars",
    "copy",
    "copyreg",
    "cProfile",
    "crypt",
    "csv",
    "ctypes",
    "curses",
    "dataclasses",
    "datetime",
    "dbm",
    "decimal",
    "difflib",
    "dis",
    "distutils",
    "doctest",
    "email",
    "encodings",
    "enum",
    "errno",
    "faulthandler",
    "fcntl",
    "filecmp",
    "fileinput",
    "fnmatch",
    "fractions",
    "ftplib",
    "functools",
    "gc",
    "getopt",
    "getpass",
    "gettext",
    "glob",
    "graphlib",
    "grp",
    "gzip",
    "hashlib",
    "heapq",
    "hmac",
    "html",
    "http",
    "idlelib",
    "imaplib",
    "imghdr",
    "imp",
    "importlib",
    "inspect",
    "io",
    "ipaddress",
    "itertools",
    "json",
    "keyword",
    "lib2to3",
    "linecache",
    "locale",
    "logging",
    "lzma",
    "mailbox",
    "mailcap",
    "marshal",
    "math",
    "mimetypes",
    "mmap",
    "modulefinder",
    "multiprocessing",
    "netrc",
    "nis",
    "nntplib",
    "numbers",
    "operator",
    "optparse",
    "os",
    "ossaudiodev",
    "pathlib",
    "pdb",
    "pickle",
    "pickletools",
    "pipes",
    "pkgutil",
    "platform",
    "plistlib",
    "poplib",
    "posix",
    "posixpath",
    "pprint",
    "profile",
    "pstats",
    "pty",
    "pwd",
    "py_compile",
    "pyclbr",
    "pydoc",
    "queue",
    "quopri",
    "random",
    "re",
    "readline",
    "reprlib",
    "resource",
    "rlcompleter",
    "runpy",
    "sched",
    "secrets",
    "select",
    "selectors",
    "shelve",
    "shlex",
    "shutil",
    "signal",
    "site",
    "smtpd",
    "smtplib",
    "sndhdr",
    "socket",
    "socketserver",
    "spwd",
    "sqlite3",
    "ssl",
    "stat",
    "statistics",
    "string",
    "stringprep",
    "struct",
    "subprocess",
    "sunau",
    "symtable",
    "sys",
    "sysconfig",
    "syslog",
    "tabnanny",
    "tarfile",
    "telnetlib",
    "tempfile",
    "termios",
    "test",
    "textwrap",
    "threading",
    "time",
    "timeit",
    "tkinter",
    "token",
    "tokenize",
    "tomllib",
    "trace",
    "traceback",
    "tracemalloc",
    "tty",
    "turtle",
    "turtledemo",
    "types",
    "typing",
    "typing_extensions",
    "unicodedata",
    "unittest",
    "urllib",
    "uu",
    "uuid",
    "venv",
    "warnings",
    "wave",
    "weakref",
    "webbrowser",
    "winreg",
    "winsound",
    "wsgiref",
    "xdrlib",
    "xml",
    "xmlrpc",
    "zipapp",
    "zipfile",
    "zipimport",
    "zlib",
    "zoneinfo",
    // Typing related
    "typing",
    "typing_extensions",
    // underscore modules
    "__future__",
    "_thread",
  ])

  /**
   * Import information
   */
  export interface ImportInfo {
    /** Built-in Python modules (os, sys, etc.) */
    builtin: string[]
    /** Third-party packages (numpy, requests, etc.) */
    thirdParty: string[]
    /** Local imports (relative imports, project modules) */
    local: string[]
  }

  /**
   * Class information
   */
  export interface ClassInfo {
    name: string
    baseClasses: string[]
    decorators: string[]
    methodCount: number
    docstring?: string
    isDataclass: boolean
    isAbstract: boolean
  }

  /**
   * Function information
   */
  export interface FunctionInfo {
    name: string
    decorators: string[]
    parameters: string[]
    returnType?: string
    docstring?: string
    isAsync: boolean
    isGenerator: boolean
  }

  /**
   * Global variable information
   */
  export interface GlobalInfo {
    name: string
    hasTypeAnnotation: boolean
    isConstant: boolean
  }

  /**
   * Metadata about the Python file
   */
  export interface PythonMetadata {
    /** Line count */
    lineCount: number
    /** Import information */
    imports: ImportInfo
    /** Classes defined */
    classes: ClassInfo[]
    /** Functions defined (module-level) */
    functions: FunctionInfo[]
    /** Global variables/constants */
    globals: GlobalInfo[]
    /** Exports (__all__ list) */
    exports: string[]
    /** Whether the file has a main block */
    hasMain: boolean
    /** Module docstring */
    moduleDocstring?: string
    /** Whether typing is used */
    usesTyping: boolean
    /** Python version hints (if detected from shebang or syntax) */
    pythonVersion?: string
    /** Is this a stub file (.pyi) */
    isStubFile: boolean
  }

  /**
   * Result of Python exploration
   */
  export interface PythonExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Python file */
    metadata: PythonMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Parse state for tracking multiline strings and other context
   */
  interface ParseState {
    inMultilineString: boolean
    multilineStringDelimiter: string
    inClass: boolean
    currentClassName: string
    classIndent: number
    methodCount: number
  }

  /**
   * Extract the module name from an import statement
   */
  function extractModuleName(importLine: string): string[] {
    const modules: string[] = []

    // Handle "import X" or "import X, Y, Z"
    const simpleImportMatch = importLine.match(/^import\s+(.+)$/)
    if (simpleImportMatch) {
      const parts = simpleImportMatch[1].split(",").map(
        (p) =>
          p
            .trim()
            .split(/\s+as\s+/)[0]
            .split(".")[0],
      )
      modules.push(...parts)
      return modules
    }

    // Handle "from X import Y" or "from X import Y, Z"
    const fromImportMatch = importLine.match(/^from\s+(\S+)\s+import/)
    if (fromImportMatch) {
      const moduleName = fromImportMatch[1].split(".")[0]
      modules.push(moduleName)
      return modules
    }

    return modules
  }

  /**
   * Categorize an import as builtin, third-party, or local
   */
  function categorizeImport(moduleName: string, isRelative: boolean): "builtin" | "thirdParty" | "local" {
    if (isRelative) return "local"
    if (BUILTIN_MODULES.has(moduleName)) return "builtin"
    return "thirdParty"
  }

  /**
   * Parse a class definition line
   */
  function parseClassLine(line: string, decorators: string[]): { name: string; baseClasses: string[] } | null {
    const match = line.match(/^class\s+(\w+)(?:\s*\(\s*([^)]*)\s*\))?:/)
    if (!match) return null

    const name = match[1]
    const baseClassesStr = match[2] || ""
    const baseClasses = baseClassesStr
      .split(",")
      .map((b) => b.trim())
      .filter((b) => b.length > 0)

    return { name, baseClasses }
  }

  /**
   * Parse a function definition line
   */
  function parseFunctionLine(
    line: string,
    decorators: string[],
  ): { name: string; parameters: string[]; returnType?: string; isAsync: boolean } | null {
    const isAsync = line.trimStart().startsWith("async ")
    const funcLine = isAsync ? line.replace(/^\s*async\s+/, "") : line

    const match = funcLine.match(/^def\s+(\w+)\s*\(\s*([^)]*)\s*\)(?:\s*->\s*([^:]+))?:/)
    if (!match) return null

    const name = match[1]
    const paramsStr = match[2] || ""
    const returnType = match[3]?.trim()

    // Parse parameters (simplified - just extract names)
    const parameters: string[] = []
    if (paramsStr.trim()) {
      // Handle nested brackets/parens in type annotations
      let depth = 0
      let current = ""
      for (const char of paramsStr) {
        if (char === "[" || char === "(" || char === "{") depth++
        if (char === "]" || char === ")" || char === "}") depth--
        if (char === "," && depth === 0) {
          const param = current.trim().split(":")[0].split("=")[0].trim()
          if (param && param !== "*" && param !== "**") parameters.push(param)
          current = ""
        } else {
          current += char
        }
      }
      if (current.trim()) {
        const param = current.trim().split(":")[0].split("=")[0].trim()
        if (param && param !== "*" && param !== "**") parameters.push(param)
      }
    }

    return { name, parameters, returnType, isAsync }
  }

  /**
   * Extract decorator name from a decorator line
   */
  function extractDecoratorName(line: string): string | null {
    const match = line.match(/^\s*@(\w+(?:\.\w+)*)(?:\s*\(|$)/)
    return match ? match[1] : null
  }

  /**
   * Extract docstring from following lines
   */
  function extractDocstring(lines: string[], startIndex: number): string | null {
    if (startIndex >= lines.length) return null

    const line = lines[startIndex].trim()
    const delimiters = ['"""', "'''"]

    for (const delim of delimiters) {
      if (line.startsWith(delim)) {
        // Single line docstring
        if (line.length > delim.length && line.endsWith(delim)) {
          return line.slice(delim.length, -delim.length).trim()
        }

        // Multi-line docstring
        let docstring = line.slice(delim.length)
        for (let i = startIndex + 1; i < lines.length; i++) {
          const nextLine = lines[i]
          if (nextLine.includes(delim)) {
            docstring += "\n" + nextLine.slice(0, nextLine.indexOf(delim))
            break
          }
          docstring += "\n" + nextLine
        }
        return docstring.trim()
      }
    }

    return null
  }

  /**
   * Truncate docstring for display
   */
  function truncateDocstring(docstring: string | undefined): string | undefined {
    if (!docstring) return undefined
    const firstLine = docstring.split("\n")[0].trim()
    if (firstLine.length <= MAX_DOCSTRING_LENGTH) return firstLine
    return firstLine.slice(0, MAX_DOCSTRING_LENGTH - 3) + "..."
  }

  /**
   * Parse __all__ exports
   */
  function parseAllExports(content: string): string[] {
    const match = content.match(/__all__\s*=\s*\[([^\]]*)\]/)
    if (!match) return []

    const exports = match[1]
      .split(",")
      .map((e) => e.trim().replace(/["']/g, ""))
      .filter((e) => e.length > 0)

    return exports
  }

  /**
   * Detect Python version from shebang or syntax hints
   */
  function detectPythonVersion(lines: string[]): string | undefined {
    if (lines.length === 0) return undefined

    const firstLine = lines[0]
    if (firstLine.startsWith("#!")) {
      const match = firstLine.match(/python(\d+\.?\d*)/)
      if (match) return match[1]
    }

    return undefined
  }

  /**
   * Check if a variable name looks like a constant (ALL_CAPS)
   */
  function isConstantName(name: string): boolean {
    return /^[A-Z][A-Z0-9_]*$/.test(name)
  }

  /**
   * Parse global variable assignment
   */
  function parseGlobalAssignment(line: string): GlobalInfo | null {
    // Skip lines that are class/function definitions
    if (/^\s*(class|def|async\s+def)\s+/.test(line)) return null

    // Match: NAME = value or NAME: type = value
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+))?\s*=/)
    if (!match) return null

    const name = match[1]
    const hasTypeAnnotation = !!match[2]

    // Skip private variables (leading underscore) unless they're constants
    if (name.startsWith("_") && !isConstantName(name)) return null

    return {
      name,
      hasTypeAnnotation,
      isConstant: isConstantName(name),
    }
  }

  /**
   * Format the Python summary
   */
  function formatSummary(filePath: string, metadata: PythonMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: Python${metadata.isStubFile ? " Stub (.pyi)" : ""}`)
    if (metadata.pythonVersion) {
      lines.push(`Python Version: ${metadata.pythonVersion}`)
    }
    lines.push(`Lines: ${metadata.lineCount.toLocaleString("en-US")}`)
    lines.push("")

    // Module docstring
    if (metadata.moduleDocstring) {
      lines.push("Module Description:")
      lines.push(`  ${truncateDocstring(metadata.moduleDocstring)}`)
      lines.push("")
    }

    // Imports
    const totalImports =
      metadata.imports.builtin.length + metadata.imports.thirdParty.length + metadata.imports.local.length
    if (totalImports > 0) {
      lines.push("Imports:")
      if (metadata.imports.builtin.length > 0) {
        lines.push(
          `  Built-in (${metadata.imports.builtin.length}): ${metadata.imports.builtin.slice(0, 10).join(", ")}${metadata.imports.builtin.length > 10 ? ", ..." : ""}`,
        )
      }
      if (metadata.imports.thirdParty.length > 0) {
        lines.push(
          `  Third-party (${metadata.imports.thirdParty.length}): ${metadata.imports.thirdParty.slice(0, 10).join(", ")}${metadata.imports.thirdParty.length > 10 ? ", ..." : ""}`,
        )
      }
      if (metadata.imports.local.length > 0) {
        lines.push(
          `  Local (${metadata.imports.local.length}): ${metadata.imports.local.slice(0, 10).join(", ")}${metadata.imports.local.length > 10 ? ", ..." : ""}`,
        )
      }
      lines.push("")
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push(`Classes (${metadata.classes.length}):`)
      for (const cls of metadata.classes.slice(0, MAX_SAMPLE_ITEMS)) {
        const decoratorStr = cls.decorators.length > 0 ? `@${cls.decorators.join(", @")} ` : ""
        const baseStr = cls.baseClasses.length > 0 ? `(${cls.baseClasses.join(", ")})` : ""
        const flags: string[] = []
        if (cls.isDataclass) flags.push("dataclass")
        if (cls.isAbstract) flags.push("abstract")
        const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : ""
        lines.push(`  ${decoratorStr}${cls.name}${baseStr}${flagStr} - ${cls.methodCount} methods`)
        if (cls.docstring) {
          lines.push(`    "${truncateDocstring(cls.docstring)}"`)
        }
      }
      if (metadata.classes.length > MAX_SAMPLE_ITEMS) {
        lines.push(`  ... and ${metadata.classes.length - MAX_SAMPLE_ITEMS} more classes`)
      }
      lines.push("")
    }

    // Functions
    if (metadata.functions.length > 0) {
      lines.push(`Functions (${metadata.functions.length}):`)
      for (const func of metadata.functions.slice(0, MAX_SAMPLE_ITEMS)) {
        const decoratorStr = func.decorators.length > 0 ? `@${func.decorators.join(", @")} ` : ""
        const asyncStr = func.isAsync ? "async " : ""
        const genStr = func.isGenerator ? " (generator)" : ""
        const returnStr = func.returnType ? ` -> ${func.returnType}` : ""
        lines.push(`  ${decoratorStr}${asyncStr}${func.name}(${func.parameters.join(", ")})${returnStr}${genStr}`)
        if (func.docstring) {
          lines.push(`    "${truncateDocstring(func.docstring)}"`)
        }
      }
      if (metadata.functions.length > MAX_SAMPLE_ITEMS) {
        lines.push(`  ... and ${metadata.functions.length - MAX_SAMPLE_ITEMS} more functions`)
      }
      lines.push("")
    }

    // Global variables/constants
    const constants = metadata.globals.filter((g) => g.isConstant)
    const variables = metadata.globals.filter((g) => !g.isConstant)

    if (constants.length > 0) {
      lines.push(`Constants (${constants.length}):`)
      lines.push(
        `  ${constants
          .slice(0, 15)
          .map((c) => c.name)
          .join(", ")}${constants.length > 15 ? ", ..." : ""}`,
      )
      lines.push("")
    }

    if (variables.length > 0) {
      lines.push(`Global Variables (${variables.length}):`)
      lines.push(
        `  ${variables
          .slice(0, 15)
          .map((v) => v.name)
          .join(", ")}${variables.length > 15 ? ", ..." : ""}`,
      )
      lines.push("")
    }

    // Exports
    if (metadata.exports.length > 0) {
      lines.push(`Exports (__all__):`)
      lines.push(`  ${metadata.exports.slice(0, 20).join(", ")}${metadata.exports.length > 20 ? ", ..." : ""}`)
      lines.push("")
    }

    // Features
    const features: string[] = []
    if (metadata.hasMain) features.push("has main block")
    if (metadata.usesTyping) features.push("uses type hints")
    if (metadata.isStubFile) features.push("stub file")

    if (features.length > 0) {
      lines.push(`Features: ${features.join(", ")}`)
    }

    return lines.join("\n").trimEnd()
  }

  /**
   * Input for exploring a Python file
   */
  export interface ExploreInput {
    /** The file content to explore */
    content: string
    /** Optional file path for context */
    filePath?: string
    /** Optional model for agent-based summary generation */
    model?: Provider.Model
    /** Optional session ID for spawning exploration agent */
    sessionID?: string
    /** Optional abort signal */
    abort?: AbortSignal
  }

  /**
   * Explore a Python file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<PythonExplorationResult> {
    const filePath = input.filePath ?? "unknown.py"
    log.info("exploring Python file", { filePath })

    try {
      const lines = input.content.split("\n")
      const lineCount = lines.length
      const isStubFile = filePath.endsWith(".pyi")

      // Initialize metadata
      const imports: ImportInfo = {
        builtin: [],
        thirdParty: [],
        local: [],
      }
      const classes: ClassInfo[] = []
      const functions: FunctionInfo[] = []
      const globals: GlobalInfo[] = []
      let hasMain = false
      let usesTyping = false
      const pythonVersion = detectPythonVersion(lines)

      // Parse __all__ exports
      const exports = parseAllExports(input.content)

      // Extract module docstring (first string literal after shebang/encoding)
      let moduleDocstring: string | undefined
      let docstringStartLine = 0
      for (let i = 0; i < Math.min(lines.length, 10); i++) {
        const line = lines[i].trim()
        if (line.startsWith("#")) continue
        if (line === "") continue
        if (line.startsWith('"""') || line.startsWith("'''")) {
          moduleDocstring = extractDocstring(lines, i) ?? undefined
          break
        }
        // If we hit a non-comment, non-string line, no module docstring
        break
      }

      // Track state for parsing
      const pendingDecorators: string[] = []
      let inClass = false
      let currentClass: ClassInfo | null = null
      let classIndentLevel = 0

      // Check for typing usage
      if (
        input.content.includes("from typing import") ||
        input.content.includes("import typing") ||
        input.content.includes(": ") ||
        input.content.includes("->")
      ) {
        usesTyping = true
      }

      // Check for main block
      if (input.content.includes('if __name__ == "__main__"') || input.content.includes("if __name__ == '__main__'")) {
        hasMain = true
      }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const trimmedLine = line.trim()
        const indent = line.length - line.trimStart().length

        // Skip empty lines and comments (but process decorators)
        if (trimmedLine === "" || (trimmedLine.startsWith("#") && !trimmedLine.startsWith("@"))) {
          continue
        }

        // Track when we exit a class
        if (
          inClass &&
          currentClass &&
          indent <= classIndentLevel &&
          trimmedLine !== "" &&
          !trimmedLine.startsWith("@")
        ) {
          // Exiting class scope
          classes.push(currentClass)
          inClass = false
          currentClass = null
        }

        // Handle decorators
        if (trimmedLine.startsWith("@")) {
          const decoratorName = extractDecoratorName(trimmedLine)
          if (decoratorName) {
            pendingDecorators.push(decoratorName)
          }
          continue
        }

        // Handle imports
        if (trimmedLine.startsWith("import ") || trimmedLine.startsWith("from ")) {
          const isRelative = trimmedLine.startsWith("from .")
          const moduleNames = extractModuleName(trimmedLine)

          for (const moduleName of moduleNames) {
            if (!moduleName) continue
            const category = categorizeImport(moduleName, isRelative)

            // Deduplicate
            if (category === "builtin" && !imports.builtin.includes(moduleName)) {
              imports.builtin.push(moduleName)
            } else if (category === "thirdParty" && !imports.thirdParty.includes(moduleName)) {
              imports.thirdParty.push(moduleName)
            } else if (category === "local" && !imports.local.includes(moduleName)) {
              imports.local.push(moduleName)
            }
          }
          continue
        }

        // Handle class definitions
        if (trimmedLine.startsWith("class ")) {
          const classInfo = parseClassLine(trimmedLine, pendingDecorators)
          if (classInfo) {
            const isDataclass =
              pendingDecorators.includes("dataclass") || pendingDecorators.includes("dataclasses.dataclass")
            const isAbstract =
              classInfo.baseClasses.includes("ABC") ||
              classInfo.baseClasses.includes("abc.ABC") ||
              pendingDecorators.includes("abstractmethod")

            // Get class docstring
            const classDocstring = extractDocstring(lines, i + 1) ?? undefined

            currentClass = {
              name: classInfo.name,
              baseClasses: classInfo.baseClasses,
              decorators: [...pendingDecorators],
              methodCount: 0,
              docstring: classDocstring,
              isDataclass,
              isAbstract,
            }
            inClass = true
            classIndentLevel = indent
          }
          pendingDecorators.length = 0
          continue
        }

        // Handle function definitions
        if (trimmedLine.startsWith("def ") || trimmedLine.startsWith("async def ")) {
          const funcInfo = parseFunctionLine(trimmedLine, pendingDecorators)
          if (funcInfo) {
            // Check if it's a generator
            const isGenerator = checkIfGenerator(lines, i)

            // Get function docstring
            const funcDocstring = extractDocstring(lines, i + 1) ?? undefined

            if (inClass && currentClass) {
              // It's a method
              currentClass.methodCount++
            } else {
              // It's a module-level function
              functions.push({
                name: funcInfo.name,
                decorators: [...pendingDecorators],
                parameters: funcInfo.parameters,
                returnType: funcInfo.returnType,
                docstring: funcDocstring,
                isAsync: funcInfo.isAsync,
                isGenerator,
              })
            }
          }
          pendingDecorators.length = 0
          continue
        }

        // Handle global variable assignments (only at module level)
        if (!inClass && indent === 0) {
          const globalInfo = parseGlobalAssignment(trimmedLine)
          if (globalInfo && !globals.some((g) => g.name === globalInfo.name)) {
            globals.push(globalInfo)
          }
        }

        // Clear decorators if we hit something that's not a class/function
        pendingDecorators.length = 0
      }

      // Don't forget the last class if we were still in one
      if (inClass && currentClass) {
        classes.push(currentClass)
      }

      const metadata: PythonMetadata = {
        lineCount,
        imports,
        classes,
        functions,
        globals,
        exports,
        hasMain,
        moduleDocstring,
        usesTyping,
        pythonVersion,
        isStubFile,
      }

      // Generate summary - use exploration agent if model and sessionID provided
      let summary: string
      let tokenCount: number

      if (input.model && input.sessionID) {
        // Generate agent-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(filePath, metadata)
        const agentResult = await generateAgentSummary({
          content: input.content,
          filePath,
          language: "Python",
          structuredMetadata,
          model: input.model,
          sessionID: input.sessionID,
          abort: input.abort,
        })
        summary = agentResult.summary
        tokenCount = agentResult.tokenCount
      } else {
        // Fall back to template-based summary (for testing or when no session context)
        summary = formatSummary(filePath, metadata)
        tokenCount = Token.estimate(summary)
      }

      log.info("Python exploration complete", {
        filePath,
        lineCount,
        classCount: classes.length,
        functionCount: functions.length,
        importCount: imports.builtin.length + imports.thirdParty.length + imports.local.length,
        tokenCount,
        usedLLM: !!input.model,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse Python file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          lineCount: 0,
          imports: { builtin: [], thirdParty: [], local: [] },
          classes: [],
          functions: [],
          globals: [],
          exports: [],
          hasMain: false,
          usesTyping: false,
          isStubFile: false,
        },
        tokenCount: 0,
        error: `Failed to parse Python file: ${errorMessage}`,
      }
    }
  }

  /**
   * Check if a function contains yield statements (making it a generator)
   */
  function checkIfGenerator(lines: string[], funcStartLine: number): boolean {
    const startIndent = lines[funcStartLine].length - lines[funcStartLine].trimStart().length

    for (let i = funcStartLine + 1; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()
      if (trimmed === "") continue

      const indent = line.length - line.trimStart().length

      // If we hit a line with same or less indent (and not empty/comment), we've left the function
      if (indent <= startIndent && !trimmed.startsWith("#")) {
        break
      }

      // Check for yield
      if (/\byield\b/.test(trimmed)) {
        return true
      }
    }

    return false
  }
}
