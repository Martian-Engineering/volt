import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager"
import { Log } from "../util/log"

export interface WorkerSecrets {
  dbUrl: string
  openaiKey: string
  anthropicKey: string
  moonshotKey: string
  glmKey: string
}

const SECRET_NAMES = {
  dbUrl: "voltcode/db-url",
  openaiKey: "voltcode/openai-key",
  anthropicKey: "voltcode/anthropic-key",
  moonshotKey: "voltcode/moonshot-key",
  glmKey: "voltcode/glm-key",
} as const

const log = Log.create({ service: "worker-secrets" })

let cachedSecrets: WorkerSecrets | undefined

/** Reset the cached secrets (for testing only) */
export function resetSecretsCache(): void {
  cachedSecrets = undefined
}

async function fetchSecret(client: SecretsManagerClient, secretName: string): Promise<string> {
  const command = new GetSecretValueCommand({ SecretId: secretName })
  const response = await client.send(command)

  if (!response.SecretString) {
    throw new Error(`Secret ${secretName} has no string value`)
  }

  return response.SecretString
}

export async function fetchSecrets(): Promise<WorkerSecrets> {
  if (cachedSecrets) {
    log.debug("returning cached secrets")
    return cachedSecrets
  }

  log.info("fetching secrets from AWS Secrets Manager")

  const client = new SecretsManagerClient({})

  const results = await Promise.allSettled([
    fetchSecret(client, SECRET_NAMES.dbUrl),
    fetchSecret(client, SECRET_NAMES.openaiKey),
    fetchSecret(client, SECRET_NAMES.anthropicKey),
    fetchSecret(client, SECRET_NAMES.moonshotKey),
    fetchSecret(client, SECRET_NAMES.glmKey),
  ])

  const errors: string[] = []
  const values: string[] = []

  const secretKeys = Object.keys(SECRET_NAMES) as (keyof typeof SECRET_NAMES)[]

  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const key = secretKeys[i]

    if (result.status === "rejected") {
      errors.push(
        `Failed to fetch ${SECRET_NAMES[key]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
      )
      values.push("")
    } else {
      values.push(result.value)
    }
  }

  if (errors.length > 0) {
    log.error("failed to fetch some secrets", { errors })
    throw new Error(`Failed to fetch secrets:\n${errors.join("\n")}`)
  }

  cachedSecrets = {
    dbUrl: values[0],
    openaiKey: values[1],
    anthropicKey: values[2],
    moonshotKey: values[3],
    glmKey: values[4],
  }

  log.info("successfully fetched all secrets")

  return cachedSecrets
}
