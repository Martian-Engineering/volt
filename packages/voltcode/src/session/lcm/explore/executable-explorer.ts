import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { $ } from "bun"

/**
 * Executable File Exploration Agent
 *
 * Analyzes executable and binary files using system tools (file, nm, strings, otool/objdump)
 * to extract metadata about the binary including architecture, dependencies, symbols, and more.
 */
export namespace ExecutableExplorer {
  const log = Log.create({ service: "lcm.explore.executable" })

  /**
   * Maximum number of symbols to include
   */
  const MAX_SYMBOLS = 50

  /**
   * Maximum number of strings to include
   */
  const MAX_STRINGS = 30

  /**
   * Maximum string length
   */
  const MAX_STRING_LENGTH = 100

  /**
   * Minimum string length to include (filters noise)
   */
  const MIN_STRING_LENGTH = 6

  /**
   * Executable type
   */
  export type ExecutableType =
    | "elf"
    | "mach-o"
    | "pe"
    | "script"
    | "java_class"
    | "wasm"
    | "archive"
    | "shared_library"
    | "unknown"

  /**
   * Architecture information
   */
  export interface ArchInfo {
    arch: string
    bits?: number
    endian?: "little" | "big"
  }

  /**
   * Symbol information
   */
  export interface SymbolInfo {
    name: string
    type: string
  }

  /**
   * Metadata about the executable
   */
  export interface ExecutableMetadata {
    /** File type description from `file` command */
    fileType: string
    /** Detected executable format */
    format: ExecutableType
    /** Architecture info */
    arch?: ArchInfo
    /** File size in bytes */
    sizeBytes: number
    /** Whether the file is stripped */
    stripped?: boolean
    /** Whether it's statically linked */
    staticLinked?: boolean
    /** Shared library dependencies */
    dependencies: string[]
    /** Exported/defined symbols (sample) */
    exportedSymbols: SymbolInfo[]
    /** Imported/undefined symbols (sample) */
    importedSymbols: SymbolInfo[]
    /** Interesting strings found */
    strings: string[]
    /** Section names (for ELF/Mach-O) */
    sections: string[]
  }

  /**
   * Result of executable exploration
   */
  export interface ExecutableExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the executable */
    metadata: ExecutableMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Run a shell command and return stdout, or empty string on error
   */
  async function runCommand(cmd: string[]): Promise<string> {
    try {
      const result = await $`${cmd}`.quiet().text()
      return result.trim()
    } catch {
      return ""
    }
  }

  /**
   * Get file type using the `file` command
   */
  async function getFileType(filePath: string): Promise<string> {
    return runCommand(["file", "-b", filePath])
  }

  /**
   * Detect executable format from file type string
   */
  function detectFormat(fileType: string): ExecutableType {
    const lower = fileType.toLowerCase()

    if (lower.includes("elf")) return "elf"
    if (lower.includes("mach-o") || lower.includes("macho")) return "mach-o"
    if (lower.includes("pe32") || lower.includes("windows") || lower.includes(".exe")) return "pe"
    if (lower.includes("script") || lower.includes("text executable")) return "script"
    if (lower.includes("java class")) return "java_class"
    if (lower.includes("webassembly") || lower.includes("wasm")) return "wasm"
    if (lower.includes("archive") || lower.includes(".a")) return "archive"
    if (lower.includes("shared object") || lower.includes("dynamically linked")) return "shared_library"

    return "unknown"
  }

  /**
   * Parse architecture from file type
   */
  function parseArch(fileType: string): ArchInfo | undefined {
    const lower = fileType.toLowerCase()

    let arch = "unknown"
    let bits: number | undefined
    let endian: "little" | "big" | undefined

    // Detect architecture
    if (lower.includes("x86-64") || lower.includes("x86_64") || lower.includes("amd64")) {
      arch = "x86_64"
      bits = 64
    } else if (lower.includes("x86") || lower.includes("i386") || lower.includes("i686")) {
      arch = "x86"
      bits = 32
    } else if (lower.includes("arm64") || lower.includes("aarch64")) {
      arch = "arm64"
      bits = 64
    } else if (lower.includes("arm")) {
      arch = "arm"
      bits = 32
    } else if (lower.includes("riscv64")) {
      arch = "riscv64"
      bits = 64
    } else if (lower.includes("riscv")) {
      arch = "riscv"
      bits = 32
    } else if (lower.includes("mips64")) {
      arch = "mips64"
      bits = 64
    } else if (lower.includes("mips")) {
      arch = "mips"
      bits = 32
    } else if (lower.includes("powerpc64") || lower.includes("ppc64")) {
      arch = "ppc64"
      bits = 64
    } else if (lower.includes("powerpc") || lower.includes("ppc")) {
      arch = "ppc"
      bits = 32
    }

    // Detect endianness
    if (lower.includes("lsb") || lower.includes("little-endian") || lower.includes("little endian")) {
      endian = "little"
    } else if (lower.includes("msb") || lower.includes("big-endian") || lower.includes("big endian")) {
      endian = "big"
    }

    // 64-bit from description
    if (lower.includes("64-bit")) bits = 64
    if (lower.includes("32-bit")) bits = 32

    if (arch === "unknown") return undefined

    return { arch, bits, endian }
  }

