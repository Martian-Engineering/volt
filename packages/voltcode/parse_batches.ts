import { readFileSync, writeFileSync } from "node:fs"

type ParsedItem = {
  date: string
  user: string
  question: string
}

function readArg(name: string): string | undefined {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function toPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function usageAndExit(): never {
  console.error(
    "Usage: bun packages/voltcode/parse_batches.ts --input <context.txt> --output <batches.jsonl> [--batch-size <n>]",
  )
  process.exit(1)
}

const inputFile = readArg("input")
const outputFile = readArg("output")
const batchSize = toPositiveInt(readArg("batch-size"), 10)

if (!inputFile || !outputFile) {
  usageAndExit()
}

const content = readFileSync(inputFile, "utf-8")
const lines = content.split("\n")
const items: ParsedItem[] = []

for (const line of lines) {
  if (!line.startsWith("Date:")) continue

  const match = line.match(/Date: (.+?) \|\| User: (.+?) \|\| Instance: (.+)/)
  if (!match) continue

  items.push({
    date: match[1].trim(),
    user: match[2].trim(),
    question: match[3].trim(),
  })
}

const batches: { batch_index: number; items: ParsedItem[] }[] = []
for (let i = 0; i < items.length; i += batchSize) {
  batches.push({
    batch_index: batches.length,
    items: items.slice(i, i + batchSize),
  })
}

const output = batches.map((batch) => JSON.stringify(batch)).join("\n") + "\n"
writeFileSync(outputFile, output)

console.log(`Parsed ${items.length} items from ${inputFile}`)
console.log(`Created ${batches.length} batch(es) of size ${batchSize}`)
console.log(`Wrote ${outputFile}`)
