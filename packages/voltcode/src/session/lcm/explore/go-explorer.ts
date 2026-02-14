import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Go File Exploration Agent
 *
 * Analyzes Go source files (.go) and produces structured summaries that describe
 * the package, imports, types, functions, and other Go-specific constructs.
 */
export namespace GoExplorer {
  const log = Log.create({ service: "lcm.explore.go" })

  /**
   * Information about imports
   */
  export interface ImportInfo {
    /** Standard library imports (fmt, os, net/http, etc.) */
    stdlib: string[]
    /** Third-party packages (github.com/..., etc.) */
    thirdParty: string[]
    /** Local/project-relative imports */
    local: string[]
  }

  /**
   * Information about a Go type definition
   */
  export interface TypeDef {
    /** Name of the type */
    name: string
    /** Type kind: struct, interface, alias, or other */
    kind: "struct" | "interface" | "alias" | "other"
    /** Whether the type is exported (capitalized) */
    exported: boolean
    /** Field/method count for structs/interfaces */
    memberCount?: number
  }

  /**
   * Information about a Go function
   */
  export interface FunctionDef {
    /** Function name */
    name: string
    /** Receiver type (for methods), e.g., "*Server" or "Config" */
    receiver?: string
    /** Parameter types (simplified) */
    params: string[]
    /** Return types (simplified) */
    returns: string[]
    /** Whether the function is exported (capitalized) */
    exported: boolean
  }

  /**
   * Information about a global variable or constant
   */
  export interface GlobalDef {
    /** Variable/constant name */
    name: string
    /** Whether it's a const or var */
    kind: "const" | "var"
    /** Whether it's exported (capitalized) */
    exported: boolean
  }

  /**
   * Metadata about the Go file
   */
  export interface GoMetadata {
    /** Package name (e.g., "main", "foo") */
    packageName: string
    /** Import information */
    imports: ImportInfo
    /** Type definitions (structs, interfaces, type aliases) */
    types: TypeDef[]
    /** Function definitions */
    functions: FunctionDef[]
    /** Global variables and constants */
    globals: GlobalDef[]
    /** Whether the file has a main function */
    hasMain: boolean
    /** Number of init functions */
    initCount: number
    /** List of exported symbols */
    exports: string[]
    /** Build constraints (//go:build tags) */
    buildConstraints: string[]
    /** Line count */
    lineCount: number
  }

  /**
   * Result of Go exploration
   */
  export interface GoExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Go file */
    metadata: GoMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring a Go file
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
   * Standard library package prefixes
   */
  const STDLIB_PACKAGES = new Set([
    "archive",
    "bufio",
    "builtin",
    "bytes",
    "compress",
    "container",
    "context",
    "crypto",
    "database",
    "debug",
    "embed",
    "encoding",
    "errors",
    "expvar",
    "flag",
    "fmt",
    "go",
    "hash",
    "html",
    "image",
    "index",
    "io",
    "log",
    "maps",
    "math",
    "mime",
    "net",
    "os",
    "path",
    "plugin",
    "reflect",
    "regexp",
    "runtime",
    "slices",
    "sort",
    "strconv",
    "strings",
    "sync",
    "syscall",
    "testing",
    "text",
    "time",
    "unicode",
    "unsafe",
  ])

  /**
   * Check if an import path is a standard library package
   */
  function isStdlib(importPath: string): boolean {
    const firstPart = importPath.split("/")[0]
    return STDLIB_PACKAGES.has(firstPart)
  }

  /**
   * Check if an import path is a third-party package
   */
  function isThirdParty(importPath: string): boolean {
    // Third-party packages typically have a domain in the path
    return importPath.includes(".") && !importPath.startsWith(".")
  }

  /**
   * Check if a name is exported (starts with uppercase)
   */
  function isExported(name: string): boolean {
    return /^[A-Z]/.test(name)
  }

  /**
   * Extract package name from content
   */
  function extractPackageName(content: string): string {
    const match = content.match(/^package\s+(\w+)/m)
    return match ? match[1] : "unknown"
  }

