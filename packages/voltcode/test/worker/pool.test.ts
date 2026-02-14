import { describe, expect, test } from "bun:test"
import { WorkerPool } from "../../src/worker/pool.ts"

describe("WorkerPool", () => {
  describe("acquire/release cycle", () => {
    test("acquire decrements available and increments running", async () => {
      const pool = new WorkerPool(2)
      expect(pool.runningCount).toBe(0)

      await pool.acquire()
      expect(pool.runningCount).toBe(1)

      await pool.acquire()
      expect(pool.runningCount).toBe(2)
    })

    test("release decrements running and increments available", async () => {
      const pool = new WorkerPool(2)
      await pool.acquire()
      await pool.acquire()
      expect(pool.runningCount).toBe(2)

      pool.release()
      expect(pool.runningCount).toBe(1)

      pool.release()
      expect(pool.runningCount).toBe(0)
    })

    test("acquire after release works correctly", async () => {
      const pool = new WorkerPool(1)
      await pool.acquire()
      expect(pool.runningCount).toBe(1)

      pool.release()
      expect(pool.runningCount).toBe(0)

      await pool.acquire()
      expect(pool.runningCount).toBe(1)
    })
  })

  describe("concurrency limiting", () => {
    test("acquire blocks when at max concurrency", async () => {
      const pool = new WorkerPool(2)
      await pool.acquire()
      await pool.acquire()
      expect(pool.runningCount).toBe(2)

      let acquired = false
      const acquirePromise = pool.acquire().then(() => {
        acquired = true
      })

      // Give microtasks a chance to run
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(acquired).toBe(false)
      expect(pool.runningCount).toBe(2)

      // Release one slot
      pool.release()
      await acquirePromise
      expect(acquired).toBe(true)
      expect(pool.runningCount).toBe(2)
    })

    test("blocked acquires are processed in FIFO order", async () => {
      const pool = new WorkerPool(1)
      await pool.acquire()

      const order: number[] = []

      const promise1 = pool.acquire().then(() => order.push(1))
      const promise2 = pool.acquire().then(() => order.push(2))
      const promise3 = pool.acquire().then(() => order.push(3))

      // Release slots one by one
      pool.release()
      await promise1
      expect(order).toEqual([1])

      pool.release()
      await promise2
      expect(order).toEqual([1, 2])

      pool.release()
      await promise3
      expect(order).toEqual([1, 2, 3])
    })
  })

  describe("runningCount getter", () => {
    test("returns 0 for new pool", () => {
      const pool = new WorkerPool(4)
      expect(pool.runningCount).toBe(0)
    })

    test("accurately reflects acquired slots", async () => {
      const pool = new WorkerPool(4)

      await pool.acquire()
      expect(pool.runningCount).toBe(1)

      await pool.acquire()
      await pool.acquire()
      expect(pool.runningCount).toBe(3)

      pool.release()
      expect(pool.runningCount).toBe(2)
    })

    test("includes blocked acquires once they are granted", async () => {
      const pool = new WorkerPool(1)
      await pool.acquire()

      const pendingAcquire = pool.acquire()
      expect(pool.runningCount).toBe(1) // Still 1, blocked acquire not counted

      pool.release()
      await pendingAcquire
      expect(pool.runningCount).toBe(1) // Now the blocked acquire has the slot
    })
  })

  describe("waitForAll", () => {
    test("resolves immediately if nothing is running", async () => {
      const pool = new WorkerPool(2)
      await pool.waitForAll()
      expect(true).toBe(true) // Just verify it completes
    })

    test("waits for all slots to be released", async () => {
      const pool = new WorkerPool(2)
      await pool.acquire()
      await pool.acquire()

      let waitResolved = false
      const waitPromise = pool.waitForAll().then(() => {
        waitResolved = true
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(waitResolved).toBe(false)

      pool.release()
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(waitResolved).toBe(false)

      pool.release()
      await waitPromise
      expect(waitResolved).toBe(true)
      expect(pool.runningCount).toBe(0)
    })

    test("multiple waitForAll calls all resolve", async () => {
      const pool = new WorkerPool(1)
      await pool.acquire()

      let resolved1 = false
      let resolved2 = false

      const wait1 = pool.waitForAll().then(() => {
        resolved1 = true
      })
      const wait2 = pool.waitForAll().then(() => {
        resolved2 = true
      })

      pool.release()
      await Promise.all([wait1, wait2])
      expect(resolved1).toBe(true)
      expect(resolved2).toBe(true)
    })
  })

  describe("concurrent acquire calls", () => {
    test("multiple concurrent acquires within limit all succeed immediately", async () => {
      const pool = new WorkerPool(4)
      const results = await Promise.all([
        pool.acquire().then(() => "a"),
        pool.acquire().then(() => "b"),
        pool.acquire().then(() => "c"),
      ])

      expect(results).toEqual(["a", "b", "c"])
      expect(pool.runningCount).toBe(3)
    })

    test("concurrent acquires exceeding limit queue correctly", async () => {
      const pool = new WorkerPool(2)
      const order: string[] = []

      // Start 4 concurrent acquires
      const p1 = pool.acquire().then(() => {
        order.push("a")
      })
      const p2 = pool.acquire().then(() => {
        order.push("b")
      })
      const p3 = pool.acquire().then(() => {
        order.push("c")
      })
      const p4 = pool.acquire().then(() => {
        order.push("d")
      })

      // First 2 should complete immediately
      await Promise.all([p1, p2])
      expect(order.length).toBe(2)
      expect(pool.runningCount).toBe(2)

      // Release one, third should complete
      pool.release()
      await p3
      expect(order).toContain("c")
      expect(pool.runningCount).toBe(2)

      // Release another, fourth should complete
      pool.release()
      await p4
      expect(order).toContain("d")
      expect(pool.runningCount).toBe(2)
    })

    test("stress test with many concurrent acquires", async () => {
      const pool = new WorkerPool(3)
      const completed: number[] = []
      const NUM_TASKS = 10

      // Start many concurrent tasks
      const promises: Promise<void>[] = []
      for (let i = 0; i < NUM_TASKS; i++) {
        const idx = i
        promises.push(
          pool.acquire().then(() => {
            completed.push(idx)
          }),
        )
      }

      // Release slots one by one
      for (let i = 0; i < NUM_TASKS; i++) {
        pool.release()
      }

      await Promise.all(promises)
      expect(completed.length).toBe(NUM_TASKS)
    })
  })

  describe("edge cases", () => {
    test("pool with maxConcurrency of 1 serializes work", async () => {
      const pool = new WorkerPool(1)
      const order: string[] = []

      await pool.acquire()
      const p1 = pool.acquire().then(() => order.push("second"))
      const p2 = pool.acquire().then(() => order.push("third"))

      order.push("first")
      pool.release()
      await p1

      pool.release()
      await p2

      expect(order).toEqual(["first", "second", "third"])
    })

    test("default maxConcurrency is 4", async () => {
      const pool = new WorkerPool()

      // Should be able to acquire 4 slots without blocking
      await Promise.all([pool.acquire(), pool.acquire(), pool.acquire(), pool.acquire()])
      expect(pool.runningCount).toBe(4)

      // Fifth should block
      let fifthAcquired = false
      const fifthPromise = pool.acquire().then(() => {
        fifthAcquired = true
      })

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(fifthAcquired).toBe(false)

      pool.release()
      await fifthPromise
      expect(fifthAcquired).toBe(true)
    })
  })
})
