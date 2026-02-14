import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Rust File Exploration Agent
 *
 * Analyzes Rust source files (.rs) and produces structured summaries showing
 * crate type, imports, modules, structs, enums, traits, impl blocks, functions,
 * and exports.
 */
export namespace RustExplorer {
  const log = Log.create({ service: "lcm.explore.rust" })

  /**
   * Import categories for Rust use statements
   */
  export interface RustImports {
    /** Standard library imports (std::*, core::*, alloc::*) */
    std: string[]
    /** External crate imports */
    external: string[]
    /** Local module imports (crate::, super::, self::) */
    local: string[]
  }

  /**
   * Information about a struct definition
   */
  export interface StructInfo {
    name: string
    /** Summary of fields (e.g., "3 fields" or field names) */
    fieldsSummary: string
    /** Derive macros applied */
    derives: string[]
    /** Whether it's public */
    isPublic: boolean
  }

  /**
   * Information about an enum definition
   */
  export interface EnumInfo {
    name: string
    /** List of variant names */
    variants: string[]
    /** Derive macros applied */
    derives: string[]
    /** Whether it's public */
    isPublic: boolean
  }

  /**
   * Information about a trait definition
   */
  export interface TraitInfo {
    name: string
    /** List of method names */
    methods: string[]
    /** Whether it's public */
    isPublic: boolean
  }

  /**
   * Information about an impl block
   */
  export interface ImplInfo {
    /** The type being implemented for */
    targetType: string
    /** The trait being implemented (if any) */
    traitName?: string
    /** List of method names */
    methods: string[]
  }

  /**
   * Information about a function definition
   */
  export interface FunctionInfo {
    name: string
    /** Function modifiers (async, const, unsafe) */
    modifiers: string[]
    /** Whether it's public */
    isPublic: boolean
  }

  /**
   * Information about a macro definition
   */
  export interface MacroInfo {
    name: string
    /** Whether it's exported with #[macro_export] */
    isExported: boolean
  }

  /**
   * Metadata extracted from a Rust file
   */
  export interface RustMetadata {
    /** Crate type (lib, bin, or undefined) */
    crateType?: "lib" | "bin"
    /** Whether this is a lib.rs file */
    isLibRs: boolean
    /** Whether this is a main.rs file */
    isMainRs: boolean
    /** Import statements categorized */
    imports: RustImports
    /** Module declarations */
    modules: string[]
    /** Struct definitions */
    structs: StructInfo[]
    /** Enum definitions */
    enums: EnumInfo[]
    /** Trait definitions */
    traits: TraitInfo[]
    /** Impl blocks */
    impls: ImplInfo[]
    /** Top-level function definitions */
    functions: FunctionInfo[]
    /** Macro definitions */
    macros: MacroInfo[]
    /** Public exports (pub items) */
    exports: string[]
    /** Whether the file has a main function */
    hasMain: boolean
    /** Line count */
    lineCount: number
  }

