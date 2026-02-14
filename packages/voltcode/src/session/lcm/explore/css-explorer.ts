import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { Provider } from "@/provider/provider"
import { generateLLMSummary } from "./llm-summary"

/**
 * CSS File Exploration Agent
 *
 * Analyzes CSS files (.css, .scss, .sass, .less) and produces structured
 * summaries including preprocessor detection, imports, selector counts,
 * CSS variables, media queries, keyframes, and mixins/functions.
 */
export namespace CssExplorer {
  const log = Log.create({ service: "lcm.explore.css" })

  /**
   * Maximum number of items to list in each category
   */
  const MAX_ITEMS = 10

  /**
   * Maximum line length for samples
   */
  const MAX_LINE_LENGTH = 80

  /**
   * CSS preprocessor types
   */
  export type Preprocessor = "css" | "scss" | "sass" | "less"

  /**
   * Selector type counts
   */
  export interface SelectorCounts {
    /** .classname selectors */
    class: number
    /** #id selectors */
    id: number
    /** element selectors (div, span, etc.) */
    element: number
    /** [attribute] selectors */
    attribute: number
    /** :pseudo and ::pseudo selectors */
    pseudo: number
    /** Total selectors */
    total: number
  }

  /**
   * CSS variable information
   */
  export interface VariableInfo {
    name: string
    value: string
  }

  /**
   * Media query information
   */
  export interface MediaQueryInfo {
    query: string
    ruleCount: number
  }

  /**
   * Keyframe animation information
   */
  export interface KeyframeInfo {
    name: string
    stepCount: number
  }

  /**
   * Mixin/function information (for preprocessors)
   */
  export interface MixinInfo {
    name: string
    type: "mixin" | "function"
    params: string[]
  }

  /**
   * Import information
   */
  export interface ImportInfo {
    path: string
    type: "@import" | "@use" | "@forward"
  }

  /**
   * Font-face declaration information
   */
  export interface FontFaceInfo {
    family?: string
    src?: string
    weight?: string
    style?: string
  }

  /**
   * Metadata about the CSS structure
   */
  export interface CssMetadata {
    /** Detected preprocessor type */
    preprocessor: Preprocessor
    /** Total number of rules */
    ruleCount: number
    /** Selector counts by type */
    selectorCounts: SelectorCounts
    /** Number of CSS variables defined */
    variableCount: number
    /** Number of media queries */
    mediaQueryCount: number
    /** Number of keyframe animations */
    keyframeCount: number
    /** Number of font-face declarations */
    fontFaceCount: number
    /** Number of mixins (SCSS/LESS) */
    mixinCount: number
    /** Number of functions (SCSS/LESS) */
    functionCount: number
    /** Number of imports */
    importCount: number
    /** Whether CSS-in-JS patterns detected */
    hasCssInJsPatterns: boolean
    /** Total line count */
    lineCount: number
  }

