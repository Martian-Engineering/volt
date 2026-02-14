import z from "zod"

export const JobMessage = z
  .object({
    run_id: z.string(),
    context_length: z.number(),
    context_window_id: z.string(),
    backend: z.string(),
    seed: z.number(),
    timeout_minutes: z.number(),
    retry_count: z.number(),
    output_prefix: z.string(),
  })
  .meta({ ref: "JobMessage" })

export type JobMessage = z.infer<typeof JobMessage>

export const WorkerSecrets = z
  .object({
    OPENAI_API_KEY: z.string().optional(),
    ANTHROPIC_API_KEY: z.string().optional(),
    MOONSHOT_API_KEY: z.string().optional(),
    GLM_API_KEY: z.string().optional(),
  })
  .meta({ ref: "WorkerSecrets" })

export type WorkerSecrets = z.infer<typeof WorkerSecrets>

export function parseJobMessage(body: string): JobMessage {
  const parsed = JSON.parse(body)
  return JobMessage.parse(parsed)
}

export function getEnvForBackend(backend: string, secrets: WorkerSecrets): Record<string, string> {
  const env: Record<string, string> = {
    VOLTCODE_BACKEND: backend,
  }

  if (backend.startsWith("openai:") && secrets.OPENAI_API_KEY) {
    env.OPENAI_API_KEY = secrets.OPENAI_API_KEY
  }
  if (backend.startsWith("anthropic:") && secrets.ANTHROPIC_API_KEY) {
    env.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY
  }
  if (backend.startsWith("moonshot:") && secrets.MOONSHOT_API_KEY) {
    env.MOONSHOT_API_KEY = secrets.MOONSHOT_API_KEY
  }
  if (backend.startsWith("glm:") && secrets.GLM_API_KEY) {
    env.GLM_API_KEY = secrets.GLM_API_KEY
  }

  return env
}
