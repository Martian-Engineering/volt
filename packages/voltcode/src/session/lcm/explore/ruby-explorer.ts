import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Ruby File Exploration Agent
 *
 * Analyzes Ruby files (.rb, .rake, .gemspec) and produces structured summaries
 * describing requires, classes, modules, methods, constants, and Rails patterns.
 *
 * Uses regex-based parsing to extract Ruby code structure without external dependencies.
 */
export namespace RubyExplorer {
  const log = Log.create({ service: "lcm.explore.ruby" })

  /**
   * Maximum number of items to show in lists
   */
  const MAX_LIST_ITEMS = 20

  /**
   * Maximum string length to show in samples
   */
  const MAX_STRING_LENGTH = 50

  /**
   * Ruby require information categorized by type
   */
  export interface RequireInfo {
    /** Standard library requires (json, net/http, etc.) */
    stdlib: string[]
    /** Gem requires (third-party libraries) */
    gems: string[]
    /** Local file requires (require_relative) */
    local: string[]
  }

  /**
   * Class definition information
   */
  export interface ClassInfo {
    /** Class name */
    name: string
    /** Superclass if any */
    superclass?: string
    /** Included modules */
    includes: string[]
    /** Extended modules */
    extends: string[]
    /** Prepended modules */
    prepends: string[]
    /** Line number where class is defined */
    line: number
  }

  /**
   * Module definition information
   */
  export interface ModuleInfo {
    /** Module name */
    name: string
    /** Included modules */
    includes: string[]
    /** Extended modules */
    extends: string[]
    /** Prepended modules */
    prepends: string[]
    /** Line number where module is defined */
    line: number
  }

  /**
   * Method definition information
   */
  export interface MethodInfo {
    /** Method name */
    name: string
    /** Whether it's a class method (self.method) */
    isClassMethod: boolean
    /** Method visibility (public, private, protected) */
    visibility: "public" | "private" | "protected"
    /** Line number where method is defined */
    line: number
  }

  /**
   * Constant definition information
   */
  export interface ConstantInfo {
    /** Constant name */
    name: string
    /** Value type or sample */
    valueType: string
    /** Line number where constant is defined */
    line: number
  }

  /**
   * Block/DSL usage information
   */
  export interface BlockInfo {
    /** Block type (describe, it, context, before, after, let, etc.) */
    type: string
    /** Description or name if any */
    description?: string
    /** Line number */
    line: number
  }

  /**
   * Rails pattern detection result
   */
  export interface RailsPatterns {
    /** Whether this appears to be a Rails file */
    isRailsFile: boolean
    /** Type of Rails file (controller, model, migration, etc.) */
    fileType?: "controller" | "model" | "migration" | "mailer" | "job" | "serializer" | "concern" | "helper" | "view"
    /** Detected callbacks */
    callbacks: string[]
    /** Detected validations */
    validations: string[]
    /** Detected associations */
    associations: string[]
    /** Detected scopes */
    scopes: string[]
  }

  /**
   * Metadata about the Ruby file structure
   */
  export interface RubyMetadata {
    /** Require statements organized by type */
    requires: RequireInfo
    /** Class definitions */
    classes: ClassInfo[]
    /** Module definitions */
    modules: ModuleInfo[]
    /** Method definitions */
    methods: MethodInfo[]
    /** Constant definitions */
    constants: ConstantInfo[]
    /** Whether the file has code outside classes/modules (script mode) */
    hasMainCode: boolean
    /** Rails-specific patterns if detected */
    rails: RailsPatterns
    /** Block/DSL usages (RSpec, etc.) */
    blocks: BlockInfo[]
    /** Total line count */
    lineCount: number
    /** Whether file uses frozen string literal pragma */
    frozenStringLiteral: boolean
    /** Magic comments (encoding, etc.) */
    magicComments: string[]
  }

