import { describe, expect, test } from "bun:test"
import { LatexExplorer } from "../../../../src/session/lcm/explore/latex-explorer"

describe("session.lcm.explore.latex-explorer", () => {
  describe("document class detection", () => {
    test("detects article document class", async () => {
      const content = `\\documentclass{article}
\\begin{document}
Hello world
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentClass).toBeDefined()
      expect(result.metadata.documentClass!.name).toBe("article")
      expect(result.metadata.documentClass!.options).toEqual([])
    })

    test("detects document class with options", async () => {
      const content = `\\documentclass[12pt, a4paper, twoside]{report}
\\begin{document}
Content
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentClass).toBeDefined()
      expect(result.metadata.documentClass!.name).toBe("report")
      expect(result.metadata.documentClass!.options).toContain("12pt")
      expect(result.metadata.documentClass!.options).toContain("a4paper")
      expect(result.metadata.documentClass!.options).toContain("twoside")
    })

    test("detects beamer document class", async () => {
      const content = `\\documentclass[aspectratio=169]{beamer}
\\begin{document}
\\begin{frame}
\\frametitle{Title}
\\end{frame}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "presentation.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentClass!.name).toBe("beamer")
      expect(result.metadata.documentClass!.options).toContain("aspectratio=169")
    })

    test("detects book document class with multiple options", async () => {
      const content = `\\documentclass[11pt, openright, fleqn]{book}
\\begin{document}
\\chapter{Introduction}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "book.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentClass!.name).toBe("book")
      expect(result.metadata.documentClass!.options).toHaveLength(3)
    })

    test("returns undefined documentClass when not present", async () => {
      const content = `% Just a style file
\\ProvidesPackage{mypackage}
\\newcommand{\\hello}{Hello}`

      const result = await LatexExplorer.explore({ content, filePath: "mypackage.sty" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentClass).toBeUndefined()
      expect(result.metadata.fileType).toBe("package")
    })
  })

  describe("package extraction", () => {
    test("extracts single package without options", async () => {
      const content = `\\documentclass{article}
\\usepackage{amsmath}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages).toHaveLength(1)
      expect(result.metadata.packages[0].name).toBe("amsmath")
      expect(result.metadata.packages[0].options).toEqual([])
      expect(result.metadata.packages[0].isCommon).toBe(true)
    })

    test("extracts package with options", async () => {
      const content = `\\documentclass{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages).toHaveLength(2)

      const inputenc = result.metadata.packages.find((p) => p.name === "inputenc")
      expect(inputenc).toBeDefined()
      expect(inputenc!.options).toContain("utf8")
      expect(inputenc!.isCommon).toBe(true)

      const geometry = result.metadata.packages.find((p) => p.name === "geometry")
      expect(geometry).toBeDefined()
      expect(geometry!.options).toContain("margin=1in")
    })

    test("extracts multiple packages from single usepackage command", async () => {
      const content = `\\documentclass{article}
\\usepackage{amsmath,amssymb,amsthm}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages).toHaveLength(3)

      const packageNames = result.metadata.packages.map((p) => p.name)
      expect(packageNames).toContain("amsmath")
      expect(packageNames).toContain("amssymb")
      expect(packageNames).toContain("amsthm")

      // All AMS packages should be marked as common
      result.metadata.packages.forEach((pkg) => {
        expect(pkg.isCommon).toBe(true)
      })
    })

    test("extracts RequirePackage from style files", async () => {
      const content = `\\ProvidesPackage{mypackage}
\\RequirePackage{xcolor}
\\RequirePackage[T1]{fontenc}
\\newcommand{\\hello}{Hello}`

      const result = await LatexExplorer.explore({ content, filePath: "mypackage.sty" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages).toHaveLength(2)

      const xcolor = result.metadata.packages.find((p) => p.name === "xcolor")
      expect(xcolor).toBeDefined()
      expect(xcolor!.isCommon).toBe(true)

      const fontenc = result.metadata.packages.find((p) => p.name === "fontenc")
      expect(fontenc).toBeDefined()
      expect(fontenc!.options).toContain("T1")
    })

    test("marks specialized packages as non-common", async () => {
      const content = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{my-custom-package}
\\usepackage{obscure-math-lib}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)

      const amsmath = result.metadata.packages.find((p) => p.name === "amsmath")
      expect(amsmath!.isCommon).toBe(true)

      const customPkg = result.metadata.packages.find((p) => p.name === "my-custom-package")
      expect(customPkg!.isCommon).toBe(false)

      const obscurePkg = result.metadata.packages.find((p) => p.name === "obscure-math-lib")
      expect(obscurePkg!.isCommon).toBe(false)
    })

    test("deduplicates packages", async () => {
      const content = `\\documentclass{article}
\\usepackage{amsmath}
\\usepackage{amsmath}
\\usepackage{graphicx}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages).toHaveLength(2)
    })
  })

  describe("section structure parsing", () => {
    test("counts sections correctly", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
Content here.
\\section{Methods}
More content.
\\section{Results}
Results here.
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.sections).toBe(3)
      expect(result.metadata.structure.subsections).toBe(0)
    })

    test("counts nested sections", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
\\subsection{Background}
\\subsection{Motivation}
\\section{Methods}
\\subsection{Data Collection}
\\subsubsection{Survey Design}
\\subsubsection{Sampling}
\\subsection{Analysis}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.sections).toBe(2)
      expect(result.metadata.structure.subsections).toBe(4)
      expect(result.metadata.structure.subsubsections).toBe(2)
    })

    test("counts chapters in book class", async () => {
      const content = `\\documentclass{book}
\\begin{document}
\\chapter{Getting Started}
\\section{Installation}
\\section{Configuration}
\\chapter{Advanced Topics}
\\section{Customization}
\\chapter{Reference}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "book.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.chapters).toBe(3)
      expect(result.metadata.structure.sections).toBe(3)
    })

    test("counts parts in large documents", async () => {
      const content = `\\documentclass{book}
\\begin{document}
\\part{Fundamentals}
\\chapter{Basics}
\\part{Advanced}
\\chapter{Expert Topics}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "thesis.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.parts).toBe(2)
      expect(result.metadata.structure.chapters).toBe(2)
    })

    test("counts starred sections", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\section*{Preface}
\\section{Introduction}
\\section*{Acknowledgments}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.sections).toBe(3)
    })

    test("counts paragraphs", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\section{Introduction}
\\paragraph{First Point}
Content.
\\paragraph{Second Point}
More content.
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.paragraphs).toBe(2)
    })

    test("returns zero counts for empty structure", async () => {
      const content = `\\documentclass{article}
\\begin{document}
Just plain text without any sections.
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.structure.parts).toBe(0)
      expect(result.metadata.structure.chapters).toBe(0)
      expect(result.metadata.structure.sections).toBe(0)
      expect(result.metadata.structure.subsections).toBe(0)
      expect(result.metadata.structure.subsubsections).toBe(0)
      expect(result.metadata.structure.paragraphs).toBe(0)
    })
  })

  describe("bibliography detection", () => {
    test("detects bibtex bibliography", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\cite{smith2020}
\\bibliographystyle{plain}
\\bibliography{references}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.bibliography.type).toBe("bibtex")
      expect(result.metadata.bibliography.files).toContain("references")
      expect(result.metadata.bibliography.style).toBe("plain")
    })

    test("detects bibtex with multiple bib files", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\bibliographystyle{apalike}
\\bibliography{refs1,refs2,refs3}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.bibliography.type).toBe("bibtex")
      expect(result.metadata.bibliography.files).toHaveLength(3)
      expect(result.metadata.bibliography.files).toContain("refs1")
      expect(result.metadata.bibliography.files).toContain("refs2")
      expect(result.metadata.bibliography.files).toContain("refs3")
      expect(result.metadata.bibliography.style).toBe("apalike")
    })

    test("detects biblatex with addbibresource", async () => {
      const content = `\\documentclass{article}
\\usepackage[style=authoryear]{biblatex}
\\addbibresource{main.bib}
\\addbibresource{secondary.bib}
\\begin{document}
\\cite{author2021}
\\printbibliography
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.bibliography.type).toBe("biblatex")
      expect(result.metadata.bibliography.files).toContain("main.bib")
      expect(result.metadata.bibliography.files).toContain("secondary.bib")
      expect(result.metadata.bibliography.style).toBe("authoryear")
    })

    test("detects biblatex with numeric style", async () => {
      const content = `\\documentclass{article}
\\usepackage[style=numeric-comp, sorting=none]{biblatex}
\\addbibresource{references.bib}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.bibliography.type).toBe("biblatex")
      expect(result.metadata.bibliography.style).toBe("numeric-comp")
    })

    test("detects thebibliography environment", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\begin{thebibliography}{9}
\\bibitem{lamport94}
  Leslie Lamport,
  \\textit{\\LaTeX: a document preparation system},
  Addison Wesley, 1994.
\\end{thebibliography}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.bibliography.type).toBe("thebibliography")
      expect(result.metadata.bibliography.files).toHaveLength(0)
    })

    test("returns none when no bibliography", async () => {
      const content = `\\documentclass{article}
\\begin{document}
No citations here.
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.bibliography.type).toBe("none")
      expect(result.metadata.bibliography.files).toHaveLength(0)
      expect(result.metadata.bibliography.style).toBeUndefined()
    })
  })

  describe("file type detection", () => {
    test("detects document type from documentclass", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "paper.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("document")
    })

    test("detects package type from .sty extension", async () => {
      const content = `\\newcommand{\\foo}{bar}`

      const result = await LatexExplorer.explore({ content, filePath: "mypackage.sty" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("package")
    })

    test("detects package type from ProvidesPackage", async () => {
      const content = `\\ProvidesPackage{mypackage}[2024/01/01 My Package]
\\newcommand{\\foo}{bar}`

      const result = await LatexExplorer.explore({ content, filePath: "mypackage.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("package")
    })

    test("detects class type from .cls extension", async () => {
      const content = `\\LoadClass{article}
\\newcommand{\\foo}{bar}`

      const result = await LatexExplorer.explore({ content, filePath: "myclass.cls" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("class")
    })

    test("detects class type from ProvidesClass", async () => {
      const content = `\\ProvidesClass{myclass}[2024/01/01 My Class]
\\LoadClass{article}`

      const result = await LatexExplorer.explore({ content, filePath: "myclass.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("class")
    })

    test("returns unknown for ambiguous files", async () => {
      const content = `% Just some LaTeX code
\\newcommand{\\foo}{bar}`

      const result = await LatexExplorer.explore({ content, filePath: "snippet.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("unknown")
    })
  })

  describe("custom commands extraction", () => {
    test("extracts newcommand definitions", async () => {
      const content = `\\documentclass{article}
\\newcommand{\\RR}{\\mathbb{R}}
\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.customCommands.length).toBeGreaterThanOrEqual(2)

      const rrCmd = result.metadata.customCommands.find((c) => c.name === "RR")
      expect(rrCmd).toBeDefined()
      expect(rrCmd!.type).toBe("newcommand")
      expect(rrCmd!.argCount).toBeUndefined()

      const normCmd = result.metadata.customCommands.find((c) => c.name === "norm")
      expect(normCmd).toBeDefined()
      expect(normCmd!.type).toBe("newcommand")
      expect(normCmd!.argCount).toBe(1)
    })

    test("extracts def macros", async () => {
      const content = `\\documentclass{article}
\\def\\foo{bar}
\\def\\myMacro{content}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)

      const fooCmd = result.metadata.customCommands.find((c) => c.name === "foo")
      expect(fooCmd).toBeDefined()
      expect(fooCmd!.type).toBe("def")
    })

    test("extracts newenvironment definitions", async () => {
      const content = `\\documentclass{article}
\\newenvironment{myenv}{\\begin{center}}{\\end{center}}
\\newenvironment{boxed}[1]{\\fbox{\\begin{minipage}{#1}}}{\\end{minipage}}}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)

      const myenvCmd = result.metadata.customCommands.find((c) => c.name === "myenv")
      expect(myenvCmd).toBeDefined()
      expect(myenvCmd!.type).toBe("newenvironment")

      const boxedCmd = result.metadata.customCommands.find((c) => c.name === "boxed")
      expect(boxedCmd).toBeDefined()
      expect(boxedCmd!.argCount).toBe(1)
    })
  })

  describe("included files extraction", () => {
    test("extracts input files", async () => {
      const content = `\\documentclass{article}
\\input{preamble}
\\input{chapters/intro}
\\begin{document}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "main.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.includedFiles).toHaveLength(2)

      const preamble = result.metadata.includedFiles.find((f) => f.path === "preamble")
      expect(preamble).toBeDefined()
      expect(preamble!.type).toBe("input")

      const intro = result.metadata.includedFiles.find((f) => f.path === "chapters/intro")
      expect(intro).toBeDefined()
      expect(intro!.type).toBe("input")
    })

    test("extracts include files", async () => {
      const content = `\\documentclass{book}
\\begin{document}
\\include{chapter1}
\\include{chapter2}
\\include{appendix}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "book.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.includedFiles).toHaveLength(3)

      result.metadata.includedFiles.forEach((file) => {
        expect(file.type).toBe("include")
      })
    })
  })

  describe("environments extraction", () => {
    test("extracts used environments", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\begin{abstract}
Abstract text.
\\end{abstract}
\\begin{equation}
E = mc^2
\\end{equation}
\\begin{figure}
\\end{figure}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.environments).toContain("document")
      expect(result.metadata.environments).toContain("abstract")
      expect(result.metadata.environments).toContain("equation")
      expect(result.metadata.environments).toContain("figure")
    })
  })

  describe("document info extraction", () => {
    test("extracts title, author, and date", async () => {
      const content = `\\documentclass{article}
\\title{My Research Paper}
\\author{John Doe}
\\date{January 2024}
\\begin{document}
\\maketitle
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "paper.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentInfo.title).toBe("My Research Paper")
      expect(result.metadata.documentInfo.author).toBe("John Doe")
      expect(result.metadata.documentInfo.date).toBe("January 2024")
    })

    test("detects abstract presence", async () => {
      const content = `\\documentclass{article}
\\begin{document}
\\begin{abstract}
This paper presents our findings.
\\end{abstract}
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "paper.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.documentInfo.abstract).toBe("[present]")
    })
  })

  describe("empty and edge cases", () => {
    test("handles empty file", async () => {
      const result = await LatexExplorer.explore({ content: "", filePath: "empty.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(0)
      expect(result.metadata.fileType).toBe("unknown")
    })

    test("handles whitespace-only file", async () => {
      const result = await LatexExplorer.explore({ content: "   \n\n  \t  ", filePath: "whitespace.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.fileType).toBe("unknown")
    })

    test("counts lines correctly", async () => {
      const content = `Line 1
Line 2
Line 3
Line 4
Line 5`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(5)
    })

    test("generates summary with token count", async () => {
      const content = `\\documentclass{article}
\\usepackage{amsmath}
\\title{Test}
\\begin{document}
\\section{Intro}
Hello world.
\\end{document}`

      const result = await LatexExplorer.explore({ content, filePath: "test.tex" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("test.tex")
      expect(result.summary).toContain("article")
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })
})
