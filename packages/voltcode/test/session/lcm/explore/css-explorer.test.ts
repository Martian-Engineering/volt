import { describe, expect, test } from "bun:test"
import { CssExplorer } from "../../../../src/session/lcm/explore/css-explorer"

describe("session.lcm.explore.css-explorer", () => {
  describe("basic CSS parsing", () => {
    test("parses simple CSS with class selectors", async () => {
      const css = `
.container {
  width: 100%;
  padding: 20px;
}

.button {
  background-color: blue;
  color: white;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "styles.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("css")
      expect(result.metadata.selectorCounts.class).toBeGreaterThanOrEqual(2)
      expect(result.metadata.ruleCount).toBeGreaterThan(0)
    })

    test("parses CSS with ID selectors", async () => {
      const css = `
#header {
  background: navy;
}

#footer {
  border-top: 1px solid gray;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "layout.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.selectorCounts.id).toBeGreaterThanOrEqual(2)
    })

    test("parses CSS with element selectors", async () => {
      const css = `
body {
  margin: 0;
  font-family: sans-serif;
}

h1 {
  font-size: 2em;
}

p {
  line-height: 1.5;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "base.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.selectorCounts.element).toBeGreaterThanOrEqual(3)
    })

    test("parses CSS with attribute selectors", async () => {
      const css = `
[data-theme="dark"] {
  background: black;
}

input[type="text"] {
  border: 1px solid gray;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "attrs.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.selectorCounts.attribute).toBeGreaterThanOrEqual(2)
    })

    test("parses CSS with pseudo selectors", async () => {
      const css = `
a:hover {
  color: red;
}

button:focus {
  outline: 2px solid blue;
}

p::first-line {
  font-weight: bold;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "pseudo.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.selectorCounts.pseudo).toBeGreaterThanOrEqual(3)
    })

    test("parses CSS with multiple selectors per rule", async () => {
      const css = `
.btn-primary, .btn-secondary, .btn-tertiary {
  padding: 10px 20px;
  border-radius: 4px;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "buttons.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.selectorCounts.total).toBeGreaterThanOrEqual(3)
    })

    test("counts total rules correctly", async () => {
      const css = `
.a { color: red; }
.b { color: blue; }
.c { color: green; }
.d { color: yellow; }
`
      const result = await CssExplorer.explore({ content: css, filePath: "colors.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.ruleCount).toBe(4)
    })
  })

  describe("CSS variable extraction", () => {
    test("extracts CSS custom properties", async () => {
      const css = `
:root {
  --primary-color: #3490dc;
  --secondary-color: #ffed4a;
  --font-size-base: 16px;
}

.button {
  background: var(--primary-color);
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "variables.css" })

      expect(result.success).toBe(true)
      expect(result.variables.length).toBeGreaterThanOrEqual(3)
      expect(result.metadata.variableCount).toBeGreaterThanOrEqual(3)

      const primaryColor = result.variables.find((v) => v.name === "--primary-color")
      expect(primaryColor).toBeDefined()
      expect(primaryColor?.value).toBe("#3490dc")
    })

    test("extracts variables with complex values", async () => {
      const css = `
:root {
  --gradient: linear-gradient(to right, red, blue);
  --shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "complex-vars.css" })

      expect(result.success).toBe(true)
      expect(result.variables.length).toBe(2)

      const gradient = result.variables.find((v) => v.name === "--gradient")
      expect(gradient).toBeDefined()
      expect(gradient?.value).toContain("linear-gradient")
    })

    test("truncates very long variable values", async () => {
      const longValue = "a".repeat(100)
      const css = `
:root {
  --long-var: ${longValue};
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "long-vars.css" })

      expect(result.success).toBe(true)
      expect(result.variables.length).toBe(1)
      expect(result.variables[0].value.length).toBeLessThanOrEqual(80)
      expect(result.variables[0].value).toContain("...")
    })
  })

  describe("media query detection", () => {
    test("detects media queries", async () => {
      const css = `
.container {
  width: 100%;
}

@media (min-width: 768px) {
  .container {
    width: 750px;
  }
}

@media (min-width: 1024px) {
  .container {
    width: 980px;
  }
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "responsive.css" })

      expect(result.success).toBe(true)
      expect(result.mediaQueries.length).toBe(2)
      expect(result.metadata.mediaQueryCount).toBe(2)
    })

    test("extracts media query conditions", async () => {
      const css = `
@media screen and (max-width: 600px) {
  .mobile-only {
    display: block;
  }
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "mobile.css" })

      expect(result.success).toBe(true)
      expect(result.mediaQueries.length).toBe(1)
      expect(result.mediaQueries[0].query).toContain("max-width")
    })

    test("counts rules inside media queries", async () => {
      const css = `
@media (min-width: 768px) {
  .a { color: red; }
  .b { color: blue; }
  .c { color: green; }
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "mq-rules.css" })

      expect(result.success).toBe(true)
      expect(result.mediaQueries.length).toBe(1)
      expect(result.mediaQueries[0].ruleCount).toBeGreaterThanOrEqual(3)
    })

    test("aggregates duplicate media queries", async () => {
      const css = `
@media (min-width: 768px) {
  .a { color: red; }
}

@media (min-width: 768px) {
  .b { color: blue; }
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "dup-mq.css" })

      expect(result.success).toBe(true)
      // Should aggregate into a single media query entry
      expect(result.mediaQueries.length).toBe(1)
      expect(result.mediaQueries[0].ruleCount).toBeGreaterThanOrEqual(2)
    })
  })

  describe("SCSS detection", () => {
    test("detects SCSS by file extension", async () => {
      const scss = `
.container {
  width: 100%;
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "styles.scss" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("scss")
    })

    test("detects SCSS by @mixin syntax", async () => {
      const scss = `
@mixin button-styles($color) {
  background: $color;
  padding: 10px 20px;
}

.button {
  @include button-styles(blue);
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "styles.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("scss")
    })

    test("detects SCSS by @use syntax", async () => {
      const scss = `
@use 'sass:math';
@use 'variables' as v;

.container {
  width: math.div(100%, 3);
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "main.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("scss")
    })

    test("detects SCSS by $ variables", async () => {
      const scss = `
$primary-color: #3490dc;
$font-size: 16px;

body {
  color: $primary-color;
  font-size: $font-size;
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "styles.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("scss")
    })

    test("extracts SCSS mixins", async () => {
      const scss = `
@mixin flex-center {
  display: flex;
  justify-content: center;
  align-items: center;
}

@mixin responsive-font($min, $max) {
  font-size: clamp($min, 2vw, $max);
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "mixins.scss" })

      expect(result.success).toBe(true)
      expect(result.mixins.length).toBe(2)
      expect(result.metadata.mixinCount).toBe(2)

      const flexCenter = result.mixins.find((m) => m.name === "flex-center")
      expect(flexCenter).toBeDefined()
      expect(flexCenter?.type).toBe("mixin")

      const responsiveFont = result.mixins.find((m) => m.name === "responsive-font")
      expect(responsiveFont).toBeDefined()
      expect(responsiveFont?.params.length).toBe(2)
    })

    test("extracts SCSS functions", async () => {
      const scss = `
@function px-to-rem($px) {
  @return ($px / 16) * 1rem;
}

@function lighten-color($color, $amount) {
  @return lighten($color, $amount);
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "functions.scss" })

      expect(result.success).toBe(true)
      expect(result.mixins.filter((m) => m.type === "function").length).toBe(2)
      expect(result.metadata.functionCount).toBe(2)
    })

    test("extracts @use and @forward imports", async () => {
      const scss = `
@use 'variables';
@use 'mixins' as m;
@forward 'theme';

.container {
  color: variables.$color;
}
`
      const result = await CssExplorer.explore({ content: scss, filePath: "main.scss" })

      expect(result.success).toBe(true)
      expect(result.imports.length).toBe(3)

      const useImports = result.imports.filter((i) => i.type === "@use")
      expect(useImports.length).toBe(2)

      const forwardImports = result.imports.filter((i) => i.type === "@forward")
      expect(forwardImports.length).toBe(1)
    })
  })

  describe("LESS detection", () => {
    test("detects LESS by file extension", async () => {
      const less = `
.container {
  width: 100%;
}
`
      const result = await CssExplorer.explore({ content: less, filePath: "styles.less" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("less")
    })

    test("detects LESS by @ variable syntax", async () => {
      const less = `
@primary-color: #3490dc;
@font-size: 16px;

body {
  color: @primary-color;
  font-size: @font-size;
}
`
      const result = await CssExplorer.explore({ content: less, filePath: "styles.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("less")
    })

    test("extracts LESS mixins", async () => {
      const less = `
.border-radius(@radius) {
  border-radius: @radius;
}

#gradient(@start, @end) {
  background: linear-gradient(@start, @end);
}
`
      const result = await CssExplorer.explore({ content: less, filePath: "mixins.less" })

      expect(result.success).toBe(true)
      expect(result.mixins.length).toBe(2)
    })
  })

  describe("Sass (indented) detection", () => {
    test("detects Sass by file extension", async () => {
      const sass = `
.container
  width: 100%
  padding: 20px
`
      const result = await CssExplorer.explore({ content: sass, filePath: "styles.sass" })

      expect(result.success).toBe(true)
      expect(result.metadata.preprocessor).toBe("sass")
    })
  })

  describe("@import extraction", () => {
    test("extracts @import statements", async () => {
      const css = `
@import url('reset.css');
@import 'typography.css';
@import "layout.css";

body {
  margin: 0;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "main.css" })

      expect(result.success).toBe(true)
      expect(result.imports.length).toBe(3)
      expect(result.metadata.importCount).toBe(3)

      const paths = result.imports.map((i) => i.path)
      expect(paths).toContain("reset.css")
      expect(paths).toContain("typography.css")
      expect(paths).toContain("layout.css")
    })
  })

  describe("keyframe extraction", () => {
    test("extracts @keyframes animations", async () => {
      const css = `
@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes slide {
  0% { transform: translateX(0); }
  50% { transform: translateX(50px); }
  100% { transform: translateX(100px); }
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "animations.css" })

      expect(result.success).toBe(true)
      expect(result.keyframes.length).toBe(2)
      expect(result.metadata.keyframeCount).toBe(2)

      const fadeIn = result.keyframes.find((k) => k.name === "fadeIn")
      expect(fadeIn).toBeDefined()
      expect(fadeIn?.stepCount).toBe(2)

      const slide = result.keyframes.find((k) => k.name === "slide")
      expect(slide).toBeDefined()
      expect(slide?.stepCount).toBe(3)
    })
  })

  describe("font-face extraction", () => {
    test("extracts @font-face declarations", async () => {
      const css = `
@font-face {
  font-family: 'CustomFont';
  src: url('custom.woff2') format('woff2');
  font-weight: 400;
  font-style: normal;
}

@font-face {
  font-family: 'CustomFont';
  src: url('custom-bold.woff2') format('woff2');
  font-weight: 700;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "fonts.css" })

      expect(result.success).toBe(true)
      expect(result.fontFaces.length).toBe(2)
      expect(result.metadata.fontFaceCount).toBe(2)

      const normalFont = result.fontFaces.find((f) => f.weight === "400")
      expect(normalFont).toBeDefined()
      expect(normalFont?.family).toBe("CustomFont")
      expect(normalFont?.style).toBe("normal")
    })
  })

  describe("summary formatting", () => {
    test("generates a formatted summary", async () => {
      const css = `
:root {
  --primary: blue;
}

.container {
  width: 100%;
}

@media (min-width: 768px) {
  .container {
    width: 750px;
  }
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "test.css" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: test.css")
      expect(result.summary).toContain("Format: CSS")
      expect(result.summary).toContain("Structure:")
      expect(result.summary).toContain("Selectors:")
      expect(result.summary).toContain("Features:")
    })

    test("includes token count estimate", async () => {
      const css = `
.a { color: red; }
.b { color: blue; }
`
      const result = await CssExplorer.explore({ content: css, filePath: "simple.css" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("error handling", () => {
    test("handles empty content", async () => {
      const result = await CssExplorer.explore({ content: "", filePath: "empty.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.ruleCount).toBe(0)
      expect(result.metadata.lineCount).toBe(1)
    })

    test("handles CSS with comments", async () => {
      const css = `
/* This is a comment */
.button {
  /* inline comment */
  color: blue;
}

// Single line comment (SCSS style)
.container {
  width: 100%;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "commented.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.selectorCounts.class).toBeGreaterThanOrEqual(2)
    })
  })

  describe("CSS-in-JS detection", () => {
    test("detects styled-components patterns", async () => {
      const content = `
const Button = styled.button\`
  background: blue;
  color: white;
\`
`
      const result = await CssExplorer.explore({ content, filePath: "component.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasCssInJsPatterns).toBe(true)
    })

    test("detects css template literal patterns", async () => {
      const content = `
const styles = css\`
  display: flex;
  justify-content: center;
\`
`
      const result = await CssExplorer.explore({ content, filePath: "styles.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasCssInJsPatterns).toBe(true)
    })

    test("does not flag regular CSS as CSS-in-JS", async () => {
      const css = `
.container {
  display: flex;
  justify-content: center;
}
`
      const result = await CssExplorer.explore({ content: css, filePath: "styles.css" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasCssInJsPatterns).toBe(false)
    })
  })
})
