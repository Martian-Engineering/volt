#!/usr/bin/env bun
/**
 * VoltCode Evaluation Suite
 *
 * This module provides runners for various AI coding benchmarks.
 * It is NOT included in the main executable build - only used for internal evaluation.
 *
 * Supported benchmarks:
 * - SWE-bench Verified: Real GitHub issue resolution
 * - MCP Atlas: Multi-tool MCP server tasks
 * - LoCoBench-Agent: Long-context software engineering
 * - Context-Bench: Context engineering proficiency
 * - Terminal-Bench 2.0: Terminal/CLI task completion
 * - Aider Polyglot: Multi-language coding problems
 */

export * from "./types"
export * from "./util"
export * from "./swe-bench"
export * from "./mcp-atlas"
export * from "./locobench-agent"
export * from "./context-bench"
export * from "./terminal-bench"
export * from "./aider-polyglot"
export * from "./runner"
