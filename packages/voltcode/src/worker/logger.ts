type LogLevel = "trace" | "debug" | "info" | "warn" | "error"

type LogContext = Record<string, unknown>

interface LogEntry {
  ts: string
  level: LogLevel
  msg: string
  [key: string]: unknown
}

interface Logger {
  trace(msg: string, context?: LogContext): void
  debug(msg: string, context?: LogContext): void
  info(msg: string, context?: LogContext): void
  warn(msg: string, context?: LogContext): void
  error(msg: string, context?: LogContext): void
  child(context: LogContext): Logger
}

function createLogger(baseContext: LogContext = {}): Logger {
  const log = (level: LogLevel, msg: string, context: LogContext = {}): void => {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      ...baseContext,
      msg,
      ...context,
    }
    console.log(JSON.stringify(entry))
  }

  return {
    trace: (msg, context) => log("trace", msg, context),
    debug: (msg, context) => log("debug", msg, context),
    info: (msg, context) => log("info", msg, context),
    warn: (msg, context) => log("warn", msg, context),
    error: (msg, context) => log("error", msg, context),
    child: (context) => createLogger({ ...baseContext, ...context }),
  }
}

export { createLogger, type Logger, type LogLevel, type LogContext }