  /**
   * Result of CSS exploration
   */
  export interface CssExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the CSS */
    metadata: CssMetadata
    /** List of imports */
    imports: ImportInfo[]
    /** List of CSS variables */
    variables: VariableInfo[]
    /** List of media queries */
    mediaQueries: MediaQueryInfo[]
    /** List of keyframe animations */
    keyframes: KeyframeInfo[]
    /** List of font-face declarations */
    fontFaces: FontFaceInfo[]
    /** List of mixins/functions */
    mixins: MixinInfo[]
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Detect preprocessor from file extension and content
   */
  function detectPreprocessor(content: string, filePath?: string): Preprocessor {
    if (filePath) {
      const ext = filePath.split(".").pop()?.toLowerCase()
      if (ext === "scss") return "scss"
      if (ext === "sass") return "sass"
      if (ext === "less") return "less"
    }

    // Content-based detection
    // SCSS patterns: $variable, @mixin, @include, @use, @forward, nested {}
    if (/@mixin\s+\w+/.test(content) || /@include\s+\w+/.test(content) || /@use\s+['"]/.test(content)) {
      return "scss"
    }

    // LESS patterns: @variable:, .mixin(), @import (url) with less-specific syntax
    if (/@[\w-]+\s*:/.test(content) && !content.includes("@media") && !content.includes("@keyframes")) {
      return "less"
    }

    // SASS patterns (indentation-based, no braces)
    const lines = content.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//"))
    const hasBraces = lines.some((l) => l.includes("{") || l.includes("}"))
    const hasIndentation = lines.some((l) => /^\s{2,}\w/.test(l))
    if (!hasBraces && hasIndentation && lines.length > 5) {
      return "sass"
    }

    // Check for $ variables (SCSS/SASS indicator)
    if (/\$[\w-]+\s*:/.test(content)) {
      return "scss"
    }

    return "css"
  }

  /**
   * Extract @import and @use statements
   */
  function extractImports(content: string): ImportInfo[] {
    const imports: ImportInfo[] = []

    // @import statements
    const importRegex = /@import\s+(?:url\s*\(\s*)?['"]?([^'");\s]+)['"]?\s*\)?/gi
    let match
    while ((match = importRegex.exec(content)) !== null) {
      imports.push({ path: match[1], type: "@import" })
    }

    // @use statements (SCSS)
    const useRegex = /@use\s+['"]([^'"]+)['"]/gi
    while ((match = useRegex.exec(content)) !== null) {
      imports.push({ path: match[1], type: "@use" })
    }

    // @forward statements (SCSS)
    const forwardRegex = /@forward\s+['"]([^'"]+)['"]/gi
    while ((match = forwardRegex.exec(content)) !== null) {
      imports.push({ path: match[1], type: "@forward" })
    }

    return imports
  }

  /**
   * Count selectors by type
   */
  function countSelectors(content: string): SelectorCounts {
    const counts: SelectorCounts = {
      class: 0,
      id: 0,
      element: 0,
      attribute: 0,
      pseudo: 0,
      total: 0,
    }

    // Remove comments and strings to avoid false matches
    const cleanContent = content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')

    // Extract selectors (everything before { that's not a function or at-rule body)
    const selectorRegex = /([^{}@]+)\s*\{/g
    let match

    while ((match = selectorRegex.exec(cleanContent)) !== null) {
      const selectorBlock = match[1].trim()

      // Skip if it looks like a mixin call, function, or at-rule body
      if (selectorBlock.startsWith("@") || (selectorBlock.includes("(") && !selectorBlock.includes("["))) {
        continue
      }

      // Split by comma for multiple selectors
      const selectors = selectorBlock.split(",")

      for (const selector of selectors) {
        const trimmed = selector.trim()
        if (!trimmed) continue

        counts.total++

        // Count class selectors
        const classMatches = trimmed.match(/\.\w[\w-]*/g)
        if (classMatches) counts.class += classMatches.length

        // Count ID selectors
        const idMatches = trimmed.match(/#\w[\w-]*/g)
        if (idMatches) counts.id += idMatches.length

        // Count attribute selectors
        const attrMatches = trimmed.match(/\[[^\]]+\]/g)
        if (attrMatches) counts.attribute += attrMatches.length

        // Count pseudo selectors
        const pseudoMatches = trimmed.match(/:{1,2}[\w-]+/g)
        if (pseudoMatches) counts.pseudo += pseudoMatches.length

        // Count element selectors (words at start or after combinators)
        const withoutClassIdAttr = trimmed
          .replace(/\.\w[\w-]*/g, "")
          .replace(/#\w[\w-]*/g, "")
          .replace(/\[[^\]]+\]/g, "")
          .replace(/:{1,2}[\w-]+(?:\([^)]*\))?/g, "")
        const elementMatches = withoutClassIdAttr.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g)
        if (elementMatches) counts.element += elementMatches.length
      }
    }

    return counts
  }

  /**
   * Extract CSS custom properties (variables)
   */
  function extractVariables(content: string): VariableInfo[] {
    const variables: VariableInfo[] = []

    // CSS custom properties: --variable-name: value
    const cssVarRegex = /(--[\w-]+)\s*:\s*([^;}\n]+)/g
    let match
    while ((match = cssVarRegex.exec(content)) !== null) {
      const value = match[2].trim()
      if (value.length <= MAX_LINE_LENGTH) {
        variables.push({ name: match[1], value })
      } else {
        variables.push({ name: match[1], value: value.slice(0, MAX_LINE_LENGTH - 3) + "..." })
      }
    }

