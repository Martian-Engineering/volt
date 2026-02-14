import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * TypeScript File Exploration Agent
 *
 * Analyzes TypeScript files (.ts, .tsx, .mts, .cts) and produces structured
 * summaries extracting imports, interfaces, types, classes, functions,
 * exports, namespaces, enums, and React components.
 */
export namespace TypeScriptExplorer {
  const log = Log.create({ service: "lcm.explore.typescript" })

  /**
   * Maximum number of items to list in each category
   */
  const MAX_ITEMS = 15

  /**
   * Maximum text length for property/parameter summaries
   */
  const MAX_TEXT_LENGTH = 100

  /**
   * Import categorization
   */
  export interface ImportInfo {
    /** Node.js built-in modules */
    builtin: string[]
    /** Third-party packages (npm, @types, etc.) */
    thirdParty: string[]
    /** Local imports (relative paths) */
    local: string[]
  }

  /**
   * Interface definition info
   */
  export interface InterfaceInfo {
    name: string
    extends?: string[]
    properties: string
    isExported: boolean
  }

  /**
   * Type alias info
   */
  export interface TypeInfo {
    name: string
    definition: string
    isGeneric: boolean
    isExported: boolean
  }

  /**
   * Class definition info
   */
  export interface ClassInfo {
    name: string
    extends?: string
    implements?: string[]
    methods: string[]
    properties: string[]
    isExported: boolean
    isAbstract: boolean
  }

  /**
   * Function definition info
   */
  export interface FunctionInfo {
    name: string
    params: string
    returnType?: string
    isAsync: boolean
    isArrow: boolean
    isExported: boolean
    isGenerator: boolean
  }

  /**
   * Export info
   */
  export interface ExportInfo {
    /** Named exports */
    named: string[]
    /** Default export identifier or expression type */
    default?: string
    /** Re-exports (export * from, export { } from) */
    reExports: string[]
  }

  /**
   * Namespace/module declaration info
   */
  export interface NamespaceInfo {
    name: string
    isExported: boolean
    members: string[]
  }

  /**
   * Enum definition info
   */
  export interface EnumInfo {
    name: string
    members: string[]
    isConst: boolean
    isExported: boolean
  }

  /**
   * React component info
   */
  export interface ReactComponentInfo {
    name: string
    type: "function" | "class" | "arrow"
    hasProps: boolean
    propsType?: string
    isExported: boolean
  }

  /**
   * Metadata about the TypeScript structure
   */
  export interface TypeScriptMetadata {
    /** Import information */
    imports: ImportInfo
    /** Interface definitions */
    interfaces: InterfaceInfo[]
    /** Type alias definitions */
    types: TypeInfo[]
    /** Class definitions */
    classes: ClassInfo[]
    /** Function definitions */
    functions: FunctionInfo[]
    /** Export information */
    exports: ExportInfo
    /** Namespace/module declarations */
    namespaces: NamespaceInfo[]
    /** Enum definitions */
    enums: EnumInfo[]
    /** React components (if TSX) */
    reactComponents: ReactComponentInfo[]
    /** Whether the file is TSX (React) */
    isReact: boolean
    /** Whether there's top-level execution code */
    hasEntryPoint: boolean
    /** Line count */
    lineCount: number
    /** Detected module type */
    moduleType: "esm" | "commonjs" | "mixed" | "unknown"
  }

  /**
   * Result of TypeScript exploration
   */
  export interface TypeScriptExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the TypeScript file */
    metadata: TypeScriptMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Node.js built-in modules
   */
  const BUILTIN_MODULES = new Set([
    "assert",
    "async_hooks",
    "buffer",
    "child_process",
    "cluster",
    "console",
    "constants",
    "crypto",
    "dgram",
    "diagnostics_channel",
    "dns",
    "domain",
    "events",
    "fs",
    "fs/promises",
    "http",
    "http2",
    "https",
    "inspector",
    "module",
    "net",
    "os",
    "path",
    "perf_hooks",
    "process",
    "punycode",
    "querystring",
    "readline",
    "repl",
    "stream",
    "stream/promises",
    "stream/web",
    "string_decoder",
    "sys",
    "timers",
    "timers/promises",
    "tls",
    "trace_events",
    "tty",
    "url",
    "util",
    "v8",
    "vm",
    "wasi",
    "worker_threads",
    "zlib",
  ])

