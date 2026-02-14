import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Swift File Exploration Agent
 *
 * Analyzes Swift source files and produces structured summaries showing
 * imports, type definitions (classes, structs, enums, protocols, actors),
 * extensions, functions, and properties.
 */
export namespace SwiftExplorer {
  const log = Log.create({ service: "lcm.explore.swift" })

  /**
   * Maximum number of items to show in each category
   */
  const MAX_ITEMS_PER_CATEGORY = 30

  /**
   * Maximum length for type/function signatures in output
   */
  const MAX_SIGNATURE_LENGTH = 100

  /**
   * Import information categorized by source
   */
  export interface SwiftImports {
    /** Apple frameworks (Foundation, UIKit, SwiftUI, etc.) */
    apple: string[]
    /** Third-party modules */
    thirdParty: string[]
    /** Local modules */
    local: string[]
  }

  /**
   * Class definition information
   */
  export interface ClassInfo {
    name: string
    superclass?: string
    protocols: string[]
    modifiers: string[]
    isGeneric: boolean
  }

  /**
   * Struct definition information
   */
  export interface StructInfo {
    name: string
    protocols: string[]
    modifiers: string[]
    isGeneric: boolean
  }

  /**
   * Enum definition information
   */
  export interface EnumInfo {
    name: string
    protocols: string[]
    cases: string[]
    hasAssociatedValues: boolean
    hasRawValue: boolean
    rawValueType?: string
  }

  /**
   * Protocol definition information
   */
  export interface ProtocolInfo {
    name: string
    inheritedProtocols: string[]
    requirements: string[]
  }

  /**
   * Extension definition information
   */
  export interface ExtensionInfo {
    extendedType: string
    protocols: string[]
    whereClause?: string
  }

  /**
   * Function definition information
   */
  export interface FunctionInfo {
    name: string
    kind: "func" | "static func" | "class func" | "mutating func" | "init" | "deinit"
    parameters: string
    returnType?: string
    modifiers: string[]
    isAsync: boolean
    isThrows: boolean
  }

  /**
   * Property definition information
   */
  export interface PropertyInfo {
    name: string
    type?: string
    kind: "let" | "var" | "computed" | "lazy" | "static let" | "static var" | "class var"
    modifiers: string[]
  }

  /**
   * Actor definition information
   */
  export interface ActorInfo {
    name: string
    protocols: string[]
    modifiers: string[]
    isGlobal: boolean
  }

  /**
   * Metadata about the Swift file structure
   */
  export interface SwiftMetadata {
    /** Import statements categorized by source */
    imports: SwiftImports
    /** Class definitions */
    classes: ClassInfo[]
    /** Struct definitions */
    structs: StructInfo[]
    /** Enum definitions */
    enums: EnumInfo[]
    /** Protocol definitions */
    protocols: ProtocolInfo[]
    /** Extension definitions */
    extensions: ExtensionInfo[]
    /** Function definitions */
    functions: FunctionInfo[]
    /** Property definitions at file scope */
    properties: PropertyInfo[]
    /** Actor definitions */
    actors: ActorInfo[]
    /** Whether the file contains @main or is main.swift */
    hasMain: boolean
    /** Whether the file uses SwiftUI (struct ... : View) */
    isSwiftUI: boolean
    /** Line count */
    lineCount: number
    /** Whether it appears to be a test file */
    isTestFile: boolean
  }