    return variables
  }

  /**
   * Extract media queries
   */
  function extractMediaQueries(content: string): MediaQueryInfo[] {
    const mediaQueries: MediaQueryInfo[] = []
    const seen = new Map<string, number>()

    // Match @media rules
    const mediaRegex = /@media\s*([^{]+)\s*\{/gi
    let match
    while ((match = mediaRegex.exec(content)) !== null) {
      const query = match[1].trim()
      const normalizedQuery = query.replace(/\s+/g, " ")

      // Count rules inside (approximate by counting { after the media query)
      const startIndex = match.index + match[0].length
      let braceCount = 1
      let ruleCount = 0
      let i = startIndex

      while (i < content.length && braceCount > 0) {
        if (content[i] === "{") {
          braceCount++
          ruleCount++
        } else if (content[i] === "}") {
          braceCount--
        }
        i++
      }

      if (seen.has(normalizedQuery)) {
        const existingIdx = seen.get(normalizedQuery)!
        mediaQueries[existingIdx].ruleCount += ruleCount
      } else {
        seen.set(normalizedQuery, mediaQueries.length)
        mediaQueries.push({ query: normalizedQuery, ruleCount })
      }
    }

    return mediaQueries.sort((a, b) => b.ruleCount - a.ruleCount)
  }

  /**
   * Extract @keyframes animations
   */
  function extractKeyframes(content: string): KeyframeInfo[] {
    const keyframes: KeyframeInfo[] = []

    // Match @keyframes rules
    const keyframesRegex = /@keyframes\s+([\w-]+)\s*\{/gi
    let match
    while ((match = keyframesRegex.exec(content)) !== null) {
      const name = match[1]
      const startIndex = match.index + match[0].length
      let braceCount = 1
      let stepCount = 0
      let i = startIndex

      while (i < content.length && braceCount > 0) {
        if (content[i] === "{") {
          braceCount++
          if (braceCount === 2) stepCount++ // Inner brace = keyframe step
        } else if (content[i] === "}") {
          braceCount--
        }
        i++
      }

      keyframes.push({ name, stepCount })
    }

    return keyframes
  }

  /**
   * Extract @font-face declarations
   */
  function extractFontFaces(content: string): FontFaceInfo[] {
    const fontFaces: FontFaceInfo[] = []

    // Match @font-face rules
    const fontFaceRegex = /@font-face\s*\{([^}]+)\}/gi
    let match
    while ((match = fontFaceRegex.exec(content)) !== null) {
      const block = match[1]

      const familyMatch = block.match(/font-family\s*:\s*['"]?([^'";]+)['"]?/i)
      const srcMatch = block.match(/src\s*:\s*([^;]+)/i)
      const weightMatch = block.match(/font-weight\s*:\s*([^;]+)/i)
      const styleMatch = block.match(/font-style\s*:\s*([^;]+)/i)

      const srcValue = srcMatch?.[1]?.trim()
      fontFaces.push({
        family: familyMatch?.[1]?.trim(),
        src: srcValue ? (srcValue.length > 50 ? srcValue.slice(0, 50) + "..." : srcValue) : undefined,
        weight: weightMatch?.[1]?.trim(),
        style: styleMatch?.[1]?.trim(),
      })
    }

    return fontFaces
  }

  /**
   * Extract mixins and functions (SCSS/LESS)
   */
  function extractMixins(content: string, preprocessor: Preprocessor): MixinInfo[] {
    const mixins: MixinInfo[] = []

    if (preprocessor === "scss" || preprocessor === "sass") {
      // SCSS @mixin
      const mixinRegex = /@mixin\s+([\w-]+)\s*(?:\(([^)]*)\))?/gi
      let match
      while ((match = mixinRegex.exec(content)) !== null) {
        const params = match[2] ? match[2].split(",").map((p) => p.trim()) : []
        mixins.push({ name: match[1], type: "mixin", params })
      }

      // SCSS @function
      const functionRegex = /@function\s+([\w-]+)\s*(?:\(([^)]*)\))?/gi
      while ((match = functionRegex.exec(content)) !== null) {
        const params = match[2] ? match[2].split(",").map((p) => p.trim()) : []
        mixins.push({ name: match[1], type: "function", params })
      }
    } else if (preprocessor === "less") {
      // LESS mixins: .mixin-name() or #mixin-name()
      const lessMixinRegex = /([.#][\w-]+)\s*\(([^)]*)\)\s*\{/gi
      let match
      while ((match = lessMixinRegex.exec(content)) !== null) {
        const params = match[2] ? match[2].split(",").map((p) => p.trim()) : []
        mixins.push({ name: match[1], type: "mixin", params })
      }
    }

    return mixins
  }

  /**
   * Count total CSS rules
   */
  function countRules(content: string): number {
    // Remove at-rules bodies to avoid counting nested rules incorrectly
    const cleanContent = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")

    // Count rule blocks (selector followed by {})
    const ruleMatches = cleanContent.match(/[^{}@]+\s*\{[^{}]*\}/g)
    return ruleMatches?.length ?? 0
  }

  /**
   * Detect CSS-in-JS patterns
   */
  function detectCssInJsPatterns(content: string): boolean {
    // Look for common CSS-in-JS patterns
    const patterns = [
      /styled\.\w+`/,
      /css`/,
      /createStyles/,
      /makeStyles/,
      /StyleSheet\.create/,
      /emotion/i,
      /@emotion\/css/,
    ]

    return patterns.some((p) => p.test(content))
  }

  /**
   * Format the CSS summary
   */
  function formatSummary(
    filePath: string,
    metadata: CssMetadata,
    imports: ImportInfo[],
    variables: VariableInfo[],
    mediaQueries: MediaQueryInfo[],
    keyframes: KeyframeInfo[],
    fontFaces: FontFaceInfo[],
    mixins: MixinInfo[],
  ): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: ${formatPreprocessorName(metadata.preprocessor)}`)
    lines.push("")

    // Structure summary
    lines.push("Structure:")
    lines.push(`- Lines: ${metadata.lineCount.toLocaleString("en-US")}`)
    lines.push(`- Rules: ${metadata.ruleCount.toLocaleString("en-US")}`)
    lines.push(`- Imports: ${metadata.importCount}`)
    if (metadata.hasCssInJsPatterns) {
      lines.push(`- CSS-in-JS patterns detected`)
    }

    // Selector counts
    lines.push("")
    lines.push("Selectors:")
    lines.push(`- Total: ${metadata.selectorCounts.total.toLocaleString("en-US")}`)
    lines.push(`- Classes: ${metadata.selectorCounts.class.toLocaleString("en-US")}`)
    lines.push(`- IDs: ${metadata.selectorCounts.id.toLocaleString("en-US")}`)
    lines.push(`- Elements: ${metadata.selectorCounts.element.toLocaleString("en-US")}`)
    lines.push(`- Attributes: ${metadata.selectorCounts.attribute.toLocaleString("en-US")}`)
    lines.push(`- Pseudo: ${metadata.selectorCounts.pseudo.toLocaleString("en-US")}`)

    // Features
    lines.push("")
    lines.push("Features:")
    lines.push(`- CSS Variables: ${metadata.variableCount}`)
    lines.push(`- Media Queries: ${metadata.mediaQueryCount}`)
    lines.push(`- Keyframe Animations: ${metadata.keyframeCount}`)
    lines.push(`- Font Faces: ${metadata.fontFaceCount}`)
    if (metadata.preprocessor !== "css") {
      lines.push(`- Mixins: ${metadata.mixinCount}`)
      lines.push(`- Functions: ${metadata.functionCount}`)
    }

    // Imports
    if (imports.length > 0) {
      lines.push("")
      lines.push("Imports:")
      for (const imp of imports.slice(0, MAX_ITEMS)) {
        lines.push(`  ${imp.type} "${imp.path}"`)
      }
      if (imports.length > MAX_ITEMS) {
        lines.push(`  ... and ${imports.length - MAX_ITEMS} more imports`)
      }
    }

    // CSS Variables
    if (variables.length > 0) {
      lines.push("")
      lines.push("CSS Variables (sample):")
      for (const v of variables.slice(0, MAX_ITEMS)) {
        lines.push(`  ${v.name}: ${v.value}`)
      }
      if (variables.length > MAX_ITEMS) {
        lines.push(`  ... and ${variables.length - MAX_ITEMS} more variables`)
      }
    }

    // Media Queries
    if (mediaQueries.length > 0) {
      lines.push("")
      lines.push("Media Queries:")
      for (const mq of mediaQueries.slice(0, MAX_ITEMS)) {
        const queryDisplay = mq.query.length > 60 ? mq.query.slice(0, 57) + "..." : mq.query
        lines.push(`  @media ${queryDisplay} (${mq.ruleCount} rules)`)
      }
      if (mediaQueries.length > MAX_ITEMS) {
        lines.push(`  ... and ${mediaQueries.length - MAX_ITEMS} more media queries`)
      }
    }

    // Keyframes
    if (keyframes.length > 0) {
      lines.push("")
      lines.push("Keyframe Animations:")
      for (const kf of keyframes.slice(0, MAX_ITEMS)) {
        lines.push(`  @keyframes ${kf.name} (${kf.stepCount} steps)`)
      }
      if (keyframes.length > MAX_ITEMS) {
        lines.push(`  ... and ${keyframes.length - MAX_ITEMS} more animations`)
      }
    }

    // Font Faces
    if (fontFaces.length > 0) {
      lines.push("")
      lines.push("Font Faces:")
      for (const ff of fontFaces.slice(0, MAX_ITEMS)) {
        const details = [ff.family, ff.weight, ff.style].filter(Boolean).join(", ")
        lines.push(`  @font-face ${details || "(unnamed)"}`)
      }
      if (fontFaces.length > MAX_ITEMS) {
        lines.push(`  ... and ${fontFaces.length - MAX_ITEMS} more font faces`)
      }
    }

    // Mixins/Functions
    if (mixins.length > 0) {
      lines.push("")
      lines.push("Mixins/Functions:")
      for (const m of mixins.slice(0, MAX_ITEMS)) {
        const paramsStr = m.params.length > 0 ? `(${m.params.join(", ")})` : "()"
        lines.push(`  ${m.type}: ${m.name}${paramsStr}`)
      }
      if (mixins.length > MAX_ITEMS) {
        lines.push(`  ... and ${mixins.length - MAX_ITEMS} more mixins/functions`)
      }
    }

    return lines.join("\n")
  }

  /**
   * Get human-readable preprocessor name
   */
  function formatPreprocessorName(preprocessor: Preprocessor): string {
    switch (preprocessor) {
      case "scss":
        return "SCSS (Sassy CSS)"
      case "sass":
        return "Sass (indented syntax)"
      case "less":
        return "LESS"
      default:
        return "CSS"
    }
  }

  /**
   * Input for exploring a CSS file
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
   * Explore a CSS file or content and produce a structured summary.
   *
   * When a model is provided, the summary is generated by an LLM that understands
   * the file's purpose and can explain its architecture. Without a model, the
   * summary is generated using a deterministic template.
   */
  export async function explore(input: ExploreInput): Promise<CssExplorationResult> {
    const filePath = input.filePath ?? "unknown.css"
    log.info("exploring CSS file", { filePath })

    try {
      const content = input.content
      const lines = content.split("\n")
      const lineCount = lines.length

      // Detect preprocessor
      const preprocessor = detectPreprocessor(content, filePath)

      // Extract various components
      const imports = extractImports(content)
      const selectorCounts = countSelectors(content)
      const variables = extractVariables(content)
      const mediaQueries = extractMediaQueries(content)
      const keyframes = extractKeyframes(content)
      const fontFaces = extractFontFaces(content)
      const mixins = extractMixins(content, preprocessor)
      const ruleCount = countRules(content)
      const hasCssInJsPatterns = detectCssInJsPatterns(content)

      const metadata: CssMetadata = {
        preprocessor,
        ruleCount,
        selectorCounts,
        variableCount: variables.length,
        mediaQueryCount: mediaQueries.length,
        keyframeCount: keyframes.length,
        fontFaceCount: fontFaces.length,
        mixinCount: mixins.filter((m) => m.type === "mixin").length,
        functionCount: mixins.filter((m) => m.type === "function").length,
        importCount: imports.length,
        hasCssInJsPatterns,
        lineCount,
      }

      // Generate summary - use LLM if model provided, otherwise use template
      let summary: string
      let tokenCount: number

      if (input.model) {
        // Generate LLM-based summary using the extracted metadata as context
        const structuredMetadata = formatSummary(
          filePath,
          metadata,
          imports,
          variables,
          mediaQueries,
          keyframes,
          fontFaces,
          mixins,
        )
        const llmResult = await generateLLMSummary({
          content: input.content,
          filePath,
          language: "CSS",
          structuredMetadata,
          model: input.model,
          abort: input.abort,
        })
        summary = llmResult.summary
        tokenCount = llmResult.tokenCount
      } else {
        // Fall back to template-based summary
        summary = formatSummary(filePath, metadata, imports, variables, mediaQueries, keyframes, fontFaces, mixins)
        tokenCount = Token.estimate(summary)
      }

      log.info("CSS exploration complete", {
        filePath,
        preprocessor,
        ruleCount,
        selectorCount: selectorCounts.total,
        variableCount: variables.length,
        mediaQueryCount: mediaQueries.length,
        tokenCount,
        usedLLM: !!input.model,
      })

      return {
        success: true,
        summary,
        metadata,
        imports,
        variables,
        mediaQueries,
        keyframes,
        fontFaces,
        mixins,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to parse CSS", { filePath, error: errorMessage })

      return {
        success: false,
        summary: "",
        metadata: {
          preprocessor: "css",
          ruleCount: 0,
          selectorCounts: {
            class: 0,
            id: 0,
            element: 0,
            attribute: 0,
            pseudo: 0,
            total: 0,
          },
          variableCount: 0,
          mediaQueryCount: 0,
          keyframeCount: 0,
          fontFaceCount: 0,
          mixinCount: 0,
          functionCount: 0,
          importCount: 0,
          hasCssInJsPatterns: false,
          lineCount: 0,
        },
        imports: [],
        variables: [],
        mediaQueries: [],
        keyframes: [],
        fontFaces: [],
        mixins: [],
        tokenCount: 0,
        error: `Failed to parse CSS: ${errorMessage}`,
      }
    }
  }
}
