import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Objective-C File Exploration Agent
 *
 * Analyzes Objective-C source files (.m, .mm, .h) and produces structured
 * summaries showing imports, interfaces, implementations, protocols,
 * methods, properties, and categories.
 */
export namespace ObjCExplorer {
  const log = Log.create({ service: "lcm.explore.objc" })

  /**
   * Import categories for Objective-C
   */
  export interface ObjCImports {
    /** Foundation framework imports */
    foundation: string[]
    /** UIKit framework imports */
    uikit: string[]
    /** AppKit framework imports */
    appkit: string[]
    /** Other Apple framework imports */
    frameworks: string[]
    /** Local imports (#import "...") */
    local: string[]
  }

  /**
   * Interface declaration information
   */
  export interface ObjCInterface {
    /** Class name */
    name: string
    /** Superclass name (if any) */
    superclass?: string
    /** Protocols the class conforms to */
    protocols: string[]
    /** Line number where declared */
    line: number
  }

  /**
   * Implementation block information
   */
  export interface ObjCImplementation {
    /** Class name */
    name: string
    /** Category name (if category implementation) */
    category?: string
    /** Line number where declared */
    line: number
  }

  /**
   * Protocol definition information
   */
  export interface ObjCProtocol {
    /** Protocol name */
    name: string
    /** Methods declared in the protocol */
    methods: string[]
    /** Line number where declared */
    line: number
  }

  /**
   * Method definition information
   */
  export interface ObjCMethod {
    /** Whether this is a class method (+) or instance method (-) */
    isClassMethod: boolean
    /** Return type */
    returnType: string
    /** Method name/selector */
    name: string
    /** Parameter types */
    parameterTypes: string[]
    /** Line number where declared */
    line: number
  }

  /**
   * Property declaration information
   */
  export interface ObjCProperty {
    /** Property name */
    name: string
    /** Property type */
    type: string
    /** Property attributes (nonatomic, strong, weak, etc.) */
    attributes: string[]
    /** Line number where declared */
    line: number
  }

  /**
   * Category definition information
   */
  export interface ObjCCategory {
    /** Class being extended */
    className: string
    /** Category name */
    categoryName: string
    /** Line number where declared */
    line: number
  }

  /**
   * Synthesize/Dynamic directive
   */
  export interface ObjCSynthesizeDirective {
    /** Directive type: @synthesize or @dynamic */
    type: "synthesize" | "dynamic"
    /** Property names */
    properties: string[]
    /** Line number where declared */
    line: number
  }

