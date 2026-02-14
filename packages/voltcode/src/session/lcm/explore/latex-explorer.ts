import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * LaTeX File Exploration Agent
 *
 * Analyzes LaTeX files (.tex, .sty, .cls) and produces structured summaries
 * including document class, packages, structure, bibliography, custom commands,
 * included files, environments, and metadata.
 */
export namespace LatexExplorer {
  const log = Log.create({ service: "lcm.explore.latex" })

  /**
   * Maximum number of items to show in each category
   */
  const MAX_ITEMS_PER_CATEGORY = 20

  /**
   * Common packages that most LaTeX users know
   */
  const COMMON_PACKAGES = new Set([
    "amsmath",
    "amssymb",
    "amsthm",
    "graphicx",
    "geometry",
    "hyperref",
    "babel",
    "inputenc",
    "fontenc",
    "xcolor",
    "booktabs",
    "array",
    "tabularx",
    "longtable",
    "multirow",
    "caption",
    "subcaption",
    "float",
    "fancyhdr",
    "titlesec",
    "enumitem",
    "listings",
    "verbatim",
    "url",
    "cite",
    "natbib",
    "biblatex",
    "csquotes",
    "microtype",
    "setspace",
    "parskip",
    "tikz",
    "pgfplots",
    "algorithm",
    "algorithmicx",
    "algpseudocode",
    "cleveref",
    "siunitx",
    "mathtools",
    "bm",
    "textcomp",
    "lmodern",
    "times",
    "palatino",
    "helvet",
    "courier",
  ])

  /**
   * Document class information
   */
  export interface DocumentClass {
    name: string
    options: string[]
  }

  /**
   * Package information
   */
  export interface PackageInfo {
    name: string
    options: string[]
    isCommon: boolean
  }

  /**
   * Document structure counts
   */
  export interface StructureCounts {
    parts: number
    chapters: number
    sections: number
    subsections: number
    subsubsections: number
    paragraphs: number
  }

  /**
   * Custom command definition
   */
  export interface CustomCommand {
    name: string
    argCount?: number
    type: "newcommand" | "renewcommand" | "def" | "newenvironment" | "renewenvironment"
  }

  /**
   * Included file reference
   */
  export interface IncludedFile {
    path: string
    type: "input" | "include" | "subfile" | "subimport" | "import"
  }

  /**
   * Bibliography information
   */
  export interface BibliographyInfo {
    type: "bibtex" | "biblatex" | "thebibliography" | "none"
    files: string[]
    style?: string
  }

  /**
   * Document metadata
   */
  export interface DocumentInfo {
    title?: string
    author?: string
    date?: string
    abstract?: string
  }

  /**
   * Metadata about the LaTeX file
   */
  export interface LatexMetadata {
    /** Document class (article, book, report, beamer, etc.) */
    documentClass?: DocumentClass
    /** Packages used with categorization */
    packages: PackageInfo[]
    /** Document structure counts */
    structure: StructureCounts
    /** Bibliography information */
    bibliography: BibliographyInfo
    /** Custom command definitions */
    customCommands: CustomCommand[]
    /** Included files */
    includedFiles: IncludedFile[]
    /** Environments used */
    environments: string[]
    /** Document metadata (title, author, date) */
    documentInfo: DocumentInfo
    /** Whether this is a main document or a package/class file */
    fileType: "document" | "package" | "class" | "unknown"
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of LaTeX exploration
   */
  export interface LatexExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the LaTeX file */
    metadata: LatexMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Extract document class from content
   */
  function extractDocumentClass(content: string): DocumentClass | undefined {
    const match = content.match(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/)
    if (!match) return undefined

    const options = match[1]
      ? match[1]
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean)
      : []
    return {
      name: match[2].trim(),
      options,
    }
  }

  /**
   * Extract packages from content
   */
  function extractPackages(content: string): PackageInfo[] {
    const packages: PackageInfo[] = []
    const seen = new Set<string>()

    // Match \usepackage with optional options and potentially multiple packages
    const regex = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g
    let match

    while ((match = regex.exec(content)) !== null) {
      const options = match[1]
        ? match[1]
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : []
      const packageNames = match[2]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)

      for (const name of packageNames) {
        if (!seen.has(name)) {
          seen.add(name)
          packages.push({
            name,
            options: packageNames.length === 1 ? options : [], // Options only apply to single package
            isCommon: COMMON_PACKAGES.has(name),
          })
        }
      }
    }

