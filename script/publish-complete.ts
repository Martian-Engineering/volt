#!/usr/bin/env bun

import { Script } from "@opencode-ai/script"
import { $ } from "bun"

if (!Script.preview) {
  await $`gh release edit v${Script.version} --draft=false`
}

await $`bun install`

await $`gh release download --pattern "voltcode-linux-*64.tar.gz" --pattern "voltcode-darwin-*64.zip" -D dist`

await import(`../packages/voltcode/script/publish-registries.ts`)
