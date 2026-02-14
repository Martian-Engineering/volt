import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * Markdown File Exploration Agent
 *
 * Analyzes Markdown files (.md, .mdx, .markdown) and produces structured summaries
 * extracting frontmatter, heading structure, links, code blocks, and special elements.
 */
export namespace MarkdownExplorer {
  const log = Log.create({ service: "lcm.explore.markdown" })

  /**
   * Maximum number of items to show in lists
   */
  const MAX_ITEMS = 15

  /**
   * Maximum text length for samples
   */
  const MAX_TEXT_LENGTH = 80

  /**
   * Words per minute for reading time estimation
   */
  const WORDS_PER_MINUTE = 200

  /**
   * Frontmatter data extracted from YAML header
   */
  export interface FrontmatterData {
    /** Document title */
    title?: string
    /** Author name */
    author?: string
    /** Publication date */
    date?: string
    /** Tags or categories */
    tags?: string[]
    /** Description or excerpt */
    description?: string
    /** All other frontmatter keys */
    otherKeys: string[]
  }

  /**
   * Heading information
   */
  export interface HeadingInfo {
    level: number
    text: string
    line: number
  }

  /**
   * Heading structure counts
   */
  export interface HeadingCounts {
    h1: number
    h2: number
    h3: number
    h4: number
    h5: number
    h6: number
  }

  /**
   * Link information
   */
  export interface LinkInfo {
    text: string
    url: string
    type: "internal" | "external" | "anchor" | "image"
    line: number
  }

  /**
   * Code block information
   */
  export interface CodeBlockInfo {
    language?: string
    lineCount: number
    line: number
  }

  /**
   * Special element counts
   */
  export interface SpecialElements {
    tables: number
    taskLists: number
    taskListsChecked: number
    taskListsUnchecked: number
    footnotes: number
    mathBlocks: number
    mathInline: number
    blockquotes: number
    horizontalRules: number
  }

  /**
   * MDX-specific information
   */
  export interface MdxInfo {
    /** Whether this appears to be an MDX file */
    isMdx: boolean
    /** Imported components */
    imports: string[]
    /** JSX component usage */
    componentUsages: string[]
    /** Export statements */
    exports: string[]
  }

  /**
   * Metadata about the Markdown structure
   */
  export interface MarkdownMetadata {
    /** Whether frontmatter was found */
    hasFrontmatter: boolean
    /** Extracted frontmatter data */
    frontmatter: FrontmatterData
    /** Heading counts by level */
    headingCounts: HeadingCounts
    /** Total heading count */
    totalHeadings: number
    /** Number of internal links */
    internalLinkCount: number
    /** Number of external links */
    externalLinkCount: number
    /** Number of images */
    imageCount: number
    /** Number of code blocks */
    codeBlockCount: number
    /** Languages used in code blocks */
    codeLanguages: string[]
    /** Special elements */
    specialElements: SpecialElements
    /** MDX information */
    mdx: MdxInfo
    /** Word count (approximate) */
    wordCount: number
    /** Estimated reading time in minutes */
    readingTimeMinutes: number
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of Markdown exploration
   */
  export interface MarkdownExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the Markdown */
    metadata: MarkdownMetadata
    /** Table of contents (headings) */
    tableOfContents: HeadingInfo[]
    /** All links found */
    links: LinkInfo[]
    /** Code blocks found */
    codeBlocks: CodeBlockInfo[]
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Extract YAML frontmatter from content
   */
  function extractFrontmatter(content: string): { data: FrontmatterData; endIndex: number } | undefined {
    const lines = content.split("\n")
    if (lines[0]?.trim() !== "---") {
      return undefined
    }

    let endLine = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        endLine = i
        break
      }
    }

    if (endLine === -1) {
      return undefined
    }

    const frontmatterLines = lines.slice(1, endLine)
    const data: FrontmatterData = { otherKeys: [] }

