import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * C++ File Exploration Agent
 *
 * Analyzes C++ files (.cpp, .hpp, .cc, .cxx, .hxx, .h) and produces
 * structured summaries showing includes, namespaces, classes, structs,
 * templates, and functions.
 */
export namespace CppExplorer {
  const log = Log.create({ service: "lcm.explore.cpp" })

  /**
   * Maximum number of items to list in each category
   */
  const MAX_ITEMS = 15

  /**
   * Maximum text length for samples
   */
  const MAX_TEXT_LENGTH = 80

  /**
   * Include categorization
   */
  export interface IncludeInfo {
    /** C++ standard library headers (<iostream>, <vector>, etc.) */
    cppStdlib: string[]
    /** C standard library headers (<cstdio>, <cstdlib>, etc.) */
    cStdlib: string[]
    /** System headers (angle bracket includes not in std libs) */
    system: string[]
    /** Local headers (quoted includes) */
    local: string[]
  }

  /**
   * Namespace information
   */
  export interface NamespaceInfo {
    name: string
    isUsing: boolean
  }

  /**
   * Class information
   */
  export interface ClassInfo {
    name: string
    baseClasses: string[]
    isTemplate: boolean
    templateParams?: string
    methods: string[]
    accessSpecifiers: ("public" | "protected" | "private")[]
  }

  /**
   * Struct information
   */
  export interface StructInfo {
    name: string
    isTemplate: boolean
    templateParams?: string
    fields: string[]
    methods: string[]
  }

  /**
   * Template information (standalone)
   */
  export interface TemplateInfo {
    name: string
    kind: "class" | "struct" | "function"
    templateParams: string
  }

  /**
   * Function information
   */
  export interface FunctionInfo {
    name: string
    returnType?: string
    isInline: boolean
    isConstexpr: boolean
    isVirtual: boolean
    isStatic: boolean
    isOperator: boolean
    signature?: string
  }

  /**
   * Using statement information
   */
  export interface UsingInfo {
    kind: "namespace" | "alias" | "declaration"
    name: string
    target?: string
  }

  /**
   * Metadata about the C++ file
   */
  export interface CppMetadata {
    /** Categorized includes */
    includes: IncludeInfo
    /** Total include count */
    includeCount: number
    /** Namespace declarations and using statements */
    namespaces: NamespaceInfo[]
    /** Class definitions */
    classes: ClassInfo[]
    /** Struct definitions */
    structs: StructInfo[]
    /** Standalone template definitions */
    templates: TemplateInfo[]
    /** Function definitions */
    functions: FunctionInfo[]
    /** Using statements */
    usingStatements: UsingInfo[]
    /** Whether file has main function */
    hasMain: boolean
    /** Whether this is a header file */
    isHeader: boolean
    /** Whether file has header guard */
    hasHeaderGuard: boolean
    /** Whether file uses #pragma once */
    hasPragmaOnce: boolean
    /** Operator overloads found */
    operatorOverloads: string[]
    /** Line count */
    lineCount: number
  }

  /**
   * Result of C++ exploration
   */
  export interface CppExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the C++ file */
    metadata: CppMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * C++ standard library headers
   */
  const CPP_STDLIB_HEADERS = new Set([
    // Containers
    "array",
    "deque",
    "forward_list",
    "list",
    "map",
    "queue",
    "set",
    "stack",
    "unordered_map",
    "unordered_set",
    "vector",
    // I/O
    "iostream",
    "fstream",
    "sstream",
    "istream",
    "ostream",
    "iomanip",
    "ios",
    "streambuf",
    // Strings
    "string",
    "string_view",
    "regex",
    // Algorithms
    "algorithm",
    "numeric",
    // Utilities
    "utility",
    "tuple",
    "optional",
    "variant",
    "any",
    "functional",
    "memory",
    "chrono",
    "ratio",
    "type_traits",
    "typeinfo",
    "typeindex",
    "bitset",
    // Concurrency
    "thread",
    "mutex",
    "shared_mutex",
    "condition_variable",
    "future",
    "atomic",
    // Exceptions
    "exception",
    "stdexcept",
    "system_error",
    // Iterators
    "iterator",
    // Numerics
    "complex",
    "valarray",
    "random",
    "cmath",
    "limits",
    // Memory
    "new",
    "scoped_allocator",
    "memory_resource",
    // Filesystem
    "filesystem",
    // Ranges (C++20)
    "ranges",
    "span",
    // Concepts (C++20)
    "concepts",
    // Coroutines (C++20)
    "coroutine",
    // Format (C++20)
    "format",
    // Source location (C++20)
    "source_location",
    // Other
    "initializer_list",
    "compare",
    "version",
    "execution",
    "numbers",
  ])

