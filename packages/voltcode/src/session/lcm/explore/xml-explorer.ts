import { Log } from "@/util/log"
import { Token } from "@/util/token"

/**
 * XML File Exploration Agent
 *
 * Analyzes XML files and produces structured summaries showing
 * element hierarchy, attributes, and namespaces.
 */
export namespace XmlExplorer {
  const log = Log.create({ service: "lcm.explore.xml" })

  /**
   * Maximum depth to analyze
   */
  const MAX_DEPTH = 10

  /**
   * Maximum text content length to show
   */
  const MAX_TEXT_LENGTH = 50

  /**
   * Element information
   */
  export interface ElementInfo {
    name: string
    namespace?: string
    attributes: Record<string, string>
    childElements: string[]
    childCount: number
    hasText: boolean
    textSample?: string
  }

  /**
   * Metadata about the XML structure
   */
  export interface XmlMetadata {
    /** Root element name */
    rootElement: string
    /** Total number of elements */
    totalElements: number
    /** Maximum nesting depth */
    maxDepth: number
    /** Unique element names */
    uniqueElements: string[]
    /** Namespaces used */
    namespaces: Record<string, string>
    /** Whether the XML has a declaration */
    hasDeclaration: boolean
    /** XML version if declared */
    version?: string
    /** Encoding if declared */
    encoding?: string
  }

  /**
   * Result of XML exploration
   */
  export interface XmlExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the XML */
    metadata: XmlMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Simple XML element representation
   */
  interface XmlNode {
    type: "element" | "text" | "comment" | "cdata"
    name?: string
    attributes?: Record<string, string>
    children?: XmlNode[]
    content?: string
  }

  /**
   * Parse XML into a simple tree structure
   * This is a basic parser for exploration purposes
   */
  function parseXml(content: string): {
    root: XmlNode | null
    declaration: { version?: string; encoding?: string } | null
  } {
    let declaration: { version?: string; encoding?: string } | null = null
    let remaining = content.trim()

    // Check for XML declaration
    const declMatch = remaining.match(/^<\?xml\s+([^?]*)\?>/)
    if (declMatch) {
      const declContent = declMatch[1]
      const versionMatch = declContent.match(/version\s*=\s*["']([^"']+)["']/)
      const encodingMatch = declContent.match(/encoding\s*=\s*["']([^"']+)["']/)
      declaration = {
        version: versionMatch?.[1],
        encoding: encodingMatch?.[1],
      }
      remaining = remaining.slice(declMatch[0].length).trim()
    }

    // Skip DOCTYPE
    const doctypeMatch = remaining.match(/^<!DOCTYPE[^>]*>/)
    if (doctypeMatch) {
      remaining = remaining.slice(doctypeMatch[0].length).trim()
    }

    // Parse root element
    const root = parseElement(remaining)
    return { root: root.node, declaration }
  }

