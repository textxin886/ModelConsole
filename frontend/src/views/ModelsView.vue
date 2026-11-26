<template>
  <div class="panel-grid">
    <el-card class="panel full" shadow="hover">
      <div class="panel-heading">
        <div><h2>模型链接</h2><p>保存于 {{ modelLinksFile }}；添加后可直接拉取，拉取成功自动记录校验信息，删除记录不影响本地文件</p></div>
        <el-tag effect="plain">{{ enabledLinkCount }} 启用 · {{ missingLinkCount }} 缺失</el-tag>
      </div>
      <div class="page-toolbar">
        <span class="metric-foot">差异化拉取只下载启用且本地缺失的模型，不覆盖或删除已有文件。</span>
        <div class="toolbar-actions">
          <el-button :disabled="linkBusy || syncingLinks" @click="openLinkEditor()">新增模型链接</el-button>
          <el-button tag="a" type="primary" href="/admin/api/model-links/export" download>导出备份</el-button>
          <el-button type="success" :loading="syncingLinks" :disabled="syncingLinks || linkBusy" @click="pullMissingLinks">一键差异化拉取</el-button>
        </div>
      </div>
      <el-alert v-if="modelLinksError" class="upload-status" :title="modelLinksError" type="error" show-icon closable @close="modelLinksError = ''"></el-alert>
      <el-alert v-else-if="syncError" class="upload-status" :title="syncError" type="warning" show-icon closable @close="syncError = ''"></el-alert>
      <el-alert v-else-if="syncMessage" class="upload-status" :title="syncMessage" type="success" show-icon closable @close="syncMessage = ''"></el-alert>
      <div class="table-shell">
        <el-table v-loading="linkLoading" class="link-config-table" :data="modelLinks" row-key="id" empty-text="暂无模型链接，点击「新增模型链接」开始">
          <el-table-column label="启用" width="82" align="center">
            <template #default="{ row }"><el-switch :model-value="row.enabled" :loading="linkActionId === row.id" :disabled="linkBusy || syncingLinks" @change="toggleModelLink(row, $event)"></el-switch></template>
          </el-table-column>
          <el-table-column label="模型文件" min-width="250"><template #default="{ row }"><span class="model-id" :title="row.id">{{ row.id }}</span></template></el-table-column>
          <el-table-column label="下载链接" min-width="360" show-overflow-tooltip><template #default="{ row }"><span class="link-url">{{ row.url }}</span></template></el-table-column>
          <el-table-column label="完整性校验" min-width="165">
            <template #default="{ row }">
              <div>{{ row.sizeBytes ? formatBytes(row.sizeBytes) : '大小未校验' }}</div>
              <code>{{ row.sha256 ? `${row.sha256.slice(0, 12)}…` : '未设置 SHA-256' }}</code>
            </template>
          </el-table-column>
          <el-table-column label="本地状态" min-width="135">
            <template #default="{ row }"><el-tag size="small" :type="linkLocalStatusType(row.localStatus)">{{ linkLocalStatusText(row.localStatus) }}</el-tag><div v-if="row.localStatus === 'size_mismatch'" class="metric-foot">本地 {{ formatBytes(row.localSizeBytes) }}</div></template>
          </el-table-column>
          <el-table-column label="最近拉取" min-width="165"><template #default="{ row }">{{ formatDate(row.lastPulledAt) }}</template></el-table-column>
          <el-table-column label="操作" min-width="230" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <el-button size="small" type="success" :loading="pullingLink === row.id" :disabled="linkBusy || transferStatusNames.has(String(row.id).toLowerCase()) || row.localStatus === 'present'" @click="pullSingleLink(row.id)">拉取</el-button>
                <el-button size="small" :disabled="linkBusy || syncingLinks" @click="openLinkEditor(row)">编辑</el-button>
                <el-button size="small" type="danger" plain :disabled="linkBusy || syncingLinks" @click="deleteModelLink(row)">删除记录</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="metric-foot">手动从 URL 拉取成功后也会自动写入本列表；下载完成后会校验文件大小与 SHA-256。</div>
    </el-card>

    <el-card v-if="transferBusy || finishedTasks.length" class="panel full" shadow="hover">
      <div class="panel-heading">
        <div><h2>模型下载队列</h2><p>下载在后台排队执行，刷新页面状态仍在；完成后记录保留，可手动清空</p></div>
        <el-tag :type="activeTask ? 'warning' : queuedTasks.length ? 'info' : 'success'" effect="plain">{{ activeTask ? `下载中 ${pullPercent}%` : queuedTasks.length ? `排队 ${queuedTasks.length}` : '空闲' }}</el-tag>
      </div>
      <div class="page-toolbar">
        <span class="metric-foot">同一时间只跑一个下载，其余自动排队等待。</span>
        <div class="toolbar-actions">
          <el-button size="small" type="danger" plain :disabled="!transferBusy" @click="abortAllTransfers">停止下载</el-button>
          <el-button size="small" :disabled="!finishedTasks.length" @click="clearTransfers">清空记录</el-button>
        </div>
      </div>
      <div v-if="activeTask" class="metric-foot" style="margin-bottom: 12px;">正在下载 {{ activeTask.filename || activeTask.name }}（{{ transferStatusText(activeTask.status) }}）：已下载 {{ formatBytes(activeTask.receivedBytes) }}{{ activeTask.totalBytes ? ` / ${formatBytes(activeTask.totalBytes)}` : '' }}</div>
      <el-progress v-if="activeTask && pullPercent > 0" :percentage="pullPercent" :stroke-width="10" style="margin-bottom: 14px;"></el-progress>
      <div v-if="queuedTasks.length" class="metric-foot" style="margin-bottom: 12px;">排队等待：{{ queuedTasks.map((task) => task.name || task.filename || '未命名').join('、') }}</div>
      <div v-if="finishedTasks.length" class="table-shell">
        <el-table :data="finishedTasks" size="small" row-key="id">
          <el-table-column label="模型" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.filename || row.name || row.url }}</template></el-table-column>
          <el-table-column label="状态" width="90"><template #default="{ row }"><el-tag size="small" :type="transferStatusType(row.status)">{{ transferStatusText(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="大小 / 结果" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.status === 'done' ? formatBytes(row.sizeBytes) : (row.error || '—') }}</template></el-table-column>
          <el-table-column label="完成时间" min-width="150"><template #default="{ row }">{{ formatDate(row.finishedAt) }}</template></el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-card class="panel full" shadow="hover">
      <div class="panel-heading">
        <div><h2>模型目录</h2><p>共 {{ stats.models.length }} 个模型，搜索到 {{ filteredModels.length }} 个；文件名即模型 ID</p></div>
        <el-tag effect="plain">单文件上限 {{ formatBytes(stats.maxModelBytes) }}</el-tag>
      </div>
      <div class="page-toolbar">
        <el-input v-model="modelSearch" class="search-input" clearable placeholder="搜索模型文件名或模型名称">
          <template #prefix><span aria-hidden="true">⌕</span></template>
        </el-input>
        <div class="toolbar-actions">
          <input ref="fileInput" type="file" accept=".gguf" hidden>
          <el-button type="primary" :disabled="uploading" @click="selectFile">选择 GGUF 模型</el-button>
          <el-button type="success" :loading="uploading" :disabled="uploading" @click="uploadModel">上传模型</el-button>
        </div>
      </div>
      <el-progress v-if="uploading" :percentage="uploadPercent" :stroke-width="10" style="margin-bottom: 14px;"></el-progress>
      <el-alert v-if="uploadError" class="upload-status" :title="uploadError" type="error" show-icon closable @close="uploadError = ''"></el-alert>
      <el-alert v-else-if="uploadMessage" class="upload-status" :title="uploadMessage" type="success" show-icon closable @close="uploadMessage = ''"></el-alert>
      <div class="selection-actions" style="margin-bottom: 12px;">
        <el-button size="small" :disabled="filteredModels.length === 0" @click="toggleAllVisible(true)">全选当前</el-button>
        <el-button size="small" :disabled="selectedModels.length === 0" @click="selectedModels = []">清空选择</el-button>
        <el-button tag="a" size="small" type="primary" :href="selectedModels.length ? batchDownloadUrl : undefined" :disabled="selectedModels.length === 0">批量下载 ZIP（{{ selectedModels.length }}）</el-button>
        <span class="metric-foot">批量下载会在服务器端流式打包，不额外占用模型内存。</span>
      </div>
      <div class="table-shell">
        <el-table v-loading="loading" class="model-table" :data="filteredModels" row-key="id" empty-text="暂无模型，请先上传 GGUF 文件或拉取链接">
          <el-table-column width="46" align="center">
            <template #header><el-checkbox :model-value="allVisibleSelected" :indeterminate="someVisibleSelected" :disabled="filteredModels.length === 0" @change="toggleAllVisible"></el-checkbox></template>
            <template #default="{ row }"><el-checkbox :model-value="selectedModels.includes(row.id)" @change="toggleModel(row.id, $event)"></el-checkbox></template>
          </el-table-column>
          <el-table-column label="模型文件" min-width="280"><template #default="{ row }"><span class="model-id" :title="row.id">{{ row.id }}</span></template></el-table-column>
          <el-table-column label="类型" width="120"><template #default="{ row }"><el-tag v-for="cap in (row.capabilities || ['text'])" :key="cap" size="small" :type="capabilityType(cap)" style="margin: 1px 4px 1px 0;">{{ capabilityText(cap) }}</el-tag></template></el-table-column>
          <el-table-column label="大小" min-width="110" align="right"><template #default="{ row }">{{ formatBytes(row.sizeBytes) }}</template></el-table-column>
          <el-table-column label="状态" min-width="150"><template #default="{ row }"><el-tag size="small" :type="statusType(row.status)">{{ statusText(row.status) }}</el-tag><el-tag v-if="row.isHot" size="small" type="warning" effect="dark" style="margin-left: 6px;">热启动</el-tag></template></el-table-column>
          <el-table-column label="创建时间" min-width="170"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
          <el-table-column label="最近使用" min-width="170"><template #default="{ row }">{{ row.lastUsedAt ? formatDate(row.lastUsedAt) : '—' }}</template></el-table-column>
          <el-table-column label="上下文" min-width="100" align="right"><template #default="{ row }">{{ row.contextSize ? formatCompact(row.contextSize) : '—' }}</template></el-table-column>
          <el-table-column label="操作" min-width="500" fixed="right">
            <template #default="{ row }">
              <div class="row-actions">
                <a :href="modelDownloadUrl(row)" title="下载模型"><el-button size="small">下载</el-button></a>
                <el-button size="small" :type="row.status === 'unloaded' ? 'primary' : 'warning'" plain :loading="actionModel === row.id" :disabled="(hotModelLoading || actionLoading) && actionModel !== row.id" @click="modelAction(row.status === 'unloaded' ? 'load' : 'unload', row)">{{ row.status === 'unloaded' ? '加载' : '卸载' }}</el-button>
                <el-button size="small" :type="row.isHot ? 'warning' : 'default'" :disabled="stats.hotModelPinned || hotModelLoading" :loading="hotModelLoading" @click="toggleHotModel(row.id)">{{ row.isHot ? '取消热启动' : '设为热启动' }}</el-button>
                <el-button size="small" :disabled="row.status === 'loading' || actionLoading" @click="openRename(row)">重命名</el-button>
                <el-button size="small" type="danger" plain :disabled="row.status === 'loading' || actionLoading" @click="modelAction('delete', row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="metric-foot">模型从 models 目录自动发现；热启动模型保持常驻，其余推理实例闲置后自动回收。</div>
    </el-card>

    <el-dialog v-model="renameDialog" title="重命名模型" width="min(500px, calc(100vw - 28px))" @closed="renameName = ''">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="当前模型"><code>{{ renameModel?.id || '—' }}</code></el-form-item>
        <el-form-item label="新文件名" required>
          <el-input v-model="renameName" maxlength="240" clearable autofocus placeholder="例如：中文决策模型.gguf" @keyup.enter="confirmRename"></el-input>
        </el-form-item>
        <div class="dialog-tip">名称将直接作为新的模型 ID，必须以 .gguf 结尾，且不能包含路径或非法字符。</div>
      </el-form>
      <template #footer>
        <el-button @click="renameDialog = false">取消</el-button>
        <el-button type="primary" :loading="renaming" @click="confirmRename">保存名称</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="linkDialog" :title="linkDialogTitle" width="min(640px, calc(100vw - 28px))" @closed="resetLinkEditor">
      <el-form label-position="top" @submit.prevent>
        <div class="link-form-grid">
          <el-form-item label="模型下载地址" required class="full">
            <el-input v-model="linkForm.url" clearable placeholder="https://huggingface.co/.../resolve/main/model.gguf" @blur="suggestFilename"></el-input>
          </el-form-item>
          <el-form-item label="保存文件名" required class="full">
            <el-input v-model="linkForm.id" maxlength="240" clearable placeholder="例如：Qwen3.5-2B-Q4_K_M.gguf"></el-input>
          </el-form-item>
          <el-form-item label="参与差异拉取" class="full">
            <el-switch v-model="linkForm.enabled"></el-switch>
          </el-form-item>
          <el-form-item v-if="!linkEditingId" label="保存后立即从 URL 拉取" class="full">
            <el-switch v-model="linkForm.autoPull"></el-switch>
          </el-form-item>
        </div>
        <div class="dialog-tip">文件名将作为本地模型 ID；地址仅支持公网 HTTP/HTTPS，下载完成后自动记录大小与 SHA-256 用于完整性校验，无需手动填写。</div>
      </el-form>
      <template #footer>
        <el-button @click="linkDialog = false">取消</el-button>
        <el-button type="primary" :loading="linkBusy" @click="saveModelLink">{{ linkEditingId ? '保存修改' : (linkForm.autoPull ? '保存并拉取' : '保存配置') }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { config, request } from '../api'
import { stats, loading, loadStats, activeTask, queuedTasks, finishedTasks, transferBusy, transferTasks, pullPercent } from '../store'
import { formatCompact, formatBytes, formatDate, statusText, statusType, linkLocalStatusText, linkLocalStatusType, transferStatusText, transferStatusType } from '../utils'

const modelSearch = ref('')
const fileInput = ref(null)
const uploading = ref(false)
const uploadPercent = ref(0)
const uploadMessage = ref('')
const uploadError = ref('')
const selectedModels = ref([])
const actionLoading = ref(false)
const actionModel = ref('')
const hotModelLoading = ref(false)
const renameDialog = ref(false)
const renameName = ref('')
const renameModel = ref(null)
const renaming = ref(false)

const modelLinks = ref([])
const modelLinksFile = ref('models.config.jsonl')
const linkLoading = ref(false)
const modelLinksError = ref('')
const linkBusy = ref(false)
const linkActionId = ref('')
const syncingLinks = ref(false)
const syncMessage = ref('')
const syncError = ref('')
const linkDialog = ref(false)
const linkEditingId = ref(null)
const linkForm = ref({ id: '', url: '', enabled: true, autoPull: true })
const pullingLink = ref('')

const filteredModels = computed(() => {
  const query = modelSearch.value.trim().toLowerCase()
  if (!query) return stats.value.models
  return stats.value.models.filter((item) => item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query))
})
const allVisibleSelected = computed(() => filteredModels.value.length > 0 && filteredModels.value.every((item) => selectedModels.value.includes(item.id)))
const someVisibleSelected = computed(() => filteredModels.value.some((item) => selectedModels.value.includes(item.id)) && !allVisibleSelected.value)
const batchDownloadUrl = computed(() => {
  const params = new URLSearchParams()
  selectedModels.value.forEach((id) => params.append('model', id))
  return `/admin/api/models/batch-download?${params.toString()}`
})
const enabledLinkCount = computed(() => modelLinks.value.filter((item) => item.enabled).length)
const missingLinkCount = computed(() => modelLinks.value.filter((item) => item.enabled && item.localStatus === 'missing').length)
const linkDialogTitle = computed(() => linkEditingId.value ? '编辑模型链接' : '新增模型链接')
const transferStatusNames = computed(() => new Set(transferTasks.value.filter((task) => !['done', 'failed', 'aborted'].includes(task.status)).map((task) => String(task.name || '').toLowerCase())))

