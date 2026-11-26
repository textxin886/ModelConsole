<template>
  <div>
    <section class="metrics-grid" aria-label="服务概览">
      <el-card class="metric-card" shadow="hover">
        <div class="metric-label">累计 Token</div>
        <el-statistic :value="stats.totals.totalTokens" :formatter="formatCompact"></el-statistic>
        <div class="metric-foot">输入 {{ formatCompact(stats.totals.promptTokens) }} · 输出 {{ formatCompact(stats.totals.completionTokens) }}</div>
      </el-card>
      <el-card class="metric-card" shadow="hover">
        <div class="metric-label">累计请求</div>
        <el-statistic :value="stats.totals.requests" :formatter="formatCompact"></el-statistic>
        <div class="metric-foot">成功 {{ formatCompact(stats.totals.successfulRequests) }} · 失败 {{ formatCompact(stats.totals.failedRequests) }}</div>
      </el-card>
      <el-card class="metric-card" shadow="hover">
        <div class="metric-label">推理队列</div>
        <div class="metric-value">{{ stats.queue.active }} / {{ stats.queue.maxActive }}</div>
        <div class="metric-foot">等待 {{ stats.queue.queued }} · 最长排队 {{ queueTimeoutMinutes }} 分钟</div>
      </el-card>
      <el-card class="metric-card wide" shadow="hover">
        <div class="metric-label">服务运行</div>
        <div class="metric-value">{{ formatUptime(stats.uptimeSeconds) }}</div>
        <div class="metric-foot">{{ lastUpdated ? `更新于 ${formatDate(lastUpdated)}` : '等待首次刷新' }}</div>
      </el-card>
    </section>

    <section class="resource-grid" aria-label="本机资源">
      <el-card class="resource-card" shadow="hover">
        <div class="panel-heading">
          <div><h2>CPU</h2><p>{{ stats.system?.cpu?.container ? `容器配额 ${stats.system?.cpu?.cores || 0} 核（宿主 ${stats.system?.cpu?.hostCores || 0} 核）` : `${stats.system?.cpu?.cores || 0} 个逻辑核心` }}</p></div>
          <el-tag :type="pressureType(stats.system?.cpu?.usagePercent)" effect="plain">{{ formatPercent(stats.system?.cpu?.usagePercent) }}</el-tag>
        </div>
        <div class="resource-value">{{ formatPercent(stats.system?.cpu?.usagePercent) }}</div>
        <el-progress :percentage="percentValue(stats.system?.cpu?.usagePercent)" :color="pressureColor(stats.system?.cpu?.usagePercent)" :stroke-width="9"></el-progress>
        <div class="metric-foot">
          <template v-if="stats.system?.cpu?.container">折算占用 {{ Number(stats.system?.cpu?.coresUsed || 0).toFixed(2) }} 核 · 宿主机 1/5/15 分钟负载（参考）：{{ (stats.system?.cpu?.loadAverage || [0, 0, 0]).map((value) => Number(value).toFixed(2)).join(' / ') }}</template>
          <template v-else>1 / 5 / 15 分钟负载：{{ (stats.system?.cpu?.loadAverage || [0, 0, 0]).map((value) => Number(value).toFixed(2)).join(' / ') }}</template>
        </div>
        <div class="core-grid">
          <div v-for="(value, index) in (stats.system?.cpu?.perCore || [])" :key="index" class="core-item">
            <span>#{{ index + 1 }}</span>
            <div class="core-track"><i :style="{ width: percentValue(value) + '%', background: pressureColor(value) }"></i></div>
            <span>{{ formatPercent(value) }}</span>
          </div>
        </div>
      </el-card>

      <el-card class="resource-card" shadow="hover">
        <div class="panel-heading">
          <div><h2>内存</h2><p>系统与推理进程占用</p></div>
          <div style="display: flex; gap: 6px; align-items: center;">
            <el-tag v-if="stats.memoryPressure === 'hard'" type="danger" effect="dark" size="small">硬阈值 · 拒绝新请求</el-tag>
            <el-tag v-else-if="stats.memoryPressure === 'soft'" type="warning" effect="dark" size="small">软阈值 · 自动降级中</el-tag>
            <el-tag v-else type="success" effect="plain" size="small">健康</el-tag>
            <el-tag :type="pressureType(memoryPercent)" effect="plain">{{ formatPercent(memoryPercent) }}</el-tag>
          </div>
        </div>
        <div class="resource-value">{{ formatBytes(stats.system?.memory?.usedBytes) }} <span class="metric-foot">/ {{ formatBytes(stats.system?.memory?.totalBytes) }}</span></div>
        <el-progress :percentage="percentValue(memoryPercent)" :color="pressureColor(memoryPercent)" :stroke-width="9"></el-progress>
        <div v-if="stats.memoryThresholds" class="metric-foot">
          软限 {{ formatBytes(stats.memoryThresholds.softBytes) }} · 硬限 {{ formatBytes(stats.memoryThresholds.hardBytes) }}
          <template v-if="stats.memoryPressureAt"> · 上次切换 {{ formatDate(stats.memoryPressureAt) }}</template>
        </div>
        <div class="metric-foot">Node {{ formatBytes(stats.serverRssBytes) }} · 推理 {{ formatBytes(stats.system?.memory?.runtimeBytes) }} · 可用 {{ formatBytes(stats.system?.memory?.freeBytes) }}</div>
      </el-card>

      <el-card class="resource-card" shadow="hover">
        <div class="panel-heading">
          <div><h2>硬盘</h2><p>容器存储配额（自动探测）</p></div>
          <el-tag :type="pressureType(diskPercent)" effect="plain">{{ formatPercent(diskPercent) }}</el-tag>
        </div>
        <div class="resource-value">{{ formatBytes(stats.system?.disk?.usedBytes) }} <span class="metric-foot">/ {{ formatBytes(stats.system?.disk?.totalBytes) }}</span></div>
        <el-progress :percentage="percentValue(diskPercent)" :color="pressureColor(diskPercent)" :stroke-width="9"></el-progress>
        <div class="metric-foot">模型目录 {{ formatBytes(stats.system?.disk?.modelBytes) }} · 可用 {{ formatBytes(stats.system?.disk?.freeBytes) }}</div>
        <div v-if="stats.system?.disk?.scope" class="metric-foot">容量口径：{{ stats.system.disk.scope }}</div>
      </el-card>
    </section>

    <section class="panel-grid" style="margin-top: 16px;">
      <el-card class="panel" shadow="hover">
        <div class="panel-heading">
          <div><h2>运行与资源</h2><p>最常用模型常驻，其余实例按并发上限驻留并空闲回收</p></div>
          <el-tag :type="stats.runtime ? 'success' : 'info'" effect="plain">{{ stats.runtime ? (stats.runtime.status === 'loaded' ? '运行中' : '加载中') : '内存已回收' }}</el-tag>
        </div>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="当前模型" :span="2"><span class="description-value">{{ stats.runtime?.id || '未加载' }}</span></el-descriptions-item>
          <el-descriptions-item label="热启动模型" :span="2">
            <span v-if="(stats.hotModelIds || []).length === 0" class="description-value">未选择（全部模型按闲置回收）</span>
            <span v-else class="description-value">
              <el-tag v-for="id in stats.hotModelIds" :key="id" size="small" type="warning" effect="dark" style="margin: 2px 6px 2px 0;">{{ id }}</el-tag>
            </span>
            <el-tag v-if="stats.hotModelPinned" size="small" type="warning" effect="plain" style="margin-left: 6px;">HOT_MODEL 固定</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="总 RSS">{{ formatBytes(stats.runtime?.rssBytes ?? stats.serverRssBytes) }}</el-descriptions-item>
          <el-descriptions-item label="上下文大小">{{ stats.runtime?.contextSize ? formatCompact(stats.runtime.contextSize) : '—' }}</el-descriptions-item>
          <el-descriptions-item label="模型内存">{{ stats.runtime ? formatBytes(stats.runtime.modelBytes) : '—' }}</el-descriptions-item>
          <el-descriptions-item label="上下文内存">{{ stats.runtime ? formatBytes(stats.runtime.contextMemory?.ram || 0) : '—' }}</el-descriptions-item>
          <el-descriptions-item label="闲置回收">{{ Math.round(stats.modelIdleTimeoutMs / 1000) }} 秒</el-descriptions-item>
          <el-descriptions-item label="内存上限">{{ formatBytes(stats.memoryLimitBytes) }}<template v-if="stats.memoryThresholds"> · 软限 {{ formatBytes(stats.memoryThresholds.softBytes) }} · 硬限 {{ formatBytes(stats.memoryThresholds.hardBytes) }}</template></el-descriptions-item>
          <el-descriptions-item label="推理实例">{{ stats.runtime?.instanceCount || 0 }} 个</el-descriptions-item>
          <el-descriptions-item label="队列状态">活跃 {{ stats.queue.active }} · 排队 {{ stats.queue.queued }}</el-descriptions-item>
        </el-descriptions>
        <div class="metric-foot">自动按成功调用次数选择热模型；设置 HOT_MODEL 可固定指定模型。</div>
      </el-card>

      <el-card class="panel" shadow="hover">
        <div class="panel-heading">
          <div><h2>并发与排队</h2><p>超出并发上限的请求自动进入等待队列</p></div>
          <el-tag :type="stats.queue.queued > 0 ? 'warning' : 'success'" effect="plain">{{ stats.queue.queued > 0 ? `排队 ${stats.queue.queued}` : '无排队' }}</el-tag>
        </div>
        <div class="concurrency-control">
          <input v-model.number="concurrencyDraft" @focus="concurrencyDirty = true" class="el-input__inner concurrency-input" type="number" min="1" :max="stats.maxConcurrencyLimit || 8" :disabled="concurrencyBusy" aria-label="推理并发数">
          <el-button type="primary" :loading="concurrencyBusy" @click="applyConcurrency">应用并发</el-button>
        </div>
        <el-alert v-if="stats.queue.queued > 0" class="upload-status" :title="`当前有 ${stats.queue.queued} 个请求正在排队，活跃 ${stats.queue.active} / ${stats.queue.maxActive}`" type="warning" show-icon></el-alert>
        <div class="metric-foot">并发越高，CPU 争用和内存占用越大；系统会按内存预算阻止超额驻留。</div>
      </el-card>

      <el-card class="panel" shadow="hover">
        <div class="panel-heading">
          <div><h2>资源与地址</h2><p>OpenAI 兼容接口</p></div>
          <el-button text type="primary" @click="router.push('/models')">管理模型</el-button>
        </div>
        <div class="metric-label">聊天补全</div>
        <div class="endpoint-row"><code>{{ apiUrl }}</code><el-button text @click="doCopy(apiUrl)">复制</el-button></div>
        <div class="metric-label" style="margin-top: 16px;">模型列表</div>
        <div class="endpoint-row"><code>{{ modelsUrl }}</code><el-button text @click="doCopy(modelsUrl)">复制</el-button></div>
        <el-divider></el-divider>
        <div class="status-line"><span class="metric-label">请求方式</span><code>Authorization: Bearer &lt;key&gt;</code></div>
        <div class="status-line" style="margin-top: 10px;"><span class="metric-label">模型选择</span><span>请求 body.model 使用模型完整文件名</span></div>
        <div class="status-line" style="margin-top: 10px;"><span class="metric-label">模型数量</span><span>{{ stats.models.length }} 个 · 当前 {{ stats.runtime?.id || '无驻留模型' }}</span></div>
      </el-card>

      <el-card class="panel full" shadow="hover">
        <div class="panel-heading">
          <div><h2>访问密钥</h2><p>页面按个人使用需求直接展示密钥</p></div>
          <el-button type="primary" plain @click="doCopy(config.apiKey)">复制 API Key</el-button>
        </div>
        <div class="key-row"><code>{{ config.apiKey }}</code></div>
        <div class="metric-foot">控制台无需登录；公网部署时请自行配置访问白名单或反向代理鉴权。</div>
      </el-card>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { config, request } from '../api'