  /**
   * Parse a single element and its children
   */
  function parseElement(content: string, depth: number = 0): { node: XmlNode | null; remaining: string } {
    const trimmed = content.trim()

    // Skip comments
    if (trimmed.startsWith("<!--")) {
      const endIdx = trimmed.indexOf("-->")
      if (endIdx === -1) return { node: null, remaining: "" }
      return { node: null, remaining: trimmed.slice(endIdx + 3).trim() }
    }

    // Skip CDATA
    if (trimmed.startsWith("<![CDATA[")) {
      const endIdx = trimmed.indexOf("]]>")
      if (endIdx === -1) return { node: null, remaining: "" }
      return {
        node: { type: "cdata", content: trimmed.slice(9, endIdx) },
        remaining: trimmed.slice(endIdx + 3).trim(),
      }
    }

    // Check for opening tag
    const tagMatch = trimmed.match(/^<([a-zA-Z_][\w:.-]*)([^>]*?)(\/?)>/)
    if (!tagMatch) {
      // Text content
      const nextTagIdx = trimmed.indexOf("<")
      if (nextTagIdx === -1) {
        return { node: { type: "text", content: trimmed }, remaining: "" }
      }
      const textContent = trimmed.slice(0, nextTagIdx).trim()
      if (textContent) {
        return { node: { type: "text", content: textContent }, remaining: trimmed.slice(nextTagIdx) }
      }
      return { node: null, remaining: trimmed }
    }

    const tagName = tagMatch[1]
    const attrString = tagMatch[2].trim()
    const selfClosing = tagMatch[3] === "/"

    // Parse attributes
    const attributes: Record<string, string> = {}
    const attrRegex = /([a-zA-Z_][\w:.-]*)\s*=\s*["']([^"']*)["']/g
    let attrMatch
    while ((attrMatch = attrRegex.exec(attrString)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2]
    }

    const node: XmlNode = {
      type: "element",
      name: tagName,
      attributes,
      children: [],
    }

    if (selfClosing) {
      return { node, remaining: trimmed.slice(tagMatch[0].length).trim() }
    }

    // Parse children
    let remaining = trimmed.slice(tagMatch[0].length)
    const closingTag = `</${tagName}>`

    if (depth < MAX_DEPTH) {
      while (remaining.length > 0) {
        const closeIdx = remaining.indexOf(closingTag)
        if (closeIdx === 0) {
          remaining = remaining.slice(closingTag.length).trim()
          break
        }

        const result = parseElement(remaining, depth + 1)
        if (result.node) {
          node.children!.push(result.node)
        }
        if (result.remaining === remaining) {
          // No progress, skip a character
          remaining = remaining.slice(1)
        } else {
          remaining = result.remaining
        }

        // Safety check for closing tag
        if (remaining.startsWith(closingTag)) {
          remaining = remaining.slice(closingTag.length).trim()
          break
        }
      }
    } else {
      // Skip children at max depth
      const closeIdx = remaining.indexOf(closingTag)
      if (closeIdx !== -1) {
        remaining = remaining.slice(closeIdx + closingTag.length).trim()
      }
    }

    return { node, remaining }
  }

  /**
   * Count elements in the tree
   */
  function countElements(node: XmlNode | null): number {
    if (!node || node.type !== "element") return 0
    let count = 1
    for (const child of node.children ?? []) {
      count += countElements(child)
    }
    return count
  }

  /**
   * Calculate maximum depth
   */
  function calculateMaxDepth(node: XmlNode | null, currentDepth: number = 0): number {
    if (!node || node.type !== "element") return currentDepth
    let maxDepth = currentDepth
    for (const child of node.children ?? []) {
      if (child.type === "element") {
        maxDepth = Math.max(maxDepth, calculateMaxDepth(child, currentDepth + 1))
      }
    }
    return maxDepth
  }

  /**
   * Get unique element names
   */
  function getUniqueElements(node: XmlNode | null): Set<string> {
    const elements = new Set<string>()
    if (!node || node.type !== "element" || !node.name) return elements
    elements.add(node.name)
    for (const child of node.children ?? []) {
      const childElements = getUniqueElements(child)
      for (const elem of childElements) {
        elements.add(elem)
      }
    }
    return elements
  }

  /**
   * Extract namespaces from attributes
   */
  function extractNamespaces(node: XmlNode | null): Record<string, string> {
    const namespaces: Record<string, string> = {}
    if (!node || node.type !== "element") return namespaces

    for (const [key, value] of Object.entries(node.attributes ?? {})) {
      if (key === "xmlns") {
        namespaces["default"] = value
      } else if (key.startsWith("xmlns:")) {
        namespaces[key.slice(6)] = value
      }
    }

    for (const child of node.children ?? []) {
      const childNs = extractNamespaces(child)
      Object.assign(namespaces, childNs)
    }

    return namespaces
  }

