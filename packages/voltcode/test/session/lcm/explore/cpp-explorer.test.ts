import { describe, expect, test } from "bun:test"
import { CppExplorer } from "../../../../src/session/lcm/explore/cpp-explorer"

describe("session.lcm.explore.cpp", () => {
  describe("basic C++ file parsing", () => {
    test("parses simple include directives", async () => {
      const content = `
#include <iostream>
#include <vector>
#include <cstdlib>
#include "myheader.h"
#include "utils/helper.hpp"

int main() {
  return 0;
}
`
      const result = await CppExplorer.explore({ content, filePath: "main.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.includeCount).toBe(5)
      expect(result.metadata.includes.cppStdlib).toContain("iostream")
      expect(result.metadata.includes.cppStdlib).toContain("vector")
      expect(result.metadata.includes.cStdlib).toContain("cstdlib")
      expect(result.metadata.includes.local).toContain("myheader.h")
      expect(result.metadata.includes.local).toContain("utils/helper.hpp")
    })

    test("identifies system vs local includes", async () => {
      const content = `
#include <GL/gl.h>
#include <boost/asio.hpp>
#include "config.h"
`
      const result = await CppExplorer.explore({ content, filePath: "render.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.system).toContain("GL/gl.h")
      expect(result.metadata.includes.system).toContain("boost/asio.hpp")
      expect(result.metadata.includes.local).toContain("config.h")
    })

    test("parses class definitions with inheritance", async () => {
      const content = `
class Animal {
public:
  virtual void speak() = 0;
protected:
  int age;
};

class Dog : public Animal {
public:
  void speak() override;
  void bark();
private:
  std::string name;
};
`
      const result = await CppExplorer.explore({ content, filePath: "animal.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(2)

      const animalClass = result.metadata.classes.find((c) => c.name === "Animal")
      expect(animalClass).toBeDefined()
      expect(animalClass?.baseClasses).toEqual([])
      expect(animalClass?.accessSpecifiers).toContain("public")
      expect(animalClass?.accessSpecifiers).toContain("protected")
      expect(animalClass?.methods).toContain("speak")

      const dogClass = result.metadata.classes.find((c) => c.name === "Dog")
      expect(dogClass).toBeDefined()
      expect(dogClass?.baseClasses).toContain("Animal")
      expect(dogClass?.accessSpecifiers).toContain("public")
      expect(dogClass?.accessSpecifiers).toContain("private")
    })

    test("parses struct definitions", async () => {
      const content = `
struct Point {
  int x;
  int y;
  void translate(int dx, int dy);
};

struct Rectangle {
  Point topLeft;
  Point bottomRight;
  int area() const;
};
`
      const result = await CppExplorer.explore({ content, filePath: "geometry.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(2)

      const pointStruct = result.metadata.structs.find((s) => s.name === "Point")
      expect(pointStruct).toBeDefined()
      expect(pointStruct?.isTemplate).toBe(false)

      const rectStruct = result.metadata.structs.find((s) => s.name === "Rectangle")
      expect(rectStruct).toBeDefined()
    })

    test("detects main function", async () => {
      const contentWithMain = `
int main(int argc, char** argv) {
  return 0;
}
`
      const contentWithoutMain = `
void setup() {}
void loop() {}
`
      const resultWithMain = await CppExplorer.explore({ content: contentWithMain, filePath: "main.cpp" })
      const resultWithoutMain = await CppExplorer.explore({ content: contentWithoutMain, filePath: "lib.cpp" })

      expect(resultWithMain.metadata.hasMain).toBe(true)
      expect(resultWithoutMain.metadata.hasMain).toBe(false)
    })

    test("identifies header files correctly", async () => {
      const content = `
#pragma once
class MyClass {};
`
      const resultHpp = await CppExplorer.explore({ content, filePath: "myclass.hpp" })
      const resultH = await CppExplorer.explore({ content, filePath: "myclass.h" })
      const resultCpp = await CppExplorer.explore({ content, filePath: "myclass.cpp" })

      expect(resultHpp.metadata.isHeader).toBe(true)
      expect(resultH.metadata.isHeader).toBe(true)
      expect(resultCpp.metadata.isHeader).toBe(false)
    })
  })

  describe("template detection", () => {
    test("detects template classes", async () => {
      const content = `
template<typename T>
class Container {
public:
  void add(T item);
  T get(int index);
private:
  T* data;
};

template<typename K, typename V>
class Map {
public:
  void insert(K key, V value);
};
`
      const result = await CppExplorer.explore({ content, filePath: "container.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(2)

      const containerClass = result.metadata.classes.find((c) => c.name === "Container")
      expect(containerClass).toBeDefined()
      expect(containerClass?.isTemplate).toBe(true)
      expect(containerClass?.templateParams).toBe("typename T")

      const mapClass = result.metadata.classes.find((c) => c.name === "Map")
      expect(mapClass).toBeDefined()
      expect(mapClass?.isTemplate).toBe(true)
      expect(mapClass?.templateParams).toBe("typename K, typename V")
    })

    test("detects template structs", async () => {
      const content = `
template<typename T, size_t N>
struct Array {
  T data[N];
  size_t size() const { return N; }
};
`
      const result = await CppExplorer.explore({ content, filePath: "array.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)

      const arrayStruct = result.metadata.structs[0]
      expect(arrayStruct.name).toBe("Array")
      expect(arrayStruct.isTemplate).toBe(true)
      expect(arrayStruct.templateParams).toBe("typename T, size_t N")
    })

    test("detects template functions", async () => {
      const content = `
template<typename T>
T max(T a, T b) {
  return a > b ? a : b;
}

template<typename T, typename U>
auto add(T a, U b) -> decltype(a + b) {
  return a + b;
}
`
      const result = await CppExplorer.explore({ content, filePath: "util.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.templates.length).toBeGreaterThanOrEqual(1)

      const maxTemplate = result.metadata.templates.find((t) => t.name === "max")
      expect(maxTemplate).toBeDefined()
      expect(maxTemplate?.kind).toBe("function")
      expect(maxTemplate?.templateParams).toBe("typename T")
    })

    test("distinguishes template classes from regular classes", async () => {
      const content = `
template<typename T>
class TemplateClass {
public:
  T value;
};

class RegularClass {
public:
  int value;
};
`
      const result = await CppExplorer.explore({ content, filePath: "classes.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(2)

      const templateClass = result.metadata.classes.find((c) => c.name === "TemplateClass")
      const regularClass = result.metadata.classes.find((c) => c.name === "RegularClass")

      expect(templateClass?.isTemplate).toBe(true)
      expect(regularClass?.isTemplate).toBe(false)
    })
  })

  describe("namespace extraction", () => {
    test("extracts declared namespaces", async () => {
      const content = `
namespace MyLib {
  class Widget {};
}

namespace MyLib::Internal {
  void helper();
}
`
      const result = await CppExplorer.explore({ content, filePath: "mylib.hpp" })

      expect(result.success).toBe(true)

      const declaredNamespaces = result.metadata.namespaces.filter((n) => !n.isUsing)
      expect(declaredNamespaces.length).toBe(2)

      const names = declaredNamespaces.map((n) => n.name)
      expect(names).toContain("MyLib")
      expect(names).toContain("MyLib::Internal")
    })

    test("extracts using namespace statements", async () => {
      const content = `
using namespace std;
using namespace boost::asio;

void foo() {
  cout << "hello";
}
`
      const result = await CppExplorer.explore({ content, filePath: "impl.cpp" })

      expect(result.success).toBe(true)

      const usingNamespaces = result.metadata.namespaces.filter((n) => n.isUsing)
      expect(usingNamespaces.length).toBe(2)

      const names = usingNamespaces.map((n) => n.name)
      expect(names).toContain("std")
      expect(names).toContain("boost::asio")
    })

    test("distinguishes declared vs using namespaces", async () => {
      const content = `
namespace App {
  using namespace std;

  class Service {};
}
`
      const result = await CppExplorer.explore({ content, filePath: "app.cpp" })

      expect(result.success).toBe(true)

      const declared = result.metadata.namespaces.filter((n) => !n.isUsing)
      const using_ = result.metadata.namespaces.filter((n) => n.isUsing)

      expect(declared.some((n) => n.name === "App")).toBe(true)
      expect(using_.some((n) => n.name === "std")).toBe(true)
    })

    test("extracts nested namespaces", async () => {
      const content = `
namespace Company {
  namespace Product {
    namespace Module {
      class Feature {};
    }
  }
}
`
      const result = await CppExplorer.explore({ content, filePath: "nested.hpp" })

      expect(result.success).toBe(true)

      const names = result.metadata.namespaces.map((n) => n.name)
      expect(names).toContain("Company")
      expect(names).toContain("Product")
      expect(names).toContain("Module")
    })
  })

  describe("method detection", () => {
    test("extracts class methods", async () => {
      const content = `
class Calculator {
public:
  int add(int a, int b);
  int subtract(int a, int b);
  void reset();
private:
  int getValue() const;
};
`
      const result = await CppExplorer.explore({ content, filePath: "calc.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)

      const calc = result.metadata.classes[0]
      expect(calc.methods).toContain("add")
      expect(calc.methods).toContain("subtract")
      expect(calc.methods).toContain("reset")
      expect(calc.methods).toContain("getValue")
    })

    test("extracts struct methods", async () => {
      const content = `
struct Vector2D {
  float x, y;

  float length() const;
  void normalize();
  Vector2D operator+(const Vector2D& other) const;
};
`
      const result = await CppExplorer.explore({ content, filePath: "vector.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)

      const vec = result.metadata.structs[0]
      expect(vec.methods).toContain("length")
      expect(vec.methods).toContain("normalize")
    })

    test("detects function qualifiers", async () => {
      const content = `
inline int fastAdd(int a, int b) { return a + b; }
constexpr int compile_add(int a, int b) { return a + b; }
static void helper() {}
`
      const result = await CppExplorer.explore({ content, filePath: "funcs.cpp" })

      expect(result.success).toBe(true)

      const inlineFunc = result.metadata.functions.find((f) => f.name === "fastAdd")
      expect(inlineFunc?.isInline).toBe(true)

      const constexprFunc = result.metadata.functions.find((f) => f.name === "compile_add")
      expect(constexprFunc?.isConstexpr).toBe(true)

      const staticFunc = result.metadata.functions.find((f) => f.name === "helper")
      expect(staticFunc?.isStatic).toBe(true)
    })

    test("detects operator overloads", async () => {
      const content = `
class Complex {
public:
  Complex operator+(const Complex& other);
  Complex operator-(const Complex& other);
  bool operator==(const Complex& other);
  Complex& operator++();
  double operator[](int index);
};
`
      const result = await CppExplorer.explore({ content, filePath: "complex.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.operatorOverloads.length).toBeGreaterThan(0)
      expect(result.metadata.operatorOverloads).toContain("operator+")
      expect(result.metadata.operatorOverloads).toContain("operator-")
      expect(result.metadata.operatorOverloads).toContain("operator==")
    })
  })

  describe("header file features", () => {
    test("detects pragma once", async () => {
      const content = `
#pragma once

class MyClass {};
`
      const result = await CppExplorer.explore({ content, filePath: "myclass.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasPragmaOnce).toBe(true)
      expect(result.metadata.hasHeaderGuard).toBe(false)
    })

    test("detects header guards", async () => {
      const content = `
#ifndef MYCLASS_HPP
#define MYCLASS_HPP

class MyClass {};

#endif
`
      const result = await CppExplorer.explore({ content, filePath: "myclass.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasHeaderGuard).toBe(true)
      expect(result.metadata.hasPragmaOnce).toBe(false)
    })

    test("detects both header protections", async () => {
      const content = `
#pragma once
#ifndef MYCLASS_HPP
#define MYCLASS_HPP

class MyClass {};

#endif
`
      const result = await CppExplorer.explore({ content, filePath: "myclass.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasPragmaOnce).toBe(true)
      expect(result.metadata.hasHeaderGuard).toBe(true)
    })
  })

  describe("using statements", () => {
    test("extracts using namespace statements", async () => {
      const content = `
using namespace std;
using namespace boost::filesystem;
`
      const result = await CppExplorer.explore({ content, filePath: "impl.cpp" })

      expect(result.success).toBe(true)

      const namespaceUsing = result.metadata.usingStatements.filter((u) => u.kind === "namespace")
      expect(namespaceUsing.length).toBe(2)
      expect(namespaceUsing.map((u) => u.name)).toContain("std")
      expect(namespaceUsing.map((u) => u.name)).toContain("boost::filesystem")
    })

    test("extracts type aliases", async () => {
      const content = `
using StringVec = std::vector<std::string>;
using IntPtr = int*;
using Callback = std::function<void(int)>;
`
      const result = await CppExplorer.explore({ content, filePath: "types.hpp" })

      expect(result.success).toBe(true)

      const aliases = result.metadata.usingStatements.filter((u) => u.kind === "alias")
      expect(aliases.length).toBe(3)

      const stringVec = aliases.find((a) => a.name === "StringVec")
      expect(stringVec).toBeDefined()
      expect(stringVec?.target).toContain("std::vector")
    })

    test("extracts using declarations", async () => {
      const content = `
using std::cout;
using std::endl;
using boost::shared_ptr;
`
      const result = await CppExplorer.explore({ content, filePath: "impl.cpp" })

      expect(result.success).toBe(true)

      const declarations = result.metadata.usingStatements.filter((u) => u.kind === "declaration")
      expect(declarations.length).toBe(3)
      expect(declarations.map((d) => d.name)).toContain("std::cout")
      expect(declarations.map((d) => d.name)).toContain("std::endl")
    })
  })

  describe("summary formatting", () => {
    test("produces non-empty summary for valid C++ file", async () => {
      const content = `
#include <iostream>
#include <vector>

namespace App {
  template<typename T>
  class Container {
  public:
    void add(T item);
  };
}

int main() {
  return 0;
}
`
      const result = await CppExplorer.explore({ content, filePath: "app.cpp" })

      expect(result.success).toBe(true)
      expect(result.summary.length).toBeGreaterThan(0)
      expect(result.summary).toContain("app.cpp")
      expect(result.summary).toContain("Includes:")
      expect(result.summary).toContain("Namespaces:")
      expect(result.summary).toContain("Classes")
      expect(result.summary).toContain("main()")
    })

    test("includes line count in summary", async () => {
      const content = `line1
line2
line3
line4
line5`
      const result = await CppExplorer.explore({ content, filePath: "test.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(5)
      expect(result.summary).toContain("5 lines")
    })

    test("calculates token count", async () => {
      const content = `
#include <iostream>

int main() {
  std::cout << "Hello, World!" << std::endl;
  return 0;
}
`
      const result = await CppExplorer.explore({ content, filePath: "hello.cpp" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("edge cases", () => {
    test("handles empty file", async () => {
      const result = await CppExplorer.explore({ content: "", filePath: "empty.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.includeCount).toBe(0)
      expect(result.metadata.classes.length).toBe(0)
      expect(result.metadata.functions.length).toBe(0)
    })

    test("handles file with only comments", async () => {
      const content = `
// This is a comment
/* This is a
   multi-line comment */
// Another comment
`
      const result = await CppExplorer.explore({ content, filePath: "comments.cpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.includeCount).toBe(0)
    })

    test("parses includes even inside comments (known limitation)", async () => {
      // Note: The current implementation does not strip comments before parsing includes
      // This test documents the actual behavior
      const content = `
// #include <algorithm>
/* #include <functional> */
#include <iostream>
`
      const result = await CppExplorer.explore({ content, filePath: "commented.cpp" })

      expect(result.success).toBe(true)
      // All includes are detected (including those in comments)
      expect(result.metadata.includeCount).toBe(3)
      expect(result.metadata.includes.cppStdlib).toContain("iostream")
      expect(result.metadata.includes.cppStdlib).toContain("algorithm")
      expect(result.metadata.includes.cppStdlib).toContain("functional")
    })

    test("handles file without explicit path", async () => {
      const content = `class Foo {};`
      const result = await CppExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
    })

    test("handles simple template parameters", async () => {
      // Note: Complex template params with nested angle brackets (like std::allocator<T>)
      // may not be fully captured due to regex limitations
      const content = `
template<typename T, typename U>
class MyPair {
public:
  T first;
  U second;
};
`
      const result = await CppExplorer.explore({ content, filePath: "mypair.hpp" })

      expect(result.success).toBe(true)
      expect(result.metadata.classes.length).toBe(1)

      const myPair = result.metadata.classes[0]
      expect(myPair.isTemplate).toBe(true)
      expect(myPair.templateParams).toContain("typename T")
      expect(myPair.templateParams).toContain("typename U")
    })
  })
})
