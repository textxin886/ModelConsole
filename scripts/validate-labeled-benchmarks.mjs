import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetDir = path.join(projectRoot, 'datasets')
const files = [
  'private_reply_100.json',
  'proactive_push_decisions.json',
  'group_chat_benchmark.json',
  'moment_comment_benchmark.json',
  'tool_call_benchmark.json',
  'tool_definitions.json',
]
const errors = []
const loaded = {}
const fileStats = []

for (const file of files) {
  const raw = await readFile(path.join(datasetDir, file))
  const data = JSON.parse(raw.toString('utf8'))
  loaded[file] = data
  if (data.count !== data.samples.length) errors.push(`${file}: count mismatch`)
  const ids = new Set()
  for (const sample of data.samples) {
    if (!sample.sample_id) errors.push(`${file}: missing sample_id`)
    if (ids.has(sample.sample_id)) errors.push(`${file}: duplicate sample_id ${sample.sample_id}`)
    ids.add(sample.sample_id)
    if (file !== 'tool_definitions.json' && !sample.expected_output) {
      errors.push(`${file}: missing expected_output ${sample.sample_id}`)
    }
  }
  const text = raw.toString('utf8')
  if (/DATABASE_PASSWORD|47\.92\.119\.110/.test(text)) errors.push(`${file}: credential marker`)
  if (/(?<!\d)1[3-9]\d{9}(?!\d)|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|https?:\/\//.test(text)) {
    errors.push(`${file}: unredacted PII pattern`)
  }
  fileStats.push({
    file,
    count: data.count,
    bytes: raw.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
  })
}

function validateKeys(value, location = 'root') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => validateKeys(item, `${location}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    if (['user_id', 'persona_id', 'group_id', 'moment_id', 'from_user_id', 'id_num'].includes(key)) {
      errors.push(`${location}: raw identifier field ${key}`)
    }
    validateKeys(item, `${location}.${key}`)
  }
}

for (const [file, data] of Object.entries(loaded)) validateKeys(data, file)

const privateSamples = loaded['private_reply_100.json'].samples
for (const sample of privateSamples) {
  if (sample.input.messages.at(-1)?.role !== 'user') errors.push(`${sample.sample_id}: private input must end with user`)
  if (!sample.expected_output.reply) errors.push(`${sample.sample_id}: missing reference reply`)
  if (sample.input.messages.some((message) => !['user', 'assistant'].includes(message.role))) {
    errors.push(`${sample.sample_id}: invalid private role`)
  }
}

const pushSamples = loaded['proactive_push_decisions.json'].samples
for (const sample of pushSamples) {
  if (typeof sample.expected_output.should_push !== 'boolean') errors.push(`${sample.sample_id}: invalid push boolean`)
  if (!['end', 'soon', 'mid', 'evening', 'morning'].includes(sample.expected_output.next_check)) {
    errors.push(`${sample.sample_id}: invalid next_check`)
  }
  if (!sample.reference_answer) errors.push(`${sample.sample_id}: missing raw decision answer`)
}

const groupSamples = loaded['group_chat_benchmark.json'].samples
for (const sample of groupSamples) {
  if (!['single', 'chain'].includes(sample.expected_output.mode)) errors.push(`${sample.sample_id}: invalid group mode`)
  if (sample.label_basis === 'production_decision_log' && !sample.reference_answer) {
    errors.push(`${sample.sample_id}: missing group decision answer`)
  }
  if (sample.label_basis === 'next_real_assistant_message' && !sample.expected_output.reference_reply) {
    errors.push(`${sample.sample_id}: missing group reference reply`)
  }
}

const momentSamples = loaded['moment_comment_benchmark.json'].samples
for (const sample of momentSamples) {
  if (typeof sample.expected_output.should_comment !== 'boolean') errors.push(`${sample.sample_id}: invalid comment boolean`)
  if (sample.expected_output.should_comment && !sample.expected_output.commenter_name) {
    errors.push(`${sample.sample_id}: positive comment label missing commenter`)
  }
  if (sample.label_basis === 'production_decision_log' && !sample.reference_answer) {
    errors.push(`${sample.sample_id}: missing moment decision answer`)
  }
  if (sample.label_basis === 'next_real_persona_comment' && !sample.expected_output.reference_comment) {
    errors.push(`${sample.sample_id}: missing moment reference comment`)
  }
}

const toolSamples = loaded['tool_call_benchmark.json'].samples
const toolDistribution = {}
for (const sample of toolSamples) {
  const calls = sample.expected_output.tool_calls
  if (!Array.isArray(calls)) {
    errors.push(`${sample.sample_id}: missing tool_calls array`)
    continue
  }
  if (calls.length === 0) toolDistribution.__no_tool__ = (toolDistribution.__no_tool__ ?? 0) + 1
  for (const call of calls) {
    if (!call.name) errors.push(`${sample.sample_id}: missing tool name`)
    if (sample.input.available_tools.length > 0 && !sample.input.available_tools.includes(call.name)) {
      errors.push(`${sample.sample_id}: tool not available`)
    }
    toolDistribution[call.name] = (toolDistribution[call.name] ?? 0) + 1
  }
  if (sample.input.messages.some((message) => message.role === 'system')) errors.push(`${sample.sample_id}: system message exported`)
}

for (const sample of loaded['tool_definitions.json'].samples) {
  if (!sample.definition?.function?.name) errors.push(`${sample.sample_id}: invalid tool definition`)
}

const summary = {
  valid: errors.length === 0,
  files: fileStats,
  private: {
    count: privateSamples.length,
    uniqueUsers: new Set(privateSamples.map((sample) => sample.user_ref)).size,
    uniquePersonas: new Set(privateSamples.map((sample) => sample.persona_ref)).size,
  },
  proactive: {
    count: pushSamples.length,
    yes: pushSamples.filter((sample) => sample.expected_output.should_push).length,
    no: pushSamples.filter((sample) => !sample.expected_output.should_push).length,
  },
  group: {
    count: groupSamples.length,
    decisions: groupSamples.filter((sample) => sample.label_basis === 'production_decision_log').length,
    outcomes: groupSamples.filter((sample) => sample.label_basis === 'next_real_assistant_message').length,
    replyMatched: groupSamples.filter((sample) => sample.reference?.reply_matched).length,
  },
  moment: {
    count: momentSamples.length,
    decisions: momentSamples.filter((sample) => sample.label_basis === 'production_decision_log').length,
    outcomes: momentSamples.filter((sample) => sample.label_basis === 'next_real_persona_comment').length,
    shouldComment: momentSamples.filter((sample) => sample.expected_output.should_comment).length,
    noComment: momentSamples.filter((sample) => !sample.expected_output.should_comment).length,
    commentMatched: momentSamples.filter((sample) => sample.reference?.comment_matched).length,
  },
  tools: {
    count: toolSamples.length,
    distinctTools: Object.keys(toolDistribution).length,
    distribution: toolDistribution,
  },
  toolDefinitions: loaded['tool_definitions.json'].count,
  errors,
}

console.log(JSON.stringify(summary, null, 2))
if (errors.length > 0) process.exit(1)
