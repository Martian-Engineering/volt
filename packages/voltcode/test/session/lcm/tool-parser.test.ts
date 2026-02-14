import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../../src/session/prompt"
import { Log } from "../../../src/util/log"

Log.init({ print: false })

describe("parseToolTagsFromLcm", () => {
  test("parses basic tool tag with Output", () => {
    const content = `<tool name="read">
Input: {"path": "/tmp/file.txt"}
Output: File contents here
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("read")
    expect(result[0].input).toEqual({ path: "/tmp/file.txt" })
    expect(result[0].output).toBe("File contents here")
    expect(result[0].isError).toBe(false)
  })

  test("parses basic tool tag with Error", () => {
    const content = `<tool name="bash">
Input: {"command": "rm -rf /"}
Error: Permission denied
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("bash")
    expect(result[0].input).toEqual({ command: "rm -rf /" })
    expect(result[0].output).toBe("Permission denied")
    expect(result[0].isError).toBe(true)
  })

  test("parses multiple tool tags", () => {
    const content = `<tool name="read">
Input: {"path": "/a.txt"}
Output: Content A
</tool>
<tool name="write">
Input: {"path": "/b.txt", "content": "hello"}
Output: Success
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe("read")
    expect(result[1].name).toBe("write")
  })

  test("handles input containing literal Output: text", () => {
    const content = `<tool name="bash">
Input: {"command": "echo 'Output: test'"}
Output: Output: test
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("bash")
    expect(result[0].input).toEqual({ command: "echo 'Output: test'" })
    expect(result[0].output).toBe("Output: test")
    expect(result[0].isError).toBe(false)
  })

  test("handles input containing literal Error: text", () => {
    const content = `<tool name="bash">
Input: {"command": "grep 'Error: something' log.txt"}
Output: Error: something found on line 5
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].input).toEqual({ command: "grep 'Error: something' log.txt" })
    expect(result[0].output).toBe("Error: something found on line 5")
    expect(result[0].isError).toBe(false)
  })

  test("handles output containing literal </tool> text", () => {
    const content = `<tool name="read">
Input: {"path": "/code.ts"}
Output: const xml = "</tool>";
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].output).toBe('const xml = "</tool>";')
  })

  test("handles non-JSON input", () => {
    const content = `<tool name="ask">
Input: What is the weather?
Output: It's sunny
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].input).toBe("What is the weather?")
    expect(result[0].output).toBe("It's sunny")
  })

  test("handles multiline output", () => {
    const content = `<tool name="read">
Input: {"path": "/file.txt"}
Output: Line 1
Line 2
Line 3
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    expect(result[0].output).toBe("Line 1\nLine 2\nLine 3")
  })

  test("handles empty content", () => {
    const result = SessionPrompt.parseToolTagsFromLcm("")
    expect(result).toHaveLength(0)
  })

  test("handles content with no tool tags", () => {
    const result = SessionPrompt.parseToolTagsFromLcm("Just some text without tool tags")
    expect(result).toHaveLength(0)
  })

  test("handles malformed tool tag (no closing tag)", () => {
    const content = `<tool name="read">
Input: {"path": "/file.txt"}
Output: Content`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(0)
  })

  test("handles malformed tool tag (no Input:)", () => {
    const content = `<tool name="read">
{"path": "/file.txt"}
Output: Content
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(0)
  })

  test("uses last Output/Error marker when multiple exist in content", () => {
    // This tests the case where tool output itself contains an earlier Output: or Error:
    const content = `<tool name="bash">
Input: {"command": "cat log.txt"}
Output: Line 1
Output: The actual output starts here
</tool>`
    const result = SessionPrompt.parseToolTagsFromLcm(content)
    expect(result).toHaveLength(1)
    // Should use the LAST Output: marker
    expect(result[0].output).toBe("The actual output starts here")
  })
})

describe("stripToolTagsFromLcm", () => {
  test("strips single tool tag", () => {
    const content = `Before <tool name="read">
Input: {"path": "/file.txt"}
Output: Content
</tool> After`
    const result = SessionPrompt.stripToolTagsFromLcm(content)
    expect(result).toBe("Before After")
  })

  test("strips multiple tool tags", () => {
    const content = `Start <tool name="a">
Input: x
Output: y
</tool> Middle <tool name="b">
Input: z
Output: w
</tool> End`
    const result = SessionPrompt.stripToolTagsFromLcm(content)
    expect(result).toBe("Start Middle End")
  })

  test("handles content with no tool tags", () => {
    const content = "Just plain text"
    const result = SessionPrompt.stripToolTagsFromLcm(content)
    expect(result).toBe("Just plain text")
  })

  test("handles tool tag with </tool> in output", () => {
    const content = `Text <tool name="read">
Input: {"path": "/code.ts"}
Output: const xml = "</tool>";
</tool> More text`
    const result = SessionPrompt.stripToolTagsFromLcm(content)
    expect(result).toBe("Text More text")
  })

  test("handles empty content", () => {
    const result = SessionPrompt.stripToolTagsFromLcm("")
    expect(result).toBe("")
  })

  test("handles only tool tags", () => {
    const content = `<tool name="read">
Input: x
Output: y
</tool>`
    const result = SessionPrompt.stripToolTagsFromLcm(content)
    expect(result).toBe("")
  })
})
