import path from "path"
import fs from "fs/promises"
import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { TextExplorer } from "./text-explorer"
import { FallbackExplorer } from "./fallback-explorer"
import { SqliteExplorer } from "./sqlite-explorer"
import { PdfExplorer } from "./pdf-explorer"
import { JsonExplorer } from "./json-explorer"
import { CsvExplorer } from "./csv-explorer"
import { YamlExplorer } from "./yaml-explorer"
import { TomlExplorer } from "./toml-explorer"
import { IniExplorer } from "./ini-explorer"
import { XmlExplorer } from "./xml-explorer"
import { HtmlExplorer } from "./html-explorer"
import { LogExplorer } from "./log-explorer"
import { ExecutableExplorer } from "./executable-explorer"
import { ImageExplorer } from "./image-explorer"
import { PythonExplorer } from "./python-explorer"
import { LatexExplorer } from "./latex-explorer"
import { MarkdownExplorer } from "./markdown-explorer"
import { GoExplorer } from "./go-explorer"
import { RustExplorer } from "./rust-explorer"
import { TypeScriptExplorer } from "./typescript-explorer"
import { JavaScriptExplorer } from "./javascript-explorer"
import { CssExplorer } from "./css-explorer"
import { RubyExplorer } from "./ruby-explorer"
import { CExplorer } from "./c-explorer"
import { CppExplorer } from "./cpp-explorer"
import { CSharpExplorer } from "./csharp-explorer"
import { JavaExplorer } from "./java-explorer"
import { ObjCExplorer } from "./objc-explorer"
import { SwiftExplorer } from "./swift-explorer"
import { CudaExplorer } from "./cuda-explorer"
import { TclExplorer } from "./tcl-explorer"

/**
 * LCM Exploration Dispatcher
 *
 * Selects the appropriate exploration agent based on file type, using
 * extension, MIME type, and content-based detection (magic bytes).
 */
export namespace ExploreDispatcher {
  const log = Log.create({ service: "lcm.explore.dispatcher" })

  /**
   * Maximum file size to fully load into memory (50MB).
   * Files larger than this will be sampled instead.
   */
  const MAX_FULL_LOAD_SIZE = 50 * 1024 * 1024

  /**
   * Size of header to read for magic byte detection (8KB).
   */
  const MAGIC_DETECTION_SIZE = 8 * 1024

  /**
   * Size of content sample to read for text exploration (200KB total).
   * Split across beginning, middle, and end.
   */
  const SAMPLE_SIZE = 200 * 1024

  /**
   * Explorer type identifier
   */
  export type ExplorerType =
    | "text"
    | "pdf"
    | "sqlite"
    | "json"
    | "csv"
    | "yaml"
    | "toml"
    | "ini"
    | "xml"
    | "html"
    | "log"
    | "executable"
    | "image"
    | "python"
    | "latex"
    | "markdown"
    | "go"
    | "rust"
    | "typescript"
    | "javascript"
    | "css"
    | "ruby"
    | "c"
    | "cpp"
    | "csharp"
    | "java"
    | "objc"
    | "swift"
    | "cuda"
    | "tcl"
    | "fallback"

  /**
   * Common fields for all dispatcher results
   */
  interface BaseDispatcherResult {
    /** Which explorer was used */
    explorerUsed: ExplorerType
  }

