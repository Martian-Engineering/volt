import { describe, expect, test } from "bun:test"
import { TypeScriptExplorer } from "../../../../src/session/lcm/explore/typescript-explorer"

describe("session.lcm.explore.typescript", () => {
  describe("basic TypeScript file parsing", () => {
    test("parses ES imports", async () => {
      const content = `
import fs from "fs"
import path from "path"
import { Router } from "express"
import type { Request, Response } from "express"
import * as utils from "./utils"
import "./side-effects"

export function handler() {}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "server.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("fs")
      expect(result.metadata.imports.builtin).toContain("path")
      expect(result.metadata.imports.thirdParty).toContain("express")
      expect(result.metadata.imports.local).toContain("./utils")
      expect(result.metadata.imports.local).toContain("./side-effects")
    })

    test("parses node: prefixed imports", async () => {
      const content = `
import fs from "node:fs"
import path from "node:path"
import { Buffer } from "node:buffer"

export function read() {}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "file.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("node:fs")
      expect(result.metadata.imports.builtin).toContain("node:path")
      expect(result.metadata.imports.builtin).toContain("node:buffer")
    })

    test("parses dynamic imports", async () => {
      const content = `
const express = await import("express")
const config = await import("./config")
const fs = await import("fs")
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "dynamic.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.thirdParty).toContain("express")
      expect(result.metadata.imports.local).toContain("./config")
      expect(result.metadata.imports.builtin).toContain("fs")
    })

    test("parses require statements", async () => {
      const content = `
const fs = require("fs")
const express = require("express")
const config = require("./config")
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "legacy.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("fs")
      expect(result.metadata.imports.thirdParty).toContain("express")
      expect(result.metadata.imports.local).toContain("./config")
      expect(result.metadata.moduleType).toBe("commonjs")
    })

    test("counts line numbers correctly", async () => {
      const content = `import fs from "fs"

interface User {
  name: string
  age: number
}

export function greet(user: User) {
  console.log(user.name)
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "greet.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(11)
    })
  })

  describe("interface extraction", () => {
    test("extracts simple interface", async () => {
      const content = `
interface User {
  id: number
  name: string
  email: string
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "types.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.interfaces[0].name).toBe("User")
      expect(result.metadata.interfaces[0].isExported).toBe(false)
    })

    test("extracts exported interface", async () => {
      const content = `
export interface Config {
  host: string
  port: number
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "config.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.interfaces[0].name).toBe("Config")
      expect(result.metadata.interfaces[0].isExported).toBe(true)
    })

    test("extracts interface with extends", async () => {
      const content = `
interface Animal {
  name: string
}

interface Dog extends Animal {
  breed: string
}

interface ServiceDog extends Dog, Trainable {
  serviceType: string
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "animals.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(3)

      const dogInterface = result.metadata.interfaces.find((i) => i.name === "Dog")
      expect(dogInterface).toBeDefined()
      expect(dogInterface?.extends).toContain("Animal")

      const serviceDogInterface = result.metadata.interfaces.find((i) => i.name === "ServiceDog")
      expect(serviceDogInterface).toBeDefined()
      expect(serviceDogInterface?.extends).toContain("Dog")
      expect(serviceDogInterface?.extends).toContain("Trainable")
    })

    test("extracts generic interface", async () => {
      const content = `
interface Repository<T> {
  find(id: number): T | null
  save(item: T): void
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "repo.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.interfaces[0].name).toBe("Repository")
    })

    test("extracts multiple interfaces", async () => {
      const content = `
export interface Request {
  method: string
  url: string
}

export interface Response {
  status: number
  body: unknown
}

interface Internal {
  secret: string
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "http.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(3)

      const names = result.metadata.interfaces.map((i) => i.name)
      expect(names).toContain("Request")
      expect(names).toContain("Response")
      expect(names).toContain("Internal")
    })
  })

  describe("type alias extraction", () => {
    test("extracts simple type alias", async () => {
      const content = `
type ID = string
type Count = number
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "types.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(2)

      const idType = result.metadata.types.find((t) => t.name === "ID")
      expect(idType).toBeDefined()
      expect(idType?.definition).toBe("string")
      expect(idType?.isGeneric).toBe(false)
    })

    test("extracts exported type alias", async () => {
      const content = `
export type Status = "active" | "inactive" | "pending"
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "status.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("Status")
      expect(result.metadata.types[0].isExported).toBe(true)
    })

    test("extracts generic type alias", async () => {
      const content = `
type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E }
type Nullable<T> = T | null
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "result.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(2)

      const resultType = result.metadata.types.find((t) => t.name === "Result")
      expect(resultType).toBeDefined()
      expect(resultType?.isGeneric).toBe(true)

      const nullableType = result.metadata.types.find((t) => t.name === "Nullable")
      expect(nullableType).toBeDefined()
      expect(nullableType?.isGeneric).toBe(true)
    })

    test("extracts union and intersection types", async () => {
      const content = `
type StringOrNumber = string | number
type Combined = A & B
type Complex = (A | B) & C
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "unions.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(3)
    })

    test("extracts object type alias", async () => {
      const content = `
type Config = {
  host: string
  port: number
  debug: boolean
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "config.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("Config")
    })
  })

  describe("class extraction", () => {
    test("extracts simple class", async () => {
      const content = `
class User {
  private name: string
  public age: number

  constructor(name: string, age: number) {
    this.name = name
    this.age = age
  }

  greet(): string {
    return \`Hello, \${this.name}\`
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "user.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("User")
      expect(result.metadata.classes[0].isExported).toBe(false)
      expect(result.metadata.classes[0].isAbstract).toBe(false)
    })

    test("extracts exported class", async () => {
      const content = `
export class Service {
  start(): void {}
  stop(): void {}
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "service.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Service")
      expect(result.metadata.classes[0].isExported).toBe(true)
      expect(result.metadata.classes[0].methods).toContain("start")
      expect(result.metadata.classes[0].methods).toContain("stop")
    })

    test("extracts abstract class", async () => {
      const content = `
export abstract class Animal {
  abstract speak(): void
  abstract move(): void

  breathe(): void {
    console.log("breathing")
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "animal.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Animal")
      expect(result.metadata.classes[0].isAbstract).toBe(true)
      expect(result.metadata.classes[0].isExported).toBe(true)
    })

    test("extracts class with inheritance", async () => {
      const content = `
class Dog extends Animal {
  bark(): void {}
}

class ServiceDog extends Dog implements Trainable, Serviceable {
  train(): void {}
  serve(): void {}
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "dog.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(2)

      const dogClass = result.metadata.classes.find((c) => c.name === "Dog")
      expect(dogClass).toBeDefined()
      expect(dogClass?.extends).toBe("Animal")

      const serviceDogClass = result.metadata.classes.find((c) => c.name === "ServiceDog")
      expect(serviceDogClass).toBeDefined()
      expect(serviceDogClass?.extends).toBe("Dog")
      expect(serviceDogClass?.implements).toContain("Trainable")
      expect(serviceDogClass?.implements).toContain("Serviceable")
    })

    test("extracts generic class", async () => {
      const content = `
class Container<T> {
  private items: T[] = []

  add(item: T): void {
    this.items.push(item)
  }

  get(index: number): T | undefined {
    return this.items[index]
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "container.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Container")
      expect(result.metadata.classes[0].methods).toContain("add")
      expect(result.metadata.classes[0].methods).toContain("get")
    })
  })

  describe("function extraction", () => {
    test("extracts regular function", async () => {
      const content = `
function add(a: number, b: number): number {
  return a + b
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "math.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("add")
      expect(result.metadata.functions[0].isAsync).toBe(false)
      expect(result.metadata.functions[0].isArrow).toBe(false)
      expect(result.metadata.functions[0].isExported).toBe(false)
    })

    test("extracts exported function", async () => {
      const content = `
export function greet(name: string): string {
  return \`Hello, \${name}\`
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "greet.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("greet")
      expect(result.metadata.functions[0].isExported).toBe(true)
    })

    test("extracts async function", async () => {
      const content = `
export async function fetchData(url: string): Promise<Response> {
  return fetch(url)
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "fetch.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("fetchData")
      expect(result.metadata.functions[0].isAsync).toBe(true)
    })

    test("extracts generator function", async () => {
      const content = `
function* range(start: number, end: number): Generator<number> {
  for (let i = start; i < end; i++) {
    yield i
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "generator.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("range")
      expect(result.metadata.functions[0].isGenerator).toBe(true)
    })

    test("extracts arrow function", async () => {
      const content = `
export const multiply = (a: number, b: number): number => a * b
const divide = async (a: number, b: number): Promise<number> => a / b
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "ops.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(2)

      const multiplyFunc = result.metadata.functions.find((f) => f.name === "multiply")
      expect(multiplyFunc).toBeDefined()
      expect(multiplyFunc?.isArrow).toBe(true)
      expect(multiplyFunc?.isExported).toBe(true)

      const divideFunc = result.metadata.functions.find((f) => f.name === "divide")
      expect(divideFunc).toBeDefined()
      expect(divideFunc?.isArrow).toBe(true)
      expect(divideFunc?.isAsync).toBe(true)
    })

    test("extracts multiple functions", async () => {
      const content = `
export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}

function internal(): void {}

export const multiply = (a: number, b: number) => a * b
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "math.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(4)

      const names = result.metadata.functions.map((f) => f.name)
      expect(names).toContain("add")
      expect(names).toContain("subtract")
      expect(names).toContain("internal")
      expect(names).toContain("multiply")
    })
  })

  describe("enum extraction", () => {
    test("extracts simple enum", async () => {
      const content = `
enum Status {
  Active,
  Inactive,
  Pending
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "status.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Status")
      expect(result.metadata.enums[0].isConst).toBe(false)
      expect(result.metadata.enums[0].members).toContain("Active")
      expect(result.metadata.enums[0].members).toContain("Inactive")
      expect(result.metadata.enums[0].members).toContain("Pending")
    })

    test("extracts exported enum", async () => {
      const content = `
export enum Color {
  Red = "red",
  Green = "green",
  Blue = "blue"
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "color.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Color")
      expect(result.metadata.enums[0].isExported).toBe(true)
    })

    test("extracts const enum", async () => {
      const content = `
export const enum Direction {
  Up = 1,
  Down = 2,
  Left = 3,
  Right = 4
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "direction.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Direction")
      expect(result.metadata.enums[0].isConst).toBe(true)
      expect(result.metadata.enums[0].isExported).toBe(true)
    })

    test("extracts multiple enums", async () => {
      const content = `
enum LogLevel {
  Debug,
  Info,
  Warn,
  Error
}

export enum Priority {
  Low,
  Medium,
  High
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "enums.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(2)

      const names = result.metadata.enums.map((e) => e.name)
      expect(names).toContain("LogLevel")
      expect(names).toContain("Priority")
    })
  })

  describe("namespace extraction", () => {
    test("extracts namespace", async () => {
      const content = `
namespace Utils {
  export function helper(): void {}
  export const VERSION = "1.0.0"
  export interface Config {}
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "utils.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(1)
      expect(result.metadata.namespaces[0].name).toBe("Utils")
      expect(result.metadata.namespaces[0].members).toContain("helper")
      expect(result.metadata.namespaces[0].members).toContain("VERSION")
      expect(result.metadata.namespaces[0].members).toContain("Config")
    })

    test("extracts exported namespace", async () => {
      const content = `
export namespace API {
  export function get(): void {}
  export function post(): void {}
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "api.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(1)
      expect(result.metadata.namespaces[0].name).toBe("API")
      expect(result.metadata.namespaces[0].isExported).toBe(true)
    })

    test("extracts module declaration", async () => {
      const content = `
module Legacy {
  export class OldService {}
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "legacy.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(1)
      expect(result.metadata.namespaces[0].name).toBe("Legacy")
    })
  })

  describe("export extraction", () => {
    test("extracts named exports", async () => {
      const content = `
export const VERSION = "1.0.0"
export function init(): void {}
export class Service {}
export interface Config {}
export type Status = "ok" | "error"
export enum Level { Low, High }
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "exports.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports.named).toContain("VERSION")
      expect(result.metadata.exports.named).toContain("init")
      expect(result.metadata.exports.named).toContain("Service")
      expect(result.metadata.exports.named).toContain("Config")
      expect(result.metadata.exports.named).toContain("Status")
      expect(result.metadata.exports.named).toContain("Level")
    })

    test("extracts default export", async () => {
      const content = `
class App {
  run(): void {}
}

export default App
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "app.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports.default).toBe("App")
    })

    test("extracts re-exports", async () => {
      const content = `
export * from "./utils"
export * as helpers from "./helpers"
export { foo, bar } from "./other"
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "index.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports.reExports.length).toBe(3)
    })

    test("extracts export block", async () => {
      const content = `
const a = 1
const b = 2
function c() {}

export { a, b, c }
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "block.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports.named).toContain("a")
      expect(result.metadata.exports.named).toContain("b")
      expect(result.metadata.exports.named).toContain("c")
    })
  })

  describe("module type detection", () => {
    test("detects ESM module", async () => {
      const content = `
import fs from "fs"
export function read() {}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "esm.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleType).toBe("esm")
    })

    test("detects CommonJS module", async () => {
      const content = `
const fs = require("fs")
module.exports = { read: function() {} }
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "cjs.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleType).toBe("commonjs")
    })

    test("detects mixed module", async () => {
      const content = `
import path from "path"
const fs = require("fs")

export function read() {}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "mixed.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleType).toBe("mixed")
    })

    test("detects unknown module type", async () => {
      const content = `
function internal() {}
const x = 1
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "internal.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.moduleType).toBe("unknown")
    })
  })

  describe("React/TSX support", () => {
    test("detects TSX file as React", async () => {
      const content = `
import React from "react"

function App() {
  return <div>Hello</div>
}

export default App
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "app.tsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.isReact).toBe(true)
    })

    test("extracts function component", async () => {
      const content = `
import React from "react"

interface Props {
  name: string
}

export function Greeting(props: Props) {
  return <div>Hello, {props.name}</div>
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "greeting.tsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.reactComponents.length).toBe(1)
      expect(result.metadata.reactComponents[0].name).toBe("Greeting")
      expect(result.metadata.reactComponents[0].type).toBe("function")
      expect(result.metadata.reactComponents[0].hasProps).toBe(true)
      expect(result.metadata.reactComponents[0].isExported).toBe(true)
    })

    test("extracts arrow function component", async () => {
      const content = `
import React, { FC } from "react"

interface ButtonProps {
  onClick: () => void
  label: string
}

export const Button: FC<ButtonProps> = ({ onClick, label }) => {
  return <button onClick={onClick}>{label}</button>
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "button.tsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.reactComponents.length).toBe(1)
      expect(result.metadata.reactComponents[0].name).toBe("Button")
      expect(result.metadata.reactComponents[0].type).toBe("arrow")
      expect(result.metadata.reactComponents[0].hasProps).toBe(true)
    })

    test("extracts class component", async () => {
      const content = `
import React, { Component } from "react"

interface State {
  count: number
}

interface Props {
  initial: number
}

export class Counter extends Component<Props, State> {
  render() {
    return <div>{this.state.count}</div>
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "counter.tsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.reactComponents.length).toBe(1)
      expect(result.metadata.reactComponents[0].name).toBe("Counter")
      expect(result.metadata.reactComponents[0].type).toBe("class")
      expect(result.metadata.reactComponents[0].hasProps).toBe(true)
      expect(result.metadata.reactComponents[0].propsType).toBe("Props")
    })

    test("extracts multiple React components", async () => {
      const content = `
import React from "react"

export function Header() {
  return <header>Header</header>
}

export function Footer() {
  return <footer>Footer</footer>
}

export const Sidebar = () => {
  return <aside>Sidebar</aside>
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "components.tsx" })

      expect(result.success).toBe(true)
      expect(result.metadata.reactComponents.length).toBe(3)

      const names = result.metadata.reactComponents.map((c) => c.name)
      expect(names).toContain("Header")
      expect(names).toContain("Footer")
      expect(names).toContain("Sidebar")
    })
  })

  describe("entry point detection", () => {
    test("detects console.log as entry point", async () => {
      const content = `
const message = "Hello"
console.log(message)
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "script.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasEntryPoint).toBe(true)
    })

    test("detects express app as entry point", async () => {
      const content = `
import express from "express"

const app = express()
app.listen(3000)
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "server.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasEntryPoint).toBe(true)
    })

    test("detects main() call as entry point", async () => {
      const content = `
async function main() {
  console.log("starting")
}

main().catch(console.error)
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "main.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasEntryPoint).toBe(true)
    })

    test("does not detect entry point in library file", async () => {
      const content = `
export function helper() {}
export function util() {}
export const VERSION = "1.0.0"
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "lib.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasEntryPoint).toBe(false)
    })
  })

  describe("summary generation", () => {
    test("generates summary with all sections", async () => {
      const content = `
import fs from "fs"
import { Router } from "express"

interface Config {
  host: string
  port: number
}

type Status = "ok" | "error"

enum Level {
  Low,
  High
}

export class Server {
  private config: Config

  start(): void {}
  stop(): void {}
}

export function createServer(config: Config): Server {
  return new Server()
}

export namespace Utils {
  export function log(): void {}
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "server.ts" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: server.ts")
      expect(result.summary).toContain("TypeScript")
      expect(result.summary).toContain("ESM")
      expect(result.summary).toContain("Imports")
      expect(result.summary).toContain("Interfaces")
      expect(result.summary).toContain("Type Aliases")
      expect(result.summary).toContain("Enums")
      expect(result.summary).toContain("Classes")
      expect(result.summary).toContain("Functions")
      expect(result.summary).toContain("Namespaces")
      expect(result.summary).toContain("Exports")
    })

    test("token count is positive", async () => {
      const content = `
export function hello(): void {
  console.log("hello")
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "hello.ts" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("decorators", () => {
    test("parses class with decorators", async () => {
      const content = `
@Controller("/users")
export class UserController {
  @Get("/:id")
  getUser(id: string): User {
    return {} as User
  }

  @Post("/")
  @Validate()
  createUser(data: CreateUserDto): User {
    return {} as User
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "controller.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("UserController")
      expect(result.metadata.classes[0].isExported).toBe(true)
    })
  })

  describe("generics", () => {
    test("parses complex generic types", async () => {
      const content = `
type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

type Awaited<T> = T extends Promise<infer U> ? U : T

interface Repository<T extends Entity, ID = number> {
  findById(id: ID): Promise<T | null>
  save(entity: T): Promise<T>
  delete(id: ID): Promise<void>
}

class GenericService<T, K extends keyof T> {
  private data: Map<K, T[K]> = new Map()

  get(key: K): T[K] | undefined {
    return this.data.get(key)
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "generics.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(2)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.classes.length).toBe(1)

      const deepPartial = result.metadata.types.find((t) => t.name === "DeepPartial")
      expect(deepPartial).toBeDefined()
      expect(deepPartial?.isGeneric).toBe(true)

      const awaited = result.metadata.types.find((t) => t.name === "Awaited")
      expect(awaited).toBeDefined()
      expect(awaited?.isGeneric).toBe(true)
    })
  })

  describe("edge cases", () => {
    test("handles empty file", async () => {
      const result = await TypeScriptExplorer.explore({ content: "", filePath: "empty.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(0)
      expect(result.metadata.types.length).toBe(0)
      expect(result.metadata.classes.length).toBe(0)
      expect(result.metadata.functions.length).toBe(0)
    })

    test("handles file with only comments", async () => {
      const content = `
// This is a comment
/* This is a
   multi-line comment */
/**
 * JSDoc comment
 */
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "comments.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(0)
      expect(result.metadata.functions.length).toBe(0)
    })

    test("handles file without explicit path", async () => {
      const content = `
export function hello(): void {}
`
      const result = await TypeScriptExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("unknown.ts")
    })

    test("handles deeply nested structures", async () => {
      const content = `
interface Level1 {
  level2: {
    level3: {
      level4: {
        value: string
      }
    }
  }
}

type DeepNested = {
  a: {
    b: {
      c: {
        d: string
      }
    }
  }
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "nested.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(1)
      expect(result.metadata.types.length).toBe(1)
    })

    test("handles special characters in strings", async () => {
      const content = `
const template = \`Hello \${name}\`
const regex = /import.*from/g
const json = '{"key": "value"}'
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "special.ts" })

      expect(result.success).toBe(true)
    })

    test("handles mts and cts extensions", async () => {
      const mtsContent = `
export function esModule(): void {}
`
      const ctsContent = `
module.exports = { cjsModule: function() {} }
`
      const mtsResult = await TypeScriptExplorer.explore({ content: mtsContent, filePath: "module.mts" })
      const ctsResult = await TypeScriptExplorer.explore({ content: ctsContent, filePath: "module.cts" })

      expect(mtsResult.success).toBe(true)
      expect(mtsResult.metadata.moduleType).toBe("esm")

      expect(ctsResult.success).toBe(true)
      expect(ctsResult.metadata.moduleType).toBe("commonjs")
    })

    test("handles ambient module declarations", async () => {
      const content = `
declare module "custom-module" {
  export function customFn(): void
  export interface CustomType {}
}

declare module "*.css" {
  const styles: Record<string, string>
  export default styles
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "ambient.d.ts" })

      expect(result.success).toBe(true)
    })

    test("handles overloaded functions", async () => {
      const content = `
function process(value: string): string
function process(value: number): number
function process(value: string | number): string | number {
  return value
}

export { process }
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "overloads.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBeGreaterThan(0)
    })

    test("handles index signatures", async () => {
      const content = `
interface StringMap {
  [key: string]: string
}

interface NumberMap {
  [key: number]: string
}

type RecordLike = {
  [K in string]: unknown
}
`
      const result = await TypeScriptExplorer.explore({ content, filePath: "maps.ts" })

      expect(result.success).toBe(true)
      expect(result.metadata.interfaces.length).toBe(2)
      expect(result.metadata.types.length).toBe(1)
    })
  })
})
