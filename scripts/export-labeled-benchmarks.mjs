import { createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(projectRoot, 'datasets')
const hmacKey = process.env.CORPUS_HMAC_KEY || randomBytes(32)
const pushThreshold = 0.6

for (const name of ['DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME']) {
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

let chatRows
let groupRows
let memberRows
let momentRows
let commentRows
let personaRows
let decisionLogs
let toolLogs

try {
  await connection.query('SET SESSION TRANSACTION READ ONLY')
  await connection.query('START TRANSACTION READ ONLY')
  ;[chatRows] = await connection.query(`
    SELECT id_num, user_id, persona_id, role, content, created_at, meta
    FROM chat_message
    ORDER BY user_id, persona_id, created_at, id_num
  `)
  ;[groupRows] = await connection.query(`
    SELECT id_num, group_id, user_id, persona_id, role, content, created_at, meta
    FROM group_message
    ORDER BY group_id, created_at, id_num
  `)
  ;[memberRows] = await connection.query(`
    SELECT group_id, persona_id, created_at
    FROM group_member
    ORDER BY group_id, created_at
  `)
  ;[momentRows] = await connection.query(`
    SELECT id, id_num, user_id, persona_id, content, media, created_at
    FROM moment
    ORDER BY created_at, id_num
  `)
  ;[commentRows] = await connection.query(`
    SELECT id, id_num, moment_id, user_id, persona_id, content, reply_to_id, created_at
    FROM moment_comment
    ORDER BY created_at, id_num
  `)
  ;[personaRows] = await connection.query(`
    SELECT id, user_id, name, description, last_interact_at, is_active, status
    FROM user_persona
    ORDER BY created_at
  `)
  ;[decisionLogs] = await connection.query(`
    SELECT id, created_at, content
    FROM debug_logs
    WHERE event = 'llm_relay_decision'
    ORDER BY created_at
  `)
  ;[toolLogs] = await connection.query(`
    SELECT id, event, created_at, content
    FROM debug_logs
    WHERE event IN ('llm_relay', 'llm_relay_companion_state')
    ORDER BY created_at
  `)
  await connection.query('COMMIT')
} catch (error) {
  try {
    await connection.rollback()
  } catch {
    // Preserve the original database error when the connection has already closed.
  }
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
  return value
}

function redactDeep(value) {
  if (typeof value === 'string') return redactPii(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)]))
  }
  return value
}

function anonymousRef(kind, id) {
  return createHmac('sha256', hmacKey).update(`${kind}:${id}`).digest('hex').slice(0, 16)
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp')
  return date.toISOString()
}

function parseMaybe(value) {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return JSON.parse(text)
    } catch {
      return value
    }
  }
  return value
}

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => textOf(item?.text ?? item?.content ?? '')).join('')
  if (value && typeof value === 'object') return textOf(value.text ?? value.content ?? '')
  return ''
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

function shuffle(items, seedText) {
  const result = [...items]
  const random = seededRandom(seedText)
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    ;[result[index], result[swapIndex]] = [result[swapIndex], result[index]]
  }
  return result
}

function envelope(dataset, task, samples, extra = {}) {
  return {
    dataset,
    version: 1,
    created_at: new Date().toISOString(),
    read_only: true,
    task,
    count: samples.length,
    ...extra,
    samples,
  }
}

const chatGroups = new Map()
for (const row of chatRows) {
  if (!['user', 'assistant'].includes(row.role)) continue
  const content = redactPii(row.content).trim()
  if (!content) continue
  const key = `${String(row.user_id)}\u0000${String(row.persona_id)}`
  if (!chatGroups.has(key)) {
    chatGroups.set(key, {
      userId: String(row.user_id),
      personaId: String(row.persona_id),
      messages: [],
    })
  }
  chatGroups.get(key).messages.push({
    role: row.role,
    content,
    createdAt: toIso(row.created_at),
    sequence: Number(row.id_num),
  })
}

