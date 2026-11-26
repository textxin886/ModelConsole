// 服务端注入的运行时配置（apiKey / adminKey / publicBaseUrl）
export const config = JSON.parse(document.getElementById('runtime-config').textContent)

export async function request(path, options = {}) {
  const headers = { Authorization: `Bearer ${config.adminKey}`, ...(options.headers || {}) }
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'
  const response = await fetch(path, { ...options, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`)
  return payload
}
