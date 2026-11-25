require('dotenv').config()
const http = require('node:http')
const https = require('node:https')
const crypto = require('node:crypto')
const dns = require('node:dns')
const net = require('node:net')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { pipeline } = require('node:stream/promises')
const Busboy = require('busboy')

const projectRoot = __dirname
const port = Number(process.env.PORT || 25682)
const host = process.env.HOST || '0.0.0.0'
const threads = Number(process.env.THREADS || 2)
const contextSize = Number(process.env.CONTEXT_SIZE || 2048)
let maxConcurrency = Number(process.env.MAX_CONCURRENCY || 1)
const maxConcurrencyLimit = 8
const maxQueue = Number(process.env.MAX_QUEUE || 8)
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 120000)
const maxBodyBytes = Number(process.env.MAX_BODY_BYTES || 1048576)
const modelDir = path.resolve(process.env.MODEL_DIR || path.join(projectRoot, 'models'))
const legacyModelPath = path.resolve(process.env.MODEL_PATH || path.join(modelDir, 'Qwen3.5-2B-Q4_K_M.gguf'))
let defaultModelId = process.env.DEFAULT_MODEL || process.env.MODEL_ID || path.basename(legacyModelPath)
let configuredHotModel = (process.env.HOT_MODEL || '').trim()
const modelIdleTimeoutMs = Number(process.env.MODEL_IDLE_TIMEOUT_MS || 300000)
const modelLoadTimeoutMs = Number(process.env.MODEL_LOAD_TIMEOUT_MS || 300000)
const maxModelBytes = Number(process.env.MAX_MODEL_BYTES || 20 * 1024 ** 3)
const modelMemoryOverheadMb = Number(process.env.MODEL_MEMORY_OVERHEAD_MB || 1536)
const memoryLimitMb = Number(process.env.MEMORY_LIMIT_MB || 0)
const allowPrivateModelUrls = process.env.MODEL_PULL_ALLOW_PRIVATE === 'true'
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || 'http://se1.nodaroo.fun:25682').replace(/\/+$/, '')
const apiKey = process.env.API_KEY || `sk-${crypto.randomBytes(24).toString('hex')}`
const adminKey = process.env.ADMIN_KEY || apiKey
const adminDownloadCookie = crypto.createHmac('sha256', adminKey).update('rea-admin-download-v1').digest('hex')
const usageFile = path.join(projectRoot, 'usage.json')
const modelLinksFile = path.resolve(process.env.MODEL_LINKS_FILE || path.join(projectRoot, 'config', 'models.config.json'))
const workerPath = path.join(projectRoot, 'workers', 'inference-worker.js')
const defaultModelLinks = [
  {
    id: 'Qwen3.5-0.8B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_K_M.gguf?download=true',
    enabled: true,
    sizeBytes: 532517120,
    sha256: 'bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517',
  },
  {
    id: 'Qwen3.5-2B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-2B-GGUF/resolve/main/Qwen3.5-2B-Q4_K_M.gguf?download=true',
    enabled: true,
    sizeBytes: 1280835840,
    sha256: 'aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223',
  },
  {
    id: 'Qwen3-4B-Instruct-2507-Q6_K.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q6_K.gguf?download=true',
    enabled: true,
    sizeBytes: 3306261600,
    sha256: 'cd7b21b38b3e71400587c184b6a9b04d3beb4d13fdae6464d4075dee4f1bc5ad',
  },
]
const defaultSystemPrompt = '你是一个乐于助人的中文助手。回答简洁、准确。'
const keepAliveEnabled = process.env.KEEP_ALIVE_ENABLED !== 'false'
const keepAliveIntervalMs = Number(process.env.KEEP_ALIVE_INTERVAL_MS || 300000)
const keepAliveUrl = process.env.KEEP_ALIVE_URL || `${publicBaseUrl}/health`

for (const [name, value] of Object.entries({ port, threads, contextSize, maxQueue, requestTimeoutMs, maxBodyBytes, modelIdleTimeoutMs, modelLoadTimeoutMs, maxModelBytes, modelMemoryOverheadMb, keepAliveIntervalMs })) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`)
}
if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > maxConcurrencyLimit) {
  throw new Error(`MAX_CONCURRENCY 必须是 1–${maxConcurrencyLimit} 的整数`)
}
if (!Number.isInteger(memoryLimitMb) || memoryLimitMb < 0) throw new Error('MEMORY_LIMIT_MB 必须是非负整数')

class HttpError extends Error {
  constructor(status, message, code, param) {
    super(message)
    this.status = status
    this.code = code
    this.param = param
  }
}

function emptyStats() {
  return {
    totals: {
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      promptTokens: 0,
      completionTokens: 0,
    },
    daily: {},
    recent: [],
    modelUsage: {},
  }
}

function loadStats() {
  try {
    const saved = JSON.parse(fsSync.readFileSync(usageFile, 'utf8'))
    const recent = Array.isArray(saved.recent) ? saved.recent.slice(0, 100) : []
    const modelUsage = {}
    if (saved.modelUsage && typeof saved.modelUsage === 'object') {
      for (const [model, count] of Object.entries(saved.modelUsage)) {
        if (Number.isInteger(count) && count > 0) modelUsage[model] = count
      }
    } else {
      for (const item of recent) {
        if (item.status === 'success' && item.model) modelUsage[item.model] = (modelUsage[item.model] || 0) + 1
      }
    }
    return {
      totals: { ...emptyStats().totals, ...saved.totals },
      daily: saved.daily && typeof saved.daily === 'object' ? saved.daily : {},
      recent,
      modelUsage,
    }
  } catch {
    return emptyStats()
  }
}

const stats = loadStats()
let persistQueue = Promise.resolve()
let modelLinksWriteQueue = Promise.resolve()
let adminHtml
let server
const runtimes = new Map()
let idleTimer = null
let heartbeatTimer = null
let resourceTimer = null
let uploadInProgress = false
let pullInProgress = false
let modelTransfer = null
let hotModelId = configuredHotModel || null
let hotModelPinned = Boolean(configuredHotModel)
let shuttingDown = false
let activeRequests = 0
let queuedRequests = 0
let queueTail = Promise.resolve()
const taskQueue = []
const blockedModels = new Set()
const maintenanceCounts = new Map()
const maintenanceTails = new Map()
let cpuPrevious = null
let cpuUsage = { totalPercent: 0, perCore: [] }
const heartbeat = {
  enabled: keepAliveEnabled,
  url: keepAliveUrl,
  intervalMs: keepAliveIntervalMs,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastError: null,
  consecutiveFailures: 0,
}

function persistStats() {
  const snapshot = `${JSON.stringify(stats, null, 2)}\n`
  persistQueue = persistQueue
    .then(() => fs.writeFile(usageFile, snapshot, 'utf8'))
    .catch((error) => console.error('用量统计写入失败：', error.message))
  return persistQueue
}

function recordRequest(entry) {
  stats.totals.requests += 1
  if (entry.status === 'success') stats.totals.successfulRequests += 1
  else stats.totals.failedRequests += 1
  stats.totals.promptTokens += entry.promptTokens
  stats.totals.completionTokens += entry.completionTokens
  if (entry.status === 'success' && entry.model) {
    stats.modelUsage[entry.model] = (stats.modelUsage[entry.model] || 0) + 1
    promoteHotModel(entry.model)
  }

  const day = entry.timestamp.slice(0, 10)
  const daily = stats.daily[day] || { requests: 0, successfulRequests: 0, promptTokens: 0, completionTokens: 0 }
  daily.requests += 1
  if (entry.status === 'success') daily.successfulRequests += 1
  daily.promptTokens += entry.promptTokens
  daily.completionTokens += entry.completionTokens
  stats.daily[day] = daily

  stats.recent.unshift(entry)
  stats.recent = stats.recent.slice(0, 100)
  persistStats()
}

function applyHeaders(res, extra = {}) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Api-Key')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  for (const [name, value] of Object.entries(extra)) res.setHeader(name, value)
}

function sendJson(res, status, payload, extra = {}) {
  applyHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra })
  res.writeHead(status)
  res.end(JSON.stringify(payload))
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function requireAuth(req, expectedKey) {
  const authorization = req.headers.authorization || ''
  const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
  const provided = bearer || req.headers['x-api-key'] || ''
  if (!provided || !safeEqual(provided, expectedKey)) {
    throw new HttpError(401, 'API Key 无效或缺失', 'invalid_api_key')
  }
}

function sendError(res, error) {
  const status = error instanceof HttpError ? error.status : 500
  const message = error instanceof HttpError ? error.message : '推理服务异常，请查看服务日志'
  const code = error instanceof HttpError ? error.code : 'internal_error'

  if (!(error instanceof HttpError)) console.error(error)

  if (res.headersSent) {
    if (String(res.getHeader('Content-Type') || '').includes('text/event-stream') && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: { message, type: 'server_error', code } })}\n\n`)
      res.end('data: [DONE]\n\n')
    } else if (!res.destroyed) {
      res.destroy()
    }
    return
  }

  const headers = status === 401 ? { 'WWW-Authenticate': 'Bearer' } : {}
  if (status === 429) headers['Retry-After'] = '5'
  sendJson(res, status, { error: { message, type: status === 429 ? 'rate_limit_error' : 'invalid_request_error', param: error.param, code } }, headers)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBodyBytes) throw new HttpError(413, '请求体过大', 'request_too_large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new HttpError(400, '请求体不能为空', 'invalid_json')
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON', 'invalid_json')
  }
}

function runTask(task) {
  activeRequests += 1
  return (async () => {
    try {
      return await task()
    } finally {
      activeRequests -= 1
      scheduleIdleUnload()
      drainQueue()
    }
  })()
}

function drainQueue() {
  while (activeRequests < maxConcurrency && taskQueue.length > 0) {
    const item = taskQueue.shift()
    queuedRequests -= 1
    runTask(item.task).then(item.resolve, item.reject)
  }
}