  /**
   * Result of Swift file exploration
   */
  export interface SwiftExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Swift file */
    metadata: SwiftMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring a Swift file
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
   * Known Apple frameworks
   */
  const APPLE_FRAMEWORKS = new Set([
    "Foundation",
    "UIKit",
    "SwiftUI",
    "AppKit",
    "CoreFoundation",
    "CoreGraphics",
    "CoreData",
    "CoreLocation",
    "CoreMotion",
    "CoreBluetooth",
    "CoreImage",
    "CoreML",
    "CoreAnimation",
    "CoreAudio",
    "CoreMedia",
    "CoreVideo",
    "CoreText",
    "CoreServices",
    "CoreSpotlight",
    "AVFoundation",
    "AVKit",
    "ARKit",
    "Accelerate",
    "Combine",
    "Contacts",
    "ContactsUI",
    "CloudKit",
    "CryptoKit",
    "Darwin",
    "EventKit",
    "FileProvider",
    "GameKit",
    "GameplayKit",
    "HealthKit",
    "HomeKit",
    "IOKit",
    "MapKit",
    "MediaPlayer",
    "MessageUI",
    "Metal",
    "MetalKit",
    "NaturalLanguage",
    "Network",
    "NotificationCenter",
    "ObjectiveC",
    "os",
    "PDFKit",
    "PassKit",
    "PencilKit",
    "Photos",
    "PhotosUI",
    "PushKit",
    "QuartzCore",
    "QuickLook",
    "RealityKit",
    "SafariServices",
    "SceneKit",
    "Security",
    "SpriteKit",
    "StoreKit",
    "Swift",
    "SwiftData",
    "SystemConfiguration",
    "UIKitCore",
    "UniformTypeIdentifiers",
    "UserNotifications",
    "Vision",
    "WatchConnectivity",
    "WatchKit",
    "WebKit",
    "WidgetKit",
    "XCTest",
    "os.log",
    "Dispatch",
    "simd",
    "Observation",
    "SwiftTesting",
    "Testing",
  ])

  /**
   * Categorize an import module
   */
  function categorizeImport(module: string): "apple" | "thirdParty" | "local" {
    // Handle submodule imports like "import UIKit.UIView"
    const baseName = module.split(".")[0]

    if (APPLE_FRAMEWORKS.has(baseName)) {
      return "apple"
    }

    // Heuristics for local modules (typically project-specific)
    // Local modules are harder to detect, but usually:
    // - Start with a lowercase letter
    // - Match common project patterns
    if (/^[a-z]/.test(module)) {
      return "local"
    }

    // Third-party frameworks typically start with uppercase
    return "thirdParty"
  }

