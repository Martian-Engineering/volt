import { Log } from "@/util/log"
import { Token } from "@/util/token"
import { $ } from "bun"
import path from "path"

/**
 * Image File Exploration Agent
 *
 * Analyzes image files to extract metadata including dimensions, format,
 * color information, EXIF data, and other properties.
 */
export namespace ImageExplorer {
  const log = Log.create({ service: "lcm.explore.image" })

  /**
   * Supported image formats
   */
  export type ImageFormat =
    | "jpeg"
    | "png"
    | "gif"
    | "webp"
    | "bmp"
    | "tiff"
    | "svg"
    | "ico"
    | "heic"
    | "avif"
    | "raw"
    | "psd"
    | "unknown"

  /**
   * Color space information
   */
  export type ColorSpace = "rgb" | "rgba" | "grayscale" | "cmyk" | "indexed" | "unknown"

  /**
   * EXIF metadata (common fields)
   */
  export interface ExifData {
    camera?: string
    lens?: string
    dateTime?: string
    exposureTime?: string
    fNumber?: string
    iso?: number
    focalLength?: string
    gpsLatitude?: number
    gpsLongitude?: number
    software?: string
    copyright?: string
    artist?: string
  }

  /**
   * Metadata about the image
   */
  export interface ImageMetadata {
    /** Image format */
    format: ImageFormat
    /** Width in pixels */
    width: number
    /** Height in pixels */
    height: number
    /** File size in bytes */
    sizeBytes: number
    /** Bit depth per channel */
    bitDepth?: number
    /** Color space */
    colorSpace: ColorSpace
    /** Number of channels */
    channels?: number
    /** Whether the image has an alpha channel */
    hasAlpha: boolean
    /** Whether the image is animated (GIF, WebP, APNG) */
    animated: boolean
    /** Number of frames if animated */
    frameCount?: number
    /** DPI/PPI if available */
    dpi?: { x: number; y: number }
    /** EXIF data if available */
    exif?: ExifData
    /** ICC color profile name */
    colorProfile?: string
    /** Compression type */
    compression?: string
  }

  /**
   * Result of image exploration
   */
  export interface ImageExplorationResult {
    /** Whether the exploration succeeded */
    success: boolean
    /** Formatted structure summary */
    summary: string
    /** Structured metadata about the image */
    metadata: ImageMetadata
    /** Estimated token count for the summary */
    tokenCount: number
    /** Error message if exploration failed */
    error?: string
  }

