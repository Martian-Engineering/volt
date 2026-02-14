import { describe, expect, test } from "bun:test"
import { Instance } from "../../../src/project/instance"
import { ToolRegistry } from "../../../src/tool/registry"
import { SystemPrompt } from "../../../src/session/system"
import { tmpdir } from "../../fixture/fixture"
import { ensureLcmReady } from "../../../src/session/lcm/runtime"
import { isEmbeddedPostgresSupported } from "../../../src/session/lcm/embedded-postgres"

const isLcmAvailable = isEmbeddedPostgresSupported() && (await ensureLcmReady().catch(() => false))

describe("session.lcm.availability", () => {
  if (!isLcmAvailable) {
    test.skip("Embedded PostgreSQL not available, skipping LCM availability test", () => {})
    return
  }

  test("lists LCM tools when database is configured at runtime", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        const toolListText = ids.join(", ")
        expect(toolListText).toContain("lcm_grep")
        expect(toolListText).toContain("lcm_expand")

        const lcmPrompt = (await SystemPrompt.lcm()).join("\n")
        expect(lcmPrompt).toContain("lcm_grep")
        expect(lcmPrompt).toContain("lcm_expand")
      },
    })
  })
})
