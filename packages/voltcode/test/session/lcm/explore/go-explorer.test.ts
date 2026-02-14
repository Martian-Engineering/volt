import { describe, expect, test } from "bun:test"
import { GoExplorer } from "../../../../src/session/lcm/explore/go-explorer"

describe("session.lcm.explore.go-explorer", () => {
  describe("basic Go file parsing", () => {
    test("parses package name", async () => {
      const content = `package main

import "fmt"

func main() {
	fmt.Println("Hello")
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.packageName).toBe("main")
    })

    test("parses single import", async () => {
      const content = `package main

import "fmt"

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.stdlib).toContain("fmt")
    })

    test("parses import block with stdlib imports", async () => {
      const content = `package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
)

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.stdlib).toContain("context")
      expect(result.metadata.imports.stdlib).toContain("fmt")
      expect(result.metadata.imports.stdlib).toContain("net/http")
      expect(result.metadata.imports.stdlib).toContain("os")
    })

    test("parses import block with third-party imports", async () => {
      const content = `package server

import (
	"fmt"
	"github.com/gin-gonic/gin"
	"github.com/sirupsen/logrus"
)

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "server.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.stdlib).toContain("fmt")
      expect(result.metadata.imports.thirdParty).toContain("github.com/gin-gonic/gin")
      expect(result.metadata.imports.thirdParty).toContain("github.com/sirupsen/logrus")
    })

    test("parses aliased imports", async () => {
      const content = `package main

import (
	"fmt"
	log "github.com/sirupsen/logrus"
	_ "github.com/lib/pq"
)

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.imports.stdlib).toContain("fmt")
      expect(result.metadata.imports.thirdParty).toContain("github.com/sirupsen/logrus")
      expect(result.metadata.imports.thirdParty).toContain("github.com/lib/pq")
    })

    test("counts line numbers correctly", async () => {
      const content = `package main

import "fmt"

func main() {
	fmt.Println("Hello")
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(8)
    })
  })

  describe("function extraction", () => {
    test("extracts standalone function", async () => {
      const content = `package main

func hello() {
	println("Hello")
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("hello")
      expect(result.metadata.functions[0].receiver).toBeUndefined()
      expect(result.metadata.functions[0].exported).toBe(false)
    })

    test("extracts exported function", async () => {
      const content = `package main

func Hello() {
	println("Hello")
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("Hello")
      expect(result.metadata.functions[0].exported).toBe(true)
    })

    test("extracts function with parameters", async () => {
      const content = `package main

func add(a int, b int) int {
	return a + b
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("add")
      expect(result.metadata.functions[0].params).toContain("int")
      expect(result.metadata.functions[0].returns).toContain("int")
    })

    test("extracts function with multiple return values", async () => {
      const content = `package main

func divide(a, b float64) (float64, error) {
	if b == 0 {
		return 0, errors.New("division by zero")
	}
	return a / b, nil
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(1)
      expect(result.metadata.functions[0].name).toBe("divide")
      expect(result.metadata.functions[0].returns).toContain("float64")
      expect(result.metadata.functions[0].returns).toContain("error")
    })

    test("extracts method with pointer receiver", async () => {
      const content = `package main

type Server struct {
	port int
}

func (s *Server) Start() error {
	return nil
}
`
      const result = await GoExplorer.explore({ content, filePath: "server.go" })

      expect(result.success).toBe(true)
      const method = result.metadata.functions.find((f) => f.name === "Start")
      expect(method).toBeDefined()
      expect(method!.receiver).toBe("*Server")
      expect(method!.exported).toBe(true)
    })

    test("extracts method with value receiver", async () => {
      const content = `package main

type Config struct {
	name string
}

func (c Config) Name() string {
	return c.name
}
`
      const result = await GoExplorer.explore({ content, filePath: "config.go" })

      expect(result.success).toBe(true)
      const method = result.metadata.functions.find((f) => f.name === "Name")
      expect(method).toBeDefined()
      expect(method!.receiver).toBe("Config")
      expect(method!.exported).toBe(true)
    })

    test("extracts multiple functions", async () => {
      const content = `package main

func init() {}

func setup() error {
	return nil
}

func Run(ctx context.Context) error {
	return nil
}

func cleanup() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.functions.length).toBe(4)

      const names = result.metadata.functions.map((f) => f.name)
      expect(names).toContain("init")
      expect(names).toContain("setup")
      expect(names).toContain("Run")
      expect(names).toContain("cleanup")
    })
  })

  describe("struct and interface detection", () => {
    test("detects struct definition", async () => {
      const content = `package main

type User struct {
	ID   int
	Name string
	Age  int
}
`
      const result = await GoExplorer.explore({ content, filePath: "user.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("User")
      expect(result.metadata.types[0].kind).toBe("struct")
      expect(result.metadata.types[0].exported).toBe(true)
      expect(result.metadata.types[0].memberCount).toBe(3)
    })

    test("detects unexported struct", async () => {
      const content = `package main

type config struct {
	host string
	port int
}
`
      const result = await GoExplorer.explore({ content, filePath: "config.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("config")
      expect(result.metadata.types[0].kind).toBe("struct")
      expect(result.metadata.types[0].exported).toBe(false)
    })

    test("detects interface definition", async () => {
      const content = `package main

type Reader interface {
	Read(p []byte) (n int, err error)
}
`
      const result = await GoExplorer.explore({ content, filePath: "reader.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("Reader")
      expect(result.metadata.types[0].kind).toBe("interface")
      expect(result.metadata.types[0].exported).toBe(true)
      expect(result.metadata.types[0].memberCount).toBe(1)
    })

    test("detects interface with multiple methods", async () => {
      const content = `package main

type ReadWriter interface {
	Read(p []byte) (n int, err error)
	Write(p []byte) (n int, err error)
	Close() error
}
`
      const result = await GoExplorer.explore({ content, filePath: "rw.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("ReadWriter")
      expect(result.metadata.types[0].kind).toBe("interface")
      expect(result.metadata.types[0].memberCount).toBe(3)
    })

    test("detects multiple types", async () => {
      const content = `package main

type Server struct {
	port int
}

type Handler interface {
	Handle() error
}

type Config struct {
	name string
	debug bool
}
`
      const result = await GoExplorer.explore({ content, filePath: "types.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(3)

      const names = result.metadata.types.map((t) => t.name)
      expect(names).toContain("Server")
      expect(names).toContain("Handler")
      expect(names).toContain("Config")

      const serverType = result.metadata.types.find((t) => t.name === "Server")
      expect(serverType!.kind).toBe("struct")

      const handlerType = result.metadata.types.find((t) => t.name === "Handler")
      expect(handlerType!.kind).toBe("interface")
    })

    test("detects empty struct", async () => {
      const content = `package main

type Empty struct {}
`
      const result = await GoExplorer.explore({ content, filePath: "empty.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("Empty")
      expect(result.metadata.types[0].kind).toBe("struct")
      expect(result.metadata.types[0].memberCount).toBe(0)
    })

    test("detects empty interface", async () => {
      const content = `package main

type Any interface {}
`
      const result = await GoExplorer.explore({ content, filePath: "any.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.types.length).toBe(1)
      expect(result.metadata.types[0].name).toBe("Any")
      expect(result.metadata.types[0].kind).toBe("interface")
      expect(result.metadata.types[0].memberCount).toBe(0)
    })
  })

  describe("main function detection", () => {
    test("detects main function in main package", async () => {
      const content = `package main

func main() {
	println("Hello, World!")
}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(true)
    })

    test("does not detect main when not present", async () => {
      const content = `package main

func run() {
	println("Running")
}
`
      const result = await GoExplorer.explore({ content, filePath: "run.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(false)
    })

    test("does not detect main method on a struct as hasMain", async () => {
      const content = `package main

type App struct {}

func (a *App) main() {
	println("This is a method, not the main function")
}

func run() {}
`
      const result = await GoExplorer.explore({ content, filePath: "app.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMain).toBe(false)
    })

    test("detects init functions", async () => {
      const content = `package main

func init() {
	println("First init")
}

func init() {
	println("Second init")
}

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.initCount).toBe(2)
      expect(result.metadata.hasMain).toBe(true)
    })
  })

  describe("globals detection", () => {
    test("detects single var", async () => {
      const content = `package main

var count int

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      const countVar = result.metadata.globals.find((g) => g.name === "count")
      expect(countVar).toBeDefined()
      expect(countVar!.kind).toBe("var")
      expect(countVar!.exported).toBe(false)
    })

    test("detects single const", async () => {
      const content = `package main

const MaxSize = 100

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      const maxSize = result.metadata.globals.find((g) => g.name === "MaxSize")
      expect(maxSize).toBeDefined()
      expect(maxSize!.kind).toBe("const")
      expect(maxSize!.exported).toBe(true)
    })

    test("detects const block", async () => {
      const content = `package main

const (
	StatusOK = 200
	StatusNotFound = 404
	StatusError = 500
)

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "status.go" })

      expect(result.success).toBe(true)
      const names = result.metadata.globals.map((g) => g.name)
      expect(names).toContain("StatusOK")
      expect(names).toContain("StatusNotFound")
      expect(names).toContain("StatusError")
    })

    test("detects var block", async () => {
      const content = `package main

var (
	host string
	port int
	Debug bool
)

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "config.go" })

      expect(result.success).toBe(true)
      const names = result.metadata.globals.map((g) => g.name)
      expect(names).toContain("host")
      expect(names).toContain("port")
      expect(names).toContain("Debug")

      const debugVar = result.metadata.globals.find((g) => g.name === "Debug")
      expect(debugVar!.exported).toBe(true)
    })
  })

  describe("build constraints", () => {
    test("detects go:build constraint", async () => {
      const content = `//go:build linux

package main

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "linux.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.buildConstraints).toContain("linux")
    })

    test("detects legacy +build constraint", async () => {
      const content = `// +build windows

package main

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "windows.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.buildConstraints).toContain("windows")
    })

    test("detects multiple build constraints", async () => {
      const content = `//go:build linux && amd64

package main

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "linux_amd64.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.buildConstraints).toContain("linux && amd64")
    })
  })

  describe("exports collection", () => {
    test("collects all exported symbols", async () => {
      const content = `package server

const MaxConnections = 100

var DefaultTimeout = 30

type Server struct {
	port int
}

type Handler interface {
	Handle()
}

func NewServer() *Server {
	return &Server{}
}

func (s *Server) Start() {}

func helper() {}
`
      const result = await GoExplorer.explore({ content, filePath: "server.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("MaxConnections")
      expect(result.metadata.exports).toContain("DefaultTimeout")
      expect(result.metadata.exports).toContain("Server")
      expect(result.metadata.exports).toContain("Handler")
      expect(result.metadata.exports).toContain("NewServer")
      expect(result.metadata.exports).toContain("Start")
      expect(result.metadata.exports).not.toContain("helper")
      expect(result.metadata.exports).not.toContain("port")
    })
  })

  describe("summary generation", () => {
    test("generates summary with all sections", async () => {
      const content = `//go:build linux

package server

import (
	"context"
	"fmt"
	"github.com/gin-gonic/gin"
)

const MaxConnections = 100

type Server struct {
	port int
}

type Handler interface {
	Handle() error
}

func NewServer(port int) *Server {
	return &Server{port: port}
}

func (s *Server) Start(ctx context.Context) error {
	return nil
}

func main() {
	fmt.Println("Starting server")
}
`
      const result = await GoExplorer.explore({ content, filePath: "server.go" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: server.go")
      expect(result.summary).toContain("Format: Go")
      expect(result.summary).toContain("Package: server")
      expect(result.summary).toContain("Build Constraints:")
      expect(result.summary).toContain("Imports")
      expect(result.summary).toContain("Types")
      expect(result.summary).toContain("Functions")
      expect(result.summary).toContain("Globals")
      expect(result.summary).toContain("Special:")
      expect(result.summary).toContain("main()")
    })

    test("token count is positive", async () => {
      const content = `package main

func main() {}
`
      const result = await GoExplorer.explore({ content, filePath: "main.go" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("edge cases", () => {
    test("handles empty file", async () => {
      const content = ``
      const result = await GoExplorer.explore({ content, filePath: "empty.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.packageName).toBe("unknown")
      expect(result.metadata.functions.length).toBe(0)
      expect(result.metadata.types.length).toBe(0)
    })

    test("handles file with only package declaration", async () => {
      const content = `package main
`
      const result = await GoExplorer.explore({ content, filePath: "minimal.go" })

      expect(result.success).toBe(true)
      expect(result.metadata.packageName).toBe("main")
      expect(result.metadata.hasMain).toBe(false)
    })

    test("uses default file path when not provided", async () => {
      const content = `package main

func main() {}
`
      const result = await GoExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: unknown.go")
    })
  })
})
