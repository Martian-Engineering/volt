import fs from "fs/promises"
import path from "path"
import { Log } from "@/util/log"
import { LcmDb } from "./db"
import {
  LCM_RETRIEVAL_MAX_DISTANCE,
  LCM_RETRIEVAL_MIN_SCORE,
  LCM_RETRIEVAL_QMD_COLLECTION_NAME,
  LCM_RETRIEVAL_QMD_INDEX_PREFIX,
  LCM_RETRIEVAL_ROOT,
  LCM_RETRIEVAL_TOP_K,
} from "./config"

const SUMMARY_ID_RE = /sum_[a-f0-9]{16}/
const SUMMARY_ID_FROM_FILE_RE = /sum[-_]([a-f0-9]{16})/
const QMD_DOC_VERSION = 1
const MAX_RECALL_CANDIDATES = 500

export namespace LcmRetrieval {
  const log = Log.create({ service: "lcm.retrieval" })
  const MAX_CUE_LENGTH = 140

  /**
   * Query input for Dolt off-context bindle recall.
   */
  export interface QueryInput {
    conversationId: number
    query: string
    topK?: number
    minScore?: number
    maxDistance?: number
    artifactsRoot?: string
    db?: RetrievalDb
    qmdClient?: QmdClient
  }

  /**
   * Retrieval hit returned by qmd-backed bindle recall.
   */
  export interface QueryHit {
    summaryId: string
    summaryType: LcmDb.SummaryType
    cueText: string
    score: number
    distance: number
    qmdDocId: string
    pointerSummaryIds: string[]
    lineageSummaryIds: string[]
  }

  /**
   * Query result envelope for off-context bindle recall.
   */
  export interface QueryResult {
    query: string
    topK: number
    minScore: number
    maxDistance?: number
    candidatesConsidered: number
    hits: QueryHit[]
  }

  /**
   * qmd client contract. Tests can inject a fake implementation.
   */
  export interface QmdClient {
    ensureCollection(input: { indexName: string; collectionName: string; rootPath: string }): Promise<void>
    updateIndex(indexName: string): Promise<void>
    embedIndex(indexName: string): Promise<void>
    vectorSearch(input: { indexName: string; query: string; limit: number }): Promise<QmdVectorHit[]>
  }

  /**
   * DB contract used by retrieval. Tests can inject a fake implementation.
   */
  export interface RetrievalDb {
    getActiveContextSummaryIds(conversationId: number): Promise<string[]>
    getOffContextSummaries(input: {
      conversationId: number
      summaryLevel?: LcmDb.SummaryLevel
      limit?: number
    }): Promise<LcmDb.Summary[]>
    getSummaryParentIds(summaryId: string): Promise<string[]>
    getSummaryLineagePointers(summaryId: string): Promise<LcmDb.SummaryLineagePointer[]>
    getSummaryLineageIds(summaryId: string): Promise<string[]>
    setSummaryQmdDocMapping(input: {
      summaryId: string
      qmdDocId: string | null
      qmdDocVersion?: number | null
    }): Promise<void>
  }

  interface QmdVectorHit {
    docid: string
    score: number
    file: string
    title?: string
  }

  interface RecallArtifact {
    summary: LcmDb.Summary
    summaryId: string
    artifactPath: string
    pointerSummaryIds: string[]
    lineageSummaryIds: string[]
  }

