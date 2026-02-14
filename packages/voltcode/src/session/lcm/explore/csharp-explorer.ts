import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * C# File Exploration Agent
 *
 * Analyzes C# source files and produces structured summaries showing
 * namespaces, classes, interfaces, structs, enums, methods, and properties.
 */
export namespace CSharpExplorer {
  const log = Log.create({ service: "lcm.explore.csharp" })

  /**
   * Maximum number of items to show in lists
   */
  const MAX_LIST_ITEMS = 20

  /**
   * Using statement categories
   */
  export interface UsingCategories {
    /** System namespaces (System, System.Collections, etc.) */
    system: string[]
    /** Microsoft namespaces */
    microsoft: string[]
    /** Third-party namespaces */
    thirdParty: string[]
    /** Project namespaces (detected heuristically) */
    project: string[]
  }

  /**
   * Class definition
   */
  export interface ClassDefinition {
    name: string
    modifiers: string[]
    baseClass?: string
    interfaces: string[]
    isGeneric: boolean
    genericParams?: string
  }

  /**
   * Interface definition
   */
  export interface InterfaceDefinition {
    name: string
    modifiers: string[]
    methods: string[]
    isGeneric: boolean
    genericParams?: string
  }

  /**
   * Struct definition
   */
  export interface StructDefinition {
    name: string
    modifiers: string[]
    fields: string[]
    isGeneric: boolean
    genericParams?: string
  }

  /**
   * Enum definition
   */
  export interface EnumDefinition {
    name: string
    modifiers: string[]
    values: string[]
  }

  /**
   * Method definition
   */
  export interface MethodDefinition {
    name: string
    modifiers: string[]
    returnType: string
    parameters: string
    isAsync: boolean
  }

  /**
   * Property definition
   */
  export interface PropertyDefinition {
    name: string
    type: string
    modifiers: string[]
    hasGetter: boolean
    hasSetter: boolean
    isAutoProperty: boolean
  }

  /**
   * Attribute usage
   */
  export interface AttributeUsage {
    name: string
    target?: string
  }

  /**
   * Metadata about the C# file
   */
  export interface CSharpMetadata {
    /** Using statements by category */
    usings: UsingCategories
    /** Namespace declarations */
    namespaces: string[]
    /** Class definitions */
    classes: ClassDefinition[]
    /** Interface definitions */
    interfaces: InterfaceDefinition[]
    /** Struct definitions */
    structs: StructDefinition[]
    /** Enum definitions */
    enums: EnumDefinition[]
    /** Top-level or notable methods */
    methods: MethodDefinition[]
    /** Properties */
    properties: PropertyDefinition[]
    /** Attributes used */
    attributes: AttributeUsage[]
    /** Whether the file has a Main method */
    hasMain: boolean
    /** Main method signature if present */
    mainSignature?: string
    /** Whether async/await is used */
    usesAsync: boolean
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of C# exploration
   */
  export interface CSharpExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the C# file */
    metadata: CSharpMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Extract using statements from content
   */
  function extractUsings(content: string): UsingCategories {
    const usings: UsingCategories = {
      system: [],
      microsoft: [],
      thirdParty: [],
      project: [],
    }

    // Common third-party namespace prefixes
    const commonThirdParty = [
      "Newtonsoft",
      "NUnit",
      "Xunit",
      "Moq",
      "AutoMapper",
      "FluentAssertions",
      "Serilog",
      "NLog",
      "Dapper",
      "EntityFramework",
      "MediatR",
      "FluentValidation",
      "Polly",
      "RestSharp",
      "Swashbuckle",
      "StackExchange",
      "Amazon",
      "Google",
      "Azure",
      "Grpc",
      "IdentityServer",
      "Hangfire",
      "Quartz",
      "RabbitMQ",
      "Redis",
      "MongoDB",
      "Npgsql",
      "MySql",
      "Oracle",
      "Confluent",
      "MassTransit",
      "Refit",
      "Bogus",
      "FluentEmail",
    ]

    // Match using statements (including static and alias)
    const usingRegex = /^\s*using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([A-Za-z_][\w.]*);/gm
    let match
    while ((match = usingRegex.exec(content)) !== null) {
      const namespace = match[2]
      const rootNamespace = namespace.split(".")[0]

      if (namespace.startsWith("System")) {
        usings.system.push(namespace)
      } else if (namespace.startsWith("Microsoft")) {
        usings.microsoft.push(namespace)
      } else if (commonThirdParty.includes(rootNamespace)) {
        usings.thirdParty.push(namespace)
      } else {
        usings.project.push(namespace)
      }
    }

    return usings
  }