  /**
   * C standard library headers (with c prefix)
   */
  const C_STDLIB_HEADERS = new Set([
    "cassert",
    "cctype",
    "cerrno",
    "cfenv",
    "cfloat",
    "cinttypes",
    "climits",
    "clocale",
    "cmath",
    "csetjmp",
    "csignal",
    "cstdarg",
    "cstddef",
    "cstdint",
    "cstdio",
    "cstdlib",
    "cstring",
    "ctime",
    "cuchar",
    "cwchar",
    "cwctype",
  ])

  /**
   * Check if a header is from the C++ standard library
   */
  function isCppStdlib(header: string): boolean {
    return CPP_STDLIB_HEADERS.has(header)
  }

  /**
   * Check if a header is from the C standard library
   */
  function isCStdlib(header: string): boolean {
    return C_STDLIB_HEADERS.has(header)
  }

  /**
   * Extract includes from content
   */
  function extractIncludes(content: string): IncludeInfo {
    const includes: IncludeInfo = {
      cppStdlib: [],
      cStdlib: [],
      system: [],
      local: [],
    }

    // Angle bracket includes: #include <...>
    const angleBracketRegex = /#\s*include\s*<([^>]+)>/g
    let match
    while ((match = angleBracketRegex.exec(content)) !== null) {
      const header = match[1].trim()
      const baseName = header.replace(/\.h(pp)?$/, "")

      if (isCppStdlib(baseName)) {
        if (!includes.cppStdlib.includes(header)) {
          includes.cppStdlib.push(header)
        }
      } else if (isCStdlib(baseName)) {
        if (!includes.cStdlib.includes(header)) {
          includes.cStdlib.push(header)
        }
      } else {
        if (!includes.system.includes(header)) {
          includes.system.push(header)
        }
      }
    }

    // Quoted includes: #include "..."
    const quotedRegex = /#\s*include\s*"([^"]+)"/g
    while ((match = quotedRegex.exec(content)) !== null) {
      const header = match[1].trim()
      if (!includes.local.includes(header)) {
        includes.local.push(header)
      }
    }

    return includes
  }