  /**
   * Query off-context bindle-lane summaries via qmd vector search.
   *
   * Guarantees:
   * - Candidates are bindle-lane off-context summaries only.
   * - Active-context summaries are excluded from final results.
   * - Deterministic top-K ordering by score DESC, distance ASC, summary_id ASC.
   */
  export async function queryOffContextBindles(input: QueryInput): Promise<QueryResult> {
    const qmdClient = input.qmdClient ?? defaultQmdClient
    const db = input.db ?? LcmDb
    const query = input.query.trim()
    const topK = toPositiveInt(input.topK, LCM_RETRIEVAL_TOP_K)
    const minScore = toUnitFloat(input.minScore, LCM_RETRIEVAL_MIN_SCORE)
    const maxDistance = toOptionalNonNegativeFloat(input.maxDistance, LCM_RETRIEVAL_MAX_DISTANCE)
    const searchLimit = Math.max(topK * 4, 20)

    if (!query) {
      return {
        query,
        topK,
        minScore,
        maxDistance,
        candidatesConsidered: 0,
        hits: [],
      }
    }

    const activeSummaryIds = new Set(await db.getActiveContextSummaryIds(input.conversationId))
    const offContextBindles = await db.getOffContextSummaries({
      conversationId: input.conversationId,
      summaryLevel: "bindle",
      limit: MAX_RECALL_CANDIDATES,
    })

    const candidates = offContextBindles.filter(
      (summary) =>
        (summary.summary_type === "bindle" || summary.summary_type === "archive_stub") &&
        !activeSummaryIds.has(summary.summary_id),
    )

    if (candidates.length === 0) {
      return {
        query,
        topK,
        minScore,
        maxDistance,
        candidatesConsidered: 0,
        hits: [],
      }
    }

    const indexName = `${LCM_RETRIEVAL_QMD_INDEX_PREFIX}-${input.conversationId}`
    const artifactsRoot = input.artifactsRoot ?? path.join(LCM_RETRIEVAL_ROOT, `conversation-${input.conversationId}`)
    const artifacts = await syncRecallArtifacts({ summaries: candidates, rootPath: artifactsRoot, db })

    await qmdClient.ensureCollection({
      indexName,
      collectionName: LCM_RETRIEVAL_QMD_COLLECTION_NAME,
      rootPath: artifactsRoot,
    })
    await qmdClient.updateIndex(indexName)
    await qmdClient.embedIndex(indexName)

    const rawHits = await qmdClient.vectorSearch({
      indexName,
      query,
      limit: searchLimit,
    })

    const qmdDocToSummaryId = new Map<string, string>()
    for (const artifact of artifacts.values()) {
      if (artifact.summary.qmd_doc_id) {
        qmdDocToSummaryId.set(artifact.summary.qmd_doc_id, artifact.summaryId)
      }
    }

    const bestHitsBySummaryId = new Map<string, QueryHit>()
    for (const rawHit of rawHits) {
      const qmdDocId = normalizeDocId(rawHit.docid)
      const summaryId = extractSummaryId(rawHit) ?? qmdDocToSummaryId.get(qmdDocId)
      if (!summaryId) continue
      if (activeSummaryIds.has(summaryId)) continue

      const artifact = artifacts.get(summaryId)
      if (!artifact) continue

      const score = clampScore(rawHit.score)
      const distance = scoreToDistance(score)
      if (score < minScore) continue
      if (maxDistance != null && distance > maxDistance) continue

      const candidateHit: QueryHit = {
        summaryId: artifact.summaryId,
        summaryType: artifact.summary.summary_type,
        cueText: compactCueText(artifact.summary.content),
        score,
        distance,
        qmdDocId,
        pointerSummaryIds: artifact.pointerSummaryIds,
        lineageSummaryIds: artifact.lineageSummaryIds,
      }

      const existing = bestHitsBySummaryId.get(summaryId)
      if (!existing || isHitBetter(candidateHit, existing)) {
        bestHitsBySummaryId.set(summaryId, candidateHit)
      }
    }

    const hits = Array.from(bestHitsBySummaryId.values())
      .sort((a, b) => compareHitsDeterministically(a, b))
      .slice(0, topK)

    for (const hit of hits) {
      await db.setSummaryQmdDocMapping({
        summaryId: hit.summaryId,
        qmdDocId: hit.qmdDocId,
        qmdDocVersion: QMD_DOC_VERSION,
      })
    }

    log.info("queried off-context bindles", {
      conversationId: input.conversationId,
      query,
      candidates: candidates.length,
      returned: hits.length,
      topK,
      minScore,
      maxDistance: maxDistance ?? "none",
    })

    return {
      query,
      topK,
      minScore,
      maxDistance,
      candidatesConsidered: candidates.length,
      hits,
    }
  }

