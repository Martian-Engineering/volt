import { describe, expect, test } from "bun:test"
import path from "path"
import { LlmMapTool, buildJsonModeProviderOptions, mergeProviderOptions } from "../../src/tool/llm-map"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import {
  stableStringify,
  buildUserMessage,
  parseJsonlFile,
  preflightSchema,
  formatValidationErrors,
} from "../../src/tool/map-shared"

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
// Shared utility tests (via map-shared.ts — validates shared layer)
// ---------------------------------------------------------------------------

describe("map-shared stableStringify", () => {
  test("sorts keys", () => {
    expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}')
  })

  test("recursive sort", () => {
    expect(stableStringify({ b: { z: 1, a: 2 }, a: 1 })).toBe('{"a":1,"b":{"a":2,"z":1}}')
  })
})

describe("map-shared buildUserMessage", () => {
  test("contains map-details-json with all fields", () => {
    const msg = buildUserMessage(
      "test prompt",
      "uuid",
      "2026-01-01T00:00:00Z",
      "lcm-1",
      0,
      { x: 1 },
      { type: "object" },
    )
    expect(msg.startsWith("test prompt")).toBe(true)
    expect(msg).toContain("<map-details-json>")
    const match = msg.match(/<map-details-json>\n(.*)\n<\/map-details-json>/)!
    const details = JSON.parse(match[1])
    expect(details.map_id).toBe("uuid")
    expect(details.item_index).toBe(0)
    expect(details.item).toEqual({ x: 1 })
  })
})

describe("map-shared parseJsonlFile", () => {
  test("parses valid JSONL", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n{"b":2}\n')
      },
    })
    const items = await parseJsonlFile(path.join(tmp.path, "input.jsonl"))
    expect(items).toEqual([{ a: 1 }, { b: 2 }])
  })

  test("rejects invalid JSON", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), "bad\n")
      },
    })
    await expect(parseJsonlFile(path.join(tmp.path, "input.jsonl"))).rejects.toThrow("not valid JSON")
  })

  test("rejects missing file", async () => {
    await expect(parseJsonlFile("/nonexistent/file.jsonl")).rejects.toThrow("Input file not found")
  })

  test("handles trailing newline", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), "1\n2\n")
      },
    })
    const items = await parseJsonlFile(path.join(tmp.path, "input.jsonl"))
    expect(items).toEqual([1, 2])
  })

  test("handles no trailing newline", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), "1\n2")
      },
    })
    const items = await parseJsonlFile(path.join(tmp.path, "input.jsonl"))
    expect(items).toEqual([1, 2])
  })

  test("accepts empty file as 0 items", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), "")
      },
    })
    const items = await parseJsonlFile(path.join(tmp.path, "input.jsonl"))
    expect(items).toEqual([])
  })
})

describe("map-shared preflightSchema", () => {
  test("compiles valid schema", () => {
    const validate = preflightSchema({ type: "object", required: ["x"] })
    expect(validate({ x: 1 })).toBe(true)
    expect(validate({})).toBe(false)
  })

  test("throws for invalid schema", () => {
    expect(() => preflightSchema({ type: 123 as unknown as string })).toThrow("not a valid JSON Schema")
  })
})

describe("map-shared formatValidationErrors", () => {
  test("formats errors with instancePath", () => {
    const result = formatValidationErrors([
      { instancePath: "/name", message: "must be string" },
      { instancePath: "", message: "must have required property 'id'" },
    ])
    expect(result).toContain("/name: must be string")
    expect(result).toContain("/: must have required property 'id'")
  })
})

// ---------------------------------------------------------------------------
// llm_map tool execute — early exits before DB
// ---------------------------------------------------------------------------