function enqueue(task) {
  if (shuttingDown) throw new HttpError(503, '服务正在关闭', 'service_unavailable')
  let result
  if (activeRequests < maxConcurrency) {
    result = runTask(task)
  } else {
    if (queuedRequests >= maxQueue) throw new HttpError(429, '推理队列已满，请稍后重试', 'queue_full')
    queuedRequests += 1
    result = new Promise((resolve, reject) => taskQueue.push({ task, resolve, reject }))
  }
  queueTail = Promise.allSettled([queueTail, result]).then(() => {})
  return result
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('')
}

function validateChatRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_request')
  }
  if (body.model !== undefined && (typeof body.model !== 'string' || body.model.length === 0)) {
    throw new HttpError(400, 'model 必须是非空字符串', 'invalid_value', 'model')
  }
  if (body.n !== undefined && body.n !== 1) {
    throw new HttpError(400, '当前仅支持 n=1', 'unsupported_value', 'n')
  }
  if (body.tools !== undefined || body.functions !== undefined) {
    throw new HttpError(400, '当前服务暂不支持 OpenAI tools/functions 调用', 'unsupported_value', 'tools')
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 64) {
    throw new HttpError(400, 'messages 必须是 1–64 条消息的数组', 'invalid_messages', 'messages')
  }

  const messages = body.messages.map((message, index) => {
    if (!message || !['system', 'user', 'assistant'].includes(message.role)) {
      throw new HttpError(400, `messages[${index}].role 无效`, 'invalid_role', `messages[${index}].role`)
    }
    const text = contentToText(message.content)
    if (!text.trim() && message.role === 'user') {
      throw new HttpError(400, `messages[${index}].content 不能为空`, 'invalid_content', `messages[${index}].content`)
    }
    return { role: message.role, text }
  })

  if (messages.at(-1).role !== 'user') {
    throw new HttpError(400, '最后一条消息必须是 user', 'invalid_messages', 'messages')
  }

  const maxTokens = body.max_tokens ?? 256
  const temperature = body.temperature ?? 0.7
  const topP = body.top_p ?? 0.9
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 1024) {
    throw new HttpError(400, 'max_tokens 必须是 1–1024 的整数', 'invalid_value', 'max_tokens')
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    throw new HttpError(400, 'temperature 必须在 0–2 之间', 'invalid_value', 'temperature')
  }
  if (!Number.isFinite(topP) || topP < 0 || topP > 1) {
    throw new HttpError(400, 'top_p 必须在 0–1 之间', 'invalid_value', 'top_p')
  }
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) {
    throw new HttpError(400, 'seed 必须是整数', 'invalid_value', 'seed')
  }
  if (body.stream !== undefined && typeof body.stream !== 'boolean') {
    throw new HttpError(400, 'stream 必须是布尔值', 'invalid_value', 'stream')
  }

  let stop = []
  if (typeof body.stop === 'string') stop = [body.stop]
  else if (Array.isArray(body.stop)) stop = body.stop
  else if (body.stop !== undefined && body.stop !== null) {
    throw new HttpError(400, 'stop 必须是字符串或字符串数组', 'invalid_value', 'stop')
  }
  if (stop.length > 4 || stop.some((item) => typeof item !== 'string' || item.length === 0)) {
    throw new HttpError(400, 'stop 最多支持 4 个非空字符串', 'invalid_value', 'stop')
  }

  const systemPrompt = messages.filter((message) => message.role === 'system').map((message) => message.text).join('\n\n') || defaultSystemPrompt
  const history = messages.slice(0, -1)
    .filter((message) => message.role !== 'system')
    .map((message) => message.role === 'user'
      ? { type: 'user', text: message.text }
      : { type: 'model', response: [message.text] })

  return {
    model: body.model,
    systemPrompt,
    history,
    prompt: messages.at(-1).text,
    maxTokens,
    temperature,
    topP,
    seed: body.seed,
    stop,
    stream: body.stream === true,
    includeUsage: body.stream_options?.include_usage === true,
  }
}

async function scanModels() {
  const entries = await fs.readdir(modelDir, { withFileTypes: true })
  const models = []
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.gguf') continue
    const filePath = path.join(modelDir, entry.name)
    try {
      const stat = await fs.stat(filePath)
      const createdMs = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs
      models.push({
        id: entry.name,
        name: path.basename(entry.name, path.extname(entry.name)),
        file: entry.name,
        path: filePath,
        sizeBytes: stat.size,
        createdAt: new Date(createdMs).toISOString(),
        modifiedAt: stat.mtime.toISOString(),
      })
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return models.sort((left, right) => left.id.localeCompare(right.id, 'zh-CN', { numeric: true }))
}

function findModelInList(models, id) {
  const exact = models.find((item) => item.id === id || item.name === id)
  if (exact) return exact
  const lowered = id.toLowerCase()
  const matches = models.filter((item) => item.id.toLowerCase() === lowered || item.name.toLowerCase() === lowered)
  return matches.length === 1 ? matches[0] : null
}

async function resolveModel(id) {
  const models = await scanModels()
  return findModelInList(models, id)
}

async function selectModel(id) {
  const models = await scanModels()
  if (id !== undefined) {
    const selected = findModelInList(models, id)
    if (!selected) throw new HttpError(404, `模型不存在：${id}`, 'model_not_found', 'model')
    return selected
  }
  if (models.length === 0) throw new HttpError(503, '模型目录为空，请先上传 GGUF 模型', 'no_models')
  return findModelInList(models, defaultModelId) ?? models[0]
}

function preferredHotModel(models) {
  if (hotModelPinned) return findModelInList(models, configuredHotModel) || null
  const ranked = Object.entries(stats.modelUsage)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'))
  for (const [id] of ranked) {
    const entry = findModelInList(models, id)
    if (entry) return entry
  }
  if (hotModelId) {
    const current = findModelInList(models, hotModelId)
    if (current) return current
  }
  return findModelInList(models, defaultModelId) ?? models[0] ?? null
}

function promoteHotModel(modelId) {
  if (hotModelPinned || !modelId || modelId === hotModelId) return
  const currentCount = stats.modelUsage[hotModelId] || 0
  if (!hotModelId || (stats.modelUsage[modelId] || 0) > currentCount) {
    hotModelId = modelId
    console.log(`热启动模型自动切换为 ${modelId}`)
    scheduleIdleUnload()
  }
}

async function warmHotModel() {
  const models = await scanModels()
  let entry = preferredHotModel(models)
  if (!entry && hotModelPinned) {
    console.error(`HOT_MODEL 指定的模型不存在：${configuredHotModel}，改为自动选择`)
    hotModelPinned = false
    hotModelId = null
    entry = preferredHotModel(models)
  }
  if (!entry) return
  hotModelId = entry.id
  try {
    await enqueue(async () => {
      const existing = [...runtimes.values()].find((state) => state.entry.id === entry.id && !state.stopping)
      if (existing) return existing.loadPromise
      return ensureRuntime(entry)
    })
    console.log(`热启动模型 ${entry.id} 已常驻，空闲回收会自动跳过`)
  } catch (error) {
    console.error(`热启动模型 ${entry.id} 预热失败：${error.message}`)
  }
}

function serializeModel(entry) {
  const current = [...runtimes.values()].filter((state) => state.entry.id === entry.id && !state.stopping)
  const latest = current.sort((left, right) => (right.lastUsedAt || 0) - (left.lastUsedAt || 0))[0]
  return {
    id: entry.id,
    name: entry.name,
    file: entry.file,
    sizeBytes: entry.sizeBytes,
    createdAt: entry.createdAt,
    modifiedAt: entry.modifiedAt,
    status: current.length === 0 ? 'unloaded' : current.some((state) => !state.loaded) ? 'loading' : 'loaded',
    loadedAt: latest?.loadedAt || null,
    lastUsedAt: latest?.lastUsedAt ? new Date(latest.lastUsedAt).toISOString() : null,
    contextSize: current.length > 0 ? contextSize : null,
    instanceCount: current.length,
    isHot: entry.id === hotModelId,
    usageCount: stats.modelUsage[entry.id] || 0,
  }
}

function formatByteSize(bytes) {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}

function getMemoryLimitBytes() {
  if (memoryLimitMb > 0) return memoryLimitMb * 1024 ** 2
  if (typeof process.constrainedMemory === 'function') {
    try {
      const constrained = process.constrainedMemory()
      if (Number.isFinite(constrained) && constrained > 0) return constrained
    } catch {}
  }
  return os.totalmem()
}

function sampleCpu() {
  const cpus = os.cpus()
  const current = cpus.map((cpu) => {
    const times = Object.values(cpu.times).reduce((total, value) => total + value, 0)
    return { total: times, idle: cpu.times.idle }
  })
  if (cpuPrevious && cpuPrevious.cpus.length === current.length) {
    const perCore = current.map((cpu, index) => {
      const previous = cpuPrevious.cpus[index]
      const totalDelta = cpu.total - previous.total
      const idleDelta = cpu.idle - previous.idle
      return totalDelta > 0 ? Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) : 0
    })
    const total = perCore.reduce((sum, value) => sum + value, 0)
    cpuUsage = { totalPercent: total / perCore.length, perCore }
  } else {
    cpuUsage = { totalPercent: 0, perCore: current.map(() => 0) }
  }
  cpuPrevious = { cpus: current }
}

function startResourceMonitor() {
  sampleCpu()
  resourceTimer = setInterval(sampleCpu, 1000)
  resourceTimer.unref()
}

async function getSystemResources(modelBytes) {
  const totalMemoryBytes = os.totalmem()
  const freeMemoryBytes = os.freemem()
  const runtimeRssBytes = [...runtimes.values()].reduce((total, state) => total + (state.stats?.rssBytes || 0), 0)
  let disk = null
  try {
    const stat = await fs.statfs(modelDir)
    const totalBytes = stat.bsize * stat.blocks
    const freeBytes = stat.bsize * stat.bavail
    disk = {
      path: modelDir,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
      modelBytes,
    }
  } catch {}

  const loadAverage = os.loadavg()
  return {
    sampledAt: new Date().toISOString(),
    cpu: {
      usagePercent: cpuUsage.totalPercent,
      cores: os.cpus().length,
      perCore: cpuUsage.perCore,
      loadAverage,
      loadPercent: os.cpus().length > 0 ? loadAverage[0] / os.cpus().length * 100 : 0,
    },
    memory: {
      totalBytes: totalMemoryBytes,
      freeBytes: freeMemoryBytes,
      usedBytes: Math.max(0, totalMemoryBytes - freeMemoryBytes),
      processBytes: process.memoryUsage().rss,
      runtimeBytes: runtimeRssBytes,
      limitBytes: getMemoryLimitBytes(),
    },
    disk,
  }
}

