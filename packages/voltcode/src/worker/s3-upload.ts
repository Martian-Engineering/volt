import {
  S3Client,
  PutObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  type CompletedPart,
} from "@aws-sdk/client-s3"
import { Log } from "@/util/log"

const log = Log.create({ service: "s3-upload" })

const MULTIPART_THRESHOLD = 5 * 1024 * 1024 // 5MB
const PART_SIZE = 5 * 1024 * 1024 // 5MB minimum part size

const client = new S3Client({})

const ARTIFACT_FILES = ["result.json", "trace.jsonl", "stdout.log", "stderr.log", "meta.json"]

export async function uploadFile(bucket: string, key: string, filePath: string): Promise<void> {
  const file = Bun.file(filePath)
  const size = file.size

  if (size > MULTIPART_THRESHOLD) {
    await uploadMultipart(bucket, key, filePath, size)
  } else {
    const body = await file.arrayBuffer()
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: new Uint8Array(body),
    })
    await client.send(command)
    log.info("Uploaded file", { bucket, key, size })
  }
}

async function uploadMultipart(bucket: string, key: string, filePath: string, size: number): Promise<void> {
  const createCommand = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
  })
  const { UploadId } = await client.send(createCommand)

  if (!UploadId) {
    throw new Error("Failed to create multipart upload")
  }

  const completedParts: CompletedPart[] = []
  const file = Bun.file(filePath)
  const totalParts = Math.ceil(size / PART_SIZE)

  try {
    for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
      const start = (partNumber - 1) * PART_SIZE
      const end = Math.min(start + PART_SIZE, size)
      const partData = await file.slice(start, end).arrayBuffer()

      const uploadPartCommand = new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId,
        PartNumber: partNumber,
        Body: new Uint8Array(partData),
      })

      const { ETag } = await client.send(uploadPartCommand)
      completedParts.push({ ETag, PartNumber: partNumber })

      log.debug("Uploaded part", {
        bucket,
        key,
        partNumber,
        totalParts,
      })
    }

    const completeCommand = new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId,
      MultipartUpload: { Parts: completedParts },
    })
    await client.send(completeCommand)
    log.info("Completed multipart upload", { bucket, key, size, totalParts })
  } catch (error) {
    log.error("Multipart upload failed, aborting", { bucket, key, error })
    const abortCommand = new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: key,
      UploadId,
    })
    await client.send(abortCommand).catch((abortError) => {
      log.warn("Failed to abort multipart upload", { bucket, key, abortError })
    })
    throw error
  }
}

export async function uploadArtifacts(bucket: string, outputPrefix: string, outputDir: string): Promise<void> {
  for (const filename of ARTIFACT_FILES) {
    const filePath = `${outputDir}/${filename}`
    const file = Bun.file(filePath)
    const exists = await file.exists()

    if (!exists) {
      log.debug("Artifact file not found, skipping", { filePath })
      continue
    }

    const key = `${outputPrefix}/${filename}`
    await uploadFile(bucket, key, filePath)
  }

  log.info("Finished uploading artifacts", { bucket, outputPrefix, outputDir })
}