const privateCandidates = []
for (const group of chatGroups.values()) {
  group.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence)
  const groupCandidates = []
  for (let index = 0; index < group.messages.length; index += 1) {
    if (group.messages[index].role !== 'user') continue
    let targetEnd = index + 1
    while (targetEnd < group.messages.length && group.messages[targetEnd].role === 'assistant') targetEnd += 1
    if (targetEnd === index + 1) continue
    const context = group.messages.slice(Math.max(0, index - 11), index + 1)
    if (!context.some((message) => message.role === 'assistant')) continue
    const targets = group.messages.slice(index + 1, targetEnd)
    groupCandidates.push({
      userId: group.userId,
      personaId: group.personaId,
      inputMessages: context,
      reply: targets.map((message) => message.content).join('\n'),
      targetCreatedAt: targets[0].createdAt,
    })
  }
  privateCandidates.push(...shuffle(groupCandidates, `private:${group.userId}:${group.personaId}`).slice(0, 2))
}

const privateSamples = shuffle(privateCandidates, 'private-reply-v1').slice(0, 100).map((candidate, index) => ({
  sample_id: `private-${String(index + 1).padStart(3, '0')}`,
  user_ref: anonymousRef('user', candidate.userId),
  persona_ref: anonymousRef('persona', candidate.personaId),
  input: {
    messages: candidate.inputMessages.map(({ role, content, createdAt }) => ({
      role,
      content,
      created_at: createdAt,
    })),
  },
  expected_output: {
    should_reply: true,
    reply: candidate.reply,
  },
  reference: {
    source_table: 'chat_message',
    target_created_at: candidate.targetCreatedAt,
  },
  label_basis: 'next_real_assistant_message',
}))

const proactiveSamples = []
const groupDecisionSamples = []
const momentDecisionSamples = []
const parsedDecisionLogs = []

for (const log of decisionLogs) {
  let payload
  try {
    payload = JSON.parse(log.content)
  } catch {
    continue
  }
  parsedDecisionLogs.push({ log, payload })
  const questionIds = payload.questionIds ?? []
  if (questionIds.includes('should_push') && questionIds.includes('next_check')) {
    const yesProbability = Number(payload.answers?.should_push?.yesProbability ?? 0)
    proactiveSamples.push({
      sample_id: `push-${String(proactiveSamples.length + 1).padStart(3, '0')}`,
      input: {
        state: redactPii(payload.state),
        questions: redactDeep(payload.questions),
      },
      expected_output: {
        should_push: yesProbability >= pushThreshold,
        next_check: payload.answers?.next_check?.choice ?? null,
      },
      reference_answer: redactDeep(payload.answers),
      reference: {
        source_table: 'debug_logs',
        source_log_id: log.id,
        created_at: toIso(log.created_at),
      },
      label_basis: 'production_decision_log',
    })
  }
}

const personaById = new Map(personaRows.map((row) => [String(row.id), row]))
const personaNameById = new Map(personaRows.map((row) => [String(row.id), row.name]))
const membersByGroup = new Map()
for (const row of memberRows) {
  const groupId = String(row.group_id)
  if (!membersByGroup.has(groupId)) membersByGroup.set(groupId, [])
  membersByGroup.get(groupId).push(String(row.persona_id))
}

const groupMessagesById = new Map()
for (const row of groupRows) {
  const groupId = String(row.group_id)
  if (!groupMessagesById.has(groupId)) groupMessagesById.set(groupId, [])
  groupMessagesById.get(groupId).push({
    groupId,
    userId: String(row.user_id),
    personaId: row.persona_id == null ? null : String(row.persona_id),
    personaName: row.persona_id == null ? null : personaNameById.get(String(row.persona_id)) ?? null,
    role: row.role,
    content: redactPii(row.content).trim(),
    createdAt: toIso(row.created_at),
    sequence: Number(row.id_num),
  })
}
for (const messages of groupMessagesById.values()) {
  messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence)
}

function groupCandidates(groupId) {
  const ids = [...(membersByGroup.get(groupId) ?? [])]
  for (const message of groupMessagesById.get(groupId) ?? []) {
    if (message.personaId && !ids.includes(message.personaId)) ids.push(message.personaId)
  }
  return ids.map((personaId) => {
    const persona = personaById.get(personaId)
    return {
      persona_ref: anonymousRef('persona', personaId),
      name: persona?.name ?? personaNameById.get(personaId) ?? '未知角色',
      blurb: redactPii(persona?.description ?? '').slice(0, 120),
    }
  })
}