  /**
   * Format element hierarchy
   */
  function formatHierarchy(
    node: XmlNode | null,
    indent: string = "",
    maxDepth: number = 5,
    currentDepth: number = 0,
  ): string[] {
    const lines: string[] = []
    if (!node || node.type !== "element" || !node.name) return lines

    const attrs = Object.entries(node.attributes ?? {})
    const attrStr =
      attrs.length > 0
        ? ` [${attrs
            .slice(0, 3)
            .map(([k]) => k)
            .join(", ")}${attrs.length > 3 ? ", ..." : ""}]`
        : ""

    const childElements = (node.children ?? []).filter((c) => c.type === "element")
    const textContent = (node.children ?? []).find((c) => c.type === "text" || c.type === "cdata")
    const textSample = textContent?.content
      ? ` "${textContent.content.slice(0, MAX_TEXT_LENGTH).trim()}${textContent.content.length > MAX_TEXT_LENGTH ? "..." : ""}"`
      : ""

    lines.push(`${indent}<${node.name}>${attrStr}${textSample}`)

    if (currentDepth < maxDepth && childElements.length > 0) {
      const uniqueChildren = new Map<string, number>()
      for (const child of childElements) {
        if (child.name) {
          uniqueChildren.set(child.name, (uniqueChildren.get(child.name) ?? 0) + 1)
        }
      }

      const shown = new Set<string>()
      for (const child of childElements.slice(0, 10)) {
        if (child.name && !shown.has(child.name)) {
          shown.add(child.name)
          const count = uniqueChildren.get(child.name) ?? 1
          const countStr = count > 1 ? ` (x${count})` : ""
          lines.push(...formatHierarchy(child, indent + "  ", maxDepth, currentDepth + 1))
          if (count > 1) {
            lines[lines.length - 1] += countStr
          }
        }
      }

      if (uniqueChildren.size > shown.size) {
        lines.push(`${indent}  ... and ${uniqueChildren.size - shown.size} more element types`)
      }
    } else if (childElements.length > 0) {
      lines.push(`${indent}  (${childElements.length} child elements)`)
    }

    return lines
  }

  /**
   * Format the XML summary
   */
  function formatSummary(
    filePath: string,
    metadata: XmlMetadata,
    root: XmlNode | null,
    declaration: { version?: string; encoding?: string } | null,
  ): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(
      `Format: XML${declaration ? ` (version ${declaration.version ?? "1.0"}, ${declaration.encoding ?? "UTF-8"})` : ""}`,
    )
    lines.push("")
    lines.push(`Structure:`)
    lines.push(`- Root element: <${metadata.rootElement}>`)
    lines.push(`- Total elements: ${metadata.totalElements.toLocaleString("en-US")}`)
    lines.push(`- Max depth: ${metadata.maxDepth}`)
    lines.push(`- Unique element types: ${metadata.uniqueElements.length}`)

    // Show namespaces if any
    const nsEntries = Object.entries(metadata.namespaces)
    if (nsEntries.length > 0) {
      lines.push("")
      lines.push("Namespaces:")
      for (const [prefix, uri] of nsEntries.slice(0, 5)) {
        lines.push(`  ${prefix}: ${uri}`)
      }
      if (nsEntries.length > 5) {
        lines.push(`  ... and ${nsEntries.length - 5} more`)
      }
    }

    lines.push("")
    lines.push("Element hierarchy:")
    lines.push(...formatHierarchy(root, "  "))

    return lines.join("\n")
  }

  /**
   * Explore an XML file or content and produce a structured summary.
   */
  export async function explore(input: { content: string; filePath?: string }): Promise<XmlExplorationResult> {
    const filePath = input.filePath ?? "unknown.xml"
    log.info("exploring XML file", { filePath })

    try {
      const { root, declaration } = parseXml(input.content)

      if (!root || root.type !== "element") {
        return {
          success: false,
          summary: "",
          metadata: {
            rootElement: "",
            totalElements: 0,
            maxDepth: 0,
            uniqueElements: [],
            namespaces: {},
            hasDeclaration: false,
          },
          tokenCount: 0,
          error: "Failed to parse XML: No root element found",
        }
      }

      const totalElements = countElements(root)
      const maxDepth = calculateMaxDepth(root)
      const uniqueElements = Array.from(getUniqueElements(root))
      const namespaces = extractNamespaces(root)

      const metadata: XmlMetadata = {
        rootElement: root.name ?? "",
        totalElements,
        maxDepth,
        uniqueElements,
        namespaces,
        hasDeclaration: declaration !== null,
        version: declaration?.version,
        encoding: declaration?.encoding,
      }

      const summary = formatSummary(filePath, metadata, root, declaration)
      const tokenCount = Token.estimate(summary)

      log.info("XML exploration complete", {
        filePath,
        rootElement: root.name,
        totalElements,
        maxDepth,
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
      log.error("failed to parse XML", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          rootElement: "",
          totalElements: 0,
          maxDepth: 0,
          uniqueElements: [],
          namespaces: {},
          hasDeclaration: false,
        },
        tokenCount: 0,
        error: `Failed to parse XML: ${errorMessage}`,
      }
    }
  }
}
