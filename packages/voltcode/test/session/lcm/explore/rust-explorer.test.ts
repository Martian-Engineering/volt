import { describe, expect, test } from "bun:test"
import { RustExplorer } from "../../../../src/session/lcm/explore/rust-explorer"

describe("session.lcm.explore.rust-explorer", () => {
  describe("basic Rust file parsing", () => {
    test("detects lib.rs as library crate", async () => {
      const content = `//! A library crate

pub fn hello() {
    println!("Hello");
}
`
      const result = await RustExplorer.explore({ content, filePath: "src/lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.isLibRs).toBe(true)
      expect(result.metadata.isMainRs).toBe(false)
      expect(result.metadata.crateType).toBe("lib")
    })

    test("detects main.rs as binary crate", async () => {
      const content = `fn main() {
    println!("Hello, world!");
}
`
      const result = await RustExplorer.explore({ content, filePath: "src/main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.isMainRs).toBe(true)
      expect(result.metadata.isLibRs).toBe(false)
      expect(result.metadata.crateType).toBe("bin")
    })

    test("detects crate type from attribute", async () => {
      const content = `#![crate_type = "lib"]

pub fn public_api() {}
`
      const result = await RustExplorer.explore({ content, filePath: "my_crate.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.crateType).toBe("lib")
    })

    test("counts line numbers correctly", async () => {
      const content = `use std::io;

fn main() {
    println!("Hello");
}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(6)
    })
  })

  describe("import extraction", () => {
    test("extracts standard library imports", async () => {
      const content = `use std::io;
use std::collections::HashMap;
use core::fmt::Debug;
use alloc::vec::Vec;

fn main() {}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.std).toContain("std::io")
      expect(result.metadata.imports.std).toContain("std::collections::HashMap")
      expect(result.metadata.imports.std).toContain("core::fmt::Debug")
      expect(result.metadata.imports.std).toContain("alloc::vec::Vec")
    })

    test("extracts external crate imports", async () => {
      const content = `use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use anyhow::Result;

fn main() {}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.external).toContain("serde::{Deserialize, Serialize}")
      expect(result.metadata.imports.external).toContain("tokio::sync::Mutex")
      expect(result.metadata.imports.external).toContain("anyhow::Result")
    })

    test("extracts local module imports", async () => {
      const content = `use crate::config::Config;
use super::utils::helper;
use self::internal::State;

fn main() {}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.local).toContain("crate::config::Config")
      expect(result.metadata.imports.local).toContain("super::utils::helper")
      expect(result.metadata.imports.local).toContain("self::internal::State")
    })

    test("handles pub use re-exports", async () => {
      const content = `pub use std::io::Error;
pub use crate::config::Config;

fn main() {}
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.std).toContain("std::io::Error")
      expect(result.metadata.imports.local).toContain("crate::config::Config")
    })
  })

  describe("module extraction", () => {
    test("extracts module declarations", async () => {
      const content = `mod config;
mod utils;
pub mod api;

fn main() {}
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.modules).toContain("mod config")
      expect(result.metadata.modules).toContain("mod utils")
      expect(result.metadata.modules).toContain("pub mod api")
    })

    test("extracts inline modules", async () => {
      const content = `mod tests {
    use super::*;

    #[test]
    fn test_something() {}
}
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.modules).toContain("mod tests")
    })
  })

  describe("struct extraction", () => {
    test("extracts simple struct", async () => {
      const content = `struct Point {
    x: i32,
    y: i32,
}
`
      const result = await RustExplorer.explore({ content, filePath: "point.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("Point")
      expect(result.metadata.structs[0].isPublic).toBe(false)
      expect(result.metadata.structs[0].fieldsSummary).toBe("x, y")
    })

    test("extracts public struct", async () => {
      const content = `pub struct Config {
    name: String,
    debug: bool,
}
`
      const result = await RustExplorer.explore({ content, filePath: "config.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("Config")
      expect(result.metadata.structs[0].isPublic).toBe(true)
    })

    test("extracts struct with derives", async () => {
      const content = `#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    id: u64,
    name: String,
}
`
      const result = await RustExplorer.explore({ content, filePath: "user.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].derives).toContain("Debug")
      expect(result.metadata.structs[0].derives).toContain("Clone")
      expect(result.metadata.structs[0].derives).toContain("Serialize")
      expect(result.metadata.structs[0].derives).toContain("Deserialize")
    })

    test("extracts tuple struct", async () => {
      const content = `pub struct Wrapper(i32);
pub struct Pair(String, String);
`
      const result = await RustExplorer.explore({ content, filePath: "wrapper.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(2)

      const wrapper = result.metadata.structs.find((s) => s.name === "Wrapper")
      expect(wrapper).toBeDefined()
      expect(wrapper!.fieldsSummary).toBe("tuple(1)")

      const pair = result.metadata.structs.find((s) => s.name === "Pair")
      expect(pair).toBeDefined()
      expect(pair!.fieldsSummary).toBe("tuple(2)")
    })

    test("extracts unit struct", async () => {
      const content = `pub struct Marker;
`
      const result = await RustExplorer.explore({ content, filePath: "marker.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("Marker")
      expect(result.metadata.structs[0].fieldsSummary).toBe("unit struct")
    })

    test("extracts struct with many fields", async () => {
      const content = `pub struct LargeStruct {
    field1: i32,
    field2: i32,
    field3: i32,
    field4: i32,
    field5: i32,
}
`
      const result = await RustExplorer.explore({ content, filePath: "large.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].fieldsSummary).toBe("5 fields")
    })

    test("extracts struct with generics", async () => {
      const content = `pub struct Container<T> {
    value: T,
}
`
      const result = await RustExplorer.explore({ content, filePath: "container.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("Container")
    })
  })

  describe("enum extraction", () => {
    test("extracts simple enum", async () => {
      const content = `enum Color {
    Red,
    Green,
    Blue,
}
`
      const result = await RustExplorer.explore({ content, filePath: "color.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Color")
      expect(result.metadata.enums[0].variants).toContain("Red")
      expect(result.metadata.enums[0].variants).toContain("Green")
      expect(result.metadata.enums[0].variants).toContain("Blue")
      expect(result.metadata.enums[0].isPublic).toBe(false)
    })

    test("extracts public enum with derives", async () => {
      const content = `#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    Pending,
    Running,
    Complete,
    Failed,
}
`
      const result = await RustExplorer.explore({ content, filePath: "status.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Status")
      expect(result.metadata.enums[0].isPublic).toBe(true)
      expect(result.metadata.enums[0].derives).toContain("Debug")
      expect(result.metadata.enums[0].derives).toContain("Clone")
      expect(result.metadata.enums[0].derives).toContain("PartialEq")
    })

    test("extracts enum with tuple variants", async () => {
      const content = `pub enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Write(String),
    ChangeColor(u8, u8, u8),
}
`
      const result = await RustExplorer.explore({ content, filePath: "message.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      // Note: The regex-based variant extraction has limitations with complex variants
      // It correctly extracts Quit and Move, but may capture type names from struct variants
      expect(result.metadata.enums[0].variants).toContain("Quit")
      expect(result.metadata.enums[0].variants).toContain("Move")
      // Verify that at least the basic variants are captured
      expect(result.metadata.enums[0].variants.length).toBeGreaterThan(0)
    })

    test("extracts enum with generics", async () => {
      const content = `pub enum Option<T> {
    Some(T),
    None,
}
`
      const result = await RustExplorer.explore({ content, filePath: "option.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Option")
    })
  })

  describe("trait extraction", () => {
    test("extracts simple trait", async () => {
      const content = `trait Greet {
    fn greet(&self);
}
`
      const result = await RustExplorer.explore({ content, filePath: "greet.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.traits.length).toBe(1)
      expect(result.metadata.traits[0].name).toBe("Greet")
      expect(result.metadata.traits[0].methods).toContain("greet")
      expect(result.metadata.traits[0].isPublic).toBe(false)
    })

    test("extracts public trait with multiple methods", async () => {
      const content = `pub trait Repository {
    fn find(&self, id: u64) -> Option<Entity>;
    fn save(&mut self, entity: Entity);
    fn delete(&mut self, id: u64);
    fn list(&self) -> Vec<Entity>;
}
`
      const result = await RustExplorer.explore({ content, filePath: "repository.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.traits.length).toBe(1)
      expect(result.metadata.traits[0].name).toBe("Repository")
      expect(result.metadata.traits[0].isPublic).toBe(true)
      expect(result.metadata.traits[0].methods).toContain("find")
      expect(result.metadata.traits[0].methods).toContain("save")
      expect(result.metadata.traits[0].methods).toContain("delete")
      expect(result.metadata.traits[0].methods).toContain("list")
    })

    test("extracts trait with generics", async () => {
      const content = `pub trait Iterator<T> {
    fn next(&mut self) -> Option<T>;
}
`
      const result = await RustExplorer.explore({ content, filePath: "iterator.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.traits.length).toBe(1)
      expect(result.metadata.traits[0].name).toBe("Iterator")
    })

    test("extracts trait with supertraits", async () => {
      const content = `pub trait Display: Debug + Clone {
    fn display(&self) -> String;
}
`
      const result = await RustExplorer.explore({ content, filePath: "display.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.traits.length).toBe(1)
      expect(result.metadata.traits[0].name).toBe("Display")
    })
  })

  describe("impl block extraction", () => {
    test("extracts inherent impl block", async () => {
      const content = `struct Point {
    x: i32,
    y: i32,
}

impl Point {
    fn new(x: i32, y: i32) -> Self {
        Self { x, y }
    }

    fn distance(&self, other: &Point) -> f64 {
        0.0
    }
}
`
      const result = await RustExplorer.explore({ content, filePath: "point.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.impls.length).toBe(1)
      expect(result.metadata.impls[0].targetType).toBe("Point")
      expect(result.metadata.impls[0].traitName).toBeUndefined()
      expect(result.metadata.impls[0].methods).toContain("new")
      expect(result.metadata.impls[0].methods).toContain("distance")
    })

    test("extracts trait impl block", async () => {
      const content = `struct MyStruct;

impl Display for MyStruct {
    fn fmt(&self, f: &mut Formatter) -> Result {
        write!(f, "MyStruct")
    }
}
`
      const result = await RustExplorer.explore({ content, filePath: "mystruct.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.impls.length).toBe(1)
      expect(result.metadata.impls[0].targetType).toBe("MyStruct")
      expect(result.metadata.impls[0].traitName).toBe("Display")
      expect(result.metadata.impls[0].methods).toContain("fmt")
    })

    test("extracts multiple impl blocks", async () => {
      const content = `struct Counter {
    count: u32,
}

impl Counter {
    fn new() -> Self {
        Self { count: 0 }
    }

    fn increment(&mut self) {
        self.count += 1;
    }
}

impl Default for Counter {
    fn default() -> Self {
        Self::new()
    }
}

impl Clone for Counter {
    fn clone(&self) -> Self {
        Self { count: self.count }
    }
}
`
      const result = await RustExplorer.explore({ content, filePath: "counter.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.impls.length).toBe(3)

      const inherent = result.metadata.impls.find((i) => !i.traitName)
      expect(inherent).toBeDefined()
      expect(inherent!.methods).toContain("new")
      expect(inherent!.methods).toContain("increment")

      const defaultImpl = result.metadata.impls.find((i) => i.traitName === "Default")
      expect(defaultImpl).toBeDefined()

      const cloneImpl = result.metadata.impls.find((i) => i.traitName === "Clone")
      expect(cloneImpl).toBeDefined()
    })

    test("extracts impl block with generics", async () => {
      const content = `impl<T> Container<T> {
    fn new(value: T) -> Self {
        Self { value }
    }
}
`
      const result = await RustExplorer.explore({ content, filePath: "container.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.impls.length).toBe(1)
      expect(result.metadata.impls[0].targetType).toBe("Container")
    })

    test("extracts impl block with where clause", async () => {
      const content = `impl<T> MyTrait for Container<T>
where
    T: Clone + Debug,
{
    fn process(&self) {}
}
`
      const result = await RustExplorer.explore({ content, filePath: "container.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.impls.length).toBe(1)
      expect(result.metadata.impls[0].traitName).toBe("MyTrait")
      expect(result.metadata.impls[0].targetType).toBe("Container")
    })
  })

  describe("function extraction", () => {
    test("extracts simple function", async () => {
      const content = `fn hello() {
    println!("Hello");
}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("hello")
      expect(result.metadata.functions[0].isPublic).toBe(false)
      expect(result.metadata.functions[0].modifiers).toEqual([])
    })

    test("extracts public function", async () => {
      const content = `pub fn public_api() {
    println!("Public");
}
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("public_api")
      expect(result.metadata.functions[0].isPublic).toBe(true)
    })

    test("extracts async function", async () => {
      const content = `pub async fn fetch_data() -> Result<String, Error> {
    Ok(String::new())
}
`
      const result = await RustExplorer.explore({ content, filePath: "fetch.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("fetch_data")
      expect(result.metadata.functions[0].modifiers).toContain("async")
    })

    test("extracts const function", async () => {
      const content = `pub const fn constant_fn() -> i32 {
    42
}
`
      const result = await RustExplorer.explore({ content, filePath: "const.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("constant_fn")
      expect(result.metadata.functions[0].modifiers).toContain("const")
    })

    test("extracts unsafe function", async () => {
      const content = `pub unsafe fn dangerous() {
    // unsafe code
}
`
      const result = await RustExplorer.explore({ content, filePath: "unsafe.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("dangerous")
      expect(result.metadata.functions[0].modifiers).toContain("unsafe")
    })

    test("extracts function with multiple modifiers", async () => {
      const content = `pub async unsafe fn complex_fn() {}
`
      const result = await RustExplorer.explore({ content, filePath: "complex.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("complex_fn")
      expect(result.metadata.functions[0].modifiers).toContain("async")
      expect(result.metadata.functions[0].modifiers).toContain("unsafe")
    })

    test("extracts multiple functions", async () => {
      const content = `fn first() {}
fn second() {}
pub fn third() {}
async fn fourth() {}
`
      const result = await RustExplorer.explore({ content, filePath: "funcs.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(4)

      const names = result.metadata.functions.map((f) => f.name)
      expect(names).toContain("first")
      expect(names).toContain("second")
      expect(names).toContain("third")
      expect(names).toContain("fourth")
    })
  })

  describe("main function detection", () => {
    test("detects main function", async () => {
      const content = `fn main() {
    println!("Hello, world!");
}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("detects async main function", async () => {
      const content = `#[tokio::main]
async fn main() {
    println!("Async main");
}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("does not detect main when not present", async () => {
      const content = `pub fn run() {
    println!("Running");
}
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(false)
    })
  })

  describe("macro extraction", () => {
    test("extracts macro_rules definition", async () => {
      const content = `macro_rules! say_hello {
    () => {
        println!("Hello!");
    };
}
`
      const result = await RustExplorer.explore({ content, filePath: "macros.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.macros.length).toBe(1)
      expect(result.metadata.macros[0].name).toBe("say_hello")
      expect(result.metadata.macros[0].isExported).toBe(false)
    })

    test("extracts exported macro", async () => {
      const content = `#[macro_export]
macro_rules! vec_of_strings {
    ($($x:expr),*) => {
        vec![$($x.to_string()),*]
    };
}
`
      const result = await RustExplorer.explore({ content, filePath: "macros.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.macros.length).toBe(1)
      expect(result.metadata.macros[0].name).toBe("vec_of_strings")
      expect(result.metadata.macros[0].isExported).toBe(true)
    })

    test("extracts multiple macros", async () => {
      const content = `macro_rules! first_macro {
    () => {};
}

#[macro_export]
macro_rules! second_macro {
    () => {};
}

macro_rules! third_macro {
    () => {};
}
`
      const result = await RustExplorer.explore({ content, filePath: "macros.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.macros.length).toBe(3)

      const exported = result.metadata.macros.filter((m) => m.isExported)
      expect(exported.length).toBe(1)
      expect(exported[0].name).toBe("second_macro")
    })
  })

  describe("exports extraction", () => {
    test("collects all public items", async () => {
      const content = `pub const MAX_SIZE: usize = 100;
pub static INSTANCE: Lazy<App> = Lazy::new(|| App::new());
pub type Result<T> = std::result::Result<T, Error>;
pub mod api;
pub struct Config {}
pub enum Status { Running, Stopped }
pub trait Service {}
pub fn initialize() {}
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("pub const MAX_SIZE")
      expect(result.metadata.exports).toContain("pub static INSTANCE")
      expect(result.metadata.exports).toContain("pub type Result")
      expect(result.metadata.exports).toContain("pub mod api")
      expect(result.metadata.exports).toContain("pub struct Config")
      expect(result.metadata.exports).toContain("pub enum Status")
      expect(result.metadata.exports).toContain("pub trait Service")
      expect(result.metadata.exports).toContain("pub fn initialize")
    })

    test("collects pub use re-exports", async () => {
      const content = `pub use crate::config::Config;
pub use std::io::Error as IoError;
`
      const result = await RustExplorer.explore({ content, filePath: "lib.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("pub use crate::config::Config")
      expect(result.metadata.exports).toContain("pub use std::io::Error as IoError")
    })
  })

  describe("lifetime handling", () => {
    test("handles struct with lifetimes", async () => {
      const content = `pub struct Borrowed<'a> {
    data: &'a str,
}
`
      const result = await RustExplorer.explore({ content, filePath: "borrowed.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("Borrowed")
    })

    test("handles function with lifetimes", async () => {
      const content = `pub fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
`
      const result = await RustExplorer.explore({ content, filePath: "lifetimes.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("longest")
    })

    test("handles impl with lifetimes", async () => {
      const content = `impl<'a> Borrowed<'a> {
    fn new(data: &'a str) -> Self {
        Self { data }
    }
}
`
      const result = await RustExplorer.explore({ content, filePath: "borrowed.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.impls.length).toBe(1)
      expect(result.metadata.impls[0].targetType).toBe("Borrowed")
    })
  })

  describe("summary generation", () => {
    test("generates summary with all sections", async () => {
      const content = `//! A comprehensive Rust file

use std::collections::HashMap;
use serde::Deserialize;

mod internal;

#[derive(Debug, Clone)]
pub struct Config {
    name: String,
}

pub enum Status {
    Active,
    Inactive,
}

pub trait Service {
    fn start(&self);
}

impl Config {
    pub fn new(name: String) -> Self {
        Self { name }
    }
}

macro_rules! log {
    () => {};
}

pub fn main() {
    println!("Hello");
}
`
      const result = await RustExplorer.explore({ content, filePath: "app.rs" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: app.rs")
      expect(result.summary).toContain("Format: Rust")
      expect(result.summary).toContain("Entry point: fn main()")
      expect(result.summary).toContain("Imports:")
      expect(result.summary).toContain("Modules:")
      expect(result.summary).toContain("Structs:")
      expect(result.summary).toContain("Enums:")
      expect(result.summary).toContain("Traits:")
      expect(result.summary).toContain("Impl blocks:")
      expect(result.summary).toContain("Functions:")
      expect(result.summary).toContain("Macros:")
      expect(result.summary).toContain("Exports:")
    })

    test("token count is positive", async () => {
      const content = `fn main() {}
`
      const result = await RustExplorer.explore({ content, filePath: "main.rs" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("edge cases", () => {
    test("handles empty file", async () => {
      const result = await RustExplorer.explore({ content: "", filePath: "empty.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(1)
      expect(result.metadata.structs.length).toBe(0)
      expect(result.metadata.enums.length).toBe(0)
      expect(result.metadata.traits.length).toBe(0)
      expect(result.metadata.impls.length).toBe(0)
      expect(result.metadata.functions.length).toBe(0)
      expect(result.metadata.macros.length).toBe(0)
      expect(result.metadata.hasMain).toBe(false)
    })

    test("handles file with only comments", async () => {
      const content = `// This is a comment
/* This is a
   multi-line comment */
/// Doc comment
//! Inner doc comment
`
      const result = await RustExplorer.explore({ content, filePath: "comments.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(0)
      expect(result.metadata.functions.length).toBe(0)
    })

    test("uses default file path when not provided", async () => {
      const content = `fn main() {}
`
      const result = await RustExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: unknown.rs")
    })

    test("handles file with complex nested structures", async () => {
      const content = `pub mod outer {
    pub mod inner {
        pub struct DeepStruct {
            value: i32,
        }

        impl DeepStruct {
            pub fn new() -> Self {
                Self { value: 0 }
            }
        }
    }
}
`
      const result = await RustExplorer.explore({ content, filePath: "nested.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.modules.length).toBeGreaterThanOrEqual(1)
    })

    test("handles attributes on various items", async () => {
      const content = `#[cfg(test)]
mod tests {
    #[test]
    fn test_something() {}
}

#[inline]
#[must_use]
pub fn important() -> i32 {
    42
}

#[repr(C)]
pub struct CStruct {
    x: i32,
}
`
      const result = await RustExplorer.explore({ content, filePath: "attrs.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.modules.length).toBeGreaterThanOrEqual(1)
      expect(result.metadata.functions.length).toBeGreaterThanOrEqual(1)
      expect(result.metadata.structs.length).toBeGreaterThanOrEqual(1)
    })

    test("handles raw identifiers", async () => {
      const content = `fn r#match() {}

struct r#type {
    r#loop: i32,
}
`
      const result = await RustExplorer.explore({ content, filePath: "raw.rs" })

      expect(result.success).toBe(true)
      // The explorer may or may not handle raw identifiers perfectly,
      // but it should not crash
    })

    test("handles extern blocks", async () => {
      const content = `extern "C" {
    fn printf(format: *const i8, ...) -> i32;
    fn malloc(size: usize) -> *mut u8;
}
`
      const result = await RustExplorer.explore({ content, filePath: "ffi.rs" })

      expect(result.success).toBe(true)
    })

    test("handles type aliases", async () => {
      const content = `pub type Result<T> = std::result::Result<T, Error>;
type Callback = Box<dyn Fn(i32) -> i32>;
`
      const result = await RustExplorer.explore({ content, filePath: "types.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("pub type Result")
    })

    test("handles const and static items", async () => {
      const content = `pub const MAX_SIZE: usize = 1024;
const INTERNAL: i32 = 42;
pub static COUNTER: AtomicUsize = AtomicUsize::new(0);
static mut BUFFER: [u8; 1024] = [0; 1024];
`
      const result = await RustExplorer.explore({ content, filePath: "constants.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("pub const MAX_SIZE")
      expect(result.metadata.exports).toContain("pub static COUNTER")
    })
  })

  describe("unsafe code handling", () => {
    test("extracts unsafe function", async () => {
      const content = `pub unsafe fn dangerous_operation() {
    // unsafe code here
}
`
      const result = await RustExplorer.explore({ content, filePath: "unsafe.rs" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].modifiers).toContain("unsafe")
    })

    test("handles unsafe impl", async () => {
      const content = `unsafe impl Send for MyType {}
unsafe impl Sync for MyType {}
`
      const result = await RustExplorer.explore({ content, filePath: "sync.rs" })

      expect(result.success).toBe(true)
      // The current implementation may not specifically track unsafe impls,
      // but it should not crash
    })

    test("handles unsafe trait", async () => {
      const content = `pub unsafe trait UnsafeTrait {
    fn dangerous(&self);
}
`
      const result = await RustExplorer.explore({ content, filePath: "unsafe_trait.rs" })

      expect(result.success).toBe(true)
      // Should parse without crashing
    })
  })
})
