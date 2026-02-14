import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../../src/session/prompt"
import { Log } from "../../../src/util/log"

Log.init({ print: false })

describe("stripLcmMarkers", () => {
  test("strips [Patch: /path/to/file1, /path/to/file2] from content", () => {
    const content = "Here is some text [Patch: /path/to/file1, /path/to/file2] and more text"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Here is some text  and more text")
  })

  test("strips single-path Patch markers", () => {
    const content = "[Patch: /src/index.ts] updated the file"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("updated the file")
  })

  test('strips <file path="foo.ts" mime="text/plain" /> tags', () => {
    const content = 'Before <file path="foo.ts" mime="text/plain" /> After'
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Before  After")
  })

  test("strips <compaction /> tags", () => {
    const content = "Start <compaction /> End"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Start  End")
  })

  test("strips <compaction/> without space", () => {
    const content = "Start <compaction/> End"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Start  End")
  })

  test('strips <subtask agent="explore">prompt text</subtask> tags', () => {
    const content = 'Before <subtask agent="explore">Search for the config file</subtask> After'
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Before  After")
  })

  test("strips subtask tags with multiline content", () => {
    const content = 'Text <subtask agent="code">Line 1\nLine 2\nLine 3</subtask> more text'
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Text  more text")
  })

  test("collapses 3+ consecutive newlines to 2", () => {
    const content = "Line 1\n\n\n\nLine 2"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("Line 1\n\nLine 2")
  })

  test("collapses many consecutive newlines to 2", () => {
    const content = "A\n\n\n\n\n\n\nB"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("A\n\nB")
  })

  test("preserves exactly 2 newlines", () => {
    const content = "A\n\nB"
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("A\n\nB")
  })

  test("trims whitespace", () => {
    const content = "  hello world  "
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("hello world")
  })

  test("handles content with multiple markers mixed with real text", () => {
    const content = [
      "[Patch: /src/a.ts, /src/b.ts]",
      "I made changes to the files.",
      '<file path="src/a.ts" mime="text/plain" />',
      "Here is the updated code.",
      "<compaction />",
      '<subtask agent="explore">find the bug</subtask>',
      "The bug was in the parser.",
    ].join("\n")
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("I made changes to the files.\n\nHere is the updated code.\n\nThe bug was in the parser.")
  })

  test("returns empty string when content is only markers", () => {
    const content =
      '[Patch: /file.ts]\n<file path="x.ts" mime="text/plain" />\n<compaction />\n<subtask agent="explore">do stuff</subtask>'
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toBe("")
  })

  test("preserves <tool> tags (they should NOT be stripped)", () => {
    const content = `Some text <tool name="read">
Input: {"path": "/file.txt"}
Output: Content
</tool> more text`
    const result = SessionPrompt.stripLcmMarkers(content)
    expect(result).toContain("<tool")
    expect(result).toContain("</tool>")
    expect(result).toBe(content)
  })

  test("handles empty string input", () => {
    const result = SessionPrompt.stripLcmMarkers("")
    expect(result).toBe("")
  })
})