    for (const line of frontmatterLines) {
      const colonIndex = line.indexOf(":")
      if (colonIndex === -1) continue

      const key = line.slice(0, colonIndex).trim().toLowerCase()
      const value = line.slice(colonIndex + 1).trim()

      switch (key) {
        case "title":
          data.title = value.replace(/^["']|["']$/g, "")
          break
        case "author":
          data.author = value.replace(/^["']|["']$/g, "")
          break
        case "date":
          data.date = value.replace(/^["']|["']$/g, "")
          break
        case "description":
        case "excerpt":
        case "summary":
          data.description = value.replace(/^["']|["']$/g, "")
          break
        case "tags":
        case "categories":
        case "keywords": {
          // Handle both inline array and multi-line
          if (value.startsWith("[")) {
            data.tags = value
              .slice(1, -1)
              .split(",")
              .map((t) => t.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean)
          } else if (value) {
            data.tags = [value.replace(/^["']|["']$/g, "")]
          }
          break
        }
        default:
          if (key && !data.otherKeys.includes(key)) {
            data.otherKeys.push(key)
          }
      }
    }

    // Calculate end index in the original string
    let endIndex = 0
    for (let i = 0; i <= endLine; i++) {
      endIndex += lines[i].length + 1 // +1 for newline
    }

    return { data, endIndex }
  }

  /**
   * Extract headings from content
   */
  function extractHeadings(content: string): HeadingInfo[] {
    const headings: HeadingInfo[] = []
    const lines = content.split("\n")

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const match = line.match(/^(#{1,6})\s+(.+)$/)
      if (match) {
        const text = match[2].replace(/\s*#{1,6}\s*$/, "").trim() // Remove trailing hashes
        headings.push({
          level: match[1].length,
          text: text.slice(0, MAX_TEXT_LENGTH) + (text.length > MAX_TEXT_LENGTH ? "..." : ""),
          line: i + 1,
        })
      }
    }

    return headings
  }

  /**
   * Count headings by level
   */
  function countHeadings(headings: HeadingInfo[]): HeadingCounts {
    const counts: HeadingCounts = { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 }
    for (const h of headings) {
      const key = `h${h.level}` as keyof HeadingCounts
      counts[key]++
    }
    return counts
  }

  /**
   * Extract links from content
   */
  function extractLinks(content: string): LinkInfo[] {
    const links: LinkInfo[] = []
    const lines = content.split("\n")

    // Standard markdown links: [text](url)
    const linkRegex = /(!?)\[([^\]]*)\]\(([^)]+)\)/g

    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum]
      let match

      while ((match = linkRegex.exec(line)) !== null) {
        const isImage = match[1] === "!"
        const text = match[2]
        const url = match[3].split(/\s+/)[0] // Remove title if present

        let type: LinkInfo["type"]
        if (isImage) {
          type = "image"
        } else if (url.startsWith("#")) {
          type = "anchor"
        } else if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) {
          type = "external"
        } else {
          type = "internal"
        }

        links.push({
          text: text.slice(0, MAX_TEXT_LENGTH) + (text.length > MAX_TEXT_LENGTH ? "..." : ""),
          url,
          type,
          line: lineNum + 1,
        })
      }
    }

    // Reference-style links: [text][ref] and [ref]: url
    const refLinkRegex = /\[([^\]]+)\]:\s*(\S+)/g
    for (let lineNum = 0; lineNum < lines.length; lineNum++) {
      const line = lines[lineNum]
      let match

      while ((match = refLinkRegex.exec(line)) !== null) {
        const url = match[2]
        let type: LinkInfo["type"]

        if (url.startsWith("#")) {
          type = "anchor"
        } else if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("//")) {
          type = "external"
        } else {
          type = "internal"
        }

        links.push({
          text: `[${match[1]}]`,
          url,
          type,
          line: lineNum + 1,
        })
      }
    }

    return links
  }

  /**
   * Extract code blocks from content
   */
  function extractCodeBlocks(content: string): CodeBlockInfo[] {
    const blocks: CodeBlockInfo[] = []
    const lines = content.split("\n")

    let inCodeBlock = false
    let currentBlock: CodeBlockInfo | null = null
    let codeLineCount = 0

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]

      if (line.startsWith("```") || line.startsWith("~~~")) {
        if (!inCodeBlock) {
          // Start of code block
          inCodeBlock = true
          const lang = line.slice(3).trim().split(/\s/)[0] || undefined
          currentBlock = { language: lang, lineCount: 0, line: i + 1 }
          codeLineCount = 0
        } else {
          // End of code block
          if (currentBlock) {
            currentBlock.lineCount = codeLineCount
            blocks.push(currentBlock)
          }
          inCodeBlock = false
          currentBlock = null
        }
      } else if (inCodeBlock) {
        codeLineCount++
      }
    }

    return blocks
  }

  /**
   * Detect special markdown elements
   */
  function detectSpecialElements(content: string): SpecialElements {
    const elements: SpecialElements = {
      tables: 0,
      taskLists: 0,
      taskListsChecked: 0,
      taskListsUnchecked: 0,
      footnotes: 0,
      mathBlocks: 0,
      mathInline: 0,
      blockquotes: 0,
      horizontalRules: 0,
    }

    const lines = content.split("\n")

    // Count tables (lines with | separators)
    let inTable = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.endsWith("|"))) {
        if (!inTable) {
          elements.tables++
          inTable = true
        }
      } else {
        inTable = false
      }
    }

    // Count task list items
    for (const line of lines) {
      if (/^\s*[-*+]\s+\[x\]/i.test(line)) {
        elements.taskListsChecked++
        elements.taskLists++
      } else if (/^\s*[-*+]\s+\[\s\]/.test(line)) {
        elements.taskListsUnchecked++
        elements.taskLists++
      }
    }

    // Count footnotes: [^name]:
    for (const line of lines) {
      if (/^\[\^[^\]]+\]:/.test(line.trim())) {
        elements.footnotes++
      }
    }

