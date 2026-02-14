import { describe, expect, test } from "bun:test"
import { JavaScriptExplorer } from "../../../../src/session/lcm/explore/javascript-explorer"

describe("session.lcm.explore.javascript-explorer", () => {
  describe("ESM import/export parsing", () => {
    test("detects ESM module system with import statements", async () => {
      const content = `
import React from 'react'
import { useState, useEffect } from 'react'

export const App = () => <div>Hello</div>
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleSystem).toBe("esm")
    })

    test("detects ESM module system with export statements only", async () => {
      const content = `
export const foo = 'bar'
export function hello() {}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleSystem).toBe("esm")
    })

    test("extracts default imports", async () => {
      const content = `
import React from 'react'
import lodash from 'lodash'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.thirdParty).toContain("react")
      expect(result.imports.thirdParty).toContain("lodash")
    })

    test("extracts named imports", async () => {
      const content = `
import { useState, useEffect, useCallback } from 'react'
import { map, filter } from 'lodash'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.thirdParty).toContain("react")
      expect(result.imports.thirdParty).toContain("lodash")
    })

    test("extracts namespace imports", async () => {
      const content = `
import * as React from 'react'
import * as utils from './utils'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.thirdParty).toContain("react")
      expect(result.imports.local).toContain("./utils")
    })

    test("extracts side-effect imports", async () => {
      const content = `
import 'normalize.css'
import './styles.css'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.thirdParty).toContain("normalize.css")
      expect(result.imports.local).toContain("./styles.css")
    })

    test("extracts dynamic imports", async () => {
      const content = `
const module = await import('./dynamic-module')
const lazy = () => import('lodash')
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.local).toContain("./dynamic-module")
      expect(result.imports.thirdParty).toContain("lodash")
    })

    test("extracts default exports", async () => {
      const content = `
const App = () => <div>Hello</div>
export default App
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const defaultExport = result.exports.find((e) => e.type === "default")
      expect(defaultExport).toBeDefined()
      expect(defaultExport?.name).toBe("App")
    })

    test("extracts named exports", async () => {
      const content = `
export const foo = 'bar'
export function hello() {}
export class MyClass {}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const namedExports = result.exports.filter((e) => e.type === "named")
      expect(namedExports.map((e) => e.name)).toContain("foo")
      expect(namedExports.map((e) => e.name)).toContain("hello")
      expect(namedExports.map((e) => e.name)).toContain("MyClass")
    })

    test("extracts re-exports", async () => {
      const content = `
export { foo, bar } from './module'
export * from './utils'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const reExportAll = result.exports.find((e) => e.type === "all")
      expect(reExportAll).toBeDefined()
      expect(reExportAll?.source).toBe("./utils")

      const namedReExports = result.exports.filter((e) => e.type === "named" && e.source === "./module")
      expect(namedReExports.map((e) => e.name)).toContain("foo")
      expect(namedReExports.map((e) => e.name)).toContain("bar")
    })

    test("categorizes imports by type", async () => {
      const content = `
import fs from 'fs'
import path from 'node:path'
import React from 'react'
import { something } from './local'
import utils from '@/utils/helper'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.builtin).toContain("fs")
      expect(result.imports.builtin).toContain("node:path")
      expect(result.imports.thirdParty).toContain("react")
      expect(result.imports.local).toContain("./local")
      expect(result.imports.local).toContain("@/utils/helper")
    })
  })

  describe("CommonJS require/module.exports parsing", () => {
    test("detects CommonJS module system with require", async () => {
      const content = `
const fs = require('fs')
const path = require('path')

module.exports = { foo: 'bar' }
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleSystem).toBe("commonjs")
    })

    test("detects CommonJS with exports.x pattern", async () => {
      const content = `
const helper = require('./helper')

exports.foo = function() {}
exports.bar = 'baz'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleSystem).toBe("commonjs")
    })

    test("extracts const require imports", async () => {
      const content = `
const fs = require('fs')
const lodash = require('lodash')
const utils = require('./utils')
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.builtin).toContain("fs")
      expect(result.imports.thirdParty).toContain("lodash")
      expect(result.imports.local).toContain("./utils")
    })

    test("extracts destructured require imports", async () => {
      const content = `
const { readFile, writeFile } = require('fs')
const { map, filter } = require('lodash')
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.imports.builtin).toContain("fs")
      expect(result.imports.thirdParty).toContain("lodash")
    })

    test("extracts module.exports", async () => {
      const content = `
function hello() {
  return 'world'
}

module.exports = hello
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const cjsExport = result.exports.find((e) => e.type === "commonjs" && e.name === "module.exports")
      expect(cjsExport).toBeDefined()
    })

    test("extracts exports.x assignments", async () => {
      const content = `
exports.foo = function() {}
exports.bar = 'baz'
exports.helper = require('./helper')
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const cjsExports = result.exports.filter((e) => e.type === "commonjs")
      expect(cjsExports.map((e) => e.name)).toContain("foo")
      expect(cjsExports.map((e) => e.name)).toContain("bar")
      expect(cjsExports.map((e) => e.name)).toContain("helper")
    })

    test("detects mixed module system", async () => {
      const content = `
import React from 'react'
const lodash = require('lodash')

export default function App() {}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleSystem).toBe("mixed")
    })
  })

  describe("function and class extraction", () => {
    test("extracts named function declarations", async () => {
      const content = `
function hello(name) {
  return 'Hello ' + name
}

function add(a, b) {
  return a + b
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.functionCount).toBe(2)
      const funcNames = result.functions.map((f) => f.name)
      expect(funcNames).toContain("hello")
      expect(funcNames).toContain("add")
    })

    test("extracts async functions", async () => {
      const content = `
async function fetchData(url) {
  const response = await fetch(url)
  return response.json()
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const asyncFunc = result.functions.find((f) => f.name === "fetchData")
      expect(asyncFunc).toBeDefined()
      expect(asyncFunc?.isAsync).toBe(true)
      expect(asyncFunc?.isArrow).toBe(false)
    })

    test("extracts generator functions", async () => {
      const content = `
function* generateNumbers() {
  yield 1
  yield 2
  yield 3
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const genFunc = result.functions.find((f) => f.name === "generateNumbers")
      expect(genFunc).toBeDefined()
      expect(genFunc?.isGenerator).toBe(true)
    })

    test("extracts arrow functions", async () => {
      const content = `
const greet = (name) => {
  return 'Hello ' + name
}

const add = (a, b) => a + b

const asyncFetch = async (url) => {
  return await fetch(url)
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const arrowFuncs = result.functions.filter((f) => f.isArrow)
      expect(arrowFuncs.length).toBeGreaterThanOrEqual(2)

      const greetFunc = result.functions.find((f) => f.name === "greet")
      expect(greetFunc?.isArrow).toBe(true)

      const asyncFunc = result.functions.find((f) => f.name === "asyncFetch")
      expect(asyncFunc?.isArrow).toBe(true)
      expect(asyncFunc?.isAsync).toBe(true)
    })

    test("extracts exported functions", async () => {
      const content = `
export function publicFunc() {}

export const arrowFunc = () => {}

function privateFunc() {}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const publicFunc = result.functions.find((f) => f.name === "publicFunc")
      expect(publicFunc?.isExported).toBe(true)

      const arrowFunc = result.functions.find((f) => f.name === "arrowFunc")
      expect(arrowFunc?.isExported).toBe(true)

      const privateFunc = result.functions.find((f) => f.name === "privateFunc")
      expect(privateFunc?.isExported).toBe(false)
    })

    test("extracts function parameters", async () => {
      const content = `
function process(data, options, callback) {
  callback(data)
}

const transform = (input, config = {}) => input
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const processFunc = result.functions.find((f) => f.name === "process")
      expect(processFunc?.params).toContain("data")
      expect(processFunc?.params).toContain("options")
      expect(processFunc?.params).toContain("callback")
    })

    test("extracts class declarations", async () => {
      const content = `
class Animal {
  constructor(name) {
    this.name = name
  }

  speak() {
    console.log(this.name + ' makes a sound')
  }
}

class Dog extends Animal {
  bark() {
    console.log('Woof!')
  }
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.classCount).toBe(2)

      const animalClass = result.classes.find((c) => c.name === "Animal")
      expect(animalClass).toBeDefined()
      expect(animalClass?.extends).toBeUndefined()
      expect(animalClass?.methods).toContain("constructor")
      expect(animalClass?.methods).toContain("speak")

      const dogClass = result.classes.find((c) => c.name === "Dog")
      expect(dogClass).toBeDefined()
      expect(dogClass?.extends).toBe("Animal")
      expect(dogClass?.methods).toContain("bark")
    })

    test("extracts exported classes", async () => {
      const content = `
export class PublicClass {
  method() {}
}

class PrivateClass {
  method() {}
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const publicClass = result.classes.find((c) => c.name === "PublicClass")
      expect(publicClass?.isExported).toBe(true)

      const privateClass = result.classes.find((c) => c.name === "PrivateClass")
      expect(privateClass?.isExported).toBe(false)
    })

    test("extracts class methods", async () => {
      const content = `
class Service {
  constructor() {}

  async fetchData() {}

  get value() {}

  set value(v) {}

  static getInstance() {}
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      const serviceClass = result.classes.find((c) => c.name === "Service")
      expect(serviceClass?.methods).toContain("constructor")
      expect(serviceClass?.methods).toContain("fetchData")
      expect(serviceClass?.methods).toContain("value")
      expect(serviceClass?.methods).toContain("getInstance")
    })
  })

  describe("React component detection", () => {
    test("detects function components with JSX", async () => {
      const content = `
import React from 'react'

function App() {
  return <div>Hello World</div>
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "App.jsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.isReact).toBe(true)
      expect(result.metadata.hasJsx).toBe(true)
      expect(result.reactComponents.length).toBeGreaterThanOrEqual(1)

      const appComponent = result.reactComponents.find((c) => c.name === "App")
      expect(appComponent).toBeDefined()
      expect(appComponent?.type).toBe("function")
    })

    test("detects arrow function components", async () => {
      const content = `
import React from 'react'

const Button = ({ children, onClick }) => {
  return <button onClick={onClick}>{children}</button>
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "Button.jsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.isReact).toBe(true)

      const buttonComponent = result.reactComponents.find((c) => c.name === "Button")
      expect(buttonComponent).toBeDefined()
      expect(buttonComponent?.type).toBe("arrow")
    })

    test("detects class components", async () => {
      const content = `
import React, { Component } from 'react'

class Counter extends Component {
  constructor(props) {
    super(props)
    this.state = { count: 0 }
  }

  render() {
    return <div>{this.state.count}</div>
  }
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "Counter.jsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.isReact).toBe(true)

      const counterComponent = result.reactComponents.find((c) => c.name === "Counter")
      expect(counterComponent).toBeDefined()
      expect(counterComponent?.type).toBe("class")
    })

    test("detects class components extending PureComponent", async () => {
      const content = `
import React, { PureComponent } from 'react'

class OptimizedList extends PureComponent {
  render() {
    return <ul>{this.props.items.map(i => <li key={i}>{i}</li>)}</ul>
  }
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "List.jsx" })

      expect(result.success).toBe(true)
      const listComponent = result.reactComponents.find((c) => c.name === "OptimizedList")
      expect(listComponent).toBeDefined()
      expect(listComponent?.type).toBe("class")
    })

    test("detects hooks usage in functional components", async () => {
      const content = `
import React, { useState, useEffect, useCallback } from 'react'

function TodoList() {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/todos')
      .then(res => res.json())
      .then(data => {
        setItems(data)
        setLoading(false)
      })
  }, [])

  const addItem = useCallback((item) => {
    setItems(prev => [...prev, item])
  }, [])

  return (
    <div>
      {loading ? <p>Loading...</p> : <ul>{items.map(i => <li>{i}</li>)}</ul>}
    </div>
  )
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "TodoList.jsx" })

      expect(result.success).toBe(true)
      const todoComponent = result.reactComponents.find((c) => c.name === "TodoList")
      expect(todoComponent).toBeDefined()
      expect(todoComponent?.hasHooks).toBe(true)
      expect(todoComponent?.usedHooks).toContain("useState")
      expect(todoComponent?.usedHooks).toContain("useEffect")
      expect(todoComponent?.usedHooks).toContain("useCallback")
    })

    test("detects custom hooks usage", async () => {
      const content = `
import React from 'react'
import { useCustomHook, useAuth } from './hooks'

function Profile() {
  const { user } = useAuth()
  const data = useCustomHook()

  return <div>{user.name}</div>
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "Profile.jsx" })

      expect(result.success).toBe(true)
      const profileComponent = result.reactComponents.find((c) => c.name === "Profile")
      expect(profileComponent).toBeDefined()
      expect(profileComponent?.hasHooks).toBe(true)
      expect(profileComponent?.usedHooks).toContain("useAuth")
      expect(profileComponent?.usedHooks).toContain("useCustomHook")
    })

    test("detects JSX syntax patterns", async () => {
      const content = `
import React from 'react'

function Page() {
  return (
    <>
      <Header className="main-header" />
      <div onClick={() => {}}>
        <Content />
      </div>
      <Footer />
    </>
  )
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "Page.jsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasJsx).toBe(true)
      expect(result.metadata.isReact).toBe(true)
    })

    test("detects JSX without explicit React import", async () => {
      const content = `
// React 17+ automatic JSX runtime
function App() {
  return <div className="app">Hello</div>
}

export default App
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "App.jsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasJsx).toBe(true)
    })

    test("class component without hooks has empty usedHooks", async () => {
      const content = `
import React, { Component } from 'react'

class StaticDisplay extends Component {
  render() {
    return <div>Static content</div>
  }
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "Static.jsx" })

      expect(result.success).toBe(true)
      const staticComponent = result.reactComponents.find((c) => c.name === "StaticDisplay")
      expect(staticComponent).toBeDefined()
      expect(staticComponent?.hasHooks).toBe(false)
      expect(staticComponent?.usedHooks).toEqual([])
    })
  })

  describe("metadata extraction", () => {
    test("detects use strict directive", async () => {
      const content = `'use strict'

function strict() {
  return true
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasUseStrict).toBe(true)
    })

    test("detects IIFE patterns", async () => {
      const content = `
(function() {
  var private = 'secret'
  window.module = { public: 'data' }
})()
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasIife).toBe(true)
    })

    test("counts lines correctly", async () => {
      const content = `line 1
line 2
line 3
line 4
line 5`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(5)
    })

    test("extracts global variables", async () => {
      const content = `
const CONFIG = { debug: true }
let counter = 0
var legacy = 'old'

function notGlobal() {
  const inner = 'not counted'
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.globalVariables.length).toBeGreaterThanOrEqual(3)
      const varNames = result.globalVariables.map((v) => v.name)
      expect(varNames).toContain("CONFIG")
      expect(varNames).toContain("counter")
      expect(varNames).toContain("legacy")
    })

    test("detects unknown module system for plain JavaScript", async () => {
      const content = `
function helper() {
  return 'no imports or exports'
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleSystem).toBe("unknown")
    })
  })

  describe("summary formatting", () => {
    test("generates summary with file info", async () => {
      const content = `
import { something } from './module'
export const foo = 'bar'
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "/path/to/test.js" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: test.js")
      expect(result.summary).toContain("Format: JavaScript")
    })

    test("generates summary with structure counts", async () => {
      const content = `
import a from 'a'
import b from 'b'
export const x = 1
export const y = 2
function foo() {}
class Bar {}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "test.js" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("Imports: 2")
      expect(result.summary).toContain("Exports: 2")
      expect(result.summary).toContain("Classes: 1")
      expect(result.summary).toContain("Functions: 1")
    })

    test("estimates token count", async () => {
      const content = `
import React from 'react'

function App() {
  return <div>Hello</div>
}

export default App
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "App.jsx" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("error handling", () => {
    test("handles empty content", async () => {
      const result = await JavaScriptExplorer.explore({ content: "", filePath: "empty.js" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(1)
      expect(result.metadata.moduleSystem).toBe("unknown")
    })

    test("handles malformed content gracefully", async () => {
      const content = `
import { incomplete
function broken( {
  return <div
}
`
      const result = await JavaScriptExplorer.explore({ content, filePath: "broken.js" })

      // Should still succeed with partial extraction
      expect(result.success).toBe(true)
    })

    test("uses default file path when not provided", async () => {
      const content = `const x = 1`
      const result = await JavaScriptExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: unknown.js")
    })
  })
})