async function loadModelLinks() {
  if (linkLoading.value) return
  linkLoading.value = true
  try {
    const payload = await request('/admin/api/model-links')
    modelLinks.value = payload.models
    modelLinksFile.value = payload.file
    modelLinksError.value = ''
  } catch (error) {
    modelLinksError.value = `链接配置加载失败：${error.message}`
  } finally {
    linkLoading.value = false
  }
}

onMounted(() => { loadModelLinks() })

function modelDownloadUrl(row) {
  return `/admin/api/models/download?model=${encodeURIComponent(row.id)}`
}

function capabilityText(cap) {
  return { text: '文本', vision: '识图', transcription: '语音转写', image: '图生' }[cap] || cap
}
function capabilityType(cap) {
  return { text: 'info', vision: 'success', transcription: 'warning', image: 'danger' }[cap] || 'info'
}

function toggleModel(id, checked) {
  selectedModels.value = checked
    ? [...new Set([...selectedModels.value, id])]
    : selectedModels.value.filter((item) => item !== id)
}

function toggleAllVisible(checked) {
  const visible = new Set(filteredModels.value.map((item) => item.id))
  selectedModels.value = checked
    ? [...new Set([...selectedModels.value, ...visible])]
    : selectedModels.value.filter((id) => !visible.has(id))
}

