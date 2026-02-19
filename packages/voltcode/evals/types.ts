import z from "zod"

/**
 * Common types for evaluation benchmarks
 */
export namespace EvalTypes {
  /** Result of a single evaluation task */
  export const TaskResult = z.object({
    taskId: z.string(),
    passed: z.boolean(),
    score: z.number().min(0).max(1),
    duration: z.number().describe("Duration in milliseconds"),
    error: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  })
  export type TaskResult = z.infer<typeof TaskResult>

  /** Aggregated results for a benchmark run */
  export const BenchmarkResult = z.object({
    benchmark: z.string(),
    version: z.string(),
    model: z.string(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    totalTasks: z.number(),
    passedTasks: z.number(),
    passRate: z.number().min(0).max(1),
    averageScore: z.number().min(0).max(1),
    totalDuration: z.number(),
    tasks: z.array(TaskResult),
  })
  export type BenchmarkResult = z.infer<typeof BenchmarkResult>

  /** Configuration for running a benchmark */
  export const RunConfig = z.object({
    /** Maximum number of tasks to run (for testing) */
    limit: z.number().positive().optional(),
    /** Specific task IDs to run */
    taskIds: z.array(z.string()).optional(),
    /** Maximum time per task in milliseconds */
    timeout: z.number().positive().default(7_200_000),
    /** Number of parallel tasks */
    concurrency: z.number().positive().default(1),
    /** Output directory for results */
    outputDir: z.string().optional(),
    /** Model to use */
    model: z.string().optional(),
    /** Provider to use */
    provider: z.string().optional(),
    /** Context length for benchmarks that support it (e.g., OOLONG) */
    contextLen: z.number().positive().optional(),
    /** Agent to use: "voltcode" (default) or "claude-code" */
    agent: z.enum(["voltcode", "claude-code"]).default("voltcode"),
    /** Use installed volt binary instead of dev source */
    binary: z.boolean().default(false),
    /** Unique identifier for this run */
    runId: z.string().optional(),
    /** Backend identifier (e.g., 'anthropic:claude-opus-4.5') */
    backend: z.string().optional(),
    /** Variant for model-specific options (e.g., 'xhigh' for OpenAI reasoning_effort) */
    variant: z.string().optional(),
  })
  export type RunConfig = z.infer<typeof RunConfig>

  /** Interface that all benchmark runners must implement */
  export interface BenchmarkRunner {
    name: string
    version: string
    description: string

    /** Setup the benchmark environment */
    setup(): Promise<void>

    /** List available tasks */
    listTasks(): Promise<string[]>

    /** Run a single task and return the result */
    runTask(taskId: string, config: RunConfig): Promise<TaskResult>

    /** Run all tasks and return aggregated results */
    run(config: RunConfig): Promise<BenchmarkResult>

    /** Cleanup after benchmark run */
    cleanup(): Promise<void>
  }
}
