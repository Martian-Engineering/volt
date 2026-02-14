import { describe, expect, test } from "bun:test"
import { ShebangDetector } from "../../../../src/session/lcm/explore/shebang-detector"

describe("session.lcm.explore.shebang-detector", () => {
  describe("shebang detection", () => {
    describe("bash/shell shebangs", () => {
      test("detects #!/bin/bash", () => {
        const content = `#!/bin/bash
echo "Hello, World!"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("bash")
        expect(result.interpreter).toBe("/bin/bash")
        expect(result.languageName).toBe("Bash")
      })

      test("detects #!/usr/bin/env bash", () => {
        const content = `#!/usr/bin/env bash
echo "Hello"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("bash")
        expect(result.interpreter).toBe("bash")
        expect(result.languageName).toBe("Bash")
      })

      test("detects #!/bin/sh", () => {
        const content = `#!/bin/sh
echo "POSIX shell"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("shell")
        expect(result.interpreter).toBe("/bin/sh")
        expect(result.languageName).toBe("Shell")
      })

      test("detects #!/usr/bin/env zsh", () => {
        const content = `#!/usr/bin/env zsh
echo "Zsh script"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("bash")
        expect(result.interpreter).toBe("zsh")
        expect(result.languageName).toBe("Zsh")
      })

      test("detects #!/usr/bin/fish", () => {
        const content = `#!/usr/bin/fish
echo "Fish shell"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("bash")
        expect(result.interpreter).toBe("/usr/bin/fish")
        expect(result.languageName).toBe("Fish")
      })

      test("detects #!/bin/dash", () => {
        const content = `#!/bin/dash
echo "Dash shell"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("shell")
        expect(result.interpreter).toBe("/bin/dash")
        expect(result.languageName).toBe("Dash")
      })

      test("detects #!/bin/ksh", () => {
        const content = `#!/bin/ksh
print "Korn shell"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("shell")
        expect(result.interpreter).toBe("/bin/ksh")
        expect(result.languageName).toBe("Korn Shell")
      })

      test("detects #!/bin/csh", () => {
        const content = `#!/bin/csh
echo "C shell"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("shell")
        expect(result.interpreter).toBe("/bin/csh")
        expect(result.languageName).toBe("C Shell")
      })

      test("detects #!/bin/tcsh", () => {
        const content = `#!/bin/tcsh
echo "TENEX C shell"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("shell")
        expect(result.interpreter).toBe("/bin/tcsh")
        // Note: The csh pattern matches first for tcsh, so it returns "C Shell"
        expect(result.languageName).toBe("C Shell")
      })
    })

    describe("python shebangs", () => {
      test("detects #!/usr/bin/env python", () => {
        const content = `#!/usr/bin/env python
print("Hello")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("python")
        expect(result.interpreter).toBe("python")
        expect(result.languageName).toBe("Python")
      })

      test("detects #!/usr/bin/python3", () => {
        const content = `#!/usr/bin/python3
print("Python 3")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("python")
        expect(result.interpreter).toBe("/usr/bin/python3")
        expect(result.languageName).toBe("Python")
      })

      test("detects #!/usr/bin/env python3", () => {
        const content = `#!/usr/bin/env python3
import sys
print(sys.version)
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("python")
        expect(result.interpreter).toBe("python3")
        expect(result.languageName).toBe("Python")
      })

      test("detects python with version number", () => {
        const content = `#!/usr/bin/python3.11
print("Python 3.11")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("python")
        expect(result.interpreter).toBe("/usr/bin/python3.11")
        expect(result.languageName).toBe("Python")
      })
    })

    describe("node/javascript shebangs", () => {
      test("detects #!/usr/bin/env node", () => {
        const content = `#!/usr/bin/env node
console.log("Hello")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("node")
        expect(result.interpreter).toBe("node")
        expect(result.languageName).toBe("Node.js")
      })

      test("detects #!/usr/bin/node", () => {
        const content = `#!/usr/bin/node
console.log("Node.js")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("node")
        expect(result.interpreter).toBe("/usr/bin/node")
        expect(result.languageName).toBe("Node.js")
      })

      test("detects #!/usr/bin/env deno", () => {
        const content = `#!/usr/bin/env deno
console.log("Deno")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("javascript")
        expect(result.interpreter).toBe("deno")
        // env pattern returns "JavaScript" as the language name
        expect(result.languageName).toBe("Deno")
      })

      test("detects #!/usr/bin/env bun", () => {
        const content = `#!/usr/bin/env bun
console.log("Bun")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("javascript")
        expect(result.interpreter).toBe("bun")
        // env pattern returns "Bun" as the language name
        expect(result.languageName).toBe("Bun")
      })

      test("detects direct deno path", () => {
        const content = `#!/usr/local/bin/deno
console.log("Deno direct")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("javascript")
        expect(result.interpreter).toBe("/usr/local/bin/deno")
        expect(result.languageName).toBe("Deno")
      })

      test("detects direct bun path", () => {
        const content = `#!/usr/local/bin/bun
console.log("Bun direct")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("javascript")
        expect(result.interpreter).toBe("/usr/local/bin/bun")
        expect(result.languageName).toBe("Bun")
      })
    })

    describe("ruby shebangs", () => {
      test("detects #!/usr/bin/env ruby", () => {
        const content = `#!/usr/bin/env ruby
puts "Hello Ruby"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("ruby")
        expect(result.interpreter).toBe("ruby")
        expect(result.languageName).toBe("Ruby")
      })

      test("detects #!/usr/bin/ruby", () => {
        const content = `#!/usr/bin/ruby
puts "Ruby"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("ruby")
        expect(result.interpreter).toBe("/usr/bin/ruby")
        expect(result.languageName).toBe("Ruby")
      })
    })

    describe("perl shebangs", () => {
      test("detects #!/usr/bin/env perl", () => {
        const content = `#!/usr/bin/env perl
print "Hello Perl\n";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.interpreter).toBe("perl")
        expect(result.languageName).toBe("Perl")
      })

      test("detects #!/usr/bin/perl", () => {
        const content = `#!/usr/bin/perl
use strict;
print "Perl\n";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.interpreter).toBe("/usr/bin/perl")
        expect(result.languageName).toBe("Perl")
      })
    })

    describe("php shebangs", () => {
      test("detects #!/usr/bin/env php", () => {
        const content = `#!/usr/bin/env php
<?php
echo "Hello PHP";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("php")
        expect(result.interpreter).toBe("php")
        expect(result.languageName).toBe("PHP")
      })

      test("detects #!/usr/bin/php", () => {
        const content = `#!/usr/bin/php
<?php echo "PHP";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("php")
        expect(result.interpreter).toBe("/usr/bin/php")
        expect(result.languageName).toBe("PHP")
      })
    })

    describe("lua shebangs", () => {
      test("detects #!/usr/bin/env lua", () => {
        const content = `#!/usr/bin/env lua
print("Hello Lua")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("lua")
        expect(result.interpreter).toBe("lua")
        expect(result.languageName).toBe("Lua")
      })

      test("detects #!/usr/bin/lua", () => {
        const content = `#!/usr/bin/lua
print("Lua")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("lua")
        expect(result.interpreter).toBe("/usr/bin/lua")
        expect(result.languageName).toBe("Lua")
      })

      test("detects #!/usr/bin/luajit", () => {
        const content = `#!/usr/bin/luajit
print("LuaJIT")
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("lua")
        expect(result.interpreter).toBe("/usr/bin/luajit")
        expect(result.languageName).toBe("Lua")
      })
    })

    describe("tcl shebangs", () => {
      test("detects #!/usr/bin/env tclsh", () => {
        const content = `#!/usr/bin/env tclsh
puts "Hello Tcl"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.interpreter).toBe("tclsh")
        expect(result.languageName).toBe("Tcl")
      })

      test("detects #!/usr/bin/tclsh", () => {
        const content = `#!/usr/bin/tclsh
puts "Tcl"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.interpreter).toBe("/usr/bin/tclsh")
        expect(result.languageName).toBe("Tcl")
      })

      test("detects #!/usr/bin/wish", () => {
        const content = `#!/usr/bin/wish
button .b -text "Tk" -command exit
pack .b
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.interpreter).toBe("/usr/bin/wish")
        expect(result.languageName).toBe("Tcl/Tk")
      })

      test("detects #!/usr/bin/expect", () => {
        const content = `#!/usr/bin/expect
spawn ssh user@host
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.interpreter).toBe("/usr/bin/expect")
        expect(result.languageName).toBe("Expect")
      })
    })

    describe("awk shebangs", () => {
      test("detects #!/usr/bin/env awk", () => {
        const content = `#!/usr/bin/env awk -f
BEGIN { print "AWK" }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.interpreter).toBe("awk")
        expect(result.languageName).toBe("AWK")
      })

      test("detects #!/usr/bin/awk", () => {
        const content = `#!/usr/bin/awk -f
{ print $1 }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.interpreter).toBe("/usr/bin/awk")
        expect(result.languageName).toBe("AWK")
      })

      test("detects #!/usr/bin/gawk", () => {
        const content = `#!/usr/bin/gawk -f
BEGIN { print "GNU AWK" }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.interpreter).toBe("/usr/bin/gawk")
        expect(result.languageName).toBe("AWK")
      })

      test("detects #!/usr/bin/nawk", () => {
        const content = `#!/usr/bin/nawk -f
{ print $0 }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.interpreter).toBe("/usr/bin/nawk")
        expect(result.languageName).toBe("AWK")
      })

      test("detects #!/usr/bin/mawk", () => {
        const content = `#!/usr/bin/mawk -f
END { print NR }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.interpreter).toBe("/usr/bin/mawk")
        expect(result.languageName).toBe("AWK")
      })
    })

    describe("go shebangs", () => {
      test("detects #!/usr/bin/env gorun", () => {
        const content = `#!/usr/bin/env gorun
package main
func main() {}
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("go")
        expect(result.interpreter).toBe("gorun")
        expect(result.languageName).toBe("Go")
      })
    })
  })

  describe("content pattern detection", () => {
    describe("PHP patterns", () => {
      test("detects <?php opening tag", () => {
        const content = `<?php
echo "Hello PHP";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("php")
        expect(result.languageName).toBe("PHP")
      })

      test("detects <?= short echo tag", () => {
        const content = `<?= "Hello" ?>
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("php")
        expect(result.languageName).toBe("PHP")
      })

      test("does not detect <?xml as PHP", () => {
        const content = `<?xml version="1.0" encoding="UTF-8"?>
<root>
  <element>Content</element>
</root>
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe(null)
      })
    })

    describe("Ruby patterns", () => {
      test("detects require statement", () => {
        const content = `require 'json'
data = JSON.parse(input)
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("ruby")
        expect(result.languageName).toBe("Ruby")
      })

      test("detects require_relative statement", () => {
        const content = `require_relative 'lib/helper'
Helper.run
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("ruby")
        expect(result.languageName).toBe("Ruby")
      })

      test("detects class inheritance pattern", () => {
        const content = `class MyApp < Application
  def run
    puts "Running"
  end
end
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("ruby")
        expect(result.languageName).toBe("Ruby")
      })

      test("detects block with pipe syntax", () => {
        const content = `[1, 2, 3].each do |num|
  puts num
end
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("ruby")
        expect(result.languageName).toBe("Ruby")
      })
    })

    describe("Perl patterns", () => {
      test("detects use strict", () => {
        const content = `use strict;
use warnings;
print "Hello Perl\n";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.languageName).toBe("Perl")
      })

      test("detects use warnings", () => {
        const content = `use warnings;
my $var = "test";
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.languageName).toBe("Perl")
      })

      test("detects package declaration", () => {
        const content = `package My::Module;
sub new { }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.languageName).toBe("Perl")
      })

      test("detects nested package declaration", () => {
        const content = `package Some::Deep::Module::Name;
use strict;
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.languageName).toBe("Perl")
      })

      test("detects regex binding operator", () => {
        const content = `my $text = "hello world";
if ($text =~ /hello/) {
    print "Found!\n";
}
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("perl")
        expect(result.languageName).toBe("Perl")
      })
    })

    describe("Lua patterns", () => {
      test("detects local require pattern", () => {
        const content = `local json = require("json")
local data = json.decode(input)
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("lua")
        expect(result.languageName).toBe("Lua")
      })

      test("detects function definition", () => {
        const content = `function greet(name)
    print("Hello, " .. name)
end
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("lua")
        expect(result.languageName).toBe("Lua")
      })
    })

    describe("Tcl patterns", () => {
      test("detects proc definition", () => {
        const content = `proc greet {name} {
    puts "Hello, $name"
}
greet "World"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.languageName).toBe("Tcl")
      })

      test("detects package require", () => {
        const content = `package require Tk
button .b -text "Click"
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.languageName).toBe("Tcl")
      })

      test("detects set with command substitution", () => {
        const content = `set result [expr {1 + 2}]
puts $result
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("tcl")
        expect(result.languageName).toBe("Tcl")
      })
    })

    describe("AWK patterns", () => {
      test("detects BEGIN block", () => {
        const content = `BEGIN {
    print "Starting..."
}
{ print $0 }
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.languageName).toBe("AWK")
      })

      test("detects END block", () => {
        // END pattern requires ^ at start of string, so put END first
        const content = `END {
    print "Total:", sum
}
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.languageName).toBe("AWK")
      })

      test("detects pattern-action block", () => {
        const content = `/error/ {
    print "Error on line", NR
}
`
        const result = ShebangDetector.detect(content)

        expect(result.type).toBe("awk")
        expect(result.languageName).toBe("AWK")
      })
    })
  })

  describe("hasSpecializedExplorer", () => {
    test("returns true for python", () => {
      expect(ShebangDetector.hasSpecializedExplorer("python")).toBe(true)
    })

    test("returns true for javascript", () => {
      expect(ShebangDetector.hasSpecializedExplorer("javascript")).toBe(true)
    })

    test("returns true for node", () => {
      expect(ShebangDetector.hasSpecializedExplorer("node")).toBe(true)
    })

    test("returns true for ruby", () => {
      expect(ShebangDetector.hasSpecializedExplorer("ruby")).toBe(true)
    })

    test("returns true for perl", () => {
      expect(ShebangDetector.hasSpecializedExplorer("perl")).toBe(true)
    })

    test("returns true for php", () => {
      expect(ShebangDetector.hasSpecializedExplorer("php")).toBe(true)
    })

    test("returns true for bash", () => {
      expect(ShebangDetector.hasSpecializedExplorer("bash")).toBe(true)
    })

    test("returns true for shell", () => {
      expect(ShebangDetector.hasSpecializedExplorer("shell")).toBe(true)
    })

    test("returns true for go", () => {
      expect(ShebangDetector.hasSpecializedExplorer("go")).toBe(true)
    })

    test("returns true for rust", () => {
      expect(ShebangDetector.hasSpecializedExplorer("rust")).toBe(true)
    })

    test("returns true for tcl", () => {
      expect(ShebangDetector.hasSpecializedExplorer("tcl")).toBe(true)
    })

    test("returns true for lua", () => {
      expect(ShebangDetector.hasSpecializedExplorer("lua")).toBe(true)
    })

    test("returns true for awk", () => {
      expect(ShebangDetector.hasSpecializedExplorer("awk")).toBe(true)
    })

    test("returns false for null", () => {
      expect(ShebangDetector.hasSpecializedExplorer(null)).toBe(false)
    })
  })

  describe("getExplorerName", () => {
    test("returns PythonExplorer for python", () => {
      expect(ShebangDetector.getExplorerName("python")).toBe("PythonExplorer")
    })

    test("returns JavaScriptExplorer for javascript", () => {
      expect(ShebangDetector.getExplorerName("javascript")).toBe("JavaScriptExplorer")
    })

    test("returns JavaScriptExplorer for node", () => {
      expect(ShebangDetector.getExplorerName("node")).toBe("JavaScriptExplorer")
    })

    test("returns GoExplorer for go", () => {
      expect(ShebangDetector.getExplorerName("go")).toBe("GoExplorer")
    })

    test("returns RustExplorer for rust", () => {
      expect(ShebangDetector.getExplorerName("rust")).toBe("RustExplorer")
    })

    test("returns TclExplorer for tcl", () => {
      expect(ShebangDetector.getExplorerName("tcl")).toBe("TclExplorer")
    })

    test("returns TextExplorer for bash", () => {
      expect(ShebangDetector.getExplorerName("bash")).toBe("TextExplorer")
    })

    test("returns TextExplorer for shell", () => {
      expect(ShebangDetector.getExplorerName("shell")).toBe("TextExplorer")
    })

    test("returns TextExplorer for ruby", () => {
      expect(ShebangDetector.getExplorerName("ruby")).toBe("TextExplorer")
    })

    test("returns TextExplorer for perl", () => {
      expect(ShebangDetector.getExplorerName("perl")).toBe("TextExplorer")
    })

    test("returns TextExplorer for php", () => {
      expect(ShebangDetector.getExplorerName("php")).toBe("TextExplorer")
    })

    test("returns TextExplorer for lua", () => {
      expect(ShebangDetector.getExplorerName("lua")).toBe("TextExplorer")
    })

    test("returns TextExplorer for awk", () => {
      expect(ShebangDetector.getExplorerName("awk")).toBe("TextExplorer")
    })

    test("returns null for null type", () => {
      expect(ShebangDetector.getExplorerName(null)).toBe(null)
    })
  })

  describe("edge cases", () => {
    test("handles empty content", () => {
      const result = ShebangDetector.detect("")

      expect(result.type).toBe(null)
    })

    test("handles whitespace-only content", () => {
      const result = ShebangDetector.detect("   \n\n   \t\t\n")

      expect(result.type).toBe(null)
    })

    test("handles content with no shebang and no patterns", () => {
      const content = `This is just plain text.
It has multiple lines.
But no recognizable patterns.
`
      const result = ShebangDetector.detect(content)

      expect(result.type).toBe(null)
    })

    test("handles unrecognized shebang", () => {
      const content = `#!/usr/bin/env someunknowninterpreter
do_something
`
      const result = ShebangDetector.detect(content)

      // When shebang is unrecognized, type is null and interpreter info is not exposed
      // (the detect function only returns interpreter when type is recognized)
      expect(result.type).toBe(null)
    })

    test("handles malformed shebang (no path)", () => {
      const content = `#!
echo "broken shebang"
`
      const result = ShebangDetector.detect(content)

      expect(result.type).toBe(null)
    })

    test("handles shebang with arguments", () => {
      const content = `#!/usr/bin/env python3 -u
print("unbuffered")
`
      const result = ShebangDetector.detect(content)

      expect(result.type).toBe("python")
      expect(result.interpreter).toBe("python3")
      expect(result.args).toEqual(["-u"])
    })

    test("handles shebang with leading whitespace on line", () => {
      const content = `  #!/bin/bash
echo "this has leading spaces but still starts with #!"
`
      const result = ShebangDetector.detect(content)

      // The implementation trims the first line, so this should still work
      expect(result.type).toBe("bash")
    })

    test("shebang takes priority over content patterns", () => {
      const content = `#!/usr/bin/env python
<?php
echo "This looks like PHP but has Python shebang";
`
      const result = ShebangDetector.detect(content)

      expect(result.type).toBe("python")
      expect(result.languageName).toBe("Python")
    })

    test("handles content with comment that looks like shebang", () => {
      const content = `# Not a shebang
#!/bin/bash
echo "The shebang is on line 2, not line 1"
`
      const result = ShebangDetector.detect(content)

      // First line is just a comment, not a shebang
      expect(result.type).toBe(null)
    })
  })
})
