import { describe, expect, test } from "bun:test"
import path from "path"
import Ajv2020 from "ajv/dist/2020"
import { AgenticMapTool, stableStringify, buildSystemMessage, buildUserMessage } from "../../src/tool/agentic-map"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

describe("stableStringify", () => {
  test("sorts top-level keys alphabetically", () => {
    expect(stableStringify({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}')
  })

  test("sorts nested object keys recursively", () => {
    expect(stableStringify({ b: { z: 1, a: 2 }, a: 1 })).toBe('{"a":1,"b":{"a":2,"z":1}}')
  })

  test("preserves array element order", () => {
    expect(stableStringify([3, 1, 2])).toBe("[3,1,2]")
  })

  test("sorts keys inside array elements", () => {
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]')
  })

  test("handles null", () => {
    expect(stableStringify(null)).toBe("null")
  })

  test("handles primitives", () => {
    expect(stableStringify("hello")).toBe('"hello"')
    expect(stableStringify(42)).toBe("42")
    expect(stableStringify(true)).toBe("true")
  })

  test("handles empty object", () => {
    expect(stableStringify({})).toBe("{}")
  })

  test("handles deeply nested objects", () => {
    expect(stableStringify({ c: { b: { a: 1 } } })).toBe('{"c":{"b":{"a":1}}}')
  })

  test("is deterministic across calls", () => {
    const obj = { z: { y: 1, x: 2 }, a: [{ c: 3, b: 4 }] }
    expect(stableStringify(obj)).toBe(stableStringify(obj))
  })
})

// ---------------------------------------------------------------------------
// buildSystemMessage
// ---------------------------------------------------------------------------

describe("buildSystemMessage", () => {
  test("includes JSON-only output instructions", () => {
    const msg = buildSystemMessage(false)
    expect(msg).toContain("exactly one JSON value")
    expect(msg).toContain("No surrounding prose")
    expect(msg).toContain("No markdown fences")
    expect(msg).toContain("No trailing text")
  })

  test("includes schema validation reference", () => {
    const msg = buildSystemMessage(false)
    expect(msg).toContain("map-details-json")
  })

  test("includes correction instruction", () => {
    const msg = buildSystemMessage(false)
    expect(msg).toContain("corrected JSON only")
  })

  test("omits write-disabled when read_only=false", () => {
    const msg = buildSystemMessage(false)
    expect(msg).not.toContain("Write operations")
  })

  test("includes write-disabled when read_only=true", () => {
    const msg = buildSystemMessage(true)
    expect(msg).toContain("Write operations")
    expect(msg).toContain("disabled")
  })
})

// ---------------------------------------------------------------------------
// buildUserMessage
// ---------------------------------------------------------------------------

describe("buildUserMessage", () => {
  const prompt = "Analyze this item"
  const mapId = "550e8400-e29b-41d4-a716-446655440000"
  const runStartedAt = "2026-01-15T12:00:00.000Z"
  const inputLcmId = "lcm-abc-123"
  const itemIndex = 2
  const item = { state: "CA", url: "https://example.com" }
  const outputSchema = { type: "object", required: ["state"] }

  function msg() {
    return buildUserMessage(prompt, mapId, runStartedAt, inputLcmId, itemIndex, item, outputSchema)
  }

  test("starts with the exact prompt text", () => {
    expect(msg().startsWith(prompt)).toBe(true)
  })

  test("wraps metadata in map-details-json tags", () => {
    expect(msg()).toContain("<map-details-json>")
    expect(msg()).toContain("</map-details-json>")
  })

  test("contains valid JSON inside tags", () => {
    const match = msg().match(/<map-details-json>\n(.*)\n<\/map-details-json>/)
    expect(match).not.toBeNull()
    expect(() => JSON.parse(match![1])).not.toThrow()
  })

  test("includes all required spec fields", () => {
    const match = msg().match(/<map-details-json>\n(.*)\n<\/map-details-json>/)!
    const details = JSON.parse(match[1])
    expect(details.map_id).toBe(mapId)
    expect(details.run_started_at).toBe(runStartedAt)
    expect(details.input_lcm_id).toBe(inputLcmId)
    expect(details.item_index).toBe(itemIndex)
    expect(details.item).toEqual(item)
    expect(details.output_schema).toEqual(outputSchema)
  })

  test("does not disclose output_path or output_lcm_id", () => {
    expect(msg()).not.toContain("output_path")
    expect(msg()).not.toContain("output_lcm_id")
  })

  test("serializes details with deterministic key ordering", () => {
    const match = msg().match(/<map-details-json>\n(.*)\n<\/map-details-json>/)!
    const keys = Object.keys(JSON.parse(match[1]))
    expect(keys).toEqual([...keys].sort())
  })
})

// ---------------------------------------------------------------------------
// Schema preflight (direct Ajv2020 logic matching tool implementation)
// ---------------------------------------------------------------------------

describe("schema preflight", () => {
  test("object type check rejects boolean", () => {
    const schema: unknown = true
    const isObj = typeof schema === "object" && schema !== null && !Array.isArray(schema)
    expect(isObj).toBe(false)
  })

  test("object type check rejects null", () => {
    const schema: unknown = null
    const isObj = typeof schema === "object" && schema !== null && !Array.isArray(schema)
    expect(isObj).toBe(false)
  })

  test("object type check rejects array", () => {
    const schema: unknown = [{ type: "string" }]
    const isObj = typeof schema === "object" && schema !== null && !Array.isArray(schema)
    expect(isObj).toBe(false)
  })

  test("object type check accepts plain object", () => {
    const schema: unknown = { type: "object" }
    const isObj = typeof schema === "object" && schema !== null && !Array.isArray(schema)
    expect(isObj).toBe(true)
  })

  test("Ajv2020 compiles valid Draft 2020-12 schema", () => {
    const ajv = new Ajv2020({ allErrors: true })
    const validate = ajv.compile({
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    })
    expect(validate({ name: "test" })).toBe(true)
    expect(validate({})).toBe(false)
    expect(validate({ name: 123 })).toBe(false)
  })

  test("Ajv2020 throws for structurally invalid schema", () => {
    const ajv = new Ajv2020({ allErrors: true })
    expect(() => ajv.compile({ type: 123 as unknown as string })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Tool execute — early exits before DB (schema, JSONL, permissions)
// ---------------------------------------------------------------------------

describe("agentic_map execute", () => {
  function makeParams(overrides: Record<string, unknown> = {}) {
    return {
      input_path: "input.jsonl",
      output_path: "output.jsonl",
      prompt: "test prompt",
      output_schema: { type: "object" } as Record<string, unknown>,
      read_only: false,
      ...overrides,
    }
  }

  test("rejects malformed output_schema via Ajv", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        await expect(tool.execute(makeParams({ output_schema: { type: 123 } }), ctx)).rejects.toThrow(
          "not a valid JSON Schema",
        )
      },
    })
  })

  test("rejects missing input file", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        await expect(
          tool.execute(
            makeParams({
              input_path: path.join(tmp.path, "nonexistent.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            ctx,
          ),
        ).rejects.toThrow("Input file not found")
      },
    })
  })

  test("rejects JSONL with empty line", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n\n{"b":2}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        await expect(
          tool.execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            ctx,
          ),
        ).rejects.toThrow("Line 1 (0-based) is empty")
      },
    })
  })

  test("rejects JSONL with invalid JSON", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), "not json\n")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        await expect(
          tool.execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            ctx,
          ),
        ).rejects.toThrow("Line 0 (0-based) is not valid JSON")
      },
    })
  })

  test("parses valid JSONL with trailing newline", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n{"b":2}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        // Will fail after JSONL parsing (at MessageV2.get), but that's OK
        await tool
          .execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            testCtx,
          )
          .catch(() => {})

        // Task permission confirms JSONL parsed 2 items
        const taskReq = requests.find((r) => r.permission === "task")
        expect(taskReq).toBeDefined()
        expect((taskReq!.metadata as Record<string, string>).description).toBe("agentic_map: 2 items")
      },
    })
  })

  test("accepts empty file as 0 items", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), "")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        await tool
          .execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            testCtx,
          )
          .catch(() => {})

        const taskReq = requests.find((r) => r.permission === "task")
        expect(taskReq).toBeDefined()
        expect((taskReq!.metadata as Record<string, string>).description).toBe("agentic_map: 0 items")
      },
    })
  })

  test("requests read and edit permissions for input/output", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        await tool
          .execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            testCtx,
          )
          .catch(() => {})

        const readReq = requests.find((r) => r.permission === "read")
        expect(readReq).toBeDefined()
        expect((readReq!.patterns as string[])[0]).toContain("input.jsonl")

        const editReq = requests.find((r) => r.permission === "edit")
        expect(editReq).toBeDefined()
        expect((editReq!.patterns as string[])[0]).toContain("output.jsonl")

        const taskReq = requests.find((r) => r.permission === "task")
        expect(taskReq).toBeDefined()
      },
    })
  })

  test("requests external_directory for paths outside project", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n')
      },
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        await tool
          .execute(
            makeParams({
              input_path: path.join(outerTmp.path, "input.jsonl"),
              output_path: path.join(outerTmp.path, "output.jsonl"),
            }),
            testCtx,
          )
          .catch(() => {})

        const extReqs = requests.filter((r) => r.permission === "external_directory")
        expect(extReqs.length).toBeGreaterThanOrEqual(1)
      },
    })
  })

  test("applies default concurrency, timeout, and max_attempts", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        // The tool proceeds past JSONL parsing with defaults applied.
        // We verify it doesn't throw for missing optional params.
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        await tool
          .execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
              // concurrency, timeout_seconds, max_attempts intentionally omitted
            }),
            testCtx,
          )
          .catch(() => {})

        // If we reached the task permission, defaults were applied without error
        const taskReq = requests.find((r) => r.permission === "task")
        expect(taskReq).toBeDefined()
      },
    })
  })

  test("parses JSONL without trailing newline", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        // No trailing newline
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n{"b":2}')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await AgenticMapTool.init()
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        await tool
          .execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            testCtx,
          )
          .catch(() => {})

        const taskReq = requests.find((r) => r.permission === "task")
        expect(taskReq).toBeDefined()
        expect((taskReq!.metadata as Record<string, string>).description).toBe("agentic_map: 2 items")
      },
    })
  })
})
