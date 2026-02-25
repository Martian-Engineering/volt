# Volt 

**A terminal-based AI coding agent with Lossless Context Management.** 

This is a research preview from Voltropy. For full details, read the [LCM technical paper](https://papers.voltropy.com/LCM).

---
## What is Volt?

Volt is an open-source AI coding agent that introduces **Lossless Context Management (LCM)**, a deterministic architecture for LLM memory that outperforms frontier coding agents on long-context tasks. In practice, this means:

- **No compaction delays** — context compression happens asynchronously between turns, so you never wait for it
- **No forgetting** — every message is saved in an immutable store and can be retrieved losslessly, no matter how long the session runs
- **Infinite sessions** — keep any session going indefinitely; there is no point at which the system forces you to start over
- **Purpose-built data tools** — process large volumes of information (classification, extraction, analysis) via parallel operators that never load the full dataset into context

The effective context window of Large Language Models remains the primary bottleneck for complex, long-horizon agentic tasks. Even models with 1M+ token windows are insufficient for multi-day agentic sessions, where the volume of tool calls, file contents, and intermediate reasoning can exceed the context limit of any production LLM. This problem is compounded by "context rot," in which model performance degrades well before the nominal limit is reached.

LCM addresses this by shifting the burden of memory architecture from the model back to the engine. Rather than asking the model to invent a memory strategy, LCM provides a deterministic, database-backed infrastructure. It maintains a high-fanout DAG of summaries in a persistent, transactional store, allowing the system to compress context aggressively while retaining "lossless" pointers to the original data. This ensures that any message from earlier in a session can always be retrieved, regardless of how many rounds of compaction have occurred.

### How LCM Works

LCM achieves lossless retrievability via a dual-state memory architecture:

- **Immutable Store** — The source of truth. Every user message, assistant response, and tool result produced during a session is persisted verbatim and never modified.
- **Active Context** — The window actually sent to the LLM on each turn. It is assembled from a mix of recent raw messages and precomputed *summary nodes* — compressed representations derived from older messages via LLM summarization. Summary nodes function as materialized views over the immutable history: they are a cache, not a source of truth.

The core data structure is a Directed Acyclic Graph (DAG) maintained in a persistent store that supports transactional writes, foreign-key integrity, and indexed search. As the active context window fills, older messages are not discarded. Instead, they are compacted into **Summary Nodes** and the originals are saved.

To ensure reliability, LCM does not rely on the model to decide when to summarize. Instead, it employs a deterministic control loop driven by soft and hard token thresholds. Below the soft threshold, no summarization occurs and the user experiences the raw latency of the base model. When the soft threshold is exceeded, LCM performs compaction asynchronously and atomically swaps the resulting summary into the context between LLM turns. If a summarization level fails to reduce token count, the system automatically escalates to a more aggressive strategy via a **Three-Level Escalation** protocol, culminating in a deterministic fallback that requires no LLM inference. This guarantees convergence.

### Operator-Level Recursion

As an alternative to model-generated loops, LCM introduces **Operator-Level Recursion** via tools like `LLM-Map` and `Agentic-Map`. Instead of the model writing a loop, it invokes a single tool call. The engine — not the probabilistic model — handles the iteration, concurrency, and retries. This moves the "control flow" logic from the stochastic layer to the deterministic layer, allowing a single tool call to process an unbounded number of inputs without the model ever needing to manage a loop or context window.

- **LLM-Map** processes each item in a JSONL input file by dispatching it as an independent LLM API call. The engine manages a worker pool (default concurrency 16), validates each response against a caller-supplied JSON Schema, and retries failed items with feedback from the validation error. Each per-item call is a pure function from input to structured output — no tools or side effects are available. Results are written to a JSONL output file and registered in the immutable store. This is appropriate for high-throughput, side-effect-free tasks such as classification, entity extraction, or scoring.

- **Agentic-Map** is similar, but spawns a full sub-agent session for each item rather than a single LLM call. Each sub-agent has access to tools — file reads, web fetches, code execution — and can perform multi-step reasoning. A `read_only` flag controls whether sub-agents may modify the filesystem. This is appropriate when per-item processing requires tool use or multi-turn reasoning that cannot be captured in a single prompt.

### Large File Handling

In agentic coding sessions, tool results frequently include file contents that individually approach or exceed the context limit. LCM addresses this by imposing a token threshold below which files are included in context normally, and above which files are never loaded into the active context. Instead, the engine stores the file externally and inserts a compact reference: a stable content-addressed ID, the file path, and a precomputed **Exploration Summary** generated by a type-aware dispatcher that selects an analysis strategy based on file type.

### Results

Volt with LCM achieves higher scores than Claude Code on the OOLONG long-context benchmark, including at every context length between 32K and 1M tokens, using Opus 4.6. The architecture-centric approach yields reliability and cost advantages for production aggregation workloads while adding zero overhead for short tasks.

For the full technical details, see the [LCM paper](https://papers.voltropy.com/LCM).

---

## About This Project

Volt is forked from [OpenCode](https://github.com/anomalyco/opencode) by [Anomaly](https://opencode.ai), an open-source, permissively licensed, provider-agnostic coding agent built on a TypeScript client/server architecture with a terminal UI. OpenCode was chosen as the basis for Volt because it is fully featured and supports multiple LLM providers. In Volt, the LCM engine handles user sessions, replacing OpenCode's default session management. Volt is released as an open-source research preview to enable reproducibility and to support further research on deterministic context management architectures.

---

### Installation

```bash
curl -fsSL https://www.voltropy.com/install | sh
```

#### Installation Directory

The install script respects the following priority order for the installation path:

1. `$VOLTCODE_INSTALL_DIR` - Custom installation directory
2. `$XDG_BIN_DIR` - XDG Base Directory Specification compliant path
3. `$HOME/bin` - Standard user binary directory (if exists or can be created)
4. `$HOME/.voltcode/bin` - Default fallback

```bash
# Examples
VOLTCODE_INSTALL_DIR=/usr/local/bin curl -fsSL https://www.voltropy.com/install | sh
XDG_BIN_DIR=$HOME/.local/bin curl -fsSL https://www.voltropy.com/install | sh
```

### Building from Source

Requires [Bun](https://bun.sh) 1.3+.

```bash
# Clone the repo
git clone https://github.com/voltropy/voltcode.git
cd voltcode

# Install dependencies
bun install

# Run in development mode
bun dev

# Build a standalone executable (current platform only)
./packages/voltcode/script/build.ts --single

# Install it
cp dist/voltcode-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/aarch64/arm64/')/bin/volt ~/.voltcode/bin/volt
```

### Modes

Volt includes two built-in modes you can switch between with the `Tab` key.

- **build** — Default mode with full access for development work
- **plan** — Read-only mode for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Volt also spawns **sub-agents** automatically when needed — for example, the **general** sub-agent handles complex searches and multistep tasks. You can invoke it explicitly with `@general` in messages.

### Task Tree

When Volt spawns sub-agents or parallel operators, the TUI displays a live **task tree** showing the hierarchy of active and completed work. This gives you visibility into what the agent is doing at each level of delegation — which sub-agents are running, what they've been asked to do, and whether they've finished.

![Task Tree Viewer](packages/web/src/assets/lander/task-tree-viewer-example.png)

### Documentation

> **Note:** The links below point to OpenCode's documentation. Volt is a fork of OpenCode and we have tried to maintain compatibility, but we make no guarantees of full compatibility. Some features or configuration options may differ.

- [Full documentation](https://opencode.ai/docs) (OpenCode)
