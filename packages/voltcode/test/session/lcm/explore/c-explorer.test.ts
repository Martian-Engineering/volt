import { describe, expect, test } from "bun:test"
import { CExplorer } from "../../../../src/session/lcm/explore/c-explorer"

describe("session.lcm.explore.c-explorer", () => {
  describe("basic C file parsing", () => {
    test("parses simple C file with includes, functions, and structs", async () => {
      const content = `
#include <stdio.h>
#include <stdlib.h>
#include "myheader.h"

struct Point {
    int x;
    int y;
};

int add(int a, int b) {
    return a + b;
}

int main() {
    return 0;
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.stdlib).toContain("stdio.h")
      expect(result.metadata.includes.stdlib).toContain("stdlib.h")
      expect(result.metadata.includes.local).toContain("myheader.h")
      expect(result.metadata.functions.length).toBeGreaterThanOrEqual(2)
      expect(result.metadata.structs.length).toBe(1)
      expect(result.metadata.structs[0].name).toBe("Point")
    })

    test("extracts function details correctly", async () => {
      const content = `
static inline int helper(int x) {
    return x * 2;
}

void process(const char *name, int count) {
    // do something
}

int calculate(int a, int b, int c);
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)

      const helper = result.metadata.functions.find((f) => f.name === "helper")
      expect(helper).toBeDefined()
      expect(helper?.isStatic).toBe(true)
      expect(helper?.isInline).toBe(true)
      expect(helper?.returnType).toBe("int")
      expect(helper?.isDeclaration).toBe(false)

      const process = result.metadata.functions.find((f) => f.name === "process")
      expect(process).toBeDefined()
      expect(process?.returnType).toBe("void")
      expect(process?.params.length).toBe(2)

      const calculate = result.metadata.functions.find((f) => f.name === "calculate")
      expect(calculate).toBeDefined()
      expect(calculate?.isDeclaration).toBe(true)
    })

    test("parses struct fields correctly", async () => {
      const content = `
struct Person {
    char *name;
    int age;
    float height;
    char address[100];
};
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.structs.length).toBe(1)

      const person = result.metadata.structs[0]
      expect(person.name).toBe("Person")
      expect(person.fields.length).toBe(4)

      const addressField = person.fields.find((f) => f.name === "address")
      expect(addressField).toBeDefined()
      expect(addressField?.arraySize).toBe("100")
    })
  })

  describe("main function detection", () => {
    test("detects main function presence", async () => {
      const content = `
int main(int argc, char *argv[]) {
    return 0;
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("detects absence of main function", async () => {
      const content = `
int helper(int x) {
    return x + 1;
}

void process(void) {
    // utility function
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(false)
    })

    test("detects main with void parameters", async () => {
      const content = `
int main(void) {
    return 0;
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })
  })

  describe("header file detection", () => {
    test("identifies header file by .h extension", async () => {
      const content = `
#ifndef MY_HEADER_H
#define MY_HEADER_H

void my_function(void);

#endif
`
      const result = await CExplorer.explore({
        content,
        filePath: "myheader.h",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(true)
    })

    test("identifies source file by .c extension", async () => {
      const content = `
#include <stdio.h>

int main() { return 0; }
`
      const result = await CExplorer.explore({
        content,
        filePath: "main.c",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(false)
    })

    test("detects header guard pattern", async () => {
      const content = `
#ifndef UTILS_H
#define UTILS_H

int utility_func(int x);

#endif
`
      const result = await CExplorer.explore({
        content,
        filePath: "utils.h",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(true)
      expect(result.metadata.headerGuard).toBe("UTILS_H")
    })

    test("does not detect header guard for source files", async () => {
      const content = `
#ifndef UTILS_H
#define UTILS_H

int main() { return 0; }

#endif
`
      const result = await CExplorer.explore({
        content,
        filePath: "main.c",
      })

      expect(result.success).toBe(true)
      expect(result.metadata.isHeader).toBe(false)
      expect(result.metadata.headerGuard).toBeUndefined()
    })
  })

  describe("macro extraction", () => {
    test("extracts simple macros", async () => {
      const content = `
#define MAX_SIZE 100
#define PI 3.14159
#define DEBUG
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.macros.length).toBeGreaterThanOrEqual(3)

      const maxSize = result.metadata.macros.find((m) => m.name === "MAX_SIZE")
      expect(maxSize).toBeDefined()
      expect(maxSize?.isFunctionLike).toBe(false)
      expect(maxSize?.value).toBe("100")

      const pi = result.metadata.macros.find((m) => m.name === "PI")
      expect(pi).toBeDefined()
      expect(pi?.value).toBe("3.14159")

      const debug = result.metadata.macros.find((m) => m.name === "DEBUG")
      expect(debug).toBeDefined()
      expect(debug?.value).toBeUndefined()
    })

    test("extracts function-like macros", async () => {
      const content = `
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define SQUARE(x) ((x) * (x))
#define LOG(msg) printf("%s\\n", msg)
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)

      const min = result.metadata.macros.find((m) => m.name === "MIN")
      expect(min).toBeDefined()
      expect(min?.isFunctionLike).toBe(true)
      expect(min?.params).toEqual(["a", "b"])

      const square = result.metadata.macros.find((m) => m.name === "SQUARE")
      expect(square).toBeDefined()
      expect(square?.isFunctionLike).toBe(true)
      expect(square?.params).toEqual(["x"])
    })

    test("skips macros with header guard name patterns", async () => {
      // Header guards are identified by name pattern (_H, _H_, _INCLUDED suffix)
      // and are filtered out from the macro list
      const content = `#define BUFFER_SIZE 1024
#define MY_HEADER_H
#define VERSION 2`

      const result = await CExplorer.explore({
        content,
        filePath: "my_header.h",
      })

      expect(result.success).toBe(true)

      // Header guard macros ending in _H should be skipped
      expect(result.metadata.macros.find((m) => m.name === "MY_HEADER_H")).toBeUndefined()

      // Regular macros should be captured
      const bufferSize = result.metadata.macros.find((m) => m.name === "BUFFER_SIZE")
      expect(bufferSize).toBeDefined()
    })
  })

  describe("include categorization", () => {
    test("categorizes stdlib headers correctly", async () => {
      const content = `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.stdlib).toContain("stdio.h")
      expect(result.metadata.includes.stdlib).toContain("stdlib.h")
      expect(result.metadata.includes.stdlib).toContain("string.h")
      expect(result.metadata.includes.stdlib).toContain("math.h")
    })

    test("categorizes system headers correctly", async () => {
      const content = `
#include <unistd.h>
#include <pthread.h>
#include <sys/types.h>
#include <netinet/in.h>
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.system).toContain("unistd.h")
      expect(result.metadata.includes.system).toContain("pthread.h")
      expect(result.metadata.includes.system).toContain("sys/types.h")
      expect(result.metadata.includes.system).toContain("netinet/in.h")
    })

    test("categorizes local headers correctly", async () => {
      const content = `
#include "myheader.h"
#include "utils/helper.h"
#include "config.h"
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.includes.local).toContain("myheader.h")
      expect(result.metadata.includes.local).toContain("utils/helper.h")
      expect(result.metadata.includes.local).toContain("config.h")
    })
  })

  describe("enum parsing", () => {
    test("parses simple enum", async () => {
      const content = `
enum Color {
    RED,
    GREEN,
    BLUE
};
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Color")
      expect(result.metadata.enums[0].values.length).toBe(3)
      expect(result.metadata.enums[0].values[0].name).toBe("RED")
    })

    test("parses enum with explicit values", async () => {
      const content = `
enum Status {
    SUCCESS = 0,
    ERROR = -1,
    PENDING = 1
};
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)

      const success = result.metadata.enums[0].values.find((v) => v.name === "SUCCESS")
      expect(success?.value).toBe("0")

      const error = result.metadata.enums[0].values.find((v) => v.name === "ERROR")
      expect(error?.value).toBe("-1")
    })

    test("parses typedef enum", async () => {
      const content = `
typedef enum {
    SMALL,
    MEDIUM,
    LARGE
} Size;
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.enums.length).toBe(1)
      expect(result.metadata.enums[0].name).toBe("Size")
      expect(result.metadata.enums[0].isTypedef).toBe(true)
    })
  })

  describe("typedef parsing", () => {
    test("parses simple typedefs", async () => {
      const content = `
typedef unsigned int uint;
typedef long long int64;
typedef char* string;
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.typedefs.length).toBeGreaterThanOrEqual(2)

      const uint = result.metadata.typedefs.find((t) => t.name === "uint")
      expect(uint).toBeDefined()
      expect(uint?.originalType).toBe("unsigned int")
    })
  })

  describe("summary generation", () => {
    test("generates summary with correct format", async () => {
      const content = `
#include <stdio.h>

int main() {
    printf("Hello\\n");
    return 0;
}
`
      const result = await CExplorer.explore({
        content,
        filePath: "hello.c",
      })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: hello.c")
      expect(result.summary).toContain("Format: C Source File")
      expect(result.summary).toContain("Contains main() function")
      expect(result.tokenCount).toBeGreaterThan(0)
    })

    test("generates header summary with correct format", async () => {
      const content = `
#ifndef UTILS_H
#define UTILS_H

void helper(void);

#endif
`
      const result = await CExplorer.explore({
        content,
        filePath: "utils.h",
      })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: utils.h")
      expect(result.summary).toContain("Format: C Header File")
      expect(result.summary).toContain("Header guard: UTILS_H")
    })
  })

  describe("comment handling", () => {
    test("ignores single-line comments", async () => {
      const content = `
// This is a comment
#include <stdio.h>

// int fake_function(void) { return 0; }

int real_function(void) {
    return 1;
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)

      const fake = result.metadata.functions.find((f) => f.name === "fake_function")
      expect(fake).toBeUndefined()

      const real = result.metadata.functions.find((f) => f.name === "real_function")
      expect(real).toBeDefined()
    })

    test("ignores multi-line comments", async () => {
      const content = `
/*
 * This is a multi-line comment
 * int commented_out(void) { return 0; }
 */

int actual_function(void) {
    return 1;
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)

      const commented = result.metadata.functions.find((f) => f.name === "commented_out")
      expect(commented).toBeUndefined()

      const actual = result.metadata.functions.find((f) => f.name === "actual_function")
      expect(actual).toBeDefined()
    })
  })

  describe("error handling", () => {
    test("handles empty content gracefully", async () => {
      const result = await CExplorer.explore({ content: "" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(0)
      expect(result.metadata.includes.stdlib.length).toBe(0)
      expect(result.metadata.hasMain).toBe(false)
    })

    test("handles content with only whitespace", async () => {
      const result = await CExplorer.explore({ content: "   \n\n   \t\t   " })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(0)
    })
  })

  describe("varargs handling", () => {
    test("parses functions with varargs", async () => {
      const content = `
int printf(const char *format, ...);

void log_message(const char *fmt, ...) {
    // implementation
}
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)

      const printf = result.metadata.functions.find((f) => f.name === "printf")
      expect(printf).toBeDefined()
      expect(printf?.params.some((p) => p.type === "...")).toBe(true)
    })
  })

  describe("extern declarations", () => {
    test("parses extern declarations", async () => {
      const content = `
extern int global_counter;
extern void external_function(int x);
`
      const result = await CExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.metadata.externDeclarations.length).toBeGreaterThan(0)
    })
  })
})
