import path from "path"
import { cmd } from "../cmd"
import { tui } from "./app"
import { UI } from "@/cli/ui"
import { getTerminalColorWarning } from "@/util/terminal-color"

export const AttachCommand = cmd({
  command: "attach <url>",
  describe: "attach to a running voltcode server",
  builder: (yargs) =>
    yargs
      .positional("url", {
        type: "string",
        describe: "http://localhost:4096",
        demandOption: true,
      })
      .option("dir", {
        type: "string",
        description: "directory to run in",
      })
      .option("session", {
        alias: ["s"],
        type: "string",
        describe: "session id to continue",
      }),
  handler: async (args) => {
    // Resolve paths: absolute paths are used as-is, relative paths resolve against cwd
    const dir = args.dir ? (path.isAbsolute(args.dir) ? args.dir : path.resolve(args.dir)) : undefined
    if (dir) process.chdir(dir)

    // Check for terminal color limitations (e.g., Apple Terminal without truecolor)
    const colorWarning = getTerminalColorWarning()
    if (colorWarning) {
      UI.println(UI.Style.TEXT_WARNING_BOLD + "Terminal Color Warning" + UI.Style.TEXT_NORMAL)
      UI.println(UI.Style.TEXT_DIM + colorWarning + UI.Style.TEXT_NORMAL)
      UI.empty()
    }

    await tui({
      url: args.url,
      args: { sessionID: args.session },
      directory: dir,
    })
  },
})
