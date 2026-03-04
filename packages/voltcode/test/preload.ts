// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll, mock } from "bun:test"

// --- Mock AWS SDK BEFORE any imports that depend on it ---
// This prevents module caching issues across test files

// Shared mock state for AWS SDK operations (tests can access via globalThis)
;(globalThis as any).__awsMockState = {
  sqsMessages: new Map<string, { body: string; receiptHandle: string }>(),
  s3Objects: new Map<string, Uint8Array>(),
  secretsCache: new Map<string, string>([
    ["voltcode/db-url", "postgres://localhost:5432/test"],
    ["voltcode/openai-key", "sk-test-openai-key"],
    ["voltcode/anthropic-key", "sk-test-anthropic-key"],
    ["voltcode/moonshot-key", "sk-test-moonshot-key"],
    ["voltcode/glm-key", "sk-test-glm-key"],
  ]),
  deletedMessages: [] as string[],
  visibilityExtensions: [] as Array<{ receiptHandle: string; timeout: number }>,
  dlqMessages: [] as Array<{ body: string; timestamp: string }>,
}

// Mock @aws-sdk/client-sqs
mock.module("@aws-sdk/client-sqs", () => ({
  SQSClient: class MockSQSClient {
    async send(command: { input: Record<string, unknown>; constructor?: { name?: string } }) {
      const mockState = (globalThis as any).__awsMockState
      const commandName = command.constructor?.name ?? ""

      if (commandName.includes("ReceiveMessage") || command.input.MaxNumberOfMessages !== undefined) {
        const messages: Array<{ Body: string; ReceiptHandle: string }> = []
        for (const [_id, msg] of mockState.sqsMessages) {
          messages.push({ Body: msg.body, ReceiptHandle: msg.receiptHandle })
          break
        }
        return { Messages: messages, $metadata: {} }
      }

      if (commandName.includes("SendMessage") || command.input.MessageBody !== undefined) {
        const queueUrl = command.input.QueueUrl as string
        const messageBody = command.input.MessageBody as string
        if (queueUrl?.endsWith("-dlq")) {
          mockState.dlqMessages.push({ body: messageBody, timestamp: new Date().toISOString() })
        } else {
          const parsed = JSON.parse(messageBody)
          const id = parsed.run_id ?? parsed.id ?? `msg-${Date.now()}`
          mockState.sqsMessages.set(id, {
            body: messageBody,
            receiptHandle: `receipt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          })
        }
        return { MessageId: `msg-${Date.now()}`, $metadata: {} }
      }

      if (
        commandName.includes("DeleteMessage") ||
        (command.input.ReceiptHandle !== undefined && command.input.VisibilityTimeout === undefined)
      ) {
        const receiptHandle = command.input.ReceiptHandle as string
        mockState.deletedMessages.push(receiptHandle)
        for (const [id, msg] of mockState.sqsMessages) {
          if (msg.receiptHandle === receiptHandle) {
            mockState.sqsMessages.delete(id)
            break
          }
        }
        return { $metadata: {} }
      }

      if (commandName.includes("ChangeMessageVisibility") || command.input.VisibilityTimeout !== undefined) {
        mockState.visibilityExtensions.push({
          receiptHandle: (command.input.ReceiptHandle ?? "") as string,
          timeout: (command.input.VisibilityTimeout ?? 0) as number,
        })
        return { $metadata: {} }
      }

      return { $metadata: {} }
    }
  },
  ReceiveMessageCommand: class MockReceiveMessageCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  SendMessageCommand: class MockSendMessageCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  DeleteMessageCommand: class MockDeleteMessageCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  ChangeMessageVisibilityCommand: class MockChangeMessageVisibilityCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
}))

// Mock @aws-sdk/client-s3
mock.module("@aws-sdk/client-s3", () => ({
  S3Client: class MockS3Client {
    async send(command: { input: Record<string, unknown>; constructor?: { name?: string } }) {
      const mockState = (globalThis as any).__awsMockState
      const commandName = command.constructor?.name ?? ""

      if (commandName.includes("PutObject") || (command.input.Bucket && command.input.Key && command.input.Body)) {
        const bucket = command.input.Bucket as string
        const key = command.input.Key as string
        const body = command.input.Body as Uint8Array
        mockState.s3Objects.set(`${bucket}/${key}`, body)
        return { $metadata: {} }
      }

      if (commandName.includes("CreateMultipartUpload")) {
        return { UploadId: `upload-${Date.now()}`, $metadata: {} }
      }

      if (commandName.includes("UploadPart")) {
        return { ETag: `"etag-${Date.now()}"`, $metadata: {} }
      }

      if (commandName.includes("CompleteMultipartUpload") || commandName.includes("AbortMultipartUpload")) {
        return { $metadata: {} }
      }

      return { $metadata: {} }
    }
  },
  PutObjectCommand: class MockPutObjectCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  CreateMultipartUploadCommand: class MockCreateMultipartUploadCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  UploadPartCommand: class MockUploadPartCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  CompleteMultipartUploadCommand: class MockCompleteMultipartUploadCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
  AbortMultipartUploadCommand: class MockAbortMultipartUploadCommand {
    input: Record<string, unknown>
    constructor(input: Record<string, unknown>) {
      this.input = input
    }
  },
}))

// Mock @aws-sdk/client-secrets-manager
mock.module("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class MockSecretsManagerClient {
    async send(command: { input: { SecretId?: string } }) {
      const mockState = (globalThis as any).__awsMockState
      const secretId = command.input.SecretId
      if (!secretId) throw new Error("SecretId is required")
      const value = mockState.secretsCache.get(secretId)
      if (!value) throw new Error(`Secret not found: ${secretId}`)
      return { SecretString: value, $metadata: {} }
    }
  },
  GetSecretValueCommand: class MockGetSecretValueCommand {
    input: { SecretId?: string }
    constructor(input: { SecretId?: string }) {
      this.input = input
    }
  },
}))

const dir = path.join(os.tmpdir(), "voltcode-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})
// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["VOLTCODE_TEST_HOME"] = testHome

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")

// Pre-fetch models.json so tests don't need the macro fallback
// Also write the cache version file to prevent global/index.ts from clearing the cache
const cacheDir = path.join(dir, "cache", "voltcode")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "14")
const response = await fetch("https://models.dev/api.json")
if (response.ok) {
  await fs.writeFile(path.join(cacheDir, "models.json"), await response.text())
}
// Disable models.dev refresh to avoid race conditions during tests
process.env["VOLTCODE_DISABLE_MODELS_FETCH"] = "true"

// Clear local config overrides from repo .env so tests stay fixture-driven.
delete process.env["VOLTCODE_CONFIG"]
delete process.env["VOLTCODE_CONFIG_DIR"]
delete process.env["VOLTCODE_CONFIG_CONTENT"]
delete process.env["VOLTCODE_PERMISSION"]

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["OPENAI_API_KEY"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})
