import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Java File Exploration Agent
 *
 * Analyzes Java source files and produces structured summaries showing
 * packages, imports, classes, interfaces, enums, methods, and fields.
 */
export namespace JavaExplorer {
  const log = Log.create({ service: "lcm.explore.java" })

  /**
   * Maximum methods to show per class
   */
  const MAX_METHODS_PER_CLASS = 20

  /**
   * Maximum fields to show per class
   */
  const MAX_FIELDS_PER_CLASS = 15

  /**
   * Import categories
   */
  export interface ImportInfo {
    /** java.* standard library imports */
    java: string[]
    /** javax.* extension imports */
    javax: string[]
    /** Third-party imports (org.*, com.*, etc.) */
    thirdParty: string[]
    /** Project-specific imports */
    project: string[]
  }

  /**
   * Class definition information
   */
  export interface ClassInfo {
    name: string
    modifiers: string[]
    extends?: string
    implements: string[]
    isAbstract: boolean
    isFinal: boolean
    isStatic: boolean
    annotations: string[]
    isInner: boolean
  }

  /**
   * Interface definition information
   */
  export interface InterfaceInfo {
    name: string
    modifiers: string[]
    extends: string[]
    annotations: string[]
    methods: string[]
  }

  /**
   * Enum definition information
   */
  export interface EnumInfo {
    name: string
    modifiers: string[]
    values: string[]
    annotations: string[]
    implements: string[]
  }

  /**
   * Method definition information
   */
  export interface MethodInfo {
    name: string
    modifiers: string[]
    returnType: string
    parameters: string[]
    throws: string[]
    annotations: string[]
    isConstructor: boolean
  }

  /**
   * Field definition information
   */
  export interface FieldInfo {
    name: string
    type: string
    modifiers: string[]
    annotations: string[]
  }

  /**
   * Annotation information
   */
  export interface AnnotationInfo {
    name: string
    count: number
  }

  /**
   * Metadata about the Java file
   */
  export interface JavaMetadata {
    /** Package declaration */
    packageName: string | null
    /** Import statements by category */
    imports: ImportInfo
    /** Class definitions */
    classes: ClassInfo[]
    /** Interface definitions */
    interfaces: InterfaceInfo[]
    /** Enum definitions */
    enums: EnumInfo[]
    /** Method definitions */
    methods: MethodInfo[]
    /** Field definitions */
    fields: FieldInfo[]
    /** Whether file has a main method */
    hasMain: boolean
    /** All annotations used in the file */
    annotations: AnnotationInfo[]
    /** Inner class count */
    innerClassCount: number
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of Java exploration
   */
  export interface JavaExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Java file */
    metadata: JavaMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring a Java file
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
   * Extract package declaration
   */
  function extractPackage(content: string): string | null {
    const match = content.match(/^\s*package\s+([\w.]+)\s*;/m)
    return match ? match[1] : null
  }

  /**
   * Extract import statements and categorize them
   */
  function extractImports(content: string): ImportInfo {
    const imports: ImportInfo = {
      java: [],
      javax: [],
      thirdParty: [],
      project: [],
    }

    const importRegex = /^\s*import\s+(static\s+)?([\w.*]+)\s*;/gm
    let match
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[2]
      const isStatic = !!match[1]
      const prefix = isStatic ? "static " : ""

      if (importPath.startsWith("java.")) {
        imports.java.push(prefix + importPath)
      } else if (importPath.startsWith("javax.")) {
        imports.javax.push(prefix + importPath)
      } else if (
        importPath.startsWith("org.") ||
        importPath.startsWith("com.") ||
        importPath.startsWith("io.") ||
        importPath.startsWith("net.")
      ) {
        imports.thirdParty.push(prefix + importPath)
      } else {
        imports.project.push(prefix + importPath)
      }
    }

    return imports
  }

