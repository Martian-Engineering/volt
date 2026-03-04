import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { QuestionTool } from "../../src/tool/question"
import * as QuestionModule from "../../src/question"

const ctx = {
  sessionID: "test-session",
  messageID: "test-message",
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  metadata: () => {},
  ask: async () => {},
}

describe("tool.question", () => {
  let askSpy: any

  beforeEach(() => {
    askSpy = spyOn(QuestionModule.Question, "ask").mockImplementation(async () => {
      return []
    })
  })

  afterEach(() => {
    askSpy.mockRestore()
  })

  test("should successfully execute with valid question parameters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite color?",
        header: "Color",
        options: [
          { label: "Red", description: "The color of passion" },
          { label: "Blue", description: "The color of sky" },
        ],
        multiple: false,
      },
    ]

    askSpy.mockResolvedValueOnce([["Red"]])

    const result = await tool.execute({ questions }, ctx)
    expect(askSpy).toHaveBeenCalledTimes(1)
    expect(result.title).toBe("Asked 1 question")
  })

  test("should now pass with a header longer than 12 but less than 30 chars", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Over 12",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]

    askSpy.mockResolvedValueOnce([["Dog"]])

    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })

  test("should execute with header exceeding 30 characters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "What is your favorite animal?",
        header: "This Header is Definitely More Than Thirty Characters Long",
        options: [{ label: "Dog", description: "Man's best friend" }],
      },
    ]
    askSpy.mockResolvedValueOnce([["Dog"]])
    const result = await tool.execute({ questions }, ctx)
    expect(result.output).toContain(`"What is your favorite animal?"="Dog"`)
  })

  test("should execute with label exceeding 30 characters", async () => {
    const tool = await QuestionTool.init()
    const questions = [
      {
        question: "A question with a very long label",
        header: "Long Label",
        options: [
          { label: "This is a very, very, very long label that will exceed the limit", description: "A description" },
        ],
      },
    ]
    askSpy.mockResolvedValueOnce([["This is a very, very, very long label that will exceed the limit"]])
    const result = await tool.execute({ questions }, ctx)
    expect(result.title).toBe("Asked 1 question")
  })
})
