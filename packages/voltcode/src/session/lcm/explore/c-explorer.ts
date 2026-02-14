import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * C File Exploration Agent
 *
 * Analyzes C source files (.c, .h) and produces structured summaries
 * showing includes, functions, structs, enums, typedefs, macros, and
 * global variables.
 */
export namespace CExplorer {
  const log = Log.create({ service: "lcm.explore.c" })

  /**
   * Maximum string length to show in samples
   */
  const MAX_VALUE_LENGTH = 80

  /**
   * Maximum number of parameters to show
   */
  const MAX_PARAMS = 10

  /**
   * Maximum number of fields to show
   */
  const MAX_FIELDS = 15

  /**
   * Maximum number of enum values to show
   */
  const MAX_ENUM_VALUES = 10

  /**
   * Include information categorized by type
   */
  export interface IncludeInfo {
    /** Standard library headers (<stdio.h>, etc.) */
    stdlib: string[]
    /** System headers (<sys/..., <unistd.h>, etc.) */
    system: string[]
    /** Local headers ("header.h") */
    local: string[]
  }

  /**
   * Function parameter information
   */
  export interface ParamInfo {
    type: string
    name: string
  }

  /**
   * Function information
   */
  export interface FunctionInfo {
    name: string
    returnType: string
    params: ParamInfo[]
    isStatic: boolean
    isInline: boolean
    isDeclaration: boolean
  }

  /**
   * Struct field information
   */
  export interface FieldInfo {
    type: string
    name: string
    isPointer: boolean
    arraySize?: string
  }

  /**
   * Struct information
   */
  export interface StructInfo {
    name: string
    fields: FieldInfo[]
    isTypedef: boolean
  }

  /**
   * Enum value information
   */
  export interface EnumValueInfo {
    name: string
    value?: string
  }

  /**
   * Enum information
   */
  export interface EnumInfo {
    name: string
    values: EnumValueInfo[]
    isTypedef: boolean
  }

  /**
   * Typedef information
   */
  export interface TypedefInfo {
    name: string
    originalType: string
  }

  /**
   * Macro information
   */
  export interface MacroInfo {
    name: string
    params?: string[]
    value?: string
    isFunctionLike: boolean
  }

  /**
   * Global variable information
   */
  export interface GlobalVarInfo {
    name: string
    type: string
    isExtern: boolean
    isStatic: boolean
    isConst: boolean
  }

  /**
   * Metadata about the C file
   */
  export interface CMetadata {
    /** Include statements categorized */
    includes: IncludeInfo
    /** Function declarations and definitions */
    functions: FunctionInfo[]
    /** Struct definitions */
    structs: StructInfo[]
    /** Enum definitions */
    enums: EnumInfo[]
    /** Typedef definitions */
    typedefs: TypedefInfo[]
    /** Macro definitions */
    macros: MacroInfo[]
    /** Whether the file has a main function */
    hasMain: boolean
    /** Whether this is a header file */
    isHeader: boolean
    /** Header guard name if present */
    headerGuard?: string
    /** Global variables */
    globalVariables: GlobalVarInfo[]
    /** Extern declarations */
    externDeclarations: string[]
  }

  /**
   * Result of C exploration
   */
  export interface CExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the C file */
    metadata: CMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Standard library headers that can be identified
   */
  const STDLIB_HEADERS = new Set([
    "assert.h",
    "complex.h",
    "ctype.h",
    "errno.h",
    "fenv.h",
    "float.h",
    "inttypes.h",
    "iso646.h",
    "limits.h",
    "locale.h",
    "math.h",
    "setjmp.h",
    "signal.h",
    "stdalign.h",
    "stdarg.h",
    "stdatomic.h",
    "stdbool.h",
    "stddef.h",
    "stdint.h",
    "stdio.h",
    "stdlib.h",
    "stdnoreturn.h",
    "string.h",
    "tgmath.h",
    "threads.h",
    "time.h",
    "uchar.h",
    "wchar.h",
    "wctype.h",
  ])

  /**
   * System header prefixes
   */
  const SYSTEM_PREFIXES = ["sys/", "netinet/", "arpa/", "net/", "linux/", "asm/", "bits/"]