  /**
   * Result of Ruby exploration
   */
  export interface RubyExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Ruby file */
    metadata: RubyMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Input for exploring a Ruby file
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
   * Known Ruby standard library modules
   */
  const STDLIB_MODULES = new Set([
    "abbrev",
    "base64",
    "benchmark",
    "bigdecimal",
    "cgi",
    "cmath",
    "coverage",
    "csv",
    "date",
    "dbm",
    "debug",
    "delegate",
    "digest",
    "drb",
    "english",
    "erb",
    "etc",
    "fcntl",
    "fiddle",
    "fileutils",
    "find",
    "forwardable",
    "gdbm",
    "getoptlong",
    "io/console",
    "io/nonblock",
    "io/wait",
    "ipaddr",
    "irb",
    "json",
    "logger",
    "matrix",
    "minitest",
    "monitor",
    "mutex_m",
    "net/ftp",
    "net/http",
    "net/https",
    "net/imap",
    "net/pop",
    "net/smtp",
    "nkf",
    "objspace",
    "observer",
    "open-uri",
    "open3",
    "openssl",
    "optparse",
    "ostruct",
    "pathname",
    "pp",
    "prettyprint",
    "prime",
    "pstore",
    "psych",
    "pty",
    "racc",
    "rdoc",
    "readline",
    "reline",
    "resolv",
    "ripper",
    "rss",
    "ruby2_keywords",
    "securerandom",
    "set",
    "shellwords",
    "singleton",
    "socket",
    "stringio",
    "strscan",
    "syslog",
    "tempfile",
    "thread",
    "time",
    "timeout",
    "tmpdir",
    "tracer",
    "tsort",
    "un",
    "uri",
    "weakref",
    "webrick",
    "yaml",
    "zlib",
  ])

  /**
   * Categorize a require statement
   */
  function categorizeRequire(requirePath: string): "stdlib" | "gems" | "local" {
    // Remove quotes if present
    const path = requirePath.replace(/^['"]|['"]$/g, "")

    // Check if it's a standard library module
    const basePath = path.split("/")[0]
    if (STDLIB_MODULES.has(basePath) || STDLIB_MODULES.has(path)) {
      return "stdlib"
    }

    // If it starts with ./ or ../ it's local
    if (path.startsWith("./") || path.startsWith("../")) {
      return "local"
    }

    // Otherwise assume it's a gem
    return "gems"
  }

  /**
   * Extract require statements from content
   */
  function extractRequires(content: string): RequireInfo {
    const requires: RequireInfo = {
      stdlib: [],
      gems: [],
      local: [],
    }

    const lines = content.split("\n")

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith("#")) continue

      // Match require 'foo' or require "foo"
      const requireMatch = trimmed.match(/^require\s+['"]([^'"]+)['"]/)
      if (requireMatch) {
        const path = requireMatch[1]
        const category = categorizeRequire(path)
        if (!requires[category].includes(path)) {
          requires[category].push(path)
        }
        continue
      }

      // Match require_relative 'foo'
      const relativeMatch = trimmed.match(/^require_relative\s+['"]([^'"]+)['"]/)
      if (relativeMatch) {
        const path = relativeMatch[1]
        if (!requires.local.includes(path)) {
          requires.local.push(path)
        }
      }
    }

    return requires
  }

  /**
   * Extract class definitions
   */
  function extractClasses(content: string): ClassInfo[] {
    const classes: ClassInfo[] = []
    const lines = content.split("\n")

    let currentClass: ClassInfo | null = null
    let depth = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith("#")) continue

      // Match class definition
      const classMatch = trimmed.match(/^class\s+([A-Z]\w*(?:::[A-Z]\w*)*)(?:\s*<\s*([A-Z]\w*(?:::[A-Z]\w*)*))?/)
      if (classMatch && !trimmed.includes(";")) {
        currentClass = {
          name: classMatch[1],
          superclass: classMatch[2],
          includes: [],
          extends: [],
          prepends: [],
          line: i + 1,
        }
        classes.push(currentClass)
        depth = 1
        continue
      }

