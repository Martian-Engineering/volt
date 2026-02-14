import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Tcl File Exploration Agent
 *
 * Analyzes Tcl files (.tcl, .tk) and produces structured summaries showing
 * packages, procedures, namespaces, variables, and widget usage.
 */
export namespace TclExplorer {
  const log = Log.create({ service: "lcm.explore.tcl" })

  /**
   * Maximum string length to show in samples
   */
  const MAX_STRING_LENGTH = 50

  /**
   * Maximum number of items to show in lists
   */
  const MAX_LIST_ITEMS = 15

  /**
   * Procedure information
   */
  export interface ProcInfo {
    name: string
    args: string[]
    namespace?: string
    lineNumber: number
  }

  /**
   * Namespace information
   */
  export interface NamespaceInfo {
    name: string
    exports: string[]
    lineNumber: number
  }

  /**
   * Variable declaration information
   */
  export interface VariableInfo {
    name: string
    type: "variable" | "global" | "upvar"
    namespace?: string
    lineNumber: number
  }

  /**
   * Class information (itcl or TclOO)
   */
  export interface ClassInfo {
    name: string
    type: "itcl" | "oo"
    methods: string[]
    lineNumber: number
  }

  /**
   * Source file information
   */
  export interface SourceInfo {
    path: string
    lineNumber: number
  }

  /**
   * Package information
   */
  export interface PackageInfo {
    name: string
    version?: string
    lineNumber: number
  }

  /**
   * Metadata about the Tcl structure
   */
  export interface TclMetadata {
    /** Required packages */
    packages: PackageInfo[]
    /** Sourced files */
    sources: SourceInfo[]
    /** Procedure definitions */
    procs: ProcInfo[]
    /** Namespace definitions */
    namespaces: NamespaceInfo[]
    /** Variable declarations */
    variables: VariableInfo[]
    /** Whether Tk widgets are used */
    hasTk: boolean
    /** Tk widgets found */
    tkWidgets: string[]
    /** Whether OO classes are present (itcl or TclOO) */
    hasOO: boolean
    /** Class definitions */
    classes: ClassInfo[]
    /** Whether there is main execution code outside procs */
    hasMainCode: boolean
    /** Exported procedures */
    exports: string[]
    /** Total line count */
    lineCount: number
    /** Comment line count */
    commentCount: number
  }

  /**
   * Result of Tcl exploration
   */
  export interface TclExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Tcl file */
    metadata: TclMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring a Tcl file
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
   * Tk widget commands to detect
   */
  const TK_WIDGETS = [
    "button",
    "label",
    "entry",
    "text",
    "frame",
    "toplevel",
    "canvas",
    "listbox",
    "scrollbar",
    "menu",
    "menubutton",
    "message",
    "scale",
    "spinbox",
    "checkbutton",
    "radiobutton",
    "labelframe",
    "panedwindow",
    "ttk::button",
    "ttk::label",
    "ttk::entry",
    "ttk::frame",
    "ttk::notebook",
    "ttk::combobox",
    "ttk::treeview",
    "ttk::progressbar",
    "ttk::scale",
    "ttk::separator",
    "ttk::sizegrip",
    "ttk::scrollbar",
    "ttk::spinbox",
    "ttk::checkbutton",
    "ttk::radiobutton",
    "ttk::menubutton",
    "ttk::labelframe",
    "ttk::panedwindow",
  ]

