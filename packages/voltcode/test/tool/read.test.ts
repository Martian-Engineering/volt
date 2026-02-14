import { describe, expect, test } from "bun:test"
import path from "path"
import { ReadTool } from "../../src/tool/read"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { PermissionNext } from "../../src/permission/next"
import { Agent } from "../../src/agent/agent"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")

const ctx = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.read external_directory permission", () => {
  test("allows reading absolute path inside project directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello world")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "test.txt") }, ctx)
        expect(result.output).toContain("hello world")
      },
    })
  })

  test("allows reading file in subdirectory inside project directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "subdir", "test.txt"), "nested content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "subdir", "test.txt") }, ctx)
        expect(result.output).toContain("nested content")
      },
    })
  })

  test("asks for external_directory permission when reading absolute path outside project", async () => {
    await using outerTmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "secret data")
      },
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await read.execute({ filePath: path.join(outerTmp.path, "secret.txt") }, testCtx)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
        expect(extDirReq!.patterns.some((p) => p.includes(outerTmp.path))).toBe(true)
      },
    })
  })

  test("asks for external_directory permission when reading absolute path outside project (parent dir)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        // Use absolute path that resolves outside project (avoids Session.get for relative path resolution)
        const outsidePath = path.resolve(tmp.path, "..", "outside.txt")
        await read.execute({ filePath: outsidePath }, testCtx).catch(() => {})
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeDefined()
      },
    })
  })

  test("does not ask for external_directory permission when reading inside project", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "internal.txt"), "internal content")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const testCtx = {
          ...ctx,
          ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(req)
          },
        }
        await read.execute({ filePath: path.join(tmp.path, "internal.txt") }, testCtx)
        const extDirReq = requests.find((r) => r.permission === "external_directory")
        expect(extDirReq).toBeUndefined()
      },
    })
  })
})

describe("tool.read env file permissions", () => {
  const cases: [string, boolean][] = [
    [".env", true],
    [".env.local", true],
    [".env.production", true],
    [".env.development.local", true],
    [".env.example", false],
    [".envrc", false],
    ["environment.ts", false],
  ]

  describe.each(["build", "plan"])("agent=%s", (agentName) => {
    test.each(cases)("%s asks=%s", async (filename, shouldAsk) => {
      await using tmp = await tmpdir({
        init: (dir) => Bun.write(path.join(dir, filename), "content"),
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const agent = await Agent.get(agentName)
          let askedForEnv = false
          const ctxWithPermissions = {
            ...ctx,
            ask: async (req: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
              for (const pattern of req.patterns) {
                const rule = PermissionNext.evaluate(req.permission, pattern, agent.permission)
                if (rule.action === "ask" && req.permission === "read") {
                  askedForEnv = true
                }
                if (rule.action === "deny") {
                  throw new PermissionNext.DeniedError(agent.permission)
                }
              }
            },
          }
          const read = await ReadTool.init()
          await read.execute({ filePath: path.join(tmp.path, filename) }, ctxWithPermissions)
          expect(askedForEnv).toBe(shouldAsk)
        },
      })
    })
  })
})

