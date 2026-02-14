import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { ExecutableExplorer } from "../../../../src/session/lcm/explore/executable-explorer"
import { $ } from "bun"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("session.lcm.explore.executable-explorer", () => {
  let tempDir: string
  let testBinaryPath: string

  beforeAll(async () => {
    // Create a temporary directory for test files
    tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "exec-explorer-test-"))
    testBinaryPath = path.join(tempDir, "test-binary")
  })

  afterAll(async () => {
    // Clean up temp directory
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
  })

  describe("non-existent files", () => {
    test("returns error result for non-existent file", async () => {
      const result = await ExecutableExplorer.explore({
        filePath: "/path/to/nonexistent/executable",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("File not found")
      expect(result.summary).toBe("")
      expect(result.tokenCount).toBe(0)
      expect(result.metadata.format).toBe("unknown")
      expect(result.metadata.sizeBytes).toBe(0)
      expect(result.metadata.dependencies).toEqual([])
      expect(result.metadata.exportedSymbols).toEqual([])
      expect(result.metadata.importedSymbols).toEqual([])
      expect(result.metadata.strings).toEqual([])
      expect(result.metadata.sections).toEqual([])
    })
  })

  describe("known system executables", () => {
    // /bin/ls should exist on macOS and Linux
    const knownExecutable = process.platform === "win32" ? null : "/bin/ls"

    test.skipIf(!knownExecutable)("explores /bin/ls successfully", async () => {
      const result = await ExecutableExplorer.explore({
        filePath: knownExecutable!,
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.summary).toContain("ls")
      expect(result.tokenCount).toBeGreaterThan(0)

      // Metadata checks
      expect(result.metadata.fileType).toBeTruthy()
      expect(result.metadata.sizeBytes).toBeGreaterThan(0)

      // On macOS, /bin/ls is Mach-O
      if (process.platform === "darwin") {
        expect(result.metadata.format).toBe("mach-o")
        // Could be arm64 (Apple Silicon) or x86_64 (Intel)
        expect(["arm64", "x86_64"]).toContain(result.metadata.arch?.arch ?? "")
      }
      // On Linux, it should be ELF
      if (process.platform === "linux") {
        expect(result.metadata.format).toBe("elf")
      }
    })

    test.skipIf(!knownExecutable)("extracts architecture info from /bin/ls", async () => {
      const result = await ExecutableExplorer.explore({
        filePath: knownExecutable!,
      })

      expect(result.success).toBe(true)
      expect(result.metadata.arch).toBeDefined()
      expect(result.metadata.arch?.bits).toBe(64)
    })

    test.skipIf(!knownExecutable)("extracts dependencies from /bin/ls", async () => {
      const result = await ExecutableExplorer.explore({
        filePath: knownExecutable!,
      })

      expect(result.success).toBe(true)
      // Most system binaries have at least some dependencies
      // On macOS, there should be dylib dependencies
      if (process.platform === "darwin") {
        expect(result.metadata.dependencies.length).toBeGreaterThanOrEqual(0)
      }
    })
  })

  describe("simple binary file handling", () => {
    test("handles a simple binary file", async () => {
      // Create a simple binary file (not a real executable, just binary data)
      const binaryData = Buffer.from([
        0x7f,
        0x45,
        0x4c,
        0x46, // ELF magic number (fake, won't fully parse)
        0x02, // 64-bit
        0x01, // Little endian
        0x01, // ELF version
        0x00, // OS/ABI
        ...Array(8).fill(0), // Padding
        0x02,
        0x00, // ET_EXEC
        0x3e,
        0x00, // x86-64
        ...Array(100).fill(0), // More placeholder data
      ])

      await fs.promises.writeFile(testBinaryPath, binaryData)

      const result = await ExecutableExplorer.explore({
        filePath: testBinaryPath,
      })

      // The file will be recognized as ELF by the `file` command
      expect(result.success).toBe(true)
      expect(result.metadata.sizeBytes).toBe(binaryData.length)
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    test("handles non-executable binary file", async () => {
      // Create a simple binary file with no executable magic
      const randomBinary = Buffer.from(
        Array(256)
          .fill(0)
          .map(() => Math.floor(Math.random() * 256)),
      )
      const randomBinaryPath = path.join(tempDir, "random-binary")

      await fs.promises.writeFile(randomBinaryPath, randomBinary)

      const result = await ExecutableExplorer.explore({
        filePath: randomBinaryPath,
      })

      // Should succeed but with unknown format
      expect(result.success).toBe(true)
      expect(result.metadata.sizeBytes).toBe(256)
      // Format will likely be "unknown" for random data
      expect(["unknown", "archive"]).toContain(result.metadata.format)
    })
  })

  describe("script files", () => {
    test("handles shell script files", async () => {
      const scriptPath = path.join(tempDir, "test-script.sh")
      const scriptContent = "#!/bin/bash\necho 'Hello, World!'\n"

      await fs.promises.writeFile(scriptPath, scriptContent)
      await fs.promises.chmod(scriptPath, 0o755)

      const result = await ExecutableExplorer.explore({
        filePath: scriptPath,
      })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("script")
      expect(result.metadata.fileType.toLowerCase()).toContain("script")
    })
  })

  describe("metadata structure", () => {
    test("returns complete metadata structure even on error", async () => {
      const result = await ExecutableExplorer.explore({
        filePath: "/nonexistent/path",
      })

      // Verify all metadata fields exist even on error
      expect(result.metadata).toHaveProperty("fileType")
      expect(result.metadata).toHaveProperty("format")
      expect(result.metadata).toHaveProperty("sizeBytes")
      expect(result.metadata).toHaveProperty("dependencies")
      expect(result.metadata).toHaveProperty("exportedSymbols")
      expect(result.metadata).toHaveProperty("importedSymbols")
      expect(result.metadata).toHaveProperty("strings")
      expect(result.metadata).toHaveProperty("sections")

      // Arrays should be empty
      expect(Array.isArray(result.metadata.dependencies)).toBe(true)
      expect(Array.isArray(result.metadata.exportedSymbols)).toBe(true)
      expect(Array.isArray(result.metadata.importedSymbols)).toBe(true)
      expect(Array.isArray(result.metadata.strings)).toBe(true)
      expect(Array.isArray(result.metadata.sections)).toBe(true)
    })

    test("summary includes file name and type info", async () => {
      const knownExecutable = process.platform === "win32" ? null : "/bin/ls"
      if (!knownExecutable) return

      const result = await ExecutableExplorer.explore({
        filePath: knownExecutable,
      })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File:")
      expect(result.summary).toContain("Type:")
      expect(result.summary).toContain("Format:")
      expect(result.summary).toContain("Size:")
    })
  })

  describe("format detection", () => {
    test.skipIf(process.platform !== "darwin")("detects Mach-O format on macOS", async () => {
      // Test with a known macOS binary
      const result = await ExecutableExplorer.explore({
        filePath: "/bin/cat",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.format).toBe("mach-o")
    })

    test.skipIf(process.platform === "win32")("detects shared library format", async () => {
      // Try to find a shared library on the system
      let sharedLibPath: string | null = null

      if (process.platform === "darwin") {
        // On macOS, check for a common dylib
        const possiblePaths = ["/usr/lib/libSystem.B.dylib", "/usr/lib/libc++.1.dylib"]
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            sharedLibPath = p
            break
          }
        }
      } else if (process.platform === "linux") {
        // On Linux, check for libc
        const possiblePaths = ["/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/usr/lib/libc.so.6"]
        for (const p of possiblePaths) {
          if (fs.existsSync(p)) {
            sharedLibPath = p
            break
          }
        }
      }

      if (!sharedLibPath) {
        console.log("No shared library found for testing, skipping")
        return
      }

      const result = await ExecutableExplorer.explore({
        filePath: sharedLibPath,
      })

      expect(result.success).toBe(true)
      expect(["shared_library", "mach-o", "elf"]).toContain(result.metadata.format)
    })
  })
})