  /**
   * Get shared library dependencies
   */
  async function getDependencies(filePath: string, format: ExecutableType): Promise<string[]> {
    let output = ""

    switch (format) {
      case "elf":
      case "shared_library":
        // Linux: use ldd or readelf
        output = await runCommand(["ldd", filePath])
        if (!output) {
          output = await runCommand(["readelf", "-d", filePath])
        }
        break

      case "mach-o":
        // macOS: use otool
        output = await runCommand(["otool", "-L", filePath])
        break

      case "pe":
        // Windows: would need objdump or similar
        output = await runCommand(["objdump", "-p", filePath])
        break
    }

    if (!output) return []

    // Parse dependencies from output
    const deps: string[] = []
    const lines = output.split("\n")

    for (const line of lines) {
      // ldd format: libfoo.so => /path/to/libfoo.so (0x...)
      const lddMatch = line.match(/^\s*(\S+\.so[\d.]*)\s*=>/)
      if (lddMatch) {
        deps.push(lddMatch[1])
        continue
      }

      // otool format: /path/to/lib.dylib (...)
      const otoolMatch = line.match(/^\s+(\S+\.dylib|\S+\.framework\S*)/)
      if (otoolMatch && !otoolMatch[1].includes(filePath)) {
        deps.push(otoolMatch[1].split("/").pop() ?? otoolMatch[1])
        continue
      }

      // NEEDED entries from readelf
      const neededMatch = line.match(/NEEDED.*\[(.*)\]/)
      if (neededMatch) {
        deps.push(neededMatch[1])
      }
    }

    return [...new Set(deps)].slice(0, 20)
  }

  /**
   * Get symbols from the binary
   */
  async function getSymbols(
    filePath: string,
    format: ExecutableType,
  ): Promise<{ exported: SymbolInfo[]; imported: SymbolInfo[] }> {
    let output = ""

    // Try nm first (works on most Unix-like systems)
    output = await runCommand(["nm", "-g", filePath])

    if (!output && format === "mach-o") {
      output = await runCommand(["nm", filePath])
    }

    if (!output) {
      return { exported: [], imported: [] }
    }

    const exported: SymbolInfo[] = []
    const imported: SymbolInfo[] = []
    const lines = output.split("\n")

    for (const line of lines) {
      // nm format: address type name
      const match = line.match(/^[\da-f]*\s*([A-Za-z])\s+(.+)$/i)
      if (!match) continue

      const [, type, name] = match
      // Skip internal/compiler symbols
      if (name.startsWith("_GLOBAL_") || name.startsWith("__") || name.includes("@@")) continue

      const symbolInfo = { name: name.slice(0, 100), type }

      // Uppercase = exported/defined, lowercase = imported/undefined
      if (type === type.toUpperCase() && type !== "U") {
        if (exported.length < MAX_SYMBOLS) {
          exported.push(symbolInfo)
        }
      } else if (type === "U" || type === "u") {
        if (imported.length < MAX_SYMBOLS) {
          imported.push(symbolInfo)
        }
      }
    }

    return { exported, imported }
  }

  /**
   * Get interesting strings from the binary
   */
  async function getStrings(filePath: string): Promise<string[]> {
    const output = await runCommand(["strings", "-n", String(MIN_STRING_LENGTH), filePath])
    if (!output) return []

    const lines = output.split("\n")
    const interesting: string[] = []

    // Patterns for interesting strings
    const interestingPatterns = [
      /^https?:\/\//, // URLs
      /^\/[\w/]+/, // Unix paths
      /\.(com|org|net|io)/, // Domains
      /error|warning|fatal|panic/i, // Error messages
      /version|copyright|license/i, // Version info
      /password|secret|key|token/i, // Security-related
      /^\w+\(\)$/, // Function names
      /^[A-Z_]{4,}$/, // Constants
    ]

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length < MIN_STRING_LENGTH || trimmed.length > MAX_STRING_LENGTH) continue

      // Check if it matches any interesting pattern
      for (const pattern of interestingPatterns) {
        if (pattern.test(trimmed)) {
          interesting.push(trimmed)
          break
        }
      }

