import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { GeneralChatWrapper, getLlama, LlamaChatSession, QwenChatWrapper, resolveChatWrapper } from 'node-llama-cpp'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const datasetDir = path.join(projectRoot, 'datasets')
const resultsDir = path.join(datasetDir, 'results')
const modelSelector = process.argv[2] ?? '2B'
const replyLimit = Number(process.argv[3] ?? 30)
const toolJsonLimit = Number(process.argv[4] ?? 20)
const selectedTask = process.argv[5] ?? 'all'
const decisionLimit = Number(process.argv[6] ?? 0)
for (const [name, value] of Object.entries({ replyLimit, toolJsonLimit, decisionLimit })) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`)
}
if (!['all', 'decisions', 'generation'].includes(selectedTask)) throw new Error(`未知任务：${selectedTask}`)

const modelFiles = [
  { name: 'Qwen3.5-0.8B-Q4_K_M', file: 'Qwen3.5-0.8B-Q4_K_M.gguf' },
  { name: 'Qwen3.5-2B-Q4_K_M', file: 'Qwen3.5-2B-Q4_K_M.gguf' },
  { name: 'Qwen3-4B-Instruct-2507-Q6_K', file: 'Qwen3-4B-Instruct-2507-Q6_K.gguf' },
]
const modelInfo = modelFiles.find((model) => model.name.includes(modelSelector))
if (!modelInfo) throw new Error(`未找到模型：${modelSelector}`)
const onlyCategory = process.env.BENCHMARK_CATEGORY || 'all'
const categoryNames = ['all', 'proactive', 'group', 'moment', 'toolRouting']
if (!categoryNames.includes(onlyCategory)) throw new Error(`未知评测类别：${onlyCategory}`)
const outputFile = process.env.BENCHMARK_OUTPUT
  ? path.resolve(projectRoot, process.env.BENCHMARK_OUTPUT)
  : path.join(
    resultsDir,
    modelInfo.file === 'Qwen3-4B-Instruct-2507-Q6_K.gguf'
      ? 'labeled_benchmark_results_qwen3-4b-q6k.json'
      : 'labeled_benchmark_results.json',
  )

function shouldRunCategory(category) {
  return selectedTask === 'all'
    || (selectedTask === 'decisions' && (onlyCategory === 'all' || onlyCategory === category))
}

async function loadDataset(file) {
  const raw = await readFile(path.join(datasetDir, file))
  return {
    data: JSON.parse(raw.toString('utf8')),
    sha256: createHash('sha256').update(raw).digest('hex'),
  }
}

const [
  privateDataset,
  pushDataset,
  groupDataset,
  momentDataset,
  toolDataset,
  toolDefinitionsDataset,
  manifestDataset,
] = await Promise.all([
  loadDataset('private_reply_100.json'),
  loadDataset('proactive_push_decisions.json'),
  loadDataset('group_chat_benchmark.json'),
  loadDataset('moment_comment_benchmark.json'),
  loadDataset('tool_call_benchmark.json'),
  loadDataset('tool_definitions.json'),
  loadDataset('labeled_manifest.json'),
])

const toolDefinitions = new Map(
  toolDefinitionsDataset.data.samples.map((sample) => [sample.definition.function.name, sample.definition.function]),
)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length === 0
    ? 0
    : sorted.length % 2 === 0
      ? (sorted[middle - 1] + sorted[middle]) / 2
      : sorted[middle]
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function latencyStats(results) {
  const values = results.map((result) => result.latencyMs)
  return {
    p50: median(values),
    p95: percentile(values, 0.95),
    max: values.length === 0 ? 0 : Math.max(...values),
  }
}

function accuracy(results, key = 'correct') {
  return results.length === 0 ? 0 : results.filter((result) => result[key]).length / results.length
}

function selectRepresentative(samples, limit) {
  if (limit === 0) return []
  if (limit >= samples.length) return samples
  const step = samples.length / limit
  return Array.from({ length: limit }, (_, index) => samples[Math.floor(index * step)])
}

function selectStratified(samples, limit, keyOf) {
  if (limit <= 0 || limit >= samples.length) return samples
  const groups = new Map()
  for (const sample of samples) {
    const key = String(keyOf(sample))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(sample)
  }
  const allocations = [...groups.values()].map((group) => ({
    group,
    exact: limit * group.length / samples.length,
    count: Math.floor(limit * group.length / samples.length),
  }))
  let remaining = limit - allocations.reduce((sum, item) => sum + item.count, 0)
  allocations.sort((left, right) => (right.exact - right.count) - (left.exact - left.count))
  for (const item of allocations) {
    if (remaining <= 0) break
    item.count += 1
    remaining -= 1
  }
  return allocations.flatMap((item) => selectRepresentative(item.group, item.count))
}

function adaptQuestion(question) {
  return {
    type: question.type,
    instruction: question.instructions,
    ...(question.criteria ? { criteria: question.criteria } : {}),
  }
}

function adaptQuestions(questions) {
  return Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, adaptQuestion(question)]))
}

function choiceValue(answer) {
  return answer?.type === 'choice' ? answer.choice : null
}

function noulValue(answer, threshold = 0.5) {
  const probability = answer?.value ?? answer?.yesProbability
  return answer?.type === 'noul' && Number.isFinite(probability) ? probability >= threshold : null
}

function answerConfidence(answer) {
  if (answer?.type === 'noul') {
    const probability = answer.value ?? answer.yesProbability
    return Number.isFinite(probability) ? Math.max(probability, 1 - probability) : 0
  }
  return answer?.confidence ?? 0
}

function rss() {
  return process.memoryUsage().rss
}

function formatMessages(messages, limit = 8, maxChars = 600) {
  return messages
    .filter((message) => message?.role && message.role !== 'system')
    .slice(-limit)
    .map((message) => {
      const speaker = message.speaker_name ?? (message.role === 'user' ? '用户' : message.role === 'assistant' ? '角色' : message.tool_name ?? '工具')
      return `${speaker}：${String(message.content ?? '').slice(0, maxChars)}`
    })
    .join('\n')
}

function groupOutcomeDocument(sample) {
  const candidates = sample.input.candidates.map((candidate, index) => `${index + 1}. ${candidate.name}：${candidate.blurb}`).join('\n')
  return `这是群聊。请根据最近记录和候选成员，判断下一位最自然接话的成员。\n候选成员：\n${candidates}\n最近群聊记录：\n${formatMessages(sample.input.history, 12, 500)}`
}

function momentOutcomeDocument(sample) {
  const candidates = sample.input.candidates.map((candidate, index) => `${index + 1}. ${candidate.name}：${candidate.blurb}`).join('\n')
  const comments = sample.input.prior_comments.length > 0
    ? sample.input.prior_comments.map((comment) => `${comment.commenter_name}：${comment.content}`).join('\n')
    : '暂无评论'
  return `这是朋友圈动态。判断是否有人适合评论；如果适合，只选一个最自然的评论者，否则选择不评论。\n动态：${sample.input.moment.content}\n已有评论：\n${comments}\n候选评论者：\n${candidates}`
}

function toolRoutingDocument(sample, labelByName) {
  const toolLines = sample.input.available_tools.map((name) => {
    const description = String(toolDefinitions.get(name)?.description ?? name).slice(0, 60)
    return `${labelByName.get(name)} ${name}：${description}`
  })
  return `你是角色聊天助手。根据对话决定是否调用工具。只有用户明确需要实时信息、长期记忆、提醒、图像、语音、生活状态、群聊、动态或日程等工具能力时才调用；普通闲聊、表达情绪或单纯回应时不要调用。\n最近对话：\n${formatMessages(sample.input.messages, 4, 220)}\n可用工具：\n${toolLines.join('\n')}\nNONE 不调用工具，直接自然回复`
}

function normalizedChars(text) {
  return Array.from(String(text ?? '')).filter((char) => /[\p{L}\p{N}]/u.test(char))
}

function ngramF1(expected, actual, size) {
  const left = normalizedChars(expected)
  const right = normalizedChars(actual)
  if (left.length < size || right.length < size) return left.join('') === right.join('') ? 1 : 0
  const leftCounts = new Map()
  const rightCounts = new Map()
  for (let index = 0; index <= left.length - size; index++) {
    const gram = left.slice(index, index + size).join('')
    leftCounts.set(gram, (leftCounts.get(gram) ?? 0) + 1)
  }
  for (let index = 0; index <= right.length - size; index++) {
    const gram = right.slice(index, index + size).join('')
    rightCounts.set(gram, (rightCounts.get(gram) ?? 0) + 1)
  }
  let overlap = 0
  for (const [gram, count] of leftCounts) overlap += Math.min(count, rightCounts.get(gram) ?? 0)
  const leftTotal = left.length - size + 1
  const rightTotal = right.length - size + 1
  return leftTotal + rightTotal === 0 ? 0 : (2 * overlap) / (leftTotal + rightTotal)
}

function replyMetrics(expected, actual) {
  return {
    exactMatch: expected.trim() === actual.trim(),
    charUnigramF1: ngramF1(expected, actual, 1),
    charBigramF1: ngramF1(expected, actual, 2),
    lengthRatio: normalizedChars(expected).length === 0 ? 0 : normalizedChars(actual).length / normalizedChars(expected).length,
  }
}

function sortedKeys(value) {
  return Array.isArray(value) ? value.map(sortedKeys) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedKeys(value[key])]))
    : value
}

const output = {
  created_at: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    threads: 2,
    decisionContextSize: 4096,
    generationContextSize: 2048,
    parallelQuestions: 2,
    replyLimit,
    toolJsonLimit,
    selectedTask,
    onlyCategory,
    decisionLimit,
  },
  model: modelInfo,
  datasets: {
    private: privateDataset.sha256,
    proactive: pushDataset.sha256,
    group: groupDataset.sha256,
    moment: momentDataset.sha256,
    tools: toolDataset.sha256,
    toolDefinitions: toolDefinitionsDataset.sha256,
    manifest: manifestDataset.sha256,
  },
  memory: {},
  summary: {},
  results: {},
}

async function saveOutput() {
  await mkdir(path.dirname(outputFile), { recursive: true })
  await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
}

const llama = await getLlama({
  gpu: false,
  build: 'never',
  maxThreads: 2,
  logLevel: 'error',
})

let model
let decisionContext
let generationContext
let session

function createModelChatWrapper() {
  if (modelInfo.file.startsWith('Qwen3.5-')) {
    return new QwenChatWrapper({ variation: '3.5', thoughts: 'discourage' })
  }
  return resolveChatWrapper(model, { warningLogs: false }) ?? new GeneralChatWrapper()
}

let peakRssBytes = 0
const rssTimer = setInterval(() => {
  peakRssBytes = Math.max(peakRssBytes, rss())
}, 250)
rssTimer.unref()

try {
  console.log(`加载 ${modelInfo.name}`)
  const loadStart = performance.now()
  model = await llama.loadModel({ modelPath: path.join(projectRoot, 'models', modelInfo.file) })
  output.memory.loadMs = performance.now() - loadStart
  output.memory.rssAfterModelLoad = rss()
  console.log(`模型加载完成 ${output.memory.loadMs.toFixed(0)}ms，RSS ${(output.memory.rssAfterModelLoad / 1024 / 1024).toFixed(0)} MiB`)

  if (selectedTask === 'all' || selectedTask === 'decisions') {
    decisionContext = await model.createDecisionContext({
      chatWrapper: createModelChatWrapper(),
      contextSize: 4096,
      batchSize: 512,
      parallelQuestions: 2,
      threads: 2,
    })
    await decisionContext.warmup()
    output.memory.rssAfterDecisionWarmup = rss()
    output.memory.decisionContext = decisionContext.memoryUsage
    console.log(`决策上下文就绪，RSS ${(output.memory.rssAfterDecisionWarmup / 1024 / 1024).toFixed(0)} MiB`)

    const pushSamples = shouldRunCategory('proactive')
      ? selectStratified(pushDataset.data.samples, decisionLimit, (sample) => sample.expected_output.should_push)
      : []
    const pushResults = []
    for (const [index, sample] of pushSamples.entries()) {
      const start = performance.now()
      try {
        const response = await decisionContext.decideWithMeta(sample.input.state, adaptQuestions(sample.input.questions))
        const actualPush = noulValue(response.answers.should_push, pushDataset.data.push_threshold)
        const actualNextCheck = choiceValue(response.answers.next_check)
        pushResults.push({
          sample_id: sample.sample_id,
          expected: sample.expected_output,
          actual: { should_push: actualPush, next_check: actualNextCheck },
          should_push_correct: actualPush === sample.expected_output.should_push,
          next_check_correct: actualNextCheck === sample.expected_output.next_check,
          correct: actualPush === sample.expected_output.should_push && actualNextCheck === sample.expected_output.next_check,
          confidence: {
            should_push: answerConfidence(response.answers.should_push),
            next_check: answerConfidence(response.answers.next_check),
          },
          latencyMs: performance.now() - start,
          tokenUsage: response.tokenUsage,
          answer: response.answers,
        })
      } catch (error) {
        pushResults.push({ sample_id: sample.sample_id, correct: false, error: String(error), latencyMs: performance.now() - start })
      }
      if ((index + 1) % 10 === 0) console.log(`主动推送 ${index + 1}/${pushSamples.length}`)
    }
    output.results.proactive = pushResults
    output.summary.proactive = {
      count: pushResults.length,
      shouldPushAccuracy: accuracy(pushResults, 'should_push_correct'),
      nextCheckAccuracy: accuracy(pushResults, 'next_check_correct'),
      jointAccuracy: accuracy(pushResults),
      latencyMs: latencyStats(pushResults),
    }
    await saveOutput()

    const groupSamples = shouldRunCategory('group')
      ? selectStratified(groupDataset.data.samples, decisionLimit, (sample) => sample.label_basis)
      : []
    const groupResults = []
    for (const [index, sample] of groupSamples.entries()) {
      const start = performance.now()
      try {
        if (sample.label_basis === 'production_decision_log') {
          const response = await decisionContext.decideWithMeta(sample.input.state, adaptQuestions(sample.input.questions))
          const actual = { mode: sample.expected_output.mode }
          if (sample.expected_output.mode === 'single') {
            actual.responder_name = choiceValue(response.answers.who_replies)
            actual.at_user = noulValue(response.answers.at_user)
            actual.quote_user = noulValue(response.answers.quote_user)
            actual.at_prev_ai = noulValue(response.answers.at_prev_ai)
          } else {
            actual.chain = [choiceValue(response.answers.chain_1), choiceValue(response.answers.chain_2)]
              .filter((name) => name && name !== '（不用再接了）')
          }
          const responderCorrect = sample.expected_output.mode === 'chain'
            ? JSON.stringify(actual.chain) === JSON.stringify(sample.expected_output.chain.map((item) => typeof item === 'string' ? item : item.name))
            : actual.responder_name === sample.expected_output.responder_name
          const flagsCorrect = sample.expected_output.mode === 'chain'
            ? true
            : ['at_user', 'quote_user', 'at_prev_ai'].every((key) => actual[key] === sample.expected_output[key])
          groupResults.push({
            sample_id: sample.sample_id,
            label_basis: sample.label_basis,
            expected: sample.expected_output,
            actual,
            responder_correct: responderCorrect,
            flags_correct: flagsCorrect,
            correct: responderCorrect && flagsCorrect,
            latencyMs: performance.now() - start,
            tokenUsage: response.tokenUsage,
            answer: response.answers,
          })
        } else {
          const criteria = Object.fromEntries(sample.input.candidates.map((candidate) => [candidate.name, candidate.blurb]))
          criteria['（不用再接了）'] = '当前不需要角色继续接话'
          const response = await decisionContext.decideWithMeta(groupOutcomeDocument(sample), {
            answer: {
              type: 'choice',
              instruction: '下一位最自然接话的成员是谁？如果没人需要接话，选择“（不用再接了）”。',
              criteria,
            },
          })
          const actual = choiceValue(response.answers.answer)
          groupResults.push({
            sample_id: sample.sample_id,
            label_basis: sample.label_basis,
            expected: sample.expected_output,
            actual: { responder_name: actual },
            responder_correct: actual === sample.expected_output.responder_name,
            flags_correct: true,
            correct: actual === sample.expected_output.responder_name,
            latencyMs: performance.now() - start,
            tokenUsage: response.tokenUsage,
            answer: response.answers,
          })
        }
      } catch (error) {
        groupResults.push({
          sample_id: sample.sample_id,
          label_basis: sample.label_basis,
          expected: sample.expected_output,
          responder_correct: false,
          flags_correct: false,
          correct: false,
          error: String(error),
          latencyMs: performance.now() - start,
        })
      }
      if ((index + 1) % 10 === 0) console.log(`群聊 ${index + 1}/${groupSamples.length}`)
    }
    output.results.group = groupResults
    const groupDecisions = groupResults.filter((result) => result.label_basis === 'production_decision_log')
    const groupSingleDecisions = groupDecisions.filter((result) => result.expected?.mode === 'single')
    const groupOutcomes = groupResults.filter((result) => result.label_basis === 'next_real_assistant_message')
    output.summary.group = {
      count: groupResults.length,
      decisionCount: groupDecisions.length,
      outcomeCount: groupOutcomes.length,
      responderAccuracy: accuracy(groupResults, 'responder_correct'),
      decisionResponderAccuracy: accuracy(groupDecisions, 'responder_correct'),
      outcomeResponderAccuracy: accuracy(groupOutcomes, 'responder_correct'),
      flagsAccuracy: accuracy(groupSingleDecisions, 'flags_correct'),
      exactAccuracy: accuracy(groupResults),
      latencyMs: latencyStats(groupResults),
    }
    await saveOutput()

    const momentSamples = shouldRunCategory('moment')
      ? selectStratified(momentDataset.data.samples, decisionLimit, (sample) => sample.label_basis)
      : []
    const momentResults = []
    for (const [index, sample] of momentSamples.entries()) {
      const start = performance.now()
      try {
        let response
        if (sample.label_basis === 'production_decision_log') {
          response = await decisionContext.decideWithMeta(sample.input.state, adaptQuestions(sample.input.questions))
        } else {
          const criteria = Object.fromEntries(sample.input.candidates.map((candidate) => [candidate.name, candidate.blurb]))
          criteria['（不用跟了）'] = '没人需要跟评，这一轮就到这里'
          response = await decisionContext.decideWithMeta(momentOutcomeDocument(sample), {
            answer: {
              type: 'choice',
              instruction: '是否有人适合评论这条动态？只选一个最自然的评论者，否则选择“（不用跟了）”。',
              criteria,
            },
          })
        }
        const commenter = choiceValue(response.answers.follow_who ?? response.answers.answer)
        const shouldComment = commenter !== '（不用跟了）'
        const expected = sample.expected_output
        momentResults.push({
          sample_id: sample.sample_id,
          label_basis: sample.label_basis,
          expected,
          actual: { should_comment: shouldComment, commenter_name: shouldComment ? commenter : null },
          should_comment_correct: shouldComment === expected.should_comment,
          commenter_correct: (shouldComment ? commenter : null) === expected.commenter_name,
          correct: shouldComment === expected.should_comment && (shouldComment ? commenter : null) === expected.commenter_name,
          confidence: answerConfidence(response.answers.follow_who ?? response.answers.answer),
          latencyMs: performance.now() - start,
          tokenUsage: response.tokenUsage,
          answer: response.answers,
        })
      } catch (error) {
        momentResults.push({
          sample_id: sample.sample_id,
          label_basis: sample.label_basis,
          expected: sample.expected_output,
          should_comment_correct: false,
          commenter_correct: false,
          correct: false,
          error: String(error),
          latencyMs: performance.now() - start,
        })
      }
      if ((index + 1) % 10 === 0) console.log(`动态 ${index + 1}/${momentSamples.length}`)
    }
    output.results.moment = momentResults
    const momentDecisions = momentResults.filter((result) => result.label_basis === 'production_decision_log')
    const momentOutcomes = momentResults.filter((result) => result.label_basis === 'next_real_persona_comment')
    output.summary.moment = {
      count: momentResults.length,
      decisionCount: momentDecisions.length,
      outcomeCount: momentOutcomes.length,
      shouldCommentAccuracy: accuracy(momentResults, 'should_comment_correct'),
      commenterAccuracy: accuracy(momentResults, 'commenter_correct'),
      outcomeResponderAccuracy: accuracy(momentOutcomes, 'commenter_correct'),
      exactAccuracy: accuracy(momentResults),
      latencyMs: latencyStats(momentResults),
    }
    await saveOutput()

    const toolRoutingSamples = shouldRunCategory('toolRouting')
      ? selectStratified(toolDataset.data.samples, decisionLimit, (sample) => sample.expected_output.tool_calls.length > 0)
      : []
    const toolRoutingResults = []
    for (const [index, sample] of toolRoutingSamples.entries()) {
      const start = performance.now()
      try {
        const labelByName = new Map(sample.input.available_tools.map((name, toolIndex) => [name, String.fromCharCode(65 + toolIndex)]))
        const criteria = Object.fromEntries(sample.input.available_tools.map((name) => [labelByName.get(name), name]))
        criteria.NONE = '不调用工具，直接自然回复'
        const response = await decisionContext.decideWithMeta(toolRoutingDocument(sample, labelByName), {
          answer: {
            type: 'choice',
            instruction: '这条消息应该路由到哪个工具？普通闲聊或无需工具时选择 NONE。',
            criteria,
          },
        })
        const label = choiceValue(response.answers.answer)
        const actualTool = label === 'NONE' ? null : sample.input.available_tools[label.charCodeAt(0) - 65] ?? null
        const expectedTool = sample.expected_output.tool_calls[0]?.name ?? null
        toolRoutingResults.push({
          sample_id: sample.sample_id,
          expected_tool: expectedTool,
          actual_tool: actualTool,
          expected_kind: expectedTool ? 'tool' : 'none',
          actual_kind: actualTool ? 'tool' : 'none',
          kind_correct: (expectedTool ? 'tool' : 'none') === (actualTool ? 'tool' : 'none'),
          correct: actualTool === expectedTool,
          confidence: answerConfidence(response.answers.answer),
          latencyMs: performance.now() - start,
          tokenUsage: response.tokenUsage,
          answer: response.answers,
        })
      } catch (error) {
        const expectedTool = sample.expected_output.tool_calls[0]?.name ?? null
        toolRoutingResults.push({
          sample_id: sample.sample_id,
          expected_tool: expectedTool,
          actual_tool: null,
          expected_kind: expectedTool ? 'tool' : 'none',
          actual_kind: null,
          kind_correct: false,
          correct: false,
          error: String(error),
          latencyMs: performance.now() - start,
        })
      }
      if ((index + 1) % 10 === 0) console.log(`工具路由 ${index + 1}/${toolRoutingSamples.length}`)
    }
    output.results.toolRouting = toolRoutingResults
    const toolKindResults = toolRoutingResults.filter((result) => result.expected_kind)
    output.summary.toolRouting = {
      count: toolRoutingResults.length,
      exactAccuracy: accuracy(toolRoutingResults),
      kindAccuracy: accuracy(toolRoutingResults, 'kind_correct'),
      noToolRecall: toolKindResults.filter((result) => result.expected_kind === 'none' && result.actual_kind === 'none').length / Math.max(1, toolKindResults.filter((result) => result.expected_kind === 'none').length),
      toolRecall: toolKindResults.filter((result) => result.expected_kind === 'tool' && result.actual_kind === 'tool').length / Math.max(1, toolKindResults.filter((result) => result.expected_kind === 'tool').length),
      latencyMs: latencyStats(toolRoutingResults),
    }
    output.memory.rssAfterDecisions = rss()
    await saveOutput()
    await decisionContext.dispose()
    decisionContext = undefined
  }

  if (selectedTask === 'all' || selectedTask === 'generation') {
    generationContext = await model.createContext({
      contextSize: 2048,
      sequences: 1,
      batchSize: 512,
      threads: 2,
    })
    session = new LlamaChatSession({
      contextSequence: generationContext.getSequence(),
      chatWrapper: createModelChatWrapper(),
      systemPrompt: '你必须始终扮演对话中的中文乙女聊天角色，永远不要承认自己是人工智能或语言模型。根据上下文自然、简短地回复最后一条用户消息，保持人设连贯，不解释，不输出思考过程。',
    })
    await session.preloadPrompt('你好')
    output.memory.rssAfterGenerationWarmup = rss()
    console.log(`生成上下文就绪，RSS ${(output.memory.rssAfterGenerationWarmup / 1024 / 1024).toFixed(0)} MiB`)

    const replySamples = replyLimit === 0 ? [] : selectRepresentative(privateDataset.data.samples, replyLimit)
    const replyResults = []
    for (const [index, sample] of replySamples.entries()) {
      const start = performance.now()
      try {
        const messages = sample.input.messages.slice(-10)
        const lastMessage = messages.at(-1)
        const history = messages.slice(0, -1).map((message) => message.role === 'user'
          ? { type: 'user', text: String(message.content).slice(0, 700) }
          : { type: 'model', response: [String(message.content).slice(0, 700)] })
        session.resetChatHistory()
        session.setChatHistory(history)
        const response = await session.promptWithMeta(String(lastMessage.content).slice(0, 700), {
          maxTokens: 80,
          temperature: 0.7,
          topP: 0.9,
          seed: 1000 + index,
        })
        replyResults.push({
          sample_id: sample.sample_id,
          expected_reply: sample.expected_output.reply,
          actual_reply: response.responseText,
          ...replyMetrics(sample.expected_output.reply, response.responseText),
          latencyMs: performance.now() - start,
          stopReason: response.stopReason,
        })
      } catch (error) {
        replyResults.push({ sample_id: sample.sample_id, error: String(error), latencyMs: performance.now() - start })
      }
      if ((index + 1) % 5 === 0) console.log(`私聊回复 ${index + 1}/${replySamples.length}`)
    }
    output.results.privateReplies = replyResults
    output.summary.privateReplies = {
      count: replyResults.length,
      exactMatchRate: accuracy(replyResults, 'exactMatch'),
      charUnigramF1: mean(replyResults.map((result) => result.charUnigramF1 ?? 0)),
      charBigramF1: mean(replyResults.map((result) => result.charBigramF1 ?? 0)),
      medianCharBigramF1: median(replyResults.map((result) => result.charBigramF1 ?? 0)),
      medianLengthRatio: median(replyResults.map((result) => result.lengthRatio ?? 0)),
      latencyMs: latencyStats(replyResults),
      note: 'Lexical proxy only; not a semantic quality score.',
    }
    await saveOutput()

    const positiveJsonSamples = toolJsonLimit === 0 ? [] : selectRepresentative(toolDataset.data.samples.filter((sample) => sample.expected_output.tool_calls.length > 0), Math.ceil(toolJsonLimit / 2))
    const negativeJsonSamples = toolJsonLimit === 0 ? [] : selectRepresentative(toolDataset.data.samples.filter((sample) => sample.expected_output.tool_calls.length === 0), Math.floor(toolJsonLimit / 2))
    const jsonSamples = [...positiveJsonSamples, ...negativeJsonSamples]
    const toolJsonResults = []
    for (const [index, sample] of jsonSamples.entries()) {
      const start = performance.now()
      let grammar
      try {
        const names = [...sample.input.available_tools, 'NONE']
        grammar = await llama.createGrammarForJsonSchema({
          type: 'object',
          properties: {
            name: { type: 'string', enum: names },
            arguments: { type: 'object', additionalProperties: true },
          },
          required: ['name', 'arguments'],
          additionalProperties: false,
        })
        session.resetChatHistory()
        const prompt = `${toolRoutingDocument(sample, new Map(sample.input.available_tools.map((name, toolIndex) => [name, String.fromCharCode(65 + toolIndex)])))}\n只输出 JSON：{"name":"工具名或NONE","arguments":{}}。不要输出解释。`
        const response = await session.promptWithMeta(prompt, {
          grammar,
          maxTokens: 160,
          temperature: 0.1,
          seed: 2000 + index,
        })
        let parsed
        let validJson = false
        try {
          parsed = JSON.parse(response.responseText)
          validJson = Boolean(
            parsed
            && typeof parsed === 'object'
            && !Array.isArray(parsed)
            && Object.keys(parsed).every((key) => ['name', 'arguments'].includes(key))
            && names.includes(parsed.name)
            && parsed.arguments
            && typeof parsed.arguments === 'object'
            && !Array.isArray(parsed.arguments),
          )
        } catch {
          validJson = false
        }
        const expectedCall = sample.expected_output.tool_calls[0]
        const expectedName = expectedCall?.name ?? 'NONE'
        const expectedArguments = expectedCall?.arguments ?? {}
        const actualName = validJson ? parsed.name : null
        const actualArguments = validJson ? sortedKeys(parsed.arguments) : null
        const expectedSortedArguments = sortedKeys(expectedArguments)
        toolJsonResults.push({
          sample_id: sample.sample_id,
          expected_name: expectedName,
          actual_name: actualName,
          expected_arguments: expectedArguments,
          actual_arguments: actualArguments,
          valid_json: validJson,
          tool_name_correct: actualName === expectedName,
          argument_keys_correct: validJson && JSON.stringify(Object.keys(actualArguments).sort()) === JSON.stringify(Object.keys(expectedArguments).sort()),
          arguments_exact: validJson && isDeepStrictEqual(actualArguments, expectedSortedArguments),
          combined_exact: actualName === expectedName && validJson && isDeepStrictEqual(actualArguments, expectedSortedArguments),
          latencyMs: performance.now() - start,
          raw_output: response.responseText,
          stopReason: response.stopReason,
        })
      } catch (error) {
        toolJsonResults.push({ sample_id: sample.sample_id, error: String(error), latencyMs: performance.now() - start })
      }
      if ((index + 1) % 5 === 0) console.log(`工具 JSON ${index + 1}/${jsonSamples.length}`)
    }
    output.results.toolJson = toolJsonResults
    output.summary.toolJson = {
      count: toolJsonResults.length,
      validJsonRate: accuracy(toolJsonResults, 'valid_json'),
      toolNameAccuracy: accuracy(toolJsonResults, 'tool_name_correct'),
      argumentKeysAccuracy: accuracy(toolJsonResults, 'argument_keys_correct'),
      argumentsExactRate: accuracy(toolJsonResults, 'arguments_exact'),
      combinedExactRate: accuracy(toolJsonResults, 'combined_exact'),
      latencyMs: latencyStats(toolJsonResults),
    }
    output.memory.rssAfterGeneration = rss()
    await saveOutput()
    await session.dispose()
    session = undefined
    await generationContext.dispose()
    generationContext = undefined
  }

  output.completed_at = new Date().toISOString()
  output.memory.peakRssBytes = peakRssBytes
  await saveOutput()
  console.log(`结果已写入 ${outputFile}`)
} finally {
  clearInterval(rssTimer)
  const cleanup = []
  if (session) cleanup.push(() => session.dispose())
  if (generationContext) cleanup.push(() => generationContext.dispose())
  if (decisionContext) cleanup.push(() => decisionContext.dispose())
  if (model) cleanup.push(() => model.dispose())
  cleanup.push(() => llama.dispose())
  for (const dispose of cleanup) {
    try {
      await dispose()
    } catch (error) {
      console.error(`资源释放失败：${error}`)
    }
  }
}