async function abortAllTransfers() {
  try {
    const payload = await request('/admin/api/transfer/abort', { method: 'POST', body: JSON.stringify({ all: true }) })
    ElMessage.warning(payload.stopped ? `已停止 ${payload.stopped} 个下载任务` : '没有正在进行的下载')
    await loadStats()
  } catch (error) {
    ElMessage.error(error.message)
  }
}

async function clearTransfers() {
  try {
    await request('/admin/api/transfer/clear', { method: 'POST' })
    ElMessage.success('已清空下载记录')
    await loadStats()
  } catch (error) {
    ElMessage.error(error.message)
  }
}

function resetLinkEditor() {
  linkEditingId.value = null
  linkForm.value = { id: '', url: '', enabled: true, autoPull: true }
}

function openLinkEditor(row) {
  linkEditingId.value = row?.id || null
  linkForm.value = {
    id: row?.id || '',
    url: row?.url || '',
    enabled: row?.enabled ?? true,
    autoPull: true,
  }
  linkDialog.value = true
}

// 新增时按 URL 自动猜测文件名
function suggestFilename() {
  if (linkEditingId.value || linkForm.value.id.trim()) return
  try {
    const target = new URL(linkForm.value.url.trim())
    const base = decodeURIComponent(target.pathname.split('/').pop() || '')
    if (/\.gguf$/i.test(base)) linkForm.value.id = base
  } catch {}
}