function groupPersonaRefByName(groupId, name) {
  if (!groupId || !name) return null
  const personaId = (membersByGroup.get(groupId) ?? []).find((id) => personaById.get(id)?.name === name)
  return personaId ? anonymousRef('persona', personaId) : null
}

function matchGroupId(state) {
  const nameMatch = String(state ?? '').match(/微信群聊「([^」]+)」/)
  let bestGroupId = null
  let bestScore = 0
  for (const [groupId, messages] of groupMessagesById.entries()) {
    let score = 0
    for (const message of messages.slice(-30)) {
      if (message.content && String(state).includes(message.content.slice(0, 60))) score += 1
    }
    if (nameMatch && score === 0) continue
    if (score > bestScore) {
      bestScore = score
      bestGroupId = groupId
    }
  }
  return bestGroupId
}

function findGroupReply(groupId, createdAt, personaName) {
  if (!groupId || !personaName) return null
  const timestamp = new Date(createdAt).getTime()
  return (groupMessagesById.get(groupId) ?? [])
    .filter((message) => message.role === 'assistant' && message.personaName === personaName)
    .map((message) => ({ message, distance: Math.abs(new Date(message.createdAt).getTime() - timestamp) }))
    .filter(({ distance }) => distance <= 180000)
    .sort((a, b) => a.distance - b.distance)[0]?.message ?? null
}

const groupOutcomeSamples = []
for (const [groupId, allMessages] of groupMessagesById.entries()) {
  const messages = allMessages.filter((message) => message.role !== 'system' && message.content)
  const candidates = groupCandidates(groupId)
  for (let index = 0; index < messages.length; index += 1) {
    const target = messages[index]
    if (target.role !== 'assistant' || !target.personaId) continue
    const history = messages.slice(Math.max(0, index - 12), index)
    if (history.length === 0) continue
    groupOutcomeSamples.push({
      sample_id: `group-outcome-${String(groupOutcomeSamples.length + 1).padStart(3, '0')}`,
      group_ref: anonymousRef('group', groupId),
      input: {
        history: history.map((message) => ({
          role: message.role,
          speaker_ref: message.personaId ? anonymousRef('persona', message.personaId) : anonymousRef('user', message.userId),
          speaker_name: message.personaName ?? '用户',
          content: message.content,
          created_at: message.createdAt,
        })),
        candidates,
      },
      expected_output: {
        mode: 'single',
        responder_persona_ref: anonymousRef('persona', target.personaId),
        responder_name: target.personaName,
        reference_reply: target.content,
      },
      reference: {
        source_table: 'group_message',
        created_at: target.createdAt,
      },
      label_basis: 'next_real_assistant_message',
    })
  }
}

for (const { log, payload } of parsedDecisionLogs) {
  const questionIds = payload.questionIds ?? []
  const isSingle = questionIds.includes('who_replies')
  const isChain = questionIds.includes('chain_1') && questionIds.includes('chain_2')
  if (!isSingle && !isChain) continue
  const state = String(payload.state ?? '')
  const groupId = matchGroupId(state)
  let expectedOutput
  let responderName = null
  if (isSingle) {
    responderName = payload.answers?.who_replies?.choice ?? null
    expectedOutput = {
      mode: 'single',
      responder_name: responderName,
      responder_persona_ref: groupPersonaRefByName(groupId, responderName),
      at_user: Number(payload.answers?.at_user?.yesProbability ?? 0) >= 0.5,
      quote_user: Number(payload.answers?.quote_user?.yesProbability ?? 0) >= 0.5,
      at_prev_ai: Number(payload.answers?.at_prev_ai?.yesProbability ?? 0) >= 0.5,
    }
  } else {
    const chain = [payload.answers?.chain_1?.choice, payload.answers?.chain_2?.choice]
      .filter((name) => name && name !== '（不用再接了）')
    responderName = chain[0] ?? null
    expectedOutput = {
      mode: 'chain',
      chain: chain.map((name) => ({
        name,
        persona_ref: groupPersonaRefByName(groupId, name),
      })),
    }
  }
  const referenceReply = findGroupReply(groupId, log.created_at, responderName)
  groupDecisionSamples.push({
    sample_id: `group-decision-${String(groupDecisionSamples.length + 1).padStart(3, '0')}`,
    group_ref: groupId ? anonymousRef('group', groupId) : anonymousRef('group_name', state),
    input: {
      state: redactPii(state),
      questions: redactDeep(payload.questions),
    },
    expected_output: expectedOutput,
    reference_reply: referenceReply?.content ?? null,
    reference_answer: redactDeep(payload.answers),
    reference: {
      source_table: 'debug_logs',
      source_log_id: log.id,
      created_at: toIso(log.created_at),
      reply_matched: Boolean(referenceReply),
    },
    label_basis: 'production_decision_log',
  })
}