function assertModelFits(entry) {
  const limit = getMemoryLimitBytes()
  const overhead = modelMemoryOverheadMb * 1024 ** 2
  if (entry.sizeBytes + overhead > limit) {
    throw new HttpError(
      400,
      `模型文件 ${formatByteSize(entry.sizeBytes)} 加上运行预留 ${formatByteSize(overhead)} 超过内存上限 ${formatByteSize(limit)}，已阻止加载`,
      'model_too_large',
      'model',
    )
  }
}

function assertPoolFits(entry) {
  const limit = getMemoryLimitBytes()
  const overhead = modelMemoryOverheadMb * 1024 ** 2
  const residentBytes = [...runtimes.values()]
    .filter((state) => !state.stopping)
    .reduce((total, state) => total + state.entry.sizeBytes + overhead, 0)
  if (residentBytes + entry.sizeBytes + overhead > limit) {
    throw new HttpError(
      429,
      `按当前并发驻留估算需要 ${formatByteSize(residentBytes + entry.sizeBytes + overhead)}，超过内存上限 ${formatByteSize(limit)}，请降低并发或先卸载模型`,
      'memory_budget_exceeded',
      'model',
    )
  }
}

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function settleLoad(state, error, result) {
  if (state.loadSettled) return
  state.loadSettled = true
  clearTimeout(state.loadTimer)
  if (error) state.rejectLoad(error)
  else state.resolveLoad(result)
}

function settlePending(state, error, result) {
  const pending = state.pending
  if (!pending) return
  state.pending = null
  clearTimeout(pending.cancelTimer)
  pending.signal.removeEventListener('abort', pending.onAbort)
  if (error) pending.reject(error)
  else pending.resolve(result)
}

function errorFromWorker(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500
  if (status >= 500) console.error('推理子进程错误：', error?.message || error)
  return new HttpError(status, error?.message || '推理失败', error?.code || 'inference_error', error?.param)
}

function failRuntime(state, error) {
  settleLoad(state, error)
  settlePending(state, error)
  if (runtimes.get(state.id) === state) runtimes.delete(state.id)
  scheduleIdleUnload()
}

