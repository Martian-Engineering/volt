import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * JavaScript File Exploration Agent
 *
 * Analyzes JavaScript files (.js, .jsx, .mjs, .cjs) and produces structured
 * summaries showing module system, imports, exports, classes, functions,
 * and React components.
 */
export namespace JavaScriptExplorer {
  const log = Log.create({ service: "lcm.explore.javascript" })

  /**
   * Maximum number of items to list in each category
   */
  const MAX_ITEMS = 15

  /**
   * Maximum text length for samples
   */
  const MAX_TEXT_LENGTH = 60

  /**
   * Module system type
   */
  export type ModuleSystem = "esm" | "commonjs" | "mixed" | "unknown"

  /**
   * Import information
   */
  export interface ImportInfo {
    source: string
    specifiers: string[]
    isDefault: boolean
    isNamespace: boolean
    isDynamic: boolean
  }

  /**
   * Categorized imports
   */
  export interface ImportCategories {
    builtin: string[]
    thirdParty: string[]
    local: string[]
  }

  /**
   * Class information
   */
  export interface ClassInfo {
    name: string
    extends?: string
    methods: string[]
    isExported: boolean
  }

  /**
   * Function information
   */
  export interface FunctionInfo {
    name: string
    isAsync: boolean
    isGenerator: boolean
    isArrow: boolean
    isExported: boolean
    params: string[]
  }

  /**
   * Export information
   */
  export interface ExportInfo {
    type: "default" | "named" | "all" | "commonjs"
    name?: string
    source?: string
  }

  /**
   * React component information
   */
  export interface ReactComponentInfo {
    name: string
    type: "function" | "class" | "arrow"
    hasHooks: boolean
    usedHooks: string[]
  }

  /**
   * Global variable information
   */
  export interface GlobalVariableInfo {
    name: string
    kind: "const" | "let" | "var"
    hasValue: boolean
  }

  /**
   * Metadata about the JavaScript structure
   */
  export interface JavaScriptMetadata {
    /** Detected module system */
    moduleSystem: ModuleSystem
    /** Whether "use strict" is present */
    hasUseStrict: boolean
    /** Whether the file contains JSX */
    hasJsx: boolean
    /** Whether the file appears to be a React component */
    isReact: boolean
    /** Number of imports */
    importCount: number
    /** Number of exports */
    exportCount: number
    /** Number of classes */
    classCount: number
    /** Number of functions */
    functionCount: number
    /** Number of global variables */
    globalVariableCount: number
    /** Whether file has IIFE patterns */
    hasIife: boolean
    /** Line count */
    lineCount: number
  }