  /**
   * System headers without prefixes
   */
  const SYSTEM_HEADERS = new Set([
    "unistd.h",
    "fcntl.h",
    "dirent.h",
    "dlfcn.h",
    "getopt.h",
    "glob.h",
    "grp.h",
    "netdb.h",
    "poll.h",
    "pthread.h",
    "pwd.h",
    "regex.h",
    "sched.h",
    "semaphore.h",
    "spawn.h",
    "syslog.h",
    "termios.h",
    "utime.h",
    "wait.h",
  ])

  /**
   * Remove C-style comments from content
   */
  function removeComments(content: string): string {
    let result = ""
    let i = 0
    while (i < content.length) {
      // Single-line comment
      if (content[i] === "/" && content[i + 1] === "/") {
        const newlineIdx = content.indexOf("\n", i)
        if (newlineIdx === -1) break
        i = newlineIdx + 1
        result += "\n"
        continue
      }
      // Multi-line comment
      if (content[i] === "/" && content[i + 1] === "*") {
        const endIdx = content.indexOf("*/", i + 2)
        if (endIdx === -1) break
        // Preserve newlines for line counting
        const commentText = content.slice(i, endIdx + 2)
        result += commentText.replace(/[^\n]/g, " ")
        i = endIdx + 2
        continue
      }
      // String literal - skip to preserve strings
      if (content[i] === '"') {
        const start = i
        i++
        while (i < content.length && content[i] !== '"') {
          if (content[i] === "\\" && i + 1 < content.length) i += 2
          else i++
        }
        i++ // skip closing quote
        result += content.slice(start, i)
        continue
      }
      // Character literal
      if (content[i] === "'") {
        const start = i
        i++
        while (i < content.length && content[i] !== "'") {
          if (content[i] === "\\" && i + 1 < content.length) i += 2
          else i++
        }
        i++
        result += content.slice(start, i)
        continue
      }
      result += content[i]
      i++
    }
    return result
  }

  /**
   * Categorize an include header
   */
  function categorizeInclude(header: string, isAngleBracket: boolean): "stdlib" | "system" | "local" {
    if (!isAngleBracket) return "local"

    if (STDLIB_HEADERS.has(header)) return "stdlib"
    if (SYSTEM_HEADERS.has(header)) return "system"

    for (const prefix of SYSTEM_PREFIXES) {
      if (header.startsWith(prefix)) return "system"
    }

    // Default angle brackets to system if not recognized as stdlib
    return "system"
  }

  /**
   * Parse include statements
   */
  function parseIncludes(content: string): IncludeInfo {
    const includes: IncludeInfo = { stdlib: [], system: [], local: [] }

    // Match #include <header> and #include "header"
    const includeRegex = /^\s*#\s*include\s*([<"])([^>"]+)[>"]/gm
    let match
    while ((match = includeRegex.exec(content)) !== null) {
      const isAngleBracket = match[1] === "<"
      const header = match[2]
      const category = categorizeInclude(header, isAngleBracket)
      if (!includes[category].includes(header)) {
        includes[category].push(header)
      }
    }

    return includes
  }

  /**
   * Parse function parameters
   */
  function parseParams(paramString: string): ParamInfo[] {
    const params: ParamInfo[] = []
    const trimmed = paramString.trim()

    if (!trimmed || trimmed === "void") return params

    const parts = splitParams(trimmed)
    for (const part of parts) {
      const cleaned = part.trim()
      if (!cleaned) continue

      // Handle "..." (varargs)
      if (cleaned === "...") {
        params.push({ type: "...", name: "" })
        continue
      }

      // Parse "type name" or "type *name" or just "type"
      const paramMatch = cleaned.match(/^(.+?)(\s+\*?\s*([a-zA-Z_]\w*)(\[[^\]]*\])?)?\s*$/)
      if (paramMatch) {
        const type = paramMatch[1].trim()
        const name = paramMatch[3] ?? ""
        params.push({ type, name })
      }
    }

