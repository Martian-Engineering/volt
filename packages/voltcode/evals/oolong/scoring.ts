/**
 * OOLONG scoring logic — faithful TypeScript port of eval_helpers.py
 * from https://github.com/abertsch72/oolong
 *
 * Scoring rules:
 * 1. Exact string match → 1.0
 * 2. Comparison answers ("more common"/"less common"/"same frequency") → substring match against gold → 1.0
 * 3. Numeric (ANSWER_TYPE.NUMERIC) → 0.75^|gold - predicted|, 0 if parse fails
 * 4. Date (ANSWER_TYPE.DATE) → exact equality after parsing, 0 if parse fails
 */

export interface ScoredResult {
  id: number
  contextWindowId: number
  dataset: string
  model: string
  attemptedParse: string
  parseConfidence: string
  fullAnswer: string
  score: number
  answer: string
  answerType?: string
  taskGroup?: string
  task?: string
}

/**
 * Parse gold answer from OOLONG dataset.
 * The answer field contains Python list literals like "['abbreviation']" or "[42]"
 * or datetime strings like "[datetime.date(2023, 5, 15)]"
 */
export function parseGoldAnswer(answer: string): string | number {
  // Handle datetime answers
  if (answer.includes("datetime")) {
    // Format: [datetime.date(YYYY, M, D)]
    const match = answer.match(/datetime\.date\((\d+),\s*(\d+),\s*(\d+)\)/)
    if (match) {
      const [, year, month, day] = match
      // Return as ISO date string for comparison
      return `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`
    }
    return answer
  }

  // Handle Python list literal: extract FIRST element only.
  // Matches official eval_helpers.py: ast.literal_eval(answer)[0]
  // Examples: "['abbreviation']", "[42]", "['a', 'b', 'c']"
  const stripped = answer.trim()

  // Try to extract from list format [X, ...] — take the first element
  const listMatch = stripped.match(/^\[(.+)\]$/)
  if (listMatch) {
    const inner = listMatch[1]!.trim()
    // Split on commas to handle multi-element lists like "['a', 'b', 'c']"
    // but be careful: element values might contain commas (unlikely in TREC labels)
    let firstElement: string
    if (inner.startsWith("'") || inner.startsWith('"')) {
      // Quoted string — extract up to the matching closing quote
      const quoteChar = inner[0]!
      const endQuote = inner.indexOf(quoteChar, 1)
      firstElement = endQuote > 0 ? inner.slice(1, endQuote) : inner.slice(1)
    } else {
      // Unquoted — take up to the first comma (or the whole thing)
      const commaIdx = inner.indexOf(",")
      firstElement = commaIdx > 0 ? inner.slice(0, commaIdx).trim() : inner
    }
    // Try to parse as number
    const num = Number(firstElement)
    if (!Number.isNaN(num) && firstElement.length > 0) {
      return num
    }
    return firstElement
  }

  // Fallback: try as number, else return as string
  const num = Number(stripped)
  if (!Number.isNaN(num) && stripped.length > 0) {
    return num
  }
  return stripped
}

/**
 * Parse model output to extract the answer.
 * Port of synth_attempt_answer_parse from eval_helpers.py
 */
