import { describe, expect, test } from "bun:test"
import { LogExplorer } from "../../../../src/session/lcm/explore/log-explorer"

describe("session.lcm.explore.log-explorer", () => {
  describe("log format detection", () => {
    test("detects JSON log format", async () => {
      const jsonLogs = [
        '{"timestamp":"2024-01-15T10:30:45.123Z","level":"INFO","message":"Application started"}',
        '{"timestamp":"2024-01-15T10:30:46.000Z","level":"DEBUG","message":"Processing request"}',
        '{"timestamp":"2024-01-15T10:30:47.500Z","level":"INFO","message":"Request completed"}',
        '{"timestamp":"2024-01-15T10:30:48.000Z","level":"WARN","message":"High memory usage"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: jsonLogs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("json")
    })

    test("detects Apache Combined log format", async () => {
      const apacheLogs = [
        '127.0.0.1 - frank [10/Oct/2024:13:55:36 +0000] "GET /apache_pb.gif HTTP/1.0" 200 2326 "http://www.example.com/start.html" "Mozilla/4.08 [en] (Win98; I)"',
        '192.168.1.100 - - [10/Oct/2024:13:56:00 +0000] "POST /api/submit HTTP/1.1" 201 512 "http://www.example.com/form.html" "Mozilla/5.0"',
        '10.0.0.1 - admin [10/Oct/2024:13:56:30 +0000] "GET /admin HTTP/1.1" 403 1024 "-" "curl/7.68.0"',
        '172.16.0.50 - - [10/Oct/2024:13:57:00 +0000] "DELETE /api/item/123 HTTP/1.1" 204 0 "-" "PostmanRuntime/7.28.0"',
      ].join("\n")

      const result = await LogExplorer.explore({ content: apacheLogs, filePath: "access.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("apache_combined")
    })

    test("detects Apache Common log format", async () => {
      const apacheCommonLogs = [
        '127.0.0.1 - frank [10/Oct/2024:13:55:36 +0000] "GET /index.html HTTP/1.0" 200 2326',
        '192.168.1.100 - - [10/Oct/2024:13:56:00 +0000] "POST /submit HTTP/1.1" 201 512',
        '10.0.0.1 - admin [10/Oct/2024:13:56:30 +0000] "GET /admin HTTP/1.1" 403 1024',
        '172.16.0.50 - - [10/Oct/2024:13:57:00 +0000] "DELETE /item/123 HTTP/1.1" 204 0',
      ].join("\n")

      const result = await LogExplorer.explore({ content: apacheCommonLogs, filePath: "access.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("apache_common")
    })

    test("detects syslog format", async () => {
      const syslogLogs = [
        "Jan 15 10:30:45 server01 sshd[12345]: Accepted publickey for user from 192.168.1.100",
        "Jan 15 10:30:46 server01 kernel: [UFW BLOCK] IN=eth0 OUT= MAC=00:00:00:00:00:00",
        "Jan 15 10:30:47 server01 systemd[1]: Started Daily apt upgrade and clean activities.",
        "Jan 15 10:30:48 server01 cron[5678]: (root) CMD (/usr/local/bin/backup.sh)",
      ].join("\n")

      const result = await LogExplorer.explore({ content: syslogLogs, filePath: "/var/log/syslog" })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("syslog")
    })

    test("detects ISO timestamp format", async () => {
      const isoLogs = [
        "2024-01-15T10:30:45.123Z INFO  Application starting up",
        "2024-01-15T10:30:46.000Z DEBUG Loading configuration from /etc/app/config.yaml",
        "2024-01-15T10:30:47.500Z INFO  Connected to database",
        "2024-01-15T10:30:48.000Z WARN  Cache miss rate is high",
      ].join("\n")

      const result = await LogExplorer.explore({ content: isoLogs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("iso_timestamp")
    })

    test("returns unknown format for unstructured text", async () => {
      const plainText = [
        "This is just plain text",
        "No timestamps or structure here",
        "Random content line",
        "More unstructured data",
      ].join("\n")

      const result = await LogExplorer.explore({ content: plainText, filePath: "notes.txt" })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("unknown")
    })
  })

  describe("log level counting", () => {
    test("counts ERROR level entries", async () => {
      const logs = [
        '{"level":"ERROR","message":"Database connection failed"}',
        '{"level":"INFO","message":"Starting server"}',
        '{"level":"ERROR","message":"Authentication failed"}',
        '{"level":"WARN","message":"High memory usage"}',
        '{"level":"ERROR","message":"Timeout occurred"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      const errorStats = result.metadata.levelStats.find((s) => s.level === "ERROR")
      expect(errorStats).toBeDefined()
      expect(errorStats!.count).toBe(3)
    })

    test("counts WARN level entries", async () => {
      const logs = [
        "2024-01-15T10:30:45 WARN High CPU usage detected",
        "2024-01-15T10:30:46 INFO Request processed",
        "2024-01-15T10:30:47 WARN Memory threshold exceeded",
        "2024-01-15T10:30:48 DEBUG Processing complete",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      const warnStats = result.metadata.levelStats.find((s) => s.level === "WARN")
      expect(warnStats).toBeDefined()
      expect(warnStats!.count).toBe(2)
    })

    test("counts INFO level entries", async () => {
      const logs = [
        "2024-01-15T10:30:45 INFO Application started",
        "2024-01-15T10:30:46 INFO Request received",
        "2024-01-15T10:30:47 INFO Processing complete",
        "2024-01-15T10:30:48 DEBUG Internal state updated",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      const infoStats = result.metadata.levelStats.find((s) => s.level === "INFO")
      expect(infoStats).toBeDefined()
      expect(infoStats!.count).toBe(3)
    })

    test("counts multiple log levels correctly", async () => {
      const logs = [
        '{"level":"DEBUG","message":"Debug 1"}',
        '{"level":"INFO","message":"Info 1"}',
        '{"level":"INFO","message":"Info 2"}',
        '{"level":"WARN","message":"Warn 1"}',
        '{"level":"WARN","message":"Warn 2"}',
        '{"level":"WARN","message":"Warn 3"}',
        '{"level":"ERROR","message":"Error 1"}',
        '{"level":"ERROR","message":"Error 2"}',
        '{"level":"ERROR","message":"Error 3"}',
        '{"level":"ERROR","message":"Error 4"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)

      const debugStats = result.metadata.levelStats.find((s) => s.level === "DEBUG")
      const infoStats = result.metadata.levelStats.find((s) => s.level === "INFO")
      const warnStats = result.metadata.levelStats.find((s) => s.level === "WARN")
      const errorStats = result.metadata.levelStats.find((s) => s.level === "ERROR")

      expect(debugStats!.count).toBe(1)
      expect(infoStats!.count).toBe(2)
      expect(warnStats!.count).toBe(3)
      expect(errorStats!.count).toBe(4)
    })

    test("detects log levels in brackets", async () => {
      const logs = [
        "2024-01-15 10:30:45 [INFO] Application started",
        "2024-01-15 10:30:46 [ERROR] Connection failed",
        "2024-01-15 10:30:47 [WARN] Retry attempt 1",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)

      const infoStats = result.metadata.levelStats.find((s) => s.level === "INFO")
      const errorStats = result.metadata.levelStats.find((s) => s.level === "ERROR")
      const warnStats = result.metadata.levelStats.find((s) => s.level === "WARN")

      expect(infoStats!.count).toBe(1)
      expect(errorStats!.count).toBe(1)
      expect(warnStats!.count).toBe(1)
    })
  })

  describe("timestamp extraction", () => {
    test("extracts timestamps from JSON logs", async () => {
      const logs = [
        '{"timestamp":"2024-01-15T08:00:00.000Z","level":"INFO","message":"First"}',
        '{"timestamp":"2024-01-15T10:30:00.000Z","level":"INFO","message":"Middle"}',
        '{"timestamp":"2024-01-15T23:59:59.000Z","level":"INFO","message":"Last"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTimestamps).toBe(true)
      expect(result.metadata.earliestTimestamp).toBe("2024-01-15T08:00:00.000Z")
      expect(result.metadata.latestTimestamp).toBe("2024-01-15T23:59:59.000Z")
    })

    test("extracts timestamps from Apache logs", async () => {
      const logs = [
        '127.0.0.1 - - [15/Jan/2024:08:00:00 +0000] "GET / HTTP/1.1" 200 1234',
        '127.0.0.1 - - [15/Jan/2024:12:00:00 +0000] "GET /api HTTP/1.1" 200 5678',
        '127.0.0.1 - - [15/Jan/2024:18:00:00 +0000] "GET /end HTTP/1.1" 200 9012',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "access.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTimestamps).toBe(true)
      expect(result.metadata.earliestTimestamp).toContain("15/Jan/2024:08:00:00")
      expect(result.metadata.latestTimestamp).toContain("15/Jan/2024:18:00:00")
    })

    test("extracts timestamps from syslog format", async () => {
      const logs = [
        "Jan  1 00:00:00 server sshd[1234]: First entry",
        "Jan 15 12:30:45 server sshd[1234]: Middle entry",
        "Dec 31 23:59:59 server sshd[1234]: Last entry",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "syslog" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTimestamps).toBe(true)
      expect(result.metadata.earliestTimestamp).toBe("Jan  1 00:00:00")
      expect(result.metadata.latestTimestamp).toBe("Dec 31 23:59:59")
    })

    test("extracts timestamps from ISO format logs", async () => {
      const logs = [
        "2024-01-01 00:00:00 INFO Start of year",
        "2024-06-15 12:00:00 INFO Mid year",
        "2024-12-31 23:59:59 INFO End of year",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTimestamps).toBe(true)
      expect(result.metadata.earliestTimestamp).toBe("2024-01-01 00:00:00")
      expect(result.metadata.latestTimestamp).toBe("2024-12-31 23:59:59")
    })

    test("handles logs without timestamps", async () => {
      const logs = ["Application started successfully", "Processing request from client", "Request completed"].join(
        "\n",
      )

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTimestamps).toBe(false)
      expect(result.metadata.earliestTimestamp).toBeUndefined()
      expect(result.metadata.latestTimestamp).toBeUndefined()
    })

    test("extracts timestamps using common field names in JSON", async () => {
      const logsWithTime = [
        '{"time":"2024-01-15T10:00:00Z","level":"INFO","msg":"Using time field"}',
        '{"time":"2024-01-15T11:00:00Z","level":"INFO","msg":"Another entry"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logsWithTime, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTimestamps).toBe(true)
      expect(result.metadata.earliestTimestamp).toBe("2024-01-15T10:00:00Z")
    })
  })

  describe("error and warning counts", () => {
    test("counts error entries correctly", async () => {
      const logs = [
        '{"level":"ERROR","message":"Database connection failed"}',
        '{"level":"INFO","message":"Retrying connection"}',
        '{"level":"ERROR","message":"Retry failed"}',
        '{"level":"FATAL","message":"Application crashed"}',
        '{"level":"INFO","message":"Shutting down"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.errorCount).toBe(3) // 2 ERROR + 1 FATAL
    })

    test("counts warning entries correctly", async () => {
      const logs = [
        '{"level":"WARN","message":"High memory usage"}',
        '{"level":"INFO","message":"Memory recovered"}',
        '{"level":"WARNING","message":"Disk space low"}',
        '{"level":"WARN","message":"Connection slow"}',
        '{"level":"DEBUG","message":"Internal state"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.warningCount).toBe(3) // 2 WARN + 1 WARNING
    })

    test("detects errors from HTTP status codes", async () => {
      const logs = [
        '127.0.0.1 - - [15/Jan/2024:10:00:00 +0000] "GET /api HTTP/1.1" 200 1234',
        '127.0.0.1 - - [15/Jan/2024:10:01:00 +0000] "GET /api HTTP/1.1" 404 567',
        '127.0.0.1 - - [15/Jan/2024:10:02:00 +0000] "GET /api HTTP/1.1" 500 890',
        '127.0.0.1 - - [15/Jan/2024:10:03:00 +0000] "GET /api HTTP/1.1" 503 123',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "access.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.errorCount).toBe(3) // 404, 500, 503
    })

    test("detects errors from error keywords", async () => {
      const logs = [
        "2024-01-15 10:00:00 Exception in thread main",
        "2024-01-15 10:01:00 Normal operation",
        "2024-01-15 10:02:00 FAILURE: Connection refused",
        "2024-01-15 10:03:00 System panic detected",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.errorCount).toBeGreaterThanOrEqual(3)
    })

    test("detects warnings from warning keywords", async () => {
      const logs = [
        "2024-01-15 10:00:00 Deprecated function called",
        "2024-01-15 10:01:00 Normal operation",
        "2024-01-15 10:02:00 Timeout waiting for response, retrying",
        "2024-01-15 10:03:00 Retry attempt 2 of 3",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.warningCount).toBeGreaterThanOrEqual(2)
    })

    test("handles empty log file", async () => {
      const result = await LogExplorer.explore({ content: "", filePath: "empty.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(0)
      expect(result.metadata.errorCount).toBe(0)
      expect(result.metadata.warningCount).toBe(0)
    })

    test("handles log file with only whitespace", async () => {
      const logs = "   \n\n   \n\t\t\n   "

      const result = await LogExplorer.explore({ content: logs, filePath: "whitespace.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(0)
      expect(result.metadata.errorCount).toBe(0)
      expect(result.metadata.warningCount).toBe(0)
    })
  })

  describe("summary generation", () => {
    test("generates summary with file name", async () => {
      const logs = ['{"level":"INFO","message":"Test"}'].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "/var/log/application.log" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("application.log")
    })

    test("generates summary with format information", async () => {
      const logs = ['{"level":"INFO","message":"Test"}'].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("JSON")
    })

    test("generates summary with line count", async () => {
      const logs = [
        '{"level":"INFO","message":"Line 1"}',
        '{"level":"INFO","message":"Line 2"}',
        '{"level":"INFO","message":"Line 3"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("3")
    })

    test("includes token count in result", async () => {
      const logs = ['{"level":"INFO","message":"Test message"}'].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("source extraction", () => {
    test("extracts sources from JSON logs", async () => {
      const logs = [
        '{"level":"INFO","source":"auth-service","message":"User logged in"}',
        '{"level":"INFO","source":"api-gateway","message":"Request received"}',
        '{"level":"INFO","source":"auth-service","message":"Token validated"}',
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.sources).toContain("auth-service")
      expect(result.metadata.sources).toContain("api-gateway")
    })

    test("extracts sources from syslog format", async () => {
      const logs = [
        "Jan 15 10:30:45 server01 sshd[12345]: Connection from 192.168.1.1",
        "Jan 15 10:30:46 server01 nginx[5678]: Request received",
        "Jan 15 10:30:47 server01 sshd[12345]: Authentication successful",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "syslog" })

      expect(result.success).toBe(true)
      expect(result.metadata.sources.length).toBeGreaterThan(0)
    })

    test("extracts bracketed components as sources", async () => {
      const logs = [
        "2024-01-15 10:30:45 [database] Connection established",
        "2024-01-15 10:30:46 [cache] Cache warmed up",
        "2024-01-15 10:30:47 [database] Query executed",
      ].join("\n")

      const result = await LogExplorer.explore({ content: logs, filePath: "app.log" })

      expect(result.success).toBe(true)
      expect(result.metadata.sources).toContain("database")
      expect(result.metadata.sources).toContain("cache")
    })
  })
})