  /**
   * Extract annotations from a declaration
   */
  function extractAnnotations(text: string): string[] {
    const annotations: string[] = []
    const annotationRegex = /@(\w+)(?:\([^)]*\))?/g
    let match
    while ((match = annotationRegex.exec(text)) !== null) {
      annotations.push(match[1])
    }
    return annotations
  }

  /**
   * Extract modifiers from a declaration
   */
  function extractModifiers(declaration: string): string[] {
    const modifiers: string[] = []
    const modifierKeywords = [
      "public",
      "private",
      "protected",
      "static",
      "final",
      "abstract",
      "synchronized",
      "native",
      "transient",
      "volatile",
      "strictfp",
      "default",
    ]

    for (const mod of modifierKeywords) {
      const regex = new RegExp(`\\b${mod}\\b`)
      if (regex.test(declaration)) {
        modifiers.push(mod)
      }
    }
    return modifiers
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []

    // Match class declarations with annotations
    const classRegex =
      /((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|private|protected|static|final|abstract|strictfp)\s+)*class\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+([\w.<>,\s]+?))?(?:\s+implements\s+([\w.<>,\s]+?))?\s*\{/g

    let match
    let depth = 0
    while ((match = classRegex.exec(content)) !== null) {
      const annotationBlock = match[1] || ""
      const modifierBlock = match[2] || ""
      const className = match[3]
      const extendsClause = match[4]?.trim()
      const implementsClause = match[5]?.trim()

      const annotations = extractAnnotations(annotationBlock)
      const modifiers = extractModifiers(modifierBlock)

      // Determine if inner class by checking if we're inside another class
      const beforeMatch = content.substring(0, match.index)
      const openBraces = (beforeMatch.match(/\{/g) || []).length
      const closeBraces = (beforeMatch.match(/\}/g) || []).length
      depth = openBraces - closeBraces

      const implementsList = implementsClause ? implementsClause.split(",").map((s) => s.trim().split("<")[0]) : []

      classes.push({
        name: className,
        modifiers,
        extends: extendsClause?.split("<")[0],
        implements: implementsList,
        isAbstract: modifiers.includes("abstract"),
        isFinal: modifiers.includes("final"),
        isStatic: modifiers.includes("static"),
        annotations,
        isInner: depth > 0,
      })
    }

    return classes
  }

  /**
   * Extract interface definitions
   */
  function extractInterfaces(content: string): InterfaceInfo[] {
    const interfaces: InterfaceInfo[] = []

    const interfaceRegex =
      /((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|private|protected|static|abstract|strictfp)\s+)*interface\s+(\w+)(?:<[^>]+>)?(?:\s+extends\s+([\w.<>,\s]+?))?\s*\{/g

    let match
    while ((match = interfaceRegex.exec(content)) !== null) {
      const annotationBlock = match[1] || ""
      const modifierBlock = match[2] || ""
      const interfaceName = match[3]
      const extendsClause = match[4]?.trim()

      const annotations = extractAnnotations(annotationBlock)
      const modifiers = extractModifiers(modifierBlock)

      const extendsList = extendsClause ? extendsClause.split(",").map((s) => s.trim().split("<")[0]) : []

      // Extract method signatures within the interface (simplified)
      const interfaceStart = match.index + match[0].length
      const methods: string[] = []

      // Find matching closing brace
      let braceCount = 1
      let pos = interfaceStart
      while (pos < content.length && braceCount > 0) {
        if (content[pos] === "{") braceCount++
        if (content[pos] === "}") braceCount--
        pos++
      }

      const interfaceBody = content.substring(interfaceStart, pos - 1)
      const methodRegex = /(?:default\s+)?(\w+(?:<[^>]+>)?)\s+(\w+)\s*\([^)]*\)/g
      let methodMatch
      while ((methodMatch = methodRegex.exec(interfaceBody)) !== null) {
        methods.push(methodMatch[2])
      }

      interfaces.push({
        name: interfaceName,
        modifiers,
        extends: extendsList,
        annotations,
        methods: methods.slice(0, 10),
      })
    }

    return interfaces
  }

  /**
   * Extract enum definitions
   */
  function extractEnums(content: string): EnumInfo[] {
    const enums: EnumInfo[] = []

    const enumRegex =
      /((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|private|protected|static|strictfp)\s+)*enum\s+(\w+)(?:\s+implements\s+([\w.<>,\s]+?))?\s*\{/g

    let match
    while ((match = enumRegex.exec(content)) !== null) {
      const annotationBlock = match[1] || ""
      const modifierBlock = match[2] || ""
      const enumName = match[3]
      const implementsClause = match[4]?.trim()

      const annotations = extractAnnotations(annotationBlock)
      const modifiers = extractModifiers(modifierBlock)

      const implementsList = implementsClause ? implementsClause.split(",").map((s) => s.trim().split("<")[0]) : []

      // Extract enum values
      const enumStart = match.index + match[0].length
      let braceCount = 1
      let pos = enumStart
      while (pos < content.length && braceCount > 0) {
        if (content[pos] === "{") braceCount++
        if (content[pos] === "}") braceCount--
        pos++
      }

      const enumBody = content.substring(enumStart, pos - 1)
      // Enum values are before the first semicolon or method
      const valuesSection = enumBody.split(/[;{]/)[0]
      const values = valuesSection
        .split(",")
        .map((v) => v.trim().split(/[(\s]/)[0])
        .filter((v) => v && /^[A-Z_][A-Z0-9_]*$/i.test(v))

      enums.push({
        name: enumName,
        modifiers,
        values: values.slice(0, 20),
        annotations,
        implements: implementsList,
      })
    }

    return enums
  }

  /**
   * Extract method definitions
   */
  function extractMethods(content: string): MethodInfo[] {
    const methods: MethodInfo[] = []

    // Remove string literals and comments to avoid false matches
    const cleanContent = content
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")

    // Match method declarations
    const methodRegex =
      /((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|private|protected|static|final|abstract|synchronized|native|strictfp|default)\s+)*([\w<>\[\],\s.?]+?)\s+(\w+)\s*\(([^)]*)\)(?:\s+throws\s+([\w,\s.]+?))?\s*(?:\{|;)/g

    let match
    while ((match = methodRegex.exec(cleanContent)) !== null) {
      const annotationBlock = match[1] || ""
      const modifierBlock = match[2] || ""
      const returnType = match[3].trim()
      const methodName = match[4]
      const params = match[5].trim()
      const throwsClause = match[6]?.trim()

      // Skip if return type looks like a keyword or class name (likely not a method)
      if (["class", "interface", "enum", "if", "for", "while", "switch", "try", "catch"].includes(returnType)) {
        continue
      }

      const annotations = extractAnnotations(annotationBlock)
      const modifiers = extractModifiers(modifierBlock)

      const parameters = params
        ? params.split(",").map((p) => {
            const parts = p.trim().split(/\s+/)
            return parts.length >= 2 ? `${parts[parts.length - 2]} ${parts[parts.length - 1]}` : p.trim()
          })
        : []

      const throwsList = throwsClause ? throwsClause.split(",").map((t) => t.trim()) : []

      // Check if constructor (return type matches a class name pattern and method name)
      const isConstructor = returnType === methodName || !returnType

      methods.push({
        name: methodName,
        modifiers,
        returnType: isConstructor ? "" : returnType,
        parameters,
        throws: throwsList,
        annotations,
        isConstructor,
      })
    }

    return methods
  }

  /**
   * Extract field definitions
   */
  function extractFields(content: string): FieldInfo[] {
    const fields: FieldInfo[] = []

    // Remove method bodies to avoid matching local variables
    const cleanContent = content
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")

    // Match field declarations (outside method bodies is tricky, so we match at class level)
    const fieldRegex =
      /((?:@\w+(?:\([^)]*\))?\s*)*)((?:public|private|protected|static|final|transient|volatile)\s+)+([\w<>\[\],\s.?]+?)\s+(\w+)(?:\s*=\s*[^;]+)?\s*;/g

    let match
    while ((match = fieldRegex.exec(cleanContent)) !== null) {
      const annotationBlock = match[1] || ""
      const modifierBlock = match[2] || ""
      const fieldType = match[3].trim()
      const fieldName = match[4]

      // Skip if type looks like control flow keyword
      if (["class", "interface", "enum", "if", "for", "while", "return", "throw"].includes(fieldType)) {
        continue
      }

      const annotations = extractAnnotations(annotationBlock)
      const modifiers = extractModifiers(modifierBlock)

      fields.push({
        name: fieldName,
        type: fieldType,
        modifiers,
        annotations,
      })
    }

    return fields
  }

  /**
   * Check for main method
   */
  function hasMainMethod(content: string): boolean {
    return /public\s+static\s+void\s+main\s*\(\s*String\s*\[\s*\]\s+\w+\s*\)/.test(content)
  }

  /**
   * Collect all annotations used in the file
   */
  function collectAnnotations(content: string): AnnotationInfo[] {
    const annotationCounts = new Map<string, number>()
    const annotationRegex = /@(\w+)/g

    let match
    while ((match = annotationRegex.exec(content)) !== null) {
      const name = match[1]
      annotationCounts.set(name, (annotationCounts.get(name) || 0) + 1)
    }

    return Array.from(annotationCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
  }

  /**
   * Format the Java file summary
   */
  function formatSummary(filePath: string, metadata: JavaMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: Java Source`)
    lines.push(`Lines: ${metadata.lineCount.toLocaleString("en-US")}`)
    lines.push("")

    // Package
    if (metadata.packageName) {
      lines.push(`Package: ${metadata.packageName}`)
      lines.push("")
    }

    // Imports summary
    const totalImports =
      metadata.imports.java.length +
      metadata.imports.javax.length +
      metadata.imports.thirdParty.length +
      metadata.imports.project.length

    if (totalImports > 0) {
      lines.push("Imports:")
      if (metadata.imports.java.length > 0) {
        lines.push(
          `  java.* (${metadata.imports.java.length}): ${metadata.imports.java.slice(0, 3).join(", ")}${metadata.imports.java.length > 3 ? ", ..." : ""}`,
        )
      }
      if (metadata.imports.javax.length > 0) {
        lines.push(
          `  javax.* (${metadata.imports.javax.length}): ${metadata.imports.javax.slice(0, 3).join(", ")}${metadata.imports.javax.length > 3 ? ", ..." : ""}`,
        )
      }
      if (metadata.imports.thirdParty.length > 0) {
        lines.push(
          `  Third-party (${metadata.imports.thirdParty.length}): ${metadata.imports.thirdParty.slice(0, 3).join(", ")}${metadata.imports.thirdParty.length > 3 ? ", ..." : ""}`,
        )
      }
      if (metadata.imports.project.length > 0) {
        lines.push(
          `  Project (${metadata.imports.project.length}): ${metadata.imports.project.slice(0, 3).join(", ")}${metadata.imports.project.length > 3 ? ", ..." : ""}`,
        )
      }
      lines.push("")
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push("Classes:")
      for (const cls of metadata.classes.slice(0, 10)) {
        const mods = cls.modifiers.length > 0 ? cls.modifiers.join(" ") + " " : ""
        const ext = cls.extends ? ` extends ${cls.extends}` : ""
        const impl = cls.implements.length > 0 ? ` implements ${cls.implements.join(", ")}` : ""
        const inner = cls.isInner ? " (inner)" : ""
        const annots = cls.annotations.length > 0 ? ` [@${cls.annotations.join(", @")}]` : ""
        lines.push(`  ${mods}class ${cls.name}${ext}${impl}${inner}${annots}`)
      }
      if (metadata.classes.length > 10) {
        lines.push(`  ... and ${metadata.classes.length - 10} more classes`)
      }
      lines.push("")
    }

    // Interfaces
    if (metadata.interfaces.length > 0) {
      lines.push("Interfaces:")
      for (const iface of metadata.interfaces.slice(0, 5)) {
        const mods = iface.modifiers.length > 0 ? iface.modifiers.join(" ") + " " : ""
        const ext = iface.extends.length > 0 ? ` extends ${iface.extends.join(", ")}` : ""
        const methods = iface.methods.length > 0 ? ` { ${iface.methods.join("(), ")}() }` : ""
        lines.push(`  ${mods}interface ${iface.name}${ext}${methods}`)
      }
      if (metadata.interfaces.length > 5) {
        lines.push(`  ... and ${metadata.interfaces.length - 5} more interfaces`)
      }
      lines.push("")
    }

    // Enums
    if (metadata.enums.length > 0) {
      lines.push("Enums:")
      for (const enm of metadata.enums.slice(0, 5)) {
        const mods = enm.modifiers.length > 0 ? enm.modifiers.join(" ") + " " : ""
        const values =
          enm.values.length > 0
            ? ` { ${enm.values.slice(0, 5).join(", ")}${enm.values.length > 5 ? ", ..." : ""} }`
            : ""
        lines.push(`  ${mods}enum ${enm.name}${values}`)
      }
      if (metadata.enums.length > 5) {
        lines.push(`  ... and ${metadata.enums.length - 5} more enums`)
      }
      lines.push("")
    }

    // Methods
    if (metadata.methods.length > 0) {
      const constructors = metadata.methods.filter((m) => m.isConstructor)
      const regularMethods = metadata.methods.filter((m) => !m.isConstructor)

      if (constructors.length > 0) {
        lines.push("Constructors:")
        for (const ctor of constructors.slice(0, 5)) {
          const mods = ctor.modifiers.length > 0 ? ctor.modifiers.join(" ") + " " : ""
          const params = ctor.parameters.join(", ")
          const throws = ctor.throws.length > 0 ? ` throws ${ctor.throws.join(", ")}` : ""
          lines.push(`  ${mods}${ctor.name}(${params})${throws}`)
        }
        if (constructors.length > 5) {
          lines.push(`  ... and ${constructors.length - 5} more constructors`)
        }
        lines.push("")
      }

      lines.push("Methods:")
      for (const method of regularMethods.slice(0, MAX_METHODS_PER_CLASS)) {
        const mods = method.modifiers.length > 0 ? method.modifiers.join(" ") + " " : ""
        const params =
          method.parameters.length > 3
            ? `${method.parameters.slice(0, 3).join(", ")}, ...`
            : method.parameters.join(", ")
        const throws = method.throws.length > 0 ? ` throws ${method.throws.join(", ")}` : ""
        const annots = method.annotations.length > 0 ? ` [@${method.annotations.join(", @")}]` : ""
        lines.push(`  ${mods}${method.returnType} ${method.name}(${params})${throws}${annots}`)
      }
      if (regularMethods.length > MAX_METHODS_PER_CLASS) {
        lines.push(`  ... and ${regularMethods.length - MAX_METHODS_PER_CLASS} more methods`)
      }
      lines.push("")
    }

    // Fields
    if (metadata.fields.length > 0) {
      lines.push("Fields:")
      for (const field of metadata.fields.slice(0, MAX_FIELDS_PER_CLASS)) {
        const mods = field.modifiers.length > 0 ? field.modifiers.join(" ") + " " : ""
        const annots = field.annotations.length > 0 ? ` [@${field.annotations.join(", @")}]` : ""
        lines.push(`  ${mods}${field.type} ${field.name}${annots}`)
      }
      if (metadata.fields.length > MAX_FIELDS_PER_CLASS) {
        lines.push(`  ... and ${metadata.fields.length - MAX_FIELDS_PER_CLASS} more fields`)
      }
      lines.push("")
    }

    // Main method indicator
    if (metadata.hasMain) {
      lines.push("Entry point: public static void main(String[] args)")
      lines.push("")
    }

    // Annotations summary
    if (metadata.annotations.length > 0) {
      lines.push("Annotations used:")
      for (const annot of metadata.annotations.slice(0, 10)) {
        lines.push(`  @${annot.name} (${annot.count}x)`)
      }
      if (metadata.annotations.length > 10) {
        lines.push(`  ... and ${metadata.annotations.length - 10} more annotation types`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Explore a Java file and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<JavaExplorationResult> {
    const filePath = input.filePath ?? "unknown.java"
    log.info("exploring Java file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all components
      const packageName = extractPackage(content)
      const imports = extractImports(content)
      const classes = extractClasses(content)
      const interfaces = extractInterfaces(content)
      const enums = extractEnums(content)
      const methods = extractMethods(content)
      const fields = extractFields(content)
      const hasMain = hasMainMethod(content)
      const annotations = collectAnnotations(content)
      const innerClassCount = classes.filter((c) => c.isInner).length

      const metadata: JavaMetadata = {
        packageName,
        imports,
        classes,
        interfaces,
        enums,
        methods,
        fields,
        hasMain,
        annotations,
        innerClassCount,
        lineCount,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        const structuredMetadata = formatSummary(filePath, metadata)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "Java",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        summary = formatSummary(filePath, metadata)
        tokenCount = Token.estimate(summary)
      }

      log.info("Java exploration complete", {
        filePath,
        packageName,
        classCount: classes.length,
        interfaceCount: interfaces.length,
        enumCount: enums.length,
        methodCount: methods.length,
        fieldCount: fields.length,
        hasMain,
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
      log.error("failed to parse Java file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          packageName: null,
          imports: { java: [], javax: [], thirdParty: [], project: [] },
          classes: [],
          interfaces: [],
          enums: [],
          methods: [],
          fields: [],
          hasMain: false,
          annotations: [],
          innerClassCount: 0,
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to parse Java file: ${errorMessage}`,
      }
    }
  }
}