  async function syncRecallArtifacts(input: {
    summaries: LcmDb.Summary[]
    rootPath: string
    db: RetrievalDb
  }): Promise<Map<string, RecallArtifact>> {
    await fs.mkdir(input.rootPath, { recursive: true })
    const artifacts = new Map<string, RecallArtifact>()
    const keepFiles = new Set<string>()

    for (const summary of input.summaries) {
      const parentSummaryIds = await input.db.getSummaryParentIds(summary.summary_id)
      const lineagePointers = await input.db.getSummaryLineagePointers(summary.summary_id)
      const lineageSummaryIds = await input.db.getSummaryLineageIds(summary.summary_id)
      const pointerSummaryIds = sortUnique([
        ...parentSummaryIds,
        ...lineagePointers.map((pointer) => pointer.points_to_summary_id),
      ])
      const lineageIds = sortUnique(lineageSummaryIds)
      const artifactPath = path.join(input.rootPath, `${summary.summary_id}.md`)
      const artifactContent = formatRecallArtifact({
        summary,
        pointerSummaryIds,
        lineageSummaryIds: lineageIds,
      })

      await fs.writeFile(artifactPath, artifactContent, "utf8")
      keepFiles.add(path.basename(artifactPath))
      artifacts.set(summary.summary_id, {
        summary,
        summaryId: summary.summary_id,
        artifactPath,
        pointerSummaryIds,
        lineageSummaryIds: lineageIds,
      })
    }

    const existingEntries = await fs.readdir(input.rootPath).catch(() => [])
    for (const entry of existingEntries) {
      if (!entry.endsWith(".md")) continue
      if (keepFiles.has(entry)) continue
      await fs.rm(path.join(input.rootPath, entry), { force: true })
    }

    return artifacts
  }

  function formatRecallArtifact(input: {
    summary: LcmDb.Summary
    pointerSummaryIds: string[]
    lineageSummaryIds: string[]
  }): string {
    const lines: string[] = []
    lines.push("---")
    lines.push(`summary_id: ${input.summary.summary_id}`)
    lines.push(`conversation_id: ${input.summary.conversation_id}`)
    lines.push(`summary_level: ${input.summary.summary_level}`)
    lines.push(`condensation_order: ${input.summary.condensation_order}`)
    lines.push(`summary_type: ${input.summary.summary_type}`)
    lines.push(`is_off_context: ${input.summary.is_off_context}`)
    lines.push(`pointer_summary_ids: ${toYamlArray(input.pointerSummaryIds)}`)
    lines.push(`lineage_summary_ids: ${toYamlArray(input.lineageSummaryIds)}`)
    lines.push("---")
    lines.push("")
    lines.push(`[Summary ID: ${input.summary.summary_id}]`)
    lines.push(`[Summary Type: ${input.summary.summary_type}]`)
    lines.push(`[Pointer IDs: ${input.pointerSummaryIds.join(", ")}]`)
    lines.push(`[Lineage IDs: ${input.lineageSummaryIds.join(", ")}]`)
    lines.push("")
    lines.push(input.summary.content.trim())
    lines.push("")
    return lines.join("\n")
  }

  function compactCueText(content: string): string {
    const compacted = content.replace(/\s+/g, " ").trim()
    if (!compacted) return "(empty summary)"
    if (compacted.length <= MAX_CUE_LENGTH) return compacted
    return `${compacted.slice(0, MAX_CUE_LENGTH - 1)}…`
  }

  const defaultQmdClient: QmdClient = {
    async ensureCollection(input) {
      const response = await runQmd({
        args: [
          "--index",
          input.indexName,
          "collection",
          "add",
          input.rootPath,
          "--name",
          input.collectionName,
          "--mask",
          "**/*.md",
        ],
        allowFailure: true,
      })

      if (response.exitCode === 0) return
      const combined = `${response.stdout}\n${response.stderr}`
      if (combined.includes("already exists")) return

      throw new Error(`qmd collection add failed: ${combined.trim() || `exit code ${response.exitCode}`}`)
    },
    async updateIndex(indexName) {
      await runQmd({ args: ["--index", indexName, "update"] })
    },
    async embedIndex(indexName) {
      await runQmd({ args: ["--index", indexName, "embed"] })
    },
    async vectorSearch(input) {
      const response = await runQmd({
        args: ["--index", input.indexName, "vsearch", "--json", "-n", String(input.limit), input.query],
      })
      return parseVectorResults(response.stdout)
    },
  }