  /**
   * Extract imports from Swift source
   */
  function extractImports(content: string): SwiftImports {
    const imports: SwiftImports = { apple: [], thirdParty: [], local: [] }

    // Match import statements: import Module, @_exported import Module, @testable import Module
    const importRegex =
      /^(?:@\w+\s+)*import\s+(?:class\s+|struct\s+|enum\s+|protocol\s+|func\s+|var\s+|typealias\s+)?(\w+(?:\.\w+)*)/gm

    let match
    while ((match = importRegex.exec(content)) !== null) {
      const module = match[1]
      const category = categorizeImport(module)
      if (!imports[category].includes(module)) {
        imports[category].push(module)
      }
    }

    return imports
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []

    // Match class definitions with modifiers, generics, inheritance
    // Modifiers: final, open, public, internal, fileprivate, private, @objc, @objcMembers
    const classRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:final|open|public|internal|fileprivate|private)\s+)*class\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?/g

    let match
    while ((match = classRegex.exec(content)) !== null) {
      const modifiersStr = match[1] ?? ""
      const name = match[2]
      const inheritanceClause = match[3]?.trim() ?? ""

      const modifiers = extractModifiers(modifiersStr)
      const isGeneric = content.slice(match.index, match.index + match[0].length).includes("<")

      let superclass: string | undefined
      const protocols: string[] = []

      if (inheritanceClause) {
        const parts = inheritanceClause.split(",").map((s) => s.trim())
        for (let i = 0; i < parts.length; i++) {
          const part = parts[i].split("<")[0].trim() // Remove generic parameters
          if (i === 0 && /^[A-Z]/.test(part) && !isKnownProtocol(part)) {
            // First item starting with uppercase that's not a known protocol is likely superclass
            superclass = part
          } else if (part) {
            protocols.push(part)
          }
        }
      }

      classes.push({ name, superclass, protocols, modifiers, isGeneric })
    }

    return classes.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Check if a name is a known protocol (heuristic)
   */
  function isKnownProtocol(name: string): boolean {
    const knownProtocols = [
      "Codable",
      "Decodable",
      "Encodable",
      "Equatable",
      "Hashable",
      "Comparable",
      "Identifiable",
      "CustomStringConvertible",
      "CustomDebugStringConvertible",
      "Error",
      "LocalizedError",
      "Sendable",
      "ObservableObject",
      "View",
      "App",
      "Scene",
      "PreviewProvider",
      "UIViewRepresentable",
      "UIViewControllerRepresentable",
      "NSViewRepresentable",
      "NSViewControllerRepresentable",
      "Sequence",
      "Collection",
      "BidirectionalCollection",
      "RandomAccessCollection",
      "RawRepresentable",
      "CaseIterable",
      "OptionSet",
      "ExpressibleByStringLiteral",
      "ExpressibleByIntegerLiteral",
      "ExpressibleByFloatLiteral",
      "ExpressibleByArrayLiteral",
      "ExpressibleByDictionaryLiteral",
    ]
    return knownProtocols.includes(name) || name.endsWith("Protocol") || name.endsWith("Delegate")
  }

  /**
   * Extract modifiers from a modifier string
   */
  function extractModifiers(modifiersStr: string): string[] {
    const modifiers: string[] = []
    const modifierKeywords = [
      "final",
      "open",
      "public",
      "internal",
      "fileprivate",
      "private",
      "lazy",
      "weak",
      "unowned",
    ]

    for (const keyword of modifierKeywords) {
      if (modifiersStr.includes(keyword)) {
        modifiers.push(keyword)
      }
    }

    // Extract attributes
    const attrRegex = /@(\w+)(?:\([^)]*\))?/g
    let match
    while ((match = attrRegex.exec(modifiersStr)) !== null) {
      modifiers.push(`@${match[1]}`)
    }

    return modifiers
  }

  /**
   * Extract struct definitions
   */
  function extractStructs(content: string): StructInfo[] {
    const structs: StructInfo[] = []

    const structRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:public|internal|fileprivate|private)\s+)*struct\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?/g

    let match
    while ((match = structRegex.exec(content)) !== null) {
      const modifiersStr = match[1] ?? ""
      const name = match[2]
      const inheritanceClause = match[3]?.trim() ?? ""

      const modifiers = extractModifiers(modifiersStr)
      const isGeneric = content.slice(match.index, match.index + match[0].length).includes("<")

      const protocols = inheritanceClause
        ? inheritanceClause
            .split(",")
            .map((s) => s.split("<")[0].trim())
            .filter(Boolean)
        : []

      structs.push({ name, protocols, modifiers, isGeneric })
    }

    return structs.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Extract enum definitions
   */
  function extractEnums(content: string): EnumInfo[] {
    const enums: EnumInfo[] = []

    const enumRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:public|internal|fileprivate|private|indirect)\s+)*enum\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g

    let match
    while ((match = enumRegex.exec(content)) !== null) {
      const name = match[2]
      const inheritanceClause = match[3]?.trim() ?? ""
      const body = match[4]

      const protocols: string[] = []
      let rawValueType: string | undefined

      if (inheritanceClause) {
        const parts = inheritanceClause.split(",").map((s) => s.split("<")[0].trim())
        for (const part of parts) {
          if (["String", "Int", "UInt", "Float", "Double", "Character"].includes(part)) {
            rawValueType = part
          } else if (part) {
            protocols.push(part)
          }
        }
      }

      // Extract cases
      const cases: string[] = []
      const caseRegex = /case\s+(\w+)(?:\s*\([^)]+\))?/g
      let caseMatch
      while ((caseMatch = caseRegex.exec(body)) !== null) {
        cases.push(caseMatch[1])
      }

      const hasAssociatedValues = /case\s+\w+\s*\([^)]+\)/.test(body)
      const hasRawValue = rawValueType !== undefined || /case\s+\w+\s*=/.test(body)

      enums.push({
        name,
        protocols,
        cases: cases.slice(0, 10),
        hasAssociatedValues,
        hasRawValue,
        rawValueType,
      })
    }

    return enums.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Extract protocol definitions
   */
  function extractProtocols(content: string): ProtocolInfo[] {
    const protocols: ProtocolInfo[] = []

    const protocolRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:public|internal|fileprivate|private)\s+)*protocol\s+(\w+)(?:\s*:\s*([^{]+))?\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g

    let match
    while ((match = protocolRegex.exec(content)) !== null) {
      const name = match[2]
      const inheritanceClause = match[3]?.trim() ?? ""
      const body = match[4]

      const inheritedProtocols = inheritanceClause
        ? inheritanceClause
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []

      // Extract requirements (simplified)
      const requirements: string[] = []

      // Functions
      const funcRegex = /(?:mutating\s+)?func\s+(\w+)/g
      let funcMatch
      while ((funcMatch = funcRegex.exec(body)) !== null) {
        requirements.push(`func ${funcMatch[1]}()`)
      }

      // Properties
      const propRegex = /var\s+(\w+)\s*:/g
      let propMatch
      while ((propMatch = propRegex.exec(body)) !== null) {
        requirements.push(`var ${propMatch[1]}`)
      }

      // Associated types
      const assocRegex = /associatedtype\s+(\w+)/g
      let assocMatch
      while ((assocMatch = assocRegex.exec(body)) !== null) {
        requirements.push(`associatedtype ${assocMatch[1]}`)
      }

      protocols.push({
        name,
        inheritedProtocols,
        requirements: requirements.slice(0, 5),
      })
    }

    return protocols.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Extract extension definitions
   */
  function extractExtensions(content: string): ExtensionInfo[] {
    const extensions: ExtensionInfo[] = []

    const extensionRegex = /(?:^|\n)\s*extension\s+(\w+(?:<[^>]+>)?)(?:\s*:\s*([^{]+?))?(?:\s+where\s+([^{]+))?\s*\{/g

    let match
    while ((match = extensionRegex.exec(content)) !== null) {
      const extendedType = match[1]
      const conformances = match[2]?.trim() ?? ""
      const whereClause = match[3]?.trim()

      const protocols = conformances
        ? conformances
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : []

      extensions.push({ extendedType, protocols, whereClause })
    }

    return extensions.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Extract function definitions
   */
  function extractFunctions(content: string): FunctionInfo[] {
    const functions: FunctionInfo[] = []

    // Match function definitions
    const funcRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:public|internal|fileprivate|private|open|final|override|static|class|mutating|nonmutating)\s+)*(func|init|deinit)\s*(\w*)?\s*(?:<[^>]+>)?\s*\(([^)]*)\)(?:\s*(async))?(?:\s*(throws|rethrows))?(?:\s*->\s*([^\n{]+))?/g

    let match
    while ((match = funcRegex.exec(content)) !== null) {
      const modifiersStr = match[1] ?? ""
      const keyword = match[2]
      const name = match[3] ?? keyword
      const parameters = match[4]?.trim() ?? ""
      const isAsync = match[5] === "async"
      const isThrows = match[6] === "throws" || match[6] === "rethrows"
      const returnType = match[7]?.trim()

      const modifiers = extractModifiers(modifiersStr)

      let kind: FunctionInfo["kind"] = "func"
      if (keyword === "init") {
        kind = "init"
      } else if (keyword === "deinit") {
        kind = "deinit"
      } else if (modifiersStr.includes("static")) {
        kind = "static func"
      } else if (modifiersStr.includes("class")) {
        kind = "class func"
      } else if (modifiersStr.includes("mutating")) {
        kind = "mutating func"
      }

      functions.push({
        name,
        kind,
        parameters: truncate(parameters, 50),
        returnType: returnType ? truncate(returnType, 30) : undefined,
        modifiers: modifiers.filter((m) => !["static", "class", "mutating"].includes(m)),
        isAsync,
        isThrows,
      })
    }

    return functions.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Extract property definitions at file scope
   */
  function extractProperties(content: string): PropertyInfo[] {
    const properties: PropertyInfo[] = []

    // Match property definitions
    const propRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:public|internal|fileprivate|private|open|final|static|class|lazy|weak|unowned)\s+)*(let|var)\s+(\w+)(?:\s*:\s*([^\n=]+?))?(?:\s*=|\s*\{)?/g

    let match
    while ((match = propRegex.exec(content)) !== null) {
      const modifiersStr = match[1] ?? ""
      const keyword = match[2]
      const name = match[3]
      const type = match[4]?.trim()

      const modifiers = extractModifiers(modifiersStr)

      let kind: PropertyInfo["kind"] = keyword as "let" | "var"
      if (modifiersStr.includes("static") && keyword === "let") {
        kind = "static let"
      } else if (modifiersStr.includes("static") && keyword === "var") {
        kind = "static var"
      } else if (modifiersStr.includes("class")) {
        kind = "class var"
      } else if (modifiersStr.includes("lazy")) {
        kind = "lazy"
      }

      // Check if it's a computed property (has { get or { set but no =)
      const afterMatch = content.slice(match.index + match[0].length, match.index + match[0].length + 50)
      if (/^\s*\{(?!.*=)/.test(afterMatch) && !modifiersStr.includes("lazy")) {
        kind = "computed"
      }

      properties.push({
        name,
        type: type ? truncate(type, 40) : undefined,
        kind,
        modifiers: modifiers.filter((m) => !["static", "class", "lazy"].includes(m)),
      })
    }

    return properties.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Extract actor definitions
   */
  function extractActors(content: string): ActorInfo[] {
    const actors: ActorInfo[] = []

    const actorRegex =
      /(?:^|\n)\s*((?:@\w+(?:\([^)]*\))?\s+)*(?:public|internal|fileprivate|private)\s+)*(actor)\s+(\w+)(?:<[^>]+>)?(?:\s*:\s*([^{]+))?/g

    let match
    while ((match = actorRegex.exec(content)) !== null) {
      const modifiersStr = match[1] ?? ""
      const name = match[3]
      const inheritanceClause = match[4]?.trim() ?? ""

      const modifiers = extractModifiers(modifiersStr)
      const isGlobal = modifiersStr.includes("@globalActor")

      const protocols = inheritanceClause
        ? inheritanceClause
            .split(",")
            .map((s) => s.split("<")[0].trim())
            .filter(Boolean)
        : []

      actors.push({ name, protocols, modifiers, isGlobal })
    }

    return actors.slice(0, MAX_ITEMS_PER_CATEGORY)
  }

  /**
   * Check if file has @main attribute or is main.swift
   */
  function checkHasMain(content: string, filePath?: string): boolean {
    // Check for @main attribute
    if (/@main\b/.test(content)) {
      return true
    }

    // Check for @UIApplicationMain or @NSApplicationMain (deprecated but still used)
    if (/@UIApplicationMain\b/.test(content) || /@NSApplicationMain\b/.test(content)) {
      return true
    }

    // Check if filename is main.swift
    if (filePath && /main\.swift$/i.test(filePath)) {
      return true
    }

    return false
  }

  /**
   * Check if file uses SwiftUI (struct conforming to View)
   */
  function checkIsSwiftUI(content: string, imports: SwiftImports): boolean {
    // Check if SwiftUI is imported
    if (!imports.apple.includes("SwiftUI")) {
      return false
    }

    // Check for View conformance
    if (/struct\s+\w+.*:\s*[^{]*\bView\b/.test(content)) {
      return true
    }

    return false
  }

  /**
   * Check if this is a test file
   */
  function checkIsTestFile(content: string, filePath?: string): boolean {
    // Check filename
    if (filePath && (/Tests?\.swift$/i.test(filePath) || /Spec\.swift$/i.test(filePath))) {
      return true
    }

    // Check for XCTest import
    if (/import\s+XCTest/.test(content)) {
      return true
    }

    // Check for Swift Testing import
    if (/import\s+Testing/.test(content) || /@Test\b/.test(content)) {
      return true
    }

    return false
  }

  /**
   * Truncate a string to max length
   */
  function truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str
    return str.slice(0, maxLen - 3) + "..."
  }

  /**
   * Format the Swift summary
   */
  function formatSummary(filePath: string, metadata: SwiftMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Language: Swift`)
    lines.push(`Lines: ${metadata.lineCount}`)

    const tags: string[] = []
    if (metadata.hasMain) tags.push("Entry Point")
    if (metadata.isSwiftUI) tags.push("SwiftUI")
    if (metadata.isTestFile) tags.push("Test File")
    if (tags.length > 0) {
      lines.push(`Tags: ${tags.join(", ")}`)
    }

    lines.push("")

    // Imports
    const totalImports =
      metadata.imports.apple.length + metadata.imports.thirdParty.length + metadata.imports.local.length
    if (totalImports > 0) {
      lines.push("Imports:")
      if (metadata.imports.apple.length > 0) {
        lines.push(
          `  Apple: ${metadata.imports.apple.slice(0, 10).join(", ")}${metadata.imports.apple.length > 10 ? ` (+${metadata.imports.apple.length - 10} more)` : ""}`,
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

    // Classes
    if (metadata.classes.length > 0) {
      lines.push(`Classes (${metadata.classes.length}):`)
      for (const cls of metadata.classes.slice(0, 15)) {
        const modStr = cls.modifiers.length > 0 ? `[${cls.modifiers.join(", ")}] ` : ""
        const genericStr = cls.isGeneric ? "<T>" : ""
        const superStr = cls.superclass ? ` : ${cls.superclass}` : ""
        const protoStr = cls.protocols.length > 0 ? (cls.superclass ? ", " : " : ") + cls.protocols.join(", ") : ""
        lines.push(`  ${modStr}${cls.name}${genericStr}${superStr}${protoStr}`)
      }
      if (metadata.classes.length > 15) {
        lines.push(`  ... and ${metadata.classes.length - 15} more`)
      }
      lines.push("")
    }

    // Structs
    if (metadata.structs.length > 0) {
      lines.push(`Structs (${metadata.structs.length}):`)
      for (const s of metadata.structs.slice(0, 15)) {
        const modStr = s.modifiers.length > 0 ? `[${s.modifiers.join(", ")}] ` : ""
        const genericStr = s.isGeneric ? "<T>" : ""
        const protoStr = s.protocols.length > 0 ? ` : ${s.protocols.join(", ")}` : ""
        lines.push(`  ${modStr}${s.name}${genericStr}${protoStr}`)
      }
      if (metadata.structs.length > 15) {
        lines.push(`  ... and ${metadata.structs.length - 15} more`)
      }
      lines.push("")
    }

    // Enums
    if (metadata.enums.length > 0) {
      lines.push(`Enums (${metadata.enums.length}):`)
      for (const e of metadata.enums.slice(0, 10)) {
        const protoStr = e.protocols.length > 0 ? ` : ${e.protocols.join(", ")}` : ""
        const rawStr = e.rawValueType ? ` (raw: ${e.rawValueType})` : ""
        const assocStr = e.hasAssociatedValues ? " (associated values)" : ""
        const casesStr = e.cases.length > 0 ? ` - cases: ${e.cases.join(", ")}${e.cases.length < 10 ? "" : "..."}` : ""
        lines.push(`  ${e.name}${protoStr}${rawStr}${assocStr}${casesStr}`)
      }
      if (metadata.enums.length > 10) {
        lines.push(`  ... and ${metadata.enums.length - 10} more`)
      }
      lines.push("")
    }

    // Protocols
    if (metadata.protocols.length > 0) {
      lines.push(`Protocols (${metadata.protocols.length}):`)
      for (const p of metadata.protocols.slice(0, 10)) {
        const inheritStr = p.inheritedProtocols.length > 0 ? ` : ${p.inheritedProtocols.join(", ")}` : ""
        const reqStr = p.requirements.length > 0 ? ` - ${p.requirements.join(", ")}` : ""
        lines.push(`  ${p.name}${inheritStr}${reqStr}`)
      }
      if (metadata.protocols.length > 10) {
        lines.push(`  ... and ${metadata.protocols.length - 10} more`)
      }
      lines.push("")
    }

    // Actors
    if (metadata.actors.length > 0) {
      lines.push(`Actors (${metadata.actors.length}):`)
      for (const a of metadata.actors.slice(0, 10)) {
        const modStr = a.modifiers.length > 0 ? `[${a.modifiers.join(", ")}] ` : ""
        const globalStr = a.isGlobal ? "[global] " : ""
        const protoStr = a.protocols.length > 0 ? ` : ${a.protocols.join(", ")}` : ""
        lines.push(`  ${globalStr}${modStr}${a.name}${protoStr}`)
      }
      if (metadata.actors.length > 10) {
        lines.push(`  ... and ${metadata.actors.length - 10} more`)
      }
      lines.push("")
    }

    // Extensions
    if (metadata.extensions.length > 0) {
      lines.push(`Extensions (${metadata.extensions.length}):`)
      for (const ext of metadata.extensions.slice(0, 10)) {
        const protoStr = ext.protocols.length > 0 ? ` : ${ext.protocols.join(", ")}` : ""
        const whereStr = ext.whereClause ? ` where ${truncate(ext.whereClause, 30)}` : ""
        lines.push(`  extension ${ext.extendedType}${protoStr}${whereStr}`)
      }
      if (metadata.extensions.length > 10) {
        lines.push(`  ... and ${metadata.extensions.length - 10} more`)
      }
      lines.push("")
    }

    // Top-level functions
    const topLevelFunctions = metadata.functions.filter(
      (f) => !["init", "deinit"].includes(f.kind) || f.modifiers.length === 0,
    )
    if (topLevelFunctions.length > 0) {
      lines.push(`Functions (${topLevelFunctions.length}):`)
      for (const fn of topLevelFunctions.slice(0, 15)) {
        const modStr = fn.modifiers.length > 0 ? `[${fn.modifiers.join(", ")}] ` : ""
        const asyncStr = fn.isAsync ? "async " : ""
        const throwsStr = fn.isThrows ? "throws " : ""
        const retStr = fn.returnType ? ` -> ${fn.returnType}` : ""
        const kindPrefix = fn.kind !== "func" ? `${fn.kind} ` : ""
        lines.push(`  ${modStr}${kindPrefix}${fn.name}(${fn.parameters}) ${asyncStr}${throwsStr}${retStr}`.trim())
      }
      if (topLevelFunctions.length > 15) {
        lines.push(`  ... and ${topLevelFunctions.length - 15} more`)
      }
      lines.push("")
    }

    // Top-level properties
    if (metadata.properties.length > 0) {
      lines.push(`Properties (${metadata.properties.length}):`)
      for (const prop of metadata.properties.slice(0, 15)) {
        const modStr = prop.modifiers.length > 0 ? `[${prop.modifiers.join(", ")}] ` : ""
        const typeStr = prop.type ? `: ${prop.type}` : ""
        lines.push(`  ${modStr}${prop.kind} ${prop.name}${typeStr}`)
      }
      if (metadata.properties.length > 15) {
        lines.push(`  ... and ${metadata.properties.length - 15} more`)
      }
    }

    return lines.join("\n").trim()
  }

  /**
   * Explore a Swift file and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<SwiftExplorationResult> {
    const filePath = input.filePath ?? "unknown.swift"
    log.info("exploring Swift file", { filePath })

    try {
      const content = input.content
      const lineCount = content.split("\n").length

      // Extract all components
      const imports = extractImports(content)
      const classes = extractClasses(content)
      const structs = extractStructs(content)
      const enums = extractEnums(content)
      const protocols = extractProtocols(content)
      const extensions = extractExtensions(content)
      const functions = extractFunctions(content)
      const properties = extractProperties(content)
      const actors = extractActors(content)
      const hasMain = checkHasMain(content, filePath)
      const isSwiftUI = checkIsSwiftUI(content, imports)
      const isTestFile = checkIsTestFile(content, filePath)

      const metadata: SwiftMetadata = {
        imports,
        classes,
        structs,
        enums,
        protocols,
        extensions,
        functions,
        properties,
        actors,
        hasMain,
        isSwiftUI,
        lineCount,
        isTestFile,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        const structuredMetadata = formatSummary(filePath, metadata)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "Swift",
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

      log.info("Swift exploration complete", {
        filePath,
        lineCount,
        classes: classes.length,
        structs: structs.length,
        enums: enums.length,
        protocols: protocols.length,
        extensions: extensions.length,
        functions: functions.length,
        actors: actors.length,
        hasMain,
        isSwiftUI,
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
      log.error("failed to explore Swift file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          imports: { apple: [], thirdParty: [], local: [] },
          classes: [],
          structs: [],
          enums: [],
          protocols: [],
          extensions: [],
          functions: [],
          properties: [],
          actors: [],
          hasMain: false,
          isSwiftUI: false,
          lineCount: 0,
          isTestFile: false,
        },
        tokenCount: 0,
        error: `Failed to explore Swift file: ${errorMessage}`,
      }
    }
  }
}
