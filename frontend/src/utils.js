const number = new Intl.NumberFormat('zh-CN')
const dateTime = new Intl.DateTimeFormat('zh-CN', { hour12: false })

export function emptyStats() {
  return {
    models: [],
    runtime: null,
    serverRssBytes: 0,
    memoryLimitBytes: 0,
    modelIdleTimeoutMs: 0,
    maxModelBytes: 0,
    maxConcurrencyLimit: 8,
    hotModelIds: [],
    hotModelPinned: false,
    system: {
      cpu: { usagePercent: 0, cores: 0, perCore: [], loadAverage: [0, 0, 0] },
      memory: { totalBytes: 0, freeBytes: 0, usedBytes: 0, runtimeBytes: 0 },
      disk: { totalBytes: 0, freeBytes: 0, usedBytes: 0, modelBytes: 0 },
    },
    transfer: null,
    publicBaseUrl: '',
    uptimeSeconds: 0,
    queue: { active: 0, queued: 0, maxActive: 1, queueTimeoutMs: 300000 },
    heartbeat: { enabled: false, lastSuccessAt: null, lastError: null },
    totals: { requests: 0, successfulRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    daily: [],
    recent: [],
  }
}

export function formatNumber(value) { return number.format(Number(value) || 0) }
export function formatCompact(value) {
  const count = Number(value) || 0
  if (count >= 1e9) return `${(count / 1e9).toFixed(2)}B`
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(2)}K`
  return formatNumber(count)
}
export function formatBytes(value) {
  const bytes = Number(value) || 0
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
}
export function percentValue(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))) }
export function formatPercent(value) { return `${percentValue(value)}%` }
export function pressureType(value) {
  const percent = percentValue(value)
  return percent >= 85 ? 'danger' : percent >= 60 ? 'warning' : 'success'
}
export function pressureColor(value) {
  const percent = percentValue(value)
  return percent >= 85 ? '#e05260' : percent >= 60 ? '#e6a23c' : '#18a05b'
}
export function formatUptime(seconds) {
  const value = Number(seconds) || 0
  const days = Math.floor(value / 86400)
  const hours = Math.floor(value % 86400 / 3600)
  const minutes = Math.floor(value % 3600 / 60)
  return days > 0 ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分`
}
export function formatDate(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date)
}
export function statusText(status) {
  return status === 'loaded' ? '运行中' : status === 'loading' ? '加载中' : '未加载'
}
export function statusType(status) {
  return status === 'loaded' ? 'success' : status === 'loading' ? 'warning' : 'info'
}
export function linkLocalStatusText(status) {
  return status === 'present' ? '已存在' : status === 'size_mismatch' ? '大小不一致' : '缺失'
}
export function linkLocalStatusType(status) {
  return status === 'present' ? 'success' : status === 'size_mismatch' ? 'warning' : 'danger'
}
export function transferStatusText(status) {
  return { queued: '排队中', connecting: '连接中', downloading: '下载中', verifying: '校验中', done: '完成', failed: '失败', aborted: '已停止' }[status] || status
}
export function transferStatusType(status) {
  if (status === 'done') return 'success'
  if (status === 'failed' || status === 'aborted') return 'danger'
  if (status === 'queued') return 'info'
  return 'warning'
}
export async function copyText(text) {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
  else {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}
