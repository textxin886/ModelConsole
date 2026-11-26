'use strict'
// llama-server 子进程管理：下载/解压 llama.cpp 官方二进制，spawn、看护、空闲回收，
// 并代理多模态请求（识图 chat / whisper 语音转写）。仅在 Linux 容器内启用。
const fsp = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const zlib = require('node:zlib')
const { spawn } = require('node:child_process')

const projectRoot = path.resolve(__dirname, '..')
const release = String(process.env.LLAMA_CPP_RELEASE || 'b5198').trim()
const downloadUrl = String(process.env.LLAMA_SERVER_URL || `https://github.com/ggml-org/llama.cpp/releases/download/${release}/llama-${release}-bin-ubuntu-x64.tar.gz`).trim()
const basePort = Number(process.env.LLAMA_SERVER_PORT || 8081)
const serverHost = '127.0.0.1'
const bootTimeoutMs = Number(process.env.LLAMA_SERVER_BOOT_TIMEOUT_MS || 180000)
const idleTimeoutMs = Number(process.env.MODEL_IDLE_TIMEOUT_MS || 300000)
const threads = Number(process.env.THREADS || 2)
const contextSize = Number(process.env.CONTEXT_SIZE || 4096)

const releaseDir = path.join(projectRoot, 'bin', 'llama', release)
const binDir = path.join(releaseDir, 'bin')
const libDir = path.join(releaseDir, 'lib')
const serverBin = path.join(binDir, 'llama-server')

// modelPath -> { port, proc, lastUsedAt, ready, stopping }
const instances = new Map()
let reaperTimer = null
let shuttingDown = false

// ---- 二进制获取与解压 ----

function httpsGet(url, redirects, handler, onError) {
  if (redirects > 6) return onError(new Error('下载地址重定向次数过多'))
  https.get(url, { headers: { 'User-Agent': 'rea-llama-server' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume()
      const next = new URL(res.headers.location, url).toString()
      return httpsGet(next, redirects + 1, handler, onError)
    }
    handler(res)
  }).on('error', onError)
}

async function downloadTarball(destFile) {
  await fsp.mkdir(path.dirname(destFile), { recursive: true })
  await new Promise((resolve, reject) => {
    httpsGet(downloadUrl, 0, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`下载 llama-server 失败：HTTP ${res.statusCode}（地址：${downloadUrl}，可用 LLAMA_CPP_RELEASE / LLAMA_SERVER_URL 调整版本或镜像）`))
      }
      const file = fsSync.createWriteStream(destFile)
      res.pipe(file)
      file.on('finish', () => file.close(() => resolve()))
      file.on('error', reject)
    }, reject)
  })
}

// 极简 tar 解析：只提取 llama-server 可执行文件与 lib 目录
function extractTarEntries(buffer) {
  const entries = []
  let offset = 0
  const cstr = (start, len) => {
    const slice = buffer.subarray(start, start + len)
    const end = slice.indexOf(0)
    return slice.toString('utf8', 0, end >= 0 ? end : len)
  }
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    let name = cstr(offset, 100)
    const prefix = cstr(offset + 345, 155)
    if (prefix) name = `${prefix}/${name}`
    const size = Number.parseInt((cstr(offset + 124, 12).trim() || '0'), 8) || 0
    const type = String.fromCharCode(header[156] || 0x30)
    const linkName = cstr(offset + 157, 100)
    const dataStart = offset + 512
    if (type === '0' || type === '2') entries.push({ name, type, linkName, data: buffer.subarray(dataStart, dataStart + size) })
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return entries
}

async function ensureBinary() {
  if (fsSync.existsSync(serverBin)) return
  await fsp.mkdir(releaseDir, { recursive: true })
  const tarFile = path.join(releaseDir, 'llama.tar.gz')
  console.log(`[llama-server] 下载 ${downloadUrl} ...`)
  await downloadTarball(tarFile)
  console.log('[llama-server] 解压中...')
  const tarBuffer = zlib.gunzipSync(await fsp.readFile(tarFile))
  let extracted = 0
  for (const entry of extractTarEntries(tarBuffer)) {
    const normalized = entry.name.replace(/\\/g, '/')
    if (normalized.endsWith('/bin/llama-server')) {
      await fsp.mkdir(binDir, { recursive: true })
      await fsp.writeFile(serverBin, entry.data)
      await fsp.chmod(serverBin, 0o755)
      extracted += 1
    } else if (normalized.includes('/lib/') && !normalized.endsWith('/')) {
      await fsp.mkdir(libDir, { recursive: true })
      const target = path.join(libDir, path.basename(normalized))
      if (entry.type === '2') {
        await fsp.symlink(entry.linkName, target).catch(() => {})
      } else {
        await fsp.writeFile(target, entry.data)
        await fsp.chmod(target, 0o755).catch(() => {})
      }
      extracted += 1
    }
  }
  await fsp.rm(tarFile, { force: true }).catch(() => {})
  if (!fsSync.existsSync(serverBin)) throw new Error('llama.cpp 压缩包内未找到 llama-server 可执行文件')
  console.log(`[llama-server] 就绪（${release}，解压 ${extracted} 个文件）`)
}

// ---- 实例生命周期 ----

function allocatePort() {
  const used = new Set([...instances.values()].map((instance) => instance.port))
  for (let port = basePort; port < basePort + 32; port += 1) if (!used.has(port)) return port
  throw new Error('llama-server 可用端口已耗尽')
}

function httpJson(port, pathname, method, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: serverHost, port, path: pathname, method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {} }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('请求超时')))
    request.on('error', reject)
    if (body) request.write(body)
    request.end()
  })
}