  /**
   * Extract namespace declarations
   */
  function extractNamespaces(content: string): NamespaceInfo[] {
    const namespaces: NamespaceInfo[] = []
    const seen = new Set<string>()

    // Namespace declarations: namespace Name { or namespace Name::Sub {
    const nsRegex = /\bnamespace\s+([\w:]+)\s*\{/g
    let match
    while ((match = nsRegex.exec(content)) !== null) {
      const name = match[1]
      if (!seen.has(`decl:${name}`)) {
        seen.add(`decl:${name}`)
        namespaces.push({ name, isUsing: false })
      }
    }

    // Using namespace: using namespace Name;
    const usingNsRegex = /\busing\s+namespace\s+([\w:]+)\s*;/g
    while ((match = usingNsRegex.exec(content)) !== null) {
      const name = match[1]
      if (!seen.has(`using:${name}`)) {
        seen.add(`using:${name}`)
        namespaces.push({ name, isUsing: true })
      }
    }

    return namespaces
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []

    // Remove comments and strings to avoid false positives
    const cleaned = removeCommentsAndStrings(content)

    // Match class definitions with optional template and inheritance
    // Template classes
    const templateClassRegex =
      /template\s*<([^>]+)>\s*class\s+(\w+)(?:\s*:\s*(?:public|protected|private)?\s*([\w:<>,\s]+))?\s*\{/g
    let match
    while ((match = templateClassRegex.exec(cleaned)) !== null) {
      const templateParams = match[1].trim()
      const className = match[2]
      const inheritance = match[3]

      const baseClasses = inheritance
        ? inheritance
            .split(",")
            .map((s) =>
              s
                .trim()
                .replace(/^(public|protected|private)\s+/, "")
                .trim(),
            )
            .filter((s) => s)
        : []

      const classContent = extractBraceContent(cleaned, match.index + match[0].length - 1)
      const methods = extractClassMethods(classContent)
      const accessSpecifiers = extractAccessSpecifiers(classContent)

      classes.push({
        name: className,
        baseClasses,
        isTemplate: true,
        templateParams,
        methods,
        accessSpecifiers,
      })
    }

    // Regular classes
    const classRegex =
      /(?<!template\s*<[^>]*>\s*)\bclass\s+(\w+)(?:\s*:\s*(?:public|protected|private)?\s*([\w:<>,\s]+))?\s*\{/g
    while ((match = classRegex.exec(cleaned)) !== null) {
      const className = match[1]
      // Skip if already found as template
      if (classes.some((c) => c.name === className)) continue

      const inheritance = match[2]
      const baseClasses = inheritance
        ? inheritance
            .split(",")
            .map((s) =>
              s
                .trim()
                .replace(/^(public|protected|private)\s+/, "")
                .trim(),
            )
            .filter((s) => s)
        : []

      const classContent = extractBraceContent(cleaned, match.index + match[0].length - 1)
      const methods = extractClassMethods(classContent)
      const accessSpecifiers = extractAccessSpecifiers(classContent)

      classes.push({
        name: className,
        baseClasses,
        isTemplate: false,
        methods,
        accessSpecifiers,
      })
    }

    return classes
  }

  /**
   * Extract struct definitions
   */
  function extractStructs(content: string): StructInfo[] {
    const structs: StructInfo[] = []
    const cleaned = removeCommentsAndStrings(content)

    // Template structs
    const templateStructRegex = /template\s*<([^>]+)>\s*struct\s+(\w+)\s*\{/g
    let match
    while ((match = templateStructRegex.exec(cleaned)) !== null) {
      const templateParams = match[1].trim()
      const structName = match[2]

      const structContent = extractBraceContent(cleaned, match.index + match[0].length - 1)
      const { fields, methods } = extractStructMembers(structContent)

      structs.push({
        name: structName,
        isTemplate: true,
        templateParams,
        fields,
        methods,
      })
    }

    // Regular structs
    const structRegex = /(?<!template\s*<[^>]*>\s*)\bstruct\s+(\w+)\s*\{/g
    while ((match = structRegex.exec(cleaned)) !== null) {
      const structName = match[1]
      // Skip if already found as template
      if (structs.some((s) => s.name === structName)) continue

      const structContent = extractBraceContent(cleaned, match.index + match[0].length - 1)
      const { fields, methods } = extractStructMembers(structContent)

      structs.push({
        name: structName,
        isTemplate: false,
        fields,
        methods,
      })
    }

    return structs
  }

  /**
   * Extract standalone template definitions (not already captured as classes/structs)
   */
  function extractTemplates(content: string, classes: ClassInfo[], structs: StructInfo[]): TemplateInfo[] {
    const templates: TemplateInfo[] = []
    const cleaned = removeCommentsAndStrings(content)

    // Template function definitions
    const templateFuncRegex = /template\s*<([^>]+)>\s*(?:inline\s+)?(?:constexpr\s+)?(?:\w+\s+)+(\w+)\s*\([^)]*\)/g
    let match
    while ((match = templateFuncRegex.exec(cleaned)) !== null) {
      const templateParams = match[1].trim()
      const name = match[2]

      // Skip if it's a class or struct template we already captured
      if (classes.some((c) => c.name === name) || structs.some((s) => s.name === name)) continue
      // Skip constructors/destructors
      if (name.startsWith("~")) continue

      templates.push({
        name,
        kind: "function",
        templateParams,
      })
    }

    return templates
  }

  /**
   * Extract function definitions
   */
  function extractFunctions(content: string, classes: ClassInfo[], structs: StructInfo[]): FunctionInfo[] {
    const functions: FunctionInfo[] = []
    const cleaned = removeCommentsAndStrings(content)

    // Get class/struct names to filter out methods
    const classStructNames = new Set([...classes.map((c) => c.name), ...structs.map((s) => s.name)])

    // Match function definitions at file scope
    // Pattern: optional qualifiers, return type, function name, parameters
    const funcRegex =
      /(?:^|\n)\s*((?:inline\s+|constexpr\s+|static\s+|virtual\s+|extern\s+)*)([\w:*&<>,\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?(?:\{|;)/g

    let match
    while ((match = funcRegex.exec(cleaned)) !== null) {
      const qualifiers = match[1]
      const returnType = match[2].trim()
      const name = match[3]
      const params = match[4]

      // Skip class/struct scoped methods (ClassName::methodName)
      if (name.includes("::")) {
        const className = name.split("::")[0]
        if (classStructNames.has(className)) continue
      }

      // Skip if name is a keyword or looks like a control structure
      if (["if", "while", "for", "switch", "catch", "return", "sizeof", "alignof", "typeid"].includes(name)) continue

      // Skip constructors/destructors of known classes
      if (classStructNames.has(name) || name.startsWith("~")) continue

      const isInline = qualifiers.includes("inline")
      const isConstexpr = qualifiers.includes("constexpr")
      const isVirtual = qualifiers.includes("virtual")
      const isStatic = qualifiers.includes("static")
      const isOperator = name.startsWith("operator")

      const signature = `${returnType} ${name}(${params.slice(0, MAX_TEXT_LENGTH)}${params.length > MAX_TEXT_LENGTH ? "..." : ""})`

      functions.push({
        name,
        returnType,
        isInline,
        isConstexpr,
        isVirtual,
        isStatic,
        isOperator,
        signature,
      })
    }

    return functions
  }

  /**
   * Extract operator overloads
   */
  function extractOperatorOverloads(content: string): string[] {
    const operators: string[] = []
    const cleaned = removeCommentsAndStrings(content)

    // Match operator overload declarations
    const operatorRegex = /\boperator\s*([+\-*/%^&|~!=<>]+|==|!=|<=|>=|<<|>>|\[\]|\(\)|->|\+\+|--|\+=|-=|\*=|\/=|%=)/g
    let match
    while ((match = operatorRegex.exec(cleaned)) !== null) {
      const op = `operator${match[1]}`
      if (!operators.includes(op)) {
        operators.push(op)
      }
    }

    return operators
  }

  /**
   * Extract using statements
   */
  function extractUsingStatements(content: string): UsingInfo[] {
    const usingStmts: UsingInfo[] = []
    const cleaned = removeCommentsAndStrings(content)

    // using namespace X;
    const usingNsRegex = /\busing\s+namespace\s+([\w:]+)\s*;/g
    let match
    while ((match = usingNsRegex.exec(cleaned)) !== null) {
      usingStmts.push({
        kind: "namespace",
        name: match[1],
      })
    }

    // using X = Y; (type alias)
    const usingAliasRegex = /\busing\s+(\w+)\s*=\s*([^;]+);/g
    while ((match = usingAliasRegex.exec(cleaned)) !== null) {
      usingStmts.push({
        kind: "alias",
        name: match[1],
        target: match[2].trim().slice(0, MAX_TEXT_LENGTH),
      })
    }

    // using X::Y; (declaration)
    const usingDeclRegex = /\busing\s+([\w:]+::\w+)\s*;/g
    while ((match = usingDeclRegex.exec(cleaned)) !== null) {
      const name = match[1]
      // Skip if it's a namespace using
      if (!name.includes("::")) continue
      usingStmts.push({
        kind: "declaration",
        name,
      })
    }

    return usingStmts
  }

  /**
   * Check for main function
   */
  function hasMainFunction(content: string): boolean {
    const cleaned = removeCommentsAndStrings(content)
    return /\bint\s+main\s*\([^)]*\)/.test(cleaned)
  }

  /**
   * Check for header guard
   */
  function hasHeaderGuard(content: string): boolean {
    return /#\s*ifndef\s+\w+\s*\n\s*#\s*define\s+\w+/.test(content)
  }

  /**
   * Check for #pragma once
   */
  function hasPragmaOnce(content: string): boolean {
    return /#\s*pragma\s+once/.test(content)
  }

  /**
   * Check if file is a header file based on path
   */
  function isHeaderFile(filePath?: string): boolean {
    if (!filePath) return false
    const ext = filePath.split(".").pop()?.toLowerCase()
    return ["h", "hpp", "hxx", "hh", "h++", "tpp", "ipp", "inl"].includes(ext ?? "")
  }

  /**
   * Remove comments and string literals from content
   */
  function removeCommentsAndStrings(content: string): string {
    // Remove single line comments
    let result = content.replace(/\/\/[^\n]*/g, "")
    // Remove multi-line comments
    result = result.replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove string literals (simplified)
    result = result.replace(/"(?:[^"\\]|\\.)*"/g, '""')
    result = result.replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // Remove raw string literals R"(...)"
    result = result.replace(/R"\([^)]*\)"/g, '""')
    return result
  }

  /**
   * Extract content between matching braces starting at position
   */
  function extractBraceContent(content: string, startPos: number): string {
    let depth = 1
    let pos = startPos + 1
    const start = startPos + 1

    while (pos < content.length && depth > 0) {
      if (content[pos] === "{") depth++
      else if (content[pos] === "}") depth--
      pos++
    }

    return content.slice(start, pos - 1)
  }

  /**
   * Extract method names from class content
   */
  function extractClassMethods(classContent: string): string[] {
    const methods: string[] = []

    // Match method declarations (simplified)
    const methodRegex =
      /(?:virtual\s+)?(?:static\s+)?(?:inline\s+)?(?:constexpr\s+)?(?:[\w:*&<>,\s]+)\s+(\w+)\s*\([^)]*\)/g
    let match
    while ((match = methodRegex.exec(classContent)) !== null) {
      const name = match[1]
      // Skip if it's a constructor (no return type means it starts with the name)
      if (!["if", "while", "for", "switch", "return"].includes(name) && !methods.includes(name)) {
        methods.push(name)
      }
    }

    return methods.slice(0, MAX_ITEMS)
  }

  /**
   * Extract access specifiers from class content
   */
  function extractAccessSpecifiers(classContent: string): ("public" | "protected" | "private")[] {
    const specifiers: ("public" | "protected" | "private")[] = []

    if (/\bpublic\s*:/.test(classContent)) specifiers.push("public")
    if (/\bprotected\s*:/.test(classContent)) specifiers.push("protected")
    if (/\bprivate\s*:/.test(classContent)) specifiers.push("private")

    return specifiers
  }

  /**
   * Extract struct members (fields and methods)
   */
  function extractStructMembers(structContent: string): { fields: string[]; methods: string[] } {
    const fields: string[] = []
    const methods: string[] = []

    // Simple field detection: type name;
    const fieldRegex = /(?:const\s+)?(?:static\s+)?([\w:*&<>,\s]+)\s+(\w+)\s*(?:=\s*[^;]+)?;/g
    let match
    while ((match = fieldRegex.exec(structContent)) !== null) {
      const type = match[1].trim()
      const name = match[2]

      // Skip if it looks like a method
      if (structContent.includes(`${name}(`)) continue
      // Skip keywords
      if (["return", "break", "continue", "typedef", "using"].includes(name)) continue

      fields.push(`${name}: ${type.slice(0, 30)}`)
    }

    // Method detection
    const methodRegex = /(?:[\w:*&<>,\s]+)\s+(\w+)\s*\([^)]*\)\s*(?:const\s*)?(?:\{|;)/g
    while ((match = methodRegex.exec(structContent)) !== null) {
      const name = match[1]
      if (!["if", "while", "for", "switch", "return"].includes(name) && !methods.includes(name)) {
        methods.push(name)
      }
    }

    return { fields: fields.slice(0, MAX_ITEMS), methods: methods.slice(0, MAX_ITEMS) }
  }

  /**
   * Format the C++ summary
   */
  function formatSummary(filePath: string, metadata: CppMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    const fileType = metadata.isHeader ? "C++ Header" : "C++ Source"
    lines.push(`Format: ${fileType} (${metadata.lineCount} lines)`)

    // Header protection
    if (metadata.isHeader) {
      if (metadata.hasPragmaOnce) {
        lines.push("Header protection: #pragma once")
      } else if (metadata.hasHeaderGuard) {
        lines.push("Header protection: Header guard")
      }
    }

    // Main function
    if (metadata.hasMain) {
      lines.push("Entry point: main() function present")
    }

    lines.push("")

    // Includes
    if (metadata.includeCount > 0) {
      lines.push("Includes:")
      if (metadata.includes.cppStdlib.length > 0) {
        lines.push(`  C++ Standard Library (${metadata.includes.cppStdlib.length}):`)
        for (const inc of metadata.includes.cppStdlib.slice(0, 8)) {
          lines.push(`    <${inc}>`)
        }
        if (metadata.includes.cppStdlib.length > 8) {
          lines.push(`    ... and ${metadata.includes.cppStdlib.length - 8} more`)
        }
      }
      if (metadata.includes.cStdlib.length > 0) {
        lines.push(`  C Standard Library (${metadata.includes.cStdlib.length}):`)
        for (const inc of metadata.includes.cStdlib.slice(0, 5)) {
          lines.push(`    <${inc}>`)
        }
        if (metadata.includes.cStdlib.length > 5) {
          lines.push(`    ... and ${metadata.includes.cStdlib.length - 5} more`)
        }
      }
      if (metadata.includes.system.length > 0) {
        lines.push(`  System (${metadata.includes.system.length}):`)
        for (const inc of metadata.includes.system.slice(0, 5)) {
          lines.push(`    <${inc}>`)
        }
        if (metadata.includes.system.length > 5) {
          lines.push(`    ... and ${metadata.includes.system.length - 5} more`)
        }
      }
      if (metadata.includes.local.length > 0) {
        lines.push(`  Local (${metadata.includes.local.length}):`)
        for (const inc of metadata.includes.local.slice(0, 5)) {
          lines.push(`    "${inc}"`)
        }
        if (metadata.includes.local.length > 5) {
          lines.push(`    ... and ${metadata.includes.local.length - 5} more`)
        }
      }
    }

    // Namespaces
    const declaredNs = metadata.namespaces.filter((n) => !n.isUsing)
    const usingNs = metadata.namespaces.filter((n) => n.isUsing)
    if (metadata.namespaces.length > 0) {
      lines.push("")
      lines.push("Namespaces:")
      if (declaredNs.length > 0) {
        lines.push(`  Declared: ${declaredNs.map((n) => n.name).join(", ")}`)
      }
      if (usingNs.length > 0) {
        lines.push(`  Using: ${usingNs.map((n) => n.name).join(", ")}`)
      }
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push("")
      lines.push(`Classes (${metadata.classes.length}):`)
      for (const cls of metadata.classes.slice(0, MAX_ITEMS)) {
        const templateStr = cls.isTemplate ? `<${cls.templateParams}>` : ""
        const inheritance = cls.baseClasses.length > 0 ? ` : ${cls.baseClasses.join(", ")}` : ""
        lines.push(`  class ${cls.name}${templateStr}${inheritance}`)
        if (cls.accessSpecifiers.length > 0) {
          lines.push(`    Access: ${cls.accessSpecifiers.join(", ")}`)
        }
        if (cls.methods.length > 0) {
          lines.push(`    Methods: ${cls.methods.slice(0, 5).join(", ")}${cls.methods.length > 5 ? " ..." : ""}`)
        }
      }
      if (metadata.classes.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.classes.length - MAX_ITEMS} more classes`)
      }
    }

    // Structs
    if (metadata.structs.length > 0) {
      lines.push("")
      lines.push(`Structs (${metadata.structs.length}):`)
      for (const str of metadata.structs.slice(0, MAX_ITEMS)) {
        const templateStr = str.isTemplate ? `<${str.templateParams}>` : ""
        lines.push(`  struct ${str.name}${templateStr}`)
        if (str.fields.length > 0) {
          lines.push(`    Fields: ${str.fields.slice(0, 3).join(", ")}${str.fields.length > 3 ? " ..." : ""}`)
        }
        if (str.methods.length > 0) {
          lines.push(`    Methods: ${str.methods.slice(0, 3).join(", ")}${str.methods.length > 3 ? " ..." : ""}`)
        }
      }
      if (metadata.structs.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.structs.length - MAX_ITEMS} more structs`)
      }
    }

    // Templates
    if (metadata.templates.length > 0) {
      lines.push("")
      lines.push(`Template Functions (${metadata.templates.length}):`)
      for (const tmpl of metadata.templates.slice(0, MAX_ITEMS)) {
        lines.push(`  template<${tmpl.templateParams}> ${tmpl.name}`)
      }
      if (metadata.templates.length > MAX_ITEMS) {
        lines.push(`  ... and ${metadata.templates.length - MAX_ITEMS} more templates`)
      }
    }

    // Functions
    const regularFunctions = metadata.functions.filter((f) => !f.isOperator)
    if (regularFunctions.length > 0) {
      lines.push("")
      lines.push(`Functions (${regularFunctions.length}):`)
      for (const func of regularFunctions.slice(0, MAX_ITEMS)) {
        const qualifiers: string[] = []
        if (func.isInline) qualifiers.push("inline")
        if (func.isConstexpr) qualifiers.push("constexpr")
        if (func.isVirtual) qualifiers.push("virtual")
        if (func.isStatic) qualifiers.push("static")
        const qualStr = qualifiers.length > 0 ? `[${qualifiers.join(", ")}] ` : ""
        lines.push(`  ${qualStr}${func.signature ?? func.name}`)
      }
      if (regularFunctions.length > MAX_ITEMS) {
        lines.push(`  ... and ${regularFunctions.length - MAX_ITEMS} more functions`)
      }
    }

    // Operator overloads
    if (metadata.operatorOverloads.length > 0) {
      lines.push("")
      lines.push(`Operator Overloads (${metadata.operatorOverloads.length}):`)
      lines.push(`  ${metadata.operatorOverloads.join(", ")}`)
    }

    // Using statements
    const typeAliases = metadata.usingStatements.filter((u) => u.kind === "alias")
    if (typeAliases.length > 0) {
      lines.push("")
      lines.push(`Type Aliases (${typeAliases.length}):`)
      for (const alias of typeAliases.slice(0, 5)) {
        lines.push(`  using ${alias.name} = ${alias.target}`)
      }
      if (typeAliases.length > 5) {
        lines.push(`  ... and ${typeAliases.length - 5} more`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Input for exploring a C++ file
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
   * Explore a C++ file or content and produce a structured summary.
   */
  export async function explore(input: ExploreInput): Promise<CppExplorationResult> {
    const filePath = input.filePath ?? "unknown.cpp"
    log.info("exploring C++ file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all components
      const includes = extractIncludes(content)
      const namespaces = extractNamespaces(content)
      const classes = extractClasses(content)
      const structs = extractStructs(content)
      const templates = extractTemplates(content, classes, structs)
      const functions = extractFunctions(content, classes, structs)
      const usingStatements = extractUsingStatements(content)
      const operatorOverloads = extractOperatorOverloads(content)
      const hasMain = hasMainFunction(content)
      const isHeader = isHeaderFile(filePath)
      const headerGuard = hasHeaderGuard(content)
      const pragmaOnce = hasPragmaOnce(content)

      const includeCount =
        includes.cppStdlib.length + includes.cStdlib.length + includes.system.length + includes.local.length

      const metadata: CppMetadata = {
        includes,
        includeCount,
        namespaces,
        classes,
        structs,
        templates,
        functions,
        usingStatements,
        hasMain,
        isHeader,
        hasHeaderGuard: headerGuard,
        hasPragmaOnce: pragmaOnce,
        operatorOverloads,
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
          language: "C++",
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

      log.info("C++ exploration complete", {
        filePath,
        lineCount,
        includeCount,
        classCount: classes.length,
        structCount: structs.length,
        functionCount: functions.length,
        hasMain,
        isHeader,
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
      log.error("failed to parse C++", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          includes: { cppStdlib: [], cStdlib: [], system: [], local: [] },
          includeCount: 0,
          namespaces: [],
          classes: [],
          structs: [],
          templates: [],
          functions: [],
          usingStatements: [],
          hasMain: false,
          isHeader: false,
          hasHeaderGuard: false,
          hasPragmaOnce: false,
          operatorOverloads: [],
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to parse C++: ${errorMessage}`,
      }
    }
  }
}
