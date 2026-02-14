import { $ } from "bun"
import path from "path"

const rootPkgPath = path.resolve(import.meta.dir, "../../../package.json")
const rootPkg = await Bun.file(rootPkgPath).json()
const expectedBunVersion = rootPkg.packageManager?.split("@")[1]

if (!expectedBunVersion) {
  throw new Error("packageManager field not found in root package.json")
}

if (process.versions.bun !== expectedBunVersion) {
  throw new Error(`This script requires bun@${expectedBunVersion}, but you are using bun@${process.versions.bun}`)
}

const env = {
  VOLTCODE_CHANNEL: process.env["VOLTCODE_CHANNEL"],
  VOLTCODE_BUMP: process.env["VOLTCODE_BUMP"],
  VOLTCODE_VERSION: process.env["VOLTCODE_VERSION"],
}
const CHANNEL = await (async () => {
  if (env.VOLTCODE_CHANNEL) return env.VOLTCODE_CHANNEL
  if (env.VOLTCODE_BUMP) return "latest"
  if (env.VOLTCODE_VERSION && !env.VOLTCODE_VERSION.startsWith("0.0.0-")) return "latest"
  return await $`git branch --show-current`.text().then((x) => x.trim())
})()
const IS_PREVIEW = CHANNEL !== "latest"

const voltcodePkgPath = path.resolve(import.meta.dir, "../../voltcode/package.json")
const voltcodePkg = await Bun.file(voltcodePkgPath).json()

const VERSION = await (async () => {
  if (env.VOLTCODE_VERSION) return env.VOLTCODE_VERSION
  if (IS_PREVIEW)
    return `${voltcodePkg.version}-${CHANNEL}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`
  const version = await fetch("https://registry.npmjs.org/opencode-ai/latest")
    .then((res) => {
      if (!res.ok) throw new Error(res.statusText)
      return res.json()
    })
    .then((data: any) => data.version)
  const [major, minor, patch] = version.split(".").map((x: string) => Number(x) || 0)
  const t = env.VOLTCODE_BUMP?.toLowerCase()
  if (t === "major") return `${major + 1}.0.0`
  if (t === "minor") return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
})()

export const Script = {
  get channel() {
    return CHANNEL
  },
  get version() {
    return VERSION
  },
  get preview() {
    return IS_PREVIEW
  },
}
console.log(`voltcode script`, JSON.stringify(Script, null, 2))
