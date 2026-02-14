import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test"
import type { Hono } from "hono"

/**
 * Integration tests for control plane heartbeat handling.
 *
 * Tests:
 * - POST /heartbeat endpoint receives and stores worker heartbeats
 * - GET /health endpoint returns proper health status
 * - Health checker marks workers as unhealthy after timeout
 */

// Mock data storage to simulate database operations
interface MockHeartbeatRow {
  instance_id: string
  last_heartbeat: string
  in_flight_jobs: number
  cpu_percent: number
  mem_percent: number
  healthy?: boolean
}

let mockHeartbeats: Map<string, MockHeartbeatRow>
let mockDbCalls: { query: string; params: unknown[] }[]

// Create a mock postgres client that captures calls and stores data in memory
function createMockDbClient() {
  mockHeartbeats = new Map()
  mockDbCalls = []

  // Tagged template function for SQL queries
  const mockSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?")
    mockDbCalls.push({ query, params: values })

    // Parse the query to determine what operation to perform
    const queryLower = query.toLowerCase()

    if (queryLower.includes("insert into worker_heartbeats")) {
      // INSERT ... ON CONFLICT DO UPDATE
      const instanceId = values[0] as string
      const timestamp = values[1] as string
      const inFlightJobs = values[2] as number
      const cpuPercent = values[3] as number
      const memPercent = values[4] as number

      mockHeartbeats.set(instanceId, {
        instance_id: instanceId,
        last_heartbeat: timestamp,
        in_flight_jobs: inFlightJobs,
        cpu_percent: cpuPercent,
        mem_percent: memPercent,
        healthy: true,
      })

      return Promise.resolve([])
    }

    if (queryLower.includes("select instance_id") && queryLower.includes("from worker_heartbeats")) {
      // SELECT unhealthy workers
      const staleThreshold = values[0] as number
      const cutoff = new Date(Date.now() - staleThreshold * 60 * 1000)
      const unhealthy: { instance_id: string }[] = []

      for (const [_, row] of mockHeartbeats) {
        if (new Date(row.last_heartbeat) < cutoff) {
          unhealthy.push({ instance_id: row.instance_id })
        }
      }

      return Promise.resolve(unhealthy)
    }

    if (queryLower.includes("update worker_heartbeats") && queryLower.includes("set healthy = true")) {
      // Mark workers as healthy - only workers with recent heartbeats
      let count = 0
      const cutoff = new Date(Date.now() - 3 * 60 * 1000)

      for (const [_, row] of mockHeartbeats) {
        const heartbeatTime = new Date(row.last_heartbeat)
        // Only mark healthy if heartbeat is AFTER cutoff (recent)
        if (heartbeatTime > cutoff && (row.healthy === undefined || row.healthy === false)) {
          row.healthy = true
          count++
        }
      }

      return Promise.resolve({ count })
    }

    if (queryLower.includes("update worker_heartbeats") && queryLower.includes("set healthy = false")) {
      // Mark workers as unhealthy - only workers with stale heartbeats
      let count = 0
      const cutoff = new Date(Date.now() - 3 * 60 * 1000)

      for (const [_, row] of mockHeartbeats) {
        const heartbeatTime = new Date(row.last_heartbeat)
        // Only mark unhealthy if heartbeat is BEFORE or EQUAL to cutoff (stale)
        if (heartbeatTime <= cutoff && (row.healthy === undefined || row.healthy === true)) {
          row.healthy = false
          count++
        }
      }

      return Promise.resolve({ count })
    }

    return Promise.resolve([])
  }

  return mockSql as unknown as ReturnType<typeof import("postgres")>
}

// Import the server module after setting up mocks
const { createServer, HeartbeatPayload } = await import("../../src/control-plane/server")
const { getUnhealthyWorkers, markWorkersHealthy, createHealthChecker } = await import(
  "../../src/control-plane/health-checker"
)