  /**
   * Result of JavaScript exploration
   */
  export interface JavaScriptExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the JavaScript */
    metadata: JavaScriptMetadata
    /** Categorized imports */
    imports: ImportCategories
    /** List of classes */
    classes: ClassInfo[]
    /** List of functions */
    functions: FunctionInfo[]
    /** List of exports */
    exports: ExportInfo[]
    /** React components if applicable */
    reactComponents: ReactComponentInfo[]
    /** Global variables */
    globalVariables: GlobalVariableInfo[]
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring a JavaScript file
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
   * Node.js built-in modules
   */
  const NODE_BUILTINS = new Set([
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
   * Common React hooks
   */
  const REACT_HOOKS = [
    "useState",
    "useEffect",
    "useContext",
    "useReducer",
    "useCallback",
    "useMemo",
    "useRef",
    "useImperativeHandle",
    "useLayoutEffect",
    "useDebugValue",
    "useDeferredValue",
    "useTransition",
    "useId",
    "useSyncExternalStore",
    "useInsertionEffect",
  ]

  /**
   * Check if a module source is a Node.js built-in
   */
  function isBuiltin(source: string): boolean {
    const normalized = source.startsWith("node:") ? source.slice(5) : source
    return NODE_BUILTINS.has(normalized)
  }

  /**
   * Check if a module source is a local import
   */
  function isLocal(source: string): boolean {
    return source.startsWith(".") || source.startsWith("/") || source.startsWith("@/")
  }

  /**
   * Detect the module system used in the file
   */
  function detectModuleSystem(content: string): ModuleSystem {
    const hasEsmImport = /^\s*import\s+/m.test(content)
    const hasEsmExport = /^\s*export\s+/m.test(content)
    const hasRequire = /\brequire\s*\(/m.test(content)
    const hasModuleExports = /\bmodule\.exports\b/m.test(content)
    const hasExportsAssign = /\bexports\.\w+\s*=/m.test(content)

    const isEsm = hasEsmImport || hasEsmExport
    const isCjs = hasRequire || hasModuleExports || hasExportsAssign

    if (isEsm && isCjs) return "mixed"
    if (isEsm) return "esm"
    if (isCjs) return "commonjs"
    return "unknown"
  }

  /**
   * Check for "use strict" directive
   */
  function hasUseStrict(content: string): boolean {
    return /^[\s\n]*["']use strict["']/m.test(content)
  }

  /**
   * Check for JSX syntax
   */
  function hasJsx(content: string): boolean {
    // Look for JSX patterns:
    // - Capitalized component tags: <Component>, </Component>
    // - HTML elements in return statements: return <div>, return (<div>
    // - Self-closing tags with JSX attributes: <div className=
    // - Fragment syntax: <>, </>
    return (
      /<[A-Z][a-zA-Z0-9]*[\s/>]/.test(content) ||
      /<\/[A-Z][a-zA-Z0-9]*>/.test(content) ||
      /return\s*\(?\s*<[a-z]/.test(content) ||
      /<[a-z]+\s+(?:className|onClick|onChange|onSubmit|style)=/.test(content) ||
      /<>|<\/>/.test(content)
    )
  }

  /**
   * Check for IIFE patterns
   * Matches: (function() {})(), (function() {}()), (() => {})()
   */
  function hasIife(content: string): boolean {
    // Classic IIFE: (function() {})() or (function() {}())
    const classicIife = /\(\s*function\s*\([^)]*\)\s*\{[\s\S]*?\}\s*\)\s*\(/.test(content)
    // Arrow IIFE: (() => {})()
    const arrowIife = /\(\s*\([^)]*\)\s*=>\s*\{[\s\S]*?\}\s*\)\s*\(/.test(content)
    // Also check for !function(){}() pattern
    const bangIife = /!\s*function\s*\([^)]*\)\s*\{[\s\S]*?\}\s*\(/.test(content)
    return classicIife || arrowIife || bangIife
  }

  /**
   * Extract ESM imports
   */
  function extractEsmImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = []

    // Static imports
    const staticImportRegex =
      /import\s+(?:(?:(\w+)\s*,?\s*)?(?:\{\s*([^}]*)\s*\})?(?:\*\s+as\s+(\w+))?)\s+from\s+["']([^"']+)["']/g
    let match: RegExpExecArray | null
    while ((match = staticImportRegex.exec(content)) !== null) {
      const defaultImport = match[1]
      const namedImports = match[2]
      const namespaceImport = match[3]
      const source = match[4]

      const specifiers: string[] = []
      if (defaultImport) specifiers.push(defaultImport)
      if (namedImports) {
        const named = namedImports.split(",").map((s) =>
          s
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        specifiers.push(...named.filter((s) => s))
      }
      if (namespaceImport) specifiers.push(`* as ${namespaceImport}`)

      imports.push({
        source,
        specifiers,
        isDefault: !!defaultImport,
        isNamespace: !!namespaceImport,
        isDynamic: false,
      })
    }

    // Side-effect imports
    const sideEffectRegex = /import\s+["']([^"']+)["']/g
    while ((match = sideEffectRegex.exec(content)) !== null) {
      // Skip if already captured
      const source = match[1]
      if (!imports.find((i) => i.source === source)) {
        imports.push({
          source,
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          isDynamic: false,
        })
      }
    }

    // Dynamic imports
    const dynamicImportRegex = /import\s*\(\s*["']([^"']+)["']\s*\)/g
    while ((match = dynamicImportRegex.exec(content)) !== null) {
      imports.push({
        source: match[1],
        specifiers: [],
        isDefault: false,
        isNamespace: false,
        isDynamic: true,
      })
    }

    return imports
  }

  /**
   * Extract CommonJS requires
   */
  function extractCommonJsRequires(content: string): ImportInfo[] {
    const imports: ImportInfo[] = []

    // const x = require('...')
    const constRequireRegex = /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g
    let match: RegExpExecArray | null
    while ((match = constRequireRegex.exec(content)) !== null) {
      imports.push({
        source: match[2],
        specifiers: [match[1]],
        isDefault: true,
        isNamespace: false,
        isDynamic: false,
      })
    }

    // const { x, y } = require('...')
    const destructureRequireRegex = /(?:const|let|var)\s+\{\s*([^}]+)\s*\}\s*=\s*require\s*\(\s*["']([^"']+)["']\s*\)/g
    while ((match = destructureRequireRegex.exec(content)) !== null) {
      const specifiers = match[1].split(",").map((s) =>
        s
          .trim()
          .split(/\s*:\s*/)[0]
          .trim(),
      )
      imports.push({
        source: match[2],
        specifiers: specifiers.filter((s) => s),
        isDefault: false,
        isNamespace: false,
        isDynamic: false,
      })
    }

    // require('...') without assignment (side-effect)
    const sideEffectRequireRegex = /^\s*require\s*\(\s*["']([^"']+)["']\s*\)/gm
    while ((match = sideEffectRequireRegex.exec(content)) !== null) {
      const source = match[1]
      if (!imports.find((i) => i.source === source)) {
        imports.push({
          source,
          specifiers: [],
          isDefault: false,
          isNamespace: false,
          isDynamic: false,
        })
      }
    }

    return imports
  }

  /**
   * Categorize imports into builtin, thirdParty, and local
   */
  function categorizeImports(imports: ImportInfo[]): ImportCategories {
    const builtin: string[] = []
    const thirdParty: string[] = []
    const local: string[] = []

    const seen = new Set<string>()
    for (const imp of imports) {
      if (seen.has(imp.source)) continue
      seen.add(imp.source)

      if (isBuiltin(imp.source)) {
        builtin.push(imp.source)
      } else if (isLocal(imp.source)) {
        local.push(imp.source)
      } else {
        thirdParty.push(imp.source)
      }
    }

    return { builtin, thirdParty, local }
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []

    // Match class declarations
    const classRegex = /(?:export\s+(?:default\s+)?)?class\s+(\w+)(?:\s+extends\s+(\w+(?:\.\w+)*))?\s*\{/g
    let match
    while ((match = classRegex.exec(content)) !== null) {
      const name = match[1]
      const extendsClass = match[2]
      const isExported = match[0].startsWith("export")

      // Find the class body and extract methods
      const startIdx = match.index + match[0].length
      const methods = extractClassMethods(content, startIdx)

      classes.push({
        name,
        extends: extendsClass,
        methods,
        isExported,
      })
    }

    return classes
  }

  /**
   * Extract method names from a class body
   */
  function extractClassMethods(content: string, startIdx: number): string[] {
    const methods: string[] = []
    let depth = 1
    let i = startIdx
    let methodMatch: RegExpExecArray | null

    // Find matching closing brace
    while (i < content.length && depth > 0) {
      if (content[i] === "{") depth++
      else if (content[i] === "}") depth--
      i++
    }

    const classBody = content.slice(startIdx, i - 1)

    // Match method definitions
    const methodRegex = /(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\([^)]*\)\s*\{/g
    while ((methodMatch = methodRegex.exec(classBody)) !== null) {
      const methodName = methodMatch[1]
      if (methodName !== "if" && methodName !== "for" && methodName !== "while" && methodName !== "switch") {
        methods.push(methodName)
      }
    }

    return [...new Set(methods)]
  }

  /**
   * Extract function definitions
   */
  function extractFunctions(content: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const seen = new Set<string>()

    // Named function declarations
    const funcDeclRegex = /(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*(\*?)\s*(\w+)\s*\(([^)]*)\)/g
    let match
    while ((match = funcDeclRegex.exec(content)) !== null) {
      const name = match[2]
      if (seen.has(name)) continue
      seen.add(name)

      const isExported = match[0].startsWith("export")
      const isAsync = match[0].includes("async")
      const isGenerator = match[1] === "*"
      const params = match[3]
        .split(",")
        .map((p) => p.trim().split(/[=:]/)[0].trim())
        .filter((p) => p)

      functions.push({
        name,
        isAsync,
        isGenerator,
        isArrow: false,
        isExported,
        params,
      })
    }

    // Arrow functions assigned to const/let/var
    const arrowRegex = /(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(?([^)]*?)\)?\s*=>/g
    while ((match = arrowRegex.exec(content)) !== null) {
      const name = match[1]
      if (seen.has(name)) continue
      seen.add(name)

      const isExported = match[0].startsWith("export")
      const isAsync = match[0].includes("async")
      const params = match[2]
        .split(",")
        .map((p) => p.trim().split(/[=:]/)[0].trim())
        .filter((p) => p)

      functions.push({
        name,
        isAsync,
        isGenerator: false,
        isArrow: true,
        isExported,
        params,
      })
    }

    return functions
  }

  /**
   * Extract exports
   */
  function extractExports(content: string): ExportInfo[] {
    const exports: ExportInfo[] = []

    // export default
    if (/export\s+default\s+/.test(content)) {
      const defaultMatch = content.match(/export\s+default\s+(?:class\s+|function\s*\*?\s*)?(\w+)?/)
      exports.push({
        type: "default",
        name: defaultMatch?.[1],
      })
    }

    // Named exports: export { ... }
    const namedExportRegex = /export\s+\{([^}]+)\}(?:\s+from\s+["']([^"']+)["'])?/g
    let match: RegExpExecArray | null
    while ((match = namedExportRegex.exec(content)) !== null) {
      const names = match[1].split(",").map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      for (const name of names) {
        if (name) {
          exports.push({
            type: "named",
            name,
            source: match[2],
          })
        }
      }
    }

    // export * from '...'
    const reExportAllRegex = /export\s+\*\s+from\s+["']([^"']+)["']/g
    while ((match = reExportAllRegex.exec(content)) !== null) {
      exports.push({
        type: "all",
        source: match[1],
      })
    }

    // Inline exports: export const/let/var/function/class
    const inlineExportRegex = /export\s+(?:const|let|var|function\s*\*?|class)\s+(\w+)/g
    while ((match = inlineExportRegex.exec(content)) !== null) {
      const name = match[1]
      if (!exports.find((e) => e.name === name)) {
        exports.push({
          type: "named",
          name,
        })
      }
    }

    // CommonJS: module.exports
    if (/module\.exports\s*=/.test(content)) {
      exports.push({
        type: "commonjs",
        name: "module.exports",
      })
    }

    // CommonJS: exports.x = ...
    const exportsAssignRegex = /exports\.(\w+)\s*=/g
    while ((match = exportsAssignRegex.exec(content)) !== null) {
      exports.push({
        type: "commonjs",
        name: match[1],
      })
    }

    return exports
  }

  /**
   * Extract React components
   */
  function extractReactComponents(
    content: string,
    classes: ClassInfo[],
    functions: FunctionInfo[],
  ): ReactComponentInfo[] {
    const components: ReactComponentInfo[] = []

    // Check for React import
    const hasReactImport = /import\s+.*\bReact\b.*from\s+["']react["']/.test(content)
    const hasJsxContent = hasJsx(content)

    if (!hasReactImport && !hasJsxContent) return components

    // Class components (extend React.Component or Component)
    for (const cls of classes) {
      if (cls.extends?.includes("Component") || cls.extends?.includes("PureComponent")) {
        components.push({
          name: cls.name,
          type: "class",
          hasHooks: false,
          usedHooks: [],
        })
      }
    }

    // Function components (functions that return JSX)
    // Look for functions with JSX in their body
    for (const func of functions) {
      // Check if this function likely returns JSX
      const funcBodyMatch = content.match(
        new RegExp(`(?:function\\s+${func.name}|const\\s+${func.name}\\s*=)[^{]*\\{([\\s\\S]*?)\\n\\}`, "m"),
      )
      if (funcBodyMatch) {
        const body = funcBodyMatch[1]
        if (hasJsx(body) || /return\s*\(?\s*</.test(body)) {
          // Find used hooks in the function body
          const usedHooks: string[] = []
          for (const hook of REACT_HOOKS) {
            if (new RegExp(`\\b${hook}\\s*\\(`).test(body)) {
              usedHooks.push(hook)
            }
          }

          // Also check for custom hooks (useXxx)
          const customHookMatches = body.match(/\buse[A-Z]\w*\s*\(/g)
          if (customHookMatches) {
            for (const match of customHookMatches) {
              const hookName = match.replace(/\s*\($/, "")
              if (!usedHooks.includes(hookName)) {
                usedHooks.push(hookName)
              }
            }
          }

          components.push({
            name: func.name,
            type: func.isArrow ? "arrow" : "function",
            hasHooks: usedHooks.length > 0,
            usedHooks,
          })
        }
      }
    }

    return components
  }

  /**
   * Extract global variables (const/let/var at module level)
   */
  function extractGlobalVariables(content: string): GlobalVariableInfo[] {
    const variables: GlobalVariableInfo[] = []
    const seen = new Set<string>()

    // Match top-level variable declarations
    // We need to be careful to only match module-level declarations
    const lines = content.split("\n")
    let depth = 0

    for (const line of lines) {
      // Track brace depth
      const openBraces = (line.match(/\{/g) ?? []).length
      const closeBraces = (line.match(/\}/g) ?? []).length
      depth += openBraces - closeBraces

      // Only look at module level (depth 0)
      if (depth > 0) continue

      const varMatch = line.match(/^\s*(const|let|var)\s+(\w+)\s*(=|;|$)/)
      if (varMatch && !line.includes("require(") && !line.includes("=>")) {
        const name = varMatch[2]
        if (seen.has(name)) continue
        seen.add(name)

        variables.push({
          name,
          kind: varMatch[1] as "const" | "let" | "var",
          hasValue: varMatch[3] === "=",
        })
      }
    }

    return variables
  }

  /**
   * Format the summary
   */
  function formatSummary(
    filePath: string,
    metadata: JavaScriptMetadata,
    imports: ImportCategories,
    classes: ClassInfo[],
    functions: FunctionInfo[],
    exports: ExportInfo[],
    reactComponents: ReactComponentInfo[],
    globalVariables: GlobalVariableInfo[],
  ): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: JavaScript (${metadata.moduleSystem})`)
    if (metadata.hasUseStrict) lines.push("Mode: Strict")
    if (metadata.hasJsx) lines.push("Syntax: JSX")
    if (metadata.isReact) lines.push("Framework: React")
    lines.push("")

    // Summary stats
    lines.push("Structure:")
    lines.push(`- Lines: ${metadata.lineCount}`)
    lines.push(`- Imports: ${metadata.importCount}`)
    lines.push(`- Exports: ${metadata.exportCount}`)
    lines.push(`- Classes: ${metadata.classCount}`)
    lines.push(`- Functions: ${metadata.functionCount}`)
    if (metadata.globalVariableCount > 0) {
      lines.push(`- Global variables: ${metadata.globalVariableCount}`)
    }
    if (metadata.hasIife) {
      lines.push(`- Contains IIFE patterns`)
    }

    // Imports by category
    if (imports.builtin.length > 0) {
      lines.push("")
      lines.push("Built-in imports:")
      for (const src of imports.builtin.slice(0, MAX_ITEMS)) {
        lines.push(`  - ${src}`)
      }
      if (imports.builtin.length > MAX_ITEMS) {
        lines.push(`  ... and ${imports.builtin.length - MAX_ITEMS} more`)
      }
    }

    if (imports.thirdParty.length > 0) {
      lines.push("")
      lines.push("Third-party imports:")
      for (const src of imports.thirdParty.slice(0, MAX_ITEMS)) {
        lines.push(`  - ${src}`)
      }
      if (imports.thirdParty.length > MAX_ITEMS) {
        lines.push(`  ... and ${imports.thirdParty.length - MAX_ITEMS} more`)
      }
    }

    if (imports.local.length > 0) {
      lines.push("")
      lines.push("Local imports:")
      for (const src of imports.local.slice(0, MAX_ITEMS)) {
        lines.push(`  - ${src}`)
      }
      if (imports.local.length > MAX_ITEMS) {
        lines.push(`  ... and ${imports.local.length - MAX_ITEMS} more`)
      }
    }

    // React components
    if (reactComponents.length > 0) {
      lines.push("")
      lines.push("React components:")
      for (const comp of reactComponents.slice(0, MAX_ITEMS)) {
        const hooksStr = comp.hasHooks
          ? ` [hooks: ${comp.usedHooks.slice(0, 3).join(", ")}${comp.usedHooks.length > 3 ? "..." : ""}]`
          : ""
        lines.push(`  - ${comp.name} (${comp.type})${hooksStr}`)
      }
      if (reactComponents.length > MAX_ITEMS) {
        lines.push(`  ... and ${reactComponents.length - MAX_ITEMS} more`)
      }
    }

    // Classes
    if (classes.length > 0) {
      lines.push("")
      lines.push("Classes:")
      for (const cls of classes.slice(0, MAX_ITEMS)) {
        const extendsStr = cls.extends ? ` extends ${cls.extends}` : ""
        const exportStr = cls.isExported ? " (exported)" : ""
        const methodsStr =
          cls.methods.length > 0
            ? ` - methods: ${cls.methods.slice(0, 5).join(", ")}${cls.methods.length > 5 ? "..." : ""}`
            : ""
        lines.push(`  - ${cls.name}${extendsStr}${exportStr}${methodsStr}`)
      }
      if (classes.length > MAX_ITEMS) {
        lines.push(`  ... and ${classes.length - MAX_ITEMS} more`)
      }
    }

    // Functions
    if (functions.length > 0) {
      lines.push("")
      lines.push("Functions:")
      for (const func of functions.slice(0, MAX_ITEMS)) {
        const modifiers: string[] = []
        if (func.isAsync) modifiers.push("async")
        if (func.isGenerator) modifiers.push("generator")
        if (func.isArrow) modifiers.push("arrow")
        if (func.isExported) modifiers.push("exported")
        const modifierStr = modifiers.length > 0 ? ` (${modifiers.join(", ")})` : ""
        const paramsStr =
          func.params.length > 0
            ? `(${func.params.slice(0, 3).join(", ")}${func.params.length > 3 ? "..." : ""})`
            : "()"
        lines.push(`  - ${func.name}${paramsStr}${modifierStr}`)
      }
      if (functions.length > MAX_ITEMS) {
        lines.push(`  ... and ${functions.length - MAX_ITEMS} more`)
      }
    }

    // Exports
    if (exports.length > 0) {
      lines.push("")
      lines.push("Exports:")
      for (const exp of exports.slice(0, MAX_ITEMS)) {
        const sourceStr = exp.source ? ` from "${exp.source}"` : ""
        if (exp.type === "default") {
          lines.push(`  - default${exp.name ? `: ${exp.name}` : ""}${sourceStr}`)
        } else if (exp.type === "all") {
          lines.push(`  - * (re-export)${sourceStr}`)
        } else if (exp.type === "commonjs") {
          lines.push(`  - ${exp.name} (CommonJS)`)
        } else {
          lines.push(`  - ${exp.name}${sourceStr}`)
        }
      }
      if (exports.length > MAX_ITEMS) {
        lines.push(`  ... and ${exports.length - MAX_ITEMS} more`)
      }
    }

    // Global variables
    if (globalVariables.length > 0) {
      lines.push("")
      lines.push("Global variables:")
      for (const v of globalVariables.slice(0, MAX_ITEMS)) {
        lines.push(`  - ${v.kind} ${v.name}`)
      }
      if (globalVariables.length > MAX_ITEMS) {
        lines.push(`  ... and ${globalVariables.length - MAX_ITEMS} more`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Explore a JavaScript file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<JavaScriptExplorationResult> {
    const filePath = input.filePath ?? "unknown.js"
    log.info("exploring JavaScript file", { filePath })

    try {
      const content = input.content

      // Detect module system and features
      const moduleSystem = detectModuleSystem(content)
      const strictMode = hasUseStrict(content)
      const jsxPresent = hasJsx(content)
      const iifePresent = hasIife(content)
      const lineCount = content.split("\n").length

      // Extract imports
      const esmImports = extractEsmImports(content)
      const cjsImports = extractCommonJsRequires(content)
      const allImports = [...esmImports, ...cjsImports]
      const imports = categorizeImports(allImports)

      // Extract code structures
      const classes = extractClasses(content)
      const functions = extractFunctions(content)
      const exports = extractExports(content)
      const globalVariables = extractGlobalVariables(content)

      // Extract React components
      const reactComponents = extractReactComponents(content, classes, functions)
      const isReact = reactComponents.length > 0 || /from\s+["']react["']/.test(content)

      const metadata: JavaScriptMetadata = {
        moduleSystem,
        hasUseStrict: strictMode,
        hasJsx: jsxPresent,
        isReact,
        importCount: allImports.length,
        exportCount: exports.length,
        classCount: classes.length,
        functionCount: functions.length,
        globalVariableCount: globalVariables.length,
        hasIife: iifePresent,
        lineCount,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        // Generate LLM-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(
          filePath,
          metadata,
          imports,
          classes,
          functions,
          exports,
          reactComponents,
          globalVariables,
        )
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "JavaScript",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        // Fall back to template-based summary
        summary = formatSummary(
          filePath,
          metadata,
          imports,
          classes,
          functions,
          exports,
          reactComponents,
          globalVariables,
        )
        tokenCount = Token.estimate(summary)
      }

      log.info("JavaScript exploration complete", {
        filePath,
        moduleSystem,
        importCount: allImports.length,
        classCount: classes.length,
        functionCount: functions.length,
        isReact,
        tokenCount,
        usedLLM: !!input.model,
      })

      return {
        success: true,
        summary,
        metadata,
        imports,
        classes,
        functions,
        exports,
        reactComponents,
        globalVariables,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse JavaScript", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          moduleSystem: "unknown",
          hasUseStrict: false,
          hasJsx: false,
          isReact: false,
          importCount: 0,
          exportCount: 0,
          classCount: 0,
          functionCount: 0,
          globalVariableCount: 0,
          hasIife: false,
          lineCount: 0,
        },
        imports: { builtin: [], thirdParty: [], local: [] },
        classes: [],
        functions: [],
        exports: [],
        reactComponents: [],
        globalVariables: [],
        tokenCount: 0,
        error: `Failed to parse JavaScript: ${errorMessage}`,
      }
    }
  }
}