  /**
   * Metadata about the Objective-C file
   */
  export interface ObjCMetadata {
    /** Import information */
    imports: ObjCImports
    /** Interface declarations */
    interfaces: ObjCInterface[]
    /** Implementation blocks */
    implementations: ObjCImplementation[]
    /** Protocol definitions */
    protocols: ObjCProtocol[]
    /** Category definitions */
    categories: ObjCCategory[]
    /** Method definitions */
    methods: ObjCMethod[]
    /** Property declarations */
    properties: ObjCProperty[]
    /** Synthesize/Dynamic directives */
    synthesizeDirectives: ObjCSynthesizeDirective[]
    /** Whether the file contains a main function */
    hasMain: boolean
    /** Whether this is a header file */
    isHeader: boolean
    /** Whether this is an Objective-C++ file */
    isObjCPlusPlus: boolean
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of Objective-C exploration
   */
  export interface ObjCExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the file */
    metadata: ObjCMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring an Objective-C file
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
   * Parse imports from content
   */
  function parseImports(content: string): ObjCImports {
    const imports: ObjCImports = {
      foundation: [],
      uikit: [],
      appkit: [],
      frameworks: [],
      local: [],
    }

    const lines = content.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()

      // Framework imports: #import <Framework/Header.h>
      const frameworkMatch = trimmed.match(/^#import\s+<([^>]+)>/)
      if (frameworkMatch) {
        const importPath = frameworkMatch[1]
        if (importPath.startsWith("Foundation/")) {
          imports.foundation.push(importPath)
        } else if (importPath.startsWith("UIKit/")) {
          imports.uikit.push(importPath)
        } else if (importPath.startsWith("AppKit/")) {
          imports.appkit.push(importPath)
        } else {
          imports.frameworks.push(importPath)
        }
        continue
      }

      // Local imports: #import "Header.h"
      const localMatch = trimmed.match(/^#import\s+"([^"]+)"/)
      if (localMatch) {
        imports.local.push(localMatch[1])
      }
    }

    return imports
  }

  /**
   * Parse interface declarations
   */
  function parseInterfaces(content: string): ObjCInterface[] {
    const interfaces: ObjCInterface[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match @interface ClassName : SuperClass <Protocol1, Protocol2>
      // or @interface ClassName <Protocol1, Protocol2>
      // or @interface ClassName : SuperClass
      // or @interface ClassName
      const match = line.match(/^@interface\s+(\w+)\s*(?::\s*(\w+))?\s*(?:<([^>]+)>)?/)
      if (match) {
        const iface: ObjCInterface = {
          name: match[1],
          line: i + 1,
          protocols: [],
        }
        if (match[2]) {
          iface.superclass = match[2]
        }
        if (match[3]) {
          iface.protocols = match[3].split(",").map((p) => p.trim())
        }
        interfaces.push(iface)
      }
    }

    return interfaces
  }

  /**
   * Parse implementation blocks
   */
  function parseImplementations(content: string): ObjCImplementation[] {
    const implementations: ObjCImplementation[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match @implementation ClassName (Category)
      // or @implementation ClassName
      const match = line.match(/^@implementation\s+(\w+)\s*(?:\((\w*)\))?/)
      if (match) {
        const impl: ObjCImplementation = {
          name: match[1],
          line: i + 1,
        }
        if (match[2]) {
          impl.category = match[2]
        }
        implementations.push(impl)
      }
    }

    return implementations
  }

  /**
   * Parse protocol definitions
   */
  function parseProtocols(content: string): ObjCProtocol[] {
    const protocols: ObjCProtocol[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match @protocol ProtocolName
      const match = line.match(/^@protocol\s+(\w+)\s*(?:<[^>]+>)?/)
      if (match && !line.includes(";")) {
        // Exclude forward declarations
        const protocol: ObjCProtocol = {
          name: match[1],
          methods: [],
          line: i + 1,
        }

        // Collect methods until @end
        for (let j = i + 1; j < lines.length; j++) {
          const methodLine = lines[j].trim()
          if (methodLine.startsWith("@end")) break

          const methodMatch = methodLine.match(/^[-+]\s*\([^)]+\)\s*(\w+)/)
          if (methodMatch) {
            protocol.methods.push(methodMatch[1])
          }
        }

        protocols.push(protocol)
      }
    }

    return protocols
  }

  /**
   * Parse method definitions
   */
  function parseMethods(content: string): ObjCMethod[] {
    const methods: ObjCMethod[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match method signatures: - (ReturnType)methodName or + (ReturnType)methodName
      const match = line.match(/^([-+])\s*\(([^)]+)\)\s*(.+?)(?:\s*\{|;|$)/)
      if (match) {
        const isClassMethod = match[1] === "+"
        const returnType = match[2].trim()
        const methodPart = match[3].trim()

        // Parse method name and parameters
        // Simple case: methodName
        // With params: methodName:(Type)param1 secondPart:(Type)param2
        const nameParts: string[] = []
        const paramTypes: string[] = []

        const segments = methodPart.split(":")
        if (segments.length === 1) {
          // No parameters
          nameParts.push(segments[0].trim())
        } else {
          for (let j = 0; j < segments.length; j++) {
            const segment = segments[j].trim()
            if (j === 0) {
              nameParts.push(segment)
            } else {
              // Extract parameter type and next name part
              const paramMatch = segment.match(/^\(([^)]+)\)\s*\w+\s*(.*)/)
              if (paramMatch) {
                paramTypes.push(paramMatch[1].trim())
                if (paramMatch[2]) {
                  nameParts.push(paramMatch[2].trim())
                }
              }
            }
          }
        }

        methods.push({
          isClassMethod,
          returnType,
          name: nameParts.join(":") + (paramTypes.length > 0 ? ":" : ""),
          parameterTypes: paramTypes,
          line: i + 1,
        })
      }
    }

    return methods
  }

  /**
   * Parse property declarations
   */
  function parseProperties(content: string): ObjCProperty[] {
    const properties: ObjCProperty[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match @property (attributes) Type *name; or @property (attributes) Type name;
      const match = line.match(/^@property\s*(?:\(([^)]*)\))?\s*(.+?)\s+\*?(\w+)\s*;/)
      if (match) {
        const attributes = match[1] ? match[1].split(",").map((a) => a.trim()) : []
        const type = match[2].trim()
        const name = match[3]

        properties.push({
          name,
          type,
          attributes,
          line: i + 1,
        })
      }
    }

