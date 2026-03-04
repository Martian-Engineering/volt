import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("symbolic recursion", () => {
  test("VOLTCODE_PARENT_SESSION env var is set in bash tool", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { BashTool } = await import("../../src/tool/bash")
        const bash = await BashTool.init()

        const sessionID = "test-parent-session-123"
        const ctx = {
          sessionID,
          messageID: "",
          callID: "",
          agent: "test",
          abort: AbortSignal.any([]),
          metadata: () => {},
          ask: async () => {},
        }

        const result = await bash.execute(
          {
            command: "echo $VOLTCODE_PARENT_SESSION",
            description: "Echo parent session env var",
          },
          ctx,
        )

        expect(result.metadata.exit).toBe(0)
        expect(result.metadata.output.trim()).toBe(sessionID)
      },
    })
  })

  test("Session.fork clones parent messages into child session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create parent session
        const parentSession = await Session.create({ title: "Parent Session" })

        // Add a user message with a secret to the parent
        const userMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userMessageID,
          sessionID: parentSession.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          tools: {},
          mode: "",
          model: { providerID: "test", modelID: "test" },
        } as MessageV2.User)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessageID,
          sessionID: parentSession.id,
          type: "text",
          text: "The secret code is ALPHA-BRAVO-CHARLIE",
        } as MessageV2.TextPart)

        // Add an assistant message to the parent
        const assistantMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: assistantMessageID,
          sessionID: parentSession.id,
          role: "assistant",
          parentID: userMessageID,
          time: { created: Date.now() },
          agent: "coder",
          providerID: "test",
          modelID: "test",
          mode: "",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as MessageV2.Assistant)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: assistantMessageID,
          sessionID: parentSession.id,
          type: "text",
          text: "I have noted the secret code.",
        } as MessageV2.TextPart)

        // Fork the parent session (this is what happens when VOLTCODE_PARENT_SESSION is set)
        const childSession = await Session.fork({ sessionID: parentSession.id })

        // Verify child is a different session
        expect(childSession.id).not.toBe(parentSession.id)

        // Get messages from both sessions
        const parentMessages = await Session.messages({ sessionID: parentSession.id })
        const childMessages = await Session.messages({ sessionID: childSession.id })

        // Child should have the same number of messages as parent
        expect(childMessages.length).toBe(parentMessages.length)
        expect(childMessages.length).toBe(2)

        // Child's messages should contain the secret from parent
        const childUserMessage = childMessages.find((m) => m.info.role === "user")
        expect(childUserMessage).toBeDefined()
        const childTextPart = childUserMessage!.parts.find((p): p is MessageV2.TextPart => p.type === "text")
        expect(childTextPart?.text).toContain("ALPHA-BRAVO-CHARLIE")

        // Cleanup
        await Session.remove(parentSession.id)
        await Session.remove(childSession.id)
      },
    })
  })

  test("child session messages don't affect parent session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create parent session with one message
        const parentSession = await Session.create({ title: "Parent Session" })
        const userMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userMessageID,
          sessionID: parentSession.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          tools: {},
          mode: "",
          model: { providerID: "test", modelID: "test" },
        } as MessageV2.User)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: userMessageID,
          sessionID: parentSession.id,
          type: "text",
          text: "Parent message",
        } as MessageV2.TextPart)

        // Fork the parent session
        const childSession = await Session.fork({ sessionID: parentSession.id })

        // Add a new message to the child session
        const childMessageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: childMessageID,
          sessionID: childSession.id,
          role: "user",
          time: { created: Date.now() },
          agent: "user",
          tools: {},
          mode: "",
          model: { providerID: "test", modelID: "test" },
        } as MessageV2.User)
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: childMessageID,
          sessionID: childSession.id,
          type: "text",
          text: "Child-only message",
        } as MessageV2.TextPart)

        // Verify parent still has only 1 message
        const parentMessages = await Session.messages({ sessionID: parentSession.id })
        expect(parentMessages.length).toBe(1)

        // Verify child has 2 messages (1 cloned + 1 new)
        const childMessages = await Session.messages({ sessionID: childSession.id })
        expect(childMessages.length).toBe(2)

        // Verify parent doesn't have the child's new message
        const parentTexts = parentMessages.flatMap((m) =>
          m.parts.filter((p): p is MessageV2.TextPart => p.type === "text").map((p) => p.text),
        )
        expect(parentTexts).not.toContain("Child-only message")

        // Cleanup
        await Session.remove(parentSession.id)
        await Session.remove(childSession.id)
      },
    })
  })

  test("forked session can set parentID to maintain hierarchy", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Create parent session
        const parentSession = await Session.create({ title: "Parent Session" })

        // Fork and set parentID (this is what run.ts does)
        const childSession = await Session.fork({ sessionID: parentSession.id })
        await Session.setParent({ sessionID: childSession.id, parentID: parentSession.id })
        await Session.setTitle({ sessionID: childSession.id, title: "Child Session" })

        // Verify the relationship
        const updatedChild = await Session.get(childSession.id)
        expect(updatedChild?.parentID).toBe(parentSession.id)
        expect(updatedChild?.title).toBe("Child Session")

        // Cleanup
        await Session.remove(parentSession.id)
        await Session.remove(childSession.id)
      },
    })
  })
})