import { stats, lastUpdated, loadStats } from '../store'
import { formatCompact, formatBytes, formatUptime, formatDate, formatPercent, percentValue, pressureType, pressureColor, copyText } from '../utils'

const router = useRouter()
const concurrencyDraft = ref(1)
const concurrencyDirty = ref(false)
const concurrencyBusy = ref(false)

const memoryPercent = computed(() => {
  const memory = stats.value.system?.memory
  return memory?.totalBytes > 0 ? memory.usedBytes / memory.totalBytes * 100 : 0
})
const queueTimeoutMinutes = computed(() => Math.max(1, Math.round((stats.value.queue.queueTimeoutMs || 300000) / 60000)))
const diskPercent = computed(() => {
  const disk = stats.value.system?.disk
  return disk?.totalBytes > 0 ? disk.usedBytes / disk.totalBytes * 100 : 0
})
const apiUrl = computed(() => `${stats.value.publicBaseUrl || config.publicBaseUrl}/v1/chat/completions`)
const modelsUrl = computed(() => `${stats.value.publicBaseUrl || config.publicBaseUrl}/v1/models`)

watch(() => stats.value.queue.maxActive, (value) => {
  if (!concurrencyBusy.value && !concurrencyDirty.value && value) concurrencyDraft.value = value
}, { immediate: true })

async function doCopy(text) {
  try {
    await copyText(text)
    ElMessage.success('已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择文本')
  }
}

async function applyConcurrency() {
  concurrencyBusy.value = true
  try {
    const payload = await request('/admin/api/concurrency', {
      method: 'POST',
      body: JSON.stringify({ concurrency: concurrencyDraft.value }),
    })
    stats.value.queue = payload.queue
    concurrencyDirty.value = false
    ElMessage.success(`推理并发已设置为 ${payload.queue.maxActive}`)
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    concurrencyBusy.value = false
  }
}
</script>