describe("tool.read truncation", () => {
  test("truncates large file and sets truncated metadata", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const content = await Bun.file(path.join(FIXTURES_DIR, "models-api.json")).text()
        await Bun.write(path.join(dir, "large.json"), content)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "large.json") }, ctx)
        expect(result.metadata.truncated).toBe(true)
        // Large files go through LCM (or streaming fallback) which truncates by lines or bytes
        expect(result.output.includes("Output truncated at") || result.output.includes("File has more lines")).toBe(
          true,
        )
      },
    })
  })

  test("truncates by line count when limit is specified", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join("\n")
        await Bun.write(path.join(dir, "many-lines.txt"), lines)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "many-lines.txt"), limit: 10 }, ctx)
        expect(result.metadata.truncated).toBe(true)
        expect(result.output).toContain("File has more lines")
        expect(result.output).toContain("line0")
        expect(result.output).toContain("line9")
        expect(result.output).not.toContain("line10")
      },
    })
  })

  test("does not truncate small file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "small.txt"), "hello world")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "small.txt") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.output).toContain("End of file")
      },
    })
  })

  test("respects offset parameter", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const lines = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n")
        await Bun.write(path.join(dir, "offset.txt"), lines)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "offset.txt"), offset: 10, limit: 5 }, ctx)
        expect(result.output).toContain("line10")
        expect(result.output).toContain("line14")
        expect(result.output).not.toContain("line0")
        expect(result.output).not.toContain("line15")
      },
    })
  })

  test("truncates long lines", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const longLine = "x".repeat(3000)
        await Bun.write(path.join(dir, "long-line.txt"), longLine)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "long-line.txt") }, ctx)
        expect(result.output).toContain("...")
        expect(result.output.length).toBeLessThan(3000)
      },
    })
  })

  test("image files set truncated to false", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // 1x1 red PNG
        const png = Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
          "base64",
        )
        await Bun.write(path.join(dir, "image.png"), png)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "image.png") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeDefined()
        expect(result.attachments?.length).toBe(1)
      },
    })
  })

  test("large image files are properly attached without error", async () => {
    await Instance.provide({
      directory: FIXTURES_DIR,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(FIXTURES_DIR, "large-image.png") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.attachments).toBeDefined()
        expect(result.attachments?.length).toBe(1)
        expect(result.attachments?.[0].type).toBe("file")
      },
    })
  })

  test(".fbs files (FlatBuffers schema) are read as text, not images", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // FlatBuffers schema content
        const fbsContent = `namespace MyGame;

table Monster {
  pos:Vec3;
  name:string;
  inventory:[ubyte];
}

root_type Monster;`
        await Bun.write(path.join(dir, "schema.fbs"), fbsContent)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "schema.fbs") }, ctx)
        // Should be read as text, not as image
        expect(result.attachments).toBeUndefined()
        expect(result.output).toContain("namespace MyGame")
        expect(result.output).toContain("table Monster")
      },
    })
  })
})

describe("tool.read binary files", () => {
  test("returns metadata marker for binary file instead of throwing error", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create a binary file with null bytes and non-printable characters
        const binaryContent = Buffer.alloc(1024)
        // Fill with some binary content including null bytes
        for (let i = 0; i < binaryContent.length; i++) {
          binaryContent[i] = i % 256
        }
        await Bun.write(path.join(dir, "binary.bin"), binaryContent)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        // Should NOT throw - should return metadata
        const result = await read.execute({ filePath: path.join(tmp.path, "binary.bin") }, ctx)
        expect(result.output).toContain("Binary file detected")
        expect(result.output).toContain("Path:")
        expect(result.output).toContain("Size:")
        expect(result.output).toContain("MIME Type:")
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("returns metadata for executable-like binary file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create a file with ELF-like header (binary executable signature)
        const elfHeader = Buffer.from([
          0x7f,
          0x45,
          0x4c,
          0x46, // ELF magic number
          0x02,
          0x01,
          0x01,
          0x00, // 64-bit, little endian, version 1, System V ABI
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00,
          0x00, // padding
        ])
        const fullBinary = Buffer.concat([elfHeader, Buffer.alloc(1024)])
        await Bun.write(path.join(dir, "executable"), fullBinary)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "executable") }, ctx)
        expect(result.output).toContain("Binary file detected")
        expect(result.output).toContain("cannot display contents as text")
        expect(result.metadata.preview).toContain("Binary file:")
      },
    })
  })

  test("returns metadata for large binary file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        // Create a larger binary file (1MB)
        const largeBinary = Buffer.alloc(1024 * 1024)
        for (let i = 0; i < largeBinary.length; i++) {
          largeBinary[i] = Math.floor(Math.random() * 256)
        }
        // Ensure there are null bytes to trigger binary detection
        largeBinary[0] = 0
        largeBinary[100] = 0
        largeBinary[1000] = 0
        await Bun.write(path.join(dir, "large.bin"), largeBinary)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const read = await ReadTool.init()
        const result = await read.execute({ filePath: path.join(tmp.path, "large.bin") }, ctx)
        expect(result.output).toContain("Binary file detected")
        expect(result.output).toContain("1.00 MB")
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("correctly identifies files with known binary extensions", async () => {
    const binaryExtensions = [".zip", ".exe", ".dll", ".so", ".wasm"]

    for (const ext of binaryExtensions) {
      await using tmp = await tmpdir({
        init: async (dir) => {
          // Create a file with binary extension - content doesn't matter for extension-based detection
          await Bun.write(path.join(dir, `file${ext}`), Buffer.from([0x00, 0x01, 0x02, 0x03]))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const read = await ReadTool.init()
          const result = await read.execute({ filePath: path.join(tmp.path, `file${ext}`) }, ctx)
          expect(result.output).toContain("Binary file detected")
          expect(result.output).toContain(`**Extension:** ${ext}`)
        },
      })
    }
  })
})
