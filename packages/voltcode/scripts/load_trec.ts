import { readFileSync } from "node:fs"
import { Database } from "bun:sqlite"

type Batch = { batch_index: number; items: { date: string; user: string; question: string }[] }
type Classification = { item_index: number; ok: boolean; result?: { labels?: string[] } }

function readArg(name: string): string | undefined {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function usageAndExit(): never {
  console.error(
    "Usage: bun packages/voltcode/scripts/load_trec.ts --batched <batches.jsonl> --classified <classified.jsonl> --db <labels.db>",
  )
  process.exit(1)
}

const batchedPath = readArg("batched")
const classifiedPath = readArg("classified")
const dbPath = readArg("db")

if (!batchedPath || !classifiedPath || !dbPath) {
  usageAndExit()
}

const batchedLines = readFileSync(batchedPath, "utf-8").split("\n").filter(Boolean)
const classifiedLines = readFileSync(classifiedPath, "utf-8").split("\n").filter(Boolean)

const batches: Batch[] = batchedLines.map((line) => JSON.parse(line) as Batch)
const classifications: Classification[] = classifiedLines.map((line) => JSON.parse(line) as Classification)

const db = new Database(dbPath)
db.exec("CREATE TABLE IF NOT EXISTS labels (date TEXT, user TEXT, label TEXT)")
db.exec("CREATE INDEX IF NOT EXISTS idx_label ON labels(label)")
db.exec("CREATE INDEX IF NOT EXISTS idx_user ON labels(user)")

const insert = db.prepare("INSERT INTO labels (date, user, label) VALUES (?, ?, ?)")

let inserted = 0
for (const classification of classifications) {
  const labels = classification.result?.labels
  if (!classification.ok || !labels) {
    console.error(`Missing classification for item ${classification.item_index}`)
    continue
  }

  const batch = batches[classification.item_index]
  if (!batch) {
    console.error(`Missing batch for index ${classification.item_index}`)
    continue
  }

  for (let j = 0; j < batch.items.length; j++) {
    const label = labels[j]
    if (!label) continue

    const item = batch.items[j]
    insert.run(item.date, item.user, label)
    inserted++
  }
}

console.log(`Inserted ${inserted} row(s) into ${dbPath}`)

const counts = db.query("SELECT label, COUNT(*) as count FROM labels GROUP BY label ORDER BY count DESC").all() as {
  label: string
  count: number
}[]
console.log("Label counts:")
for (const row of counts) {
  console.log(`  ${row.label}: ${row.count}`)
}

db.close()