  /**
   * Image magic bytes signatures
   */
  const MAGIC_SIGNATURES: { magic: Buffer; format: ImageFormat }[] = [
    { magic: Buffer.from([0xff, 0xd8, 0xff]), format: "jpeg" },
    { magic: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), format: "png" },
    { magic: Buffer.from("GIF87a"), format: "gif" },
    { magic: Buffer.from("GIF89a"), format: "gif" },
    { magic: Buffer.from("RIFF"), format: "webp" }, // WebP starts with RIFF...WEBP
    { magic: Buffer.from([0x42, 0x4d]), format: "bmp" },
    { magic: Buffer.from([0x49, 0x49, 0x2a, 0x00]), format: "tiff" }, // Little-endian
    { magic: Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), format: "tiff" }, // Big-endian
    { magic: Buffer.from([0x00, 0x00, 0x01, 0x00]), format: "ico" },
  ]

  /**
   * Run a shell command and return stdout, or empty string on error
   */
  async function runCommand(cmd: string[]): Promise<string> {
    try {
      const result = await $`${cmd}`.quiet().text()
      return result.trim()
    } catch {
      return ""
    }
  }

  /**
   * Detect image format from file content
   */
  async function detectFormat(filePath: string): Promise<ImageFormat> {
    const ext = path.extname(filePath).toLowerCase().slice(1)

    // Extension-based detection for formats hard to detect by magic
    const extMap: Record<string, ImageFormat> = {
      jpg: "jpeg",
      jpeg: "jpeg",
      png: "png",
      gif: "gif",
      webp: "webp",
      bmp: "bmp",
      tif: "tiff",
      tiff: "tiff",
      svg: "svg",
      ico: "ico",
      heic: "heic",
      heif: "heic",
      avif: "avif",
      psd: "psd",
      raw: "raw",
      cr2: "raw",
      nef: "raw",
      arw: "raw",
      dng: "raw",
    }

    if (extMap[ext]) return extMap[ext]

    // Try magic byte detection
    const file = Bun.file(filePath)
    const header = Buffer.from(await file.slice(0, 16).arrayBuffer())

    for (const { magic, format } of MAGIC_SIGNATURES) {
      if (header.subarray(0, magic.length).equals(magic)) {
        return format
      }
    }

    // Check for WebP (RIFF....WEBP)
    if (header.subarray(0, 4).equals(Buffer.from("RIFF")) && header.subarray(8, 12).equals(Buffer.from("WEBP"))) {
      return "webp"
    }

    // Check for SVG (text-based)
    const text = header.toString("utf-8")
    if (text.includes("<svg") || text.includes("<?xml")) {
      return "svg"
    }

    return "unknown"
  }

  /**
   * Parse PNG metadata from chunks
   */
  async function parsePngMetadata(filePath: string): Promise<Partial<ImageMetadata>> {
    const file = Bun.file(filePath)
    const buffer = Buffer.from(await file.arrayBuffer())

    // PNG IHDR chunk starts at byte 8
    if (buffer.length < 24) return {}

    // Read IHDR chunk
    const width = buffer.readUInt32BE(16)
    const height = buffer.readUInt32BE(20)
    const bitDepth = buffer[24]
    const colorType = buffer[25]

    let colorSpace: ColorSpace = "unknown"
    let channels = 0
    let hasAlpha = false

    switch (colorType) {
      case 0: // Grayscale
        colorSpace = "grayscale"
        channels = 1
        break
      case 2: // RGB
        colorSpace = "rgb"
        channels = 3
        break
      case 3: // Indexed
        colorSpace = "indexed"
        channels = 1
        break
      case 4: // Grayscale + Alpha
        colorSpace = "grayscale"
        channels = 2
        hasAlpha = true
        break
      case 6: // RGBA
        colorSpace = "rgba"
        channels = 4
        hasAlpha = true
        break
    }

    // Check for animation (acTL chunk)
    const animated = buffer.includes(Buffer.from("acTL"))

    return {
      width,
      height,
      bitDepth,
      colorSpace,
      channels,
      hasAlpha,
      animated,
    }
  }

  /**
   * Parse JPEG metadata
   */
  async function parseJpegMetadata(filePath: string): Promise<Partial<ImageMetadata>> {
    const file = Bun.file(filePath)
    const buffer = Buffer.from(await file.slice(0, 65536).arrayBuffer())

    let width = 0
    let height = 0
    let bitDepth = 8
    let channels = 3
    let offset = 2

    while (offset < buffer.length - 4) {
      if (buffer[offset] !== 0xff) break

      const marker = buffer[offset + 1]

      // SOF markers (Start of Frame)
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb
      ) {
        bitDepth = buffer[offset + 4]
        height = buffer.readUInt16BE(offset + 5)
        width = buffer.readUInt16BE(offset + 7)
        channels = buffer[offset + 9]
        break
      }

      // Skip to next marker
      const length = buffer.readUInt16BE(offset + 2)
      offset += 2 + length
    }

    return {
      width,
      height,
      bitDepth,
      channels,
      colorSpace: channels === 1 ? "grayscale" : "rgb",
      hasAlpha: false,
    }
  }

  /**
   * Try to get metadata using ImageMagick identify command
   */
  async function getImageMagickMetadata(filePath: string): Promise<Partial<ImageMetadata>> {
    // Try to get basic info with identify
    const output = await runCommand(["identify", "-format", "%w %h %z %[channels] %[colorspace] %n", filePath])

    if (!output) return {}

    const parts = output.split(" ")
    if (parts.length < 4) return {}

    const [widthStr, heightStr, depthStr, channelsStr, colorspaceStr, framesStr] = parts

    const metadata: Partial<ImageMetadata> = {
      width: parseInt(widthStr) || 0,
      height: parseInt(heightStr) || 0,
      bitDepth: parseInt(depthStr) || 8,
    }

    if (colorspaceStr) {
      const cs = colorspaceStr.toLowerCase()
      if (cs.includes("gray")) metadata.colorSpace = "grayscale"
      else if (cs.includes("cmyk")) metadata.colorSpace = "cmyk"
      else if (cs.includes("rgba") || channelsStr?.includes("a")) {
        metadata.colorSpace = "rgba"
        metadata.hasAlpha = true
      } else if (cs.includes("rgb")) metadata.colorSpace = "rgb"
    }

    if (framesStr && parseInt(framesStr) > 1) {
      metadata.animated = true
      metadata.frameCount = parseInt(framesStr)
    }

    return metadata
  }

  /**
   * Try to get EXIF data using exiftool
   */
  async function getExifData(filePath: string): Promise<ExifData | undefined> {
    const output = await runCommand([
      "exiftool",
      "-json",
      "-Camera",
      "-Lens",
      "-DateTimeOriginal",
      "-ExposureTime",
      "-FNumber",
      "-ISO",
      "-FocalLength",
      "-GPSLatitude",
      "-GPSLongitude",
      "-Software",
      "-Copyright",
      "-Artist",
      filePath,
    ])

    if (!output) return undefined

    try {
      const data = JSON.parse(output)
      if (!data || !data[0]) return undefined

      const d = data[0]
      const exif: ExifData = {}

      if (d.Camera) exif.camera = d.Camera
      if (d.Lens) exif.lens = d.Lens
      if (d.DateTimeOriginal) exif.dateTime = d.DateTimeOriginal
      if (d.ExposureTime) exif.exposureTime = d.ExposureTime
      if (d.FNumber) exif.fNumber = String(d.FNumber)
      if (d.ISO) exif.iso = d.ISO
      if (d.FocalLength) exif.focalLength = d.FocalLength
      if (d.GPSLatitude) exif.gpsLatitude = d.GPSLatitude
      if (d.GPSLongitude) exif.gpsLongitude = d.GPSLongitude
      if (d.Software) exif.software = d.Software
      if (d.Copyright) exif.copyright = d.Copyright
      if (d.Artist) exif.artist = d.Artist

      return Object.keys(exif).length > 0 ? exif : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Format the image summary
   */
  function formatSummary(filePath: string, metadata: ImageMetadata): string {
    const lines: string[] = []
    const fileName = filePath.split("/").pop() ?? filePath

    lines.push(`File: ${fileName}`)
    lines.push(`Format: ${formatFormatName(metadata.format)}`)
    lines.push(`Dimensions: ${metadata.width} × ${metadata.height} pixels`)
    lines.push(`Size: ${formatSize(metadata.sizeBytes)}`)

    if (metadata.bitDepth) {
      lines.push(`Bit Depth: ${metadata.bitDepth} bits/channel`)
    }

    lines.push(`Color Space: ${formatColorSpace(metadata.colorSpace)}`)

    if (metadata.channels) {
      lines.push(`Channels: ${metadata.channels}${metadata.hasAlpha ? " (with alpha)" : ""}`)
    }

    if (metadata.animated) {
      lines.push(`Animated: yes${metadata.frameCount ? ` (${metadata.frameCount} frames)` : ""}`)
    }

    if (metadata.dpi) {
      lines.push(`Resolution: ${metadata.dpi.x} × ${metadata.dpi.y} DPI`)
    }

    if (metadata.compression) {
      lines.push(`Compression: ${metadata.compression}`)
    }

    if (metadata.colorProfile) {
      lines.push(`Color Profile: ${metadata.colorProfile}`)
    }

    if (metadata.exif) {
      lines.push("")
      lines.push("EXIF Data:")
      if (metadata.exif.camera) lines.push(`  Camera: ${metadata.exif.camera}`)
      if (metadata.exif.lens) lines.push(`  Lens: ${metadata.exif.lens}`)
      if (metadata.exif.dateTime) lines.push(`  Date: ${metadata.exif.dateTime}`)
      if (metadata.exif.exposureTime) lines.push(`  Exposure: ${metadata.exif.exposureTime}`)
      if (metadata.exif.fNumber) lines.push(`  Aperture: f/${metadata.exif.fNumber}`)
      if (metadata.exif.iso) lines.push(`  ISO: ${metadata.exif.iso}`)
      if (metadata.exif.focalLength) lines.push(`  Focal Length: ${metadata.exif.focalLength}`)
      if (metadata.exif.gpsLatitude && metadata.exif.gpsLongitude) {
        lines.push(`  GPS: ${metadata.exif.gpsLatitude}, ${metadata.exif.gpsLongitude}`)
      }
      if (metadata.exif.software) lines.push(`  Software: ${metadata.exif.software}`)
      if (metadata.exif.artist) lines.push(`  Artist: ${metadata.exif.artist}`)
      if (metadata.exif.copyright) lines.push(`  Copyright: ${metadata.exif.copyright}`)
    }

    return lines.join("\n")
  }

  /**
   * Get human-readable format name
   */
  function formatFormatName(format: ImageFormat): string {
    switch (format) {
      case "jpeg":
        return "JPEG"
      case "png":
        return "PNG"
      case "gif":
        return "GIF"
      case "webp":
        return "WebP"
      case "bmp":
        return "BMP (Bitmap)"
      case "tiff":
        return "TIFF"
      case "svg":
        return "SVG (Vector)"
      case "ico":
        return "ICO (Icon)"
      case "heic":
        return "HEIC/HEIF"
      case "avif":
        return "AVIF"
      case "raw":
        return "RAW (Camera)"
      case "psd":
        return "PSD (Photoshop)"
      default:
        return "Unknown Image"
    }
  }

  /**
   * Format color space name
   */
  function formatColorSpace(colorSpace: ColorSpace): string {
    switch (colorSpace) {
      case "rgb":
        return "RGB"
      case "rgba":
        return "RGBA"
      case "grayscale":
        return "Grayscale"
      case "cmyk":
        return "CMYK"
      case "indexed":
        return "Indexed (Palette)"
      default:
        return "Unknown"
    }
  }

  /**
   * Format file size
   */
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  /**
   * Explore an image file and produce a structured summary.
   */
  export async function explore(input: { filePath: string }): Promise<ImageExplorationResult> {
    log.info("exploring image file", { filePath: input.filePath })

    const file = Bun.file(input.filePath)
    const exists = await file.exists()
    if (!exists) {
      log.warn("image file not found", { filePath: input.filePath })
      return createErrorResult(`File not found: ${input.filePath}`)
    }

    try {
      const stat = await file.stat()
      const format = await detectFormat(input.filePath)

      // Start with default metadata
      let metadata: ImageMetadata = {
        format,
        width: 0,
        height: 0,
        sizeBytes: stat.size,
        colorSpace: "unknown",
        hasAlpha: false,
        animated: false,
      }

      // Try format-specific parsing first
      let parsedMeta: Partial<ImageMetadata> = {}

      switch (format) {
        case "png":
          parsedMeta = await parsePngMetadata(input.filePath)
          break
        case "jpeg":
          parsedMeta = await parseJpegMetadata(input.filePath)
          break
        default:
          // Try ImageMagick for other formats
          parsedMeta = await getImageMagickMetadata(input.filePath)
      }

      // If we didn't get dimensions, try ImageMagick as fallback
      if (!parsedMeta.width || !parsedMeta.height) {
        const imMeta = await getImageMagickMetadata(input.filePath)
        parsedMeta = { ...parsedMeta, ...imMeta }
      }

      // Merge parsed metadata
      metadata = { ...metadata, ...parsedMeta }

      // Try to get EXIF data for photos
      if (["jpeg", "tiff", "raw", "heic"].includes(format)) {
        metadata.exif = await getExifData(input.filePath)
      }

      const summary = formatSummary(input.filePath, metadata)
      const tokenCount = Token.estimate(summary)

      log.info("image exploration complete", {
        filePath: input.filePath,
        format,
        width: metadata.width,
        height: metadata.height,
        tokenCount,
      })

      return {
        success: true,
        summary,
        metadata,
        tokenCount,
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      log.error("failed to explore image", { filePath: input.filePath, error: errorMessage })
      return createErrorResult(`Failed to explore image: ${errorMessage}`)
    }
  }

  /**
   * Create an error result
   */
  function createErrorResult(error: string): ImageExplorationResult {
    return {
      success: false,
      summary: "",
      metadata: {
        format: "unknown",
        width: 0,
        height: 0,
        sizeBytes: 0,
        colorSpace: "unknown",
        hasAlpha: false,
        animated: false,
      },
      tokenCount: 0,
      error,
    }
  }
}