    // Also check for \RequirePackage (used in .sty and .cls files)
    const requireRegex = /\\RequirePackage\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g
    while ((match = requireRegex.exec(content)) !== null) {
      const options = match[1]
        ? match[1]
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : []
      const packageNames = match[2]
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean)

      for (const name of packageNames) {
        if (!seen.has(name)) {
          seen.add(name)
          packages.push({
            name,
            options: packageNames.length === 1 ? options : [],
            isCommon: COMMON_PACKAGES.has(name),
          })
        }
      }
    }

    return packages
  }

  /**
   * Extract document structure counts
   */
  function extractStructure(content: string): StructureCounts {
    return {
      parts: (content.match(/\\part\s*(?:\*?\s*)?\{/g) || []).length,
      chapters: (content.match(/\\chapter\s*(?:\*?\s*)?\{/g) || []).length,
      sections: (content.match(/\\section\s*(?:\*?\s*)?\{/g) || []).length,
      subsections: (content.match(/\\subsection\s*(?:\*?\s*)?\{/g) || []).length,
      subsubsections: (content.match(/\\subsubsection\s*(?:\*?\s*)?\{/g) || []).length,
      paragraphs: (content.match(/\\paragraph\s*(?:\*?\s*)?\{/g) || []).length,
    }
  }

  /**
   * Extract bibliography information
   */
  function extractBibliography(content: string): BibliographyInfo {
    const files: string[] = []
    let type: BibliographyInfo["type"] = "none"
    let style: string | undefined

    // Check for biblatex
    if (content.includes("\\usepackage") && content.includes("biblatex")) {
      type = "biblatex"

      // Extract addbibresource
      const resourceRegex = /\\addbibresource\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g
      let match
      while ((match = resourceRegex.exec(content)) !== null) {
        files.push(match[2].trim())
      }

      // Extract biblatex style from package options
      const biblatexMatch = content.match(/\\usepackage\s*\[([^\]]*)\]\s*\{biblatex\}/)
      if (biblatexMatch) {
        const styleMatch = biblatexMatch[1].match(/style\s*=\s*([^,\]]+)/)
        if (styleMatch) style = styleMatch[1].trim()
      }
    }

    // Check for traditional bibtex
    const bibMatch = content.match(/\\bibliography\s*\{([^}]+)\}/)
    if (bibMatch) {
      type = "bibtex"
      files.push(...bibMatch[1].split(",").map((f) => f.trim()))

      const styleMatch = content.match(/\\bibliographystyle\s*\{([^}]+)\}/)
      if (styleMatch) style = styleMatch[1].trim()
    }

    // Check for thebibliography environment
    if (content.includes("\\begin{thebibliography}")) {
      type = "thebibliography"
    }

    return { type, files, style }
  }

  /**
   * Extract custom command definitions
   */
  function extractCustomCommands(content: string): CustomCommand[] {
    const commands: CustomCommand[] = []
    const seen = new Set<string>()

    // \newcommand{\name}[args]{...} or \newcommand*{\name}[args]{...}
    const newCmdRegex = /\\(newcommand|renewcommand)\*?\s*\{?\\([a-zA-Z@]+)\}?\s*(?:\[(\d+)\])?/g
    let match

    while ((match = newCmdRegex.exec(content)) !== null) {
      const name = match[2]
      if (!seen.has(name)) {
        seen.add(name)
        commands.push({
          name,
          argCount: match[3] ? parseInt(match[3], 10) : undefined,
          type: match[1] as "newcommand" | "renewcommand",
        })
      }
    }

    // \def\name{...}
    const defRegex = /\\def\\([a-zA-Z@]+)/g
    while ((match = defRegex.exec(content)) !== null) {
      const name = match[1]
      if (!seen.has(name)) {
        seen.add(name)
        commands.push({
          name,
          type: "def",
        })
      }
    }

    // \newenvironment{name}[args]{...}{...}
    const envRegex = /\\(newenvironment|renewenvironment)\s*\{([^}]+)\}\s*(?:\[(\d+)\])?/g
    while ((match = envRegex.exec(content)) !== null) {
      const name = match[2]
      if (!seen.has(name)) {
        seen.add(name)
        commands.push({
          name,
          argCount: match[3] ? parseInt(match[3], 10) : undefined,
          type: match[1] as "newenvironment" | "renewenvironment",
        })
      }
    }

    return commands
  }

  /**
   * Extract included files
   */
  function extractIncludedFiles(content: string): IncludedFile[] {
    const files: IncludedFile[] = []
    const seen = new Set<string>()

    const patterns: { regex: RegExp; type: IncludedFile["type"] }[] = [
      { regex: /\\input\s*\{([^}]+)\}/g, type: "input" },
      { regex: /\\include\s*\{([^}]+)\}/g, type: "include" },
      { regex: /\\subfile\s*\{([^}]+)\}/g, type: "subfile" },
      { regex: /\\subimport\s*\{[^}]*\}\s*\{([^}]+)\}/g, type: "subimport" },
      { regex: /\\import\s*\{[^}]*\}\s*\{([^}]+)\}/g, type: "import" },
    ]

    for (const { regex, type } of patterns) {
      let match
      while ((match = regex.exec(content)) !== null) {
        const path = match[1].trim()
        if (!seen.has(path)) {
          seen.add(path)
          files.push({ path, type })
        }
      }
    }

    return files
  }

  /**
   * Extract environments used
   */
  function extractEnvironments(content: string): string[] {
    const envs = new Set<string>()

    // Match \begin{environment}
    const regex = /\\begin\s*\{([^}]+)\}/g
    let match

    while ((match = regex.exec(content)) !== null) {
      envs.add(match[1].trim())
    }

    return Array.from(envs).sort()
  }

  /**
   * Extract document metadata (title, author, date)
   */
  function extractDocumentInfo(content: string): DocumentInfo {
    const info: DocumentInfo = {}

    // Extract title
    const titleMatch = content.match(/\\title\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/)
    if (titleMatch) {
      info.title = titleMatch[2].trim()
    }

    // Extract author
    const authorMatch = content.match(/\\author\s*\{([^}]+)\}/)
    if (authorMatch) {
      info.author = authorMatch[1].trim()
    }

    // Extract date
    const dateMatch = content.match(/\\date\s*\{([^}]+)\}/)
    if (dateMatch) {
      info.date = dateMatch[1].trim()
    }

    // Extract abstract (just note if present, don't include full text)
    if (content.includes("\\begin{abstract}")) {
      info.abstract = "[present]"
    }

    return info
  }

  /**
   * Determine file type from content and extension
   */
  function determineFileType(content: string, filePath?: string): LatexMetadata["fileType"] {
    // Check extension first
    if (filePath) {
      if (filePath.endsWith(".sty")) return "package"
      if (filePath.endsWith(".cls")) return "class"
    }

    // Check for package/class declarations
    if (content.includes("\\ProvidesPackage")) return "package"
    if (content.includes("\\ProvidesClass")) return "class"

    // Check for document class (indicates main document)
    if (content.includes("\\documentclass")) return "document"

    return "unknown"
  }

  /**
   * Format the LaTeX summary
   */
  function formatSummary(filePath: string, metadata: LatexMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Type: ${formatFileType(metadata.fileType)}`)
    lines.push("")

    // Document class
    if (metadata.documentClass) {
      const opts = metadata.documentClass.options.length > 0 ? ` [${metadata.documentClass.options.join(", ")}]` : ""
      lines.push(`Document Class: ${metadata.documentClass.name}${opts}`)
      lines.push("")
    }

    // Document info
    if (metadata.documentInfo.title || metadata.documentInfo.author || metadata.documentInfo.date) {
      lines.push("Document Info:")
      if (metadata.documentInfo.title) lines.push(`- Title: ${metadata.documentInfo.title}`)
      if (metadata.documentInfo.author) lines.push(`- Author: ${metadata.documentInfo.author}`)
      if (metadata.documentInfo.date) lines.push(`- Date: ${metadata.documentInfo.date}`)
      if (metadata.documentInfo.abstract) lines.push(`- Abstract: present`)
      lines.push("")
    }

    // Structure
    const struct = metadata.structure
    const structParts = []
    if (struct.parts > 0) structParts.push(`${struct.parts} parts`)
    if (struct.chapters > 0) structParts.push(`${struct.chapters} chapters`)
    if (struct.sections > 0) structParts.push(`${struct.sections} sections`)
    if (struct.subsections > 0) structParts.push(`${struct.subsections} subsections`)
    if (struct.subsubsections > 0) structParts.push(`${struct.subsubsections} subsubsections`)
    if (struct.paragraphs > 0) structParts.push(`${struct.paragraphs} paragraphs`)

    if (structParts.length > 0) {
      lines.push(`Structure: ${structParts.join(", ")}`)
      lines.push("")
    }

    // Packages
    if (metadata.packages.length > 0) {
      const commonPkgs = metadata.packages.filter((p) => p.isCommon)
      const specializedPkgs = metadata.packages.filter((p) => !p.isCommon)

      lines.push(`Packages (${metadata.packages.length} total):`)

      if (commonPkgs.length > 0) {
        const names = commonPkgs.slice(0, MAX_ITEMS_PER_CATEGORY).map((p) => p.name)
        lines.push(
          `- Common: ${names.join(", ")}${commonPkgs.length > MAX_ITEMS_PER_CATEGORY ? ` (+${commonPkgs.length - MAX_ITEMS_PER_CATEGORY} more)` : ""}`,
        )
      }

      if (specializedPkgs.length > 0) {
        const names = specializedPkgs.slice(0, MAX_ITEMS_PER_CATEGORY).map((p) => p.name)
        lines.push(
          `- Specialized: ${names.join(", ")}${specializedPkgs.length > MAX_ITEMS_PER_CATEGORY ? ` (+${specializedPkgs.length - MAX_ITEMS_PER_CATEGORY} more)` : ""}`,
        )
      }

      lines.push("")
    }

    // Bibliography
    if (metadata.bibliography.type !== "none") {
      lines.push(`Bibliography: ${formatBibType(metadata.bibliography.type)}`)
      if (metadata.bibliography.files.length > 0) {
        lines.push(`- Files: ${metadata.bibliography.files.join(", ")}`)
      }
      if (metadata.bibliography.style) {
        lines.push(`- Style: ${metadata.bibliography.style}`)
      }
      lines.push("")
    }

    // Custom commands
    if (metadata.customCommands.length > 0) {
      const cmdTypes = {
        newcommand: metadata.customCommands.filter((c) => c.type === "newcommand"),
        renewcommand: metadata.customCommands.filter((c) => c.type === "renewcommand"),
        def: metadata.customCommands.filter((c) => c.type === "def"),
        newenvironment: metadata.customCommands.filter((c) => c.type === "newenvironment"),
        renewenvironment: metadata.customCommands.filter((c) => c.type === "renewenvironment"),
      }

      lines.push(`Custom Definitions (${metadata.customCommands.length} total):`)

      if (cmdTypes.newcommand.length > 0) {
        const names = cmdTypes.newcommand.slice(0, 10).map((c) => `\\${c.name}`)
        lines.push(
          `- Commands: ${names.join(", ")}${cmdTypes.newcommand.length > 10 ? ` (+${cmdTypes.newcommand.length - 10} more)` : ""}`,
        )
      }

      if (cmdTypes.newenvironment.length > 0) {
        const names = cmdTypes.newenvironment.slice(0, 10).map((c) => c.name)
        lines.push(
          `- Environments: ${names.join(", ")}${cmdTypes.newenvironment.length > 10 ? ` (+${cmdTypes.newenvironment.length - 10} more)` : ""}`,
        )
      }

      if (cmdTypes.def.length > 0) {
        lines.push(`- \\def macros: ${cmdTypes.def.length}`)
      }

      lines.push("")
    }

    // Included files
    if (metadata.includedFiles.length > 0) {
      lines.push(`Included Files (${metadata.includedFiles.length}):`)
      for (const file of metadata.includedFiles.slice(0, MAX_ITEMS_PER_CATEGORY)) {
        lines.push(`- ${file.path} (${file.type})`)
      }
      if (metadata.includedFiles.length > MAX_ITEMS_PER_CATEGORY) {
        lines.push(`- ... and ${metadata.includedFiles.length - MAX_ITEMS_PER_CATEGORY} more`)
      }
      lines.push("")
    }

    // Environments
    if (metadata.environments.length > 0) {
      const envList = metadata.environments.slice(0, MAX_ITEMS_PER_CATEGORY)
      lines.push(`Environments Used (${metadata.environments.length}):`)
      lines.push(
        `  ${envList.join(", ")}${metadata.environments.length > MAX_ITEMS_PER_CATEGORY ? ` (+${metadata.environments.length - MAX_ITEMS_PER_CATEGORY} more)` : ""}`,
      )
      lines.push("")
    }

    // Line count
    lines.push(`Total Lines: ${metadata.lineCount.toLocaleString("en-US")}`)

    return lines.join("\n")
  }

  /**
   * Format file type for display
   */
  function formatFileType(type: LatexMetadata["fileType"]): string {
    switch (type) {
      case "document":
        return "LaTeX Document"
      case "package":
        return "LaTeX Package (.sty)"
      case "class":
        return "LaTeX Class (.cls)"
      default:
        return "LaTeX File"
    }
  }

  /**
   * Format bibliography type for display
   */
  function formatBibType(type: BibliographyInfo["type"]): string {
    switch (type) {
      case "bibtex":
        return "BibTeX"
      case "biblatex":
        return "BibLaTeX"
      case "thebibliography":
        return "Manual (thebibliography)"
      default:
        return "None"
    }
  }

  /**
   * Input for exploring a LaTeX file
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
   * Explore a LaTeX file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<LatexExplorationResult> {
    const filePath = input.filePath ?? "unknown.tex"
    log.info("exploring LaTeX file", { filePath })

    try {
      const content = input.content
      const lines = content.split("\n")
      const lineCount = lines.length

      if (lineCount === 0 || content.trim() === "") {
        return {
          success: true,
          summary: `File: ${filePath.split("/").pop()}\nType: LaTeX File\nEmpty file`,
          metadata: {
            packages: [],
            structure: { parts: 0, chapters: 0, sections: 0, subsections: 0, subsubsections: 0, paragraphs: 0 },
            bibliography: { type: "none", files: [] },
            customCommands: [],
            includedFiles: [],
            environments: [],
            documentInfo: {},
            fileType: "unknown",
            lineCount: 0,
          },
          tokenCount: 10,
        }
      }

      // Extract all metadata
      const documentClass = extractDocumentClass(content)
      const packages = extractPackages(content)
      const structure = extractStructure(content)
      const bibliography = extractBibliography(content)
      const customCommands = extractCustomCommands(content)
      const includedFiles = extractIncludedFiles(content)
      const environments = extractEnvironments(content)
      const documentInfo = extractDocumentInfo(content)
      const fileType = determineFileType(content, filePath)

      const metadata: LatexMetadata = {
        documentClass,
        packages,
        structure,
        bibliography,
        customCommands,
        includedFiles,
        environments,
        documentInfo,
        fileType,
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
          language: "LaTeX",
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

      log.info("LaTeX exploration complete", {
        filePath,
        fileType,
        packageCount: packages.length,
        lineCount,
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
      log.error("failed to parse LaTeX file", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          packages: [],
          structure: { parts: 0, chapters: 0, sections: 0, subsections: 0, subsubsections: 0, paragraphs: 0 },
          bibliography: { type: "none", files: [] },
          customCommands: [],
          includedFiles: [],
          environments: [],
          documentInfo: {},
          fileType: "unknown",
          lineCount: 0,
        },
        tokenCount: 0,
        error: `Failed to parse LaTeX file: ${errorMessage}`,
      }
    }
  }
}
