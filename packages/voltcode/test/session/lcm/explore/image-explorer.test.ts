import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { ImageExplorer } from "../../../../src/session/lcm/explore/image-explorer"
import path from "path"
import { tmpdir } from "os"

const FIXTURES_DIR = path.join(__dirname, "../../../tool/fixtures")
const TEMP_DIR = tmpdir()

describe("session.lcm.explore.image-explorer", () => {
  describe("error handling", () => {
    test("returns error for non-existent file", async () => {
      const result = await ImageExplorer.explore({
        filePath: "/non/existent/image.png",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("File not found")
      expect(result.summary).toBe("")
      expect(result.metadata.format).toBe("unknown")
      expect(result.metadata.width).toBe(0)
      expect(result.metadata.height).toBe(0)
      expect(result.tokenCount).toBe(0)
    })

    test("returns error for non-existent file with special characters in path", async () => {
      const result = await ImageExplorer.explore({
        filePath: "/path/with spaces/and-special_chars/image.png",
      })

      expect(result.success).toBe(false)
      expect(result.error).toContain("File not found")
    })
  })

  describe("format detection by extension", () => {
    // Test extension-based format detection using temporary files
    const extensionTests: Array<{ ext: string; expectedFormat: ImageExplorer.ImageFormat }> = [
      { ext: "jpg", expectedFormat: "jpeg" },
      { ext: "jpeg", expectedFormat: "jpeg" },
      { ext: "png", expectedFormat: "png" },
      { ext: "gif", expectedFormat: "gif" },
      { ext: "webp", expectedFormat: "webp" },
      { ext: "bmp", expectedFormat: "bmp" },
      { ext: "tif", expectedFormat: "tiff" },
      { ext: "tiff", expectedFormat: "tiff" },
      { ext: "svg", expectedFormat: "svg" },
      { ext: "ico", expectedFormat: "ico" },
      { ext: "heic", expectedFormat: "heic" },
      { ext: "heif", expectedFormat: "heic" },
      { ext: "avif", expectedFormat: "avif" },
      { ext: "psd", expectedFormat: "psd" },
      { ext: "raw", expectedFormat: "raw" },
      { ext: "cr2", expectedFormat: "raw" },
      { ext: "nef", expectedFormat: "raw" },
      { ext: "arw", expectedFormat: "raw" },
      { ext: "dng", expectedFormat: "raw" },
    ]

    // Create minimal test files that will be detected by extension
    // Since these files don't have valid image content, they will fail parsing
    // but format detection by extension should still work
    const tempFiles: string[] = []

    beforeAll(async () => {
      // Create minimal test files with each extension
      for (const { ext } of extensionTests) {
        const filePath = path.join(TEMP_DIR, `test-image-explorer-${Date.now()}-${Math.random()}.${ext}`)
        await Bun.write(filePath, "minimal content for format detection test")
        tempFiles.push(filePath)
      }
    })

    afterAll(async () => {
      // Clean up temp files
      for (const filePath of tempFiles) {
        try {
          ;(await Bun.file(filePath).exists()) && (await Bun.write(filePath, ""))
          // Use unlinkSync for cleanup
          const fs = await import("fs")
          fs.unlinkSync(filePath)
        } catch {
          // Ignore cleanup errors
        }
      }
    })

    test("detects format from file extension", async () => {
      // Test a subset of extensions that we can verify work with minimal files
      // The format detection should work even for files without valid image content
      const testCases: Array<{ ext: string; format: ImageExplorer.ImageFormat }> = [
        { ext: "jpg", format: "jpeg" },
        { ext: "png", format: "png" },
        { ext: "gif", format: "gif" },
        { ext: "svg", format: "svg" },
      ]

      for (const { ext, format } of testCases) {
        const filePath = path.join(TEMP_DIR, `format-test-${Date.now()}-${Math.random()}.${ext}`)
        await Bun.write(filePath, "test content")

        const result = await ImageExplorer.explore({ filePath })

        // Format should be detected from extension even if file parsing fails
        expect(result.metadata.format).toBe(format)

        // Clean up
        try {
          const fs = await import("fs")
          fs.unlinkSync(filePath)
        } catch {
          // Ignore
        }
      }
    })
  })

  describe("PNG file parsing", () => {
    const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")

    test("parses PNG file successfully", async () => {
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping PNG test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.metadata.format).toBe("png")
      expect(result.metadata.width).toBeGreaterThan(0)
      expect(result.metadata.height).toBeGreaterThan(0)
      expect(result.metadata.sizeBytes).toBeGreaterThan(0)
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    test("extracts PNG dimensions correctly", async () => {
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping PNG dimensions test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      // PNG dimensions should be extracted from IHDR chunk
      expect(typeof result.metadata.width).toBe("number")
      expect(typeof result.metadata.height).toBe("number")
      expect(result.metadata.width).toBeGreaterThan(0)
      expect(result.metadata.height).toBeGreaterThan(0)
    })

    test("generates meaningful summary for PNG", async () => {
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping PNG summary test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("PNG")
      expect(result.summary).toContain("Dimensions:")
      expect(result.summary).toContain("Size:")
    })
  })

  describe("magic byte detection", () => {
    // Create actual minimal valid image files for magic byte detection

    test("detects PNG by magic bytes", async () => {
      // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
      // Followed by minimal IHDR chunk
      const pngMagic = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR chunk length (13)
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
        0x00,
        0x00,
        0x00,
        0x01, // width: 1
        0x00,
        0x00,
        0x00,
        0x01, // height: 1
        0x08, // bit depth: 8
        0x02, // color type: RGB
        0x00, // compression: deflate
        0x00, // filter: none
        0x00, // interlace: none
        0x90,
        0x77,
        0x53,
        0xde, // CRC
      ])

      const filePath = path.join(TEMP_DIR, `magic-png-${Date.now()}.dat`)
      await Bun.write(filePath, pngMagic)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.format).toBe("png")
      expect(result.metadata.width).toBe(1)
      expect(result.metadata.height).toBe(1)

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })

    test("detects JPEG by magic bytes", async () => {
      // JPEG magic bytes: FF D8 FF
      const jpegHeader = Buffer.from([
        0xff,
        0xd8,
        0xff,
        0xe0, // JPEG SOI + APP0 marker
        0x00,
        0x10, // APP0 length
        0x4a,
        0x46,
        0x49,
        0x46,
        0x00, // "JFIF\0"
        0x01,
        0x01, // version
        0x00, // units
        0x00,
        0x01, // X density
        0x00,
        0x01, // Y density
        0x00,
        0x00, // thumbnail size
      ])

      const filePath = path.join(TEMP_DIR, `magic-jpeg-${Date.now()}.dat`)
      await Bun.write(filePath, jpegHeader)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.format).toBe("jpeg")

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })

    test("detects GIF by magic bytes", async () => {
      // GIF magic bytes: GIF89a or GIF87a
      const gifHeader = Buffer.from([
        0x47,
        0x49,
        0x46,
        0x38,
        0x39,
        0x61, // "GIF89a"
        0x01,
        0x00, // width: 1
        0x01,
        0x00, // height: 1
        0x00, // packed byte
        0x00, // background color
        0x00, // pixel aspect ratio
      ])

      const filePath = path.join(TEMP_DIR, `magic-gif-${Date.now()}.dat`)
      await Bun.write(filePath, gifHeader)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.format).toBe("gif")

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })

    test("detects BMP by magic bytes", async () => {
      // BMP magic bytes: 42 4D (BM)
      const bmpHeader = Buffer.from([
        0x42,
        0x4d, // "BM"
        0x46,
        0x00,
        0x00,
        0x00, // file size
        0x00,
        0x00, // reserved
        0x00,
        0x00, // reserved
        0x36,
        0x00,
        0x00,
        0x00, // offset to pixel data
      ])

      const filePath = path.join(TEMP_DIR, `magic-bmp-${Date.now()}.dat`)
      await Bun.write(filePath, bmpHeader)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.format).toBe("bmp")

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })
  })

  describe("metadata structure", () => {
    test("returns complete metadata structure on failure", async () => {
      const result = await ImageExplorer.explore({
        filePath: "/non/existent/file.png",
      })

      expect(result.metadata).toEqual({
        format: "unknown",
        width: 0,
        height: 0,
        sizeBytes: 0,
        colorSpace: "unknown",
        hasAlpha: false,
        animated: false,
      })
    })

    test("returns valid metadata structure on success", async () => {
      const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping metadata structure test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.metadata).toHaveProperty("format")
      expect(result.metadata).toHaveProperty("width")
      expect(result.metadata).toHaveProperty("height")
      expect(result.metadata).toHaveProperty("sizeBytes")
      expect(result.metadata).toHaveProperty("colorSpace")
      expect(result.metadata).toHaveProperty("hasAlpha")
      expect(result.metadata).toHaveProperty("animated")
    })
  })

  describe("color space detection", () => {
    test("detects RGB color space in PNG", async () => {
      // Create a minimal PNG with RGB color type (2)
      const pngRgb = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR chunk length
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
        0x00,
        0x00,
        0x00,
        0x01, // width: 1
        0x00,
        0x00,
        0x00,
        0x01, // height: 1
        0x08, // bit depth: 8
        0x02, // color type: RGB (no alpha)
        0x00,
        0x00,
        0x00, // compression, filter, interlace
        0x90,
        0x77,
        0x53,
        0xde, // CRC
      ])

      const filePath = path.join(TEMP_DIR, `rgb-png-${Date.now()}.png`)
      await Bun.write(filePath, pngRgb)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.colorSpace).toBe("rgb")
      expect(result.metadata.hasAlpha).toBe(false)

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })

    test("detects RGBA color space in PNG", async () => {
      // Create a minimal PNG with RGBA color type (6)
      const pngRgba = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR chunk length
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
        0x00,
        0x00,
        0x00,
        0x01, // width: 1
        0x00,
        0x00,
        0x00,
        0x01, // height: 1
        0x08, // bit depth: 8
        0x06, // color type: RGBA (with alpha)
        0x00,
        0x00,
        0x00, // compression, filter, interlace
        0xf9,
        0xcb,
        0x5d,
        0x75, // CRC (recalculated)
      ])

      const filePath = path.join(TEMP_DIR, `rgba-png-${Date.now()}.png`)
      await Bun.write(filePath, pngRgba)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.colorSpace).toBe("rgba")
      expect(result.metadata.hasAlpha).toBe(true)

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })

    test("detects grayscale color space in PNG", async () => {
      // Create a minimal PNG with grayscale color type (0)
      const pngGray = Buffer.from([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a, // PNG signature
        0x00,
        0x00,
        0x00,
        0x0d, // IHDR chunk length
        0x49,
        0x48,
        0x44,
        0x52, // "IHDR"
        0x00,
        0x00,
        0x00,
        0x01, // width: 1
        0x00,
        0x00,
        0x00,
        0x01, // height: 1
        0x08, // bit depth: 8
        0x00, // color type: Grayscale
        0x00,
        0x00,
        0x00, // compression, filter, interlace
        0x3a,
        0x7e,
        0x9b,
        0x55, // CRC (placeholder)
      ])

      const filePath = path.join(TEMP_DIR, `gray-png-${Date.now()}.png`)
      await Bun.write(filePath, pngGray)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.colorSpace).toBe("grayscale")
      expect(result.metadata.hasAlpha).toBe(false)

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })
  })

  describe("summary formatting", () => {
    test("summary includes file name", async () => {
      const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping summary file name test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("large-image.png")
    })

    test("summary includes format information", async () => {
      const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping summary format test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Format:")
      expect(result.summary).toContain("PNG")
    })

    test("summary includes dimensions", async () => {
      const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping summary dimensions test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Dimensions:")
      expect(result.summary).toMatch(/\d+ . \d+ pixels/)
    })

    test("summary includes size", async () => {
      const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping summary size test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Size:")
      // Should be KB or MB for the large image
      expect(result.summary).toMatch(/Size: \d+(\.\d+)? (bytes|KB|MB)/)
    })
  })

  describe("SVG detection", () => {
    test("detects SVG by xml header", async () => {
      const svgContent = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
  <rect width="100" height="100" fill="red"/>
</svg>`

      const filePath = path.join(TEMP_DIR, `test-svg-${Date.now()}.dat`)
      await Bun.write(filePath, svgContent)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.format).toBe("svg")

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })

    test("detects SVG by svg tag", async () => {
      const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50">
  <circle cx="25" cy="25" r="20" fill="blue"/>
</svg>`

      const filePath = path.join(TEMP_DIR, `test-svg2-${Date.now()}.dat`)
      await Bun.write(filePath, svgContent)

      const result = await ImageExplorer.explore({ filePath })

      expect(result.metadata.format).toBe("svg")

      // Clean up
      try {
        const fs = await import("fs")
        fs.unlinkSync(filePath)
      } catch {
        // Ignore
      }
    })
  })

  describe("token estimation", () => {
    test("token count is positive for successful exploration", async () => {
      const pngFixturePath = path.join(FIXTURES_DIR, "large-image.png")
      const exists = await Bun.file(pngFixturePath).exists()
      if (!exists) {
        console.log("Skipping token count test - fixture not available")
        return
      }

      const result = await ImageExplorer.explore({ filePath: pngFixturePath })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    test("token count is zero for failed exploration", async () => {
      const result = await ImageExplorer.explore({
        filePath: "/non/existent/file.png",
      })

      expect(result.success).toBe(false)
      expect(result.tokenCount).toBe(0)
    })
  })
})