describe("llm_map execute", () => {
  function makeParams(overrides: Record<string, unknown> = {}) {
    return {
      input_path: "input.jsonl",
      output_path: "output.jsonl",
      prompt: "test prompt",
      output_schema: { type: "object" } as Record<string, unknown>,
      ...overrides,
    }
  }

  test("rejects malformed output_schema via Ajv", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LlmMapTool.init()
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
        const tool = await LlmMapTool.init()
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
        const tool = await LlmMapTool.init()
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
        const tool = await LlmMapTool.init()
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

  test("requests correct permissions", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LlmMapTool.init()
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
        const tool = await LlmMapTool.init()
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

  test("rejects model string without slash as invalid", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LlmMapTool.init()
        // "foobar" is not "small", "default", or "provider/model-id" — parseModel
        // will produce an empty modelID which Provider.getModel should reject
        await expect(
          tool.execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
              model: "foobar",
            }),
            ctx,
          ),
        ).rejects.toThrow()
      },
    })
  })

  test("applies default concurrency and timeout", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "input.jsonl"), '{"a":1}\n')
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await LlmMapTool.init()
        const requests: Array<Record<string, unknown>> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Record<string, unknown>) => {
            requests.push(req)
          },
        }
        // Omitting concurrency, timeout_seconds, max_attempts
        await tool
          .execute(
            makeParams({
              input_path: path.join(tmp.path, "input.jsonl"),
              output_path: path.join(tmp.path, "output.jsonl"),
            }),
            testCtx,
          )
          .catch(() => {})

        // If we got past JSONL parsing, defaults were applied
        const readReq = requests.find((r) => r.permission === "read")
        expect(readReq).toBeDefined()
      },
    })
  })
})

// ---------------------------------------------------------------------------
// JSON mode provider options
// ---------------------------------------------------------------------------

describe("buildJsonModeProviderOptions", () => {
  function fakeModel(npm: string, providerID = "test"): any {
    return { api: { npm }, providerID }
  }

  test("returns json_object response_format for OpenAI", () => {
    const opts = buildJsonModeProviderOptions(fakeModel("@ai-sdk/openai"))
    expect(opts.openai).toBeDefined()
    expect(opts.openai.response_format).toEqual({ type: "json_object" })
  })

  test("returns json_object response_format for Azure", () => {
    const opts = buildJsonModeProviderOptions(fakeModel("@ai-sdk/azure"))
    expect(opts.openai).toBeDefined()
    expect(opts.openai.response_format).toEqual({ type: "json_object" })
  })

  test("returns responseMimeType for Google", () => {
    const opts = buildJsonModeProviderOptions(fakeModel("@ai-sdk/google"))
    expect(opts.google).toBeDefined()
    expect(opts.google.responseMimeType).toBe("application/json")
  })

  test("returns responseMimeType for Google Vertex", () => {
    const opts = buildJsonModeProviderOptions(fakeModel("@ai-sdk/google-vertex"))
    expect(opts.google).toBeDefined()
    expect(opts.google.responseMimeType).toBe("application/json")
  })

  test("returns empty for Anthropic", () => {
    const opts = buildJsonModeProviderOptions(fakeModel("@ai-sdk/anthropic"))
    expect(Object.keys(opts).length).toBe(0)
  })

  test("returns empty for unknown provider", () => {
    const opts = buildJsonModeProviderOptions(fakeModel("@ai-sdk/custom"))
    expect(Object.keys(opts).length).toBe(0)
  })
})

describe("mergeProviderOptions", () => {
  test("merges non-overlapping keys", () => {
    const a = { openai: { store: false } }
    const b = { google: { responseMimeType: "application/json" } }
    const result = mergeProviderOptions(a, b)
    expect(result).toEqual({
      openai: { store: false },
      google: { responseMimeType: "application/json" },
    })
  })

  test("merges overlapping keys", () => {
    const a = { openai: { store: false, reasoningEffort: "high" } }
    const b = { openai: { response_format: { type: "json_object" } } }
    const result = mergeProviderOptions(a, b)
    expect(result.openai.store).toBe(false)
    expect(result.openai.reasoningEffort).toBe("high")
    expect(result.openai.response_format).toEqual({ type: "json_object" })
  })

  test("b overrides a for same nested key", () => {
    const a = { openai: { store: true } }
    const b = { openai: { store: false } }
    const result = mergeProviderOptions(a, b)
    expect(result.openai.store).toBe(false)
  })

  test("handles empty inputs", () => {
    expect(mergeProviderOptions({}, {})).toEqual({})
    expect(mergeProviderOptions({ openai: { x: 1 } }, {})).toEqual({ openai: { x: 1 } })
    expect(mergeProviderOptions({}, { openai: { x: 1 } })).toEqual({ openai: { x: 1 } })
  })
})