      // Track class body for includes/extends
      if (currentClass && depth > 0) {
        // Track nesting
        if (
          /\b(class|module|def|do|begin|case|if|unless|while|until|for)\b/.test(trimmed) &&
          !trimmed.endsWith("end")
        ) {
          depth++
        }
        if (trimmed === "end" || trimmed.startsWith("end ") || trimmed.startsWith("end;")) {
          depth--
          if (depth === 0) {
            currentClass = null
          }
        }

        // Match include/extend/prepend at class level
        if (depth === 1 && currentClass) {
          const includeMatch = trimmed.match(/^include\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
          if (includeMatch) {
            currentClass.includes.push(includeMatch[1])
          }

          const extendMatch = trimmed.match(/^extend\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
          if (extendMatch) {
            currentClass.extends.push(extendMatch[1])
          }

          const prependMatch = trimmed.match(/^prepend\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
          if (prependMatch) {
            currentClass.prepends.push(prependMatch[1])
          }
        }
      }
    }

    return classes
  }

  /**
   * Extract module definitions
   */
  function extractModules(content: string): ModuleInfo[] {
    const modules: ModuleInfo[] = []
    const lines = content.split("\n")

    let currentModule: ModuleInfo | null = null
    let depth = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith("#")) continue

      // Match module definition
      const moduleMatch = trimmed.match(/^module\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
      if (moduleMatch && !trimmed.includes(";")) {
        currentModule = {
          name: moduleMatch[1],
          includes: [],
          extends: [],
          prepends: [],
          line: i + 1,
        }
        modules.push(currentModule)
        depth = 1
        continue
      }

      // Track module body for includes/extends
      if (currentModule && depth > 0) {
        // Track nesting
        if (
          /\b(class|module|def|do|begin|case|if|unless|while|until|for)\b/.test(trimmed) &&
          !trimmed.endsWith("end")
        ) {
          depth++
        }
        if (trimmed === "end" || trimmed.startsWith("end ") || trimmed.startsWith("end;")) {
          depth--
          if (depth === 0) {
            currentModule = null
          }
        }

        // Match include/extend/prepend at module level
        if (depth === 1 && currentModule) {
          const includeMatch = trimmed.match(/^include\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
          if (includeMatch) {
            currentModule.includes.push(includeMatch[1])
          }

          const extendMatch = trimmed.match(/^extend\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
          if (extendMatch) {
            currentModule.extends.push(extendMatch[1])
          }

          const prependMatch = trimmed.match(/^prepend\s+([A-Z]\w*(?:::[A-Z]\w*)*)/)
          if (prependMatch) {
            currentModule.prepends.push(prependMatch[1])
          }
        }
      }
    }

    return modules
  }

  /**
   * Extract method definitions
   */
  function extractMethods(content: string): MethodInfo[] {
    const methods: MethodInfo[] = []
    const lines = content.split("\n")

    let currentVisibility: "public" | "private" | "protected" = "public"
    let inClassOrModule = false
    let depth = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith("#")) continue

      // Track class/module context
      if (/^(class|module)\s+[A-Z]/.test(trimmed)) {
        inClassOrModule = true
        depth++
        currentVisibility = "public"
        continue
      }

      // Track visibility changes
      if (trimmed === "private" || trimmed === "private:") {
        currentVisibility = "private"
        continue
      }
      if (trimmed === "protected" || trimmed === "protected:") {
        currentVisibility = "protected"
        continue
      }
      if (trimmed === "public" || trimmed === "public:") {
        currentVisibility = "public"
        continue
      }

      // Match def statements
      const defMatch = trimmed.match(/^def\s+(self\.)?(\w+[?!=]?)/)
      if (defMatch) {
        methods.push({
          name: defMatch[2],
          isClassMethod: !!defMatch[1],
          visibility: inClassOrModule ? currentVisibility : "public",
          line: i + 1,
        })
        continue
      }

      // Match attr_accessor, attr_reader, attr_writer
      const attrMatch = trimmed.match(/^(attr_accessor|attr_reader|attr_writer)\s+(.+)/)
      if (attrMatch) {
        const attrType = attrMatch[1]
        const attrs = attrMatch[2].split(",").map((a) => a.trim().replace(/^:/, ""))
        for (const attr of attrs) {
          if (attr && /^\w+$/.test(attr)) {
            if (attrType === "attr_accessor" || attrType === "attr_reader") {
              methods.push({
                name: attr,
                isClassMethod: false,
                visibility: currentVisibility,
                line: i + 1,
              })
            }
            if (attrType === "attr_accessor" || attrType === "attr_writer") {
              methods.push({
                name: `${attr}=`,
                isClassMethod: false,
                visibility: currentVisibility,
                line: i + 1,
              })
            }
          }
        }
      }

      // Track nesting for end statements
      if (/\b(class|module|def|do|begin|case|if|unless|while|until|for)\b/.test(trimmed) && !trimmed.endsWith("end")) {
        depth++
      }
      if (trimmed === "end" || trimmed.startsWith("end ") || trimmed.startsWith("end;")) {
        depth--
        if (depth === 0) {
          inClassOrModule = false
          currentVisibility = "public"
        }
      }
    }

    return methods
  }

