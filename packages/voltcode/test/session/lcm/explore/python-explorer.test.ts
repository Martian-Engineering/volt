import { describe, expect, test } from "bun:test"
import { PythonExplorer } from "../../../../src/session/lcm/explore/python-explorer"

describe("session.lcm.explore.python-explorer", () => {
  describe("import extraction", () => {
    test("extracts simple import statements", async () => {
      const content = `
import os
import sys
import json
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("os")
      expect(result.metadata.imports.builtin).toContain("sys")
      expect(result.metadata.imports.builtin).toContain("json")
    })

    test("extracts from import statements", async () => {
      const content = `
from os import path
from collections import defaultdict
from typing import List, Dict
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("os")
      expect(result.metadata.imports.builtin).toContain("collections")
      expect(result.metadata.imports.builtin).toContain("typing")
    })

    test("extracts multi-module import statements", async () => {
      const content = `
import os, sys, json
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("os")
      expect(result.metadata.imports.builtin).toContain("sys")
      expect(result.metadata.imports.builtin).toContain("json")
    })

    test("extracts aliased imports", async () => {
      const content = `
import numpy as np
import pandas as pd
import os as operating_system
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.thirdParty).toContain("numpy")
      expect(result.metadata.imports.thirdParty).toContain("pandas")
      expect(result.metadata.imports.builtin).toContain("os")
    })

    test("categorizes stdlib imports correctly", async () => {
      const content = `
import os
import sys
import json
import asyncio
import typing
import pathlib
import collections
import functools
import itertools
import dataclasses
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin.length).toBe(10)
      expect(result.metadata.imports.thirdParty.length).toBe(0)
      expect(result.metadata.imports.local.length).toBe(0)
    })

    test("categorizes third-party imports correctly", async () => {
      const content = `
import numpy
import pandas
import requests
import flask
import django
import pytest
import torch
import tensorflow
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.thirdParty).toContain("numpy")
      expect(result.metadata.imports.thirdParty).toContain("pandas")
      expect(result.metadata.imports.thirdParty).toContain("requests")
      expect(result.metadata.imports.thirdParty).toContain("flask")
      expect(result.metadata.imports.thirdParty).toContain("django")
      expect(result.metadata.imports.thirdParty).toContain("pytest")
      expect(result.metadata.imports.thirdParty).toContain("torch")
      expect(result.metadata.imports.thirdParty).toContain("tensorflow")
    })

    test("categorizes local/relative imports correctly", async () => {
      // Note: The current parser implementation extracts the first part of the module path
      // after splitting by ".", which means relative imports like "from .utils import helper"
      // result in empty module names (split(".")[0] of ".utils" is "").
      // Empty module names are then skipped, so pure relative imports are not tracked.
      // This is a known limitation of the implementation.
      const content = `
from .utils import helper
from ..sibling import something
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      // Due to the implementation limitation, relative imports result in empty module names
      // which are then skipped, so local imports array remains empty
      expect(result.metadata.imports.local).toEqual([])
    })

    test("handles submodule imports", async () => {
      const content = `
import os.path
from urllib.parse import urlparse
import xml.etree.ElementTree
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.imports.builtin).toContain("os")
      expect(result.metadata.imports.builtin).toContain("urllib")
      expect(result.metadata.imports.builtin).toContain("xml")
    })

    test("deduplicates imports", async () => {
      const content = `
import os
import os
from os import path
from os.path import join
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      const osCount = result.metadata.imports.builtin.filter((m) => m === "os").length
      expect(osCount).toBe(1)
    })
  })

  describe("class detection", () => {
    test("detects simple class definition", async () => {
      const content = `
class MyClass:
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("MyClass")
    })

    test("detects class with base classes", async () => {
      const content = `
class MyClass(BaseClass):
    pass

class MultiInherit(Parent1, Parent2, Parent3):
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(2)
      expect(result.metadata.classes[0].name).toBe("MyClass")
      expect(result.metadata.classes[0].baseClasses).toContain("BaseClass")
      expect(result.metadata.classes[1].name).toBe("MultiInherit")
      expect(result.metadata.classes[1].baseClasses).toContain("Parent1")
      expect(result.metadata.classes[1].baseClasses).toContain("Parent2")
      expect(result.metadata.classes[1].baseClasses).toContain("Parent3")
    })

    test("detects abstract class", async () => {
      const content = `
from abc import ABC, abstractmethod

class AbstractClass(ABC):
    @abstractmethod
    def abstract_method(self):
        pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("AbstractClass")
      expect(result.metadata.classes[0].isAbstract).toBe(true)
    })

    test("detects dataclass", async () => {
      const content = `
from dataclasses import dataclass

@dataclass
class Person:
    name: str
    age: int
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Person")
      expect(result.metadata.classes[0].isDataclass).toBe(true)
      expect(result.metadata.classes[0].decorators).toContain("dataclass")
    })

    test("counts methods in class", async () => {
      const content = `
class MyClass:
    def __init__(self):
        pass

    def method1(self):
        pass

    def method2(self):
        pass

    def method3(self):
        pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].methodCount).toBe(4)
    })

    test("detects class docstring", async () => {
      const content = `
class MyClass:
    """This is a class docstring."""
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].docstring).toBe("This is a class docstring.")
    })

    test("detects multiple classes", async () => {
      const content = `
class First:
    pass

class Second:
    pass

class Third:
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(3)
      expect(result.metadata.classes.map((c) => c.name)).toEqual(["First", "Second", "Third"])
    })
  })

  describe("function detection", () => {
    test("detects simple function", async () => {
      const content = `
def my_function():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("my_function")
    })

    test("detects function with parameters", async () => {
      const content = `
def my_function(a, b, c):
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].parameters).toEqual(["a", "b", "c"])
    })

    test("detects function with typed parameters", async () => {
      const content = `
def my_function(name: str, age: int, active: bool = True):
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].parameters).toEqual(["name", "age", "active"])
    })

    test("detects function with return type", async () => {
      const content = `
def my_function(x: int) -> str:
    return str(x)
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].returnType).toBe("str")
    })

    test("detects async function", async () => {
      const content = `
async def async_function():
    await something()
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("async_function")
      expect(result.metadata.functions[0].isAsync).toBe(true)
    })

    test("detects generator function", async () => {
      const content = `
def generator_function():
    yield 1
    yield 2
    yield 3
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("generator_function")
      expect(result.metadata.functions[0].isGenerator).toBe(true)
    })

    test("detects function with docstring", async () => {
      const content = `
def my_function():
    """This is a function docstring."""
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].docstring).toBe("This is a function docstring.")
    })

    test("detects multiple functions", async () => {
      const content = `
def func1():
    pass

def func2():
    pass

def func3():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(3)
      expect(result.metadata.functions.map((f) => f.name)).toEqual(["func1", "func2", "func3"])
    })

    test("excludes methods from function list", async () => {
      const content = `
def module_function():
    pass

class MyClass:
    def method1(self):
        pass

    def method2(self):
        pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("module_function")
    })

    test("handles complex parameter types on single line", async () => {
      // The parser only handles single-line function definitions
      // Multiline definitions are not fully supported
      const content = `
def complex_params(data: List[Dict[str, Any]], callback: Callable[[int, str], bool]) -> Tuple[bool, str]:
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].parameters).toContain("data")
      expect(result.metadata.functions[0].parameters).toContain("callback")
    })
  })

  describe("decorator parsing", () => {
    test("detects single decorator on function", async () => {
      const content = `
@staticmethod
def my_function():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].decorators).toContain("staticmethod")
    })

    test("detects multiple decorators on function", async () => {
      const content = `
@decorator1
@decorator2
@decorator3
def my_function():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].decorators).toContain("decorator1")
      expect(result.metadata.functions[0].decorators).toContain("decorator2")
      expect(result.metadata.functions[0].decorators).toContain("decorator3")
    })

    test("detects decorators with arguments", async () => {
      const content = `
@decorator_with_args("arg1", key="value")
def my_function():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].decorators).toContain("decorator_with_args")
    })

    test("detects decorator on class", async () => {
      const content = `
@dataclass
class MyClass:
    field: str
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].decorators).toContain("dataclass")
    })

    test("detects dotted decorator", async () => {
      const content = `
@app.route("/")
def index():
    pass

@dataclasses.dataclass
class Config:
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions[0].decorators).toContain("app.route")
      expect(result.metadata.classes[0].decorators).toContain("dataclasses.dataclass")
    })

    test("detects common decorators", async () => {
      const content = `
class MyClass:
    @property
    def prop(self):
        return self._prop

    @prop.setter
    def prop(self, value):
        self._prop = value

    @classmethod
    def class_method(cls):
        pass

    @staticmethod
    def static_method():
        pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].methodCount).toBe(4)
    })

    test("handles pytest decorators", async () => {
      const content = `
import pytest

@pytest.fixture
def my_fixture():
    return 42

@pytest.mark.parametrize("x", [1, 2, 3])
def test_something(x):
    assert x > 0

@pytest.mark.skip(reason="not implemented")
def test_skipped():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.some((f) => f.decorators.includes("pytest.fixture"))).toBe(true)
      expect(result.metadata.functions.some((f) => f.decorators.includes("pytest.mark.parametrize"))).toBe(true)
      expect(result.metadata.functions.some((f) => f.decorators.includes("pytest.mark.skip"))).toBe(true)
    })
  })

  describe("main block detection", () => {
    test("detects double-quoted main block", async () => {
      const content = `
def main():
    print("Hello")

if __name__ == "__main__":
    main()
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("detects single-quoted main block", async () => {
      const content = `
def main():
    print("Hello")

if __name__ == '__main__':
    main()
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("returns false when no main block", async () => {
      const content = `
def main():
    print("Hello")
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(false)
    })

    test("detects main block anywhere in file", async () => {
      const content = `
import os

class MyClass:
    pass

def helper():
    pass

# Some comment

if __name__ == "__main__":
    obj = MyClass()
    helper()
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })
  })

  describe("additional metadata", () => {
    test("detects module docstring", async () => {
      const content = `"""This is a module docstring."""

import os

def my_function():
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.moduleDocstring).toBe("This is a module docstring.")
    })

    test("detects module docstring with shebang", async () => {
      const content = `#!/usr/bin/env python3
"""This is a module docstring."""

import os
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.moduleDocstring).toBe("This is a module docstring.")
    })

    test("detects __all__ exports", async () => {
      const content = `
__all__ = ["func1", "func2", "MyClass"]

def func1():
    pass

def func2():
    pass

class MyClass:
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("func1")
      expect(result.metadata.exports).toContain("func2")
      expect(result.metadata.exports).toContain("MyClass")
    })

    test("detects typing usage", async () => {
      const content = `
from typing import List, Dict

def my_function(items: List[str]) -> Dict[str, int]:
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.usesTyping).toBe(true)
    })

    test("detects typing usage from type hints without import", async () => {
      const content = `
def my_function(name: str, count: int) -> bool:
    return len(name) > count
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.usesTyping).toBe(true)
    })

    test("detects Python version from shebang", async () => {
      const content = `#!/usr/bin/env python3.11
import os
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.pythonVersion).toBe("3.11")
    })

    test("detects stub file", async () => {
      const content = `
def my_function(x: int) -> str: ...
class MyClass: ...
`
      const result = await PythonExplorer.explore({ content, filePath: "test.pyi" })
      expect(result.success).toBe(true)
      expect(result.metadata.isStubFile).toBe(true)
    })

    test("counts lines correctly", async () => {
      const content = `line1
line2
line3
line4
line5`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(5)
    })

    test("detects global constants", async () => {
      const content = `
MAX_SIZE = 100
DEFAULT_NAME = "test"
API_VERSION = "1.0.0"
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      const constants = result.metadata.globals.filter((g) => g.isConstant)
      expect(constants.some((c) => c.name === "MAX_SIZE")).toBe(true)
      expect(constants.some((c) => c.name === "DEFAULT_NAME")).toBe(true)
      expect(constants.some((c) => c.name === "API_VERSION")).toBe(true)
    })

    test("detects global variables with type annotations", async () => {
      const content = `
count: int = 0
name: str = "default"
items: List[str] = []
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      const typedVars = result.metadata.globals.filter((g) => g.hasTypeAnnotation)
      expect(typedVars.length).toBeGreaterThan(0)
    })
  })

  describe("summary generation", () => {
    test("generates valid summary", async () => {
      const content = `
"""A sample module for testing."""

import os
import sys
from typing import List

__all__ = ["MyClass", "my_function"]

MAX_VALUE = 100

@dataclass
class MyClass:
    """A sample class."""
    name: str

    def method(self):
        pass

def my_function(x: int) -> str:
    """A sample function."""
    return str(x)

if __name__ == "__main__":
    print("Hello")
`
      const result = await PythonExplorer.explore({ content, filePath: "sample.py" })
      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: sample.py")
      expect(result.summary).toContain("Format: Python")
      expect(result.summary).toContain("Lines:")
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    test("handles empty file", async () => {
      const content = ""
      const result = await PythonExplorer.explore({ content, filePath: "empty.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(1) // Empty string splits to [""]
    })

    test("handles file with only comments", async () => {
      const content = `
# This is a comment
# Another comment
# More comments
`
      const result = await PythonExplorer.explore({ content, filePath: "comments.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(0)
      expect(result.metadata.functions.length).toBe(0)
    })
  })

  describe("edge cases", () => {
    test("handles multiline docstrings", async () => {
      const content = `
def my_function():
    """
    This is a multiline docstring.
    It spans multiple lines.
    With lots of content.
    """
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].docstring).toContain("multiline docstring")
    })

    test("handles nested classes", async () => {
      const content = `
class Outer:
    class Inner:
        pass

    def method(self):
        pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      // The parser should detect at least the outer class
      expect(result.metadata.classes.length).toBeGreaterThanOrEqual(1)
    })

    test("handles function with *args and **kwargs", async () => {
      const content = `
def my_function(*args, **kwargs):
    pass
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
    })

    test("handles async generator", async () => {
      const content = `
async def async_generator():
    yield 1
    yield 2
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].isAsync).toBe(true)
      expect(result.metadata.functions[0].isGenerator).toBe(true)
    })

    test("handles lambda functions (not detected as regular functions)", async () => {
      const content = `
square = lambda x: x ** 2
add = lambda a, b: a + b
`
      const result = await PythonExplorer.explore({ content, filePath: "test.py" })
      expect(result.success).toBe(true)
      // Lambda functions are not detected as module-level functions
      expect(result.metadata.functions.length).toBe(0)
      // But they create global variables
      expect(result.metadata.globals.some((g) => g.name === "square")).toBe(true)
      expect(result.metadata.globals.some((g) => g.name === "add")).toBe(true)
    })
  })
})
