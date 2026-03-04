import { cmd } from "@/cli/cmd/cmd"
import { tui } from "./app"
import { Rpc } from "@/util/rpc"
import { type rpc } from "./worker"
import path from "path"
import { UI } from "@/cli/ui"
import { iife } from "@/util/iife"
import { Log } from "@/util/log"
import { withNetworkOptions, resolveNetworkOptions } from "@/cli/network"
import type { Event } from "@opencode-ai/sdk/v2"
import type { EventSource } from "./context/sdk"
import { needsPostgresDownload, downloadPostgresWithProgress } from "@/session/lcm/embedded-postgres"
import * as prompts from "@clack/prompts"
import { getTerminalColorWarning } from "@/util/terminal-color"
import { Instance } from "@/project/instance"
import { TuiConfig } from "@/config/tui"

declare global {
  const VOLTCODE_WORKER_PATH: string
}

type RpcClient = ReturnType<typeof Rpc.client<typeof rpc>>

function createWorkerFetch(client: RpcClient): typeof fetch {
  const fn = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const body = request.body ? await request.text() : undefined
    const result = await client.call("fetch", {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
    })
    return new Response(result.body, {
      status: result.status,
      headers: result.headers,
    })
  }
  return fn as typeof fetch
}

function createEventSource(client: RpcClient): EventSource {
  return {
    on: (handler) => client.on<Event>("event", handler),
  }
}

export const TuiThreadCommand = cmd({
  command: "$0 [project]",
  describe: "start volt tui",
  builder: (yargs) =>
    withNetworkOptions(yargs)
      .positional("project", {
        type: "string",
        describe: "path to start volt in",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      })
      .option("prompt", {
        type: "string",
        describe: "prompt to use",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("context-threshold", {
        type: "number",
        describe: "context token threshold above which LCM compaction triggers",
      })
      .option("deepseek", {
        type: "boolean",
        describe: "use DeepSeek V3.2 reasoner instead of default model (requires DEEPSEEK_API_KEY)",
      })
      .option("cerebras", {
        type: "boolean",
        describe: "use Cerebras-hosted GLM-4.7 instead of default model (requires CEREBRAS_API_KEY)",
      })
      .option("kimi", {
        type: "boolean",
        describe: "use Kimi K2.5 from Moonshot AI instead of default model (requires MOONSHOT_API_KEY)",
      })
      .option("dev", {
        type: "boolean",
        describe: "enable developer mode (show context usage tokens/percentage and LCM logs)",
      }),
  handler: async (args) => {
    if (args["context-threshold"]) {
      process.env.VOLTCODE_LCM_CONTEXT_THRESHOLD = String(args["context-threshold"])
    }

    // Override model to DeepSeek V3.2 reasoner if --deepseek flag is set
    if (args.deepseek) {
      if (!process.env.DEEPSEEK_API_KEY) {
        const { UI } = await import("@/cli/ui")
        UI.error("DEEPSEEK_API_KEY environment variable is not set")
        process.exit(1)
      }
      args.model = "deepseek/deepseek-reasoner"
    }

    // Override model to Cerebras-hosted GLM-4.7 if --cerebras flag is set
    if (args.cerebras) {
      if (!process.env.CEREBRAS_API_KEY) {
        const { UI } = await import("@/cli/ui")
        UI.error("CEREBRAS_API_KEY environment variable is not set")
        process.exit(1)
      }
      args.model = "cerebras/zai-glm-4.7"
    }

    // Override model to Kimi K2.5 if --kimi flag is set
    if (args.kimi) {
      if (!process.env.MOONSHOT_API_KEY) {
        const { UI } = await import("@/cli/ui")
        UI.error("MOONSHOT_API_KEY environment variable is not set")
        process.exit(1)
      }
      args.model = "moonshotai/kimi-k2.5"
    }

    // Resolve paths: absolute paths are used as-is, relative paths resolve against PWD
    const cwd = args.project
      ? path.isAbsolute(args.project)
        ? args.project
        : path.resolve(process.env.PWD ?? process.cwd(), args.project)
      : process.cwd()
    const localWorker = new URL("./worker.ts", import.meta.url)
    const distWorker = new URL("./cli/cmd/tui/worker.js", import.meta.url)
    const workerPath = await iife(async () => {
      if (typeof VOLTCODE_WORKER_PATH !== "undefined") return VOLTCODE_WORKER_PATH
      if (await Bun.file(distWorker).exists()) return distWorker
      return localWorker
    })
    try {
      process.chdir(cwd)
    } catch (e) {
      UI.error("Failed to change directory to " + cwd)
      return
    }

    // Download postgres if needed (first-time install) with progress bar
    if (await needsPostgresDownload()) {
      const spinner = prompts.spinner()
      spinner.start("Downloading VoltCode...")
      await downloadPostgresWithProgress((percent) => {
        spinner.message(`Downloading VoltCode... ${percent}%`)
      })
      spinner.stop("Download complete")
    }

    // Check for terminal color limitations (e.g., Apple Terminal without truecolor)
    const colorWarning = getTerminalColorWarning()
    if (colorWarning) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "Terminal Color Warning" + UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_DIM + colorWarning + UI.Style.TEXT_NORMAL)
      UI.empty()
    }

    const worker = new Worker(workerPath, {
      env: Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    })
    worker.onerror = (e) => {
      Log.Default.error(e)
    }
    const client = Rpc.client<typeof rpc>(worker)
    process.on("uncaughtException", (e) => {
      Log.Default.error(e)
    })
    process.on("unhandledRejection", (e) => {
      Log.Default.error(e)
    })
    process.on("SIGUSR2", async () => {
      await client.call("reload", undefined)
    })

    const prompt = await iife(async () => {
      const piped = !process.stdin.isTTY ? await Bun.stdin.text() : undefined
      if (!args.prompt) return piped
      return piped ? piped + "\n" + args.prompt : args.prompt
    })

    // Check if server should be started (port or hostname explicitly set in CLI or config)
    const networkOpts = await resolveNetworkOptions(args)
    const shouldStartServer =
      process.argv.includes("--port") ||
      process.argv.includes("--hostname") ||
      process.argv.includes("--mdns") ||
      networkOpts.mdns ||
      networkOpts.port !== 0 ||
      networkOpts.hostname !== "127.0.0.1"

    let url: string
    let customFetch: typeof fetch | undefined
    let events: EventSource | undefined

    if (shouldStartServer) {
      // Start HTTP server for external access
      const server = await client.call("server", networkOpts)
      url = server.url
    } else {
      // Use direct RPC communication (no HTTP)
      url = "http://opencode.internal"
      customFetch = createWorkerFetch(client)
      events = createEventSource(client)
    }

    const tuiPromise = tui({
      url,
      fetch: customFetch,
      events,
      config: await Instance.provide({
        directory: cwd,
        fn: () => TuiConfig.get(),
      }),
      args: {
        continue: args.continue,
        sessionID: args.session,
        agent: args.agent,
        model: args.model,
        prompt,
        dev: args.dev,
      },
      onExit: async () => {
        await client.call("shutdown", undefined)
      },
    })

    setTimeout(() => {
      client.call("checkUpgrade", { directory: cwd }).catch(() => {})
    }, 1000)

    await tuiPromise
  },
})