  /**
   * Extract imports from content
   */
  function extractImports(content: string): ImportInfo {
    const result: ImportInfo = { stdlib: [], thirdParty: [], local: [] }

    // Match single import: import "fmt"
    const singleImportRegex = /^import\s+"([^"]+)"/gm
    let match
    while ((match = singleImportRegex.exec(content)) !== null) {
      categorizeImport(match[1], result)
    }

    // Match import block: import ( ... )
    const blockImportRegex = /import\s*\(\s*([\s\S]*?)\s*\)/g
    while ((match = blockImportRegex.exec(content)) !== null) {
      const block = match[1]
      // Match each import line in block, handling aliases
      const lineRegex = /(?:\w+\s+)?"([^"]+)"/g
      let lineMatch
      while ((lineMatch = lineRegex.exec(block)) !== null) {
        categorizeImport(lineMatch[1], result)
      }
    }

    return result
  }

  /**
   * Categorize an import path into stdlib, thirdParty, or local
   */
  function categorizeImport(importPath: string, result: ImportInfo): void {
    if (isStdlib(importPath)) {
      result.stdlib.push(importPath)
    } else if (isThirdParty(importPath)) {
      result.thirdParty.push(importPath)
    } else {
      result.local.push(importPath)
    }
  }

  /**
   * Extract type definitions from content
   */
  function extractTypes(content: string): TypeDef[] {
    const types: TypeDef[] = []

    // Match struct type definitions
    const structRegex = /type\s+(\w+)\s+struct\s*\{([^}]*)\}/g
    let match
    while ((match = structRegex.exec(content)) !== null) {
      const name = match[1]
      const body = match[2]
      const memberCount = countStructFields(body)
      types.push({
        name,
        kind: "struct",
        exported: isExported(name),
        memberCount,
      })
    }

    // Match interface type definitions
    const interfaceRegex = /type\s+(\w+)\s+interface\s*\{([^}]*)\}/g
    while ((match = interfaceRegex.exec(content)) !== null) {
      const name = match[1]
      const body = match[2]
      const memberCount = countInterfaceMethods(body)
      types.push({
        name,
        kind: "interface",
        exported: isExported(name),
        memberCount,
      })
    }

    // Match type aliases: type Foo = Bar or type Foo Bar
    const aliasRegex = /type\s+(\w+)\s*=?\s*([^{\s][^\n{]*?)(?:\n|$)/g
    while ((match = aliasRegex.exec(content)) !== null) {
      const name = match[1]
      const target = match[2].trim()
      // Skip if already captured as struct or interface
      if (types.some((t) => t.name === name)) continue
      // Skip if target starts with "struct" or "interface"
      if (target.startsWith("struct") || target.startsWith("interface")) continue
      types.push({
        name,
        kind: target.includes("=") ? "alias" : "other",
        exported: isExported(name),
      })
    }

    return types
  }

  /**
   * Count fields in a struct body
   */
  function countStructFields(body: string): number {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("/*"))
    return lines.length
  }

  /**
   * Count methods in an interface body
   */
  function countInterfaceMethods(body: string): number {
    const lines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("//") && !l.startsWith("/*"))
    return lines.length
  }

  /**
   * Extract function definitions from content
   */
  function extractFunctions(content: string): FunctionDef[] {
    const functions: FunctionDef[] = []

    // Match function with receiver: func (r *Type) Name(params) returns
    // Match function without receiver: func Name(params) returns
    const funcRegex = /func\s+(?:\((\w+)\s+([*\w]+)\)\s+)?(\w+)\s*\(([^)]*)\)\s*(?:\(([^)]*)\)|([^\s{][^{]*))?/g
    let match
    while ((match = funcRegex.exec(content)) !== null) {
      const receiverVar = match[1]
      const receiverType = match[2]
      const name = match[3]
      const paramsStr = match[4]
      const multiReturnStr = match[5]
      const singleReturnStr = match[6]

      const params = parseParams(paramsStr)
      const returns = parseReturns(multiReturnStr, singleReturnStr)
      const receiver = receiverType ? (receiverVar ? `${receiverType}` : receiverType) : undefined

      functions.push({
        name,
        receiver,
        params,
        returns,
        exported: isExported(name),
      })
    }

    return functions
  }

  /**
   * Parse function parameters into simplified type list
   */
  function parseParams(paramsStr: string): string[] {
    if (!paramsStr.trim()) return []

    const params: string[] = []
    const parts = paramsStr.split(",")

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue
      // Extract just the type (last word, handling pointers/slices)
      const typeMatch = trimmed.match(/([*\[\]]*\w+(?:\.\w+)?)$/)
      if (typeMatch) {
        params.push(typeMatch[1])
      }
    }

    return params
  }

  /**
   * Parse function returns into simplified type list
   */
  function parseReturns(multiReturnStr: string | undefined, singleReturnStr: string | undefined): string[] {
    if (multiReturnStr) {
      return parseParams(multiReturnStr)
    }
    if (singleReturnStr) {
      const trimmed = singleReturnStr.trim()
      if (trimmed && trimmed !== "{") {
        return [trimmed]
      }
    }
    return []
  }

  /**
   * Extract global variables and constants
   */
  function extractGlobals(content: string): GlobalDef[] {
    const globals: GlobalDef[] = []

    // Match var blocks: var ( ... )
    const varBlockRegex = /var\s*\(\s*([\s\S]*?)\s*\)/g
    let match
    while ((match = varBlockRegex.exec(content)) !== null) {
      const block = match[1]
      extractNamesFromBlock(block, "var", globals)
    }

    // Match single var: var name type = value or var name = value
    const singleVarRegex = /^var\s+(\w+)\s/gm
    while ((match = singleVarRegex.exec(content)) !== null) {
      const name = match[1]
      if (!globals.some((g) => g.name === name)) {
        globals.push({ name, kind: "var", exported: isExported(name) })
      }
    }

    // Match const blocks: const ( ... )
    const constBlockRegex = /const\s*\(\s*([\s\S]*?)\s*\)/g
    while ((match = constBlockRegex.exec(content)) !== null) {
      const block = match[1]
      extractNamesFromBlock(block, "const", globals)
    }

    // Match single const: const name = value or const name type = value
    const singleConstRegex = /^const\s+(\w+)\s/gm
    while ((match = singleConstRegex.exec(content)) !== null) {
      const name = match[1]
      if (!globals.some((g) => g.name === name)) {
        globals.push({ name, kind: "const", exported: isExported(name) })
      }
    }

    return globals
  }

  /**
   * Extract names from a var/const block
   */
  function extractNamesFromBlock(block: string, kind: "var" | "const", globals: GlobalDef[]): void {
    const lines = block.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*")) continue

      // Match name at start of line
      const nameMatch = trimmed.match(/^(\w+)/)
      if (nameMatch) {
        const name = nameMatch[1]
        if (!globals.some((g) => g.name === name)) {
          globals.push({ name, kind, exported: isExported(name) })
        }
      }
    }
  }

  /**
   * Extract build constraints from content
   */
  function extractBuildConstraints(content: string): string[] {
    const constraints: string[] = []

    // Match //go:build tags
    const goBuildRegex = /^\/\/go:build\s+(.+)$/gm
    let match
    while ((match = goBuildRegex.exec(content)) !== null) {
      constraints.push(match[1])
    }

    // Match legacy // +build tags
    const plusBuildRegex = /^\/\/\s*\+build\s+(.+)$/gm
    while ((match = plusBuildRegex.exec(content)) !== null) {
      constraints.push(match[1])
    }

    return constraints
  }

  /**
   * Format the Go summary
   */
  function formatSummary(filePath: string, metadata: GoMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: Go`)
    lines.push(`Package: ${metadata.packageName}`)
    lines.push(`Lines: ${metadata.lineCount}`)
    lines.push("")

    // Build constraints
    if (metadata.buildConstraints.length > 0) {
      lines.push("Build Constraints:")
      for (const constraint of metadata.buildConstraints) {
        lines.push(`  //go:build ${constraint}`)
      }
      lines.push("")
    }

    // Imports summary
    const totalImports =
      metadata.imports.stdlib.length + metadata.imports.thirdParty.length + metadata.imports.local.length
    if (totalImports > 0) {
      lines.push(`Imports (${totalImports}):`)
      if (metadata.imports.stdlib.length > 0) {
        lines.push(`  Standard library (${metadata.imports.stdlib.length}):`)
        for (const imp of metadata.imports.stdlib.slice(0, 10)) {
          lines.push(`    - ${imp}`)
        }
        if (metadata.imports.stdlib.length > 10) {
          lines.push(`    ... and ${metadata.imports.stdlib.length - 10} more`)
        }
      }
      if (metadata.imports.thirdParty.length > 0) {
        lines.push(`  Third-party (${metadata.imports.thirdParty.length}):`)
        for (const imp of metadata.imports.thirdParty.slice(0, 10)) {
          lines.push(`    - ${imp}`)
        }
        if (metadata.imports.thirdParty.length > 10) {
          lines.push(`    ... and ${metadata.imports.thirdParty.length - 10} more`)
        }
      }
      if (metadata.imports.local.length > 0) {
        lines.push(`  Local (${metadata.imports.local.length}):`)
        for (const imp of metadata.imports.local.slice(0, 10)) {
          lines.push(`    - ${imp}`)
        }
        if (metadata.imports.local.length > 10) {
          lines.push(`    ... and ${metadata.imports.local.length - 10} more`)
        }
      }
      lines.push("")
    }

    // Types summary
    if (metadata.types.length > 0) {
      lines.push(`Types (${metadata.types.length}):`)
      for (const t of metadata.types.slice(0, 20)) {
        const exported = t.exported ? " (exported)" : ""
        const members = t.memberCount !== undefined ? ` [${t.memberCount} members]` : ""
        lines.push(`  - ${t.name}: ${t.kind}${members}${exported}`)
      }
      if (metadata.types.length > 20) {
        lines.push(`  ... and ${metadata.types.length - 20} more`)
      }
      lines.push("")
    }

    // Functions summary
    if (metadata.functions.length > 0) {
      lines.push(`Functions (${metadata.functions.length}):`)

      // Separate methods and standalone functions
      const methods = metadata.functions.filter((f) => f.receiver)
      const standalone = metadata.functions.filter((f) => !f.receiver)

      if (standalone.length > 0) {
        lines.push("  Standalone:")
        for (const f of standalone.slice(0, 15)) {
          const exported = f.exported ? " (exported)" : ""
          const params = f.params.length > 0 ? f.params.join(", ") : ""
          const returns = f.returns.length > 0 ? ` -> ${f.returns.join(", ")}` : ""
          lines.push(`    - ${f.name}(${params})${returns}${exported}`)
        }
        if (standalone.length > 15) {
          lines.push(`    ... and ${standalone.length - 15} more`)
        }
      }

      if (methods.length > 0) {
        lines.push("  Methods:")
        for (const f of methods.slice(0, 15)) {
          const exported = f.exported ? " (exported)" : ""
          const params = f.params.length > 0 ? f.params.join(", ") : ""
          const returns = f.returns.length > 0 ? ` -> ${f.returns.join(", ")}` : ""
          lines.push(`    - (${f.receiver}) ${f.name}(${params})${returns}${exported}`)
        }
        if (methods.length > 15) {
          lines.push(`    ... and ${methods.length - 15} more`)
        }
      }
      lines.push("")
    }

    // Globals summary
    if (metadata.globals.length > 0) {
      const vars = metadata.globals.filter((g) => g.kind === "var")
      const consts = metadata.globals.filter((g) => g.kind === "const")

      lines.push(`Globals (${metadata.globals.length}):`)
      if (consts.length > 0) {
        lines.push(`  Constants (${consts.length}):`)
        for (const c of consts.slice(0, 10)) {
          const exported = c.exported ? " (exported)" : ""
          lines.push(`    - ${c.name}${exported}`)
        }
        if (consts.length > 10) {
          lines.push(`    ... and ${consts.length - 10} more`)
        }
      }
      if (vars.length > 0) {
        lines.push(`  Variables (${vars.length}):`)
        for (const v of vars.slice(0, 10)) {
          const exported = v.exported ? " (exported)" : ""
          lines.push(`    - ${v.name}${exported}`)
        }
        if (vars.length > 10) {
          lines.push(`    ... and ${vars.length - 10} more`)
        }
      }
      lines.push("")
    }

    // Special indicators
    const indicators: string[] = []
    if (metadata.hasMain) indicators.push("main()")
    if (metadata.initCount > 0) indicators.push(`${metadata.initCount} init()`)
    if (metadata.exports.length > 0) indicators.push(`${metadata.exports.length} exports`)

    if (indicators.length > 0) {
      lines.push(`Special: ${indicators.join(", ")}`)
    }

    return lines.join("\n")
  }

  /**
   * Explore a Go file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<GoExplorationResult> {
    const filePath = input.filePath ?? "unknown.go"
    log.info("exploring Go file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all components
      const packageName = extractPackageName(content)
      const imports = extractImports(content)
      const types = extractTypes(content)
      const functions = extractFunctions(content)
      const globals = extractGlobals(content)
      const buildConstraints = extractBuildConstraints(content)

      // Detect main and init functions
      const hasMain = functions.some((f) => f.name === "main" && !f.receiver)
      const initCount = functions.filter((f) => f.name === "init" && !f.receiver).length

      // Collect all exported symbols
      const exports: string[] = []
      for (const t of types) {
        if (t.exported) exports.push(t.name)
      }
      for (const f of functions) {
        if (f.exported) exports.push(f.name)
      }
      for (const g of globals) {
        if (g.exported) exports.push(g.name)
      }

      const metadata: GoMetadata = {
        packageName,
        imports,
        types,
        functions,
        globals,
        hasMain,
        initCount,
        exports,
        buildConstraints,
        lineCount,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        // Generate LLM-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(filePath, metadata)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "Go",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        // Fall back to template-based summary
        summary = formatSummary(filePath, metadata)
        tokenCount = Token.estimate(summary)
      }

      log.info("Go exploration complete", {
        filePath,
        packageName,
        typeCount: types.length,
        functionCount: functions.length,
        hasMain,
        initCount,
        exportCount: exports.length,
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
      log.error("failed to explore Go file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          packageName: "unknown",
          imports: { stdlib: [], thirdParty: [], local: [] },
          types: [],
          functions: [],
          globals: [],
          hasMain: false,
          initCount: 0,
          exports: [],
          buildConstraints: [],
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to explore Go file: ${errorMessage}`,
      }
    }
  }
}