const groupSamples = [...groupDecisionSamples, ...shuffle(groupOutcomeSamples, 'group-outcome-v1')]

const momentById = new Map(momentRows.map((row) => [String(row.id), row]))
const commentsByMoment = new Map()
const normalizedComments = []
for (const row of commentRows) {
  const momentId = String(row.moment_id)
  if (!commentsByMoment.has(momentId)) commentsByMoment.set(momentId, [])
  const comment = {
    id: String(row.id),
    momentId,
    userId: row.user_id == null ? null : String(row.user_id),
    personaId: row.persona_id == null ? null : String(row.persona_id),
    personaName: row.persona_id == null ? null : personaNameById.get(String(row.persona_id)) ?? null,
    content: redactPii(row.content).trim(),
    replyToId: row.reply_to_id == null ? null : String(row.reply_to_id),
    createdAt: toIso(row.created_at),
    sequence: Number(row.id_num),
  }
  normalizedComments.push(comment)
  commentsByMoment.get(momentId).push(comment)
}
for (const comments of commentsByMoment.values()) {
  comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.sequence - b.sequence)
}

function momentOwnerUserId(moment) {
  if (moment.user_id != null) return String(moment.user_id)
  if (moment.persona_id != null) {
    const author = personaById.get(String(moment.persona_id))
    if (author?.user_id != null) return String(author.user_id)
  }
  return null
}

function momentCandidates(moment, requiredPersonaId) {
  const ownerUserId = momentOwnerUserId(moment)
  const candidates = personaRows
    .filter((persona) => ownerUserId && String(persona.user_id) === ownerUserId && Number(persona.is_active) === 1)
    .sort((a, b) => String(b.last_interact_at ?? '').localeCompare(String(a.last_interact_at ?? '')))
    .map((persona) => String(persona.id))
  if (requiredPersonaId && !candidates.includes(requiredPersonaId)) candidates.unshift(requiredPersonaId)
  return candidates.slice(0, 8).map((personaId) => {
    const persona = personaById.get(personaId)
    return {
      persona_ref: anonymousRef('persona', personaId),
      name: persona?.name ?? personaNameById.get(personaId) ?? '未知角色',
      blurb: redactPii(persona?.description ?? '').slice(0, 120),
    }
  })
}

function momentPersonaRefByName(moment, name) {
  const ownerUserId = moment ? momentOwnerUserId(moment) : null
  if (!ownerUserId || !name) return null
  const persona = personaRows.find((row) => String(row.user_id) === ownerUserId && row.name === name)
  return persona ? anonymousRef('persona', persona.id) : null
}