function handleRuntimeMessage(state, message) {
  if (message.type === 'loaded' && message.requestId === state.loadRequestId) {
    state.loaded = true
    state.loadedAt = message.loadedAt
    state.stats = message.stats
    state.lastUsedAt = Date.now()
    settleLoad(state, null, state)
    return
  }
  if (message.type === 'chunk' && state.pending?.requestId === message.requestId) {
    state.pending.onTextChunk?.(message.text)
    return
  }
  if (message.type === 'result' && state.pending?.requestId === message.requestId) {
    state.stats = message.stats
    state.lastUsedAt = Date.now()
    settlePending(state, null, {
      text: message.text,
      finishReason: message.finishReason,
      promptTokens: message.promptTokens,
      completionTokens: message.completionTokens,
    })
    return
  }
  if (message.type === 'error') {
    const error = errorFromWorker(message.error)
    if (message.requestId === state.loadRequestId) settleLoad(state, error)
    else if (state.pending?.requestId === message.requestId) settlePending(state, error)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function terminateChild(state) {
  state.stopping = true
  settleLoad(state, new HttpError(503, '模型加载已取消', 'model_load_aborted'))
  settlePending(state, new HttpError(503, '推理已停止', 'inference_stopped'))
  if (state.child.connected) {
    state.child.send({ type: 'shutdown' }, () => {})
  }
  await Promise.race([state.closePromise, delay(5000)])
  if (state.child.exitCode === null && state.child.signalCode === null) {
    state.child.kill('SIGKILL')
    await Promise.race([state.closePromise, delay(2000)])
  }
}

async function spawnRuntime(entry) {
  assertModelFits(entry)
  assertPoolFits(entry)
  const child = spawn(process.execPath, [workerPath], {
    cwd: projectRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  const state = {
    id: crypto.randomUUID(),
    child,
    entry,
    loaded: false,
    loadedAt: null,
    lastUsedAt: Date.now(),
    stats: null,
    pending: null,
    stopping: false,
    loadSettled: false,
    loadRequestId: crypto.randomUUID(),
    loadTimer: null,
    resolveLoad: null,
    rejectLoad: null,
  }
  state.closePromise = new Promise((resolve) => child.once('close', resolve))
  state.loadPromise = new Promise((resolve, reject) => {
    state.resolveLoad = resolve
    state.rejectLoad = reject
  })
  runtimes.set(state.id, state)

  child.on('message', (message) => handleRuntimeMessage(state, message))
  child.on('error', (error) => failRuntime(state, new HttpError(503, `推理进程启动失败：${error.message}`, 'runtime_unavailable')))
  child.on('close', (code, signal) => {
    if (!state.stopping) {
      failRuntime(state, new HttpError(503, `推理进程意外退出（${signal || code}）`, 'runtime_crashed'))
    }
  })
  child.stdout.on('data', (chunk) => process.stdout.write(`[${entry.id}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[${entry.id}] ${chunk}`))

  state.loadTimer = setTimeout(() => {
    settleLoad(state, new HttpError(504, '模型加载超时', 'model_load_timeout'))
    terminateChild(state).catch(() => {})
  }, modelLoadTimeoutMs)
  child.send({
    type: 'load',
    requestId: state.loadRequestId,
    modelPath: entry.path,
    threads,
    contextSize,
  }, (error) => {
    if (error) settleLoad(state, new HttpError(503, `无法启动模型加载：${error.message}`, 'runtime_unavailable'))
  })

  try {
    await state.loadPromise
    state.loaded = true
    state.lastUsedAt = Date.now()
    console.log(`模型 ${entry.id} 已加载，推理进程 RSS ${formatByteSize(state.stats?.rssBytes || 0)}`)
    return state
  } catch (error) {
    if (runtimes.get(state.id) === state) runtimes.delete(state.id)
    await terminateChild(state)
    throw error
  }
}

async function stopRuntime(state) {
  if (!state || state.stopping) return
  clearIdleTimer()
  if (runtimes.get(state.id) === state) runtimes.delete(state.id)
  await terminateChild(state)
}

async function stopRuntimesFor(entryId) {
  const states = [...runtimes.values()].filter((state) => state.entry.id === entryId)
  await Promise.all(states.map((state) => stopRuntime(state)))
}

async function stopAllRuntimes() {
  const states = [...runtimes.values()]
  await Promise.all(states.map((state) => stopRuntime(state)))
}

async function ensureRuntime(entry) {
  if (blockedModels.has(entry.id)) throw new HttpError(503, '模型正在维护，请稍后重试', 'model_maintenance')
  const available = [...runtimes.values()].find((state) => (
    state.entry.id === entry.id && state.loaded && !state.pending && !state.stopping
  ))
  if (available) {
    available.lastUsedAt = Date.now()
    return available
  }
  return spawnRuntime(entry)
}

async function waitForModelIdle(entryId) {
  const states = [...runtimes.values()].filter((state) => state.entry.id === entryId)
  await Promise.allSettled(states.map((state) => state.loadPromise))
  while (true) {
    const pending = [...runtimes.values()]
      .filter((state) => state.entry.id === entryId)
      .map((state) => state.pending?.promise)
      .filter(Boolean)
    if (pending.length === 0) return
    await Promise.allSettled(pending)
  }
}

async function withModelMaintenance(entryId, task) {
  maintenanceCounts.set(entryId, (maintenanceCounts.get(entryId) || 0) + 1)
  blockedModels.add(entryId)
  const previous = maintenanceTails.get(entryId) || Promise.resolve()
  let release
  const tail = new Promise((resolve) => { release = resolve })
  maintenanceTails.set(entryId, tail)
  await previous.catch(() => {})
  try {
    await waitForModelIdle(entryId)
    return await task()
  } finally {
    const count = (maintenanceCounts.get(entryId) || 1) - 1
    if (count <= 0) {
      maintenanceCounts.delete(entryId)
      blockedModels.delete(entryId)
    } else {
      maintenanceCounts.set(entryId, count)
    }
    release()
    if (maintenanceTails.get(entryId) === tail) maintenanceTails.delete(entryId)
  }
}

function scheduleIdleUnload() {
  clearIdleTimer()
  if (runtimes.size === 0 || shuttingDown) return
  if (activeRequests > 0 || queuedRequests > 0) return
  const candidates = [...runtimes.values()].filter((state) => (
    state.loaded && !state.pending && !state.stopping && state.entry.id !== hotModelId && !blockedModels.has(state.entry.id)
  ))
  if (candidates.length === 0) return
  const wait = Math.max(1000, ...candidates.map((state) => modelIdleTimeoutMs - (Date.now() - state.lastUsedAt)))
  idleTimer = setTimeout(async () => {
    if (shuttingDown) return
    if (activeRequests > 0 || queuedRequests > 0) {
      scheduleIdleUnload()
      return
    }
    const due = [...runtimes.values()].filter((state) => (
      state.loaded && !state.pending && !state.stopping
      && state.entry.id !== hotModelId && !blockedModels.has(state.entry.id)
      && Date.now() - state.lastUsedAt >= modelIdleTimeoutMs
    ))
    for (const state of due) {
      await stopRuntime(state)
      console.log(`模型 ${state.entry.id} 闲置 ${Math.round(modelIdleTimeoutMs / 1000)} 秒，已回收推理内存`)
    }
    scheduleIdleUnload()
  }, wait)
  idleTimer.unref()
}

function runtimeGenerate(state, options, signal, onTextChunk) {
  const requestId = crypto.randomUUID()
  const pending = { requestId, signal, onTextChunk, cancelTimer: null, onAbort: null, promise: null }
  const promise = new Promise((resolve, reject) => {
    pending.resolve = resolve
    pending.reject = reject
  })
  pending.promise = promise
  pending.onAbort = () => {
    if (!state.child.connected) return
    state.child.send({ type: 'cancel', requestId }, () => {})
    pending.cancelTimer = setTimeout(() => {
      settlePending(state, new HttpError(408, '请求已取消', 'request_aborted'))
      if (runtimes.get(state.id) === state) {
        runtimes.delete(state.id)
        terminateChild(state).catch(() => {})
      }
    }, 5000)
  }
  state.pending = pending
  if (signal.aborted) pending.onAbort()
  else signal.addEventListener('abort', pending.onAbort, { once: true })
  state.child.send({ type: 'generate', requestId, options }, (error) => {
    if (error) settlePending(state, new HttpError(503, `无法发送推理请求：${error.message}`, 'runtime_unavailable'))
  })
  return promise
}

function startSse(res, requestId, createdAt, modelId) {
  applyHeaders(res, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  })
  res.writeHead(200)
  res.write(`data: ${JSON.stringify({
    id: requestId,
    object: 'chat.completion.chunk',
    created: createdAt,
    model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  })}\n\n`)
}

function writeSseChunk(res, requestId, createdAt, modelId, delta, finishReason = null, usage) {
  if (res.destroyed || res.writableEnded) return
  const choices = finishReason === null && usage === undefined
    ? [{ index: 0, delta, finish_reason: null }]
    : usage !== undefined
      ? []
      : [{ index: 0, delta, finish_reason: finishReason }]
  const payload = { id: requestId, object: 'chat.completion.chunk', created: createdAt, model: modelId, choices }
  if (usage !== undefined) payload.usage = usage
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function finishSse(res, requestId, createdAt, modelId, result, includeUsage) {
  writeSseChunk(res, requestId, createdAt, modelId, {}, result.finishReason)
  if (includeUsage) {
    writeSseChunk(res, requestId, createdAt, modelId, {}, null, {
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      total_tokens: result.promptTokens + result.completionTokens,
    })
  }
  if (!res.destroyed && !res.writableEnded) res.end('data: [DONE]\n\n')
}

async function handleChat(req, res) {
  requireAuth(req, apiKey)
  let requestId
  let startedAt
  let controller
  let timer
  let stream = false
  let status = 'error'
  let promptTokens = 0
  let completionTokens = 0
  let finishReason
  let failureCode
  let selectedModel

  try {
    const options = validateChatRequest(await readJson(req))
    selectedModel = await selectModel(options.model)
    options.model = selectedModel.id
    stream = options.stream
    requestId = `chatcmpl-${crypto.randomUUID()}`
    const createdAt = Math.floor(Date.now() / 1000)
    startedAt = Date.now()
    controller = new AbortController()
    timer = setTimeout(() => controller.abort(new Error('请求超时')), requestTimeoutMs)
    res.once('close', () => {
      if (!res.writableEnded) controller.abort(new Error('客户端断开连接'))
    })

    await enqueue(async () => {
      if (controller.signal.aborted) throw controller.signal.reason
      const state = await ensureRuntime(selectedModel)
      if (controller.signal.aborted) throw controller.signal.reason
      if (stream) startSse(res, requestId, createdAt, selectedModel.id)
      const generated = await runtimeGenerate(state, options, controller.signal, stream
        ? (text) => writeSseChunk(res, requestId, createdAt, selectedModel.id, { content: text })
        : undefined)
      promptTokens = generated.promptTokens
      completionTokens = generated.completionTokens
      finishReason = generated.finishReason

      if (stream) {
        finishSse(res, requestId, createdAt, selectedModel.id, generated, options.includeUsage)
      } else {
        sendJson(res, 200, {
          id: requestId,
          object: 'chat.completion',
          created: createdAt,
          model: selectedModel.id,
          choices: [{ index: 0, message: { role: 'assistant', content: generated.text }, finish_reason: generated.finishReason }],
          usage: {
            prompt_tokens: generated.promptTokens,
            completion_tokens: generated.completionTokens,
            total_tokens: generated.promptTokens + generated.completionTokens,
          },
        })
      }
      return generated
    })
    status = 'success'
  } catch (error) {
    if (controller?.signal.aborted && !res.headersSent) {
      error = new HttpError(408, error.reason?.message === '请求超时' ? '推理超时' : '请求已取消', 'request_aborted')
    }
    failureCode = error?.code || 'internal_error'
    sendError(res, error)
  } finally {
    clearTimeout(timer)
    if (requestId) {
      recordRequest({
        id: requestId,
        timestamp: new Date().toISOString(),
        model: selectedModel?.id || null,
        status,
        stream,
        promptTokens,
        completionTokens,
        latencyMs: startedAt ? Date.now() - startedAt : 0,
        finishReason,
        errorCode: status === 'success' ? null : failureCode,
      })
    }
  }
}

async function handleModels(req, res) {
  requireAuth(req, apiKey)
  const models = await scanModels()
  sendJson(res, 200, {
    object: 'list',
    data: models.map((entry) => ({
      id: entry.id,
      object: 'model',
      created: Math.floor(new Date(entry.createdAt).getTime() / 1000),
      owned_by: 'local',
      permission: [],
      root: entry.id,
      parent: null,
    })),
  })
}

function handleHealth(req, res) {
  const modelIds = [...new Set([...runtimes.values()].map((state) => state.entry.id))]
  sendJson(res, 200, {
    status: shuttingDown ? 'shutting_down' : 'ok',
    model: modelIds.length === 1 ? modelIds[0] : modelIds.length > 1 ? modelIds : null,
    uptimeSeconds: Math.floor(process.uptime()),
    hotModel: hotModelId,
    queue: { active: activeRequests, queued: queuedRequests, maxActive: maxConcurrency, maxQueue },
    heartbeat: {
      enabled: heartbeat.enabled,
      lastSuccessAt: heartbeat.lastSuccessAt,
      lastError: heartbeat.lastError,
    },
  })
}

function renderAdminHtml() {
  const runtimeConfig = JSON.stringify({ apiKey, adminKey, publicBaseUrl }).replace(/</g, '\\u003c')
  return adminHtml.replace('__RUNTIME_CONFIG__', runtimeConfig)
}

function handleAdminPage(req, res) {
  applyHeaders(res, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' data: https://cdn.jsdelivr.net; connect-src 'self'; img-src 'self' data:",
    'Set-Cookie': `rea_admin_download=${adminDownloadCookie}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=86400`,
  })
  res.writeHead(200)
  res.end(renderAdminHtml())
}

async function readModelSelector(req) {
  const body = await readJson(req)
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || body.model.length === 0) {
    throw new HttpError(400, 'model 必须是非空字符串', 'invalid_value', 'model')
  }
  return body.model
}

async function handleAdminLoad(req, res) {
  requireAuth(req, adminKey)
  const id = await readModelSelector(req)
  const entry = await selectModel(id)
  await enqueue(() => ensureRuntime(entry))
  sendJson(res, 200, { ok: true, model: serializeModel(entry) })
}

async function handleAdminUnload(req, res) {
  requireAuth(req, adminKey)
  const id = await readModelSelector(req)
  const entry = await resolveModel(id)
  if (!entry) throw new HttpError(404, `模型不存在：${id}`, 'model_not_found', 'model')
  if (entry.id === hotModelId) throw new HttpError(409, '热启动模型需保持常驻，不能手动卸载', 'hot_model_locked', 'model')
  await enqueue(() => withModelMaintenance(entry.id, () => stopRuntimesFor(entry.id)))
  sendJson(res, 200, { ok: true })
}

async function handleAdminDelete(req, res) {
  requireAuth(req, adminKey)
  const id = await readModelSelector(req)
  const entry = await resolveModel(id)
  if (!entry) throw new HttpError(404, `模型不存在：${id}`, 'model_not_found', 'model')
  const wasHot = entry.id === hotModelId
  await enqueue(() => withModelMaintenance(entry.id, async () => {
    await stopRuntimesFor(entry.id)
    try {
      await fs.unlink(entry.path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    delete stats.modelUsage[entry.id]
    if (wasHot) hotModelId = null
    persistStats()
  }))
  if (wasHot) await warmHotModel()
  sendJson(res, 200, { ok: true, models: (await scanModels()).map(serializeModel) })
}

async function handleAdminRename(req, res) {
  requireAuth(req, adminKey)
  const body = await readJson(req)
  if (!body || typeof body !== 'object' || typeof body.model !== 'string' || body.model.length === 0) {
    throw new HttpError(400, 'model 必须是非空字符串', 'invalid_value', 'model')
  }
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw new HttpError(400, '新模型名称不能为空', 'invalid_value', 'name')
  }
  if (/[\\/]/.test(body.name)) throw new HttpError(400, '模型名称不能包含路径', 'invalid_filename')
  const newName = sanitizeUploadFilename(body.name)
  const entry = await resolveModel(body.model)
  if (!entry) throw new HttpError(404, `模型不存在：${body.model}`, 'model_not_found', 'model')
  if (newName === entry.id) throw new HttpError(400, '模型名称未改变', 'name_unchanged', 'name')
  if (newName.toLowerCase() === entry.id.toLowerCase()) {
    throw new HttpError(400, '仅修改文件名大小写暂不支持', 'case_only_rename', 'name')
  }

  const targetPath = path.join(modelDir, newName)
  const wasHot = entry.id === hotModelId
  await enqueue(() => withModelMaintenance(entry.id, async () => {
    await stopRuntimesFor(entry.id)
    try {
      await fs.link(entry.path, targetPath)
    } catch (error) {
      if (error.code === 'EEXIST') throw new HttpError(409, `模型已存在：${newName}`, 'model_exists')
      throw error
    }
    try {
      await fs.unlink(entry.path)
    } catch (error) {
      await fs.unlink(targetPath).catch(() => {})
      throw error
    }
    if (defaultModelId === entry.id || defaultModelId === entry.name) defaultModelId = newName
    if (hotModelPinned && (configuredHotModel === entry.id || configuredHotModel === entry.name)) configuredHotModel = newName
    if (wasHot) hotModelId = newName
    stats.modelUsage[newName] = (stats.modelUsage[entry.id] || 0) + (stats.modelUsage[newName] || 0)
    delete stats.modelUsage[entry.id]
    persistStats()
  }))
  if (wasHot) await warmHotModel()

  const renamed = await resolveModel(newName)
  sendJson(res, 200, { ok: true, model: serializeModel(renamed), models: (await scanModels()).map(serializeModel) })
}

function sanitizeUploadFilename(filename) {
  const name = path.posix.basename(String(filename || '').replace(/\\/g, '/'))
  const baseName = path.basename(name, path.extname(name))
  if (
    !name || name === '.' || name === '..'
    || /[\u0000-\u001f\u007f<>:"|?*]/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(baseName)
    || Buffer.byteLength(name) > 240
  ) {
    throw new HttpError(400, '模型文件名无效', 'invalid_filename')
  }
  if (path.extname(name).toLowerCase() !== '.gguf') {
    throw new HttpError(400, '仅支持 .gguf 模型文件', 'invalid_file_type')
  }
  return name
}

function isPublicIp(address) {
  if (address.includes(':')) {
    const ip = address.toLowerCase()
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip)
    if (mapped) return isPublicIp(mapped[1])
    if (ip === '::' || ip === '::1' || ip.startsWith('::') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('ff')) return false
    if (!/^[23][0-9a-f]{3}:/.test(ip) || ip.startsWith('2001:db8:') || ip.startsWith('2002:')) return false
    return true
  }
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [a, b, c] = parts
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function remoteLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error)
    const allowed = allowPrivateModelUrls ? addresses : addresses.filter((item) => isPublicIp(item.address))
    if (allowed.length === 0) return callback(new Error('模型地址仅允许公网 HTTP/HTTPS 服务'))
    // Linux 下 Node 默认启用 autoSelectFamily，会以 { all: true } 约定调用 lookup 并要求数组结果
    if (options?.all) return callback(null, allowed)
    callback(null, allowed[0].address, allowed[0].family)
  })
}