  /**
   * Extract namespace declarations
   */
  function extractNamespaces(content: string): string[] {
    const namespaces: string[] = []

    // File-scoped namespace (C# 10+)
    const fileScopedRegex = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*;/gm
    let match
    while ((match = fileScopedRegex.exec(content)) !== null) {
      if (!namespaces.includes(match[1])) {
        namespaces.push(match[1])
      }
    }

    // Block-scoped namespace
    const blockScopedRegex = /^\s*namespace\s+([A-Za-z_][\w.]*)\s*\{/gm
    while ((match = blockScopedRegex.exec(content)) !== null) {
      if (!namespaces.includes(match[1])) {
        namespaces.push(match[1])
      }
    }

    return namespaces
  }

  /**
   * Parse modifiers from a modifier string
   */
  function parseModifiers(modifierString: string): string[] {
    const validModifiers = [
      "public",
      "private",
      "protected",
      "internal",
      "static",
      "abstract",
      "sealed",
      "virtual",
      "override",
      "new",
      "readonly",
      "const",
      "volatile",
      "async",
      "partial",
      "extern",
      "unsafe",
    ]
    return modifierString
      .split(/\s+/)
      .filter((m) => validModifiers.includes(m.toLowerCase()))
      .map((m) => m.toLowerCase())
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassDefinition[] {
    const classes: ClassDefinition[] = []

    // Match class declarations
    const classRegex =
      /^\s*((?:public|private|protected|internal|static|abstract|sealed|partial|new)\s+)*class\s+(\w+)(<[^>]+>)?(?:\s*:\s*([^{]+))?\s*\{/gm
    let match
    while ((match = classRegex.exec(content)) !== null) {
      const modifiers = match[1] ? parseModifiers(match[1]) : []
      const name = match[2]
      const genericParams = match[3]?.slice(1, -1) // Remove < >
      const inheritance = match[4]?.trim()

      let baseClass: string | undefined
      const interfaces: string[] = []

      if (inheritance) {
        const parts = inheritance.split(",").map((p) => p.trim())
        for (const part of parts) {
          // First non-interface is likely the base class
          if (!part.startsWith("I") || part.length <= 1 || !/^I[A-Z]/.test(part)) {
            if (!baseClass && !part.startsWith("I")) {
              baseClass = part
            } else {
              interfaces.push(part)
            }
          } else {
            interfaces.push(part)
          }
        }
      }

      classes.push({
        name,
        modifiers,
        baseClass,
        interfaces,
        isGeneric: !!genericParams,
        genericParams,
      })
    }

    return classes.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Extract interface definitions
   */
  function extractInterfaces(content: string): InterfaceDefinition[] {
    const interfaces: InterfaceDefinition[] = []

    const interfaceRegex =
      /^\s*((?:public|private|protected|internal|partial|new)\s+)*interface\s+(\w+)(<[^>]+>)?(?:\s*:\s*([^{]+))?\s*\{([^}]*)\}/gms
    let match
    while ((match = interfaceRegex.exec(content)) !== null) {
      const modifiers = match[1] ? parseModifiers(match[1]) : []
      const name = match[2]
      const genericParams = match[3]?.slice(1, -1)
      const body = match[5]

      // Extract method signatures from interface body
      const methods: string[] = []
      const methodRegex = /^\s*(\w+(?:<[^>]+>)?)\s+(\w+)\s*\([^)]*\)\s*;/gm
      let methodMatch
      while ((methodMatch = methodRegex.exec(body)) !== null) {
        methods.push(methodMatch[2])
      }

      interfaces.push({
        name,
        modifiers,
        methods: methods.slice(0, 10),
        isGeneric: !!genericParams,
        genericParams,
      })
    }

    return interfaces.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Extract struct definitions
   */
  function extractStructs(content: string): StructDefinition[] {
    const structs: StructDefinition[] = []

    const structRegex =
      /^\s*((?:public|private|protected|internal|readonly|partial|new)\s+)*struct\s+(\w+)(<[^>]+>)?\s*\{([^}]*)\}/gms
    let match
    while ((match = structRegex.exec(content)) !== null) {
      const modifiers = match[1] ? parseModifiers(match[1]) : []
      const name = match[2]
      const genericParams = match[3]?.slice(1, -1)
      const body = match[4]

      // Extract field names from struct body
      const fields: string[] = []
      const fieldRegex = /^\s*(?:public|private|protected|internal)?\s*\w+(?:<[^>]+>)?\s+(\w+)\s*[;=]/gm
      let fieldMatch
      while ((fieldMatch = fieldRegex.exec(body)) !== null) {
        fields.push(fieldMatch[1])
      }

      structs.push({
        name,
        modifiers,
        fields: fields.slice(0, 10),
        isGeneric: !!genericParams,
        genericParams,
      })
    }

    return structs.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Extract enum definitions
   */
  function extractEnums(content: string): EnumDefinition[] {
    const enums: EnumDefinition[] = []

    const enumRegex = /^\s*((?:public|private|protected|internal|new)\s+)*enum\s+(\w+)(?:\s*:\s*\w+)?\s*\{([^}]*)\}/gms
    let match
    while ((match = enumRegex.exec(content)) !== null) {
      const modifiers = match[1] ? parseModifiers(match[1]) : []
      const name = match[2]
      const body = match[3]

      // Extract enum values
      const values = body
        .split(",")
        .map((v) => v.trim().split(/[=\s]/)[0])
        .filter((v) => v && /^\w+$/.test(v))

      enums.push({
        name,
        modifiers,
        values: values.slice(0, 10),
      })
    }

    return enums.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Extract method definitions
   */
  function extractMethods(content: string): MethodDefinition[] {
    const methods: MethodDefinition[] = []

    // Match method declarations (simplified, may have false positives)
    const methodRegex =
      /^\s*((?:public|private|protected|internal|static|virtual|override|abstract|sealed|async|new|extern|unsafe)\s+)+(\w+(?:<[^>]+>)?(?:\[\])?(?:\?)?)\s+(\w+)\s*\(([^)]*)\)/gm
    let match
    while ((match = methodRegex.exec(content)) !== null) {
      const modifiers = parseModifiers(match[1])
      const returnType = match[2]
      const name = match[3]
      const parameters = match[4].trim()

      // Skip property accessors and constructors
      if (["get", "set", "init", "add", "remove"].includes(name)) continue
      if (returnType === name) continue // Constructor

      methods.push({
        name,
        modifiers,
        returnType,
        parameters: parameters.length > 50 ? parameters.slice(0, 50) + "..." : parameters,
        isAsync: modifiers.includes("async"),
      })
    }

    return methods.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Extract property definitions
   */
  function extractProperties(content: string): PropertyDefinition[] {
    const properties: PropertyDefinition[] = []

    // Match property declarations - must have get/set in the body
    const propertyRegex =
      /^\s*((?:public|private|protected|internal|static|virtual|override|abstract|sealed|new|readonly)\s+)+(\w+(?:<[^>]+>)?(?:\[\])?(?:\?)?)\s+(\w+)\s*\{([^}]*)\}/gm
    let match
    while ((match = propertyRegex.exec(content)) !== null) {
      const modifiers = parseModifiers(match[1])
      const type = match[2]
      const name = match[3]
      const body = match[4]

      // Skip type declarations (class, interface, struct, enum)
      if (["class", "interface", "struct", "enum"].includes(type)) continue

      // Must have get or set accessor to be a property
      if (!/\b(get|set|init)\b/.test(body)) continue

      const hasGetter = /\bget\b/.test(body)
      const hasSetter = /\bset\b/.test(body) || /\binit\b/.test(body)
      const isAutoProperty = /get\s*;\s*(set|init)?\s*;?/.test(body) || /\{\s*get\s*;\s*\}/.test(body)

      properties.push({
        name,
        type,
        modifiers,
        hasGetter,
        hasSetter,
        isAutoProperty,
      })
    }

    return properties.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Extract attribute usages
   */
  function extractAttributes(content: string): AttributeUsage[] {
    const attributes: AttributeUsage[] = []
    const seen = new Set<string>()

    // Match attributes
    const attributeRegex = /\[(\w+)(?:\([^\]]*\))?\]/g
    let match
    while ((match = attributeRegex.exec(content)) !== null) {
      const name = match[1]
      // Skip common non-attribute patterns
      if (["0", "1", "i", "j", "k", "index"].includes(name)) continue

      if (!seen.has(name)) {
        seen.add(name)
        attributes.push({ name })
      }
    }

    return attributes.slice(0, MAX_LIST_ITEMS)
  }

  /**
   * Check for Main method
   */
  function findMainMethod(content: string): { hasMain: boolean; signature?: string } {
    // Traditional Main methods
    const mainPatterns = [
      /static\s+(?:async\s+)?(?:void|int|Task|Task<int>)\s+Main\s*\([^)]*\)/,
      /static\s+(?:async\s+)?(?:void|int|Task|Task<int>)\s+Main\s*\(\s*\)/,
    ]

    for (const pattern of mainPatterns) {
      const match = content.match(pattern)
      if (match) {
        return { hasMain: true, signature: match[0] }
      }
    }

    // Top-level statements (C# 9+) - check for code outside of class/namespace
    const hasTopLevelStatements =
      /^(?!.*(?:namespace|class|interface|struct|enum|using)\b)[^{]*(?:Console\.|await|var\s+\w+\s*=)/m.test(content)

    if (hasTopLevelStatements) {
      return { hasMain: true, signature: "Top-level statements" }
    }

    return { hasMain: false }
  }

  /**
   * Check for async/await usage
   */
  function usesAsyncAwait(content: string): boolean {
    return /\basync\b/.test(content) && /\bawait\b/.test(content)
  }

  /**
   * Format the summary
   */
  function formatSummary(filePath: string, metadata: CSharpMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: C#`)
    lines.push(`Lines: ${metadata.lineCount}`)
    lines.push("")

    // Usings summary
    const totalUsings =
      metadata.usings.system.length +
      metadata.usings.microsoft.length +
      metadata.usings.thirdParty.length +
      metadata.usings.project.length

    if (totalUsings > 0) {
      lines.push("Using statements:")
      if (metadata.usings.system.length > 0) {
        lines.push(
          `  System: ${metadata.usings.system.slice(0, 5).join(", ")}${metadata.usings.system.length > 5 ? ` (+${metadata.usings.system.length - 5} more)` : ""}`,
        )
      }
      if (metadata.usings.microsoft.length > 0) {
        lines.push(
          `  Microsoft: ${metadata.usings.microsoft.slice(0, 5).join(", ")}${metadata.usings.microsoft.length > 5 ? ` (+${metadata.usings.microsoft.length - 5} more)` : ""}`,
        )
      }
      if (metadata.usings.thirdParty.length > 0) {
        lines.push(
          `  Third-party: ${metadata.usings.thirdParty.slice(0, 5).join(", ")}${metadata.usings.thirdParty.length > 5 ? ` (+${metadata.usings.thirdParty.length - 5} more)` : ""}`,
        )
      }
      if (metadata.usings.project.length > 0) {
        lines.push(
          `  Project: ${metadata.usings.project.slice(0, 5).join(", ")}${metadata.usings.project.length > 5 ? ` (+${metadata.usings.project.length - 5} more)` : ""}`,
        )
      }
      lines.push("")
    }

    // Namespaces
    if (metadata.namespaces.length > 0) {
      lines.push(`Namespaces: ${metadata.namespaces.join(", ")}`)
      lines.push("")
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push("Classes:")
      for (const cls of metadata.classes) {
        const mods = cls.modifiers.length > 0 ? `[${cls.modifiers.join(" ")}] ` : ""
        const generic = cls.isGeneric ? `<${cls.genericParams}>` : ""
        const inheritance: string[] = []
        if (cls.baseClass) inheritance.push(cls.baseClass)
        inheritance.push(...cls.interfaces)
        const inheritStr = inheritance.length > 0 ? ` : ${inheritance.join(", ")}` : ""
        lines.push(`  ${mods}${cls.name}${generic}${inheritStr}`)
      }
      lines.push("")
    }

    // Interfaces
    if (metadata.interfaces.length > 0) {
      lines.push("Interfaces:")
      for (const iface of metadata.interfaces) {
        const mods = iface.modifiers.length > 0 ? `[${iface.modifiers.join(" ")}] ` : ""
        const generic = iface.isGeneric ? `<${iface.genericParams}>` : ""
        const methodStr = iface.methods.length > 0 ? ` (methods: ${iface.methods.join(", ")})` : ""
        lines.push(`  ${mods}${iface.name}${generic}${methodStr}`)
      }
      lines.push("")
    }

    // Structs
    if (metadata.structs.length > 0) {
      lines.push("Structs:")
      for (const struct of metadata.structs) {
        const mods = struct.modifiers.length > 0 ? `[${struct.modifiers.join(" ")}] ` : ""
        const generic = struct.isGeneric ? `<${struct.genericParams}>` : ""
        const fieldStr = struct.fields.length > 0 ? ` (fields: ${struct.fields.join(", ")})` : ""
        lines.push(`  ${mods}${struct.name}${generic}${fieldStr}`)
      }
      lines.push("")
    }

    // Enums
    if (metadata.enums.length > 0) {
      lines.push("Enums:")
      for (const enumDef of metadata.enums) {
        const mods = enumDef.modifiers.length > 0 ? `[${enumDef.modifiers.join(" ")}] ` : ""
        const values =
          enumDef.values.length > 0
            ? ` { ${enumDef.values.slice(0, 5).join(", ")}${enumDef.values.length > 5 ? ", ..." : ""} }`
            : ""
        lines.push(`  ${mods}${enumDef.name}${values}`)
      }
      lines.push("")
    }

    // Methods
    if (metadata.methods.length > 0) {
      lines.push("Methods:")
      for (const method of metadata.methods.slice(0, 15)) {
        const mods = method.modifiers.length > 0 ? `[${method.modifiers.join(" ")}] ` : ""
        const asyncMark = method.isAsync ? "async " : ""
        lines.push(`  ${mods}${asyncMark}${method.returnType} ${method.name}(${method.parameters})`)
      }
      if (metadata.methods.length > 15) {
        lines.push(`  ... and ${metadata.methods.length - 15} more methods`)
      }
      lines.push("")
    }

    // Properties
    if (metadata.properties.length > 0) {
      lines.push("Properties:")
      for (const prop of metadata.properties.slice(0, 15)) {
        const mods = prop.modifiers.length > 0 ? `[${prop.modifiers.join(" ")}] ` : ""
        const accessors = []
        if (prop.hasGetter) accessors.push("get")
        if (prop.hasSetter) accessors.push("set")
        const auto = prop.isAutoProperty ? " (auto)" : ""
        lines.push(`  ${mods}${prop.type} ${prop.name} { ${accessors.join("; ")} }${auto}`)
      }
      if (metadata.properties.length > 15) {
        lines.push(`  ... and ${metadata.properties.length - 15} more properties`)
      }
      lines.push("")
    }

    // Attributes
    if (metadata.attributes.length > 0) {
      lines.push(`Attributes: [${metadata.attributes.map((a) => a.name).join("], [")}]`)
      lines.push("")
    }

    // Features
    const features: string[] = []
    if (metadata.hasMain) {
      features.push(`Entry point: ${metadata.mainSignature ?? "Main"}`)
    }
    if (metadata.usesAsync) {
      features.push("Uses async/await")
    }

    if (features.length > 0) {
      lines.push("Features:")
      for (const feature of features) {
        lines.push(`  - ${feature}`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Input for exploring a C# file
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
   * Explore a C# file and produce a structured summary.
   */
  export async function explore(input: ExploreInput): Promise<CSharpExplorationResult> {
    const filePath = input.filePath ?? "unknown.cs"
    log.info("exploring C# file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all metadata
      const usings = extractUsings(content)
      const namespaces = extractNamespaces(content)
      const classes = extractClasses(content)
      const interfaces = extractInterfaces(content)
      const structs = extractStructs(content)
      const enums = extractEnums(content)
      const methods = extractMethods(content)
      const properties = extractProperties(content)
      const attributes = extractAttributes(content)
      const mainInfo = findMainMethod(content)
      const usesAsync = usesAsyncAwait(content)

      const metadata: CSharpMetadata = {
        usings,
        namespaces,
        classes,
        interfaces,
        structs,
        enums,
        methods,
        properties,
        attributes,
        hasMain: mainInfo.hasMain,
        mainSignature: mainInfo.signature,
        usesAsync,
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
          language: "C#",
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

      log.info("C# exploration complete", {
        filePath,
        lineCount,
        classes: classes.length,
        interfaces: interfaces.length,
        methods: methods.length,
        hasMain: mainInfo.hasMain,
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
      log.error("failed to explore C# file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          usings: { system: [], microsoft: [], thirdParty: [], project: [] },
          namespaces: [],
          classes: [],
          interfaces: [],
          structs: [],
          enums: [],
          methods: [],
          properties: [],
          attributes: [],
          hasMain: false,
          usesAsync: false,
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to explore C# file: ${errorMessage}`,
      }
    }
  }
}
