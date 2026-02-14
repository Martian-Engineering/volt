import { describe, expect, test } from "bun:test"
import { TclExplorer } from "../../../../src/session/lcm/explore/tcl-explorer"

describe("session.lcm.explore.tcl-explorer", () => {
  describe("basic Tcl file parsing", () => {
    test("parses simple proc", async () => {
      const content = `#!/usr/bin/env tclsh

proc hello {} {
    puts "Hello, World!"
}
`
      const result = await TclExplorer.explore({ content, filePath: "hello.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(1)
      expect(result.metadata.procs[0].name).toBe("hello")
      expect(result.metadata.procs[0].args).toEqual([])
    })

    test("parses proc with arguments", async () => {
      const content = `proc add {a b} {
    return [expr {$a + $b}]
}
`
      const result = await TclExplorer.explore({ content, filePath: "math.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(1)
      expect(result.metadata.procs[0].name).toBe("add")
      expect(result.metadata.procs[0].args).toContain("a")
      expect(result.metadata.procs[0].args).toContain("b")
    })

    test("parses proc with default arguments", async () => {
      const content = `proc greet {name {greeting "Hello"}} {
    puts "$greeting, $name!"
}
`
      const result = await TclExplorer.explore({ content, filePath: "greet.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(1)
      expect(result.metadata.procs[0].name).toBe("greet")
    })

    test("parses multiple procs", async () => {
      const content = `proc hello {} {
    puts "Hello"
}

proc goodbye {} {
    puts "Goodbye"
}

proc calculate {x y} {
    return [expr {$x * $y}]
}
`
      const result = await TclExplorer.explore({ content, filePath: "utils.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(3)
      const names = result.metadata.procs.map((p) => p.name)
      expect(names).toContain("hello")
      expect(names).toContain("goodbye")
      expect(names).toContain("calculate")
    })

    test("counts line numbers correctly", async () => {
      const content = `#!/usr/bin/env tclsh
# A simple Tcl script

proc hello {} {
    puts "Hello"
}
`
      const result = await TclExplorer.explore({ content, filePath: "hello.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.lineCount).toBe(7)
    })

    test("counts comment lines", async () => {
      const content = `# This is a comment
# Another comment
proc hello {} {
    # Comment inside proc
    puts "Hello"
}
# Final comment
`
      const result = await TclExplorer.explore({ content, filePath: "comments.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.commentCount).toBe(4)
    })
  })

  describe("package extraction", () => {
    test("extracts package require", async () => {
      const content = `package require Tk

proc main {} {
    wm title . "My App"
}
`
      const result = await TclExplorer.explore({ content, filePath: "app.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages.length).toBe(1)
      expect(result.metadata.packages[0].name).toBe("Tk")
    })

    test("extracts package require with version", async () => {
      const content = `package require Tcl 8.6
package require http 2.9

proc fetch {url} {
    return [http::geturl $url]
}
`
      const result = await TclExplorer.explore({ content, filePath: "http.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages.length).toBe(2)

      const tclPkg = result.metadata.packages.find((p) => p.name === "Tcl")
      expect(tclPkg).toBeDefined()
      expect(tclPkg!.version).toBe("8.6")

      const httpPkg = result.metadata.packages.find((p) => p.name === "http")
      expect(httpPkg).toBeDefined()
      expect(httpPkg!.version).toBe("2.9")
    })

    test("extracts multiple packages", async () => {
      const content = `package require Tk
package require tdom
package require sqlite3

proc init {} {
    # initialization
}
`
      const result = await TclExplorer.explore({ content, filePath: "app.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.packages.length).toBe(3)
      const names = result.metadata.packages.map((p) => p.name)
      expect(names).toContain("Tk")
      expect(names).toContain("tdom")
      expect(names).toContain("sqlite3")
    })
  })

  describe("namespace extraction", () => {
    test("extracts namespace eval", async () => {
      const content = `namespace eval MyApp {
    proc init {} {
        puts "Initializing"
    }
}
`
      const result = await TclExplorer.explore({ content, filePath: "myapp.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(1)
      expect(result.metadata.namespaces[0].name).toBe("MyApp")
    })

    test("extracts namespace with :: prefix", async () => {
      const content = `namespace eval ::Utils::Math {
    proc add {a b} {
        return [expr {$a + $b}]
    }
}
`
      const result = await TclExplorer.explore({ content, filePath: "math.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(1)
      expect(result.metadata.namespaces[0].name).toBe("Utils::Math")
    })

    test("extracts multiple namespaces", async () => {
      const content = `namespace eval ::App {
    variable version 1.0
}

namespace eval ::App::Utils {
    proc helper {} {}
}

namespace eval ::App::Core {
    proc main {} {}
}
`
      const result = await TclExplorer.explore({ content, filePath: "app.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(3)
      const names = result.metadata.namespaces.map((ns) => ns.name)
      expect(names).toContain("App")
      expect(names).toContain("App::Utils")
      expect(names).toContain("App::Core")
    })

    test("extracts namespace exports", async () => {
      const content = `namespace eval Math {
    namespace export add subtract multiply

    proc add {a b} { return [expr {$a + $b}] }
    proc subtract {a b} { return [expr {$a - $b}] }
    proc multiply {a b} { return [expr {$a * $b}] }
    proc _internal {} { puts "internal" }
}
`
      const result = await TclExplorer.explore({ content, filePath: "math.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("add")
      expect(result.metadata.exports).toContain("subtract")
      expect(result.metadata.exports).toContain("multiply")
      expect(result.metadata.exports).not.toContain("_internal")
    })

    test("extracts namespace exports with braces", async () => {
      const content = `namespace eval Utils {
    namespace export {init cleanup configure}

    proc init {} {}
    proc cleanup {} {}
    proc configure {args} {}
}
`
      const result = await TclExplorer.explore({ content, filePath: "utils.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.exports).toContain("init")
      expect(result.metadata.exports).toContain("cleanup")
      expect(result.metadata.exports).toContain("configure")
    })
  })

  describe("proc with namespace", () => {
    test("extracts proc with qualified name", async () => {
      const content = `proc ::MyApp::init {} {
    puts "Initializing MyApp"
}

proc ::MyApp::Utils::helper {arg} {
    return $arg
}
`
      const result = await TclExplorer.explore({ content, filePath: "app.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(2)

      const initProc = result.metadata.procs.find((p) => p.name === "init")
      expect(initProc).toBeDefined()
      expect(initProc!.namespace).toBe("::MyApp")

      const helperProc = result.metadata.procs.find((p) => p.name === "helper")
      expect(helperProc).toBeDefined()
      expect(helperProc!.namespace).toBe("::MyApp::Utils")
    })
  })

  describe("variable extraction", () => {
    test("extracts variable declaration", async () => {
      const content = `namespace eval Config {
    variable version 1.0
    variable debug false

    proc getVersion {} {
        variable version
        return $version
    }
}
`
      const result = await TclExplorer.explore({ content, filePath: "config.tcl" })

      expect(result.success).toBe(true)
      const vars = result.metadata.variables.filter((v) => v.type === "variable")
      expect(vars.length).toBeGreaterThanOrEqual(2)
      const names = vars.map((v) => v.name)
      expect(names).toContain("version")
      expect(names).toContain("debug")
    })

    test("extracts global declaration", async () => {
      const content = `set globalCounter 0

proc incrementCounter {} {
    global globalCounter
    incr globalCounter
}
`
      const result = await TclExplorer.explore({ content, filePath: "counter.tcl" })

      expect(result.success).toBe(true)
      const globals = result.metadata.variables.filter((v) => v.type === "global")
      expect(globals.length).toBeGreaterThanOrEqual(1)
      expect(globals.some((g) => g.name === "globalCounter")).toBe(true)
    })

    test("extracts multiple globals in one line", async () => {
      const content = `proc process {} {
    global input output error
    # process data
}
`
      const result = await TclExplorer.explore({ content, filePath: "process.tcl" })

      expect(result.success).toBe(true)
      const globals = result.metadata.variables.filter((v) => v.type === "global")
      const names = globals.map((v) => v.name)
      expect(names).toContain("input")
      expect(names).toContain("output")
      expect(names).toContain("error")
    })

    test("extracts upvar declaration", async () => {
      const content = `proc double {varName} {
    upvar 1 otherVar localVar
    set localVar [expr {$localVar * 2}]
}
`
      const result = await TclExplorer.explore({ content, filePath: "double.tcl" })

      expect(result.success).toBe(true)
      const upvars = result.metadata.variables.filter((v) => v.type === "upvar")
      expect(upvars.length).toBe(1)
      expect(upvars[0].name).toBe("localVar")
    })
  })

  describe("source file extraction", () => {
    test("extracts source commands", async () => {
      const content = `source utils.tcl
source "config.tcl"
source [file join $dir "lib.tcl"]

proc main {} {
    puts "Main"
}
`
      const result = await TclExplorer.explore({ content, filePath: "main.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.sources.length).toBe(3)
      const paths = result.metadata.sources.map((s) => s.path)
      expect(paths).toContain("utils.tcl")
      expect(paths).toContain("config.tcl")
    })
  })

  describe("Tk widget detection", () => {
    test("detects basic Tk widgets", async () => {
      const content = `package require Tk

button .btn -text "Click me" -command {puts "Clicked"}
label .lbl -text "Hello"
entry .ent -textvariable inputVar

pack .btn .lbl .ent
`
      const result = await TclExplorer.explore({ content, filePath: "gui.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTk).toBe(true)
      expect(result.metadata.tkWidgets).toContain("button")
      expect(result.metadata.tkWidgets).toContain("label")
      expect(result.metadata.tkWidgets).toContain("entry")
    })

    test("detects ttk widgets", async () => {
      const content = `package require Tk

ttk::button .btn -text "Click"
ttk::label .lbl -text "Label"
ttk::entry .ent
ttk::combobox .combo -values {one two three}
ttk::treeview .tree

pack .btn .lbl .ent .combo .tree
`
      const result = await TclExplorer.explore({ content, filePath: "ttk.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTk).toBe(true)
      expect(result.metadata.tkWidgets).toContain("ttk::button")
      expect(result.metadata.tkWidgets).toContain("ttk::label")
      expect(result.metadata.tkWidgets).toContain("ttk::entry")
      expect(result.metadata.tkWidgets).toContain("ttk::combobox")
      expect(result.metadata.tkWidgets).toContain("ttk::treeview")
    })

    test("detects frame and canvas", async () => {
      const content = `package require Tk

frame .f
canvas .c -width 400 -height 300
listbox .lb
scrollbar .sb

pack .f .c .lb .sb
`
      const result = await TclExplorer.explore({ content, filePath: "widgets.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTk).toBe(true)
      expect(result.metadata.tkWidgets).toContain("frame")
      expect(result.metadata.tkWidgets).toContain("canvas")
      expect(result.metadata.tkWidgets).toContain("listbox")
      expect(result.metadata.tkWidgets).toContain("scrollbar")
    })

    test("does not falsely detect Tk without widgets", async () => {
      const content = `proc calculate {x y} {
    return [expr {$x + $y}]
}

proc main {} {
    puts [calculate 5 3]
}
`
      const result = await TclExplorer.explore({ content, filePath: "calc.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTk).toBe(false)
      expect(result.metadata.tkWidgets.length).toBe(0)
    })
  })

  describe("OO class detection", () => {
    test("detects TclOO class", async () => {
      const content = `package require TclOO

oo::class create Person {
    variable name age

    constructor {n a} {
        set name $n
        set age $a
    }

    method greet {} {
        puts "Hello, I am $name"
    }
}
`
      const result = await TclExplorer.explore({ content, filePath: "person.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasOO).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Person")
      expect(result.metadata.classes[0].type).toBe("oo")
    })

    test("detects itcl class", async () => {
      const content = `package require Itcl

itcl::class Animal {
    private variable species
    private variable name

    constructor {s n} {
        set species $s
        set name $n
    }

    public method speak {} {
        puts "$name says hello"
    }
}
`
      const result = await TclExplorer.explore({ content, filePath: "animal.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasOO).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Animal")
      expect(result.metadata.classes[0].type).toBe("itcl")
    })

    test("detects multiple classes", async () => {
      const content = `package require TclOO

oo::class create Base {
    method init {} {}
}

oo::class create Derived {
    superclass Base
    method process {} {}
}

oo::class create Helper {
    method help {} {}
}
`
      const result = await TclExplorer.explore({ content, filePath: "classes.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasOO).toBe(true)
      expect(result.metadata.classes.length).toBe(3)
      const names = result.metadata.classes.map((c) => c.name)
      expect(names).toContain("Base")
      expect(names).toContain("Derived")
      expect(names).toContain("Helper")
    })

    test("detects class with :: prefix", async () => {
      const content = `package require TclOO

::oo::class create Widget {
    method render {} {}
}
`
      const result = await TclExplorer.explore({ content, filePath: "widget.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasOO).toBe(true)
      expect(result.metadata.classes.length).toBe(1)
      expect(result.metadata.classes[0].name).toBe("Widget")
    })
  })

  describe("main code detection", () => {
    test("detects main execution code", async () => {
      const content = `proc helper {} {
    return "helper"
}

puts "Starting application"
set result [helper]
puts $result
`
      const result = await TclExplorer.explore({ content, filePath: "main.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMainCode).toBe(true)
    })

    test("does not detect main code when only procs", async () => {
      const content = `proc init {} {
    puts "Init"
}

proc cleanup {} {
    puts "Cleanup"
}

proc main {} {
    init
    # do work
    cleanup
}
`
      const result = await TclExplorer.explore({ content, filePath: "lib.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasMainCode).toBe(false)
    })
  })

  describe("summary generation", () => {
    test("generates summary with all sections", async () => {
      const content = `#!/usr/bin/env wish
# A complete Tcl/Tk application

package require Tk
package require sqlite3 3.0

namespace eval App {
    variable version 1.0
    namespace export init run

    proc init {} {
        puts "Initializing"
    }

    proc run {} {
        puts "Running"
    }
}

oo::class create Widget {
    method render {} {}
}

button .btn -text "Click" -command {App::run}
pack .btn

puts "Application loaded"
`
      const result = await TclExplorer.explore({ content, filePath: "app.tcl" })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: app.tcl")
      expect(result.summary).toContain("Format: Tcl/Tk (OO)")
      expect(result.summary).toContain("Lines:")
      expect(result.summary).toContain("Comments:")
      expect(result.summary).toContain("Procedures:")
      expect(result.summary).toContain("Namespaces:")
      expect(result.summary).toContain("Required packages:")
      expect(result.summary).toContain("Exported procedures:")
      expect(result.summary).toContain("Classes:")
      expect(result.summary).toContain("Tk widgets used:")
    })

    test("token count is positive", async () => {
      const content = `proc hello {} {
    puts "Hello"
}
`
      const result = await TclExplorer.explore({ content, filePath: "hello.tcl" })

      expect(result.success).toBe(true)
      expect(result.tokenCount).toBeGreaterThan(0)
    })
  })

  describe("edge cases", () => {
    test("handles empty file", async () => {
      const content = ``
      const result = await TclExplorer.explore({ content, filePath: "empty.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(0)
      expect(result.metadata.namespaces.length).toBe(0)
      expect(result.metadata.packages.length).toBe(0)
      expect(result.metadata.lineCount).toBe(1) // empty string splits to [""]
    })

    test("handles file with only comments", async () => {
      const content = `# This is a comment
# Another comment
# More comments
`
      const result = await TclExplorer.explore({ content, filePath: "comments.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(0)
      expect(result.metadata.commentCount).toBe(3)
    })

    test("uses default file path when not provided", async () => {
      const content = `proc hello {} {
    puts "Hello"
}
`
      const result = await TclExplorer.explore({ content })

      expect(result.success).toBe(true)
      expect(result.summary).toContain("File: unknown.tcl")
    })

    test("handles proc with complex arguments", async () => {
      const content = `proc complex {required {optional default} args} {
    puts "required: $required"
    puts "optional: $optional"
    puts "args: $args"
}
`
      const result = await TclExplorer.explore({ content, filePath: "complex.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(1)
      expect(result.metadata.procs[0].name).toBe("complex")
    })

    test("handles inline comments", async () => {
      const content = `proc hello {} {
    set x 10 ;# this is an inline comment
    puts $x
}
`
      const result = await TclExplorer.explore({ content, filePath: "inline.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.procs.length).toBe(1)
    })

    test("handles nested namespaces", async () => {
      const content = `namespace eval ::A::B::C::D {
    proc deep {} {
        puts "Deep nested"
    }
}
`
      const result = await TclExplorer.explore({ content, filePath: "nested.tcl" })

      expect(result.success).toBe(true)
      expect(result.metadata.namespaces.length).toBe(1)
      expect(result.metadata.namespaces[0].name).toBe("A::B::C::D")
    })

    test("handles .tk file extension", async () => {
      const content = `package require Tk

label .lbl -text "Hello from .tk file"
pack .lbl
`
      const result = await TclExplorer.explore({ content, filePath: "gui.tk" })

      expect(result.success).toBe(true)
      expect(result.metadata.hasTk).toBe(true)
    })
  })
})
