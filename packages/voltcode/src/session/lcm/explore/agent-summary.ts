import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageV2 } from "@/session/message-v2"
import { Identifier } from "@/id/id"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import { Token } from "@/util/token"

const log = Log.create({ service: "lcm.explore.agent-summary" })

/**
 * Input for generating an agent-based summary
 */
export interface AgentSummaryInput {
  /** The file content to summarize (provided as context, agent can also use Read) */
  content: string
  /** File path for the agent to explore */
  filePath: string
  /** Detected language/type */
  language: string
  /** Pre-extracted structured metadata (from regex parsing) */
  structuredMetadata: string
  /** The provider model to use */
  model: Provider.Model
  /** Parent session ID for spawning sub-agent */
  sessionID: string
  /** Optional abort signal */
  abort?: AbortSignal
}

/**
 * Result of agent-based summary generation
 */
export interface AgentSummaryResult {
  /** The generated summary */
  summary: string
  /** Estimated token count */
  tokenCount: number
  /** The exploration session ID */
  explorationSessionID: string
}

/**
 * Language-specific exploration prompts.
 * Each prompt guides the agent to look for language-specific constructs.
 */
const LANGUAGE_PROMPTS: Record<string, string> = {
  Python: `You are a Python file exploration agent. Analyze this Python file to understand its purpose and structure.

Look for:
- Module docstring and purpose
- Classes (especially dataclasses, abstract classes, protocols)
- Functions and their purposes (async, generators, decorators)
- Type hints and typing patterns
- Imports (stdlib vs third-party vs local)
- __all__ exports and module API
- Main block and entry points
- Magic methods and protocols implemented
- Framework patterns (Flask routes, Django models, FastAPI endpoints, etc.)`,

  JavaScript: `You are a JavaScript file exploration agent. Analyze this JavaScript file to understand its purpose and structure.

Look for:
- Module format (ESM vs CommonJS)
- Exports (named, default, re-exports)
- Classes and their methods
- Functions (regular, arrow, async, generators)
- React/Vue/Svelte components if present
- Event handlers and callbacks
- API endpoints if it's a backend file
- Framework patterns (Express routes, React hooks, etc.)
- Notable patterns (factory functions, closures, prototypes)`,

  TypeScript: `You are a TypeScript file exploration agent. Analyze this TypeScript file to understand its purpose and structure.

Look for:
- Type definitions (interfaces, types, enums)
- Generics and type utilities
- Classes and their methods
- Module exports and API surface
- React components and hooks if present
- Decorators and metadata
- Framework patterns (NestJS controllers, etc.)
- Zod/io-ts schemas if present
- Notable type patterns and utilities`,

  Go: `You are a Go file exploration agent. Analyze this Go file to understand its purpose and structure.

Look for:
- Package name and purpose
- Exported vs unexported symbols (capitalization)
- Structs and their methods
- Interfaces and implementations
- Functions (including init())
- Error handling patterns
- Concurrency patterns (goroutines, channels)
- HTTP handlers if present
- Notable stdlib usage (context, sync, etc.)`,

  Rust: `You are a Rust file exploration agent. Analyze this Rust file to understand its purpose and structure.

Look for:
- Module structure (mod declarations)
- Structs and enums
- Traits and implementations
- Functions (pub, async, unsafe)
- Lifetimes and borrowing patterns
- Error handling (Result, Option, ?)
- Macros (macro_rules!, proc macros)
- Derives and attributes
- Notable crate usage`,

  Java: `You are a Java file exploration agent. Analyze this Java file to understand its purpose and structure.

Look for:
- Package and class structure
- Inheritance and interfaces
- Methods (public API vs private impl)
- Annotations (Spring, JPA, Lombok, etc.)
- Exception handling
- Generics usage
- Design patterns implemented
- Framework patterns (Spring beans, etc.)`,

  "C++": `You are a C++ file exploration agent. Analyze this C++ file to understand its purpose and structure.

Look for:
- Header vs implementation file patterns
- Classes (constructors, destructors, RAII)
- Templates and specializations
- Namespaces
- Memory management patterns
- STL usage
- Operator overloading
- Inheritance and polymorphism
- Modern C++ features (move semantics, smart pointers, etc.)`,

  C: `You are a C file exploration agent. Analyze this C file to understand its purpose and structure.

Look for:
- Header guards and includes
- Struct definitions
- Function declarations vs definitions
- Static vs extern linkage
- Preprocessor macros
- Memory management (malloc/free patterns)
- Error handling conventions
- API patterns (opaque pointers, function tables)`,

  Ruby: `You are a Ruby file exploration agent. Analyze this Ruby file to understand its purpose and structure.

Look for:
- Classes and modules
- Mixins (include, extend, prepend)
- Methods (instance vs class)
- attr_accessor patterns
- Blocks and procs
- Rails patterns (models, controllers, concerns)
- DSL patterns
- Metaprogramming usage`,

  Swift: `You are a Swift file exploration agent. Analyze this Swift file to understand its purpose and structure.

Look for:
- Classes, structs, enums
- Protocols and extensions
- Computed properties
- Closures and completion handlers
- Optionals and error handling
- Generics
- SwiftUI views if present
- UIKit patterns if present
- Async/await patterns`,

  default: `You are a file exploration agent. Analyze this file to understand its purpose and structure.

Look for:
- Main purpose of the file
- Key structures and functions
- Dependencies and imports
- Notable patterns or conventions
- API surface and entry points`,
}