const momentOutcomeSamples = []
for (const comment of normalizedComments) {
  if (!comment.personaId) continue
  const moment = momentById.get(comment.momentId)
  if (!moment || !momentOwnerUserId(moment)) continue
  const priorComments = (commentsByMoment.get(comment.momentId) ?? [])
    .filter((item) => item.createdAt < comment.createdAt || (item.createdAt === comment.createdAt && item.sequence < comment.sequence))
    .slice(-8)
  momentOutcomeSamples.push({
    sample_id: `moment-outcome-${String(momentOutcomeSamples.length + 1).padStart(3, '0')}`,
    moment_ref: anonymousRef('moment', comment.momentId),
    input: {
      moment: {
        author_type: moment.user_id != null ? 'user' : 'persona',
        content: redactPii(moment.content),
        has_media: Array.isArray(parseMaybe(moment.media)) && parseMaybe(moment.media).length > 0,
        created_at: toIso(moment.created_at),
      },
      prior_comments: priorComments.map((item) => ({
        commenter_ref: item.personaId ? anonymousRef('persona', item.personaId) : anonymousRef('user', item.userId),
        commenter_name: item.personaName ?? '用户',
        content: item.content,
        created_at: item.createdAt,
      })),
      candidates: momentCandidates(moment, comment.personaId),
    },
    expected_output: {
      should_comment: true,
      commenter_persona_ref: anonymousRef('persona', comment.personaId),
      commenter_name: comment.personaName,
      reply_to_comment_ref: comment.replyToId ? anonymousRef('moment_comment', comment.replyToId) : null,
      reference_comment: comment.content,
    },
    reference: {
      source_table: 'moment_comment',
      created_at: comment.createdAt,
    },
    label_basis: 'next_real_persona_comment',
  })
}

function findMomentComment(state, createdAt, personaName) {
  const match = String(state ?? '').match(/动态内容：「([^」]*)」/)
  if (!match || !personaName) return null
  const moment = momentRows.find((row) => row.content === match[1])
  if (!moment) return null
  const timestamp = new Date(createdAt).getTime()
  const comment = (commentsByMoment.get(String(moment.id)) ?? [])
    .filter((item) => item.personaName === personaName)
    .map((item) => ({ item, distance: Math.abs(new Date(item.createdAt).getTime() - timestamp) }))
    .filter(({ distance }) => distance <= 1800000)
    .sort((a, b) => a.distance - b.distance)[0]?.item ?? null
  return { moment, comment }
}

for (const { log, payload } of parsedDecisionLogs) {
  if (!(payload.questionIds ?? []).includes('follow_who')) continue
  const state = String(payload.state ?? '')
  const choice = payload.answers?.follow_who?.choice ?? null
  const shouldComment = Boolean(choice && choice !== '（不用跟了）')
  const matched = shouldComment ? findMomentComment(state, log.created_at, choice) : null
  const commenterPersonaRef = shouldComment ? momentPersonaRefByName(matched?.moment, choice) : null
  momentDecisionSamples.push({
    sample_id: `moment-decision-${String(momentDecisionSamples.length + 1).padStart(3, '0')}`,
    moment_ref: matched?.moment ? anonymousRef('moment', matched.moment.id) : anonymousRef('moment_state', state),
    input: {
      state: redactPii(state),
      questions: redactDeep(payload.questions),
    },
    expected_output: {
      should_comment: shouldComment,
      commenter_name: shouldComment ? choice : null,
      commenter_persona_ref: commenterPersonaRef,
      reference_comment: matched?.comment?.content ?? null,
    },
    reference_answer: redactDeep(payload.answers),
    reference: {
      source_table: 'debug_logs',
      source_log_id: log.id,
      created_at: toIso(log.created_at),
      comment_matched: Boolean(matched?.comment),
    },
    label_basis: 'production_decision_log',
  })
}

const momentSamples = [...momentDecisionSamples, ...shuffle(momentOutcomeSamples, 'moment-outcome-v1')]

function findArraysByKey(value, key, path = '', output = []) {
  const parsed = parseMaybe(value)
  if (!parsed || typeof parsed !== 'object') return output
  for (const [name, item] of Object.entries(parsed)) {
    const itemPath = path ? `${path}.${name}` : name
    const parsedItem = parseMaybe(item)
    if (name === key && Array.isArray(parsedItem)) output.push({ path: itemPath, value: parsedItem })
    if (parsedItem && typeof parsedItem === 'object') findArraysByKey(parsedItem, key, itemPath, output)
  }
  return output
}

function normalizeArguments(value) {
  const parsed = parseMaybe(value)
  if (parsed && typeof parsed === 'object') return redactDeep(parsed)
  return redactPii(value)
}

