import fs from 'node:fs/promises'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { GeneralChatWrapper, getLlama, LlamaChatSession, QwenChatWrapper, resolveChatWrapper } from 'node-llama-cpp'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const resultsDir = path.join(root, 'datasets', 'results')
const modelFiles = [
  { name: 'Qwen3.5-0.8B-Q4_K_M', file: 'Qwen3.5-0.8B-Q4_K_M.gguf' },
  { name: 'Qwen3.5-2B-Q4_K_M', file: 'Qwen3.5-2B-Q4_K_M.gguf' },
  { name: 'Qwen3-4B-Instruct-2507-Q6_K', file: 'Qwen3-4B-Instruct-2507-Q6_K.gguf' },
]

const cases = [
  {
    id: 'push-01',
    category: '主动推送',
    document: '时间：工作日 10:00。用户昨晚说“今天加班，别吵我”。角色没有新消息，也不存在紧急事件。',
    expected: false,
    question: {
      type: 'noul',
      instruction: '角色现在是否适合主动给用户发消息？',
      criteria: { true: '适合主动发消息', false: '不适合，应等用户主动联系' },
    },
  },
  {
    id: 'push-02',
    category: '主动推送',
    document: '时间：工作日 18:30。用户昨天说“等我下班”。用户平时下班后会主动分享晚餐，角色今晚有想分享的新鲜事。',
    expected: true,
    question: {
      type: 'noul',
      instruction: '角色现在是否适合主动给用户发消息？',
      criteria: { true: '适合主动发消息', false: '不适合，应继续等待' },
    },
  },
  {
    id: 'push-03',
    category: '主动推送',
    document: '时间：凌晨 01:20。用户已经睡觉，角色没有紧急事件，只是想聊天。',
    expected: false,
    question: {
      type: 'noul',
      instruction: '角色现在是否适合主动给用户发消息？',
      criteria: { true: '适合主动发消息', false: '不适合，应避免打扰' },
    },
  },
  {
    id: 'push-04',
    category: '主动推送',
    document: '时间：晚上 21:00。用户刚才说“你最近怎么都不理我”，语气有些委屈。角色与用户关系亲密，也想表达在意。',
    expected: true,
    question: {
      type: 'noul',
      instruction: '角色现在是否适合主动给用户发消息？',
      criteria: { true: '适合主动发消息', false: '不适合，应继续等待' },
    },
  },
  {
    id: 'push-05',
    category: '主动推送',
    document: '时间：考试周周三。用户明确说“这周别打扰我，等我考完”。角色没有紧急事件。',
    expected: false,
    question: {
      type: 'noul',
      instruction: '角色现在是否适合主动给用户发消息？',
      criteria: { true: '适合主动发消息', false: '不适合，应尊重用户边界' },
    },
  },
  {
    id: 'push-06',
    category: '主动推送',
    document: '时间：用户生日当天 08:00。用户昨天提过今天想过得安静一些，角色准备了生日祝福，没有邀请第三方。',
    expected: true,
    question: {
      type: 'noul',
      instruction: '角色现在是否适合主动给用户发消息？',
      criteria: { true: '适合主动发消息', false: '不适合，应继续等待' },
    },
  },
  {
    id: 'group-01',
    category: '群聊接话',
    document: '群聊中用户 @林晚 问“周末去看展吗？”林晚之前多次表达想去看这个展。周屿和许知没有接话，也没有相关兴趣。',
    expected: 'A',
    question: {
      type: 'choice',
      instruction: '群里下一句由谁接最自然？',
      criteria: {
        A: '林晚：被用户直接 @，且对展览有明显兴趣',
        B: '周屿：没有表现出相关兴趣',
        C: '许知：没有表现出相关兴趣',
        D: '暂不接话：当前不需要角色继续发言',
      },
    },
  },
  {
    id: 'group-02',
    category: '群聊接话',
    document: '群里大家在讨论火锅。周屿刚说“我订好位置了”，随后有人问“几点开吃？”。林晚和许知没有掌握时间信息。',
    expected: 'A',
    question: {
      type: 'choice',
      instruction: '群里下一句由谁接最自然？',
      criteria: {
        A: '周屿：刚订好位置，掌握开吃时间',
        B: '林晚：没有掌握时间信息',
        C: '许知：没有掌握时间信息',
        D: '暂不接话：当前不需要角色继续发言',
      },
    },
  },
  {
    id: 'group-03',
    category: '群聊接话',
    document: '深夜群里有人发“睡了”，随后没有人再说话。角色没有未回复的 @，也没有必须补充的信息。',
    expected: 'D',
    question: {
      type: 'choice',
      instruction: '群里下一句由谁接最自然？',
      criteria: {
        A: '林晚接话',
        B: '周屿接话',
        C: '许知接话',
        D: '暂不接话：让群聊自然结束',
      },
    },
  },
  {
    id: 'group-04',
    category: '群聊接话',
    document: '用户发了一张流浪猫照片。许知是坚定的猫派，之前还问过“后来那只小猫怎样了”。林晚和周屿没有特别反应。',
    expected: 'C',
    question: {
      type: 'choice',
      instruction: '群里下一句由谁接最自然？',
      criteria: {
        A: '林晚接话',
        B: '周屿接话',
        C: '许知接话：喜欢猫且之前关注过这只猫',
        D: '暂不接话：当前不需要角色继续发言',
      },
    },
  },
  {
    id: 'tone-01',
    category: '情绪判断',
    document: '用户说：“你根本不在乎我。”上下文显示用户期待角色回复，但角色隔了很久才回答，用户语气明显难过。',
    expected: 2,
    question: {
      type: 'score',
      instruction: '用户这句话的情绪强度有多高？',
      criteria: ['平静或中性', '轻微不快', '明显难过、生气或受伤'],
    },
  },
  {
    id: 'tone-02',
    category: '情绪判断',
    document: '用户说：“哈哈，你居然记得我之前随口说过的话，有点开心。”',
    expected: 0,
    question: {
      type: 'score',
      instruction: '用户这句话的情绪强度有多高？',
      criteria: ['平静或中性', '轻微情绪波动', '明显情绪波动'],
    },
  },
  {
    id: 'tool-01',
    category: '工具路由',
    document: '用户说：“提醒我明天早上七点开会，别迟到。”当前没有同名提醒，用户权限允许创建提醒。',
    expected: 'A',
    question: {
      type: 'choice',
      instruction: '这句话应该路由到哪个工具？',
      criteria: {
        A: '创建提醒：设置明天 07:00 的会议提醒',
        B: '更新角色生活状态：与提醒无关',
        C: '不调用工具：信息不足或无需工具',
      },
    },
  },
  {
    id: 'tool-02',
    category: '工具路由',
    document: '用户说：“我今天有点累，想安静待着。”用户没有要求创建提醒、查询信息或修改日程。',
    expected: 'C',
    question: {
      type: 'choice',
      instruction: '这句话应该路由到哪个工具？',
      criteria: {
        A: '创建提醒',
        B: '更新角色生活状态',
        C: '不调用工具：只需自然回应',
      },
    },
  },
]