  /**
   * Extract constant definitions
   */
  function extractConstants(content: string): ConstantInfo[] {
    const constants: ConstantInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const trimmed = line.trim()

      // Skip comments
      if (trimmed.startsWith("#")) continue

      // Match CONSTANT = value
      const constMatch = trimmed.match(/^([A-Z][A-Z0-9_]*)\s*=\s*(.+)/)
      if (constMatch) {
        const name = constMatch[1]
        const value = constMatch[2].trim()

        let valueType = "unknown"
        if (value.startsWith("[")) valueType = "Array"
        else if (value.startsWith("{")) valueType = "Hash"
        else if (value.startsWith('"') || value.startsWith("'")) {
          const quoteChar = value[0]
          const endQuoteIndex = value.indexOf(quoteChar, 1)
          const stringContent = endQuoteIndex > 0 ? value.slice(1, endQuoteIndex) : value.slice(1)
          const sample = stringContent.slice(0, MAX_STRING_LENGTH)
          valueType = `String ("${sample}${stringContent.length > MAX_STRING_LENGTH ? "..." : ""}")`
        } else if (value.startsWith(":")) valueType = "Symbol"
        else if (/^\d+$/.test(value)) valueType = `Integer (${value})`
        else if (/^\d+\.\d+$/.test(value)) valueType = `Float (${value})`
        else if (value === "true" || value === "false") valueType = `Boolean (${value})`
        else if (value === "nil") valueType = "nil"
        else if (/^[A-Z]/.test(value)) valueType = `Reference (${value.slice(0, 30)})`

        constants.push({
          name,
          valueType,
          line: i + 1,
        })
      }
    }

