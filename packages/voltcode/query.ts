import { Database } from "bun:sqlite"

function readArg(name: string): string | undefined {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function usageAndExit(): never {
  console.error(
    "Usage: bun packages/voltcode/query.ts --db <labels.db> --label <name> [--table <labels>] [--user <id>]",
  )
  process.exit(1)
}

const dbPath = readArg("db")
const label = readArg("label")
const table = readArg("table") ?? "labels"
const userId = readArg("user")

if (!dbPath || !label) {
  usageAndExit()
}

const db = new Database(dbPath, { readonly: true })

const sql = userId
  ? `SELECT COUNT(*) as count FROM ${table} WHERE user = ? AND label = ?`
  : `SELECT COUNT(*) as count FROM ${table} WHERE label = ?`

const row = userId
  ? (db.query(sql).get(userId, label) as { count: number })
  : (db.query(sql).get(label) as { count: number })

db.close()

console.log(`count(${label}) = ${row.count}`)