  async function runQmd(input: {
    args: string[]
    allowFailure?: boolean
  }): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["qmd", ...input.args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    if (!input.allowFailure && exitCode !== 0) {
      const combined = `${stdout}\n${stderr}`.trim()
      throw new Error(`qmd command failed: qmd ${input.args.join(" ")}\n${combined}`)
    }

    return {
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    }
  }

  function parseVectorResults(stdout: string): QmdVectorHit[] {
    const trimmed = stdout.trim()
    if (!trimmed || trimmed === "No results found.") {
      return []
    }

    let jsonPayload = trimmed
    if (!jsonPayload.startsWith("[")) {
      const start = jsonPayload.indexOf("[")
      const end = jsonPayload.lastIndexOf("]")
      if (start >= 0 && end > start) {
        jsonPayload = jsonPayload.slice(start, end + 1)
      }
    }

    const parsed = JSON.parse(jsonPayload)
    if (!Array.isArray(parsed)) return []

    return parsed
      .map((item): QmdVectorHit | null => {
        if (!item || typeof item !== "object") return null
        const row = item as Partial<QmdVectorHit>
        if (typeof row.docid !== "string" || typeof row.file !== "string" || typeof row.score !== "number") {
          return null
        }
        return {
          docid: row.docid,
          score: row.score,
          file: row.file,
          title: typeof row.title === "string" ? row.title : undefined,
        }
      })
      .filter((row): row is QmdVectorHit => row !== null)
  }

  function extractSummaryId(hit: QmdVectorHit): string | undefined {
    const titleMatch = hit.title?.match(SUMMARY_ID_RE)?.[0]
    if (titleMatch) return titleMatch

    const fileMatch = hit.file.match(SUMMARY_ID_RE)?.[0]
    if (fileMatch) return fileMatch

    const slugMatch = hit.file.match(SUMMARY_ID_FROM_FILE_RE)?.[1]
    if (slugMatch) return `sum_${slugMatch}`

    return undefined
  }

  function normalizeDocId(docid: string): string {
    return docid.startsWith("#") ? docid : `#${docid}`
  }

  function toYamlArray(values: string[]): string {
    if (values.length === 0) return "[]"
    return `[${values.join(", ")}]`
  }

  function sortUnique(values: string[]): string[] {
    return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b))
  }

  function scoreToDistance(score: number): number {
    if (score <= 0) return Number.POSITIVE_INFINITY
    return 1 / score - 1
  }

  function isHitBetter(candidate: QueryHit, current: QueryHit): boolean {
    if (candidate.score !== current.score) return candidate.score > current.score
    if (candidate.distance !== current.distance) return candidate.distance < current.distance
    return candidate.summaryId.localeCompare(current.summaryId) < 0
  }

  function compareHitsDeterministically(a: QueryHit, b: QueryHit): number {
    if (a.score !== b.score) return b.score - a.score
    if (a.distance !== b.distance) return a.distance - b.distance
    return a.summaryId.localeCompare(b.summaryId)
  }

  function toPositiveInt(value: number | undefined, fallback: number): number {
    if (value == null || !Number.isInteger(value) || value <= 0) return fallback
    return value
  }

  function toUnitFloat(value: number | undefined, fallback: number): number {
    if (value == null || !Number.isFinite(value) || value < 0 || value > 1) return fallback
    return value
  }

  function toOptionalNonNegativeFloat(value: number | undefined, fallback: number | undefined): number | undefined {
    const actual = value ?? fallback
    if (actual == null || !Number.isFinite(actual) || actual < 0) return undefined
    return actual
  }

  function clampScore(score: number): number {
    if (!Number.isFinite(score)) return 0
    if (score < 0) return 0
    if (score > 1) return 1
    return score
  }
}