  /**
   * Check if module is a Node.js built-in
   */
  function isBuiltinModule(moduleName: string): boolean {
    const name = moduleName.replace(/^node:/, "")
    return BUILTIN_MODULES.has(name) || moduleName.startsWith("node:")
  }

  /**
   * Check if module is a local import
   */
  function isLocalImport(moduleName: string): boolean {
    return moduleName.startsWith(".") || moduleName.startsWith("/")
  }

  /**
   * Extract imports from content
   */
  function extractImports(content: string): ImportInfo {
    const imports: ImportInfo = {
      builtin: [],
      thirdParty: [],
      local: [],
    }

    // Match ES imports: import ... from "module"
    const esImportRegex = /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g
    let match
    while ((match = esImportRegex.exec(content)) !== null) {
      const moduleName = match[1]
      categorizeImport(moduleName, imports)
    }

    // Match dynamic imports: import("module") or await import("module")
    const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      const moduleName = match[1]
      categorizeImport(moduleName, imports)
    }

    // Match require(): require("module")
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    while ((match = requireRegex.exec(content)) !== null) {
      const moduleName = match[1]
      categorizeImport(moduleName, imports)
    }

    // Deduplicate
    imports.builtin = [...new Set(imports.builtin)]
    imports.thirdParty = [...new Set(imports.thirdParty)]
    imports.local = [...new Set(imports.local)]

