import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * HTML File Exploration Agent
 *
 * Analyzes HTML files and produces structured summaries extracting
 * title, headings, links, forms, and semantic structure.
 */
export namespace HtmlExplorer {
  const log = Log.create({ service: "lcm.explore.html" })

  /**
   * Maximum number of items to list in each category
   */
  const MAX_ITEMS = 10

  /**
   * Maximum text length for samples
   */
  const MAX_TEXT_LENGTH = 50

  /**
   * Heading information
   */
  export interface HeadingInfo {
    level: number
    text: string
  }

  /**
   * Link information
   */
  export interface LinkInfo {
    href: string
    text: string
    isExternal: boolean
  }

  /**
   * Form information
   */
  export interface FormInfo {
    action?: string
    method?: string
    inputs: string[]
  }

  /**
   * Semantic element counts
   */
  export interface SemanticInfo {
    header: number
    nav: number
    main: number
    article: number
    section: number
    aside: number
    footer: number
  }

  /**
   * Metadata about the HTML structure
   */
  export interface HtmlMetadata {
    /** Document title */
    title?: string
    /** Meta description */
    description?: string
    /** Charset */
    charset?: string
    /** Viewport meta */
    viewport?: string
    /** Language */
    lang?: string
    /** Number of headings */
    headingCount: number
    /** Number of links */
    linkCount: number
    /** Number of forms */
    formCount: number
    /** Number of images */
    imageCount: number
    /** Number of scripts */
    scriptCount: number
    /** Number of stylesheets */
    stylesheetCount: number
    /** Semantic element usage */
    semanticElements: SemanticInfo
  }

  /**
   * Result of HTML exploration
   */
  export interface HtmlExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the HTML */
    metadata: HtmlMetadata
    /** List of headings */
    headings: HeadingInfo[]
    /** List of links */
    links: LinkInfo[]
    /** List of forms */
    forms: FormInfo[]
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Extract text content from between tags (simplified)
   */
  function extractText(html: string): string {
    return html
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#\d+;/g, "")
      .replace(/\s+/g, " ")
      .trim()
  }

  /**
   * Get attribute value from a tag
   */
  function getAttr(tag: string, attrName: string): string | undefined {
    const regex = new RegExp(`${attrName}\\s*=\\s*["']([^"']*)["']`, "i")
    const match = tag.match(regex)
    return match?.[1]
  }

  /**
   * Extract title from HTML
   */
  function extractTitle(html: string): string | undefined {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    return match ? extractText(match[1]) : undefined
  }

  /**
   * Extract meta content
   */
  function extractMeta(html: string, name: string): string | undefined {
    const regex = new RegExp(`<meta[^>]*name\\s*=\\s*["']${name}["'][^>]*>`, "i")
    const match = html.match(regex)
    if (match) {
      return getAttr(match[0], "content")
    }
    // Also check for property attribute (for OpenGraph)
    const propRegex = new RegExp(`<meta[^>]*property\\s*=\\s*["']${name}["'][^>]*>`, "i")
    const propMatch = html.match(propRegex)
    if (propMatch) {
      return getAttr(propMatch[0], "content")
    }
    return undefined
  }

