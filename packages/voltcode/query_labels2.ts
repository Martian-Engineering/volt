import { Database } from "bun:sqlite"

function readArg(name: string): string | undefined {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function usageAndExit(): never {
  console.error("Usage: bun packages/voltcode/query_labels2.ts --db <labels.db> [--table <labels>] [--show-null]")
  process.exit(1)
}

const dbPath = readArg("db")
const table = readArg("table") ?? "labels"
const showNull = hasFlag("show-null")

if (!dbPath) {
  usageAndExit()
}

const db = new Database(dbPath, { readonly: true })

if (showNull) {
  const nullRowCount = db.query(`SELECT COUNT(*) as c FROM ${table} WHERE label IS NULL`).get() as { c: number }
  console.log(`NULL label rows: ${nullRowCount.c}`)
}

const result = db
  .query(
    `
SELECT label, COUNT(*) as count
FROM ${table}
WHERE label IS NOT NULL
GROUP BY label
ORDER BY count ASC
`,
  )
  .all() as { label: string; count: number }[]

db.close()

if (result.length === 0) {
  console.log("No labels found")
  process.exit(0)
}

console.log("Label counts (ascending):")
for (const row of result) {
  console.log(`${row.label}: ${row.count}`)
}

console.log(`Least common label: ${result[0].label}`)