function validateRemoteUrl(value) {
  let target
  try {
    target = new URL(value)
  } catch {
    throw new HttpError(400, '模型下载地址无效', 'invalid_url')
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new HttpError(400, '仅支持不带账号密码的 HTTP/HTTPS 模型地址', 'invalid_url')
  }
  const hostname = target.hostname.replace(/^\[|\]$/g, '')
  if (!allowPrivateModelUrls && net.isIP(hostname) && !isPublicIp(hostname)) {
    throw new HttpError(400, '模型地址仅允许公网 HTTP/HTTPS 服务', 'invalid_url')
  }
  return target
}

function openRemoteResponse(target, redirects = 0, signal) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new HttpError(502, '模型地址重定向次数过多', 'remote_redirect_limit'))
      return
    }
    const client = target.protocol === 'https:' ? https : http
    const req = client.get(target, {
      headers: { 'User-Agent': 'REA-Model-Console/1.1', Accept: 'application/octet-stream,*/*' },
      lookup: remoteLookup,
      signal,
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume()
        let next
        try {
          next = validateRemoteUrl(new URL(res.headers.location, target).toString())
        } catch (error) {
          reject(error)
          return
        }
        resolve(openRemoteResponse(next, redirects + 1, signal))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        reject(new HttpError(502, `模型服务器返回 HTTP ${res.statusCode}`, 'remote_http_error'))
        return
      }
      resolve({ response: res, url: target })
    })
    req.setTimeout(30000, () => req.destroy(new Error('模型服务器响应超时')))
    req.on('error', (error) => reject(error instanceof HttpError ? error : new HttpError(502, `模型下载失败：${error.message}`, 'remote_download_error')))
  })
}

function filenameFromRemote(target, disposition = '') {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
  const plain = /filename="?([^";]+)"?/i.exec(disposition)?.[1]
  let name = ''
  try { name = decodeURIComponent(encoded || plain || '') } catch {}
  if (!name) {
    try { name = decodeURIComponent(path.posix.basename(target.pathname)) } catch {}
  }
  return name || null
}

function normalizeModelLink(value, errorStatus = 400) {
  const fail = (message, param) => { throw new HttpError(errorStatus, message, errorStatus === 500 ? 'invalid_model_links_config' : 'invalid_value', param) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('模型链接必须是对象', 'model')
  if (typeof value.id !== 'string' || !value.id.trim()) fail('模型文件名不能为空', 'id')
  if (/[\\/]/.test(value.id.trim())) fail('模型文件名不能包含路径', 'id')
  let id
  try {
    id = sanitizeUploadFilename(value.id.trim())
  } catch (error) {
    throw new HttpError(errorStatus, error.message, errorStatus === 500 ? 'invalid_model_links_config' : error.code, 'id')
  }
  if (typeof value.url !== 'string' || !value.url.trim() || value.url.length > 8192) fail('模型下载地址不能为空且不能超过 8192 个字符', 'url')
  let target
  try {
    target = validateRemoteUrl(value.url.trim())
  } catch (error) {
    throw new HttpError(errorStatus, error.message, errorStatus === 500 ? 'invalid_model_links_config' : error.code, 'url')
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') fail('enabled 必须是布尔值', 'enabled')
  const link = { id, url: target.toString(), enabled: value.enabled ?? true }
  if (value.sizeBytes !== undefined && value.sizeBytes !== null && value.sizeBytes !== '') {
    if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes <= 0) fail('sizeBytes 必须是正整数', 'sizeBytes')
    link.sizeBytes = value.sizeBytes
  }
  if (value.sha256 !== undefined && value.sha256 !== null && value.sha256 !== '') {
    if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(value.sha256)) fail('SHA-256 必须是 64 位十六进制字符串', 'sha256')
    link.sha256 = value.sha256.toLowerCase()
  }
  if (value.lastPulledAt !== undefined && value.lastPulledAt !== null && value.lastPulledAt !== '') {
    const pulledAt = new Date(value.lastPulledAt)
    if (Number.isNaN(pulledAt.getTime())) fail('lastPulledAt 时间格式无效', 'lastPulledAt')
    link.lastPulledAt = pulledAt.toISOString()
  }
  return link
}

function ensureUniqueModelLink(models, id, ignoreIndex, errorStatus) {
  const duplicate = models.findIndex((item, index) => index !== ignoreIndex && item.id.toLowerCase() === id.toLowerCase())
  if (duplicate >= 0) throw new HttpError(errorStatus, `模型链接已存在：${id}`, errorStatus === 500 ? 'invalid_model_links_config' : 'model_link_exists', 'id')
}

function normalizeModelLinksConfig(saved) {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) throw new HttpError(500, '模型链接配置必须是 JSON 对象', 'invalid_model_links_config')
  if (saved.version !== undefined && saved.version !== 1) throw new HttpError(500, '模型链接配置仅支持 version 1', 'invalid_model_links_config')
  if (!Array.isArray(saved.models) || saved.models.length > 100) throw new HttpError(500, '模型链接配置的 models 必须是不超过 100 项的数组', 'invalid_model_links_config')
  const models = saved.models.map((item) => normalizeModelLink(item, 500))
  models.forEach((item, index) => ensureUniqueModelLink(models, item.id, index, 500))
  return { version: 1, models }
}

async function readModelLinksConfig() {
  let raw
  try {
    raw = await fs.readFile(modelLinksFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, models: [] }
    throw new HttpError(500, `模型链接配置读取失败：${error.message}`, 'model_links_read_error')
  }
  let saved
  try {
    saved = JSON.parse(raw)
  } catch (error) {
    throw new HttpError(500, `模型链接配置不是合法 JSON：${error.message}`, 'invalid_model_links_config')
  }
  return normalizeModelLinksConfig(saved)
}