const toolCandidates = []
const seenToolSignatures = new Set()
for (const log of toolLogs) {
  let payload
  try {
    payload = JSON.parse(log.content)
  } catch {
    continue
  }
  const requestBody = parseMaybe(payload.requestBody) ?? {}
  const responseBody = parseMaybe(payload.responseBody)
  if (!responseBody || typeof responseBody !== 'object' || responseBody.error) continue
  const arrays = findArraysByKey(responseBody, 'tool_calls')
  const rawCalls = arrays.flatMap((item) => item.value)
  const calls = rawCalls.map((call) => ({
    name: call?.function?.name ?? call?.name ?? null,
    arguments: normalizeArguments(call?.function?.arguments ?? call?.arguments ?? {}),
  })).filter((call) => call.name)
  const availableTools = Array.isArray(requestBody.tools)
    ? requestBody.tools.map((tool) => tool?.function?.name).filter(Boolean)
    : []
  if (availableTools.length === 0) continue
  if (calls.length > 0 && calls.some((call) => !availableTools.includes(call.name))) continue
  const messages = Array.isArray(requestBody.messages) ? requestBody.messages : []
  const contextMessages = messages
    .filter((message) => message?.role && message.role !== 'system')
    .slice(-8)
    .map((message) => ({
      role: message.role,
      ...(message.role === 'tool' && message.name ? { tool_name: message.name } : {}),
      content: redactPii(textOf(message.content)).slice(0, 1200),
    }))
    .filter((message) => message.content)
  if (contextMessages.length === 0) continue
  const signature = `${calls.map((call) => call.name).join(',')}|${JSON.stringify(calls.map((call) => call.arguments))}|${contextMessages.at(-1)?.content ?? ''}`
  if (seenToolSignatures.has(signature)) continue
  seenToolSignatures.add(signature)
  toolCandidates.push({
    primaryTool: calls[0]?.name ?? '__no_tool__',
    sample: {
      sample_id: '',
      user_ref: payload.userId ? anonymousRef('user', payload.userId) : null,
      input: {
        messages: contextMessages,
        available_tools: availableTools,
      },
      expected_output: {
        tool_calls: calls,
      },
      reference: {
        source_table: 'debug_logs',
        source_log_id: log.id,
        event: log.event,
        created_at: toIso(log.created_at),
      },
      label_basis: calls.length > 0 ? 'production_response_tool_calls' : 'production_response_no_tool_calls',
    },
    toolDefinitions: Array.isArray(requestBody.tools) ? redactDeep(requestBody.tools) : [],
  })
}

const toolBuckets = new Map()
for (const candidate of toolCandidates) {
  if (!toolBuckets.has(candidate.primaryTool)) toolBuckets.set(candidate.primaryTool, [])
  toolBuckets.get(candidate.primaryTool).push(candidate)
}
for (const bucket of toolBuckets.values()) bucket.sort((a, b) => b.sample.reference.created_at.localeCompare(a.sample.reference.created_at))

function selectRoundRobin(candidates, limit) {
  const buckets = new Map()
  for (const candidate of candidates) {
    if (!buckets.has(candidate.primaryTool)) buckets.set(candidate.primaryTool, [])
    buckets.get(candidate.primaryTool).push(candidate)
  }
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => b.sample.reference.created_at.localeCompare(a.sample.reference.created_at))
  }
  const selected = []
  const names = [...buckets.keys()].sort()
  while (selected.length < limit) {
    let added = false
    for (const name of names) {
      const bucket = buckets.get(name)
      if (bucket.length > 0) {
        selected.push(bucket.shift())
        added = true
        if (selected.length === limit) break
      }
    }
    if (!added) break
  }
  return selected
}

const positiveToolCandidates = toolCandidates.filter((candidate) => candidate.primaryTool !== '__no_tool__')
const negativeToolCandidates = toolCandidates.filter((candidate) => candidate.primaryTool === '__no_tool__')
const selectedToolCandidates = [
  ...selectRoundRobin(positiveToolCandidates, 50),
  ...selectRoundRobin(negativeToolCandidates, 50),
]

const toolSamples = selectedToolCandidates.map((candidate, index) => ({
  ...candidate.sample,
  sample_id: `tool-${String(index + 1).padStart(3, '0')}`,
}))

