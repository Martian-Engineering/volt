import { dlopen, ptr } from "bun:ffi"

/**
 * Installs an fd-level interceptor that converts truecolor (24-bit) ANSI escape
 * sequences to 256-color equivalents.
 *
 * The OpenTUI native Zig renderer writes directly to fd 1 using the OS write()
 * syscall, bypassing Node/Bun's process.stdout entirely. Terminals like Apple
 * Terminal.app on pre-Tahoe macOS don't support truecolor escape sequences and
 * render them as garbage.
 *
 * Strategy:
 *   1. dup(1) to save the real stdout fd
 *   2. pipe() to create a pipe pair
 *   3. dup2(pipeWrite, 1) so all writes to fd 1 go into the pipe
 *   4. In-process async loop reads from the pipe, converts truecolor sequences
 *      to 256-color, and writes to the real stdout fd
 *
 * Converts:
 *   \x1B[38;2;R;G;Bm (fg) → \x1B[38;5;Xm
 *   \x1B[48;2;R;G;Bm (bg) → \x1B[48;5;Xm
 */
export function installTruecolorDowngrade() {
  if (process.platform !== "darwin" && process.platform !== "linux") return

  const libPath = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6"

  const libc = dlopen(libPath, {
    dup: { args: ["i32"], returns: "i32" },
    dup2: { args: ["i32", "i32"], returns: "i32" },
    pipe: { args: ["ptr"], returns: "i32" },
    close: { args: ["i32"], returns: "i32" },
  })

  // Save the real stdout fd
  const realStdoutFd = libc.symbols.dup(1) as number
  if (realStdoutFd < 0) {
    libc.close()
    return
  }

  // Create a pipe
  const pipeFds = new Int32Array(2)
  if ((libc.symbols.pipe(ptr(pipeFds)) as number) < 0) {
    libc.symbols.close(realStdoutFd)
    libc.close()
    return
  }
  const pipeReadFd = pipeFds[0]!
  const pipeWriteFd = pipeFds[1]!

  // Grab Bun.file handles before redirecting stdout
  const pipeReadFile = Bun.file("/dev/fd/" + pipeReadFd)
  const realStdoutFile = Bun.file("/dev/fd/" + realStdoutFd)

  // Redirect fd 1 to the pipe write end
  libc.symbols.dup2(pipeWriteFd, 1)
  libc.symbols.close(pipeWriteFd)

  // Close the original fds in the parent — Bun.file already holds references
  libc.symbols.close(pipeReadFd)
  libc.symbols.close(realStdoutFd)
  libc.close()

  // In-process async loop: read from pipe, convert truecolor → 256-color, write to real stdout.
  // Uses getReader() to avoid TypeScript async-iterator issues with ReadableStream.
  // Runs on the event loop between render ticks. The pipe buffer (64KB on macOS) provides
  // enough headroom for bursty Zig renderer writes.
  const re = /\x1B\[(38|48);2;(\d+);(\d+);(\d+)m/g
  const decoder = new TextDecoder()
  const reader = pipeReadFile.stream().getReader()

  ;(async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const str = decoder.decode(value, { stream: true })
        const converted = str.replace(re, (_, type, r, g, b) => {
          return "\x1B[" + type + ";5;" + rgbTo256(+r, +g, +b) + "m"
        })
        await Bun.write(realStdoutFile, converted)
      }
    } catch {
      // Pipe closed on exit — expected
    }
  })()
}

function rgbTo256(r: number, g: number, b: number): number {
  const isGray = Math.abs(r - g) < 10 && Math.abs(g - b) < 10 && Math.abs(r - b) < 10
  if (isGray) {
    const gray = Math.round((r + g + b) / 3)
    if (gray < 4) return 16
    if (gray > 243) return 231
    return Math.min(255, Math.max(232, 232 + Math.round((gray - 8) / 10)))
  }
  const c = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40)))
  return 16 + 36 * c(r) + 6 * c(g) + c(b)
}