  /**
   * Remove Tcl comments and string contents for safer parsing
   */
  function stripCommentsAndStrings(content: string): string {
    const lines = content.split("\n")
    const result: string[] = []

    for (const line of lines) {
      const trimmed = line.trim()
      // Skip full comment lines
      if (trimmed.startsWith("#")) {
        result.push("")
        continue
      }

      // Remove inline comments (simple heuristic - not perfect)
      let processedLine = line
      const commentIdx = line.indexOf(" #")
      if (commentIdx > 0) {
        // Check if it's inside a string (rough check)
        const beforeComment = line.slice(0, commentIdx)
        const quoteCount = (beforeComment.match(/"/g) || []).length
        if (quoteCount % 2 === 0) {
          processedLine = line.slice(0, commentIdx)
        }
      }

      result.push(processedLine)
    }

    return result.join("\n")
  }

  /**
   * Extract package require statements
   */
  function extractPackages(content: string): PackageInfo[] {
    const packages: PackageInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      // Match: package require name ?version?
      const match = line.match(/^package\s+require\s+(\S+)(?:\s+(\S+))?/)
      if (match) {
        packages.push({
          name: match[1],
          version: match[2],
          lineNumber: i + 1,
        })
      }
    }

    return packages
  }

  /**
   * Extract source commands
   */
  function extractSources(content: string): SourceInfo[] {
    const sources: SourceInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      // Match: source "file.tcl" or source file.tcl or source [file join ...]
      const match = line.match(/^source\s+(?:"([^"]+)"|'([^']+)'|\[([^\]]+)\]|(\S+))/)
      if (match) {
        const path = match[1] || match[2] || match[3] || match[4]
        sources.push({
          path,
          lineNumber: i + 1,
        })
      }
    }

    return sources
  }

