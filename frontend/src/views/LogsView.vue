<template>
  <div class="panel-grid">
    <el-card class="panel full" shadow="hover">
      <div class="panel-heading">
        <div><h2>服务日志</h2><p>主进程与推理 worker 的控制台输出，自动按天滚分到 logs/ 目录；超过 20MB 或 14 天自动清理</p></div>
        <div class="panel-actions">
          <el-radio-group v-model="logStream" size="small">
            <el-radio-button value="server">主进程</el-radio-button>
            <el-radio-button value="worker">推理 Worker</el-radio-button>
          </el-radio-group>
          <el-button size="small" :loading="logLoading" @click="refreshLog">刷新</el-button>
          <el-button size="small" type="danger" plain @click="openLogCleanup">清理日志</el-button>
        </div>
      </div>
      <div class="log-viewer" ref="logViewerRef">
        <div v-if="logLoading && logLines.length === 0" class="log-empty">加载中…</div>
        <div v-else-if="logLines.length === 0" class="log-empty">暂无日志</div>
        <template v-else>
          <div v-for="(line, index) in logLines" :key="index" class="log-line" :class="`log-${line.level}`">
            <span class="log-time">{{ formatDate(line.t) }}</span>
            <span class="log-level">{{ line.level.toUpperCase() }}</span>
            <span class="log-text">{{ line.text }}</span>
          </div>
        </template>
      </div>
      <div class="metric-foot" style="margin-top: 4px;">共 {{ logLines.length }} 行 · 磁盘文件：{{ logFile || '-*-.log' }}</div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request } from '../api'
import { formatBytes, formatDate } from '../utils'

const logStream = ref('server')
const logLines = ref([])
const logFile = ref('')
const logLoading = ref(false)
const logViewerRef = ref(null)

async function refreshLog() {
  try {
    logLoading.value = true
    const data = await request(`/admin/api/logs?stream=${logStream.value}&n=100`)
    logLines.value = data.lines || []
    logFile.value = data.file || ''
    await nextTick()
    if (logViewerRef.value) logViewerRef.value.scrollTop = logViewerRef.value.scrollHeight
  } catch (error) {
    logLines.value = []
    logFile.value = ''
  } finally {
    logLoading.value = false
  }
}

async function openLogCleanup() {
  try {
    await ElMessageBox.confirm(
      '<p>选择清理策略：</p>' +
      '<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">' +
      '<label><input type="radio" name="lc" value="auto" checked> 自动（清理超过 14 天或超过 50 个文件的旧日志）</label>' +
      '<label><input type="radio" name="lc" value="age"> 按天数清理（保留最近 <input id="lc-days" size="3" value="7" style="width:48px"> 天）</label>' +
      '<label><input type="radio" name="lc" value="count"> 按数量清理（保留最近 <input id="lc-count" size="4" value="20" style="width:56px"> 个文件）</label>' +
      '<label><input type="radio" name="lc" value="all" style="color:#f56c6c"> <b>全部清空</b>（logs 目录下所有 .log 文件，不可恢复）</label>' +
      '</div>',
      '清理日志文件',
      {
        dangerouslyUseHTMLString: true,
        confirmButtonText: '执行清理',
        cancelButtonText: '取消',
        type: 'warning',
        distinguishCancelAndClose: true,
      }
    )
    const radio = document.querySelector('input[name="lc"]:checked')
    const mode = radio ? radio.value : 'auto'
    const days = Number(document.getElementById('lc-days')?.value) || 7
    const totalFiles = Number(document.getElementById('lc-count')?.value) || 20
    if (mode === 'all') {
      await ElMessageBox.confirm('确认要清空 logs/ 目录下所有日志文件吗？此操作不可撤销。', '全部清空', { type: 'error', confirmButtonText: '确认清空', cancelButtonText: '取消' })
    }
    const payload = { mode }
    if (mode === 'age') payload.days = days
    if (mode === 'count') payload.totalFiles = totalFiles
    const result = await request('/admin/api/logs', { method: 'POST', body: JSON.stringify(payload) })
    ElMessage.success(`清理完成：扫描 ${result.scanned} 个文件，删除 ${result.deleted} 个，释放 ${formatBytes(result.freedBytes)}`)
    await refreshLog()
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error.message)
  }
}

watch(logStream, () => refreshLog())
onMounted(() => refreshLog())
</script>
