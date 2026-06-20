/**
 * Seed built-in frames into R2 + PostgreSQL.
 *
 * Usage:
 *   pnpm seed:frames
 *
 * Reads every built-in frame defined in config, uploads the PNG to R2, and
 * inserts/upserts a row into `app_frames`.  After seeding, the merged catalog
 * (GET /api/frames) serves built-in frames from R2 URLs instead of the local
 * filesystem — the DB version takes precedence.
 *
 * Safe to re-run: existing rows are updated (image_key / image_url stay
 * current), new ones are inserted.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { Pool } from 'pg'
import dotenv from 'dotenv'

// Load env vars — Next.js auto-loads .env.local, but tsx doesn't.
dotenv.config({ path: path.resolve(process.cwd(), '.env.local') })

/* ─── Built-in frame definitions (mirrors lib/photobooth/config.ts) ─── */

type FrameSlot = { left: number; top: number; width: number; height: number }

type FrameDef = {
  key: string
  label: string
  /** Absolute path to the PNG on disk. */
  image: string
  publicUrl: string
  width: number
  height: number
  slots: FrameSlot[]
  builtIn: boolean
}

const builtInImage = (filename: string) =>
  path.join(process.cwd(), 'public', 'frames', filename)

const BUILT_IN: FrameDef[] = [
  {
    key: 'summer-day', label: 'Summer Day',
    image: builtInImage('summer-day.png'),
    publicUrl: '/frames/summer-day.png',
    width: 1414, height: 4000, builtIn: true,
    slots: [
      { left: 76, top: 142, width: 1262, height: 720 },
      { left: 76, top: 952, width: 1262, height: 721 },
      { left: 76, top: 1762, width: 1262, height: 721 },
      { left: 76, top: 2573, width: 1262, height: 720 },
    ],
  },
  {
    key: 'memory-sender', label: 'Memory Sender',
    image: builtInImage('memory-sender.png'),
    publicUrl: '/frames/memory-sender.png',
    width: 1414, height: 4000, builtIn: true,
    slots: [
      { left: 86, top: 142, width: 1243, height: 747 },
      { left: 86, top: 937, width: 1243, height: 748 },
      { left: 86, top: 1732, width: 1243, height: 748 },
      { left: 86, top: 2528, width: 1243, height: 748 },
    ],
  },
  {
    key: 'multicolor-photography', label: 'Multicolor Photography',
    image: builtInImage('multicolor-photography.png'),
    publicUrl: '/frames/multicolor-photography.png',
    width: 1600, height: 4000, builtIn: true,
    slots: [
      { left: 159, top: 392, width: 1441, height: 716 },
      { left: 173, top: 1114, width: 1427, height: 1243 },
      { left: 188, top: 2364, width: 1412, height: 1242 },
    ],
  },
  {
    key: 'retro-portraits', label: 'Retro Portraits',
    image: builtInImage('retro-portraits.png'),
    publicUrl: '/frames/retro-portraits.png',
    width: 1200, height: 3600, builtIn: true,
    slots: [
      { left: 359, top: 126, width: 715, height: 1077 },
      { left: 359, top: 1260, width: 715, height: 1077 },
      { left: 359, top: 2397, width: 715, height: 1077 },
    ],
  },
  {
    key: 'family-polaroid', label: 'Family Polaroid',
    image: builtInImage('family-polaroid.png'),
    publicUrl: '/frames/family-polaroid.png',
    width: 1200, height: 3600, builtIn: true,
    slots: [
      { left: 202, top: 206, width: 776, height: 718 },
      { left: 210, top: 942, width: 786, height: 769 },
      { left: 240, top: 1824, width: 707, height: 706 },
      { left: 199, top: 2615, width: 776, height: 760 },
    ],
  },
  {
    key: 'red-friendship', label: 'Red Friendship',
    image: builtInImage('red-friendship.png'),
    publicUrl: '/frames/red-friendship.png',
    width: 1200, height: 3600, builtIn: true,
    slots: [
      { left: 126, top: 102, width: 948, height: 803 },
      { left: 127, top: 1008, width: 946, height: 703 },
      { left: 143, top: 1826, width: 914, height: 906 },
    ],
  },
  {
    key: 'red-white-friends', label: 'Red & White Friends',
    image: builtInImage('red-white-friends.png'),
    publicUrl: '/frames/red-white-friends.png',
    width: 1200, height: 3600, builtIn: true,
    slots: [
      { left: 125, top: 436, width: 948, height: 948 },
      { left: 125, top: 1663, width: 948, height: 948 },
    ],
  },
  {
    key: 'white-pink', label: 'White & Pink',
    image: builtInImage('white-pink.png'),
    publicUrl: '/frames/white-pink.png',
    width: 1181, height: 3543, builtIn: true,
    slots: [
      { left: 177, top: 192, width: 827, height: 755 },
      { left: 177, top: 1317, width: 827, height: 754 },
      { left: 177, top: 2442, width: 827, height: 754 },
    ],
  },
]

/* ─── R2 client ─── */

const R2_ENDPOINT = process.env.R2_ENDPOINT
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? 'photobooth-frames'

function getR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: R2_ENDPOINT,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: R2_SECRET_ACCESS_KEY ?? '',
    },
  })
}

async function uploadToR2(key: string, body: Buffer, contentType: string): Promise<string> {
  const client = getR2Client()
  await client.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: body,
    ContentType: contentType,
  }))
  const publicUrl = R2_PUBLIC_URL
    ? `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
    : `${R2_ENDPOINT}/${R2_BUCKET_NAME}/${key}`
  return publicUrl
}

/* ─── DB client ─── */

const db = new Pool({
  connectionString: process.env.POSTGRES_URL,
})

async function ensureSchema(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_frames (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      image_key TEXT NOT NULL,
      image_url TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      slots JSONB NOT NULL,
      created_by UUID REFERENCES app_users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

/* ─── Seeder ─── */

async function seed() {
  console.log('')
  console.log('  ── Seeding built-in frames into R2 + DB ──')
  console.log('')

  // 1. Ensure the DB table exists
  await ensureSchema()
  console.log('  ✓ Schema ready\n')

  let uploaded = 0
  let skipped = 0
  let failed = 0

  for (const frame of BUILT_IN) {
    const imageKey = `frames/built-in/${frame.key}.png`

    process.stdout.write(`  ${frame.key}  `)

    try {
      // 2. Read PNG from disk
      const buffer = await readFile(frame.image)

      // 3. Upload to R2
      const publicUrl = await uploadToR2(imageKey, buffer, 'image/png')

      // 4. Upsert into app_frames
      await db.query(
        `INSERT INTO app_frames (key, label, image_key, image_url, width, height, slots, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NULL)
         ON CONFLICT (key) DO UPDATE SET
           label      = EXCLUDED.label,
           image_key  = EXCLUDED.image_key,
           image_url  = EXCLUDED.image_url,
           width      = EXCLUDED.width,
           height     = EXCLUDED.height,
           slots      = EXCLUDED.slots`,
        [
          frame.key,
          frame.label,
          imageKey,
          publicUrl,
          frame.width,
          frame.height,
          JSON.stringify(frame.slots),
        ],
      )

      console.log('✔  →', publicUrl)
      uploaded++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log('✘  ', msg)
      failed++
    }
  }

  // 5. Summary
  console.log('')
  console.log(`  ── Done: ${uploaded} uploaded, ${skipped} skipped, ${failed} failed ──`)
  console.log('')

  if (failed > 0) process.exit(1)
}

seed().catch((err) => {
  console.error('\n  Fatal:', err)
  process.exit(1)
})