export function parseModelOutput(answer: string): { answer: string; confidence: string } {
  let parseConfidence = "low"

  // Strip tool transcript blocks (e.g. <tool name="write">...Output:\n\n</tool>)
  // Models sometimes emit tool markup as visible text which confuses parsing
  let cleaned = answer.replace(/<tool\b[^>]*>[\s\S]*?<\/tool>/gi, "").trim()
  // Also strip standalone closing tags and XML-like fragments
  cleaned = cleaned.replace(/<\/?tool[^>]*>/gi, "").trim()

  // If stripping left us empty, fall back to original
  if (!cleaned) cleaned = answer

  // Prefer lines with explicit answer markers
  const markerPatterns = [/^Answer\s*:/im, /^Label\s*:/im, /^Date\s*:/im, /^Category\s*:/im, /^Classification\s*:/im]
  for (const pattern of markerPatterns) {
    const match = cleaned.match(pattern)
    if (match) {
      const markerLine = cleaned.slice(match.index!).split("\n")[0]!
      let afterColon = markerLine
        .split(":")
        .slice(1)
        .join(":")
        .trim()
        .replace(/\*/g, "")
        .replace(/\[/g, "")
        .replace(/\]/g, "")
      if (afterColon.length > 0 && afterColon.length < 100) {
        // Normalize comparison answers before returning
        if (afterColon.includes("more common")) afterColon = "more common"
        else if (afterColon.includes("less common")) afterColon = "less common"
        else if (afterColon.includes("same frequency")) afterColon = "same frequency"
        return { answer: afterColon, confidence: "high" }
      }
    }
  }

  if (!cleaned.includes(":")) {
    if (cleaned.length < 20) {
      return { answer: cleaned, confidence: parseConfidence }
    }
    const words = cleaned.split(/\s+/)
    return { answer: words[words.length - 1] ?? cleaned, confidence: parseConfidence }
  }

  // Split on last colon
  let candidateAnswer = cleaned.split(":").pop()!.trim()
  // Remove bold markers and brackets (OpenAI likes **, Anthropic likes [])
  candidateAnswer = candidateAnswer.replace(/\*/g, "")
  candidateAnswer = candidateAnswer.replace(/\[/g, "")
  candidateAnswer = candidateAnswer.replace(/\]/g, "")

  parseConfidence = "med"

  if (
    cleaned.includes("User:") ||
    cleaned.includes("Answer:") ||
    cleaned.includes("Date:") ||
    cleaned.includes("Label")
  ) {
    parseConfidence = "high"
  }

  if (candidateAnswer.length < 20) {
    parseConfidence = "vhigh"
  } else if (candidateAnswer.includes("more common")) {
    candidateAnswer = "more common"
  } else if (candidateAnswer.includes("less common")) {
    candidateAnswer = "less common"
  } else if (candidateAnswer.includes("same frequency")) {
    candidateAnswer = "same frequency"
  }

  return { answer: candidateAnswer, confidence: parseConfidence }
}

/**
 * Score a single OOLONG synth response.
 * Port of synth_process_response from eval_helpers.py
 */
export function scoreResponse(
  datapoint: {
    id: number
    contextWindowId: number
    dataset: string
    answer: string
    answerType: string
    taskGroup?: string
    task?: string
  },
  output: string,
  model: string,
): ScoredResult {
  let score = 0
  const gold = parseGoldAnswer(datapoint.answer)
  const { answer: trimmedOutput, confidence: parseConfidence } = parseModelOutput(output)

  let finalConfidence = parseConfidence

  // 1. Exact string match
  if (String(trimmedOutput) === String(gold)) {
    score = 1
  }
  // 2. Comparison answers
  else if (["more common", "less common", "same frequency"].includes(String(trimmedOutput))) {
    if (String(gold).includes(String(trimmedOutput))) {
      score = 1
    }
  }
  // 3. Numeric answers
  else if (datapoint.answerType === "ANSWER_TYPE.NUMERIC") {
    const predictedNum = parseInt(String(trimmedOutput), 10)
    const goldNum = typeof gold === "number" ? gold : parseInt(String(gold), 10)
    if (!Number.isNaN(predictedNum) && !Number.isNaN(goldNum)) {
      score = Math.pow(0.75, Math.abs(goldNum - predictedNum))
    } else {
      finalConfidence = "low"
    }
  }
  // 4. Date answers
  else if (datapoint.answerType === "ANSWER_TYPE.DATE") {
    // Try to parse the predicted date
    const goldStr = String(gold)
    const predictedStr = String(trimmedOutput).trim()
    // Simple date comparison — normalize to YYYY-MM-DD if possible
    if (predictedStr === goldStr) {
      score = 1
    } else {
      // Try parsing both as dates
      const goldDate = new Date(goldStr)
      const predictedDate = new Date(predictedStr)
      if (!isNaN(goldDate.getTime()) && !isNaN(predictedDate.getTime())) {
        score = goldDate.toISOString().split("T")[0] === predictedDate.toISOString().split("T")[0] ? 1 : 0
      } else {
        finalConfidence = "low"
      }
    }
  }

  return {
    id: datapoint.id,
    contextWindowId: datapoint.contextWindowId,
    dataset: datapoint.dataset,
    model,
    attemptedParse: String(trimmedOutput),
    parseConfidence: finalConfidence,
    fullAnswer: output,
    score,
    answer: String(gold),
    answerType: datapoint.answerType,
    taskGroup: datapoint.taskGroup,
    task: datapoint.task,
  }
}