    return imports
  }

  /**
   * Categorize an import into builtin, thirdParty, or local
   */
  function categorizeImport(moduleName: string, imports: ImportInfo): void {
    if (isBuiltinModule(moduleName)) {
      imports.builtin.push(moduleName)
    } else if (isLocalImport(moduleName)) {
      imports.local.push(moduleName)
    } else {
      imports.thirdParty.push(moduleName)
    }
  }

  /**
   * Extract interface definitions
   */
  function extractInterfaces(content: string): InterfaceInfo[] {
    const interfaces: InterfaceInfo[] = []
    const regex =
      /(?:export\s+)?interface\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+([^{]+))?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g
    let match
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      const extendsClause = match[2]?.trim()
      const body = match[3]

      const extendsArray = extendsClause ? extendsClause.split(",").map((e) => e.trim().split("<")[0]) : undefined

      // Summarize properties
      const propLines = body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("//") && !l.startsWith("/*"))
      const propSummary =
        propLines.length > 3 ? `${propLines.length} properties` : propLines.join("; ").slice(0, MAX_TEXT_LENGTH)

      interfaces.push({
        name,
        extends: extendsArray,
        properties: propSummary,
        isExported: match[0].trimStart().startsWith("export"),
      })
    }
    return interfaces
  }

  /**
   * Extract type alias definitions
   */
  function extractTypes(content: string): TypeInfo[] {
    const types: TypeInfo[] = []
    // Match type aliases - handle both semicolon-terminated and newline-terminated
    // Also handle object types that span multiple lines
    const regex = /(?:export\s+)?type\s+(\w+)(?:<([^>]+)>)?\s*=\s*(\{[^}]*\}|[^\n;]+)/g
    let match
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      const generics = match[2]
      const definition = match[3].trim()

      types.push({
        name,
        definition: definition.slice(0, MAX_TEXT_LENGTH) + (definition.length > MAX_TEXT_LENGTH ? "..." : ""),
        isGeneric: !!generics,
        isExported: match[0].trimStart().startsWith("export"),
      })
    }
    return types
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []
    const regex =
      /(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+(\w+)(?:<[^>]+>)?)?(?:\s+implements\s+([^{]+))?\s*\{/g
    let match
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      const extendsClass = match[2]
      const implementsClause = match[3]?.trim()
      const isAbstract = match[0].includes("abstract")
      const isExported = match[0].trimStart().startsWith("export")

      const implementsArray = implementsClause
        ? implementsClause.split(",").map((i) => i.trim().split("<")[0])
        : undefined

      // Find class body to extract methods and properties
      const startIdx = match.index + match[0].length
      const classBody = extractBalancedBlock(content, startIdx - 1)

      const methods: string[] = []
      const properties: string[] = []

      // Extract methods
      const methodRegex =
        /(?:public|private|protected|static|async|abstract|\s)*(\w+)\s*(?:<[^>]+>)?\s*\([^)]*\)\s*(?::\s*[^{;]+)?(?:\s*\{|;)/g
      let methodMatch
      while ((methodMatch = methodRegex.exec(classBody)) !== null) {
        const methodName = methodMatch[1]
        if (methodName && methodName !== "constructor" && !methodName.startsWith("_")) {
          methods.push(methodName)
        }
      }

      // Extract properties (simple pattern)
      const propRegex = /(?:public|private|protected|readonly|static|\s)+(\w+)\s*(?:\?)?:\s*[^;{]+;/g
      let propMatch
      while ((propMatch = propRegex.exec(classBody)) !== null) {
        const propName = propMatch[1]
        if (propName && !propName.startsWith("_")) {
          properties.push(propName)
        }
      }

      classes.push({
        name,
        extends: extendsClass,
        implements: implementsArray,
        methods: [...new Set(methods)].slice(0, MAX_ITEMS),
        properties: [...new Set(properties)].slice(0, MAX_ITEMS),
        isExported,
        isAbstract,
      })
    }
    return classes
  }

  /**
   * Extract a balanced block starting from an opening brace
   */
  function extractBalancedBlock(content: string, startIdx: number): string {
    let depth = 0
    let i = startIdx
    let started = false

    while (i < content.length) {
      const char = content[i]
      if (char === "{") {
        depth++
        started = true
      } else if (char === "}") {
        depth--
        if (started && depth === 0) {
          return content.slice(startIdx, i + 1)
        }
      }
      i++
    }
    return content.slice(startIdx, Math.min(startIdx + 1000, content.length))
  }

  /**
   * Extract function definitions
   */
  function extractFunctions(content: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const seen = new Set<string>()

    // Regular function declarations
    const funcRegex =
      /(?:export\s+)?(?:async\s+)?function\s*(\*?)\s*(\w+)\s*(?:<[^>]+>)?\s*\(([^)]*)\)\s*(?::\s*([^{]+))?\s*\{/g
    let match
    while ((match = funcRegex.exec(content)) !== null) {
      const isGenerator = match[1] === "*"
      const name = match[2]
      const params = match[3].trim()
      const returnType = match[4]?.trim()

      if (!seen.has(name)) {
        seen.add(name)
        functions.push({
          name,
          params: summarizeParams(params),
          returnType: returnType?.slice(0, 50),
          isAsync: match[0].includes("async"),
          isArrow: false,
          isExported: match[0].trimStart().startsWith("export"),
          isGenerator,
        })
      }
    }

    // Arrow functions assigned to const/let/var
    const arrowRegex =
      /(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/g
    while ((match = arrowRegex.exec(content)) !== null) {
      const name = match[1]

      if (!seen.has(name)) {
        seen.add(name)
        // Re-extract to get params
        const fullMatch = content.slice(match.index, match.index + 500)
        const paramsMatch = fullMatch.match(/=\s*(?:async\s+)?\(([^)]*)\)/)
        const params = paramsMatch?.[1]?.trim() ?? ""

        functions.push({
          name,
          params: summarizeParams(params),
          returnType: undefined,
          isAsync: match[0].includes("async"),
          isArrow: true,
          isExported: match[0].trimStart().startsWith("export"),
          isGenerator: false,
        })
      }
    }

    return functions
  }

  /**
   * Summarize function parameters
   */
  function summarizeParams(params: string): string {
    if (!params) return "()"
    const paramList = params.split(",").map((p) => p.trim().split(":")[0].split("=")[0].trim())
    const summary = paramList.filter((p) => p).join(", ")
    return summary.length > 50 ? `(${paramList.length} params)` : `(${summary})`
  }

  /**
   * Extract export information
   */
  function extractExports(content: string): ExportInfo {
    const exports: ExportInfo = {
      named: [],
      default: undefined,
      reExports: [],
    }

    // Named exports: export { a, b, c }
    const namedExportRegex = /export\s+\{([^}]+)\}(?:\s+from\s+['"]([^'"]+)['"])?/g
    let match
    while ((match = namedExportRegex.exec(content)) !== null) {
      const names = match[1].split(",").map((n) =>
        n
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      const fromModule = match[2]
      if (fromModule) {
        exports.reExports.push(`{ ${names.join(", ")} } from "${fromModule}"`)
      } else {
        exports.named.push(...names)
      }
    }

    // Export * from
    const starExportRegex = /export\s+\*(?:\s+as\s+(\w+))?\s+from\s+['"]([^'"]+)['"]/g
    while ((match = starExportRegex.exec(content)) !== null) {
      const asName = match[1]
      const fromModule = match[2]
      exports.reExports.push(asName ? `* as ${asName} from "${fromModule}"` : `* from "${fromModule}"`)
    }

    // Default export
    const defaultExportRegex = /export\s+default\s+(?:(class|function|abstract\s+class)\s+(\w+)|(\w+))/g
    while ((match = defaultExportRegex.exec(content)) !== null) {
      if (match[2]) {
        exports.default = `${match[1]} ${match[2]}`
      } else if (match[3]) {
        exports.default = match[3]
      }
    }

    // Inline exports: export const/let/var/function/class/interface/type/enum
    // Note: "const enum" must be checked before "const" to avoid capturing "enum" as a name
    const inlineExportRegex =
      /export\s+(?:async\s+)?(?:const\s+enum|let|var|const|function\*?|class|abstract\s+class|interface|type|enum)\s+(\w+)/g
    while ((match = inlineExportRegex.exec(content)) !== null) {
      const name = match[1]
      if (!exports.named.includes(name)) {
        exports.named.push(name)
      }
    }

    // Deduplicate
    exports.named = [...new Set(exports.named)]
    exports.reExports = [...new Set(exports.reExports)]

    return exports
  }

  /**
   * Extract namespace/module declarations
   */
  function extractNamespaces(content: string): NamespaceInfo[] {
    const namespaces: NamespaceInfo[] = []
    const regex = /(?:export\s+)?(?:namespace|module)\s+(\w+)\s*\{/g
    let match
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      const isExported = match[0].trimStart().startsWith("export")

      // Extract namespace body
      const startIdx = match.index + match[0].length - 1
      const body = extractBalancedBlock(content, startIdx)

      // Find members (simplified)
      const members: string[] = []
      const memberRegex = /(?:export\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/g
      let memberMatch
      while ((memberMatch = memberRegex.exec(body)) !== null) {
        members.push(memberMatch[1])
      }

      namespaces.push({
        name,
        isExported,
        members: [...new Set(members)].slice(0, MAX_ITEMS),
      })
    }
    return namespaces
  }

  /**
   * Extract enum definitions
   */
  function extractEnums(content: string): EnumInfo[] {
    const enums: EnumInfo[] = []
    const regex = /(?:export\s+)?(?:const\s+)?enum\s+(\w+)\s*\{([^}]*)\}/g
    let match
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      const body = match[2]
      const isConst = match[0].includes("const enum")
      const isExported = match[0].trimStart().startsWith("export")

      // Extract members
      const members = body
        .split(",")
        .map((m) => m.trim().split("=")[0].trim())
        .filter((m) => m && !m.startsWith("//"))

      enums.push({
        name,
        members: members.slice(0, MAX_ITEMS),
        isConst,
        isExported,
      })
    }
    return enums
  }

  /**
   * Extract React components (for TSX files)
   */
  function extractReactComponents(content: string, filePath?: string): ReactComponentInfo[] {
    const components: ReactComponentInfo[] = []
    const isTsx = filePath?.endsWith(".tsx") ?? false

    // Skip if not TSX and no JSX-like patterns
    if (!isTsx && !content.includes("<") && !content.includes("React")) {
      return components
    }

    const seen = new Set<string>()

    // Function components: function ComponentName(props: Props) { return <...> }
    const funcComponentRegex =
      /(?:export\s+)?(?:async\s+)?function\s+([A-Z]\w*)\s*(?:<[^>]+>)?\s*\(\s*(?:(\w+)\s*:\s*([^)]+)|(\{[^}]*\})\s*:\s*([^)]+))?\s*\)/g
    let match
    while ((match = funcComponentRegex.exec(content)) !== null) {
      const name = match[1]
      if (!seen.has(name)) {
        seen.add(name)
        const propsParam = match[2] || match[4]
        const propsType = match[3] || match[5]
        components.push({
          name,
          type: "function",
          hasProps: !!propsParam,
          propsType: propsType?.trim().split("<")[0],
          isExported: match[0].trimStart().startsWith("export"),
        })
      }
    }

    // Arrow function components: const ComponentName = (props: Props) => { ... }
    const arrowComponentRegex =
      /(?:export\s+)?const\s+([A-Z]\w*)\s*(?::\s*React\.FC[^=]*|:\s*FC[^=]*)?\s*=\s*(?:\([^)]*\)|[^=])*=>/g
    while ((match = arrowComponentRegex.exec(content)) !== null) {
      const name = match[1]
      if (!seen.has(name)) {
        seen.add(name)
        // Check for props type
        const fullMatch = content.slice(match.index, match.index + 300)
        const propsMatch = fullMatch.match(/:\s*(?:React\.)?FC<([^>]+)>/)
        components.push({
          name,
          type: "arrow",
          hasProps: !!propsMatch,
          propsType: propsMatch?.[1]?.trim(),
          isExported: match[0].trimStart().startsWith("export"),
        })
      }
    }

    // Class components: class ComponentName extends React.Component<Props>
    const classComponentRegex =
      /(?:export\s+)?class\s+([A-Z]\w*)\s+extends\s+(?:React\.)?(?:Component|PureComponent)(?:<([^>]+)>)?/g
    while ((match = classComponentRegex.exec(content)) !== null) {
      const name = match[1]
      if (!seen.has(name)) {
        seen.add(name)
        const propsType = match[2]?.split(",")[0]?.trim()
        components.push({
          name,
          type: "class",
          hasProps: !!propsType,
          propsType,
          isExported: match[0].trimStart().startsWith("export"),
        })
      }
    }

    return components
  }

  /**
   * Detect if file has entry point code (top-level execution)
   */
  function detectEntryPoint(content: string): boolean {
    // Check for common entry point patterns
    const patterns = [
      /^(?!.*(?:export|import)).*\b(console\.log|process\.exit|app\.listen|server\.listen)\s*\(/m,
      /^(?:const|let|var)\s+app\s*=\s*express\(\)/m,
      /^(?:const|let|var)\s+server\s*=\s*(?:http|https)\.createServer/m,
      /if\s*\(\s*(?:require\.main\s*===\s*module|import\.meta\.url)\s*\)/,
      /^main\s*\(\s*\)\s*(?:\.catch|\.then)?/m,
      /^\(async\s*\(\)\s*=>\s*\{/m,
    ]

    return patterns.some((pattern) => pattern.test(content))
  }

  /**
   * Detect module type
   */
  function detectModuleType(content: string): "esm" | "commonjs" | "mixed" | "unknown" {
    const hasImport = /\bimport\s+/.test(content)
    const hasExport = /\bexport\s+/.test(content)
    const hasRequire = /\brequire\s*\(/.test(content)
    const hasModuleExports = /\bmodule\.exports\b/.test(content)
    const hasExportsAssign = /\bexports\.\w+\s*=/.test(content)

    const isEsm = hasImport || hasExport
    const isCjs = hasRequire || hasModuleExports || hasExportsAssign

    if (isEsm && isCjs) return "mixed"
    if (isEsm) return "esm"
    if (isCjs) return "commonjs"
    return "unknown"
  }

  /**
   * Format the TypeScript summary
   */
  function formatSummary(filePath: string, metadata: TypeScriptMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    // File info
    lines.push(`File: ${fileName}`)
    const fileType = metadata.isReact ? "TypeScript (React)" : "TypeScript"
    lines.push(`Format: ${fileType} (${metadata.moduleType.toUpperCase()})`)
    lines.push(`Lines: ${metadata.lineCount}`)
    lines.push("")

    // Imports
    const totalImports =
      metadata.imports.builtin.length + metadata.imports.thirdParty.length + metadata.imports.local.length
    if (totalImports > 0) {
      lines.push("Imports:")
      if (metadata.imports.builtin.length > 0) {
        lines.push(
          `  Built-in: ${metadata.imports.builtin.slice(0, 10).join(", ")}${metadata.imports.builtin.length > 10 ? ` (+${metadata.imports.builtin.length - 10} more)` : ""}`,
        )
      }
      if (metadata.imports.thirdParty.length > 0) {
        lines.push(
          `  Third-party: ${metadata.imports.thirdParty.slice(0, 10).join(", ")}${metadata.imports.thirdParty.length > 10 ? ` (+${metadata.imports.thirdParty.length - 10} more)` : ""}`,
        )
      }
      if (metadata.imports.local.length > 0) {
        lines.push(
          `  Local: ${metadata.imports.local.slice(0, 10).join(", ")}${metadata.imports.local.length > 10 ? ` (+${metadata.imports.local.length - 10} more)` : ""}`,
        )
      }
      lines.push("")
    }

    // Interfaces
    if (metadata.interfaces.length > 0) {
      lines.push("Interfaces:")
      for (const iface of metadata.interfaces.slice(0, MAX_ITEMS)) {
        const exported = iface.isExported ? "(exported) " : ""
        const ext = iface.extends?.length ? ` extends ${iface.extends.join(", ")}` : ""
        lines.push(`  ${exported}${iface.name}${ext}`)
        if (iface.properties) {
          lines.push(`    ${iface.properties}`)
        }
      }
      if (metadata.interfaces.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.interfaces.length - MAX_ITEMS} more interfaces`)
      }
      lines.push("")
    }

    // Types
    if (metadata.types.length > 0) {
      lines.push("Type Aliases:")
      for (const type of metadata.types.slice(0, MAX_ITEMS)) {
        const exported = type.isExported ? "(exported) " : ""
        const generic = type.isGeneric ? "<T>" : ""
        lines.push(`  ${exported}${type.name}${generic} = ${type.definition}`)
      }
      if (metadata.types.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.types.length - MAX_ITEMS} more types`)
      }
      lines.push("")
    }

    // Enums
    if (metadata.enums.length > 0) {
      lines.push("Enums:")
      for (const en of metadata.enums.slice(0, MAX_ITEMS)) {
        const exported = en.isExported ? "(exported) " : ""
        const constStr = en.isConst ? "const " : ""
        lines.push(`  ${exported}${constStr}enum ${en.name} { ${en.members.join(", ")} }`)
      }
      if (metadata.enums.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.enums.length - MAX_ITEMS} more enums`)
      }
      lines.push("")
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push("Classes:")
      for (const cls of metadata.classes.slice(0, MAX_ITEMS)) {
        const exported = cls.isExported ? "(exported) " : ""
        const abstract = cls.isAbstract ? "abstract " : ""
        const ext = cls.extends ? ` extends ${cls.extends}` : ""
        const impl = cls.implements?.length ? ` implements ${cls.implements.join(", ")}` : ""
        lines.push(`  ${exported}${abstract}class ${cls.name}${ext}${impl}`)
        if (cls.methods.length > 0) {
          lines.push(`    Methods: ${cls.methods.join(", ")}`)
        }
        if (cls.properties.length > 0) {
          lines.push(`    Properties: ${cls.properties.join(", ")}`)
        }
      }
      if (metadata.classes.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.classes.length - MAX_ITEMS} more classes`)
      }
      lines.push("")
    }

    // Functions
    if (metadata.functions.length > 0) {
      lines.push("Functions:")
      for (const func of metadata.functions.slice(0, MAX_ITEMS)) {
        const exported = func.isExported ? "(exported) " : ""
        const async = func.isAsync ? "async " : ""
        const arrow = func.isArrow ? "=> " : ""
        const gen = func.isGenerator ? "*" : ""
        const ret = func.returnType ? `: ${func.returnType}` : ""
        lines.push(`  ${exported}${async}${arrow}${gen}${func.name}${func.params}${ret}`)
      }
      if (metadata.functions.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.functions.length - MAX_ITEMS} more functions`)
      }
      lines.push("")
    }

    // Namespaces
    if (metadata.namespaces.length > 0) {
      lines.push("Namespaces:")
      for (const ns of metadata.namespaces.slice(0, MAX_ITEMS)) {
        const exported = ns.isExported ? "(exported) " : ""
        lines.push(`  ${exported}namespace ${ns.name}`)
        if (ns.members.length > 0) {
          lines.push(`    Members: ${ns.members.join(", ")}`)
        }
      }
      if (metadata.namespaces.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.namespaces.length - MAX_ITEMS} more namespaces`)
      }
      lines.push("")
    }

    // React Components
    if (metadata.reactComponents.length > 0) {
      lines.push("React Components:")
      for (const comp of metadata.reactComponents.slice(0, MAX_ITEMS)) {
        const exported = comp.isExported ? "(exported) " : ""
        const props = comp.propsType ? `<${comp.propsType}>` : ""
        lines.push(`  ${exported}${comp.type} ${comp.name}${props}`)
      }
      if (metadata.reactComponents.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.reactComponents.length - MAX_ITEMS} more components`)
      }
      lines.push("")
    }

    // Exports
    if (metadata.exports.named.length > 0 || metadata.exports.default || metadata.exports.reExports.length > 0) {
      lines.push("Exports:")
      if (metadata.exports.default) {
        lines.push(`  default: ${metadata.exports.default}`)
      }
      if (metadata.exports.named.length > 0) {
        lines.push(
          `  named: ${metadata.exports.named.slice(0, 20).join(", ")}${metadata.exports.named.length > 20 ? ` (+${metadata.exports.named.length - 20} more)` : ""}`,
        )
      }
      if (metadata.exports.reExports.length > 0) {
        lines.push(`  re-exports:`)
        for (const re of metadata.exports.reExports.slice(0, 5)) {
          lines.push(`    ${re}`)
        }
        if (metadata.exports.reExports.length > 5) {
          lines.push(`    ... and ${metadata.exports.reExports.length - 5} more`)
        }
      }
      lines.push("")
    }

    // Entry point
    if (metadata.hasEntryPoint) {
      lines.push("Entry Point: Yes (contains top-level execution code)")
    }

    return lines.join("\n").trim()
  }

  /**
   * Input for exploring a TypeScript file
   */
  export interface ExploreInput {
    /** The file content to explore */
    content: string
    /** Optional file path for context */
    filePath?: string
    /** Optional model for LLM-based summary generation */
    model?: Provider.Model
    /** Optional abort signal */
    abort?: AbortSignal
  }

  /**
   * Explore a TypeScript file and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<TypeScriptExplorationResult> {
    const filePath = input.filePath ?? "unknown.ts"
    log.info("exploring TypeScript file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length
      const isReact = filePath.endsWith(".tsx") || content.includes("from 'react'") || content.includes('from "react"')

      // Extract all metadata
      const imports = extractImports(content)
      const interfaces = extractInterfaces(content)
      const types = extractTypes(content)
      const classes = extractClasses(content)
      const functions = extractFunctions(content)
      const exports = extractExports(content)
      const namespaces = extractNamespaces(content)
      const enums = extractEnums(content)
      const reactComponents = isReact ? extractReactComponents(content, filePath) : []
      const hasEntryPoint = detectEntryPoint(content)
      const moduleType = detectModuleType(content)

      const metadata: TypeScriptMetadata = {
        imports,
        interfaces,
        types,
        classes,
        functions,
        exports,
        namespaces,
        enums,
        reactComponents,
        isReact,
        hasEntryPoint,
        lineCount,
        moduleType,
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
          language: "TypeScript",
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

      log.info("TypeScript exploration complete", {
        filePath,
        lineCount,
        interfaces: interfaces.length,
        types: types.length,
        classes: classes.length,
        functions: functions.length,
        namespaces: namespaces.length,
        enums: enums.length,
        reactComponents: reactComponents.length,
        isReact,
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
      log.error("failed to explore TypeScript file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          imports: { builtin: [], thirdParty: [], local: [] },
          interfaces: [],
          types: [],
          classes: [],
          functions: [],
          exports: { named: [], default: undefined, reExports: [] },
          namespaces: [],
          enums: [],
          reactComponents: [],
          isReact: false,
          hasEntryPoint: false,
          lineCount: 0,
          moduleType: "unknown",
        },
        tokenCount: 0,
        error: `Failed to explore TypeScript: ${errorMessage}`,
      }
    }
  }
}