const toolDefinitions = new Map()
for (const candidate of selectedToolCandidates) {
  for (const tool of candidate.toolDefinitions) {
    const name = tool?.function?.name
    if (name && !toolDefinitions.has(name)) toolDefinitions.set(name, tool)
  }
}
const toolDefinitionSamples = [...toolDefinitions.values()].map((definition, index) => ({
  sample_id: `tool-def-${String(index + 1).padStart(3, '0')}`,
  definition,
}))

const privateFile = path.join(outputDir, 'private_reply_100.json')
const proactiveFile = path.join(outputDir, 'proactive_push_decisions.json')
const groupFile = path.join(outputDir, 'group_chat_benchmark.json')
const momentFile = path.join(outputDir, 'moment_comment_benchmark.json')
const toolFile = path.join(outputDir, 'tool_call_benchmark.json')
const toolDefinitionsFile = path.join(outputDir, 'tool_definitions.json')
const manifestFile = path.join(outputDir, 'labeled_manifest.json')

const outputs = [
  {
    file: privateFile,
    data: envelope('wanxing_private_reply', 'private_reply', privateSamples, {
      label_basis: 'next_real_assistant_message',
      match_mode: 'semantic',
    }),
  },
  {
    file: proactiveFile,
    data: envelope('wanxing_proactive_push', 'proactive_push', proactiveSamples, {
      label_basis: 'production_decision_log',
      push_threshold: pushThreshold,
      match_mode: 'exact_decision',
    }),
  },
  {
    file: groupFile,
    data: envelope('wanxing_group_chat', 'group_reply_and_decision', groupSamples, {
      label_basis: 'production_decision_log_or_next_real_assistant_message',
      match_mode: 'decision_exact_reply_semantic',
    }),
  },
  {
    file: momentFile,
    data: envelope('wanxing_moment_comment', 'moment_comment_and_decision', momentSamples, {
      label_basis: 'production_decision_log_or_next_real_persona_comment',
      match_mode: 'decision_exact_reply_semantic',
    }),
  },
  {
    file: toolFile,
    data: envelope('wanxing_tool_call', 'tool_call', toolSamples, {
      label_basis: 'production_response_tool_calls_or_no_tool_calls',
      match_mode: 'tool_name_exact_arguments_structural',
    }),
  },
  {
    file: toolDefinitionsFile,
    data: envelope('wanxing_tool_definitions', 'tool_definitions', toolDefinitionSamples, {
      label_basis: 'production_request_tool_definitions',
    }),
  },
]

const manifest = {
  dataset: 'wanxing_labeled_benchmarks',
  version: 1,
  created_at: new Date().toISOString(),
  read_only: true,
  source: {
    database: process.env.DATABASE_NAME,
    tables: ['chat_message', 'group_message', 'group_member', 'moment', 'moment_comment', 'user_persona', 'debug_logs'],
  },
  anonymization: {
    ids: 'HMAC-SHA256 truncated to 16 hex characters',
    pii_redactions: redactionCount,
    note: 'Roleplay names and dialogue content are retained; account IDs and common PII patterns are removed.',
  },
  files: outputs.map(({ file, data }) => ({
    file: path.basename(file),
    count: data.count,
    task: data.task,
    label_basis: data.label_basis,
    match_mode: data.match_mode ?? null,
  })),
}

function validate(value, pathName = 'root') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validate(item, `${pathName}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (['user_id', 'persona_id', 'group_id', 'moment_id', 'from_user_id', 'id_num'].includes(key)) {
      throw new Error(`Raw identifier field exported at ${pathName}.${key}`)
    }
    validate(item, `${pathName}.${key}`)
  }
}

for (const { file, data } of outputs) {
  if (data.count !== data.samples.length) throw new Error(`Count mismatch: ${file}`)
  validate(data)
  const serialized = JSON.stringify(data)
  if (serialized.includes('DATABASE_PASSWORD') || serialized.includes('47.92.119.110')) {
    throw new Error(`Credential material detected: ${file}`)
  }
}

validate(manifest)
await mkdir(outputDir, { recursive: true })
for (const { file, data } of outputs) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

console.log(JSON.stringify({
  manifestFile,
  files: outputs.map(({ file, data }) => ({ file: path.basename(file), count: data.count })),
  piiRedactions: redactionCount,
}, null, 2))
