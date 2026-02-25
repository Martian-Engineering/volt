import { describe, expect, test } from "bun:test"
import path from "path"

function decodeOutput(output: Uint8Array | null): string {
  if (!output) return ""
  return new TextDecoder().decode(output)
}

describe("session.lcm.runtime invalid mode startup", () => {
  test("invalid VOLTCODE_LCM_MODE fails startup initialization", () => {
    const packageRoot = path.resolve(import.meta.dir, "../../..")
    const startupProbe = 'import { ensureLcmReady } from "./src/session/lcm/runtime.ts"; await ensureLcmReady();'

    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", startupProbe],
      cwd: packageRoot,
      env: {
        ...process.env,
        VOLTCODE_LCM_MODE: "legacy",
      },
      stdout: "pipe",
      stderr: "pipe",
    })

    const combinedOutput = `${decodeOutput(result.stdout)}\n${decodeOutput(result.stderr)}`
    expect(result.exitCode).not.toBe(0)
    expect(combinedOutput).toContain("VOLTCODE_LCM_MODE")
  })
})
