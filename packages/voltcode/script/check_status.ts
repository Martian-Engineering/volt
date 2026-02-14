#!/usr/bin/env bun
// script/check_status.ts
// Usage: RESULTS_DB_URL=postgres://... DLQ_URL=https://sqs... bun run script/check_status.ts > status.md

import { Client } from "pg"
import { SQSClient, GetQueueAttributesCommand } from "@aws-sdk/client-sqs"

async function main() {
  const dbUrl = process.env.RESULTS_DB_URL
  const dlqUrl = process.env.DLQ_URL

  if (!dbUrl) {
    console.error("Error: RESULTS_DB_URL environment variable is required")
    process.exit(1)
  }

  if (!dlqUrl) {
    console.error("Error: DLQ_URL environment variable is required")
    process.exit(1)
  }

  const db = new Client({ connectionString: dbUrl })
  await db.connect()

  const now = new Date().toISOString()
  console.log(`# VoltCode Run Status\n`)
  console.log(`Generated: ${now}\n`)

  // Overall stats
  const overall = await db.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE success = true) AS succeeded,
      COUNT(*) FILTER (WHERE success = false) AS failed,
      COUNT(*) FILTER (WHERE status = 'running') AS in_flight
    FROM runs
  `)
  const o = overall.rows[0]
  const successRate =
    o.succeeded + o.failed > 0
      ? ((Number(o.succeeded) / (Number(o.succeeded) + Number(o.failed))) * 100).toFixed(1)
      : "N/A"

  console.log(`## Summary\n`)
  console.log(`| Metric | Value |`)
  console.log(`|--------|-------|`)
  console.log(`| Total runs | ${o.total} |`)
  console.log(`| Succeeded | ${o.succeeded} |`)
  console.log(`| Failed | ${o.failed} |`)
  console.log(`| In-flight | ${o.in_flight} |`)
  console.log(`| Success rate | ${successRate}% |`)
  console.log()

  // By backend
  const byBackend = await db.query(`
    SELECT
      backend,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE success = true) AS succeeded,
      COUNT(*) FILTER (WHERE success = false) AS failed,
      AVG(duration_s) FILTER (WHERE success = true) AS avg_duration,
      AVG(tokens_in + tokens_out) FILTER (WHERE success = true) AS avg_tokens
    FROM runs
    GROUP BY backend
    ORDER BY total DESC
  `)
  console.log(`## By Backend\n`)
  console.log(`| Backend | Total | Succeeded | Failed | Avg Duration (s) | Avg Tokens |`)
  console.log(`|---------|-------|-----------|--------|------------------|------------|`)
  for (const r of byBackend.rows) {
    const avgDuration = r.avg_duration != null ? Number(r.avg_duration).toFixed(1) : "-"
    const avgTokens = r.avg_tokens != null ? Number(r.avg_tokens).toFixed(0) : "-"
    console.log(`| ${r.backend} | ${r.total} | ${r.succeeded} | ${r.failed} | ${avgDuration} | ${avgTokens} |`)
  }
  console.log()

  // By context length
  const byCtx = await db.query(`
    SELECT
      context_length,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE success = true) AS succeeded
    FROM runs
    GROUP BY context_length
    ORDER BY context_length
  `)
  console.log(`## By Context Length\n`)
  console.log(`| Context Length | Total | Succeeded |`)
  console.log(`|----------------|-------|-----------|`)
  for (const r of byCtx.rows) {
    console.log(`| ${r.context_length} | ${r.total} | ${r.succeeded} |`)
  }
  console.log()

  // Worker health
  const workers = await db.query(`
    SELECT
      instance_id,
      last_heartbeat,
      in_flight_jobs,
      cpu_percent,
      mem_percent,
      CASE WHEN last_heartbeat > NOW() - INTERVAL '3 minutes' THEN 'healthy' ELSE 'unhealthy' END AS status
    FROM worker_heartbeats
    ORDER BY last_heartbeat DESC
    LIMIT 20
  `)
  console.log(`## Worker Health (top 20)\n`)
  console.log(`| Instance | Last Heartbeat | In-Flight | CPU % | Mem % | Status |`)
  console.log(`|----------|----------------|-----------|-------|-------|--------|`)
  for (const r of workers.rows) {
    const lastHeartbeat = r.last_heartbeat instanceof Date ? r.last_heartbeat.toISOString() : String(r.last_heartbeat)
    console.log(
      `| ${r.instance_id} | ${lastHeartbeat} | ${r.in_flight_jobs} | ${r.cpu_percent} | ${r.mem_percent} | ${r.status} |`,
    )
  }
  console.log()

  // Recent failures
  const failures = await db.query(`
    SELECT run_id, backend, context_length, error_message, end_ts
    FROM runs
    WHERE success = false
    ORDER BY end_ts DESC
    LIMIT 10
  `)
  console.log(`## Recent Failures (last 10)\n`)
  console.log(`| Run ID | Backend | Context | Error | Time |`)
  console.log(`|--------|---------|---------|-------|------|`)
  for (const r of failures.rows) {
    const err = (r.error_message || "").slice(0, 50).replace(/\|/g, "\\|")
    const endTs = r.end_ts instanceof Date ? r.end_ts.toISOString() : (r.end_ts ?? "-")
    console.log(`| ${r.run_id} | ${r.backend} | ${r.context_length} | ${err} | ${endTs} |`)
  }
  console.log()

  // DLQ depth (requires SQS call)
  const sqs = new SQSClient({ region: process.env.AWS_REGION || "us-west-2" })
  const dlqAttrs = await sqs.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ["ApproximateNumberOfMessages"],
    }),
  )
  const dlqDepth = dlqAttrs.Attributes?.ApproximateNumberOfMessages ?? "?"
  console.log(`## Queue Status\n`)
  console.log(`- DLQ depth: ${dlqDepth} messages\n`)

  await db.end()
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
