import { Database } from "bun:sqlite"

function readArg(name: string): string | undefined {
  const flag = `--${name}`
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function usageAndExit(): never {
  console.error(
    "Usage: bun packages/voltcode/query_labels.ts --db <labels.db> --lhs <label-a> --rhs <label-b> [--user <id>] [--table <labels>]",
  )
  process.exit(1)
}

const dbPath = readArg("db")
const lhs = readArg("lhs")
const rhs = readArg("rhs")
const table = readArg("table") ?? "labels"
const userId = readArg("user")

if (!dbPath || !lhs || !rhs) {
  usageAndExit()
}

const db = new Database(dbPath, { readonly: true })

const sql = userId
  ? `SELECT COUNT(*) as c FROM ${table} WHERE user = ? AND label = ?`
  : `SELECT COUNT(*) as c FROM ${table} WHERE label = ?`

const lhsRow = userId
  ? (db.query(sql).get(userId, lhs) as { c: number })
  : (db.query(sql).get(lhs) as { c: number })
const rhsRow = userId
  ? (db.query(sql).get(userId, rhs) as { c: number })
  : (db.query(sql).get(rhs) as { c: number })

db.close()

const lhsCount = lhsRow.c
const rhsCount = rhsRow.c

let relation = "same frequency as"
if (lhsCount > rhsCount) relation = "more common than"
if (lhsCount < rhsCount) relation = "less common than"

console.log(`${lhs}: ${lhsCount}`)
console.log(`${rhs}: ${rhsCount}`)
console.log(`Answer: ${lhs} is ${relation} ${rhs}`)
