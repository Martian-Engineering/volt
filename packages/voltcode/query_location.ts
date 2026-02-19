import { Database } from "bun:sqlite"

function readArg(name: string): string | undefined {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function usageAndExit(): never {
  console.error("Usage: bun packages/voltcode/query_location.ts --db <labels.db> [--table <labels>]")
  process.exit(1)
}

const dbPath = readArg("db")
const table = readArg("table") ?? "labels"

if (!dbPath) {
  usageAndExit()
}

const db = new Database(dbPath, { readonly: true })
const row = db.query(`SELECT COUNT(*) as count FROM ${table} WHERE label = 'location'`).get() as {
  count: number
}
db.close()

console.log(`location count: ${row.count}`)
