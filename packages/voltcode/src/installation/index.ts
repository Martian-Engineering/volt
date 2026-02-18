import { BusEvent } from "@/bus/bus-event"
import { $ } from "bun"
import z from "zod"
import { NamedError } from "@opencode-ai/util/error"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"

declare global {
  const VOLTCODE_VERSION: string
  const VOLTCODE_CHANNEL: string
}

export namespace Installation {
  const log = Log.create({ service: "installation" })

  export type Method = Awaited<ReturnType<typeof method>>

  export const Event = {
    Updated: BusEvent.define(
      "installation.updated",
      z.object({
        version: z.string(),
      }),
    ),
    UpdateAvailable: BusEvent.define(
      "installation.update-available",
      z.object({
        version: z.string(),
      }),
    ),
  }

  export const Info = z
    .object({
      version: z.string(),
      latest: z.string(),
    })
    .meta({
      ref: "InstallationInfo",
    })
  export type Info = z.infer<typeof Info>

  export async function info() {
    return {
      version: VERSION,
      latest: await latest(),
    }
  }

  export function isPreview() {
    return CHANNEL !== "latest"
  }

  export function isLocal() {
    return CHANNEL === "local"
  }

  export async function method() {
    return "curl" as const
  }

  export const UpgradeFailedError = NamedError.create(
    "UpgradeFailedError",
    z.object({
      stderr: z.string(),
    }),
  )

  export async function upgrade(_method: Method, target: string) {
    const result = await $`curl -fsSL https://www.voltropy.com/install | sh`.env({
      ...process.env,
      VOLT_VERSION: target,
    }).quiet().throws(false)
    if (result.exitCode !== 0) {
      throw new UpgradeFailedError({
        stderr: result.stderr.toString("utf8"),
      })
    }
    log.info("upgraded", {
      target,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    })
    await $`${process.execPath} --version`.nothrow().quiet().text()
  }

  export const VERSION = typeof VOLTCODE_VERSION === "string" ? VOLTCODE_VERSION : "local"
  export const CHANNEL = typeof VOLTCODE_CHANNEL === "string" ? VOLTCODE_CHANNEL : "local"
  export const USER_AGENT = `voltcode/${CHANNEL}/${VERSION}/${Flag.VOLTCODE_CLIENT}`

  export async function latest(_installMethod?: Method) {
    const platform = process.platform === "darwin" ? "darwin" : "linux"
    const arch = process.arch === "arm64" ? "arm64" : "amd64"
    const res = await fetch("https://api.voltropy.com/v1/bootstrap/download-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform, arch, version: "latest" }),
    })
    if (!res.ok) throw new Error(res.statusText)
    const data: any = await res.json()
    return (data.version as string).replace(/^v/, "")
  }
}