async function saveModelLink() {
  const id = linkForm.value.id.trim()
  const url = linkForm.value.url.trim()
  if (!/\.gguf$/i.test(id)) {
    ElMessage.warning('保存文件名必须以 .gguf 结尾')
    return
  }
  if (/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(id)) {
    ElMessage.warning('保存文件名包含路径或非法字符')
    return
  }
  try {
    const target = new URL(url)
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('invalid')
  } catch {
    ElMessage.warning('请填写不带账号密码的 HTTP/HTTPS 模型地址')
    return
  }
  linkBusy.value = true
  try {
    const editingId = linkEditingId.value
    await request(editingId ? `/admin/api/model-links/${encodeURIComponent(editingId)}` : '/admin/api/model-links', {
      method: editingId ? 'PUT' : 'POST',
      body: JSON.stringify({ id, url, enabled: linkForm.value.enabled }),
    })
    linkDialog.value = false
    ElMessage.success(editingId ? '模型链接已更新' : '模型链接已新增')
    if (!editingId && linkForm.value.autoPull) {
      try {
        const payload = await request(`/admin/api/model-links/${encodeURIComponent(id)}/pull`, { method: 'POST' })
        ElMessage.success(`已入队下载：${payload.task.name || id}`)
      } catch (error) {
        if (/已存在/.test(error.message)) ElMessage.info(`链接已保存，${error.message}`)
        else ElMessage.warning(`链接已保存，但拉取失败：${error.message}`)
      }
    }
    await Promise.all([loadModelLinks(), loadStats()])
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    linkBusy.value = false
  }
}