  /**
   * Result of Rust file exploration
   */
  export interface RustExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Rust file */
    metadata: RustMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Extract crate type from file path or content
   */
  function detectCrateType(
    filePath: string,
    content: string,
  ): { crateType?: "lib" | "bin"; isLibRs: boolean; isMainRs: boolean } {
    const fileName = filePath.split("/").pop() ?? ""
    const isLibRs = fileName === "lib.rs"
    const isMainRs = fileName === "main.rs"

    // Check for #![crate_type] attribute
    const crateTypeMatch = content.match(/#!\[crate_type\s*=\s*"(lib|bin)"\]/)
    if (crateTypeMatch) {
      return { crateType: crateTypeMatch[1] as "lib" | "bin", isLibRs, isMainRs }
    }

    // Infer from file name
    if (isLibRs) {
      return { crateType: "lib", isLibRs, isMainRs }
    }
    if (isMainRs) {
      return { crateType: "bin", isLibRs, isMainRs }
    }

    return { crateType: undefined, isLibRs, isMainRs }
  }

  /**
   * Extract use statements and categorize them
   */
  function extractImports(content: string): RustImports {
    const imports: RustImports = { std: [], external: [], local: [] }

    // Match use statements (handles multi-line and nested)
    const useRegex = /^\s*(?:pub\s+)?use\s+([^;]+);/gm
    let match

    while ((match = useRegex.exec(content)) !== null) {
      const importPath = match[1].trim()

      // Categorize the import
      if (importPath.startsWith("std::") || importPath.startsWith("core::") || importPath.startsWith("alloc::")) {
        imports.std.push(importPath)
      } else if (
        importPath.startsWith("crate::") ||
        importPath.startsWith("super::") ||
        importPath.startsWith("self::")
      ) {
        imports.local.push(importPath)
      } else {
        imports.external.push(importPath)
      }
    }

    return imports
  }

  /**
   * Extract module declarations
   */
  function extractModules(content: string): string[] {
    const modules: string[] = []
    const modRegex = /^\s*(pub\s+)?mod\s+(\w+)\s*[;{]/gm
    let match

    while ((match = modRegex.exec(content)) !== null) {
      const visibility = match[1] ? "pub " : ""
      modules.push(`${visibility}mod ${match[2]}`)
    }

    return modules
  }

  /**
   * Extract derive macros from an attribute block
   */
  function extractDerives(attributeBlock: string): string[] {
    const derives: string[] = []
    const deriveRegex = /#\[derive\(([^)]+)\)\]/g
    let match

    while ((match = deriveRegex.exec(attributeBlock)) !== null) {
      const deriveList = match[1].split(",").map((d) => d.trim())
      derives.push(...deriveList)
    }

    return derives
  }

  /**
   * Extract struct definitions
   */
  function extractStructs(content: string): StructInfo[] {
    const structs: StructInfo[] = []

    // Match structs with optional attributes and derive macros
    // This regex captures the attributes before the struct and the struct definition
    const structRegex = /((?:#\[[^\]]+\]\s*)*)(pub\s+)?struct\s+(\w+)(?:<[^>]+>)?\s*(\{[^}]*\}|;|\([^)]*\))/gs
    let match

    while ((match = structRegex.exec(content)) !== null) {
      const attributes = match[1] || ""
      const isPublic = !!match[2]
      const name = match[3]
      const body = match[4]

      const derives = extractDerives(attributes)

      // Determine fields summary
      let fieldsSummary = "unit struct"
      if (body.startsWith("{")) {
        const fields = body.match(/(\w+)\s*:/g) || []
        if (fields.length > 0) {
          if (fields.length <= 3) {
            fieldsSummary = fields.map((f) => f.replace(":", "").trim()).join(", ")
          } else {
            fieldsSummary = `${fields.length} fields`
          }
        } else {
          fieldsSummary = "empty"
        }
      } else if (body.startsWith("(")) {
        const tupleFields = body
          .slice(1, -1)
          .split(",")
          .filter((f) => f.trim())
        fieldsSummary = `tuple(${tupleFields.length})`
      }

      structs.push({ name, fieldsSummary, derives, isPublic })
    }

    return structs
  }

  /**
   * Extract enum definitions
   */
  function extractEnums(content: string): EnumInfo[] {
    const enums: EnumInfo[] = []

    // Match enums with optional attributes
    const enumRegex = /((?:#\[[^\]]+\]\s*)*)(pub\s+)?enum\s+(\w+)(?:<[^>]+>)?\s*\{([^}]*)\}/gs
    let match

    while ((match = enumRegex.exec(content)) !== null) {
      const attributes = match[1] || ""
      const isPublic = !!match[2]
      const name = match[3]
      const body = match[4]

      const derives = extractDerives(attributes)

      // Extract variant names
      const variants: string[] = []
      const variantRegex = /(\w+)(?:\s*\{|\s*\(|,|\s*$)/g
      let variantMatch

      while ((variantMatch = variantRegex.exec(body)) !== null) {
        if (variantMatch[1] && !variants.includes(variantMatch[1])) {
          variants.push(variantMatch[1])
        }
      }

      enums.push({ name, variants, derives, isPublic })
    }

    return enums
  }

  /**
   * Extract trait definitions
   */
  function extractTraits(content: string): TraitInfo[] {
    const traits: TraitInfo[] = []

    // Match trait definitions
    const traitRegex = /(pub\s+)?trait\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*[^{]+)?\s*\{([^}]*)\}/gs
    let match

    while ((match = traitRegex.exec(content)) !== null) {
      const isPublic = !!match[1]
      const name = match[2]
      const body = match[3]

      // Extract method names from trait body
      const methods: string[] = []
      const methodRegex = /fn\s+(\w+)/g
      let methodMatch

      while ((methodMatch = methodRegex.exec(body)) !== null) {
        methods.push(methodMatch[1])
      }

      traits.push({ name, methods, isPublic })
    }

    return traits
  }

  /**
   * Extract impl blocks
   */
  function extractImpls(content: string): ImplInfo[] {
    const impls: ImplInfo[] = []

    // Match impl blocks - handles both "impl Type" and "impl Trait for Type"
    const implRegex = /impl(?:<[^>]+>)?\s+(?:(\w+)(?:<[^>]+>)?\s+for\s+)?(\w+)(?:<[^>]+>)?\s*(?:where[^{]*)?\{/g
    let match

    while ((match = implRegex.exec(content)) !== null) {
      const traitName = match[1]
      const targetType = match[2]

      // Find the matching closing brace and extract method names
      const startIndex = match.index + match[0].length
      let braceCount = 1
      let endIndex = startIndex

      for (let i = startIndex; i < content.length && braceCount > 0; i++) {
        if (content[i] === "{") braceCount++
        if (content[i] === "}") braceCount--
        endIndex = i
      }

      const implBody = content.slice(startIndex, endIndex)

      // Extract method names
      const methods: string[] = []
      const methodRegex = /(?:pub\s+)?(?:async\s+)?(?:const\s+)?(?:unsafe\s+)?fn\s+(\w+)/g
      let methodMatch

      while ((methodMatch = methodRegex.exec(implBody)) !== null) {
        methods.push(methodMatch[1])
      }

      impls.push({ targetType, traitName, methods })
    }

    return impls
  }

  /**
   * Extract top-level function definitions
   */
  function extractFunctions(content: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []

    // Match function definitions at top level (not inside impl blocks)
    // This is a simplified approach - looks for fn at start of line
    const fnRegex = /^(pub\s+)?(async\s+)?(const\s+)?(unsafe\s+)?fn\s+(\w+)/gm
    let match

    while ((match = fnRegex.exec(content)) !== null) {
      const isPublic = !!match[1]
      const modifiers: string[] = []
      if (match[2]) modifiers.push("async")
      if (match[3]) modifiers.push("const")
      if (match[4]) modifiers.push("unsafe")
      const name = match[5]

      functions.push({ name, modifiers, isPublic })
    }

    return functions
  }

  /**
   * Check if the file has a main function
   */
  function hasMainFunction(content: string): boolean {
    return /^\s*(?:pub\s+)?(?:async\s+)?fn\s+main\s*\(/m.test(content)
  }

  /**
   * Extract macro definitions
   */
  function extractMacros(content: string): MacroInfo[] {
    const macros: MacroInfo[] = []

    // Match macro_rules! definitions
    const macroRegex = /(#\[macro_export\]\s*)?macro_rules!\s+(\w+)/g
    let match

    while ((match = macroRegex.exec(content)) !== null) {
      const isExported = !!match[1]
      const name = match[2]
      macros.push({ name, isExported })
    }

    return macros
  }

  /**
   * Extract public exports
   */
  function extractExports(content: string): string[] {
    const exports: string[] = []

    // Match pub items (simplified - just captures the item type and name)
    const pubRegex = /^pub\s+(struct|enum|trait|fn|const|static|type|mod)\s+(\w+)/gm
    let match

    while ((match = pubRegex.exec(content)) !== null) {
      exports.push(`pub ${match[1]} ${match[2]}`)
    }

    // Also check for pub use (re-exports)
    const pubUseRegex = /^pub\s+use\s+([^;]+);/gm
    while ((match = pubUseRegex.exec(content)) !== null) {
      exports.push(`pub use ${match[1]}`)
    }

    return exports
  }

  /**
   * Format the exploration summary
   */
  function formatSummary(filePath: string, metadata: RustMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: Rust`)
    lines.push(`Lines: ${metadata.lineCount}`)

    if (metadata.crateType) {
      lines.push(`Crate type: ${metadata.crateType}`)
    }
    if (metadata.hasMain) {
      lines.push(`Entry point: fn main()`)
    }

    // Imports
    const totalImports = metadata.imports.std.length + metadata.imports.external.length + metadata.imports.local.length
    if (totalImports > 0) {
      lines.push("")
      lines.push("Imports:")
      if (metadata.imports.std.length > 0) {
        lines.push(
          `  std: ${metadata.imports.std.length} (${metadata.imports.std.slice(0, 3).join(", ")}${metadata.imports.std.length > 3 ? "..." : ""})`,
        )
      }
      if (metadata.imports.external.length > 0) {
        lines.push(
          `  external: ${metadata.imports.external.length} (${metadata.imports.external.slice(0, 3).join(", ")}${metadata.imports.external.length > 3 ? "..." : ""})`,
        )
      }
      if (metadata.imports.local.length > 0) {
        lines.push(
          `  local: ${metadata.imports.local.length} (${metadata.imports.local.slice(0, 3).join(", ")}${metadata.imports.local.length > 3 ? "..." : ""})`,
        )
      }
    }

    // Modules
    if (metadata.modules.length > 0) {
      lines.push("")
      lines.push("Modules:")
      for (const mod of metadata.modules.slice(0, 10)) {
        lines.push(`  ${mod}`)
      }
      if (metadata.modules.length > 10) {
        lines.push(`  ... and ${metadata.modules.length - 10} more`)
      }
    }

    // Structs
    if (metadata.structs.length > 0) {
      lines.push("")
      lines.push("Structs:")
      for (const s of metadata.structs.slice(0, 10)) {
        const vis = s.isPublic ? "pub " : ""
        const derives = s.derives.length > 0 ? ` [${s.derives.join(", ")}]` : ""
        lines.push(`  ${vis}${s.name} (${s.fieldsSummary})${derives}`)
      }
      if (metadata.structs.length > 10) {
        lines.push(`  ... and ${metadata.structs.length - 10} more`)
      }
    }

    // Enums
    if (metadata.enums.length > 0) {
      lines.push("")
      lines.push("Enums:")
      for (const e of metadata.enums.slice(0, 10)) {
        const vis = e.isPublic ? "pub " : ""
        const variants = e.variants.length <= 4 ? e.variants.join(", ") : `${e.variants.length} variants`
        const derives = e.derives.length > 0 ? ` [${e.derives.join(", ")}]` : ""
        lines.push(`  ${vis}${e.name} { ${variants} }${derives}`)
      }
      if (metadata.enums.length > 10) {
        lines.push(`  ... and ${metadata.enums.length - 10} more`)
      }
    }

    // Traits
    if (metadata.traits.length > 0) {
      lines.push("")
      lines.push("Traits:")
      for (const t of metadata.traits.slice(0, 10)) {
        const vis = t.isPublic ? "pub " : ""
        const methods = t.methods.length <= 4 ? t.methods.join(", ") : `${t.methods.length} methods`
        lines.push(`  ${vis}${t.name} { ${methods} }`)
      }
      if (metadata.traits.length > 10) {
        lines.push(`  ... and ${metadata.traits.length - 10} more`)
      }
    }

    // Impl blocks
    if (metadata.impls.length > 0) {
      lines.push("")
      lines.push("Impl blocks:")
      for (const i of metadata.impls.slice(0, 10)) {
        const traitPart = i.traitName ? `${i.traitName} for ` : ""
        const methods = i.methods.length <= 4 ? i.methods.join(", ") : `${i.methods.length} methods`
        lines.push(`  impl ${traitPart}${i.targetType} { ${methods} }`)
      }
      if (metadata.impls.length > 10) {
        lines.push(`  ... and ${metadata.impls.length - 10} more`)
      }
    }

    // Functions
    if (metadata.functions.length > 0) {
      lines.push("")
      lines.push("Functions:")
      for (const f of metadata.functions.slice(0, 15)) {
        const vis = f.isPublic ? "pub " : ""
        const mods = f.modifiers.length > 0 ? f.modifiers.join(" ") + " " : ""
        lines.push(`  ${vis}${mods}fn ${f.name}`)
      }
      if (metadata.functions.length > 15) {
        lines.push(`  ... and ${metadata.functions.length - 15} more`)
      }
    }

    // Macros
    if (metadata.macros.length > 0) {
      lines.push("")
      lines.push("Macros:")
      for (const m of metadata.macros.slice(0, 10)) {
        const exported = m.isExported ? " [exported]" : ""
        lines.push(`  macro_rules! ${m.name}${exported}`)
      }
      if (metadata.macros.length > 10) {
        lines.push(`  ... and ${metadata.macros.length - 10} more`)
      }
    }

    // Exports summary
    if (metadata.exports.length > 0) {
      lines.push("")
      lines.push(`Exports: ${metadata.exports.length} public items`)
    }

    return lines.join("\n")
  }

  /**
   * Input for exploring a Rust file
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
   * Explore a Rust file and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<RustExplorationResult> {
    const filePath = input.filePath ?? "unknown.rs"
    log.info("exploring Rust file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all metadata
      const { crateType, isLibRs, isMainRs } = detectCrateType(filePath, content)
      const imports = extractImports(content)
      const modules = extractModules(content)
      const structs = extractStructs(content)
      const enums = extractEnums(content)
      const traits = extractTraits(content)
      const impls = extractImpls(content)
      const functions = extractFunctions(content)
      const macros = extractMacros(content)
      const exports = extractExports(content)
      const hasMain = hasMainFunction(content)

      const metadata: RustMetadata = {
        crateType,
        isLibRs,
        isMainRs,
        imports,
        modules,
        structs,
        enums,
        traits,
        impls,
        functions,
        macros,
        exports,
        hasMain,
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
          language: "Rust",
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

      log.info("Rust exploration complete", {
        filePath,
        crateType,
        hasMain,
        structCount: structs.length,
        enumCount: enums.length,
        traitCount: traits.length,
        implCount: impls.length,
        functionCount: functions.length,
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
      log.error("failed to explore Rust file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          crateType: undefined,
          isLibRs: false,
          isMainRs: false,
          imports: { std: [], external: [], local: [] },
          modules: [],
          structs: [],
          enums: [],
          traits: [],
          impls: [],
          functions: [],
          macros: [],
          exports: [],
          hasMain: false,
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to explore Rust file: ${errorMessage}`,
      }
    }
  }
}
