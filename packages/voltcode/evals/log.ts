export type EvalLogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR"

const priorities: Record<EvalLogLevel, number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
}

const DEFAULT_LEVEL: EvalLogLevel = "INFO"
let currentLevel: EvalLogLevel = parseLevel(process.env.VOLTCODE_EVAL_LOG_LEVEL) ?? DEFAULT_LEVEL

function parseLevel(raw: string | undefined): EvalLogLevel | undefined {
  if (!raw) return undefined
  const level = raw.trim().toUpperCase()
  if (level === "TRACE" || level === "DEBUG" || level === "INFO" || level === "WARN" || level === "ERROR") {
    return level
  }
  return undefined
}

function shouldLog(level: EvalLogLevel): boolean {
  return priorities[level] >= priorities[currentLevel]
}

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.replace(/\r?\n/g, "\\n"),
    }
  }
  if (typeof value === "string") return value.replace(/\r?\n/g, "\\n")
  return value
}

function emit(level: EvalLogLevel, event: string, fields: Record<string, unknown> = {}): void {
  if (!shouldLog(level)) return
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  }
  for (const [key, value] of Object.entries(fields)) {
    payload[key] = sanitize(value)
  }
  const line = JSON.stringify(payload)
  if (level === "WARN" || level === "ERROR") {
    process.stderr.write(line + "\n")
    return
  }
  process.stdout.write(line + "\n")
}

export const EvalLog = {
  level() {
    return currentLevel
  },
  setLevel(raw: string | undefined) {
    const parsed = parseLevel(raw)
    if (parsed) currentLevel = parsed
  },
  trace(event: string, fields?: Record<string, unknown>) {
    emit("TRACE", event, fields)
  },
  debug(event: string, fields?: Record<string, unknown>) {
    emit("DEBUG", event, fields)
  },
  info(event: string, fields?: Record<string, unknown>) {
    emit("INFO", event, fields)
  },
  warn(event: string, fields?: Record<string, unknown>) {
    emit("WARN", event, fields)
  },
  error(event: string, fields?: Record<string, unknown>) {
    emit("ERROR", event, fields)
  },
}