    // Count math blocks: $$ ... $$
    const mathBlockMatches = content.match(/\$\$[\s\S]*?\$\$/g)
    elements.mathBlocks = mathBlockMatches?.length ?? 0

    // Count inline math: $ ... $ (not $$)
    // This is a simple heuristic - may have false positives
    const inlineMathMatches = content.match(/(?<!\$)\$(?!\$)[^$\n]+\$(?!\$)/g)
    elements.mathInline = inlineMathMatches?.length ?? 0

    // Count blockquotes (lines starting with >)
    let inBlockquote = false
    for (const line of lines) {
      if (line.trim().startsWith(">")) {
        if (!inBlockquote) {
          elements.blockquotes++
          inBlockquote = true
        }
      } else if (line.trim() === "") {
        inBlockquote = false
      }
    }

    // Count horizontal rules
    for (const line of lines) {
      const trimmed = line.trim()
      if (/^[-*_]{3,}$/.test(trimmed.replace(/\s/g, ""))) {
        elements.horizontalRules++
      }
    }

    return elements
  }

  /**
   * Detect MDX-specific elements
   */
  function detectMdx(content: string): MdxInfo {
    const info: MdxInfo = {
      isMdx: false,
      imports: [],
      componentUsages: [],
      exports: [],
    }

    const lines = content.split("\n")

    // Check for import statements
    const importRegex = /^import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"]([^'"]+)['"]/
    for (const line of lines) {
      const match = line.match(importRegex)
      if (match) {
        info.isMdx = true
        const imported = match[1] ?? match[2]
        if (imported) {
          const components = imported.split(",").map((c) => c.trim())
          info.imports.push(...components)
        }
      }
    }

    // Check for export statements
    const exportRegex = /^export\s+(const|let|var|function|default)\s+(\w+)?/
    for (const line of lines) {
      const match = line.match(exportRegex)
      if (match) {
        info.isMdx = true
        if (match[2]) {
          info.exports.push(match[2])
        } else if (match[1] === "default") {
          info.exports.push("default")
        }
      }
    }

    // Check for JSX component usage: <ComponentName or <ComponentName>
    const jsxRegex = /<([A-Z][a-zA-Z0-9]*)/g
    let match
    while ((match = jsxRegex.exec(content)) !== null) {
      const componentName = match[1]
      if (!info.componentUsages.includes(componentName)) {
        info.isMdx = true
        info.componentUsages.push(componentName)
      }
    }

    return info
  }

  /**
   * Count words in content (excluding code blocks and frontmatter)
   */
  function countWords(content: string): number {
    // Remove code blocks
    let cleaned = content.replace(/```[\s\S]*?```/g, "")
    cleaned = cleaned.replace(/~~~[\s\S]*?~~~/g, "")

    // Remove inline code
    cleaned = cleaned.replace(/`[^`]+`/g, "")

    // Remove links (keep text)
    cleaned = cleaned.replace(/!?\[([^\]]*)\]\([^)]+\)/g, "$1")

    // Remove HTML tags
    cleaned = cleaned.replace(/<[^>]+>/g, "")

    // Count words
    const words = cleaned.split(/\s+/).filter((w) => w.length > 0)
    return words.length
  }

  /**
   * Input for exploring a Markdown file
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
   * Format the summary
   */
  function formatSummary(
    filePath: string,
    metadata: MarkdownMetadata,
    headings: HeadingInfo[],
    links: LinkInfo[],
    codeBlocks: CodeBlockInfo[],
  ): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: ${metadata.mdx.isMdx ? "MDX" : "Markdown"}`)
    lines.push("")

    // Document info
    if (metadata.frontmatter.title) {
      lines.push(`Title: ${metadata.frontmatter.title}`)
    }
    if (metadata.frontmatter.author) {
      lines.push(`Author: ${metadata.frontmatter.author}`)
    }
    if (metadata.frontmatter.date) {
      lines.push(`Date: ${metadata.frontmatter.date}`)
    }
    if (metadata.frontmatter.description) {
      const desc = metadata.frontmatter.description
      lines.push(`Description: ${desc.slice(0, 100)}${desc.length > 100 ? "..." : ""}`)
    }
    if (metadata.frontmatter.tags && metadata.frontmatter.tags.length > 0) {
      lines.push(`Tags: ${metadata.frontmatter.tags.join(", ")}`)
    }

    // Stats
    lines.push("")
    lines.push("Statistics:")
    lines.push(`- Words: ${metadata.wordCount.toLocaleString("en-US")}`)
    lines.push(`- Reading time: ~${metadata.readingTimeMinutes} min`)
    lines.push(`- Lines: ${metadata.lineCount.toLocaleString("en-US")}`)

    // Structure summary
    lines.push("")
    lines.push("Structure:")
    lines.push(`- Headings: ${metadata.totalHeadings}`)
    if (metadata.totalHeadings > 0) {
      const headingDetails: string[] = []
      const counts = metadata.headingCounts
      if (counts.h1) headingDetails.push(`H1: ${counts.h1}`)
      if (counts.h2) headingDetails.push(`H2: ${counts.h2}`)
      if (counts.h3) headingDetails.push(`H3: ${counts.h3}`)
      if (counts.h4) headingDetails.push(`H4: ${counts.h4}`)
      if (counts.h5) headingDetails.push(`H5: ${counts.h5}`)
      if (counts.h6) headingDetails.push(`H6: ${counts.h6}`)
      if (headingDetails.length > 0) {
        lines.push(`  (${headingDetails.join(", ")})`)
      }
    }

    const totalLinks = metadata.internalLinkCount + metadata.externalLinkCount
    lines.push(
      `- Links: ${totalLinks} (${metadata.internalLinkCount} internal, ${metadata.externalLinkCount} external)`,
    )
    if (metadata.imageCount > 0) {
      lines.push(`- Images: ${metadata.imageCount}`)
    }
    lines.push(`- Code blocks: ${metadata.codeBlockCount}`)
    if (metadata.codeLanguages.length > 0) {
      lines.push(`  Languages: ${metadata.codeLanguages.join(", ")}`)
    }

    // Special elements
    const special = metadata.specialElements
    const specialItems: string[] = []
    if (special.tables > 0) specialItems.push(`tables: ${special.tables}`)
    if (special.taskLists > 0) {
      specialItems.push(`task lists: ${special.taskLists} (${special.taskListsChecked} checked)`)
    }
    if (special.footnotes > 0) specialItems.push(`footnotes: ${special.footnotes}`)
    if (special.mathBlocks > 0 || special.mathInline > 0) {
      specialItems.push(`math: ${special.mathBlocks} blocks, ${special.mathInline} inline`)
    }
    if (special.blockquotes > 0) specialItems.push(`blockquotes: ${special.blockquotes}`)

    if (specialItems.length > 0) {
      lines.push("")
      lines.push("Special elements:")
      for (const item of specialItems) {
        lines.push(`  - ${item}`)
      }
    }

    // MDX info
    if (metadata.mdx.isMdx) {
      lines.push("")
      lines.push("MDX Components:")
      if (metadata.mdx.imports.length > 0) {
        lines.push(
          `  Imports: ${metadata.mdx.imports.slice(0, 10).join(", ")}${metadata.mdx.imports.length > 10 ? "..." : ""}`,
        )
      }
      if (metadata.mdx.componentUsages.length > 0) {
        lines.push(
          `  Used: ${metadata.mdx.componentUsages.slice(0, 10).join(", ")}${metadata.mdx.componentUsages.length > 10 ? "..." : ""}`,
        )
      }
      if (metadata.mdx.exports.length > 0) {
        lines.push(`  Exports: ${metadata.mdx.exports.join(", ")}`)
      }
    }

    // Table of contents
    if (headings.length > 0) {
      lines.push("")
      lines.push("Table of Contents:")
      for (const h of headings.slice(0, MAX_ITEMS)) {
        const indent = "  ".repeat(h.level - 1)
        lines.push(`${indent}${h.level}. ${h.text}`)
      }
      if (headings.length > MAX_ITEMS) {
        lines.push(`  ... and ${headings.length - MAX_ITEMS} more headings`)
      }
    }

    // Code blocks summary
    if (codeBlocks.length > 0) {
      lines.push("")
      lines.push("Code Blocks:")
      for (const block of codeBlocks.slice(0, 10)) {
        const lang = block.language ?? "plain"
        lines.push(`  - Line ${block.line}: ${lang} (${block.lineCount} lines)`)
      }
      if (codeBlocks.length > 10) {
        lines.push(`  ... and ${codeBlocks.length - 10} more code blocks`)
      }
    }

    // External links
    const externalLinks = links.filter((l) => l.type === "external")
    if (externalLinks.length > 0) {
      lines.push("")
      lines.push("External Links:")
      for (const link of externalLinks.slice(0, 10)) {
        const text = link.text || "(no text)"
        lines.push(`  - ${text}: ${link.url}`)
      }
      if (externalLinks.length > 10) {
        lines.push(`  ... and ${externalLinks.length - 10} more external links`)
      }
    }

    // Frontmatter other keys
    if (metadata.frontmatter.otherKeys.length > 0) {
      lines.push("")
      lines.push(`Frontmatter keys: ${metadata.frontmatter.otherKeys.join(", ")}`)
    }

    return lines.join("\n")
  }

  /**
   * Explore a Markdown file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<MarkdownExplorationResult> {
    const filePath = input.filePath ?? "unknown.md"
    log.info("exploring Markdown file", { filePath })

    try {
      const content = input.content
      const lines = content.split("\n")
      const lineCount = lines.length

      // Extract frontmatter
      const frontmatterResult = extractFrontmatter(content)
      const hasFrontmatter = frontmatterResult !== undefined
      const frontmatter = frontmatterResult?.data ?? { otherKeys: [] }

      // Get content after frontmatter for analysis
      const mainContent = frontmatterResult ? content.slice(frontmatterResult.endIndex) : content

      // Extract headings
      const headings = extractHeadings(mainContent)
      const headingCounts = countHeadings(headings)
      const totalHeadings = headings.length

      // Extract links
      const links = extractLinks(mainContent)
      const internalLinkCount = links.filter((l) => l.type === "internal").length
      const externalLinkCount = links.filter((l) => l.type === "external").length
      const imageCount = links.filter((l) => l.type === "image").length

      // Extract code blocks
      const codeBlocks = extractCodeBlocks(mainContent)
      const codeBlockCount = codeBlocks.length
      const codeLanguages = [...new Set(codeBlocks.map((b) => b.language).filter(Boolean) as string[])]

      // Detect special elements
      const specialElements = detectSpecialElements(mainContent)

      // Detect MDX
      const mdx = detectMdx(content)

      // Count words and calculate reading time
      const wordCount = countWords(mainContent)
      const readingTimeMinutes = Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE))

      const metadata: MarkdownMetadata = {
        hasFrontmatter,
        frontmatter,
        headingCounts,
        totalHeadings,
        internalLinkCount,
        externalLinkCount,
        imageCount,
        codeBlockCount,
        codeLanguages,
        specialElements,
        mdx,
        wordCount,
        readingTimeMinutes,
        lineCount,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        // Generate LLM-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(filePath, metadata, headings, links, codeBlocks)
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "Markdown",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        // Fall back to template-based summary
        summary = formatSummary(filePath, metadata, headings, links, codeBlocks)
        tokenCount = Token.estimate(summary)
      }

      log.info("Markdown exploration complete", {
        filePath,
        hasFrontmatter,
        totalHeadings,
        linkCount: links.length,
        codeBlockCount,
        wordCount,
        isMdx: mdx.isMdx,
        tokenCount,
        usedLLM: !!input.model,
      })

      return {
        success: true,
        summary,
        metadata,
        tableOfContents: headings,
        links,
        codeBlocks,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse Markdown", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          hasFrontmatter: false,
          frontmatter: { otherKeys: [] },
          headingCounts: { h1: 0, h2: 0, h3: 0, h4: 0, h5: 0, h6: 0 },
          totalHeadings: 0,
          internalLinkCount: 0,
          externalLinkCount: 0,
          imageCount: 0,
          codeBlockCount: 0,
          codeLanguages: [],
          specialElements: {
            tables: 0,
            taskLists: 0,
            taskListsChecked: 0,
            taskListsUnchecked: 0,
            footnotes: 0,
            mathBlocks: 0,
            mathInline: 0,
            blockquotes: 0,
            horizontalRules: 0,
          },
          mdx: { isMdx: false, imports: [], componentUsages: [], exports: [] },
          wordCount: 0,
          readingTimeMinutes: 0,
          lineCount: 0,
        },
        tableOfContents: [],
        links: [],
        codeBlocks: [],
        tokenCount: 0,
        error: `Failed to parse Markdown: ${errorMessage}`,
      }
    }
  }
}