  /**
   * Result when TextExplorer is used
   */
  export interface TextDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "text"
    summary: string
    metadata: TextExplorer.ExplorationMetadata
    tokenCount: number
  }

  /**
   * Result when SqliteExplorer is used
   */
  export interface SqliteDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "sqlite"
    success: boolean
    summary: string
    metadata: SqliteExplorer.DatabaseMetadata
    tokenCount: number
    indexes: SqliteExplorer.IndexInfo[]
    error?: string
  }

  /**
   * Result when PdfExplorer is used
   */
  export interface PdfDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "pdf"
    success: boolean
    summary: string
    metadata: TextExplorer.ExplorationMetadata | FallbackExplorer.FallbackExplorationResult["metadata"]
    tokenCount: number
    pagesExtracted?: number
    error?: string
  }

  /**
   * Result when FallbackExplorer is used
   */
  export interface FallbackDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "fallback"
    summary: string
    metadata: FallbackExplorer.FallbackExplorationResult["metadata"]
    tokenCount: number
  }

  /**
   * Result when JsonExplorer is used
   */
  export interface JsonDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "json"
    success: boolean
    summary: string
    metadata: JsonExplorer.JsonMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when CsvExplorer is used
   */
  export interface CsvDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "csv"
    success: boolean
    summary: string
    metadata: CsvExplorer.CsvMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when YamlExplorer is used
   */
  export interface YamlDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "yaml"
    success: boolean
    summary: string
    metadata: YamlExplorer.YamlMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when TomlExplorer is used
   */
  export interface TomlDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "toml"
    success: boolean
    summary: string
    metadata: TomlExplorer.TomlMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when IniExplorer is used
   */
  export interface IniDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "ini"
    success: boolean
    summary: string
    metadata: IniExplorer.IniMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when XmlExplorer is used
   */
  export interface XmlDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "xml"
    success: boolean
    summary: string
    metadata: XmlExplorer.XmlMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when HtmlExplorer is used
   */
  export interface HtmlDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "html"
    success: boolean
    summary: string
    metadata: HtmlExplorer.HtmlMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when LogExplorer is used
   */
  export interface LogDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "log"
    success: boolean
    summary: string
    metadata: LogExplorer.LogMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when ExecutableExplorer is used
   */
  export interface ExecutableDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "executable"
    success: boolean
    summary: string
    metadata: ExecutableExplorer.ExecutableMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when ImageExplorer is used
   */
  export interface ImageDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "image"
    success: boolean
    summary: string
    metadata: ImageExplorer.ImageMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when PythonExplorer is used
   */
  export interface PythonDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "python"
    success: boolean
    summary: string
    metadata: PythonExplorer.PythonMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when LatexExplorer is used
   */
  export interface LatexDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "latex"
    success: boolean
    summary: string
    metadata: LatexExplorer.LatexMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when MarkdownExplorer is used
   */
  export interface MarkdownDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "markdown"
    success: boolean
    summary: string
    metadata: MarkdownExplorer.MarkdownMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when GoExplorer is used
   */
  export interface GoDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "go"
    success: boolean
    summary: string
    metadata: GoExplorer.GoMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when RustExplorer is used
   */
  export interface RustDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "rust"
    success: boolean
    summary: string
    metadata: RustExplorer.RustMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when TypeScriptExplorer is used
   */
  export interface TypeScriptDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "typescript"
    success: boolean
    summary: string
    metadata: TypeScriptExplorer.TypeScriptMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when JavaScriptExplorer is used
   */
  export interface JavaScriptDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "javascript"
    success: boolean
    summary: string
    metadata: JavaScriptExplorer.JavaScriptMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when CssExplorer is used
   */
  export interface CssDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "css"
    success: boolean
    summary: string
    metadata: CssExplorer.CssMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when RubyExplorer is used
   */
  export interface RubyDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "ruby"
    success: boolean
    summary: string
    metadata: RubyExplorer.RubyMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when CExplorer is used
   */
  export interface CDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "c"
    success: boolean
    summary: string
    metadata: CExplorer.CMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when CppExplorer is used
   */
  export interface CppDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "cpp"
    success: boolean
    summary: string
    metadata: CppExplorer.CppMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when CSharpExplorer is used
   */
  export interface CSharpDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "csharp"
    success: boolean
    summary: string
    metadata: CSharpExplorer.CSharpMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when JavaExplorer is used
   */
  export interface JavaDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "java"
    success: boolean
    summary: string
    metadata: JavaExplorer.JavaMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when ObjCExplorer is used
   */
  export interface ObjCDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "objc"
    success: boolean
    summary: string
    metadata: ObjCExplorer.ObjCMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when SwiftExplorer is used
   */
  export interface SwiftDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "swift"
    success: boolean
    summary: string
    metadata: SwiftExplorer.SwiftMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when CudaExplorer is used
   */
  export interface CudaDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "cuda"
    success: boolean
    summary: string
    metadata: CudaExplorer.CudaMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Result when TclExplorer is used
   */
  export interface TclDispatcherResult extends BaseDispatcherResult {
    explorerUsed: "tcl"
    success: boolean
    summary: string
    metadata: TclExplorer.TclMetadata
    tokenCount: number
    error?: string
  }

  /**
   * Union of all possible dispatcher results
   */
  export type DispatcherResult =
    | TextDispatcherResult
    | SqliteDispatcherResult
    | PdfDispatcherResult
    | FallbackDispatcherResult
    | JsonDispatcherResult
    | CsvDispatcherResult
    | YamlDispatcherResult
    | TomlDispatcherResult
    | IniDispatcherResult
    | XmlDispatcherResult
    | HtmlDispatcherResult
    | LogDispatcherResult
    | ExecutableDispatcherResult
    | ImageDispatcherResult
    | PythonDispatcherResult
    | LatexDispatcherResult
    | MarkdownDispatcherResult
    | GoDispatcherResult
    | RustDispatcherResult
    | TypeScriptDispatcherResult
    | JavaScriptDispatcherResult
    | CssDispatcherResult
    | RubyDispatcherResult
    | CDispatcherResult
    | CppDispatcherResult
    | CSharpDispatcherResult
    | JavaDispatcherResult
    | ObjCDispatcherResult
    | SwiftDispatcherResult
    | CudaDispatcherResult
    | TclDispatcherResult

  /**
   * Input for the explore function
   */
  export interface ExploreInput {
    /** For in-memory content */
    content?: string | Buffer
    /** For file on disk */
    filePath?: string
    /** Optional MIME type hint */
    mimeType?: string
    /** For LLM-based explorers */
    model: Provider.Model
    /** Session ID for spawning exploration agents */
    sessionID?: string
    /** Optional abort signal for cancellation */
    abort?: AbortSignal
  }

  /**
   * SQLite magic bytes: "SQLite format 3\0"
   */
  const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "ascii")

  /**
   * PDF magic bytes: "%PDF-"
   */
  const PDF_MAGIC = Buffer.from("%PDF-", "ascii")

  /**
   * ELF magic bytes
   */
  const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]) // \x7fELF

  /**
   * Mach-O magic bytes (various)
   */
  const MACHO_MAGIC_32 = Buffer.from([0xfe, 0xed, 0xfa, 0xce]) // 32-bit
  const MACHO_MAGIC_64 = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]) // 64-bit
  const MACHO_MAGIC_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]) // Universal

  /**
   * PE (Windows) magic bytes
   */
  const PE_MAGIC = Buffer.from([0x4d, 0x5a]) // MZ

  /**
   * Common image magic bytes
   */
  const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const GIF_MAGIC = Buffer.from("GIF8") // GIF87a or GIF89a
  const WEBP_MAGIC = Buffer.from("RIFF")
  const BMP_MAGIC = Buffer.from([0x42, 0x4d])

  /**
   * JSON file extensions
   */
  const JSON_EXTENSIONS = new Set(["json", "jsonc", "json5"])

  /**
   * CSV file extensions
   */
  const CSV_EXTENSIONS = new Set(["csv", "tsv"])

  /**
   * YAML file extensions
   */
  const YAML_EXTENSIONS = new Set(["yaml", "yml"])

  /**
   * TOML file extensions
   */
  const TOML_EXTENSIONS = new Set(["toml"])

  /**
   * INI file extensions
   */
  const INI_EXTENSIONS = new Set(["ini", "cfg", "conf", "config", "properties"])

  /**
   * XML file extensions
   */
  const XML_EXTENSIONS = new Set(["xml", "xsl", "xslt", "xsd", "wsdl", "svg", "rss", "atom", "plist"])

  /**
   * HTML file extensions
   */
  const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"])

  /**
   * Log file extensions
   */
  const LOG_EXTENSIONS = new Set(["log", "logs", "out", "err", "stderr", "stdout"])

  /**
   * Executable file extensions
   */
  const EXECUTABLE_EXTENSIONS = new Set([
    "exe",
    "dll",
    "so",
    "dylib",
    "a",
    "o",
    "obj",
    "bin",
    "elf",
    "app",
    "deb",
    "rpm",
    "msi",
    "dmg",
    "wasm",
  ])

  /**
   * Image file extensions
   */
  const IMAGE_EXTENSIONS = new Set([
    "jpg",
    "jpeg",
    "png",
    "gif",
    "webp",
    "bmp",
    "tiff",
    "tif",
    "ico",
    "heic",
    "heif",
    "avif",
    "raw",
    "cr2",
    "nef",
    "arw",
    "dng",
    "psd",
  ])

  /**
   * Python file extensions
   */
  const PYTHON_EXTENSIONS = new Set(["py", "pyi", "pyw", "pyx", "pxd"])

  /**
   * LaTeX file extensions
   */
  const LATEX_EXTENSIONS = new Set(["tex", "latex", "sty", "cls", "bib", "bst"])

  /**
   * Markdown file extensions
   */
  const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx", "mdown", "mkd", "mkdn"])

  /**
   * Go file extensions
   */
  const GO_EXTENSIONS = new Set(["go"])

  /**
   * Rust file extensions
   */
  const RUST_EXTENSIONS = new Set(["rs"])

  /**
   * TypeScript file extensions
   */
  const TYPESCRIPT_EXTENSIONS = new Set(["ts", "tsx", "mts", "cts"])

  /**
   * JavaScript file extensions
   */
  const JAVASCRIPT_EXTENSIONS = new Set(["js", "mjs", "cjs", "jsx"])

  /**
   * CSS file extensions
   */
  const CSS_EXTENSIONS = new Set(["css", "scss", "sass", "less", "styl", "stylus"])

  /**
   * Ruby file extensions
   */
  const RUBY_EXTENSIONS = new Set(["rb", "rake", "gemspec", "ru", "erb"])

  /**
   * C file extensions
   */
  const C_EXTENSIONS = new Set(["c", "h"])

  /**
   * C++ file extensions
   */
  const CPP_EXTENSIONS = new Set(["cpp", "cc", "cxx", "hpp", "hxx", "hh", "ipp"])

  /**
   * C# file extensions
   */
  const CSHARP_EXTENSIONS = new Set(["cs", "csx"])

  /**
   * Java file extensions
   */
  const JAVA_EXTENSIONS = new Set(["java"])

  /**
   * Objective-C file extensions
   */
  const OBJC_EXTENSIONS = new Set(["m", "mm"])

  /**
   * Swift file extensions
   */
  const SWIFT_EXTENSIONS = new Set(["swift"])

  /**
   * CUDA file extensions
   */
  const CUDA_EXTENSIONS = new Set(["cu", "cuh"])

  /**
   * Tcl file extensions
   */
  const TCL_EXTENSIONS = new Set(["tcl", "tk", "itcl", "itk"])

  /**
   * Text file extensions that should use TextExplorer
   * (Only for generic text files that don't have specialized explorers)
   */
  const TEXT_EXTENSIONS = new Set([
    // Plain text
    "txt",
    "text",
    // Kotlin/Scala (no specialized explorer yet)
    "kt",
    "kts",
    "scala",
    // F#
    "fs",
    "fsx",
    // PHP
    "php",
    // Shell
    "sh",
    "bash",
    "zsh",
    "fish",
    "ps1",
    "psm1",
    // SQL
    "sql",
    // Config files (env only - ini/cfg have their own explorer)
    "env",
    // Makefile variants
    "mk",
    // Dockerfile
    "dockerfile",
    // Other languages without specialized explorers
    "lua",
    "r",
    "R",
    "pl",
    "pm",
    "hs",
    "lhs",
    "ml",
    "mli",
    "ex",
    "exs",
    "erl",
    "hrl",
    "clj",
    "cljs",
    "cljc",
    "edn",
    "vim",
    "el",
    "lisp",
    "scm",
    "rkt",
    // Template files
    "vue",
    "svelte",
    "astro",
    "ejs",
    "hbs",
    "mustache",
    "pug",
    "jade",
    // Data interchange
    "graphql",
    "gql",
    "proto",
  ])

  /**
   * SQLite file extensions
   */
  const SQLITE_EXTENSIONS = new Set(["sqlite", "sqlite3", "db", "db3", "s3db", "sl3"])

  /**
   * Check if the first bytes match the expected magic bytes
   */
  function matchesMagic(content: Buffer, magic: Buffer): boolean {
    if (content.length < magic.length) return false
    return content.subarray(0, magic.length).equals(magic)
  }

  /**
   * Detect file type from extension
   */
  function detectTypeFromExtension(filePath: string): ExplorerType | undefined {
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, "")
    if (!ext) return undefined

    if (SQLITE_EXTENSIONS.has(ext)) return "sqlite"
    if (ext === "pdf") return "pdf"
    if (PYTHON_EXTENSIONS.has(ext)) return "python"
    if (JSON_EXTENSIONS.has(ext)) return "json"
    if (CSV_EXTENSIONS.has(ext)) return "csv"
    if (YAML_EXTENSIONS.has(ext)) return "yaml"
    if (TOML_EXTENSIONS.has(ext)) return "toml"
    if (INI_EXTENSIONS.has(ext)) return "ini"
    if (XML_EXTENSIONS.has(ext)) return "xml"
    if (HTML_EXTENSIONS.has(ext)) return "html"
    if (LOG_EXTENSIONS.has(ext)) return "log"
    if (EXECUTABLE_EXTENSIONS.has(ext)) return "executable"
    if (IMAGE_EXTENSIONS.has(ext)) return "image"
    // Programming language explorers
    if (LATEX_EXTENSIONS.has(ext)) return "latex"
    if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown"
    if (GO_EXTENSIONS.has(ext)) return "go"
    if (RUST_EXTENSIONS.has(ext)) return "rust"
    if (TYPESCRIPT_EXTENSIONS.has(ext)) return "typescript"
    if (JAVASCRIPT_EXTENSIONS.has(ext)) return "javascript"
    if (CSS_EXTENSIONS.has(ext)) return "css"
    if (RUBY_EXTENSIONS.has(ext)) return "ruby"
    if (C_EXTENSIONS.has(ext)) return "c"
    if (CPP_EXTENSIONS.has(ext)) return "cpp"
    if (CSHARP_EXTENSIONS.has(ext)) return "csharp"
    if (JAVA_EXTENSIONS.has(ext)) return "java"
    if (OBJC_EXTENSIONS.has(ext)) return "objc"
    if (SWIFT_EXTENSIONS.has(ext)) return "swift"
    if (CUDA_EXTENSIONS.has(ext)) return "cuda"
    if (TCL_EXTENSIONS.has(ext)) return "tcl"
    // Generic text fallback
    if (TEXT_EXTENSIONS.has(ext)) return "text"

    return undefined
  }

  /**
   * Detect file type from MIME type
   */
  function detectTypeFromMimeType(mimeType: string): ExplorerType | undefined {
    const normalized = mimeType.toLowerCase()

    // SQLite
    if (normalized === "application/x-sqlite3" || normalized === "application/vnd.sqlite3") {
      return "sqlite"
    }

    // PDF
    if (normalized === "application/pdf") {
      return "pdf"
    }

    // JSON
    if (normalized === "application/json" || normalized.endsWith("+json")) {
      return "json"
    }

    // CSV
    if (normalized === "text/csv" || normalized === "text/tab-separated-values") {
      return "csv"
    }

    // YAML
    if (normalized === "application/x-yaml" || normalized === "text/yaml" || normalized === "text/x-yaml") {
      return "yaml"
    }

    // TOML
    if (normalized === "application/toml" || normalized === "text/x-toml") {
      return "toml"
    }

    // XML
    if (normalized === "application/xml" || normalized === "text/xml" || normalized.endsWith("+xml")) {
      return "xml"
    }

    // HTML
    if (normalized === "text/html" || normalized === "application/xhtml+xml") {
      return "html"
    }

    // Python
    if (normalized === "text/x-python" || normalized === "application/x-python") {
      return "python"
    }

    // Images
    if (normalized.startsWith("image/") && normalized !== "image/svg+xml") {
      return "image"
    }

    // Executables
    if (
      normalized === "application/x-executable" ||
      normalized === "application/x-mach-binary" ||
      normalized === "application/x-elf" ||
      normalized === "application/x-dosexec" ||
      normalized === "application/x-sharedlib" ||
      normalized === "application/x-object" ||
      normalized === "application/wasm" ||
      normalized === "application/vnd.microsoft.portable-executable"
    ) {
      return "executable"
    }

    // Text-based MIME types
    if (normalized.startsWith("text/")) return "text"
    if (normalized === "application/javascript" || normalized === "application/typescript") {
      return "text"
    }

    return undefined
  }

  /**
   * Detect file type from content magic bytes
   */
  function detectTypeFromContent(content: Buffer): ExplorerType | undefined {
    // Check SQLite magic bytes
    if (matchesMagic(content, SQLITE_MAGIC)) return "sqlite"

    // Check PDF magic bytes
    if (matchesMagic(content, PDF_MAGIC)) return "pdf"

    // Check executable magic bytes
    if (matchesMagic(content, ELF_MAGIC)) return "executable"
    if (matchesMagic(content, MACHO_MAGIC_32)) return "executable"
    if (matchesMagic(content, MACHO_MAGIC_64)) return "executable"
    if (matchesMagic(content, MACHO_MAGIC_FAT)) return "executable"
    if (matchesMagic(content, PE_MAGIC)) return "executable"

    // Check image magic bytes
    if (matchesMagic(content, JPEG_MAGIC)) return "image"
    if (matchesMagic(content, PNG_MAGIC)) return "image"
    if (matchesMagic(content, GIF_MAGIC)) return "image"
    if (matchesMagic(content, BMP_MAGIC)) return "image"
    // WebP check: RIFF....WEBP
    if (matchesMagic(content, WEBP_MAGIC) && content.length >= 12) {
      if (content.subarray(8, 12).equals(Buffer.from("WEBP"))) return "image"
    }

    return undefined
  }

  /**
   * Check if content appears to be valid UTF-8 text with few control characters
   */
  function looksLikeText(content: Buffer): boolean {
    // Check first 8KB
    const checkBytes = Math.min(content.length, 8192)
    if (checkBytes === 0) return true // Empty is text

    let nullCount = 0
    let controlCount = 0

    for (let i = 0; i < checkBytes; i++) {
      const byte = content[i]

      // Null bytes strongly indicate binary
      if (byte === 0) {
        nullCount++
      }

      // Control characters (except tab, newline, carriage return)
      if (byte !== 9 && byte !== 10 && byte !== 13 && byte < 32) {
        controlCount++
      }
    }

    // If we have null bytes, it's likely binary
    if (nullCount > 0) return false

    // If more than 10% control characters, likely binary
    const controlRatio = controlCount / checkBytes
    return controlRatio < 0.1
  }

  /**
   * Load file content from disk - respects memory limits.
   * For files larger than MAX_FULL_LOAD_SIZE, returns only a sample.
   *
   * @returns Object with buffer and whether it's a sample
   */
  async function loadFileContent(
    filePath: string,
  ): Promise<{ buffer: Buffer; isSampled: boolean; fileSize: number } | undefined> {
    const file = Bun.file(filePath)
    const exists = await file.exists()
    if (!exists) return undefined

    const stat = await file.stat()
    const fileSize = stat.size

    // For small files, load the entire content
    if (fileSize <= MAX_FULL_LOAD_SIZE) {
      const buffer = Buffer.from(await file.arrayBuffer())
      return { buffer, isSampled: false, fileSize }
    }

    // For large files, read a sample: beginning + middle + end
    log.info("file too large for full load, sampling", { filePath, fileSize, maxSize: MAX_FULL_LOAD_SIZE })

    const sampleChunkSize = Math.floor(SAMPLE_SIZE / 3)
    const fd = await fs.open(filePath, "r")

    try {
      // Read beginning
      const beginChunk = Buffer.alloc(sampleChunkSize)
      await fd.read(beginChunk, 0, sampleChunkSize, 0)

      // Read middle
      const middleOffset = Math.floor((fileSize - sampleChunkSize) / 2)
      const middleChunk = Buffer.alloc(sampleChunkSize)
      await fd.read(middleChunk, 0, sampleChunkSize, middleOffset)

      // Read end
      const endOffset = fileSize - sampleChunkSize
      const endChunk = Buffer.alloc(sampleChunkSize)
      await fd.read(endChunk, 0, sampleChunkSize, endOffset)

      // Combine with markers
      const marker = Buffer.from("\n\n... [CONTENT SAMPLED - FILE TOO LARGE] ...\n\n", "utf-8")
      const combined = Buffer.concat([beginChunk, marker, middleChunk, marker, endChunk])

      return { buffer: combined, isSampled: true, fileSize }
    } finally {
      await fd.close().catch(() => {})
    }
  }

  /**
   * Load only the header of a file for magic byte detection.
   */
  async function loadFileHeader(filePath: string): Promise<Buffer | undefined> {
    const file = Bun.file(filePath)
    const exists = await file.exists()
    if (!exists) return undefined

    const stat = await file.stat()
    const bytesToRead = Math.min(stat.size, MAGIC_DETECTION_SIZE)

    const fd = await fs.open(filePath, "r")
    try {
      const buffer = Buffer.alloc(bytesToRead)
      await fd.read(buffer, 0, bytesToRead, 0)
      return buffer
    } finally {
      await fd.close().catch(() => {})
    }
  }

  /**
   * Explore a file or content and produce a structured result.
   *
   * The dispatcher detects the file type and delegates to the appropriate explorer:
   * - SQLite files (.sqlite, .db, .sqlite3, or SQLite magic bytes) → SqliteExplorer
   * - PDF files (.pdf or PDF magic bytes) → PdfExplorer (falls back to FallbackExplorer)
   * - Text files (by extension or content detection) → TextExplorer
   * - Everything else → FallbackExplorer
   *
   * IMPORTANT: For files larger than 50MB, content is sampled rather than fully loaded
   * to prevent memory exhaustion crashes.
   */
  export async function explore(input: ExploreInput): Promise<DispatcherResult> {
    // Validate input
    if (!input.content && !input.filePath) {
      throw new Error("Either content or filePath must be provided")
    }

    let content: Buffer | undefined
    let fileType: ExplorerType | undefined
    let isSampled = false
    let fileSize = 0

    // Try to detect from extension first
    if (input.filePath) {
      fileType = detectTypeFromExtension(input.filePath)
      log.debug("type detection from extension", { filePath: input.filePath, detected: fileType })
    }

    // Try MIME type if no extension match
    if (!fileType && input.mimeType) {
      fileType = detectTypeFromMimeType(input.mimeType)
      log.debug("type detection from MIME", { mimeType: input.mimeType, detected: fileType })
    }

    // For magic byte detection, only load the header (not the full file)
    if (!fileType && input.filePath && !input.content) {
      const header = await loadFileHeader(input.filePath)
      if (header) {
        fileType = detectTypeFromContent(header)
        log.debug("type detection from magic bytes (header)", { detected: fileType })

        // If still unknown, check if header looks like text
        if (!fileType && looksLikeText(header)) {
          fileType = "text"
          log.debug("header content looks like text")
        }
      }
    }

    // Load content if provided directly
    if (input.content) {
      content = typeof input.content === "string" ? Buffer.from(input.content, "utf-8") : input.content
      fileSize = content.length
    } else if (input.filePath) {
      // Load file content (may be sampled for large files)
      const loaded = await loadFileContent(input.filePath)
      if (!loaded) {
        throw new Error(`File not found: ${input.filePath}`)
      }
      content = loaded.buffer
      isSampled = loaded.isSampled
      fileSize = loaded.fileSize
    }

    // Try content-based detection if still unknown (using whatever content we have)
    if (!fileType && content) {
      fileType = detectTypeFromContent(content)
      log.debug("type detection from content", { detected: fileType })

      // If still unknown, check if it looks like text
      if (!fileType && looksLikeText(content)) {
        fileType = "text"
        log.debug("content looks like text")
      }
    }

    // Default to fallback
    if (!fileType) {
      fileType = "fallback"
    }

    log.info("dispatching to explorer", {
      explorerType: fileType,
      filePath: input.filePath,
      hasContent: !!input.content,
      contentSize: content?.length,
      isSampled,
      fileSize,
    })

    // Dispatch to the appropriate explorer
    switch (fileType) {
      case "sqlite":
        // SQLite uses file path directly, doesn't need content in memory
        return exploreSqlite(input, content)

      case "pdf":
        // PDF uses file path for pdftotext, doesn't need full content
        return explorePdf(input, content!)

      case "json":
        return exploreJson(input, content!, isSampled)

      case "csv":
        return exploreCsv(input, content!, isSampled)

      case "yaml":
        return exploreYaml(input, content!, isSampled)

      case "toml":
        return exploreToml(input, content!, isSampled)

      case "ini":
        return exploreIni(input, content!, isSampled)

      case "xml":
        return exploreXml(input, content!, isSampled)

      case "html":
        return exploreHtml(input, content!, isSampled)

      case "log":
        return exploreLog(input, content!, isSampled)

      case "executable":
        return exploreExecutable(input)

      case "image":
        return exploreImage(input)

      case "python":
        return explorePython(input, content!, isSampled)

      case "latex":
        return exploreLatex(input, content!, isSampled)

      case "markdown":
        return exploreMarkdown(input, content!, isSampled)

      case "go":
        return exploreGo(input, content!, isSampled)

      case "rust":
        return exploreRust(input, content!, isSampled)

      case "typescript":
        return exploreTypeScript(input, content!, isSampled)

      case "javascript":
        return exploreJavaScript(input, content!, isSampled)

      case "css":
        return exploreCss(input, content!, isSampled)

      case "ruby":
        return exploreRuby(input, content!, isSampled)

      case "c":
        return exploreC(input, content!, isSampled)

      case "cpp":
        return exploreCpp(input, content!, isSampled)

      case "csharp":
        return exploreCSharp(input, content!, isSampled)

      case "java":
        return exploreJava(input, content!, isSampled)

      case "objc":
        return exploreObjC(input, content!, isSampled)

      case "swift":
        return exploreSwift(input, content!, isSampled)

      case "cuda":
        return exploreCuda(input, content!, isSampled)

      case "tcl":
        return exploreTcl(input, content!, isSampled)

      case "text":
        return exploreText(input, content!, isSampled, fileSize)

      default:
        return exploreFallback(input, content!)
    }
  }

  /**
   * Explore a SQLite database
   */
  async function exploreSqlite(
    input: ExploreInput,
    content?: Buffer,
  ): Promise<SqliteDispatcherResult | FallbackDispatcherResult> {
    // SqliteExplorer requires a file path
    if (!input.filePath) {
      // If we have content but no path, use fallback
      if (content) {
        log.warn("SQLite content provided without file path, using fallback")
        const result = await FallbackExplorer.explore({
          content,
          path: undefined,
          mimeType: "application/x-sqlite3",
        })
        return {
          explorerUsed: "fallback",
          summary: result.summary,
          metadata: result.metadata,
          tokenCount: result.tokenCount,
        }
      }
      throw new Error("SQLite exploration requires a file path")
    }

    const result = await SqliteExplorer.explore({ filePath: input.filePath })

    return {
      explorerUsed: "sqlite",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      indexes: result.indexes,
      error: result.error,
    }
  }

  /**
   * Explore a PDF file
   *
   * Uses PdfExplorer to extract text and analyze the PDF. Falls back to
   * FallbackExplorer if PdfExplorer fails (e.g., pdftotext not installed,
   * encrypted PDF, or image-only PDF).
   */
  async function explorePdf(input: ExploreInput, content: Buffer): Promise<PdfDispatcherResult> {
    // PdfExplorer requires a file path for pdftotext
    if (!input.filePath) {
      log.warn("PDF content provided without file path, using fallback")
      const result = await FallbackExplorer.explore({
        content,
        path: undefined,
        mimeType: input.mimeType ?? "application/pdf",
      })
      return {
        explorerUsed: "pdf",
        success: false,
        summary: result.summary,
        metadata: result.metadata,
        tokenCount: result.tokenCount,
        error: "PDF exploration requires a file path for text extraction",
      }
    }

    // Try PdfExplorer first
    try {
      const result = await PdfExplorer.explore({
        filePath: input.filePath,
        model: input.model,
        abort: input.abort,
      })

      if (result.success && result.summary && result.metadata && result.tokenCount !== undefined) {
        return {
          explorerUsed: "pdf",
          success: true,
          summary: result.summary,
          metadata: result.metadata,
          tokenCount: result.tokenCount,
          pagesExtracted: result.pagesExtracted,
        }
      }

      // PdfExplorer failed, fall back to FallbackExplorer
      log.warn("PdfExplorer failed, falling back", { error: result.error })
      const fallbackResult = await FallbackExplorer.explore({
        content,
        path: input.filePath,
        mimeType: input.mimeType ?? "application/pdf",
      })

      return {
        explorerUsed: "pdf",
        success: false,
        summary: fallbackResult.summary,
        metadata: fallbackResult.metadata,
        tokenCount: fallbackResult.tokenCount,
        error: result.error,
      }
    } catch (err) {
      // Unexpected error, fall back to FallbackExplorer
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("PdfExplorer threw an error, falling back", { error: errorMessage })

      const fallbackResult = await FallbackExplorer.explore({
        content,
        path: input.filePath,
        mimeType: input.mimeType ?? "application/pdf",
      })

      return {
        explorerUsed: "pdf",
        success: false,
        summary: fallbackResult.summary,
        metadata: fallbackResult.metadata,
        tokenCount: fallbackResult.tokenCount,
        error: errorMessage,
      }
    }
  }

  /**
   * Explore a text file
   */
  async function exploreText(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
    fileSize: number,
  ): Promise<TextDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await TextExplorer.explore({
      content: textContent,
      path: input.filePath,
      mimeType: input.mimeType,
      model: input.model,
      abort: input.abort,
      isSampled,
      originalFileSize: fileSize,
    })

    return {
      explorerUsed: "text",
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
    }
  }

  /**
   * Explore a file using the fallback explorer
   */
  async function exploreFallback(input: ExploreInput, content: Buffer): Promise<FallbackDispatcherResult> {
    const result = await FallbackExplorer.explore({
      content,
      path: input.filePath,
      mimeType: input.mimeType,
    })

    return {
      explorerUsed: "fallback",
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
    }
  }

  /**
   * Explore a JSON file
   */
  async function exploreJson(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<JsonDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, JSON parsing will likely fail - note this in the result
    if (isSampled) {
      return {
        explorerUsed: "json",
        success: false,
        summary: `Large JSON file (sampled). Content preview:\n\n${textContent.slice(0, 2000)}...`,
        metadata: { rootType: "object", maxDepth: 0, totalKeys: 0, totalArrayElements: 0, isMinified: false },
        tokenCount: Math.ceil(textContent.length / 4),
        error: "File too large for full JSON parsing - showing sample only",
      }
    }

    const result = await JsonExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    return {
      explorerUsed: "json",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a CSV file
   */
  async function exploreCsv(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<CsvDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, we can still try to parse what we have
    const result = await CsvExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large CSV File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "csv",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a YAML file
   */
  async function exploreYaml(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<YamlDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, YAML parsing will likely fail
    if (isSampled) {
      return {
        explorerUsed: "yaml",
        success: false,
        summary: `Large YAML file (sampled). Content preview:\n\n${textContent.slice(0, 2000)}...`,
        metadata: {
          rootType: "object",
          maxDepth: 0,
          totalKeys: 0,
          totalArrayElements: 0,
          hasMultipleDocuments: false,
          documentCount: 0,
        },
        tokenCount: Math.ceil(textContent.length / 4),
        error: "File too large for full YAML parsing - showing sample only",
      }
    }

    const result = await YamlExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    return {
      explorerUsed: "yaml",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a TOML file
   */
  async function exploreToml(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<TomlDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, TOML parsing will likely fail
    if (isSampled) {
      return {
        explorerUsed: "toml",
        success: false,
        summary: `Large TOML file (sampled). Content preview:\n\n${textContent.slice(0, 2000)}...`,
        metadata: { sectionCount: 0, totalKeys: 0, sections: [], maxDepth: 0 },
        tokenCount: Math.ceil(textContent.length / 4),
        error: "File too large for full TOML parsing - showing sample only",
      }
    }

    const result = await TomlExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    return {
      explorerUsed: "toml",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore an INI file
   */
  async function exploreIni(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<IniDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, INI parsing might partially work
    const result = await IniExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large INI File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "ini",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore an XML file
   */
  async function exploreXml(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<XmlDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, XML parsing will likely fail
    if (isSampled) {
      return {
        explorerUsed: "xml",
        success: false,
        summary: `Large XML file (sampled). Content preview:\n\n${textContent.slice(0, 2000)}...`,
        metadata: {
          rootElement: "unknown",
          totalElements: 0,
          maxDepth: 0,
          uniqueElements: [],
          namespaces: {},
          hasDeclaration: false,
        },
        tokenCount: Math.ceil(textContent.length / 4),
        error: "File too large for full XML parsing - showing sample only",
      }
    }

    const result = await XmlExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    return {
      explorerUsed: "xml",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore an HTML file
   */
  async function exploreHtml(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<HtmlDispatcherResult> {
    const textContent = content.toString("utf-8")

    // If sampled, HTML parsing might partially work
    const result = await HtmlExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large HTML File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "html",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a log file
   */
  async function exploreLog(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<LogDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await LogExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Log File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "log",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore an executable file
   */
  async function exploreExecutable(
    input: ExploreInput,
  ): Promise<ExecutableDispatcherResult | FallbackDispatcherResult> {
    // ExecutableExplorer requires a file path
    if (!input.filePath) {
      log.warn("executable content provided without file path, using fallback")
      const result = await FallbackExplorer.explore({
        content: Buffer.alloc(0),
        path: undefined,
        mimeType: "application/octet-stream",
      })
      return {
        explorerUsed: "fallback",
        summary: result.summary,
        metadata: result.metadata,
        tokenCount: result.tokenCount,
      }
    }

    const result = await ExecutableExplorer.explore({ filePath: input.filePath })

    return {
      explorerUsed: "executable",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore an image file
   */
  async function exploreImage(input: ExploreInput): Promise<ImageDispatcherResult | FallbackDispatcherResult> {
    // ImageExplorer requires a file path
    if (!input.filePath) {
      log.warn("image content provided without file path, using fallback")
      const result = await FallbackExplorer.explore({
        content: Buffer.alloc(0),
        path: undefined,
        mimeType: "image/unknown",
      })
      return {
        explorerUsed: "fallback",
        summary: result.summary,
        metadata: result.metadata,
        tokenCount: result.tokenCount,
      }
    }

    const result = await ImageExplorer.explore({ filePath: input.filePath })

    return {
      explorerUsed: "image",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Python file
   */
  async function explorePython(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<PythonDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await PythonExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Python File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "python",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a LaTeX file
   */
  async function exploreLatex(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<LatexDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await LatexExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large LaTeX File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "latex",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Markdown file
   */
  async function exploreMarkdown(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<MarkdownDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await MarkdownExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Markdown File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "markdown",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Go file
   */
  async function exploreGo(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<GoDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await GoExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Go File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "go",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Rust file
   */
  async function exploreRust(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<RustDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await RustExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Rust File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "rust",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a TypeScript file
   */
  async function exploreTypeScript(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<TypeScriptDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await TypeScriptExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large TypeScript File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "typescript",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a JavaScript file
   */
  async function exploreJavaScript(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<JavaScriptDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await JavaScriptExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large JavaScript File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "javascript",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a CSS file
   */
  async function exploreCss(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<CssDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await CssExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large CSS File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "css",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Ruby file
   */
  async function exploreRuby(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<RubyDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await RubyExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Ruby File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "ruby",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a C file
   */
  async function exploreC(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<CDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await CExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large C File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "c",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a C++ file
   */
  async function exploreCpp(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<CppDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await CppExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large C++ File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "cpp",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a C# file
   */
  async function exploreCSharp(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<CSharpDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await CSharpExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large C# File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "csharp",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Java file
   */
  async function exploreJava(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<JavaDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await JavaExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Java File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "java",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore an Objective-C file
   */
  async function exploreObjC(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<ObjCDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await ObjCExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Objective-C File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "objc",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Swift file
   */
  async function exploreSwift(
    input: ExploreInput,
    content: Buffer,
    isSampled: boolean,
  ): Promise<SwiftDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await SwiftExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Swift File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "swift",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a CUDA file
   */
  async function exploreCuda(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<CudaDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await CudaExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large CUDA File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "cuda",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }

  /**
   * Explore a Tcl file
   */
  async function exploreTcl(input: ExploreInput, content: Buffer, isSampled: boolean): Promise<TclDispatcherResult> {
    const textContent = content.toString("utf-8")

    const result = await TclExplorer.explore({
      content: textContent,
      filePath: input.filePath,
    })

    if (isSampled) {
      result.summary = `[SAMPLED - Large Tcl File]\n\n${result.summary}`
    }

    return {
      explorerUsed: "tcl",
      success: result.success,
      summary: result.summary,
      metadata: result.metadata,
      tokenCount: result.tokenCount,
      error: result.error,
    }
  }
}