async function toggleModelLink(row, enabled) {
  linkBusy.value = true
  linkActionId.value = row.id
  try {
    await request(`/admin/api/model-links/${encodeURIComponent(row.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    })
    ElMessage.success(enabled ? '已启用差异拉取' : '已停用差异拉取')
    await loadModelLinks()
  } catch (error) {
    ElMessage.error(error.message)
    await loadModelLinks()
  } finally {
    linkBusy.value = false
    linkActionId.value = ''
  }
}

async function deleteModelLink(row) {
  try {
    await ElMessageBox.confirm(`确定删除 ${row.id} 的链接记录吗？本地模型文件不会被删除。`, '删除链接记录', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' })
  } catch { return }
  linkBusy.value = true
  linkActionId.value = row.id
  try {
    await request(`/admin/api/model-links/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
    ElMessage.success('链接记录已删除')
    await loadModelLinks()
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    linkBusy.value = false
    linkActionId.value = ''
  }
}

async function pullMissingLinks() {
  if (missingLinkCount.value === 0) {
    ElMessage.info('没有启用且本地缺失的模型')
    return
  }
  syncingLinks.value = true
  syncMessage.value = ''
  syncError.value = ''
  try {
    const payload = await request('/admin/api/model-links/pull-missing', { method: 'POST' })
    syncMessage.value = `已入队 ${payload.queued} 个缺失模型，进度见下方“模型下载队列”`
    const blocked = (payload.skipped || []).filter((item) => ['size_mismatch', 'no_url'].includes(item.status))
    if (blocked.length) {
      syncError.value = blocked.map((item) => `${item.id}：${item.status === 'size_mismatch' ? '本地大小与配置不一致' : '缺少下载地址'}`).join('；')
      ElMessage.warning('部分链接无法入队')
    } else {
      ElMessage.success('缺失模型已入队下载')
    }
    await loadStats()
  } catch (error) {
    syncError.value = `差异拉取失败：${error.message}`
  } finally {
    syncingLinks.value = false
  }
}

async function pullSingleLink(id) {
  pullingLink.value = id
  try {
    const payload = await request(`/admin/api/model-links/${encodeURIComponent(id)}/pull`, { method: 'POST' })
    ElMessage.success(`已入队下载：${payload.task.name || id}`)
    await loadStats()
  } catch (error) {
    ElMessage.error(`${id}：${error.message}`)
  } finally {
    pullingLink.value = ''
  }
}

function selectFile() {
  fileInput.value?.click()
}

function uploadModel() {
  const file = fileInput.value?.files?.[0]
  if (!file) {
    ElMessage.warning('请先选择一个 .gguf 文件')
    return
  }
  if (!/\.gguf$/i.test(file.name)) {
    uploadError.value = '仅支持 .gguf 模型文件'
    return
  }
  const formData = new FormData()
  formData.append('model', file)
  const xhr = new XMLHttpRequest()
  uploading.value = true
  uploadPercent.value = 0
  uploadError.value = ''
  uploadMessage.value = ''
  xhr.open('POST', '/admin/api/models/upload')
  xhr.setRequestHeader('Authorization', `Bearer ${config.adminKey}`)
  xhr.upload.addEventListener('progress', (event) => {
    if (event.lengthComputable) uploadPercent.value = Math.round(event.loaded / event.total * 100)
  })
  xhr.addEventListener('load', async () => {
    uploading.value = false
    try {
      const payload = JSON.parse(xhr.responseText)
      if (xhr.status < 200 || xhr.status >= 300) throw new Error(payload.error?.message || `HTTP ${xhr.status}`)
      uploadMessage.value = `上传完成：${payload.model.id}`
      if (fileInput.value) fileInput.value.value = ''
      ElMessage.success('模型上传成功')
      await loadStats()
    } catch (error) {
      uploadError.value = `上传失败：${error.message}`
    }
  })
  xhr.addEventListener('error', () => {
    uploading.value = false
    uploadError.value = '上传失败：网络连接中断'
  })
  xhr.addEventListener('abort', () => {
    uploading.value = false
    uploadMessage.value = '上传已取消'
  })
  xhr.send(formData)
}

async function modelAction(action, row) {
  if (action === 'delete') {
    try {
      await ElMessageBox.confirm(`确定删除模型文件 ${row.id} 吗？此操作不可撤销。`, '删除模型', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' })
    } catch { return }
  }
  if (action === 'unload') {
    try {
      await ElMessageBox.confirm(`确定卸载 ${row.id} 并立即回收内存吗？`, '卸载模型', { confirmButtonText: '确认卸载', cancelButtonText: '取消' })
    } catch { return }
  }
  actionLoading.value = true
  actionModel.value = row.id
  try {
    await request(`/admin/api/models/${action}`, { method: 'POST', body: JSON.stringify({ model: row.id }) })
    ElMessage.success(action === 'load' ? '模型加载成功' : action === 'unload' ? '模型已卸载，内存已回收' : '模型已删除')
    await Promise.all([loadStats(), loadModelLinks()])
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    actionLoading.value = false
    actionModel.value = ''
  }
}

async function toggleHotModel(id) {
  try {
    const current = new Set(stats.value.hotModelIds || [])
    if (current.has(id)) current.delete(id)
    else current.add(id)
    hotModelLoading.value = true
    const payload = await request('/admin/api/hot-models', {
      method: 'POST',
      body: JSON.stringify({ modelIds: [...current] }),
    })
    stats.value.hotModelIds = payload.hotModelIds
    ElMessage.success(payload.hotModelIds.length === 0 ? '已清除全部热启动模型' : `热启动模型已更新：${payload.hotModelIds.length} 个`)
    await loadStats()
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    hotModelLoading.value = false
  }
}

function openRename(row) {
  renameModel.value = row
  renameName.value = row.id
  renameDialog.value = true
}

async function confirmRename() {
  const name = renameName.value.trim()
  if (!/\.gguf$/i.test(name)) {
    ElMessage.warning('新文件名必须以 .gguf 结尾')
    return
  }
  if (/[\\/\u0000-\u001f\u007f<>:"|?*]/.test(name)) {
    ElMessage.warning('新文件名包含路径或非法字符')
    return
  }
  renaming.value = true
  try {
    await request('/admin/api/models/rename', { method: 'POST', body: JSON.stringify({ model: renameModel.value.id, name }) })
    renameDialog.value = false
    ElMessage.success(`模型已重命名为 ${name}`)
    await Promise.all([loadStats(), loadModelLinks()])
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    renaming.value = false
  }
}
</script>