/**
 * Generate a high-quality summary using an exploration agent.
 *
 * This function spawns an "explore" sub-agent that can use tools (Read, Grep)
 * to explore the file. The agent runs in a loop with tool calls until it
 * understands the file well enough to produce a quality summary.
 */
export async function generateAgentSummary(input: AgentSummaryInput): Promise<AgentSummaryResult> {
  const fileName = input.filePath.split("/").pop() ?? "unknown"

  log.info("spawning exploration agent", {
    filePath: input.filePath,
    language: input.language,
    contentLength: input.content.length,
    metadataLength: input.structuredMetadata.length,
    parentSessionID: input.sessionID,
  })

  // Create a child session for the exploration agent
  const session = await Session.create({
    parentID: input.sessionID,
    title: `Exploring ${fileName} (${input.language})`,
  })

  // Get the language-specific prompt, fallback to default
  const languagePrompt = LANGUAGE_PROMPTS[input.language] ?? LANGUAGE_PROMPTS.default

  // Build the user message with context
  const userMessage = `## Task

Explore and summarize the ${input.language} file at: ${input.filePath}

${languagePrompt}

## Pre-Extracted Structure (for reference)

The following structural metadata was extracted via static analysis:

${input.structuredMetadata}

## Instructions

1. Use the Read tool to examine the file at "${input.filePath}"
2. If needed, use Grep to search for specific patterns
3. Understand the file's purpose, structure, and how it fits into the codebase
4. Provide a concise summary (300-800 tokens) that explains:
   - What this file does and why it exists
   - Key components and their purposes
   - How it relates to other parts of the system
   - Notable patterns or important details

Write your summary in clear prose. Use actual names from the code. Don't reproduce code - describe what it does.`

  const messageID = Identifier.ascending("message")

  // Set up abort handling
  function cancel() {
    SessionPrompt.cancel(session.id)
  }
  if (input.abort) {
    input.abort.addEventListener("abort", cancel)
  }

  try {
    // Run the exploration agent
    const result = await SessionPrompt.prompt({
      messageID,
      sessionID: session.id,
      model: {
        modelID: input.model.id,
        providerID: input.model.providerID,
      },
      agent: "explore",
      parts: [{ type: "text", text: userMessage }],
    })

    // Extract the summary from the agent's response
    // The result is a MessageV2.WithParts which has parts array
    const textParts = result.parts.filter((p): p is MessageV2.TextPart => p.type === "text")
    const summary = textParts
      .map((p) => p.text)
      .join("\n")
      .trim()
    const tokenCount = Token.estimate(summary)

    log.info("exploration agent completed", {
      filePath: input.filePath,
      summaryTokenCount: tokenCount,
      explorationSessionID: session.id,
    })

    return {
      summary,
      tokenCount,
      explorationSessionID: session.id,
    }
  } finally {
    if (input.abort) {
      input.abort.removeEventListener("abort", cancel)
    }
  }
}