describe("control-plane heartbeat", () => {
  let app: Hono
  let mockDbClient: ReturnType<typeof createMockDbClient>
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(() => {
    mockDbClient = createMockDbClient()
    app = createServer(mockDbClient)
  })

  afterEach(() => {
    if (server) {
      server.stop()
      server = null
    }
  })

  describe("POST /heartbeat", () => {
    test("accepts valid heartbeat and stores in database", async () => {
      const payload = {
        instance_id: "worker-1",
        timestamp: new Date().toISOString(),
        in_flight_jobs: 5,
        completed_since_last: 10,
        failed_since_last: 1,
        cpu_percent: 45.5,
        mem_percent: 62.3,
      }

      const response = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body).toEqual({ success: true })

      // Verify data was stored
      const stored = mockHeartbeats.get("worker-1")
      expect(stored).toBeDefined()
      expect(stored!.instance_id).toBe("worker-1")
      expect(stored!.in_flight_jobs).toBe(5)
      expect(stored!.cpu_percent).toBe(45.5)
      expect(stored!.mem_percent).toBe(62.3)
    })

    test("upserts existing worker heartbeat", async () => {
      const firstPayload = {
        instance_id: "worker-1",
        timestamp: new Date(Date.now() - 60000).toISOString(),
        in_flight_jobs: 3,
        completed_since_last: 5,
        failed_since_last: 0,
        cpu_percent: 30.0,
        mem_percent: 50.0,
      }

      await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(firstPayload),
      })

      const secondPayload = {
        instance_id: "worker-1",
        timestamp: new Date().toISOString(),
        in_flight_jobs: 7,
        completed_since_last: 12,
        failed_since_last: 2,
        cpu_percent: 80.0,
        mem_percent: 75.0,
      }

      const response = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(secondPayload),
      })

      expect(response.status).toBe(200)

      // Verify data was updated (not duplicated)
      expect(mockHeartbeats.size).toBe(1)
      const stored = mockHeartbeats.get("worker-1")
      expect(stored!.in_flight_jobs).toBe(7)
      expect(stored!.cpu_percent).toBe(80.0)
    })

    test("rejects invalid payload - missing required fields", async () => {
      const invalidPayload = {
        instance_id: "worker-1",
        // Missing other required fields
      }

      const response = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalidPayload),
      })

      expect(response.status).toBe(400)
    })

    test("rejects invalid payload - wrong types", async () => {
      const invalidPayload = {
        instance_id: "worker-1",
        timestamp: new Date().toISOString(),
        in_flight_jobs: "not a number", // Should be number
        completed_since_last: 10,
        failed_since_last: 1,
        cpu_percent: 45.5,
        mem_percent: 62.3,
      }

      const response = await app.request("/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(invalidPayload),
      })

      expect(response.status).toBe(400)
    })

    test("handles multiple workers independently", async () => {
      const workers = ["worker-1", "worker-2", "worker-3"]

      for (const workerId of workers) {
        const payload = {
          instance_id: workerId,
          timestamp: new Date().toISOString(),
          in_flight_jobs: Math.floor(Math.random() * 10),
          completed_since_last: Math.floor(Math.random() * 100),
          failed_since_last: Math.floor(Math.random() * 5),
          cpu_percent: Math.random() * 100,
          mem_percent: Math.random() * 100,
        }

        const response = await app.request("/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })

        expect(response.status).toBe(200)
      }

      expect(mockHeartbeats.size).toBe(3)
      expect(mockHeartbeats.has("worker-1")).toBe(true)
      expect(mockHeartbeats.has("worker-2")).toBe(true)
      expect(mockHeartbeats.has("worker-3")).toBe(true)
    })
  })

  describe("GET /health", () => {
    test("returns 200 OK with status JSON", async () => {
      const response = await app.request("/health")

      expect(response.status).toBe(200)
      const body = await response.json()
      expect(body.status).toBe("ok")
      expect(body.timestamp).toBeDefined()
      expect(typeof body.timestamp).toBe("string")
    })

    test("timestamp is valid ISO string", async () => {
      const response = await app.request("/health")
      const body = await response.json()

      const timestamp = new Date(body.timestamp)
      expect(timestamp.getTime()).not.toBeNaN()

      // Timestamp should be recent (within last 5 seconds)
      const now = Date.now()
      expect(timestamp.getTime()).toBeGreaterThan(now - 5000)
      expect(timestamp.getTime()).toBeLessThanOrEqual(now + 1000)
    })
  })

  describe("HTTP server integration", () => {
    test("starts server on specified port and handles requests", async () => {
      const port = 9876 + Math.floor(Math.random() * 1000)
      server = Bun.serve({
        port,
        fetch: app.fetch,
      })

      // Test health endpoint via HTTP
      const healthResponse = await fetch(`http://localhost:${port}/health`)
      expect(healthResponse.status).toBe(200)
      const healthBody = await healthResponse.json()
      expect(healthBody.status).toBe("ok")

      // Test heartbeat endpoint via HTTP
      const payload = {
        instance_id: "http-worker-1",
        timestamp: new Date().toISOString(),
        in_flight_jobs: 2,
        completed_since_last: 5,
        failed_since_last: 0,
        cpu_percent: 25.0,
        mem_percent: 40.0,
      }

      const heartbeatResponse = await fetch(`http://localhost:${port}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })

      expect(heartbeatResponse.status).toBe(200)
      const heartbeatBody = await heartbeatResponse.json()
      expect(heartbeatBody.success).toBe(true)
    })
  })
})

describe("health-checker", () => {
  let mockDbClient: ReturnType<typeof createMockDbClient>

  beforeEach(() => {
    mockDbClient = createMockDbClient()
  })

  describe("getUnhealthyWorkers", () => {
    test("returns workers with stale heartbeats", async () => {
      // Add a worker with old heartbeat
      mockHeartbeats.set("stale-worker", {
        instance_id: "stale-worker",
        last_heartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
        in_flight_jobs: 0,
        cpu_percent: 0,
        mem_percent: 0,
      })

      // Add a worker with recent heartbeat
      mockHeartbeats.set("healthy-worker", {
        instance_id: "healthy-worker",
        last_heartbeat: new Date().toISOString(),
        in_flight_jobs: 5,
        cpu_percent: 50,
        mem_percent: 50,
      })

      const unhealthy = await getUnhealthyWorkers(mockDbClient, 3)

      expect(unhealthy).toContain("stale-worker")
      expect(unhealthy).not.toContain("healthy-worker")
    })

    test("returns empty array when all workers are healthy", async () => {
      mockHeartbeats.set("healthy-1", {
        instance_id: "healthy-1",
        last_heartbeat: new Date().toISOString(),
        in_flight_jobs: 3,
        cpu_percent: 40,
        mem_percent: 50,
      })

      mockHeartbeats.set("healthy-2", {
        instance_id: "healthy-2",
        last_heartbeat: new Date().toISOString(),
        in_flight_jobs: 2,
        cpu_percent: 30,
        mem_percent: 45,
      })

      const unhealthy = await getUnhealthyWorkers(mockDbClient, 3)

      expect(unhealthy).toEqual([])
    })

    test("respects custom stale threshold", async () => {
      // Worker with heartbeat 2 minutes ago
      mockHeartbeats.set("worker-1", {
        instance_id: "worker-1",
        last_heartbeat: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
        in_flight_jobs: 0,
        cpu_percent: 0,
        mem_percent: 0,
      })

      // With 1 minute threshold, should be unhealthy
      const unhealthyWith1Min = await getUnhealthyWorkers(mockDbClient, 1)
      expect(unhealthyWith1Min).toContain("worker-1")

      // With 5 minute threshold, should be healthy
      const unhealthyWith5Min = await getUnhealthyWorkers(mockDbClient, 5)
      expect(unhealthyWith5Min).not.toContain("worker-1")
    })
  })

  describe("markWorkersHealthy", () => {
    test("marks workers with recent heartbeats as healthy", async () => {
      mockHeartbeats.set("recent-worker", {
        instance_id: "recent-worker",
        last_heartbeat: new Date().toISOString(),
        in_flight_jobs: 5,
        cpu_percent: 50,
        mem_percent: 50,
        healthy: false,
      })

      await markWorkersHealthy(mockDbClient)

      const worker = mockHeartbeats.get("recent-worker")
      expect(worker!.healthy).toBe(true)
    })

    test("marks workers with stale heartbeats as unhealthy", async () => {
      mockHeartbeats.set("stale-worker", {
        instance_id: "stale-worker",
        last_heartbeat: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 minutes ago
        in_flight_jobs: 0,
        cpu_percent: 0,
        mem_percent: 0,
        healthy: true,
      })

      await markWorkersHealthy(mockDbClient)

      const worker = mockHeartbeats.get("stale-worker")
      expect(worker!.healthy).toBe(false)
    })

    test("handles mix of healthy and unhealthy workers", async () => {
      mockHeartbeats.set("healthy-1", {
        instance_id: "healthy-1",
        last_heartbeat: new Date().toISOString(),
        in_flight_jobs: 3,
        cpu_percent: 40,
        mem_percent: 50,
        healthy: false,
      })

      mockHeartbeats.set("unhealthy-1", {
        instance_id: "unhealthy-1",
        last_heartbeat: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
        in_flight_jobs: 0,
        cpu_percent: 0,
        mem_percent: 0,
        healthy: true,
      })

      await markWorkersHealthy(mockDbClient)

      expect(mockHeartbeats.get("healthy-1")!.healthy).toBe(true)
      expect(mockHeartbeats.get("unhealthy-1")!.healthy).toBe(false)
    })
  })

  describe("createHealthChecker", () => {
    test("creates checker with start and stop methods", () => {
      const checker = createHealthChecker(mockDbClient, 1000)

      expect(typeof checker.start).toBe("function")
      expect(typeof checker.stop).toBe("function")
    })

    test("runs health check immediately on start", async () => {
      mockHeartbeats.set("test-worker", {
        instance_id: "test-worker",
        last_heartbeat: new Date().toISOString(),
        in_flight_jobs: 1,
        cpu_percent: 10,
        mem_percent: 20,
        healthy: false,
      })

      const checker = createHealthChecker(mockDbClient, 60000)
      checker.start()

      // Give it a moment to run the initial check
      await new Promise((resolve) => setTimeout(resolve, 50))

      checker.stop()

      // The worker should have been marked healthy
      expect(mockHeartbeats.get("test-worker")!.healthy).toBe(true)
    })

    test("can be stopped after starting", () => {
      const checker = createHealthChecker(mockDbClient, 100)

      checker.start()
      // Should not throw
      checker.stop()
    })

    test("multiple start calls are idempotent", () => {
      const checker = createHealthChecker(mockDbClient, 100)

      checker.start()
      checker.start() // Should not create duplicate intervals
      checker.stop()
    })

    test("multiple stop calls are safe", () => {
      const checker = createHealthChecker(mockDbClient, 100)

      checker.start()
      checker.stop()
      checker.stop() // Should not throw
    })
  })
})

describe("HeartbeatPayload schema", () => {
  test("validates correct payload", () => {
    const payload = {
      instance_id: "worker-1",
      timestamp: "2025-02-04T12:00:00.000Z",
      in_flight_jobs: 5,
      completed_since_last: 10,
      failed_since_last: 1,
      cpu_percent: 45.5,
      mem_percent: 62.3,
    }

    const result = HeartbeatPayload.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test("rejects missing instance_id", () => {
    const payload = {
      timestamp: "2025-02-04T12:00:00.000Z",
      in_flight_jobs: 5,
      completed_since_last: 10,
      failed_since_last: 1,
      cpu_percent: 45.5,
      mem_percent: 62.3,
    }

    const result = HeartbeatPayload.safeParse(payload)
    expect(result.success).toBe(false)
  })

  test("rejects non-numeric cpu_percent", () => {
    const payload = {
      instance_id: "worker-1",
      timestamp: "2025-02-04T12:00:00.000Z",
      in_flight_jobs: 5,
      completed_since_last: 10,
      failed_since_last: 1,
      cpu_percent: "45.5",
      mem_percent: 62.3,
    }

    const result = HeartbeatPayload.safeParse(payload)
    expect(result.success).toBe(false)
  })

  test("accepts zero values", () => {
    const payload = {
      instance_id: "idle-worker",
      timestamp: "2025-02-04T12:00:00.000Z",
      in_flight_jobs: 0,
      completed_since_last: 0,
      failed_since_last: 0,
      cpu_percent: 0,
      mem_percent: 0,
    }

    const result = HeartbeatPayload.safeParse(payload)
    expect(result.success).toBe(true)
  })

  test("accepts negative values for metrics", () => {
    // Some systems might report negative values in edge cases
    const payload = {
      instance_id: "worker-1",
      timestamp: "2025-02-04T12:00:00.000Z",
      in_flight_jobs: -1, // Edge case
      completed_since_last: 10,
      failed_since_last: 1,
      cpu_percent: 45.5,
      mem_percent: 62.3,
    }

    const result = HeartbeatPayload.safeParse(payload)
    expect(result.success).toBe(true) // Schema allows negative numbers
  })
})