    return constants
  }

  /**
   * Detect if file has main execution code (script mode)
   */
  function hasMainCode(content: string): boolean {
    const lines = content.split("\n")
    let depth = 0
    let hasTopLevelCode = false

    for (const line of lines) {
      const trimmed = line.trim()

      // Skip empty lines, comments, requires
      if (!trimmed || trimmed.startsWith("#") || /^require/.test(trimmed)) continue

      // Track nesting
      if (/^(class|module|def|do|begin|case|if|unless|while|until|for)\b/.test(trimmed)) {
        depth++
        continue
      }
      if (trimmed === "end" || trimmed.startsWith("end ") || trimmed.startsWith("end;")) {
        depth--
        continue
      }

      // Check for if __FILE__ == $0 or if __FILE__ == $PROGRAM_NAME
      if (/if\s+__FILE__\s*==\s*\$0|if\s+__FILE__\s*==\s*\$PROGRAM_NAME/.test(trimmed)) {
        return true
      }

      // If we're at top level and have executable code
      if (depth === 0 && !trimmed.match(/^(class|module|def|end|private|protected|public)\b/)) {
        // Skip constant definitions and attribute accessors
        if (!trimmed.match(/^[A-Z][A-Z0-9_]*\s*=/) && !trimmed.match(/^attr_/)) {
          hasTopLevelCode = true
        }
      }
    }

    return hasTopLevelCode
  }

  /**
   * Detect Rails patterns
   */
  function detectRailsPatterns(content: string, filePath?: string): RailsPatterns {
    const patterns: RailsPatterns = {
      isRailsFile: false,
      callbacks: [],
      validations: [],
      associations: [],
      scopes: [],
    }

    // Check file path for Rails conventions
    if (filePath) {
      if (filePath.includes("/controllers/")) {
        patterns.isRailsFile = true
        patterns.fileType = "controller"
      } else if (filePath.includes("/models/")) {
        patterns.isRailsFile = true
        patterns.fileType = "model"
      } else if (filePath.includes("/db/migrate/")) {
        patterns.isRailsFile = true
        patterns.fileType = "migration"
      } else if (filePath.includes("/mailers/")) {
        patterns.isRailsFile = true
        patterns.fileType = "mailer"
      } else if (filePath.includes("/jobs/")) {
        patterns.isRailsFile = true
        patterns.fileType = "job"
      } else if (filePath.includes("/serializers/")) {
        patterns.isRailsFile = true
        patterns.fileType = "serializer"
      } else if (filePath.includes("/concerns/")) {
        patterns.isRailsFile = true
        patterns.fileType = "concern"
      } else if (filePath.includes("/helpers/")) {
        patterns.isRailsFile = true
        patterns.fileType = "helper"
      } else if (filePath.includes("/views/")) {
        patterns.isRailsFile = true
        patterns.fileType = "view"
      }
    }

    // Detect Rails patterns in content
    const callbackPatterns = [
      "before_action",
      "after_action",
      "around_action",
      "before_save",
      "after_save",
      "before_create",
      "after_create",
      "before_update",
      "after_update",
      "before_destroy",
      "after_destroy",
      "before_validation",
      "after_validation",
      "after_commit",
      "after_rollback",
      "after_initialize",
      "after_find",
    ]

    const validationPatterns = [
      "validates",
      "validates_presence_of",
      "validates_uniqueness_of",
      "validates_format_of",
      "validates_length_of",
      "validates_numericality_of",
      "validates_inclusion_of",
      "validates_exclusion_of",
      "validates_associated",
      "validates_confirmation_of",
      "validates_acceptance_of",
    ]

    const associationPatterns = ["belongs_to", "has_one", "has_many", "has_and_belongs_to_many"]

    for (const callback of callbackPatterns) {
      if (content.includes(callback)) {
        patterns.isRailsFile = true
        if (!patterns.callbacks.includes(callback)) {
          patterns.callbacks.push(callback)
        }
      }
    }

    for (const validation of validationPatterns) {
      if (content.includes(validation)) {
        patterns.isRailsFile = true
        if (!patterns.validations.includes(validation)) {
          patterns.validations.push(validation)
        }
      }
    }

    for (const assoc of associationPatterns) {
      if (new RegExp(`\\b${assoc}\\b`).test(content)) {
        patterns.isRailsFile = true
        if (!patterns.associations.includes(assoc)) {
          patterns.associations.push(assoc)
        }
      }
    }

    // Detect scopes
    const scopeMatches = content.matchAll(/\bscope\s+:(\w+)/g)
    for (const match of scopeMatches) {
      patterns.isRailsFile = true
      if (!patterns.scopes.includes(match[1])) {
        patterns.scopes.push(match[1])
      }
    }

    // Check for ActiveRecord inheritance
    if (/class\s+\w+\s*<\s*(ApplicationRecord|ActiveRecord::Base)/.test(content)) {
      patterns.isRailsFile = true
      if (!patterns.fileType) patterns.fileType = "model"
    }

    // Check for ApplicationController inheritance
    if (/class\s+\w+\s*<\s*(ApplicationController|ActionController::Base)/.test(content)) {
      patterns.isRailsFile = true
      if (!patterns.fileType) patterns.fileType = "controller"
    }

    return patterns
  }

  /**
   * Extract block/DSL usages (RSpec, etc.)
   */
  function extractBlocks(content: string): BlockInfo[] {
    const blocks: BlockInfo[] = []
    const lines = content.split("\n")

    // RSpec and testing DSL patterns
    const blockPatterns = [
      { pattern: /^(\s*)(describe|context|feature)\s+['"](.+?)['"]\s*do/, type: "describe" },
      { pattern: /^(\s*)(it|specify|example|scenario)\s+['"](.+?)['"]\s*do/, type: "it" },
      { pattern: /^(\s*)(before|after)\s*(\(:?\w+\))?\s*do/, type: "hook" },
      { pattern: /^(\s*)(let|let!)\s*\(:?(\w+)\)/, type: "let" },
      { pattern: /^(\s*)(subject)\s*(\(:?\w+\))?\s*do/, type: "subject" },
      { pattern: /^(\s*)(shared_examples|shared_context)\s+['"](.+?)['"]/, type: "shared" },
      { pattern: /^(\s*)(RSpec\.describe|describe)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/, type: "describe" },
    ]

    // Rake task patterns
    const rakePatterns = [
      { pattern: /^(\s*)task\s+:?(\w+)/, type: "task" },
      { pattern: /^(\s*)namespace\s+:(\w+)/, type: "namespace" },
    ]

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      for (const { pattern, type } of blockPatterns) {
        const match = line.match(pattern)
        if (match) {
          blocks.push({
            type,
            description: match[3] || match[2],
            line: i + 1,
          })
          break
        }
      }

      for (const { pattern, type } of rakePatterns) {
        const match = line.match(pattern)
        if (match) {
          blocks.push({
            type,
            description: match[2],
            line: i + 1,
          })
          break
        }
      }
    }

    return blocks
  }

  /**
   * Extract magic comments from file
   */
  function extractMagicComments(content: string): { frozenStringLiteral: boolean; comments: string[] } {
    const comments: string[] = []
    let frozenStringLiteral = false

    const lines = content.split("\n").slice(0, 5) // Only check first 5 lines

    for (const line of lines) {
      const trimmed = line.trim()

      // Check for frozen_string_literal
      if (trimmed.match(/^#\s*frozen_string_literal:\s*true/)) {
        frozenStringLiteral = true
        comments.push("frozen_string_literal: true")
      }

      // Check for encoding
      const encodingMatch = trimmed.match(/^#.*(?:encoding|coding):\s*(\S+)/)
      if (encodingMatch) {
        comments.push(`encoding: ${encodingMatch[1]}`)
      }

      // Check for warn_indent
      if (trimmed.match(/^#\s*warn_indent:\s*true/)) {
        comments.push("warn_indent: true")
      }
    }

    return { frozenStringLiteral, comments }
  }

  /**
   * Format the summary
   */
  function formatSummary(filePath: string, metadata: RubyMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: Ruby`)
    lines.push(`Lines: ${metadata.lineCount}`)

    if (metadata.frozenStringLiteral) {
      lines.push(`Frozen string literal: enabled`)
    }

    if (metadata.magicComments.length > 0) {
      lines.push(`Magic comments: ${metadata.magicComments.join(", ")}`)
    }

    lines.push("")

    // Requires
    const totalRequires =
      metadata.requires.stdlib.length + metadata.requires.gems.length + metadata.requires.local.length
    if (totalRequires > 0) {
      lines.push("Requires:")
      if (metadata.requires.stdlib.length > 0) {
        lines.push(`  Standard library (${metadata.requires.stdlib.length}):`)
        for (const req of metadata.requires.stdlib.slice(0, MAX_LIST_ITEMS)) {
          lines.push(`    - ${req}`)
        }
        if (metadata.requires.stdlib.length > MAX_LIST_ITEMS) {
          lines.push(`    ... and ${metadata.requires.stdlib.length - MAX_LIST_ITEMS} more`)
        }
      }
      if (metadata.requires.gems.length > 0) {
        lines.push(`  Gems (${metadata.requires.gems.length}):`)
        for (const req of metadata.requires.gems.slice(0, MAX_LIST_ITEMS)) {
          lines.push(`    - ${req}`)
        }
        if (metadata.requires.gems.length > MAX_LIST_ITEMS) {
          lines.push(`    ... and ${metadata.requires.gems.length - MAX_LIST_ITEMS} more`)
        }
      }
      if (metadata.requires.local.length > 0) {
        lines.push(`  Local files (${metadata.requires.local.length}):`)
        for (const req of metadata.requires.local.slice(0, MAX_LIST_ITEMS)) {
          lines.push(`    - ${req}`)
        }
        if (metadata.requires.local.length > MAX_LIST_ITEMS) {
          lines.push(`    ... and ${metadata.requires.local.length - MAX_LIST_ITEMS} more`)
        }
      }
      lines.push("")
    }

    // Rails patterns
    if (metadata.rails.isRailsFile) {
      lines.push("Rails:")
      if (metadata.rails.fileType) {
        lines.push(`  Type: ${metadata.rails.fileType}`)
      }
      if (metadata.rails.associations.length > 0) {
        lines.push(`  Associations: ${metadata.rails.associations.join(", ")}`)
      }
      if (metadata.rails.callbacks.length > 0) {
        lines.push(`  Callbacks: ${metadata.rails.callbacks.join(", ")}`)
      }
      if (metadata.rails.validations.length > 0) {
        lines.push(`  Validations: ${metadata.rails.validations.join(", ")}`)
      }
      if (metadata.rails.scopes.length > 0) {
        lines.push(
          `  Scopes: ${metadata.rails.scopes.slice(0, 10).join(", ")}${metadata.rails.scopes.length > 10 ? "..." : ""}`,
        )
      }
      lines.push("")
    }

    // Modules
    if (metadata.modules.length > 0) {
      lines.push(`Modules (${metadata.modules.length}):`)
      for (const mod of metadata.modules.slice(0, MAX_LIST_ITEMS)) {
        let desc = `  - ${mod.name} (line ${mod.line})`
        if (mod.includes.length > 0) {
          desc += ` includes: ${mod.includes.join(", ")}`
        }
        lines.push(desc)
      }
      if (metadata.modules.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.modules.length - MAX_LIST_ITEMS} more`)
      }
      lines.push("")
    }

    // Classes
    if (metadata.classes.length > 0) {
      lines.push(`Classes (${metadata.classes.length}):`)
      for (const cls of metadata.classes.slice(0, MAX_LIST_ITEMS)) {
        let desc = `  - ${cls.name}`
        if (cls.superclass) {
          desc += ` < ${cls.superclass}`
        }
        desc += ` (line ${cls.line})`
        if (cls.includes.length > 0) {
          desc += ` includes: ${cls.includes.join(", ")}`
        }
        lines.push(desc)
      }
      if (metadata.classes.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.classes.length - MAX_LIST_ITEMS} more`)
      }
      lines.push("")
    }

    // Methods
    if (metadata.methods.length > 0) {
      const publicMethods = metadata.methods.filter((m) => m.visibility === "public")
      const privateMethods = metadata.methods.filter((m) => m.visibility === "private")
      const protectedMethods = metadata.methods.filter((m) => m.visibility === "protected")
      const classMethods = metadata.methods.filter((m) => m.isClassMethod)
      const instanceMethods = metadata.methods.filter((m) => !m.isClassMethod)

      lines.push(`Methods (${metadata.methods.length} total):`)
      lines.push(
        `  Public: ${publicMethods.length}, Private: ${privateMethods.length}, Protected: ${protectedMethods.length}`,
      )
      lines.push(`  Class methods: ${classMethods.length}, Instance methods: ${instanceMethods.length}`)

      // Show some method names
      const methodNames = metadata.methods.slice(0, 15).map((m) => (m.isClassMethod ? `self.${m.name}` : m.name))
      lines.push(`  Sample: ${methodNames.join(", ")}${metadata.methods.length > 15 ? "..." : ""}`)
      lines.push("")
    }

    // Constants
    if (metadata.constants.length > 0) {
      lines.push(`Constants (${metadata.constants.length}):`)
      for (const constant of metadata.constants.slice(0, MAX_LIST_ITEMS)) {
        lines.push(`  - ${constant.name}: ${constant.valueType}`)
      }
      if (metadata.constants.length > MAX_LIST_ITEMS) {
        lines.push(`  ... and ${metadata.constants.length - MAX_LIST_ITEMS} more`)
      }
      lines.push("")
    }

    // Blocks/DSL
    if (metadata.blocks.length > 0) {
      // Group blocks by type
      const blocksByType: Record<string, BlockInfo[]> = {}
      for (const block of metadata.blocks) {
        if (!blocksByType[block.type]) {
          blocksByType[block.type] = []
        }
        blocksByType[block.type].push(block)
      }

      lines.push(`Blocks/DSL (${metadata.blocks.length}):`)
      for (const [type, blocks] of Object.entries(blocksByType)) {
        lines.push(`  ${type}: ${blocks.length}`)
        for (const block of blocks.slice(0, 5)) {
          if (block.description) {
            lines.push(`    - ${block.description} (line ${block.line})`)
          }
        }
        if (blocks.length > 5) {
          lines.push(`    ... and ${blocks.length - 5} more`)
        }
      }
      lines.push("")
    }

    // Main code indicator
    if (metadata.hasMainCode) {
      lines.push("Note: File contains executable code outside class/module definitions (script mode)")
    }

    return lines.join("\n")
  }

  /**
   * Explore a Ruby file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<RubyExplorationResult> {
    const filePath = input.filePath ?? "unknown.rb"
    log.info("exploring Ruby file", { filePath })

    try {
      const lineCount = input.content.split("\n").length

      // Extract all components
      const requires = extractRequires(input.content)
      const classes = extractClasses(input.content)
      const modules = extractModules(input.content)
      const methods = extractMethods(input.content)
      const constants = extractConstants(input.content)
      const mainCode = hasMainCode(input.content)
      const rails = detectRailsPatterns(input.content, filePath)
      const blocks = extractBlocks(input.content)
      const { frozenStringLiteral, comments: magicComments } = extractMagicComments(input.content)

      const metadata: RubyMetadata = {
        requires,
        classes,
        modules,
        methods,
        constants,
        hasMainCode: mainCode,
        rails,
        blocks,
        lineCount,
        frozenStringLiteral,
        magicComments,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        const structuredMetadata = formatSummary(filePath, metadata)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "Ruby",
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

      log.info("Ruby exploration complete", {
        filePath,
        classes: classes.length,
        modules: modules.length,
        methods: methods.length,
        constants: constants.length,
        isRails: rails.isRailsFile,
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
      log.error("failed to explore Ruby file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          requires: { stdlib: [], gems: [], local: [] },
          classes: [],
          modules: [],
          methods: [],
          constants: [],
          hasMainCode: false,
          rails: {
            isRailsFile: false,
            callbacks: [],
            validations: [],
            associations: [],
            scopes: [],
          },
          blocks: [],
          lineCount: 0,
          frozenStringLiteral: false,
          magicComments: [],
        },
        tokenCount: 0,
        error: `Failed to explore Ruby file: ${errorMessage}`,
      }
    }
  }
}