  /**
   * Extract proc definitions
   */
  function extractProcs(content: string): ProcInfo[] {
    const procs: ProcInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      // Match: proc name {args} { or proc ::namespace::name {args} {
      const match = line.match(/^proc\s+([\w:]+)\s+\{([^}]*)\}/)
      if (match) {
        const fullName = match[1]
        const argsStr = match[2].trim()
        const args = argsStr ? argsStr.split(/\s+/) : []

        let namespace: string | undefined
        let name = fullName
        if (fullName.includes("::")) {
          const parts = fullName.split("::")
          name = parts.pop() || fullName
          namespace = parts.join("::")
        }

        procs.push({
          name,
          args,
          namespace,
          lineNumber: i + 1,
        })
      }
    }

    return procs
  }

  /**
   * Extract namespace definitions
   */
  function extractNamespaces(content: string): NamespaceInfo[] {
    const namespaces: NamespaceInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      // Match: namespace eval name { or namespace eval ::name {
      const match = line.match(/^namespace\s+eval\s+([\w:]+)/)
      if (match) {
        const name = match[1].replace(/^::/, "")
        namespaces.push({
          name,
          exports: [],
          lineNumber: i + 1,
        })
      }
    }

    return namespaces
  }

  /**
   * Extract namespace exports
   */
  function extractExports(content: string): string[] {
    const exports: string[] = []
    const lines = content.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()
      // Match: namespace export procName or namespace export {proc1 proc2}
      const match = trimmed.match(/^namespace\s+export\s+(?:\{([^}]+)\}|(.+))/)
      if (match) {
        const exportList = match[1] || match[2]
        const procs = exportList.trim().split(/\s+/)
        exports.push(...procs.filter((p) => p && !p.startsWith("-")))
      }
    }

    return [...new Set(exports)]
  }

  /**
   * Extract variable declarations
   */
  function extractVariables(content: string): VariableInfo[] {
    const variables: VariableInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match: variable name ?value?
      const varMatch = line.match(/^variable\s+(\w+)/)
      if (varMatch) {
        variables.push({
          name: varMatch[1],
          type: "variable",
          lineNumber: i + 1,
        })
        continue
      }

      // Match: global name1 ?name2? ...
      const globalMatch = line.match(/^global\s+(.+)/)
      if (globalMatch) {
        const names = globalMatch[1].trim().split(/\s+/)
        for (const name of names) {
          if (name && !name.startsWith("-")) {
            variables.push({
              name,
              type: "global",
              lineNumber: i + 1,
            })
          }
        }
        continue
      }

      // Match: upvar ?level? otherVar myVar
      const upvarMatch = line.match(/^upvar\s+(?:#?\d+\s+)?(\w+)\s+(\w+)/)
      if (upvarMatch) {
        variables.push({
          name: upvarMatch[2],
          type: "upvar",
          lineNumber: i + 1,
        })
      }
    }

    return variables
  }

  /**
   * Detect Tk widget usage
   */
  function detectTkWidgets(content: string): string[] {
    const found = new Set<string>()
    const stripped = stripCommentsAndStrings(content)

    for (const widget of TK_WIDGETS) {
      // Match widget command at start of line or after whitespace
      const regex = new RegExp(`(?:^|\\s)${widget.replace("::", "::")}\\s+`, "m")
      if (regex.test(stripped)) {
        found.add(widget)
      }
    }

    return Array.from(found).sort()
  }

  /**
   * Extract itcl and TclOO class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match: itcl::class ClassName { or ::itcl::class ClassName {
      const itclMatch = line.match(/^(?:::)?itcl::class\s+(\w+)/)
      if (itclMatch) {
        classes.push({
          name: itclMatch[1],
          type: "itcl",
          methods: [],
          lineNumber: i + 1,
        })
        continue
      }

      // Match: oo::class create ClassName { or ::oo::class create ClassName {
      const ooMatch = line.match(/^(?:::)?oo::class\s+create\s+(\w+)/)
      if (ooMatch) {
        classes.push({
          name: ooMatch[1],
          type: "oo",
          methods: [],
          lineNumber: i + 1,
        })
      }
    }

    return classes
  }

  /**
   * Detect if there is main execution code outside procs
   */
  function detectMainCode(content: string): boolean {
    const lines = content.split("\n")
    let inProc = false
    let braceCount = 0

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines and comments
      if (!trimmed || trimmed.startsWith("#")) continue

      // Skip package/namespace/proc declarations
      if (trimmed.match(/^(package|namespace|proc|itcl::|oo::class)\s/)) {
        if (trimmed.includes("{")) {
          inProc = true
          braceCount += (trimmed.match(/{/g) || []).length
          braceCount -= (trimmed.match(/}/g) || []).length
        }
        continue
      }

      // Track brace depth
      if (inProc) {
        braceCount += (trimmed.match(/{/g) || []).length
        braceCount -= (trimmed.match(/}/g) || []).length
        if (braceCount <= 0) {
          inProc = false
          braceCount = 0
        }
        continue
      }

      // If we're not in a proc and have executable code, we have main code
      if (!trimmed.startsWith("source") && !trimmed.startsWith("variable")) {
        // Check for actual commands (not just variable declarations)
        if (trimmed.match(/^[\w:]+\s/) || trimmed.match(/^\$\w+/)) {
          return true
        }
      }
    }

    return false
  }

  /**
   * Count comment lines
   */
  function countComments(content: string): number {
    const lines = content.split("\n")
    let count = 0

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith("#")) {
        count++
      }
    }

    return count
  }

  /**
   * Truncate a string to a maximum length
   */
  function truncate(value: string, maxLen: number): string {
    if (value.length <= maxLen) return value
    return value.slice(0, maxLen - 3) + "..."
  }

  /**
   * Format the Tcl summary
   */
  function formatSummary(filePath: string, metadata: TclMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: Tcl${metadata.hasTk ? "/Tk" : ""}${metadata.hasOO ? " (OO)" : ""}`)
    lines.push("")
    lines.push(`Structure:`)
    lines.push(`- Lines: ${metadata.lineCount}`)
    lines.push(`- Comments: ${metadata.commentCount}`)
    lines.push(`- Procedures: ${metadata.procs.length}`)
    lines.push(`- Namespaces: ${metadata.namespaces.length}`)
    if (metadata.variables.length > 0) {
      lines.push(`- Variables: ${metadata.variables.length}`)
    }
    if (metadata.hasMainCode) {
      lines.push(`- Has main execution code: yes`)
    }

    // Packages
    if (metadata.packages.length > 0) {
      lines.push("")
      lines.push("Required packages:")
      for (const pkg of metadata.packages.slice(0, MAX_LIST_ITEMS)) {
        const version = pkg.version ? ` ${pkg.version}` : ""
        lines.push(`  - ${pkg.name}${version}`)
      }
      if (metadata.packages.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.packages.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Sources
    if (metadata.sources.length > 0) {
      lines.push("")
      lines.push("Sourced files:")
      for (const src of metadata.sources.slice(0, MAX_LIST_ITEMS)) {
        lines.push(`  - ${truncate(src.path, MAX_STRING_LENGTH)}`)
      }
      if (metadata.sources.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.sources.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Namespaces
    if (metadata.namespaces.length > 0) {
      lines.push("")
      lines.push("Namespaces:")
      for (const ns of metadata.namespaces.slice(0, MAX_LIST_ITEMS)) {
        lines.push(`  - ${ns.name}`)
      }
      if (metadata.namespaces.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.namespaces.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Procedures
    if (metadata.procs.length > 0) {
      lines.push("")
      lines.push("Procedures:")
      for (const proc of metadata.procs.slice(0, MAX_LIST_ITEMS)) {
        const nsPrefix = proc.namespace ? `${proc.namespace}::` : ""
        const args = proc.args.length > 0 ? proc.args.join(" ") : ""
        lines.push(`  - ${nsPrefix}${proc.name} {${args}}`)
      }
      if (metadata.procs.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.procs.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Exports
    if (metadata.exports.length > 0) {
      lines.push("")
      lines.push("Exported procedures:")
      for (const exp of metadata.exports.slice(0, MAX_LIST_ITEMS)) {
        lines.push(`  - ${exp}`)
      }
      if (metadata.exports.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.exports.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push("")
      lines.push("Classes:")
      for (const cls of metadata.classes.slice(0, MAX_LIST_ITEMS)) {
        lines.push(`  - ${cls.name} (${cls.type})`)
      }
      if (metadata.classes.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.classes.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Variables
    if (metadata.variables.length > 0) {
      lines.push("")
      lines.push("Variables:")
      for (const v of metadata.variables.slice(0, MAX_LIST_ITEMS)) {
        lines.push(`  - ${v.name} (${v.type})`)
      }
      if (metadata.variables.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.variables.length - MAX_LIST_ITEMS} more`)
      }
    }

    // Tk widgets
    if (metadata.tkWidgets.length > 0) {
      lines.push("")
      lines.push("Tk widgets used:")
      lines.push(`  ${metadata.tkWidgets.join(", ")}`)
    }

    return lines.join("\n")
  }

  /**
   * Explore a Tcl file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<TclExplorationResult> {
    const filePath = input.filePath ?? "unknown.tcl"
    log.info("exploring Tcl file", { filePath })

    try {
      const content = input.content
      const lines = content.split("\n")

      // Extract all metadata
      const packages = extractPackages(content)
      const sources = extractSources(content)
      const procs = extractProcs(content)
      const namespaces = extractNamespaces(content)
      const variables = extractVariables(content)
      const tkWidgets = detectTkWidgets(content)
      const classes = extractClasses(content)
      const exports = extractExports(content)
      const hasMainCode = detectMainCode(content)
      const commentCount = countComments(content)

      const metadata: TclMetadata = {
        packages,
        sources,
        procs,
        namespaces,
        variables,
        hasTk: tkWidgets.length > 0,
        tkWidgets,
        hasOO: classes.length > 0,
        classes,
        hasMainCode,
        exports,
        lineCount: lines.length,
        commentCount,
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
          language: "Tcl",
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

      log.info("Tcl exploration complete", {
        filePath,
        packages: packages.length,
        procs: procs.length,
        namespaces: namespaces.length,
        hasTk: metadata.hasTk,
        hasOO: metadata.hasOO,
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
      log.error("failed to parse Tcl", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          packages: [],
          sources: [],
          procs: [],
          namespaces: [],
          variables: [],
          hasTk: false,
          tkWidgets: [],
          hasOO: false,
          classes: [],
          hasMainCode: false,
          exports: [],
          lineCount: 0,
          commentCount: 0,
        },
        tokenCount: 0,
        error: `Failed to parse Tcl: ${errorMessage}`,
      }
    }
  }
}
