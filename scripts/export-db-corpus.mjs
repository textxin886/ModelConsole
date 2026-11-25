import { createHash, randomBytes, createHmac } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(projectRoot, 'datasets')
const outputFile = path.join(outputDir, 'wanxing_chat_windows_100.json')
const windowSize = 12
const targetCount = 100

const requiredEnv = ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME']
for (const name of requiredEnv) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`)
}

const connection = await mysql.createConnection({
  host: process.env.DATABASE_HOST,
  port: Number(process.env.DATABASE_PORT),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  charset: 'utf8mb4',
  connectTimeout: 10000,
})

let rows
try {
  await connection.query('SET SESSION TRANSACTION READ ONLY')
  await connection.query('START TRANSACTION READ ONLY')
  const [result] = await connection.query(`
    SELECT id_num, user_id, persona_id, role, content, created_at
    FROM chat_message
    WHERE role IN ('user', 'assistant')
    ORDER BY user_id, persona_id, created_at, id_num
  `)
  rows = result
  await connection.query('COMMIT')
} catch (error) {
  await connection.rollback()
  throw error
} finally {
  await connection.end()
}

let redactionCount = 0
function redactPii(text) {
  let value = String(text ?? '').replace(/\u0000/g, '')
  const rules = [
    [/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[手机号]'],
    [/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[邮箱]'],
    [/https?:\/\/[^\s<>"']+/gi, '[链接]'],
    [/(?<!\d)\d{17}[\dXx](?!\d)/g, '[身份证号]'],
    [/(?<!\d)\d{16,19}(?!\d)/g, '[长数字]'],
    [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP地址]'],
  ]
  for (const [pattern, replacement] of rules) {
    value = value.replace(pattern, () => {
      redactionCount += 1
      return replacement
    })
  }
  return value.trim()
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid created_at value')
  return date.toISOString()
}

const groups = new Map()
for (const row of rows) {
  const content = redactPii(row.content)
  if (!content) continue
  const key = `${String(row.user_id)}\u0000${String(row.persona_id)}`
  if (!groups.has(key)) {
    groups.set(key, {
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      messages: [],
    })
  }
  groups.get(key).messages.push({
    role: row.role === 'user' ? 'user' : 'assistant',
    content,
    createdAt: toIso(row.created_at),
    sequence: Number(row.id_num),
  })
}

const candidates = []
for (const group of groups.values()) {
  group.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence)
  if (group.messages.length < 4) continue

  const windows = []
  for (let start = 0; start + 4 <= group.messages.length; start += 6) {
    const messages = group.messages.slice(start, start + windowSize)
    const userCount = messages.filter((message) => message.role === 'user').length
    const assistantCount = messages.filter((message) => message.role === 'assistant').length
    if (userCount >= 2 && assistantCount >= 2) {
      windows.push({
        userId: group.userId,
        personaId: group.personaId,
        messages,
      })
    }
  }

  windows.sort((a, b) => {
    const aEndsWithUser = a.messages.at(-1)?.role === 'user' ? 1 : 0
    const bEndsWithUser = b.messages.at(-1)?.role === 'user' ? 1 : 0
    return bEndsWithUser - aEndsWithUser || b.messages.at(-1).createdAt.localeCompare(a.messages.at(-1).createdAt)
  })
  candidates.push(...windows.slice(0, 2))
}

if (candidates.length < targetCount) {
  throw new Error(`Only ${candidates.length} usable conversation windows were found`)
}

function seededRandom(seedText) {
  let state = createHash('sha256').update(seedText).digest().readUInt32BE(0)
  return () => {
    state += 0x6D2B79F5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

const random = seededRandom('wanxing-chat-corpus-v1')
for (let index = candidates.length - 1; index > 0; index -= 1) {
  const swapIndex = Math.floor(random() * (index + 1))
  ;[candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]]
}

const hmacKey = process.env.CORPUS_HMAC_KEY || randomBytes(32)
function anonymousRef(kind, id) {
  return createHmac('sha256', hmacKey).update(`${kind}:${id}`).digest('hex').slice(0, 16)
}

const samples = candidates.slice(0, targetCount).map((candidate, index) => ({
  sample_id: `chat-${String(index + 1).padStart(3, '0')}`,
  user_ref: anonymousRef('user', candidate.userId),
  persona_ref: anonymousRef('persona', candidate.personaId),
  source_table: 'chat_message',
  started_at: candidate.messages[0].createdAt,
  ended_at: candidate.messages.at(-1).createdAt,
  message_count: candidate.messages.length,
  messages: candidate.messages.map(({ role, content, createdAt }) => ({ role, content, created_at: createdAt })),
}))

if (samples.length !== targetCount) throw new Error('Corpus count validation failed')
if (samples.some((sample) => sample.message_count > windowSize)) throw new Error('Window size validation failed')
if (samples.some((sample) => sample.messages.some((message) => !['user', 'assistant'].includes(message.role)))) {
  throw new Error('Role validation failed')
}

const output = {
  dataset: 'wanxing_chat_windows',
  version: 1,
  created_at: new Date().toISOString(),
  read_only: true,
  count: samples.length,
  source: {
    database: process.env.DATABASE_NAME,
    table: 'chat_message',
    excluded_roles: ['system'],
    max_messages_per_window: windowSize,
  },
  anonymization: {
    user_and_persona_ids: 'HMAC-SHA256 truncated to 16 hex characters',
    pii_redactions: redactionCount,
  },
  samples,
}

await mkdir(outputDir, { recursive: true })
await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  outputFile,
  rowsRead: rows.length,
  groups: groups.size,
  candidateWindows: candidates.length,
  samplesWritten: samples.length,
  piiRedactions: redactionCount,
}, null, 2))
