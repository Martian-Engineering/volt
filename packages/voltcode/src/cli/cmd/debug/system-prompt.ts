import { EOL } from "os"
import { Provider } from "../../../provider/provider"
import { SystemPrompt } from "../../../session/system"
import { bootstrap } from "../../bootstrap"
import { cmd } from "../cmd"

export const SystemPromptCommand = cmd({
  command: "system-prompt",
  describe: "print the full system prompt for a given model",
  builder: (yargs) =>
    yargs.option("model", {
      alias: ["m"],
      type: "string",
      describe: "model in provider/model format (e.g. b200-lora/glm-4.7-flash-oolong-top10-8k)",
      demandOption: true,
    }),
  async handler(args) {
    await bootstrap(process.cwd(), async () => {
      const parsed = Provider.parseModel(args.model)
      const model = await Provider.getModel(parsed.providerID, parsed.modelID)
      const provider = await Provider.getProvider(model.providerID)
      const apiKey = provider?.key ?? (provider?.options?.apiKey as string | undefined)
      const apiConfig = apiKey && model.api.url ? { url: model.api.url, model: model.api.id, apiKey } : undefined
      const prompt = await SystemPrompt.build(model, apiConfig)
      process.stdout.write(prompt + EOL)
    })
  },
})