    return properties
  }

  /**
   * Parse category definitions (from @interface)
   */
  function parseCategories(content: string): ObjCCategory[] {
    const categories: ObjCCategory[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match @interface ClassName (CategoryName)
      const match = line.match(/^@interface\s+(\w+)\s*\((\w+)\)/)
      if (match) {
        categories.push({
          className: match[1],
          categoryName: match[2],
          line: i + 1,
        })
      }
    }

    return categories
  }

  /**
   * Parse @synthesize and @dynamic directives
   */
  function parseSynthesizeDirectives(content: string): ObjCSynthesizeDirective[] {
    const directives: ObjCSynthesizeDirective[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()

      // Match @synthesize prop1, prop2 = _prop2;
      const synthMatch = line.match(/^@synthesize\s+(.+?);/)
      if (synthMatch) {
        const propsStr = synthMatch[1]
        const props = propsStr.split(",").map((p) => p.split("=")[0].trim())
        directives.push({
          type: "synthesize",
          properties: props,
          line: i + 1,
        })
        continue
      }

      // Match @dynamic prop1, prop2;
      const dynMatch = line.match(/^@dynamic\s+(.+?);/)
      if (dynMatch) {
        const propsStr = dynMatch[1]
        const props = propsStr.split(",").map((p) => p.trim())
        directives.push({
          type: "dynamic",
          properties: props,
          line: i + 1,
        })
      }
    }

    return directives
  }

  /**
   * Check if the file contains a main function
   */
  function hasMainFunction(content: string): boolean {
    // Match: int main(int argc, char *argv[]) or int main()
    return /\bint\s+main\s*\([^)]*\)\s*\{/.test(content)
  }

  /**
   * Format the summary
   */
  function formatSummary(filePath: string, metadata: ObjCMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)

    const fileType = metadata.isHeader
      ? "Objective-C Header"
      : metadata.isObjCPlusPlus
        ? "Objective-C++"
        : "Objective-C Source"
    lines.push(`Format: ${fileType}`)
    lines.push(`Lines: ${metadata.lineCount}`)
    lines.push("")

    // Imports summary
    const totalImports =
      metadata.imports.foundation.length +
      metadata.imports.uikit.length +
      metadata.imports.appkit.length +
      metadata.imports.frameworks.length +
      metadata.imports.local.length

    if (totalImports > 0) {
      lines.push("Imports:")
      if (metadata.imports.foundation.length > 0) {
        lines.push(`  Foundation: ${metadata.imports.foundation.length} imports`)
      }
      if (metadata.imports.uikit.length > 0) {
        lines.push(`  UIKit: ${metadata.imports.uikit.length} imports`)
      }
      if (metadata.imports.appkit.length > 0) {
        lines.push(`  AppKit: ${metadata.imports.appkit.length} imports`)
      }
      if (metadata.imports.frameworks.length > 0) {
        lines.push(`  Other frameworks: ${metadata.imports.frameworks.length} imports`)
        for (const fw of metadata.imports.frameworks.slice(0, 5)) {
          lines.push(`    - ${fw}`)
        }
        if (metadata.imports.frameworks.length > 5) {
          lines.push(`    ... and ${metadata.imports.frameworks.length - 5} more`)
        }
      }
      if (metadata.imports.local.length > 0) {
        lines.push(`  Local: ${metadata.imports.local.length} imports`)
        for (const local of metadata.imports.local.slice(0, 5)) {
          lines.push(`    - ${local}`)
        }
        if (metadata.imports.local.length > 5) {
          lines.push(`    ... and ${metadata.imports.local.length - 5} more`)
        }
      }
      lines.push("")
    }

    // Interfaces
    if (metadata.interfaces.length > 0) {
      lines.push("Interfaces:")
      for (const iface of metadata.interfaces.slice(0, 10)) {
        let desc = `  @interface ${iface.name}`
        if (iface.superclass) {
          desc += ` : ${iface.superclass}`
        }
        if (iface.protocols.length > 0) {
          desc += ` <${iface.protocols.join(", ")}>`
        }
        desc += ` (line ${iface.line})`
        lines.push(desc)
      }
      if (metadata.interfaces.length > 10) {
        lines.push(`  ... and ${metadata.interfaces.length - 10} more interfaces`)
      }
      lines.push("")
    }

    // Categories
    if (metadata.categories.length > 0) {
      lines.push("Categories:")
      for (const cat of metadata.categories.slice(0, 10)) {
        lines.push(`  @interface ${cat.className} (${cat.categoryName}) (line ${cat.line})`)
      }
      if (metadata.categories.length > 10) {
        lines.push(`  ... and ${metadata.categories.length - 10} more categories`)
      }
      lines.push("")
    }

    // Protocols
    if (metadata.protocols.length > 0) {
      lines.push("Protocols:")
      for (const proto of metadata.protocols.slice(0, 10)) {
        lines.push(`  @protocol ${proto.name} (${proto.methods.length} methods) (line ${proto.line})`)
      }
      if (metadata.protocols.length > 10) {
        lines.push(`  ... and ${metadata.protocols.length - 10} more protocols`)
      }
      lines.push("")
    }

    // Implementations
    if (metadata.implementations.length > 0) {
      lines.push("Implementations:")
      for (const impl of metadata.implementations.slice(0, 10)) {
        let desc = `  @implementation ${impl.name}`
        if (impl.category) {
          desc += ` (${impl.category})`
        }
        desc += ` (line ${impl.line})`
        lines.push(desc)
      }
      if (metadata.implementations.length > 10) {
        lines.push(`  ... and ${metadata.implementations.length - 10} more implementations`)
      }
      lines.push("")
    }

    // Properties
    if (metadata.properties.length > 0) {
      lines.push(`Properties: ${metadata.properties.length}`)
      for (const prop of metadata.properties.slice(0, 10)) {
        const attrs = prop.attributes.length > 0 ? `(${prop.attributes.join(", ")}) ` : ""
        lines.push(`  @property ${attrs}${prop.type} ${prop.name} (line ${prop.line})`)
      }
      if (metadata.properties.length > 10) {
        lines.push(`  ... and ${metadata.properties.length - 10} more properties`)
      }
      lines.push("")
    }

    // Methods
    if (metadata.methods.length > 0) {
      lines.push(`Methods: ${metadata.methods.length}`)
      const classMethods = metadata.methods.filter((m) => m.isClassMethod)
      const instanceMethods = metadata.methods.filter((m) => !m.isClassMethod)

      if (classMethods.length > 0) {
        lines.push(`  Class methods (+): ${classMethods.length}`)
        for (const method of classMethods.slice(0, 5)) {
          lines.push(`    + (${method.returnType})${method.name} (line ${method.line})`)
        }
        if (classMethods.length > 5) {
          lines.push(`    ... and ${classMethods.length - 5} more`)
        }
      }

      if (instanceMethods.length > 0) {
        lines.push(`  Instance methods (-): ${instanceMethods.length}`)
        for (const method of instanceMethods.slice(0, 10)) {
          lines.push(`    - (${method.returnType})${method.name} (line ${method.line})`)
        }
        if (instanceMethods.length > 10) {
          lines.push(`    ... and ${instanceMethods.length - 10} more`)
        }
      }
      lines.push("")
    }

    // Synthesize/Dynamic
    if (metadata.synthesizeDirectives.length > 0) {
      lines.push("Property Synthesis:")
      for (const dir of metadata.synthesizeDirectives) {
        lines.push(`  @${dir.type} ${dir.properties.join(", ")} (line ${dir.line})`)
      }
      lines.push("")
    }

    // Main function
    if (metadata.hasMain) {
      lines.push("Entry Point: main() function present")
      lines.push("")
    }

    return lines.join("\n").trim()
  }

  /**
   * Explore an Objective-C file and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<ObjCExplorationResult> {
    const filePath = input.filePath ?? "unknown.m"
    log.info("exploring Objective-C file", { filePath })

    try {
      const content = input.content
      const lines = content.split("\n")
      const lineCount = lines.length

      // Determine file type from extension
      const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
      const isHeader = ext === "h"
      const isObjCPlusPlus = ext === "mm"

      // Parse all components
      const imports = parseImports(content)
      const interfaces = parseInterfaces(content)
      const implementations = parseImplementations(content)
      const protocols = parseProtocols(content)
      const categories = parseCategories(content)
      const methods = parseMethods(content)
      const properties = parseProperties(content)
      const synthesizeDirectives = parseSynthesizeDirectives(content)
      const hasMain = hasMainFunction(content)

      const metadata: ObjCMetadata = {
        imports,
        interfaces,
        implementations,
        protocols,
        categories,
        methods,
        properties,
        synthesizeDirectives,
        hasMain,
        isHeader,
        isObjCPlusPlus,
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
          language: "Objective-C",
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

      log.info("Objective-C exploration complete", {
        filePath,
        interfaces: interfaces.length,
        implementations: implementations.length,
        protocols: protocols.length,
        methods: methods.length,
        properties: properties.length,
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
      log.error("failed to parse Objective-C file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          imports: {
            foundation: [],
            uikit: [],
            appkit: [],
            frameworks: [],
            local: [],
          },
          interfaces: [],
          implementations: [],
          protocols: [],
          categories: [],
          methods: [],
          properties: [],
          synthesizeDirectives: [],
          hasMain: false,
          isHeader: false,
          isObjCPlusPlus: false,
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to parse Objective-C: ${errorMessage}`,
      }
    }
  }
}
