const path = require('node:path')

const defaultSystemPrompt = '你是一个乐于助人的中文助手。回答简洁、准确。'
let llama
let model
let context
let getLlama
let LlamaChatSession
let QwenChatWrapper
let GeneralChatWrapper
let resolveChatWrapper
let activeController
let shuttingDown = false

function send(message) {
  if (!process.send) return
  try {
    process.send(message, () => {})
  } catch {}
}

function serializeError(error) {
  return {
    message: error?.message || '推理失败',
    status: Number.isInteger(error?.status) ? error.status : 500,
    code: error?.code || 'inference_error',
    param: error?.param,
  }
}

async function disposeResources() {
  for (const resource of [context, model, llama]) {
    if (!resource) continue
    try {
      await resource.dispose()
    } catch (error) {
      console.error('推理资源释放失败：', error.message)
    }
  }
  context = undefined
  model = undefined
  llama = undefined
}

function createChatWrapper() {
  if (/qwen3[.-]?5/i.test(path.basename(model.filename))) {
    return new QwenChatWrapper({ variation: '3.5', thoughts: 'discourage' })
  }
  return resolveChatWrapper(model, { warningLogs: false }) ?? new GeneralChatWrapper()
}

function memoryStats() {
  return {
    rssBytes: process.memoryUsage().rss,
    modelBytes: model.size,
    contextMemory: context.memoryUsage,
  }
}

async function loadModel(message) {
  const llamaModule = await import('node-llama-cpp')
  getLlama = llamaModule.getLlama
  LlamaChatSession = llamaModule.LlamaChatSession
  QwenChatWrapper = llamaModule.QwenChatWrapper
  GeneralChatWrapper = llamaModule.GeneralChatWrapper
  resolveChatWrapper = llamaModule.resolveChatWrapper

  llama = await getLlama({ gpu: false, build: 'never', maxThreads: message.threads, logLevel: 'error' })
  model = await llama.loadModel({ modelPath: message.modelPath, gpuLayers: 0 })
  context = await model.createContext({
    contextSize: message.contextSize,
    sequences: 1,
    batchSize: 512,
    threads: message.threads,
  })

  const warmup = new LlamaChatSession({
    contextSequence: context.getSequence(),
    chatWrapper: createChatWrapper(),
    systemPrompt: defaultSystemPrompt,
    autoDisposeSequence: true,
  })
  try {
    await warmup.prompt('你好', { maxTokens: 1, temperature: 0 })
  } finally {
    warmup.dispose()
  }

  send({
    type: 'loaded',
    requestId: message.requestId,
    loadedAt: new Date().toISOString(),
    stats: memoryStats(),
  })
}

async function generate(message) {
  const controller = new AbortController()
  activeController = controller
  let session
  let streamedChunks = 0
  try {
    const options = message.options
    const estimatedInputTokens = model.tokenize([
      options.systemPrompt,
      ...options.history.map((item) => item.type === 'user' ? item.text : item.response.join('')),
      options.prompt,
    ].join('\n')).length + (options.history.length + 2) * 4 + 64
    if (estimatedInputTokens + options.maxTokens + 128 > context.contextSize) {
      const error = new Error('消息超出当前上下文窗口，请缩短历史或 max_tokens')
      error.status = 400
      error.code = 'context_length_exceeded'
      error.param = 'messages'
      throw error
    }

    const sequence = context.getSequence()
    session = new LlamaChatSession({
      contextSequence: sequence,
      chatWrapper: createChatWrapper(),
      systemPrompt: options.systemPrompt,
      autoDisposeSequence: true,
      contextShift: { strategy: 'eraseFirstResponseAndKeepFirstSystem' },
    })
    session.setChatHistory(options.history)
    const before = session.sequence.tokenMeter.getState()
    const result = await session.promptWithMeta(options.prompt, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      seed: options.seed,
      customStopTriggers: options.stop.length > 0 ? options.stop : undefined,
      trimWhitespaceSuffix: true,
      signal: controller.signal,
      onResponseChunk: options.stream ? (chunk) => {
        if (chunk.type === undefined && chunk.text) {
          streamedChunks += 1
          send({ type: 'chunk', requestId: message.requestId, text: chunk.text })
        }
      } : undefined,
    })
    const usage = session.sequence.tokenMeter.diff(before)
    if (options.stream && streamedChunks === 0 && result.responseText) {
      send({ type: 'chunk', requestId: message.requestId, text: result.responseText })
    }
    send({
      type: 'result',
      requestId: message.requestId,
      text: result.responseText,
      finishReason: result.stopReason === 'maxTokens' ? 'length' : 'stop',
      promptTokens: usage.usedInputTokens,
      completionTokens: usage.usedOutputTokens,
      stats: memoryStats(),
    })
  } catch (error) {
    send({ type: 'error', requestId: message.requestId, error: serializeError(error) })
  } finally {
    if (session) session.dispose()
    activeController = undefined
  }
}

async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  activeController?.abort(new Error('服务正在关闭'))
  await disposeResources()
  process.exit(0)
}

process.on('message', (message) => {
  if (shuttingDown) return
  if (message.type === 'load') {
    loadModel(message).catch((error) => send({ type: 'error', requestId: message.requestId, error: serializeError(error) }))
    return
  }
  if (message.type === 'generate') {
    generate(message).catch((error) => send({ type: 'error', requestId: message.requestId, error: serializeError(error) }))
    return
  }
  if (message.type === 'cancel') {
    if (activeController) activeController.abort(new Error('请求已取消'))
    return
  }
  if (message.type === 'shutdown') {
    shutdown().catch(() => process.exit(1))
  }
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('uncaughtException', (error) => {
  console.error(error)
  process.exit(1)
})
process.on('unhandledRejection', (error) => {
  console.error(error)
  process.exit(1)
})