async function writeModelLinksConfig(config) {
  const normalized = normalizeModelLinksConfig(config)
  const tempPath = `${modelLinksFile}.${process.pid}.${crypto.randomUUID()}.tmp`
  try {
    await fs.writeFile(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
    await fs.rename(tempPath, modelLinksFile)
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

async function ensureModelLinksFile() {
  try {
    await fs.access(modelLinksFile)
    return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await writeModelLinksConfig({ version: 1, models: defaultModelLinks.map((item) => ({ ...item })) })
}

function mutateModelLinks(mutator) {
  const operation = modelLinksWriteQueue.then(async () => {
    const config = await readModelLinksConfig()
    const next = mutator(config)
    await writeModelLinksConfig(next)
    return next
  })
  modelLinksWriteQueue = operation.catch(() => {})
  return operation
}

async function modelLinksPayload(config) {
  const current = config || await readModelLinksConfig()
  const localModels = await scanModels()
  const models = current.models.map((link) => {
    const local = findModelInList(localModels, link.id)
    const localStatus = !local ? 'missing' : link.sizeBytes && local.sizeBytes !== link.sizeBytes ? 'size_mismatch' : 'present'
    return { ...link, localStatus, localSizeBytes: local?.sizeBytes ?? null }
  })
  return {
    ok: true,
    file: path.basename(modelLinksFile),
    version: current.version,
    models,
    missingCount: models.filter((item) => item.enabled && item.localStatus === 'missing').length,
  }
}

async function handleAdminModelLinks(req, res) {
  requireAuth(req, adminKey)
  sendJson(res, 200, await modelLinksPayload())
}

async function handleAdminModelLinkItem(req, res, requestedId) {
  requireAuth(req, adminKey)
  const config = await readModelLinksConfig()
  const index = config.models.findIndex((item) => item.id.toLowerCase() === requestedId.toLowerCase())
  if (index < 0) throw new HttpError(404, `模型链接不存在：${requestedId}`, 'model_link_not_found', 'id')
  sendJson(res, 200, { ok: true, model: config.models[index] })
}

async function handleAdminModelLinkCreate(req, res) {
  requireAuth(req, adminKey)
  const body = await readJson(req)
  const link = normalizeModelLink(body)
  await mutateModelLinks((config) => {
    if (config.models.length >= 100) throw new HttpError(400, '最多只能保存 100 个模型链接', 'too_many_model_links')
    ensureUniqueModelLink(config.models, link.id, -1, 409)
    config.models.push(link)
    return config
  })
  sendJson(res, 201, await modelLinksPayload())
}

async function handleAdminModelLinkUpdate(req, res, requestedId) {
  requireAuth(req, adminKey)
  const body = await readJson(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, '请求体必须是 JSON 对象', 'invalid_value')
  const fields = ['id', 'url', 'enabled', 'sizeBytes', 'sha256']
  if (!fields.some((field) => Object.prototype.hasOwnProperty.call(body, field))) throw new HttpError(400, '请至少提供一个要修改的字段', 'invalid_value')
  await mutateModelLinks((config) => {
    const index = config.models.findIndex((item) => item.id.toLowerCase() === requestedId.toLowerCase())
    if (index < 0) throw new HttpError(404, `模型链接不存在：${requestedId}`, 'model_link_not_found', 'id')
    const candidate = { ...config.models[index] }
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(body, field)) candidate[field] = body[field]
    }
    const link = normalizeModelLink(candidate)
    ensureUniqueModelLink(config.models, link.id, index, 409)
    config.models[index] = link
    return config
  })
  sendJson(res, 200, await modelLinksPayload())
}

async function handleAdminModelLinkDelete(req, res, requestedId) {
  requireAuth(req, adminKey)
  await mutateModelLinks((config) => {
    const index = config.models.findIndex((item) => item.id.toLowerCase() === requestedId.toLowerCase())
    if (index < 0) throw new HttpError(404, `模型链接不存在：${requestedId}`, 'model_link_not_found', 'id')
    config.models.splice(index, 1)
    return config
  })
  sendJson(res, 200, await modelLinksPayload())
}

async function handleAdminModelLinksExport(req, res) {
  requireDownloadAuth(req)
  const config = await readModelLinksConfig()
  const body = `${JSON.stringify(config, null, 2)}\n`
  applyHeaders(res, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': contentDisposition('models.config.json'),
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.writeHead(200)
  res.end(body)
}

async function recordPulledModelLink(link) {
  return mutateModelLinks((config) => {
    const index = config.models.findIndex((item) => item.id.toLowerCase() === link.id.toLowerCase())
    const existing = index >= 0 ? config.models[index] : null
    const next = normalizeModelLink({
      id: link.id,
      url: link.url,
      enabled: existing?.enabled ?? true,
      sizeBytes: link.sizeBytes,
      sha256: link.sha256,
      lastPulledAt: new Date().toISOString(),
    })
    if (index >= 0) config.models[index] = next
    else config.models.unshift(next)
    return config
  })
}

async function downloadModelToModelDir({ url, name, signal, expectedSizeBytes, expectedSha256, onProgress }) {
  const target = validateRemoteUrl(url)
  const tempPath = path.join(modelDir, `.${crypto.randomUUID()}.part`)
  let tempCreated = false
  let response = null
  onProgress?.({ status: 'connecting', filename: name || null, receivedBytes: 0, totalBytes: 0 })
  try {
    const remote = await openRemoteResponse(target, 0, signal)
    response = remote.response
    const totalBytes = Number(response.headers['content-length'])
    if (Number.isFinite(totalBytes) && totalBytes > maxModelBytes) {
      throw new HttpError(413, `模型文件超过 ${formatByteSize(maxModelBytes)} 限制`, 'model_too_large')
    }
    if (expectedSizeBytes && Number.isFinite(totalBytes) && totalBytes !== expectedSizeBytes) {
      throw new HttpError(502, '远程模型大小与链接配置不一致', 'model_size_mismatch')
    }
    const remoteName = filenameFromRemote(remote.url, response.headers['content-disposition'] || '')
    const filename = sanitizeUploadFilename(name?.trim() || remoteName)
    const targetPath = path.join(modelDir, filename)
    if (fsSync.existsSync(targetPath)) throw new HttpError(409, `模型已存在：${filename}`, 'model_exists')
    onProgress?.({ filename, status: 'downloading', totalBytes: Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : 0 })

    const hash = crypto.createHash('sha256')
    let receivedBytes = 0
    const writeStream = fsSync.createWriteStream(tempPath, { flags: 'wx' })
    tempCreated = true
    await pipeline(response, async function* (source) {
      for await (const chunk of source) {
        receivedBytes += chunk.length
        if (receivedBytes > maxModelBytes) {
          throw new HttpError(413, `模型文件超过 ${formatByteSize(maxModelBytes)} 限制`, 'model_too_large')
        }
        hash.update(chunk)
        onProgress?.({ receivedBytes })
        yield chunk
      }
    }, writeStream)

    onProgress?.({ status: 'verifying', receivedBytes })
    const downloadStat = await fs.stat(tempPath)
    if (downloadStat.size < 24) throw new HttpError(400, 'GGUF 文件不完整', 'invalid_gguf')
    const handle = await fs.open(tempPath, 'r')
    try {
      const magic = Buffer.alloc(4)
      await handle.read(magic, 0, 4, 0)
      if (magic.toString('ascii') !== 'GGUF') throw new HttpError(400, '下载内容不是有效的 GGUF 模型', 'invalid_gguf')
    } finally {
      await handle.close()
    }
    const sha256 = hash.digest('hex')
    if (expectedSizeBytes && downloadStat.size !== expectedSizeBytes) throw new HttpError(502, '下载模型大小与链接配置不一致', 'model_size_mismatch')
    if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) throw new HttpError(502, '下载模型 SHA-256 与链接配置不一致', 'model_hash_mismatch')
    try {
      await fs.link(tempPath, targetPath)
    } catch (error) {
      if (error.code === 'EEXIST') throw new HttpError(409, `模型已存在：${filename}`, 'model_exists')
      throw error
    }
    await fs.unlink(tempPath)
    tempCreated = false
    const entry = await resolveModel(filename)
    if (!entry) throw new HttpError(500, '模型下载完成但无法扫描到文件', 'model_scan_error')
    return { entry, filename, sizeBytes: downloadStat.size, sha256 }
  } finally {
    if (response && !response.destroyed) response.destroy()
    if (tempCreated) await fs.rm(tempPath, { force: true }).catch(() => {})
  }
}

async function handleAdminPull(req, res) {
  requireAuth(req, adminKey)
  if (uploadInProgress || pullInProgress) throw new HttpError(409, '已有模型正在传输，请稍后再试', 'transfer_in_progress')
  const body = await readJson(req)
  if (!body || typeof body !== 'object' || typeof body.url !== 'string' || !body.url.trim()) {
    throw new HttpError(400, '请提供模型下载地址', 'invalid_url')
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    throw new HttpError(400, 'name 必须是字符串', 'invalid_value', 'name')
  }
  const target = validateRemoteUrl(body.url.trim())
  const controller = new AbortController()
  req.once('aborted', () => controller.abort(new Error('客户端已断开')))
  pullInProgress = true
  modelTransfer = { type: 'pull', status: 'connecting', filename: body.name || null, receivedBytes: 0, totalBytes: 0 }
  try {
    const pulled = await downloadModelToModelDir({
      url: target.toString(),
      name: body.name,
      signal: controller.signal,
      onProgress(progress) {
        modelTransfer = { ...modelTransfer, ...progress }
        if (progress.receivedBytes !== undefined) modelTransfer.receivedBytes = progress.receivedBytes
      },
    })
    let linkWarning = null
    try {
      await recordPulledModelLink({ id: pulled.filename, url: target.toString(), sizeBytes: pulled.sizeBytes, sha256: pulled.sha256 })
    } catch (error) {
      linkWarning = `模型已下载，但链接配置保存失败：${error.message}`
      console.error(linkWarning)
    }
    sendJson(res, 201, { ok: true, model: serializeModel(pulled.entry), linkSaved: !linkWarning, linkWarning })
  } finally {
    pullInProgress = false
    modelTransfer = null
  }
}

async function handleAdminModelLinksPullMissing(req, res) {
  requireAuth(req, adminKey)
  if (uploadInProgress || pullInProgress) throw new HttpError(409, '已有模型正在传输，请稍后再试', 'transfer_in_progress')
  const config = await readModelLinksConfig()
  const localModels = await scanModels()
  const controller = new AbortController()
  req.once('aborted', () => controller.abort(new Error('客户端已断开')))
  pullInProgress = true
  modelTransfer = { type: 'model-links-sync', status: 'preparing', filename: null, receivedBytes: 0, totalBytes: 0, syncIndex: 0, syncTotal: config.models.length }
  const results = []
  let downloaded = 0
  let skipped = 0
  let failed = 0
  try {
    for (let index = 0; index < config.models.length; index += 1) {
      if (controller.signal.aborted) break
      const link = config.models[index]
      if (!link.enabled) {
        results.push({ id: link.id, status: 'disabled' })
        skipped += 1
        continue
      }
      const local = findModelInList(localModels, link.id)
      if (local) {
        if (link.sizeBytes && local.sizeBytes !== link.sizeBytes) {
          results.push({ id: link.id, status: 'size_mismatch', message: '本地文件大小与配置不一致，为避免覆盖已跳过' })
          failed += 1
        } else {
          results.push({ id: link.id, status: 'exists' })
          skipped += 1
        }
        continue
      }
      modelTransfer = { ...modelTransfer, syncIndex: index + 1, status: 'connecting', filename: link.id, receivedBytes: 0, totalBytes: 0 }
      try {
        const pulled = await downloadModelToModelDir({
          url: link.url,
          name: link.id,
          signal: controller.signal,
          expectedSizeBytes: link.sizeBytes,
          expectedSha256: link.sha256,
          onProgress(progress) {
            modelTransfer = { ...modelTransfer, ...progress }
            if (progress.receivedBytes !== undefined) modelTransfer.receivedBytes = progress.receivedBytes
          },
        })
        await recordPulledModelLink({ id: pulled.filename, url: link.url, sizeBytes: pulled.sizeBytes, sha256: pulled.sha256 })
        results.push({ id: link.id, status: 'downloaded', sizeBytes: pulled.sizeBytes, sha256: pulled.sha256 })
        downloaded += 1
      } catch (error) {
        results.push({ id: link.id, status: 'failed', message: error.message })
        failed += 1
        if (controller.signal.aborted) break
      }
    }
    sendJson(res, 200, {
      ok: failed === 0,
      summary: { total: config.models.length, downloaded, skipped, failed },
      results,
      models: (await scanModels()).map(serializeModel),
    })
  } finally {
    pullInProgress = false
    modelTransfer = null
  }
}

async function handleAdminUpload(req, res) {
  requireAuth(req, adminKey)
  if (uploadInProgress) throw new HttpError(409, '已有模型正在上传，请稍后再试', 'upload_in_progress')
  const contentType = req.headers['content-type'] || ''
  const boundaryMatch = /^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]
  if (!boundary || boundary.length > 200) throw new HttpError(400, '上传请求必须是 multipart/form-data', 'invalid_upload')

  uploadInProgress = true
  modelTransfer = { type: 'upload', status: 'uploading', filename: null, receivedBytes: 0, totalBytes: 0 }
  const tempPath = path.join(modelDir, `.${crypto.randomUUID()}.part`)
  let targetPath = null
  let tempCreated = false
  let writeStream = null
  let writePromise = null
  let fileSeen = false
  let uploadError = null
  let busboy = null

  try {
    await new Promise((resolve, reject) => {
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      busboy = Busboy({
        headers: req.headers,
        defCharset: 'utf8',
        defParamCharset: 'utf8',
        limits: { files: 1, fields: 0, fileSize: maxModelBytes },
      })
      busboy.on('file', (fieldName, file, info) => {
        if (fieldName !== 'model' || fileSeen) {
          file.resume()
          fail(new HttpError(400, '上传字段必须是 model', 'invalid_upload_field'))
          return
        }
        fileSeen = true
        let filename
        try {
          filename = sanitizeUploadFilename(info.filename)
        } catch (error) {
          file.resume()
          fail(error)
          return
        }
        targetPath = path.join(modelDir, filename)
        modelTransfer.filename = filename
        file.on('data', (chunk) => {
          modelTransfer.receivedBytes += chunk.length
        })
        if (fsSync.existsSync(targetPath)) {
          file.resume()
          fail(new HttpError(409, `模型已存在：${filename}`, 'model_exists'))
          return
        }
        try {
          writeStream = fsSync.createWriteStream(tempPath, { flags: 'wx' })
          tempCreated = true
        } catch (error) {
          file.resume()
          fail(error)
          return
        }
        writeStream.on('error', fail)
        file.on('error', fail)
        file.on('limit', () => {
          uploadError = new HttpError(413, `模型文件超过 ${formatByteSize(maxModelBytes)} 限制`, 'model_too_large')
        })
        writePromise = pipeline(file, writeStream).catch(fail)
      })
      busboy.on('filesLimit', () => fail(new HttpError(400, '一次只能上传一个模型', 'too_many_files')))
      busboy.on('fieldsLimit', () => fail(new HttpError(400, '上传请求包含不支持的字段', 'invalid_upload_field')))
      busboy.on('error', fail)
      busboy.on('close', async () => {
        try {
          if (writePromise) await writePromise
          if (uploadError) throw uploadError
          if (!fileSeen || !tempCreated || !targetPath) throw new HttpError(400, '请选择要上传的模型文件', 'missing_file')
          const uploadStat = await fs.stat(tempPath)
          if (uploadStat.size < 24) throw new HttpError(400, 'GGUF 文件不完整', 'invalid_gguf')
          const handle = await fs.open(tempPath, 'r')
          try {
            const magic = Buffer.alloc(4)
            await handle.read(magic, 0, 4, 0)
            if (magic.toString('ascii') !== 'GGUF') throw new HttpError(400, '文件不是有效的 GGUF 模型', 'invalid_gguf')
          } finally {
            await handle.close()
          }
          await fs.link(tempPath, targetPath)
          await fs.unlink(tempPath)
          tempCreated = false
          resolve(targetPath)
        } catch (error) {
          fail(error)
        }
      })
      req.once('aborted', () => fail(new HttpError(400, '上传已中断', 'upload_aborted')))
      req.once('error', fail)
      req.pipe(busboy)
    })
  } finally {
    uploadInProgress = false
    if (busboy) busboy.destroy()
    if (writeStream && !writeStream.destroyed) writeStream.destroy()
    if (writeStream && !writeStream.closed) {
      await new Promise((resolve) => writeStream.once('close', resolve))
    }
    if (tempCreated) await fs.rm(tempPath, { force: true }).catch(() => {})
    modelTransfer = null
  }

  const uploaded = await resolveModel(path.basename(targetPath))
  sendJson(res, 201, { ok: true, model: serializeModel(uploaded) })
}

function requireDownloadAuth(req) {
  try {
    requireAuth(req, adminKey)
    return
  } catch {}
  const cookie = String(req.headers.cookie || '').split(';').map((item) => item.trim()).find((item) => item.startsWith('rea_admin_download='))
  const provided = cookie?.slice('rea_admin_download='.length) || ''
  if (provided && safeEqual(provided, adminDownloadCookie)) return
  throw new HttpError(401, '下载鉴权失败，请先打开管理控制台', 'invalid_api_key')
}

function contentDisposition(filename) {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

async function handleAdminDownload(req, res) {
  requireDownloadAuth(req)
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const entry = await resolveModel(url.searchParams.get('model') || '')
  if (!entry) throw new HttpError(404, '模型不存在', 'model_not_found')
  applyHeaders(res, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': entry.sizeBytes,
    'Content-Disposition': contentDisposition(entry.id),
    'Cache-Control': 'no-store',
  })
  res.writeHead(200)
  await pipeline(fsSync.createReadStream(entry.path), res)
}

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n += 1) {
  let value = n
  for (let k = 0; k < 8; k += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  crcTable[n] = value >>> 0
}

function crc32Update(crc, buffer) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buffer, crc) >>> 0
  let value = crc ^ 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function zipDateTime(date) {
  const year = Math.max(1980, Math.min(2107, date.getFullYear()))
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

async function writeZipBuffer(res, state, buffer) {
  if (res.destroyed) throw new Error('下载已中断')
  state.offset += buffer.length
  if (!res.write(buffer)) await once(res, 'drain')
}

async function sendBatchZip(res, entries) {
  const state = { offset: 0 }
  const central = []
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  applyHeaders(res, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="rea-models-${stamp}.zip"`,
    'Cache-Control': 'no-store',
  })
  res.writeHead(200)

  for (const entry of entries) {
    const name = Buffer.from(entry.id, 'utf8')
    const modified = new Date(entry.modifiedAt)
    const { time, date } = zipDateTime(modified)
    const localOffset = state.offset
    const localExtra = Buffer.alloc(20)
    localExtra.writeUInt32LE(0x0001, 0)
    localExtra.writeUInt32LE(16, 2)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(45, 4)
    local.writeUInt16LE(0x0808, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(0xffffffff, 18)
    local.writeUInt32LE(0xffffffff, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    await writeZipBuffer(res, state, Buffer.concat([local, name, localExtra]))

    let size = 0
    let crc = 0
    for await (const chunk of fsSync.createReadStream(entry.path)) {
      size += chunk.length
      crc = crc32Update(crc, chunk)
      await writeZipBuffer(res, state, chunk)
    }
    const descriptor = Buffer.alloc(24)
    descriptor.writeUInt32LE(0x08074b50, 0)
    descriptor.writeUInt32LE(crc, 4)
    descriptor.writeBigUInt64LE(BigInt(size), 8)
    descriptor.writeBigUInt64LE(BigInt(size), 16)
    await writeZipBuffer(res, state, descriptor)
    central.push({ entry, name, time, date, crc, size, localOffset })
  }

  const centralOffset = state.offset
  for (const item of central) {
    const extra = Buffer.alloc(28)
    extra.writeUInt32LE(0x0001, 0)
    extra.writeUInt32LE(24, 2)
    extra.writeBigUInt64LE(BigInt(item.size), 4)
    extra.writeBigUInt64LE(BigInt(item.size), 12)
    extra.writeBigUInt64LE(BigInt(item.localOffset), 20)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(45, 4)
    header.writeUInt16LE(45, 6)
    header.writeUInt16LE(0x0808, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(item.time, 12)
    header.writeUInt16LE(item.date, 14)
    header.writeUInt32LE(item.crc, 16)
    header.writeUInt32LE(0xffffffff, 20)
    header.writeUInt32LE(0xffffffff, 24)
    header.writeUInt16LE(item.name.length, 28)
    header.writeUInt16LE(extra.length, 30)
    header.writeUInt32LE(0xffffffff, 42)
    await writeZipBuffer(res, state, Buffer.concat([header, item.name, extra]))
  }
  const centralSize = state.offset - centralOffset

  const zip64End = Buffer.alloc(56)
  zip64End.writeUInt32LE(0x06064b50, 0)
  zip64End.writeBigUInt64LE(44n, 4)
  zip64End.writeUInt16LE(45, 12)
  zip64End.writeUInt16LE(45, 14)
  zip64End.writeBigUInt64LE(BigInt(central.length), 24)
  zip64End.writeBigUInt64LE(BigInt(central.length), 32)
  zip64End.writeBigUInt64LE(BigInt(centralSize), 40)
  zip64End.writeBigUInt64LE(BigInt(centralOffset), 48)
  await writeZipBuffer(res, state, zip64End)

  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  locator.writeBigUInt64LE(BigInt(centralOffset + centralSize), 8)
  locator.writeUInt32LE(1, 16)
  await writeZipBuffer(res, state, locator)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  end.writeUInt32LE(0xffffffff, 12)
  end.writeUInt32LE(0xffffffff, 16)
  await writeZipBuffer(res, state, end)
  res.end()
}

async function handleAdminBatchDownload(req, res) {
  requireDownloadAuth(req)
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const ids = [...new Set(url.searchParams.getAll('model'))]
  if (ids.length === 0) throw new HttpError(400, '请至少选择一个模型', 'invalid_value', 'model')
  if (ids.length > 100) throw new HttpError(400, '一次最多打包 100 个模型', 'too_many_models')
  const entries = []
  for (const id of ids) {
    const entry = await resolveModel(id)
    if (!entry) throw new HttpError(404, `模型不存在：${id}`, 'model_not_found')
    entries.push(entry)
  }
  await sendBatchZip(res, entries)
}

async function handleAdminReset(req, res) {
  requireAuth(req, adminKey)
  stats.totals = emptyStats().totals
  stats.daily = {}
  stats.recent = []
  stats.modelUsage = {}
  await persistStats()
  sendJson(res, 200, { ok: true })
}

async function handleAdminConcurrency(req, res) {
  requireAuth(req, adminKey)
  const body = await readJson(req)
  const value = body?.concurrency
  if (!Number.isInteger(value) || value < 1 || value > maxConcurrencyLimit) {
    throw new HttpError(400, `concurrency 必须是 1–${maxConcurrencyLimit} 的整数`, 'invalid_value', 'concurrency')
  }
  maxConcurrency = value
  drainQueue()
  sendJson(res, 200, { ok: true, queue: { active: activeRequests, queued: queuedRequests, maxActive: maxConcurrency, maxQueue } })
}

async function handleAdminStats(req, res) {
  requireAuth(req, adminKey)
  const models = (await scanModels()).map(serializeModel)
  const daily = Object.entries(stats.daily)
    .map(([date, value]) => ({ date, ...value }))
    .sort((left, right) => right.date.localeCompare(left.date))
    .slice(0, 90)
  const serverRssBytes = process.memoryUsage().rss
  const runtimeStates = [...runtimes.values()].filter((state) => !state.stopping)
  const modelIds = [...new Set(runtimeStates.map((state) => state.entry.id))]
  const runtimeInfo = runtimeStates.length > 0 ? {
    id: modelIds.length === 1 ? modelIds[0] : `${modelIds.length} 个模型`,
    modelIds,
    file: modelIds.length === 1 ? runtimeStates[0].entry.file : null,
    status: runtimeStates.some((state) => !state.loaded) ? 'loading' : 'loaded',
    instanceCount: runtimeStates.length,
    loadedAt: runtimeStates.map((state) => state.loadedAt).filter(Boolean).sort().at(-1) || null,
    lastUsedAt: new Date(Math.max(...runtimeStates.map((state) => state.lastUsedAt || 0))).toISOString(),
    contextSize,
    threads,
    rssBytes: serverRssBytes + runtimeStates.reduce((total, state) => total + (state.stats?.rssBytes || 0), 0),
    serverRssBytes,
    modelBytes: runtimeStates.reduce((total, state) => total + (state.stats?.modelBytes || state.entry.sizeBytes), 0),
    contextMemory: { ram: runtimeStates.reduce((total, state) => total + (state.stats?.contextMemory?.ram || 0), 0) },
    idleTimeoutMs: modelIdleTimeoutMs,
  } : null
  const system = await getSystemResources(models.reduce((total, model) => total + model.sizeBytes, 0))

  sendJson(res, 200, {
    models,
    runtime: runtimeInfo,
    serverRssBytes,
    memoryLimitBytes: getMemoryLimitBytes(),
    modelMemoryOverheadBytes: modelMemoryOverheadMb * 1024 ** 2,
    modelIdleTimeoutMs,
    maxModelBytes,
    maxConcurrencyLimit,
    hotModelId,
    hotModelPinned,
    system,
    transfer: modelTransfer,
    publicBaseUrl,
    uptimeSeconds: Math.floor(process.uptime()),
    queue: { active: activeRequests, queued: queuedRequests, maxActive: maxConcurrency, maxQueue },
    heartbeat,
    totals: {
      ...stats.totals,
      totalTokens: stats.totals.promptTokens + stats.totals.completionTokens,
    },
    daily,
    recent: stats.recent,
  })
}

function requestHealth(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const client = target.protocol === 'https:' ? https : http
    const req = client.get(target, { timeout: 10000 }, (res) => {
      res.resume()
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve()
        else reject(new Error(`HTTP ${res.statusCode}`))
      })
    })
    req.on('timeout', () => req.destroy(new Error('保活请求超时')))
    req.on('error', reject)
  })
}

async function runHeartbeat() {
  if (!keepAliveEnabled || shuttingDown) return
  heartbeat.lastAttemptAt = new Date().toISOString()
  try {
    await requestHealth(keepAliveUrl)
    heartbeat.lastSuccessAt = new Date().toISOString()
    heartbeat.lastError = null
    heartbeat.consecutiveFailures = 0
  } catch (error) {
    heartbeat.lastError = error.message
    heartbeat.consecutiveFailures += 1
  }
}

function startHeartbeat() {
  if (!keepAliveEnabled) return
  try {
    new URL(keepAliveUrl)
  } catch (error) {
    heartbeat.enabled = false
    heartbeat.lastError = `保活地址无效：${error.message}`
    console.error(heartbeat.lastError)
    return
  }
  heartbeatTimer = setInterval(runHeartbeat, keepAliveIntervalMs)
  heartbeatTimer.unref()
  setTimeout(runHeartbeat, 5000).unref()
}

async function route(req, res) {
  if (req.method === 'OPTIONS') {
    applyHeaders(res)
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(302, { Location: '/admin' })
    res.end()
    return
  }
  if (url.pathname === '/health' && req.method === 'GET') return handleHealth(req, res)
  if (url.pathname === '/v1/models' && req.method === 'GET') return handleModels(req, res)
  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChat(req, res)
  if (url.pathname === '/admin' && req.method === 'GET') return handleAdminPage(req, res)
  if (url.pathname === '/admin/api/stats' && req.method === 'GET') return handleAdminStats(req, res)
  if (url.pathname === '/admin/api/model-links' && req.method === 'GET') return handleAdminModelLinks(req, res)
  if (url.pathname === '/admin/api/model-links' && req.method === 'POST') return handleAdminModelLinkCreate(req, res)
  if (url.pathname === '/admin/api/model-links/export' && req.method === 'GET') return handleAdminModelLinksExport(req, res)
  if (url.pathname === '/admin/api/model-links/pull-missing' && req.method === 'POST') return handleAdminModelLinksPullMissing(req, res)
  const modelLinkMatch = /^\/admin\/api\/model-links\/([^/]+)$/.exec(url.pathname)
  if (modelLinkMatch && ['GET', 'PUT', 'DELETE'].includes(req.method)) {
    let id
    try {
      id = decodeURIComponent(modelLinkMatch[1])
    } catch {
      throw new HttpError(400, '模型链接 ID 编码无效', 'invalid_value', 'id')
    }
    if (req.method === 'GET') return handleAdminModelLinkItem(req, res, id)
    if (req.method === 'PUT') return handleAdminModelLinkUpdate(req, res, id)
    return handleAdminModelLinkDelete(req, res, id)
  }
  if (url.pathname === '/admin/api/concurrency' && req.method === 'POST') return handleAdminConcurrency(req, res)
  if (url.pathname === '/admin/api/reset-usage' && req.method === 'POST') return handleAdminReset(req, res)
  if (url.pathname === '/admin/api/models/upload' && req.method === 'POST') return handleAdminUpload(req, res)
  if (url.pathname === '/admin/api/models/pull' && req.method === 'POST') return handleAdminPull(req, res)
  if (url.pathname === '/admin/api/models/download' && req.method === 'GET') return handleAdminDownload(req, res)
  if (url.pathname === '/admin/api/models/batch-download' && req.method === 'GET') return handleAdminBatchDownload(req, res)
  if (url.pathname === '/admin/api/models/load' && req.method === 'POST') return handleAdminLoad(req, res)
  if (url.pathname === '/admin/api/models/unload' && req.method === 'POST') return handleAdminUnload(req, res)
  if (url.pathname === '/admin/api/models/delete' && req.method === 'POST') return handleAdminDelete(req, res)
  if (url.pathname === '/admin/api/models/rename' && req.method === 'POST') return handleAdminRename(req, res)
  throw new HttpError(404, '接口不存在', 'not_found')
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  clearIdleTimer()
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (resourceTimer) clearInterval(resourceTimer)
  console.log('正在停止服务并释放模型资源…')
  server.close()
  const forceExit = setTimeout(() => process.exit(1), requestTimeoutMs + 10000)
  forceExit.unref()
  try {
    await queueTail
    await persistQueue
    await modelLinksWriteQueue
    await stopAllRuntimes()
  } finally {
    clearTimeout(forceExit)
    process.exit(0)
  }
}

async function main() {
  await fs.mkdir(modelDir, { recursive: true })
  await ensureModelLinksFile()
  try {
    await readModelLinksConfig()
  } catch (error) {
    console.error(`模型链接配置暂不可用：${error.message}`)
  }
  await fs.access(workerPath)
  adminHtml = await fs.readFile(path.join(projectRoot, 'admin.html'), 'utf8')
  startResourceMonitor()
  const models = await scanModels()
  console.log(`模型目录：${modelDir}`)
  console.log(`模型链接配置：${modelLinksFile}`)
  console.log(`发现 ${models.length} 个 GGUF 模型；热启动模式：${configuredHotModel ? `固定 ${configuredHotModel}` : '自动选择最常用模型'}`)

  server = http.createServer((req, res) => {
    route(req, res).catch((error) => sendError(res, error))
  })
  server.headersTimeout = 30000
  server.requestTimeout = 0
  server.keepAliveTimeout = 5000
  server.listen(port, host, () => {
    console.log(`API Key：${apiKey}`)
    console.log(`模型列表：${publicBaseUrl}/v1/models`)
    console.log(`聊天补全：${publicBaseUrl}/v1/chat/completions`)
    console.log(`管理控制台：${publicBaseUrl}/admin`)
    console.log(`监听：${host}:${port}`)
    console.log(`推理并发 ${maxConcurrency}，队列上限 ${maxQueue}；非热启动模型闲置 ${Math.round(modelIdleTimeoutMs / 1000)} 秒后自动回收；保活间隔 ${Math.round(keepAliveIntervalMs / 1000)} 秒`)
    startHeartbeat()
    warmHotModel().catch((error) => console.error(`热启动预热失败：${error.message}`))
  })
  server.on('error', (error) => {
    console.error(error)
    process.exit(1)
  })
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch(async (error) => {
  console.error(error)
  await stopAllRuntimes()
  process.exit(1)
})