const repeat = Math.max(1, Number(process.argv[3] ?? 2))
const selectedModel = process.argv[2]
const selectedModels = selectedModel
  ? modelFiles.filter((model) => model.name.includes(selectedModel))
  : modelFiles

if (selectedModels.length === 0)
  throw new Error(`未找到模型：${selectedModel}`)
const outputFile = path.join(
  resultsDir,
  selectedModels.length === 1 && selectedModels[0].file === 'Qwen3-4B-Instruct-2507-Q6_K.gguf'
    ? 'results-qwen3-4b.json'
    : 'results.json',
)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))]
}

function normalizeAnswer(answer) {
  if (answer.type === 'noul')
    return answer.value >= 0.5
  if (answer.type === 'choice')
    return answer.choice
  if (answer.type === 'score')
    return Math.round(answer.score)
  return undefined
}

function answerConfidence(answer) {
  if (answer.type === 'noul')
    return Math.max(answer.value, 1 - answer.value)
  return answer.confidence
}

async function runModel(llama, modelInfo) {
  const modelPath = path.join(root, 'models', modelInfo.file)
  console.log(`\n=== ${modelInfo.name} ===`)
  const loadStart = performance.now()
  const model = await llama.loadModel({ modelPath })
  const loadMs = performance.now() - loadStart
  const createChatWrapper = () => modelInfo.file.startsWith('Qwen3.5-')
    ? new QwenChatWrapper({ variation: '3.5', thoughts: 'discourage' })
    : resolveChatWrapper(model, { warningLogs: false }) ?? new GeneralChatWrapper()

  const decisionContext = await model.createDecisionContext({
    chatWrapper: createChatWrapper(),
    contextSize: 4096,
    batchSize: 512,
    parallelQuestions: 2,
    threads: 2,
  })
  await decisionContext.warmup()
  const rssAfterWarmup = process.memoryUsage().rss

  const results = []
  for (const testCase of cases) {
    const runs = []
    for (let runIndex = 0; runIndex < repeat; runIndex++) {
      const start = performance.now()
      const response = await decisionContext.decideWithMeta(testCase.document, {
        answer: testCase.question,
      })
      runs.push({
        latencyMs: performance.now() - start,
        answer: response.answers.answer,
        tokenUsage: response.tokenUsage,
      })
    }
    const answer = runs.at(-1).answer
    const actual = normalizeAnswer(answer)
    const correct = actual === testCase.expected
    const result = {
      id: testCase.id,
      category: testCase.category,
      expected: testCase.expected,
      actual,
      correct,
      confidence: answerConfidence(answer),
      medianLatencyMs: median(runs.map((run) => run.latencyMs)),
      tokenUsage: runs.at(-1).tokenUsage,
      answer,
    }
    results.push(result)
    console.log(`${correct ? 'OK' : 'FAIL'} ${testCase.id} expected=${JSON.stringify(testCase.expected)} actual=${JSON.stringify(actual)} p=${result.confidence.toFixed(3)} ${result.medianLatencyMs.toFixed(0)}ms`)
  }

  const concurrencyCases = cases.slice(0, 4)
  const concurrencyStart = performance.now()
  const concurrencyRuns = await Promise.all(concurrencyCases.map(async (testCase) => {
    const start = performance.now()
    const response = await decisionContext.decideWithMeta(testCase.document, {
      answer: testCase.question,
    })
    const answer = response.answers.answer
    return {
      id: testCase.id,
      latencyMs: performance.now() - start,
      correct: normalizeAnswer(answer) === testCase.expected,
    }
  }))
  const concurrency = {
    requests: concurrencyRuns.length,
    slots: 2,
    wallMs: performance.now() - concurrencyStart,
    latencyMs: {
      p50: median(concurrencyRuns.map((run) => run.latencyMs)),
      p95: percentile(concurrencyRuns.map((run) => run.latencyMs), 0.95),
      max: Math.max(...concurrencyRuns.map((run) => run.latencyMs)),
    },
    correct: concurrencyRuns.filter((run) => run.correct).length,
    runs: concurrencyRuns,
  }
  console.log(`并发 4 请求/2 槽：wall=${concurrency.wallMs.toFixed(0)}ms p95=${concurrency.latencyMs.p95.toFixed(0)}ms`)

  const decisionMemory = decisionContext.memoryUsage
  await decisionContext.dispose()

  const context = await model.createContext({
    contextSize: 2048,
    sequences: 1,
    batchSize: 512,
    threads: 2,
  })
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    chatWrapper: createChatWrapper(),
    systemPrompt: '你是乙女聊天角色林晚，温柔、敏锐、有一点克制。请用自然中文回复用户，不要解释，不要输出思考过程。',
  })
  const generationStart = performance.now()
  const reply = await session.prompt('你今天是不是又把我忘了？', {
    maxTokens: 120,
    temperature: 0.7,
    topP: 0.9,
  })
  const generationMs = performance.now() - generationStart
  console.log(`回复：${reply}`)

  const summary = {
    model: modelInfo.name,
    modelFile: modelInfo.file,
    loadMs,
    correct: results.filter((result) => result.correct).length,
    total: results.length,
    accuracy: results.filter((result) => result.correct).length / results.length,
    decisionLatencyMs: {
      p50: median(results.map((result) => result.medianLatencyMs)),
      p95: percentile(results.map((result) => result.medianLatencyMs), 0.95),
    },
    decisionMemory,
    rssAfterWarmup,
    concurrency,
    generationMs,
    reply,
    results,
  }

  await session.dispose()
  await context.dispose()
  await model.dispose()
  return summary
}

const llama = await getLlama({
  gpu: false,
  build: 'never',
  maxThreads: 2,
  logLevel: 'error',
})

try {
  const summaries = []
  for (const modelInfo of selectedModels)
    summaries.push(await runModel(llama, modelInfo))

  const output = {
    createdAt: new Date().toISOString(),
    runtime: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      maxThreads: 2,
      contextSize: 4096,
      parallelQuestions: 2,
      repeat,
    },
    summaries,
  }
  await fs.mkdir(resultsDir, { recursive: true })
  await fs.writeFile(outputFile, JSON.stringify(output, null, 2), 'utf8')
  console.log('\n=== 汇总 ===')
  for (const summary of summaries) {
    console.log(`${summary.model}: ${summary.correct}/${summary.total} (${(summary.accuracy * 100).toFixed(1)}%), p50=${summary.decisionLatencyMs.p50.toFixed(0)}ms, p95=${summary.decisionLatencyMs.p95.toFixed(0)}ms, concurrentWall=${summary.concurrency.wallMs.toFixed(0)}ms, reply=${summary.generationMs.toFixed(0)}ms`)
  }
  console.log(`结果已写入 ${outputFile}`)
} finally {
  await llama.dispose()
}
