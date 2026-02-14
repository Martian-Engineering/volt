import { EvalTypes } from "./types"
import { SWEBench } from "./swe-bench"
import { MCPAtlas } from "./mcp-atlas"
import { LoCoBenchAgent } from "./locobench-agent"
import { ContextBench } from "./context-bench"
import { TerminalBench } from "./terminal-bench"
import { AiderPolyglot } from "./aider-polyglot"
import { Oolong } from "./oolong"

/**
 * Central runner for all evaluation benchmarks
 */
export namespace EvalRunner {
  const benchmarks: Record<string, () => EvalTypes.BenchmarkRunner> = {
    "swe-bench": () => new SWEBench.Runner(),
    "mcp-atlas": () => new MCPAtlas.Runner(),
    "locobench-agent": () => new LoCoBenchAgent.Runner(),
    "context-bench": () => new ContextBench.Runner(),
    "terminal-bench": () => new TerminalBench.Runner(),
    "aider-polyglot": () => new AiderPolyglot.Runner(),
    oolong: () => new Oolong.Runner(),
  }

  export function list(): string[] {
    return Object.keys(benchmarks)
  }

  export function get(name: string): EvalTypes.BenchmarkRunner | undefined {
    const factory = benchmarks[name]
    return factory?.()
  }

  export async function run(name: string, config: EvalTypes.RunConfig): Promise<EvalTypes.BenchmarkResult> {
    const runner = get(name)
    if (!runner) {
      throw new Error(`Unknown benchmark: ${name}. Available: ${list().join(", ")}`)
    }

    await runner.setup()
    try {
      return await runner.run(config)
    } finally {
      await runner.cleanup()
    }
  }

  export async function runAll(config: EvalTypes.RunConfig): Promise<Record<string, EvalTypes.BenchmarkResult>> {
    const results: Record<string, EvalTypes.BenchmarkResult> = {}

    for (const name of list()) {
      console.log(`Running benchmark: ${name}`)
      results[name] = await run(name, config)
    }

    return results
  }
}
