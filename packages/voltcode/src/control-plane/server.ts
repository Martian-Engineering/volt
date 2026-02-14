import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import type postgres from "postgres"
import { Log } from "../util/log"

const log = Log.create({ service: "control-plane" })

/**
 * Heartbeat payload sent by workers to report their status
 */
export const HeartbeatPayload = z.object({
  instance_id: z.string(),
  timestamp: z.string(),
  in_flight_jobs: z.number(),
  completed_since_last: z.number(),
  failed_since_last: z.number(),
  cpu_percent: z.number(),
  mem_percent: z.number(),
})

export type HeartbeatPayload = z.infer<typeof HeartbeatPayload>

/**
 * Health check response
 */
export const HealthResponse = z.object({
  status: z.literal("ok"),
  timestamp: z.string(),
})

export type HealthResponse = z.infer<typeof HealthResponse>

/**
 * Create the control plane HTTP server.
 *
 * @param dbClient - Postgres client for database operations
 * @returns Hono app instance
 */
export function createServer(dbClient: postgres.Sql): Hono {
  const app = new Hono()

  // POST /heartbeat - receive worker heartbeats, upsert to Postgres
  app.post("/heartbeat", validator("json", HeartbeatPayload), async (c) => {
    const payload = c.req.valid("json")

    log.debug("received heartbeat", {
      instanceId: payload.instance_id,
      inFlightJobs: payload.in_flight_jobs,
      cpuPercent: payload.cpu_percent,
      memPercent: payload.mem_percent,
    })

    await dbClient`
        INSERT INTO worker_heartbeats (instance_id, last_heartbeat, in_flight_jobs, cpu_percent, mem_percent)
        VALUES (${payload.instance_id}, ${payload.timestamp}, ${payload.in_flight_jobs}, ${payload.cpu_percent}, ${payload.mem_percent})
        ON CONFLICT (instance_id) DO UPDATE SET
          last_heartbeat = ${payload.timestamp},
          in_flight_jobs = ${payload.in_flight_jobs},
          cpu_percent = ${payload.cpu_percent},
          mem_percent = ${payload.mem_percent}
      `

    log.info("upserted worker heartbeat", { instanceId: payload.instance_id })

    return c.json({ success: true })
  })

  // GET /health - return 200 OK with status JSON
  app.get("/health", (c) => {
    const response: HealthResponse = {
      status: "ok",
      timestamp: new Date().toISOString(),
    }
    return c.json(response)
  })

  return app
}