      if (interesting.length >= MAX_STRINGS) break
    }

    return interesting
  }

  /**
   * Get section names
   */
  async function getSections(filePath: string, format: ExecutableType): Promise<string[]> {
    let output = ""

    switch (format) {
      case "elf":
      case "shared_library":
        output = await runCommand(["readelf", "-S", filePath])
        break
      case "mach-o":
        output = await runCommand(["otool", "-l", filePath])
        break
    }

    if (!output) return []

    const sections: string[] = []

    if (format === "elf" || format === "shared_library") {
      // Parse readelf output
      const matches = output.matchAll(/\[\s*\d+\]\s+(\.\w+)/g)
      for (const match of matches) {
        sections.push(match[1])
      }
    } else if (format === "mach-o") {
      // Parse otool output
      const matches = output.matchAll(/sectname\s+(\S+)/g)
      for (const match of matches) {
        sections.push(match[1])
      }
    }

    return [...new Set(sections)].slice(0, 20)
  }

  /**
   * Format the executable summary
   */
  function formatSummary(filePath: string, metadata: ExecutableMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Type: ${metadata.fileType}`)
    lines.push(`Format: ${formatFormatName(metadata.format)}`)
    lines.push(`Size: ${formatSize(metadata.sizeBytes)}`)

    if (metadata.arch) {
      const archStr = [
        metadata.arch.arch,
        metadata.arch.bits ? `${metadata.arch.bits}-bit` : "",
        metadata.arch.endian ? metadata.arch.endian : "",
      ]
        .filter(Boolean)
        .join(", ")
      lines.push(`Architecture: ${archStr}`)
    }

    if (metadata.stripped !== undefined) {
      lines.push(`Stripped: ${metadata.stripped ? "yes" : "no"}`)
    }

    if (metadata.staticLinked !== undefined) {
      lines.push(`Linking: ${metadata.staticLinked ? "static" : "dynamic"}`)
    }

    if (metadata.sections.length > 0) {
      lines.push("")
      lines.push(`Sections (${metadata.sections.length}):`)
      lines.push(`  ${metadata.sections.join(", ")}`)
    }

    if (metadata.dependencies.length > 0) {
      lines.push("")
      lines.push(`Dependencies (${metadata.dependencies.length}):`)
      for (const dep of metadata.dependencies.slice(0, 15)) {
        lines.push(`  - ${dep}`)
      }
      if (metadata.dependencies.length > 15) {
        lines.push(`  ... and ${metadata.dependencies.length - 15} more`)
      }
    }

    if (metadata.exportedSymbols.length > 0) {
      lines.push("")
      lines.push(`Exported Symbols (sample of ${metadata.exportedSymbols.length}):`)
      for (const sym of metadata.exportedSymbols.slice(0, 20)) {
        lines.push(`  - ${sym.name}`)
      }
    }

    if (metadata.importedSymbols.length > 0) {
      lines.push("")
      lines.push(`Imported Symbols (sample of ${metadata.importedSymbols.length}):`)
      for (const sym of metadata.importedSymbols.slice(0, 20)) {
        lines.push(`  - ${sym.name}`)
      }
    }

    if (metadata.strings.length > 0) {
      lines.push("")
      lines.push(`Interesting Strings (${metadata.strings.length}):`)
      for (const str of metadata.strings) {
        lines.push(`  "${str}"`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Get human-readable format name
   */
  function formatFormatName(format: ExecutableType): string {
    switch (format) {
      case "elf":
        return "ELF (Executable and Linkable Format)"
      case "mach-o":
        return "Mach-O (macOS/iOS)"
      case "pe":
        return "PE (Windows Portable Executable)"
      case "script":
        return "Script/Interpreted"
      case "java_class":
        return "Java Class File"
      case "wasm":
        return "WebAssembly"
      case "archive":
        return "Static Archive"
      case "shared_library":
        return "Shared Library"
      default:
        return "Unknown Binary"
    }
  }

  /**
   * Format file size
   */
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /**
   * Explore an executable file and produce a structured summary.
   */
  export async function explore(input: { filePath: string }): Promise<ExecutableExplorationResult> {
    log.info("exploring executable file", { filePath: input.filePath })

    // Check if file exists
    const file = Bun.file(input.filePath)
    const exists = await file.exists()
    if (!exists) {
      log.warn("executable file not found", { filePath: input.filePath })
      return createErrorResult(`File not found: ${input.filePath}`)
    }

    try {
      const stat = await file.stat()
      const fileType = await getFileType(input.filePath)
      const format = detectFormat(fileType)
      const arch = parseArch(fileType)

      // Detect if stripped
      const stripped = fileType.toLowerCase().includes("stripped")
      const staticLinked = fileType.toLowerCase().includes("statically linked")

      // Get additional info
      const dependencies = await getDependencies(input.filePath, format)
      const { exported, imported } = await getSymbols(input.filePath, format)
      const strings = await getStrings(input.filePath)
      const sections = await getSections(input.filePath, format)

      const metadata: ExecutableMetadata = {
        fileType,
        format,
        arch,
        sizeBytes: stat.size,
        stripped,
        staticLinked,
        dependencies,
        exportedSymbols: exported,
        importedSymbols: imported,
        strings,
        sections,
      }

      const summary = formatSummary(input.filePath, metadata)
      const tokenCount = Token.estimate(summary)

      log.info("executable exploration complete", {
        filePath: input.filePath,
        format,
        arch: arch?.arch,
        tokenCount,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to explore executable", { filePath: input.filePath, error: errorMessage })
      return createErrorResult(`Failed to explore executable: ${errorMessage}`)
    }
  }

  /**
   * Create an error result
   */
  function createErrorResult(error: string): ExecutableExplorationResult {
    return {
      success: false,
      summary: "",
      metadata: {
        fileType: "",
        format: "unknown",
        sizeBytes: 0,
        dependencies: [],
        exportedSymbols: [],
        importedSymbols: [],
        strings: [],
        sections: [],
      },
      tokenCount: 0,
      error,
    }
  }
}
