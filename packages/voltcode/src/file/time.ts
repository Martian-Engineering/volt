import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import { Filesystem } from "../util/filesystem"
import { Database, eq } from "../storage/db"
import { SessionTable } from "../session/session.sql"

export namespace FileTime {
  const log = Log.create({ service: "file.time" })
  // Per-session read times plus per-file write locks.
  // All tools that overwrite existing files should run their
  // assert/read/write/update sequence inside withLock(filepath, ...)
  // so concurrent writes to the same file are serialized.
  export const state = Instance.state(() => {
    const read: {
      [sessionID: string]: {
        [path: string]: Date | undefined
      }
    } = {}
    const locks = new Map<string, Promise<void>>()
    return {
      read,
      locks,
    }
  })

  export function read(sessionID: string, file: string) {
    log.info("read", { sessionID, file })
    const { read } = state()
    read[sessionID] = read[sessionID] || {}
    read[sessionID][file] = new Date()
  }

  export function get(sessionID: string, file: string) {
    return state().read[sessionID]?.[file]
  }

  async function getTreeReadTime(sessionID: string, file: string): Promise<Date | undefined> {
    const reads = state().read
    let latest = reads[sessionID]?.[file]

    const rows = Database.use((db) => db.select().from(SessionTable).all())
    const childrenByParent = new Map<string, string[]>()
    for (const row of rows) {
      if (!row.parent_id) continue
      const list = childrenByParent.get(row.parent_id)
      if (list) list.push(row.id)
      else childrenByParent.set(row.parent_id, [row.id])
    }

    const queue: string[] = [sessionID]
    const seen = new Set<string>(queue)
    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue
      const children = childrenByParent.get(current) ?? []
      for (const childID of children) {
        if (seen.has(childID)) continue
        seen.add(childID)
        queue.push(childID)
        const readTime = reads[childID]?.[file]
        if (!readTime) continue
        if (!latest || readTime.getTime() > latest.getTime()) {
          latest = readTime
        }
      }
    }

    return latest
  }

  export async function withLock<T>(filepath: string, fn: () => Promise<T>): Promise<T> {
    const current = state()
    const currentLock = current.locks.get(filepath) ?? Promise.resolve()
    let release: () => void = () => {}
    const nextLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const chained = currentLock.then(() => nextLock)
    current.locks.set(filepath, chained)
    await currentLock
    try {
      return await fn()
    } finally {
      release()
      if (current.locks.get(filepath) === chained) {
        current.locks.delete(filepath)
      }
    }
  }

  export async function assert(sessionID: string, filepath: string) {
    if (Flag.VOLTCODE_DISABLE_FILETIME_CHECK === true) {
      return
    }

    const time = await getTreeReadTime(sessionID, filepath)
    if (!time) throw new Error(`You must read the file ${filepath} before overwriting it. Use the Read tool first`)
    const mtime = Filesystem.stat(filepath)?.mtime
    // Allow a 50ms tolerance for Windows NTFS timestamp fuzziness / async flushing
    if (mtime && mtime.getTime() > time.getTime() + 50) {
      throw new Error(
        `File ${filepath} has been modified since it was last read.\nLast modification: ${mtime.toISOString()}\nLast read: ${time.toISOString()}\n\nPlease read the file again before modifying it.`,
      )
    }
  }
}
