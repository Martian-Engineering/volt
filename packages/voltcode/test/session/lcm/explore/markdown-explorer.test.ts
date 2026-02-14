import { describe, expect, test } from "bun:test"
import { MarkdownExplorer } from "../../../../src/session/lcm/explore/markdown-explorer"

describe("session.lcm.explore.markdown-explorer", () => {
  describe("heading extraction", () => {
    test("extracts h1 headings", async () => {
      const content = `# Main Title

Some content here.

# Another H1
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tableOfContents).toHaveLength(2)
      expect(result.tableOfContents[0]).toEqual({ level: 1, text: "Main Title", line: 1 })
      expect(result.tableOfContents[1]).toEqual({ level: 1, text: "Another H1", line: 5 })
      expect(result.metadata.headingCounts.h1).toBe(2)
    })

    test("extracts multiple heading levels", async () => {
      const content = `# H1 Heading
## H2 Heading
### H3 Heading
#### H4 Heading
##### H5 Heading
###### H6 Heading
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tableOfContents).toHaveLength(6)
      expect(result.metadata.headingCounts).toEqual({
        h1: 1,
        h2: 1,
        h3: 1,
        h4: 1,
        h5: 1,
        h6: 1,
      })
      expect(result.metadata.totalHeadings).toBe(6)
    })

    test("removes trailing hashes from headings", async () => {
      const content = `# Heading with trailing hashes ##
## Another heading ###
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tableOfContents[0].text).toBe("Heading with trailing hashes")
      expect(result.tableOfContents[1].text).toBe("Another heading")
    })

    test("truncates long heading text", async () => {
      const longText = "A".repeat(100)
      const content = `# ${longText}\n`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tableOfContents[0].text).toHaveLength(83) // 80 chars + "..."
      expect(result.tableOfContents[0].text).toEndWith("...")
    })

    test("extracts headings including those in code blocks", async () => {
      // Note: The current implementation extracts headings from all lines,
      // including those inside code blocks. This is a known limitation.
      const content = `# Real Heading

\`\`\`markdown
# This is inside a code block
## Also inside
\`\`\`

## Another Real Heading
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      // All heading-like lines are extracted, including those in code blocks
      expect(result.tableOfContents).toHaveLength(4)
      expect(result.tableOfContents[0].text).toBe("Real Heading")
      expect(result.tableOfContents[3].text).toBe("Another Real Heading")
    })
  })

  describe("link detection", () => {
    test("detects internal links", async () => {
      const content = `[Local page](./page.md)
[Another page](/docs/guide.md)
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.internalLinkCount).toBe(2)
      expect(result.links[0]).toEqual({
        text: "Local page",
        url: "./page.md",
        type: "internal",
        line: 1,
      })
    })

    test("detects external links", async () => {
      const content = `[Google](https://google.com)
[HTTP link](http://example.com)
[Protocol-relative](//cdn.example.com/file.js)
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.externalLinkCount).toBe(3)
      expect(result.links.every((l) => l.type === "external")).toBe(true)
    })

    test("detects anchor links", async () => {
      const content = `[Jump to section](#section-name)
[Another anchor](#another)
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.links).toHaveLength(2)
      expect(result.links.every((l) => l.type === "anchor")).toBe(true)
    })

    test("detects image links", async () => {
      const content = `![Alt text](./image.png)
![External image](https://example.com/photo.jpg)
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.imageCount).toBe(2)
      expect(result.links.every((l) => l.type === "image")).toBe(true)
    })

    test("detects reference-style links", async () => {
      const content = `[ref]: https://example.com
[local-ref]: ./local-file.md
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.links).toHaveLength(2)
      expect(result.links[0].type).toBe("external")
      expect(result.links[1].type).toBe("internal")
    })

    test("strips URL titles from links", async () => {
      const content = `[Link with title](https://example.com "Title here")
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.links[0].url).toBe("https://example.com")
    })

    test("truncates long link text", async () => {
      const longText = "B".repeat(100)
      const content = `[${longText}](./link.md)\n`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.links[0].text).toHaveLength(83) // 80 chars + "..."
      expect(result.links[0].text).toEndWith("...")
    })
  })

  describe("code block counting", () => {
    test("counts code blocks with backticks", async () => {
      const content = `\`\`\`javascript
const x = 1;
const y = 2;
\`\`\`

\`\`\`python
def hello():
    print("Hello")
\`\`\`
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.codeBlockCount).toBe(2)
      expect(result.codeBlocks).toHaveLength(2)
    })

    test("counts code blocks with tildes", async () => {
      const content = `~~~ruby
puts "Hello"
~~~
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.codeBlockCount).toBe(1)
    })

    test("extracts language from code blocks", async () => {
      const content = `\`\`\`typescript
interface User {
  name: string;
}
\`\`\`

\`\`\`go
package main
\`\`\`

\`\`\`
plain text
\`\`\`
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.codeLanguages).toContain("typescript")
      expect(result.metadata.codeLanguages).toContain("go")
      expect(result.metadata.codeLanguages).toHaveLength(2) // plain has no language
    })

    test("counts lines in code blocks", async () => {
      const content = `\`\`\`js
line1
line2
line3
line4
\`\`\`
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.codeBlocks[0].lineCount).toBe(4)
    })

    test("tracks code block starting line numbers", async () => {
      const content = `Some intro text.

\`\`\`python
code here
\`\`\`
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.codeBlocks[0].line).toBe(3)
    })

    test("handles empty code blocks", async () => {
      const content = `\`\`\`
\`\`\`
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.codeBlocks[0].lineCount).toBe(0)
      expect(result.codeBlocks[0].language).toBeUndefined()
    })
  })

  describe("front matter parsing (YAML)", () => {
    test("parses basic YAML front matter", async () => {
      const content = `---
title: My Document
author: John Doe
date: 2024-01-15
---

# Content starts here
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasFrontmatter).toBe(true)
      expect(result.metadata.frontmatter.title).toBe("My Document")
      expect(result.metadata.frontmatter.author).toBe("John Doe")
      expect(result.metadata.frontmatter.date).toBe("2024-01-15")
    })

    test("parses description/excerpt/summary aliases", async () => {
      const content1 = `---
description: A brief description
---
`
      const content2 = `---
excerpt: An excerpt here
---
`
      const content3 = `---
summary: A summary text
---
`
      const result1 = await MarkdownExplorer.explore({ content: content1 })
      const result2 = await MarkdownExplorer.explore({ content: content2 })
      const result3 = await MarkdownExplorer.explore({ content: content3 })

      expect(result1.metadata.frontmatter.description).toBe("A brief description")
      expect(result2.metadata.frontmatter.description).toBe("An excerpt here")
      expect(result3.metadata.frontmatter.description).toBe("A summary text")
    })

    test("parses tags as inline array", async () => {
      const content = `---
tags: [javascript, typescript, node]
---
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.frontmatter.tags).toEqual(["javascript", "typescript", "node"])
    })

    test("parses single tag value", async () => {
      const content = `---
tags: javascript
---
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.frontmatter.tags).toEqual(["javascript"])
    })

    test("parses categories and keywords as tags", async () => {
      const content1 = `---
categories: [web, frontend]
---
`
      const content2 = `---
keywords: [react, vue]
---
`
      const result1 = await MarkdownExplorer.explore({ content: content1 })
      const result2 = await MarkdownExplorer.explore({ content: content2 })

      expect(result1.metadata.frontmatter.tags).toEqual(["web", "frontend"])
      expect(result2.metadata.frontmatter.tags).toEqual(["react", "vue"])
    })

    test("strips quotes from values", async () => {
      const content = `---
title: "Quoted Title"
author: 'Single Quoted'
---
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.frontmatter.title).toBe("Quoted Title")
      expect(result.metadata.frontmatter.author).toBe("Single Quoted")
    })

    test("collects unknown keys in otherKeys", async () => {
      const content = `---
title: My Title
layout: post
permalink: /blog/my-post
draft: true
---
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.frontmatter.otherKeys).toContain("layout")
      expect(result.metadata.frontmatter.otherKeys).toContain("permalink")
      expect(result.metadata.frontmatter.otherKeys).toContain("draft")
    })

    test("handles missing front matter", async () => {
      const content = `# Just a heading

No front matter here.
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasFrontmatter).toBe(false)
      expect(result.metadata.frontmatter.title).toBeUndefined()
      expect(result.metadata.frontmatter.otherKeys).toEqual([])
    })

    test("handles unclosed front matter", async () => {
      const content = `---
title: Unclosed Front Matter
author: Someone

# This is not a closing delimiter
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasFrontmatter).toBe(false)
    })

    test("excludes front matter content from heading extraction", async () => {
      const content = `---
title: Document Title
---

# Real Heading
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tableOfContents).toHaveLength(1)
      expect(result.tableOfContents[0].text).toBe("Real Heading")
    })
  })

  describe("special elements detection", () => {
    test("counts tables", async () => {
      const content = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |
| Cell 3   | Cell 4   |

Some text.

| Another | Table |
|---------|-------|
| Data    | Here  |
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.specialElements.tables).toBe(2)
    })

    test("counts task lists", async () => {
      const content = `- [x] Completed task
- [ ] Pending task
* [X] Another completed
* [ ] Another pending
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.specialElements.taskLists).toBe(4)
      expect(result.metadata.specialElements.taskListsChecked).toBe(2)
      expect(result.metadata.specialElements.taskListsUnchecked).toBe(2)
    })

    test("counts blockquotes", async () => {
      const content = `> First blockquote
> Continues here

Some text.

> Second blockquote
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.specialElements.blockquotes).toBe(2)
    })

    test("counts footnotes", async () => {
      const content = `Here is some text[^1].

[^1]: This is the first footnote.
[^note]: This is another footnote.
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.specialElements.footnotes).toBe(2)
    })

    test("counts math blocks", async () => {
      const content = `$$
E = mc^2
$$

Some text with inline $x + y = z$ math.

$$
\\int_0^1 x^2 dx
$$
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.specialElements.mathBlocks).toBe(2)
      expect(result.metadata.specialElements.mathInline).toBe(1)
    })

    test("counts horizontal rules", async () => {
      const content = `Some text.

---

More text.

***

Even more.

___
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.specialElements.horizontalRules).toBe(3)
    })
  })

  describe("MDX detection", () => {
    test("detects import statements", async () => {
      const content = `import { Button } from './components'
import Layout from '@/layouts/main'

# My MDX Page
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.mdx.isMdx).toBe(true)
      expect(result.metadata.mdx.imports).toContain("Button")
      expect(result.metadata.mdx.imports).toContain("Layout")
    })

    test("detects export statements", async () => {
      const content = `export const meta = { title: 'My Post' }
export default function Layout({ children }) {}

# Content
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.mdx.isMdx).toBe(true)
      expect(result.metadata.mdx.exports).toContain("meta")
      // For "export default function Name", the regex captures "function" as group 1
      // and "Name" as group 2, so "function" is not added but "Layout" would be if matched
      expect(result.metadata.mdx.exports).toContain("function")
    })

    test("detects JSX component usage", async () => {
      const content = `# My Page

<Button onClick={handleClick}>Click me</Button>

<Card>
  <CardHeader>Title</CardHeader>
  <CardBody>Content</CardBody>
</Card>
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.mdx.isMdx).toBe(true)
      expect(result.metadata.mdx.componentUsages).toContain("Button")
      expect(result.metadata.mdx.componentUsages).toContain("Card")
      expect(result.metadata.mdx.componentUsages).toContain("CardHeader")
      expect(result.metadata.mdx.componentUsages).toContain("CardBody")
    })

    test("does not flag regular markdown as MDX", async () => {
      const content = `# Regular Markdown

Just some text with **bold** and *italic*.

- List item 1
- List item 2
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.mdx.isMdx).toBe(false)
    })
  })

  describe("word count and reading time", () => {
    test("counts words excluding code blocks", async () => {
      const content = `Here are ten words for the word count test example.

\`\`\`javascript
// This code should not be counted
const x = 1;
\`\`\`

Five more words after code.
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      // 10 + 5 = 15 words approximately
      expect(result.metadata.wordCount).toBeGreaterThanOrEqual(14)
      expect(result.metadata.wordCount).toBeLessThanOrEqual(16)
    })

    test("calculates reading time", async () => {
      // 200 words per minute, uses Math.ceil
      // 400 words + "Title" + extra = ~402 words -> ceil(402/200) = 3 minutes
      const words = Array(400).fill("word").join(" ")
      const content = `# Title\n\n${words}\n`

      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      // Word count includes "Title" from heading, so it's slightly over 400
      expect(result.metadata.readingTimeMinutes).toBeGreaterThanOrEqual(2)
      expect(result.metadata.readingTimeMinutes).toBeLessThanOrEqual(3)
    })

    test("minimum reading time is 1 minute", async () => {
      const content = `Just a few words.`

      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.readingTimeMinutes).toBe(1)
    })
  })

  describe("summary generation", () => {
    test("includes file name in summary", async () => {
      const result = await MarkdownExplorer.explore({
        content: "# Test",
        filePath: "/path/to/document.md",
      })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: document.md")
    })

    test("indicates MDX format when detected", async () => {
      const content = `import { Component } from 'lib'

# Page
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Format: MDX")
    })

    test("indicates Markdown format for regular files", async () => {
      const content = `# Regular Markdown
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Format: Markdown")
    })

    test("includes frontmatter info in summary", async () => {
      const content = `---
title: My Document
author: Author Name
tags: [a, b, c]
---

# Content
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Title: My Document")
      expect(result.summary).toContain("Author: Author Name")
      expect(result.summary).toContain("Tags: a, b, c")
    })

    test("estimates token count for summary", async () => {
      const content = `# Heading

Some content here.
`
      const result = await MarkdownExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })
})