    return params
  }

  /**
   * Split parameters respecting nested parentheses
   */
  function splitParams(str: string): string[] {
    const parts: string[] = []
    let depth = 0
    let current = ""

    for (const char of str) {
      if (char === "(" || char === "[") {
        depth++
        current += char
      } else if (char === ")" || char === "]") {
        depth--
        current += char
      } else if (char === "," && depth === 0) {
        parts.push(current.trim())
        current = ""
      } else {
        current += char
      }
    }

    if (current.trim()) parts.push(current.trim())
    return parts
  }

  /**
   * Parse function declarations and definitions
   */
  function parseFunctions(content: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const cleaned = removeComments(content)

    // Match function patterns: [static] [inline] return_type function_name(params) { or ;
    const funcRegex =
      /(?:^|\n)\s*(static\s+)?(inline\s+)?((?:(?:const|unsigned|signed|long|short|struct|enum|union)\s+)*[a-zA-Z_]\w*(?:\s*\*)*)\s+([a-zA-Z_]\w*)\s*\(([^)]*)\)\s*([{;])/g

    let match
    while ((match = funcRegex.exec(cleaned)) !== null) {
      const isStatic = !!match[1]
      const isInline = !!match[2]
      const returnType = match[3].trim()
      const name = match[4]
      const paramStr = match[5]
      const isDeclaration = match[6] === ";"

      // Skip if it looks like a macro call
      if (returnType.toUpperCase() === returnType && returnType.length > 2) continue

      const params = parseParams(paramStr)

      functions.push({
        name,
        returnType,
        params,
        isStatic,
        isInline,
        isDeclaration,
      })
    }

    return functions
  }

  /**
   * Parse struct definitions
   */
  function parseStructs(content: string): StructInfo[] {
    const structs: StructInfo[] = []
    const cleaned = removeComments(content)

    // Match typedef struct { ... } Name; or struct Name { ... };
    const structRegex = /(?:typedef\s+)?struct\s+([a-zA-Z_]\w*)?\s*\{([^}]*)\}\s*([a-zA-Z_]\w*)?\s*;/g

    let match
    while ((match = structRegex.exec(cleaned)) !== null) {
      const structName = match[1]
      const body = match[2]
      const typedefName = match[3]
      const isTypedef = !!typedefName

      const name = typedefName ?? structName ?? "(anonymous)"
      const fields = parseStructFields(body)

      structs.push({ name, fields, isTypedef })
    }

    return structs
  }

  /**
   * Parse struct fields
   */
  function parseStructFields(body: string): FieldInfo[] {
    const fields: FieldInfo[] = []
    const lines = body.split(";")

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      // Match field: type [*]name[array]
      const fieldMatch = trimmed.match(/^(.+?)(\**)?\s*([a-zA-Z_]\w*)\s*(\[[^\]]*\])?$/)
      if (fieldMatch) {
        const type = fieldMatch[1].trim()
        const isPointer = !!fieldMatch[2]
        const name = fieldMatch[3]
        const arraySize = fieldMatch[4]?.slice(1, -1)

        fields.push({ type, name, isPointer, arraySize })
      }
    }

    return fields
  }

  /**
   * Parse enum definitions
   */
  function parseEnums(content: string): EnumInfo[] {
    const enums: EnumInfo[] = []
    const cleaned = removeComments(content)

    // Match typedef enum { ... } Name; or enum Name { ... };
    const enumRegex = /(?:typedef\s+)?enum\s+([a-zA-Z_]\w*)?\s*\{([^}]*)\}\s*([a-zA-Z_]\w*)?\s*;/g

    let match
    while ((match = enumRegex.exec(cleaned)) !== null) {
      const enumName = match[1]
      const body = match[2]
      const typedefName = match[3]
      const isTypedef = !!typedefName

      const name = typedefName ?? enumName ?? "(anonymous)"
      const values = parseEnumValues(body)

      enums.push({ name, values, isTypedef })
    }

    return enums
  }

  /**
   * Parse enum values
   */
  function parseEnumValues(body: string): EnumValueInfo[] {
    const values: EnumValueInfo[] = []
    const parts = body.split(",")

    for (const part of parts) {
      const trimmed = part.trim()
      if (!trimmed) continue

      const valueMatch = trimmed.match(/^([a-zA-Z_]\w*)(?:\s*=\s*(.+))?$/)
      if (valueMatch) {
        values.push({
          name: valueMatch[1],
          value: valueMatch[2]?.trim(),
        })
      }
    }

    return values
  }

  /**
   * Parse typedef definitions (excluding struct/enum typedefs)
   */
  function parseTypedefs(content: string): TypedefInfo[] {
    const typedefs: TypedefInfo[] = []
    const cleaned = removeComments(content)

    // Match simple typedefs: typedef original_type new_name;
    const typedefRegex = /typedef\s+(?!struct\s)(?!enum\s)(?!union\s)(.+?)\s+([a-zA-Z_]\w*)\s*;/g

    let match
    while ((match = typedefRegex.exec(cleaned)) !== null) {
      const originalType = match[1].trim()
      const name = match[2]

      // Skip function pointer typedefs for simplicity
      if (originalType.includes("(")) continue

      typedefs.push({ name, originalType })
    }

    return typedefs
  }

  /**
   * Parse macro definitions
   */
  function parseMacros(content: string): MacroInfo[] {
    const macros: MacroInfo[] = []

    // Match #define NAME or #define NAME(params) or #define NAME value
    const macroRegex = /^\s*#\s*define\s+([a-zA-Z_]\w*)(?:\(([^)]*)\))?\s*(.*?)$/gm

    let match
    while ((match = macroRegex.exec(content)) !== null) {
      const name = match[1]
      const paramsStr = match[2]
      const value = match[3]?.trim()
      const isFunctionLike = paramsStr !== undefined

      // Skip include guards
      if (name.endsWith("_H") || name.endsWith("_H_") || name.endsWith("_INCLUDED")) {
        continue
      }

      const params = isFunctionLike
        ? paramsStr
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p)
        : undefined

      macros.push({
        name,
        params,
        value: value || undefined,
        isFunctionLike,
      })
    }

    return macros
  }

  /**
   * Parse global variables
   */
  function parseGlobalVariables(content: string): GlobalVarInfo[] {
    const globals: GlobalVarInfo[] = []
    const cleaned = removeComments(content)

    // Match global variable declarations
    const varRegex =
      /(?:^|\n)\s*(extern\s+)?(static\s+)?(const\s+)?((?:(?:unsigned|signed|long|short|struct|enum|union)\s+)*[a-zA-Z_]\w*(?:\s*\*)*)\s+([a-zA-Z_]\w*)\s*(?:=\s*[^;]+)?;/g

    let match
    while ((match = varRegex.exec(cleaned)) !== null) {
      const isExtern = !!match[1]
      const isStatic = !!match[2]
      const isConst = !!match[3]
      const type = match[4].trim()
      const name = match[5]

      // Skip function declarations
      const context = cleaned.slice(Math.max(0, match.index - 10), match.index + match[0].length + 10)
      if (context.includes("(")) continue

      globals.push({ name, type, isExtern, isStatic, isConst })
    }

    return globals
  }

  /**
   * Parse extern declarations
   */
  function parseExternDeclarations(content: string): string[] {
    const externs: string[] = []
    const cleaned = removeComments(content)

    const externRegex = /^\s*extern\s+(.+?);/gm
    let match
    while ((match = externRegex.exec(cleaned)) !== null) {
      externs.push(match[1].trim())
    }

    return externs
  }

  /**
   * Detect header guard pattern
   */
  function detectHeaderGuard(content: string): string | undefined {
    const guardMatch = content.match(/^\s*#\s*ifndef\s+([a-zA-Z_]\w*)\s*\n\s*#\s*define\s+\1/m)
    return guardMatch?.[1]
  }

  /**
   * Check if file has main function
   */
  function hasMainFunction(functions: FunctionInfo[]): boolean {
    return functions.some((f) => f.name === "main")
  }

  /**
   * Truncate a string to a maximum length
   */
  function truncate(value: string, maxLen: number): string {
    if (value.length <= maxLen) return value
    return value.slice(0, maxLen - 3) + "..."
  }

  /**
   * Format the C summary
   */
  function formatSummary(filePath: string, metadata: CMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: C ${metadata.isHeader ? "Header" : "Source"} File`)
    lines.push("")

    // Overview
    lines.push("Overview:")
    if (metadata.hasMain) lines.push("- Contains main() function (executable entry point)")
    if (metadata.headerGuard) lines.push(`- Header guard: ${metadata.headerGuard}`)

    const includeCount =
      metadata.includes.stdlib.length + metadata.includes.system.length + metadata.includes.local.length
    if (includeCount > 0) lines.push(`- Includes: ${includeCount} headers`)
    if (metadata.functions.length > 0) lines.push(`- Functions: ${metadata.functions.length}`)
    if (metadata.structs.length > 0) lines.push(`- Structs: ${metadata.structs.length}`)
    if (metadata.enums.length > 0) lines.push(`- Enums: ${metadata.enums.length}`)
    if (metadata.typedefs.length > 0) lines.push(`- Typedefs: ${metadata.typedefs.length}`)
    if (metadata.macros.length > 0) lines.push(`- Macros: ${metadata.macros.length}`)
    if (metadata.globalVariables.length > 0) lines.push(`- Global variables: ${metadata.globalVariables.length}`)
    lines.push("")

    // Includes
    if (includeCount > 0) {
      lines.push("Includes:")
      if (metadata.includes.stdlib.length > 0) {
        lines.push(`  Standard library: ${metadata.includes.stdlib.join(", ")}`)
      }
      if (metadata.includes.system.length > 0) {
        lines.push(`  System: ${metadata.includes.system.join(", ")}`)
      }
      if (metadata.includes.local.length > 0) {
        lines.push(`  Local: ${metadata.includes.local.join(", ")}`)
      }
      lines.push("")
    }

    // Functions
    if (metadata.functions.length > 0) {
      lines.push("Functions:")
      for (const func of metadata.functions.slice(0, 20)) {
        const modifiers: string[] = []
        if (func.isStatic) modifiers.push("static")
        if (func.isInline) modifiers.push("inline")
        const modStr = modifiers.length > 0 ? `[${modifiers.join(", ")}] ` : ""

        const paramStrs = func.params.slice(0, MAX_PARAMS).map((p) => (p.name ? `${p.type} ${p.name}` : p.type))
        if (func.params.length > MAX_PARAMS) paramStrs.push("...")
        const paramList = paramStrs.join(", ")

        const declStr = func.isDeclaration ? " (declaration)" : ""
        lines.push(`  ${modStr}${func.returnType} ${func.name}(${paramList})${declStr}`)
      }
      if (metadata.functions.length > 20) {
        lines.push(`  ... and ${metadata.functions.length - 20} more functions`)
      }
      lines.push("")
    }

    // Structs
    if (metadata.structs.length > 0) {
      lines.push("Structs:")
      for (const struct of metadata.structs.slice(0, 10)) {
        const typedefStr = struct.isTypedef ? " (typedef)" : ""
        lines.push(`  struct ${struct.name}${typedefStr}`)
        for (const field of struct.fields.slice(0, MAX_FIELDS)) {
          const ptrStr = field.isPointer ? "*" : ""
          const arrStr = field.arraySize ? `[${field.arraySize}]` : ""
          lines.push(`    ${field.type} ${ptrStr}${field.name}${arrStr}`)
        }
        if (struct.fields.length > MAX_FIELDS) {
          lines.push(`    ... and ${struct.fields.length - MAX_FIELDS} more fields`)
        }
      }
      if (metadata.structs.length > 10) {
        lines.push(`  ... and ${metadata.structs.length - 10} more structs`)
      }
      lines.push("")
    }

    // Enums
    if (metadata.enums.length > 0) {
      lines.push("Enums:")
      for (const enumDef of metadata.enums.slice(0, 10)) {
        const typedefStr = enumDef.isTypedef ? " (typedef)" : ""
        const valueNames = enumDef.values.slice(0, MAX_ENUM_VALUES).map((v) => v.name)
        if (enumDef.values.length > MAX_ENUM_VALUES) valueNames.push("...")
        lines.push(`  enum ${enumDef.name}${typedefStr}: { ${valueNames.join(", ")} }`)
      }
      if (metadata.enums.length > 10) {
        lines.push(`  ... and ${metadata.enums.length - 10} more enums`)
      }
      lines.push("")
    }

    // Typedefs
    if (metadata.typedefs.length > 0) {
      lines.push("Typedefs:")
      for (const td of metadata.typedefs.slice(0, 15)) {
        lines.push(`  ${td.name} = ${truncate(td.originalType, MAX_VALUE_LENGTH)}`)
      }
      if (metadata.typedefs.length > 15) {
        lines.push(`  ... and ${metadata.typedefs.length - 15} more typedefs`)
      }
      lines.push("")
    }

    // Macros
    if (metadata.macros.length > 0) {
      lines.push("Macros:")
      for (const macro of metadata.macros.slice(0, 15)) {
        if (macro.isFunctionLike) {
          const params = macro.params?.join(", ") ?? ""
          const valueStr = macro.value ? ` -> ${truncate(macro.value, 40)}` : ""
          lines.push(`  ${macro.name}(${params})${valueStr}`)
        } else {
          const valueStr = macro.value ? ` = ${truncate(macro.value, 50)}` : ""
          lines.push(`  ${macro.name}${valueStr}`)
        }
      }
      if (metadata.macros.length > 15) {
        lines.push(`  ... and ${metadata.macros.length - 15} more macros`)
      }
      lines.push("")
    }

    // Global variables
    if (metadata.globalVariables.length > 0) {
      lines.push("Global Variables:")
      for (const gv of metadata.globalVariables.slice(0, 15)) {
        const modifiers: string[] = []
        if (gv.isExtern) modifiers.push("extern")
        if (gv.isStatic) modifiers.push("static")
        if (gv.isConst) modifiers.push("const")
        const modStr = modifiers.length > 0 ? `[${modifiers.join(", ")}] ` : ""
        lines.push(`  ${modStr}${gv.type} ${gv.name}`)
      }
      if (metadata.globalVariables.length > 15) {
        lines.push(`  ... and ${metadata.globalVariables.length - 15} more globals`)
      }
      lines.push("")
    }

    return lines.join("\n").trimEnd()
  }

  /**
   * Input for exploring a C file
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
   * Explore a C file or content and produce a structured summary.
   */
  export async function explore(input: ExploreInput): Promise<CExplorationResult> {
    const filePath = input.filePath ?? "unknown.c"
    const isHeader = filePath.endsWith(".h")
    log.info("exploring C file", { filePath, isHeader })

    try {
      const includes = parseIncludes(input.content)
      const functions = parseFunctions(input.content)
      const structs = parseStructs(input.content)
      const enums = parseEnums(input.content)
      const typedefs = parseTypedefs(input.content)
      const macros = parseMacros(input.content)
      const globalVariables = parseGlobalVariables(input.content)
      const externDeclarations = parseExternDeclarations(input.content)
      const headerGuard = isHeader ? detectHeaderGuard(input.content) : undefined
      const hasMain = hasMainFunction(functions)

      const metadata: CMetadata = {
        includes,
        functions,
        structs,
        enums,
        typedefs,
        macros,
        hasMain,
        isHeader,
        headerGuard,
        globalVariables,
        externDeclarations,
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
          language: "C",
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

      log.info("C exploration complete", {
        filePath,
        isHeader,
        hasMain,
        functionCount: functions.length,
        structCount: structs.length,
        enumCount: enums.length,
        macroCount: macros.length,
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
      log.error("failed to parse C file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          includes: { stdlib: [], system: [], local: [] },
          functions: [],
          structs: [],
          enums: [],
          typedefs: [],
          macros: [],
          hasMain: false,
          isHeader: filePath.endsWith(".h"),
          globalVariables: [],
          externDeclarations: [],
        },
        tokenCount: 0,
        error: `Failed to parse C file: ${errorMessage}`,
      }
    }
  }
}