async function waitHealthy(port) {
  const deadline = Date.now() + bootTimeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await httpJson(port, '/health', 'GET', null, 3000)
      if (res.status === 200) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`llama-server 在 ${Math.round(bootTimeoutMs / 1000)} 秒内未就绪`)
}

// 在模型目录里寻找配套的 mmproj 视觉投影文件
function findMmproj(modelPath) {
  const dir = path.dirname(modelPath)
  const base = path.basename(modelPath, '.gguf').toLowerCase()
  let candidates = []
  try {
    candidates = fsSync.readdirSync(dir).filter((name) => /^mmproj.*\.gguf$/i.test(name))
  } catch { return null }
  if (!candidates.length) return null
  const tokens = base.split(/[-_.]/).filter((token) => token.length > 2 && !['gguf', 'q4', 'q5', 'q6', 'q8', 'f16', 'instruct', '2507'].includes(token))
  const scored = candidates
    .map((name) => ({ name, score: tokens.filter((token) => name.toLowerCase().includes(token)).length }))
    .sort((left, right) => right.score - left.score)
  if (scored[0].score > 0 || candidates.length === 1) return path.join(dir, scored[0].name)
  return null
}

async function getInstance(modelPath) {
  if (shuttingDown) throw new Error('服务正在关闭')
  startReaper()
  const existing = instances.get(modelPath)
  if (existing) {
    existing.lastUsedAt = Date.now()
    return existing
  }
  await ensureBinary()
  const port = allocatePort()
  const mmproj = findMmproj(modelPath)
  const args = ['--model', modelPath, '--host', serverHost, '--port', String(port), '--ctx-size', String(contextSize), '--threads', String(threads), '--no-webui']
  if (mmproj) args.push('--mmproj', mmproj)
  const env = { ...process.env, LD_LIBRARY_PATH: libDir + (process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : '') }
  console.log(`[llama-server] 启动：端口 ${port}，模型 ${path.basename(modelPath)}${mmproj ? ` + ${path.basename(mmproj)}` : ''}`)
  const proc = spawn(serverBin, args, { env })
  const instance = { port, proc, mmproj, lastUsedAt: Date.now(), ready: null, stopping: false }
  proc.stdout.on('data', (chunk) => console.log(`[llama-server:${port}] ${String(chunk).trimEnd()}`))
  proc.stderr.on('data', (chunk) => console.warn(`[llama-server:${port}] ${String(chunk).trimEnd()}`))
  proc.on('exit', (code, signal) => {
    instances.delete(modelPath)
    if (!instance.stopping && !shuttingDown) console.warn(`[llama-server:${port}] 意外退出（code=${code} signal=${signal}），下次请求会重新拉起`)
    if (instance.ready) instance.ready.reject(new Error(`llama-server 启动失败（code=${code}）`))
  })
  instances.set(modelPath, instance)
  instance.ready = waitHealthy(port).then(
    () => console.log(`[llama-server:${port}] 已就绪`),
    (error) => {
      instance.stopping = true
      proc.kill('SIGTERM')
      instances.delete(modelPath)
      throw error
    },
  )
  await instance.ready
  return instance
}

function stopInstance(instance) {
  instance.stopping = true
  try { instance.proc.kill('SIGTERM') } catch {}
}

function startReaper() {
  if (reaperTimer) return
  reaperTimer = setInterval(() => {
    const now = Date.now()
    for (const [modelPath, instance] of instances) {
      if (!instance.stopping && now - instance.lastUsedAt > idleTimeoutMs) {
        console.log(`[llama-server] 闲置超过 ${Math.round(idleTimeoutMs / 1000)} 秒，回收 ${path.basename(modelPath)}`)
        stopInstance(instance)
        instances.delete(modelPath)
      }
    }
  }, 30000)
  reaperTimer.unref()
}

function shutdownAll() {
  shuttingDown = true
  if (reaperTimer) clearInterval(reaperTimer)
  for (const instance of instances.values()) stopInstance(instance)
  instances.clear()
}

// ---- 请求代理 ----

// 原样转发 JSON/multipart 请求体，流式回传响应
function proxy(instance, pathname, contentType, bodyBuffer) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: serverHost, port: instance.port, path: pathname, method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': bodyBuffer.length } }, (res) => {
      resolve({ status: res.statusCode, headers: res.headers, stream: res })
    })
    request.setTimeout(Number(process.env.REQUEST_TIMEOUT_MS || 120000) + 30000, () => request.destroy(new Error('llama-server 请求超时')))
    request.on('error', reject)
    request.write(bodyBuffer)
    request.end()
  })
}

// 语音转写：用内存中的音频重新组装 multipart
function transcribe(instance, audioBuffer, { filename = 'audio.wav', mimeType = 'application/octet-stream', language, prompt } = {}) {
  const boundary = `----ReaForm${Date.now().toString(16)}`
  const parts = []
  const field = (name, value) => value ? Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`) : null
  const lang = field('language', language)
  const pr = field('prompt', prompt)
  if (lang) parts.push(lang)
  if (pr) parts.push(pr)
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`))
  parts.push(audioBuffer)
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`))
  const body = Buffer.concat(parts)
  return proxy(instance, '/v1/audio/transcriptions', `multipart/form-data; boundary=${boundary}`, body)
}

function status() {
  return {
    release,
    downloadUrl,
    installed: fsSync.existsSync(serverBin),
    basePort,
    instances: [...instances.values()].map((instance) => ({ port: instance.port, model: path.basename([...instances.entries()].find(([, value]) => value === instance)?.[0] || ''), mmproj: instance.mmproj ? path.basename(instance.mmproj) : null })),
  }
}

module.exports = { getInstance, proxy, transcribe, shutdownAll, status }
