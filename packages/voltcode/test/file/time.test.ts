import { describe, expect, test } from "bun:test"
import path from "path"
import * as fs from "fs/promises"
import { FileTime } from "../../src/file/time"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

describe("FileTime.assert with descendant reads", () => {
  test("allows edit when the same session read the file", async () => {
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const filepath = path.join(fixture.path, "test.txt")
        await fs.writeFile(filepath, "hello", "utf-8")

        const session = await Session.create({})
        FileTime.read(session.id, filepath)

        // Should not throw
        await FileTime.assert(session.id, filepath)

        await Session.remove(session.id)
      },
    })
  })

  test("rejects edit when no session has read the file", async () => {
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const filepath = path.join(fixture.path, "test.txt")
        await fs.writeFile(filepath, "hello", "utf-8")

        const session = await Session.create({})

        await expect(FileTime.assert(session.id, filepath)).rejects.toThrow("You must read the file")

        await Session.remove(session.id)
      },
    })
  })

  test("allows edit when a child session read the file", async () => {
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const filepath = path.join(fixture.path, "test.txt")
        await fs.writeFile(filepath, "hello", "utf-8")

        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })

        // Only the child reads the file
        FileTime.read(child.id, filepath)

        // Parent should be allowed to edit because its child read the file
        await FileTime.assert(parent.id, filepath)

        await Session.remove(child.id)
        await Session.remove(parent.id)
      },
    })
  })

  test("allows edit when a grandchild session read the file", async () => {
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const filepath = path.join(fixture.path, "test.txt")
        await fs.writeFile(filepath, "hello", "utf-8")

        const grandparent = await Session.create({})
        const parent = await Session.create({ parentID: grandparent.id })
        const child = await Session.create({ parentID: parent.id })

        // Only the grandchild reads the file
        FileTime.read(child.id, filepath)

        // Grandparent should be allowed to edit
        await FileTime.assert(grandparent.id, filepath)

        await Session.remove(child.id)
        await Session.remove(parent.id)
        await Session.remove(grandparent.id)
      },
    })
  })

  test("rejects edit when an unrelated session read the file", async () => {
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const filepath = path.join(fixture.path, "test.txt")
        await fs.writeFile(filepath, "hello", "utf-8")

        const sessionA = await Session.create({})
        const sessionB = await Session.create({})

        // Unrelated session reads the file
        FileTime.read(sessionB.id, filepath)

        // sessionA should NOT be allowed to edit
        await expect(FileTime.assert(sessionA.id, filepath)).rejects.toThrow("You must read the file")

        await Session.remove(sessionA.id)
        await Session.remove(sessionB.id)
      },
    })
  })
})