  /**
   * Extract charset
   */
  function extractCharset(html: string): string | undefined {
    // Check meta charset
    const charsetMatch = html.match(/<meta[^>]*charset\s*=\s*["']([^"']+)["']/i)
    if (charsetMatch) return charsetMatch[1]

    // Check http-equiv
    const httpEquivMatch = html.match(
      /<meta[^>]*http-equiv\s*=\s*["']Content-Type["'][^>]*content\s*=\s*["'][^"']*charset=([^"'\s;]+)/i,
    )
    if (httpEquivMatch) return httpEquivMatch[1]

    return undefined
  }

  /**
   * Extract language
   */
  function extractLang(html: string): string | undefined {
    const match = html.match(/<html[^>]*lang\s*=\s*["']([^"']+)["']/i)
    return match?.[1]
  }

  /**
   * Extract headings
   */
  function extractHeadings(html: string): HeadingInfo[] {
    const headings: HeadingInfo[] = []
    const regex = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi
    let match
    while ((match = regex.exec(html)) !== null) {
      const text = extractText(match[2])
      if (text) {
        headings.push({
          level: parseInt(match[1], 10),
          text: text.slice(0, MAX_TEXT_LENGTH) + (text.length > MAX_TEXT_LENGTH ? "..." : ""),
        })
      }
    }
    return headings
  }

  /**
   * Extract links
   */
  function extractLinks(html: string): LinkInfo[] {
    const links: LinkInfo[] = []
    const regex = /<a[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi
    let match
    while ((match = regex.exec(html)) !== null) {
      const href = match[1]
      const text = extractText(match[2])

      // Skip anchors and javascript
      if (href.startsWith("#") || href.startsWith("javascript:")) continue

      const isExternal = href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")

      links.push({
        href,
        text: text.slice(0, MAX_TEXT_LENGTH) + (text.length > MAX_TEXT_LENGTH ? "..." : ""),
        isExternal,
      })
    }
    return links
  }

  /**
   * Extract forms
   */
  function extractForms(html: string): FormInfo[] {
    const forms: FormInfo[] = []
    const formRegex = /<form[^>]*>([\s\S]*?)<\/form>/gi
    let match
    while ((match = formRegex.exec(html)) !== null) {
      const formTag = html.slice(match.index, match.index + match[0].indexOf(">") + 1)
      const formContent = match[1]

      const action = getAttr(formTag, "action")
      const method = getAttr(formTag, "method")

      // Extract input names
      const inputs: string[] = []
      const inputRegex = /<input[^>]*>/gi
      let inputMatch
      while ((inputMatch = inputRegex.exec(formContent)) !== null) {
        const name = getAttr(inputMatch[0], "name")
        const type = getAttr(inputMatch[0], "type") ?? "text"
        if (name) {
          inputs.push(`${name} (${type})`)
        }
      }

      // Extract select names
      const selectRegex = /<select[^>]*name\s*=\s*["']([^"']+)["']/gi
      let selectMatch
      while ((selectMatch = selectRegex.exec(formContent)) !== null) {
        inputs.push(`${selectMatch[1]} (select)`)
      }

      // Extract textarea names
      const textareaRegex = /<textarea[^>]*name\s*=\s*["']([^"']+)["']/gi
      let textareaMatch
      while ((textareaMatch = textareaRegex.exec(formContent)) !== null) {
        inputs.push(`${textareaMatch[1]} (textarea)`)
      }

      forms.push({ action, method, inputs })
    }
    return forms
  }

  /**
   * Count occurrences of a tag
   */
  function countTag(html: string, tagName: string): number {
    const regex = new RegExp(`<${tagName}[^>]*>`, "gi")
    return (html.match(regex) ?? []).length
  }

  /**
   * Extract semantic element counts
   */
  function extractSemanticInfo(html: string): SemanticInfo {
    return {
      header: countTag(html, "header"),
      nav: countTag(html, "nav"),
      main: countTag(html, "main"),
      article: countTag(html, "article"),
      section: countTag(html, "section"),
      aside: countTag(html, "aside"),
      footer: countTag(html, "footer"),
    }
  }

  /**
   * Format the HTML summary
   */
  function formatSummary(
    filePath: string,
    metadata: HtmlMetadata,
    headings: HeadingInfo[],
    links: LinkInfo[],
    forms: FormInfo[],
  ): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: HTML${metadata.lang ? ` (${metadata.lang})` : ""}`)
    lines.push("")

    // Document info
    if (metadata.title) {
      lines.push(`Title: ${metadata.title}`)
    }
    if (metadata.description) {
      lines.push(`Description: ${metadata.description.slice(0, 100)}${metadata.description.length > 100 ? "..." : ""}`)
    }

    // Structure summary
    lines.push("")
    lines.push("Structure:")
    lines.push(`- Headings: ${metadata.headingCount}`)
    lines.push(`- Links: ${metadata.linkCount} (${links.filter((l) => l.isExternal).length} external)`)
    lines.push(`- Forms: ${metadata.formCount}`)
    lines.push(`- Images: ${metadata.imageCount}`)
    lines.push(`- Scripts: ${metadata.scriptCount}`)
    lines.push(`- Stylesheets: ${metadata.stylesheetCount}`)

    // Semantic elements
    const semanticUsed = Object.entries(metadata.semanticElements).filter(([, count]) => count > 0)
    if (semanticUsed.length > 0) {
      lines.push("")
      lines.push("Semantic elements:")
      for (const [name, count] of semanticUsed) {
        lines.push(`  <${name}>: ${count}`)
      }
    }

    // Headings outline
    if (headings.length > 0) {
      lines.push("")
      lines.push("Heading outline:")
      for (const h of headings.slice(0, MAX_ITEMS)) {
        const indent = "  ".repeat(h.level - 1)
        lines.push(`${indent}H${h.level}: ${h.text}`)
      }
      if (headings.length > MAX_ITEMS) {
        lines.push(`  ... and ${headings.length - MAX_ITEMS} more headings`)
      }
    }

    // Forms
    if (forms.length > 0) {
      lines.push("")
      lines.push("Forms:")
      for (const form of forms.slice(0, 5)) {
        const actionStr = form.action ? ` action="${form.action}"` : ""
        const methodStr = form.method ? ` method="${form.method}"` : ""
        lines.push(`  <form${actionStr}${methodStr}>`)
        for (const input of form.inputs.slice(0, 5)) {
          lines.push(`    - ${input}`)
        }
        if (form.inputs.length > 5) {
          lines.push(`    ... and ${form.inputs.length - 5} more fields`)
        }
      }
      if (forms.length > 5) {
        lines.push(`  ... and ${forms.length - 5} more forms`)
      }
    }

    // Sample links
    const externalLinks = links.filter((l) => l.isExternal)
    if (externalLinks.length > 0) {
      lines.push("")
      lines.push("External links:")
      for (const link of externalLinks.slice(0, 5)) {
        const text = link.text || "(no text)"
        lines.push(`  - ${text}: ${link.href}`)
      }
      if (externalLinks.length > 5) {
        lines.push(`  ... and ${externalLinks.length - 5} more external links`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Explore an HTML file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<HtmlExplorationResult> {
    const filePath = input.filePath ?? "unknown.html"
    log.info("exploring HTML file", { filePath })

    try {
      const html = input.content

      // Extract metadata
      const title = extractTitle(html)
      const description = extractMeta(html, "description")
      const charset = extractCharset(html)
      const viewport = extractMeta(html, "viewport")
      const lang = extractLang(html)

      // Extract content
      const headings = extractHeadings(html)
      const links = extractLinks(html)
      const forms = extractForms(html)
      const semanticElements = extractSemanticInfo(html)

      // Count elements
      const imageCount = countTag(html, "img")
      const scriptCount = countTag(html, "script")
      const stylesheetCount = (html.match(/<link[^>]*rel\s*=\s*["']stylesheet["']/gi) ?? []).length

      const metadata: HtmlMetadata = {
        title,
        description,
        charset,
        viewport,
        lang,
        headingCount: headings.length,
        linkCount: links.length,
        formCount: forms.length,
        imageCount,
        scriptCount,
        stylesheetCount,
        semanticElements,
      }

      const summary = formatSummary(filePath, metadata, headings, links, forms)
      const tokenCount = Token.estimate(summary)

      log.info("HTML exploration complete", {
        filePath,
        title,
        headingCount: headings.length,
        linkCount: links.length,
        formCount: forms.length,
        tokenCount,
      })

      return {
        success: true,
        summary,
        metadata,
        headings,
        links,
        forms,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse HTML", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          headingCount: 0,
          linkCount: 0,
          formCount: 0,
          imageCount: 0,
          scriptCount: 0,
          stylesheetCount: 0,
          semanticElements: {
            header: 0,
            nav: 0,
            main: 0,
            article: 0,
            section: 0,
            aside: 0,
            footer: 0,
          },
        },
        headings: [],
        links: [],
        forms: [],
        tokenCount: 0,
        error: `Failed to parse HTML: ${errorMessage}`,
      }
    }
  }
}
