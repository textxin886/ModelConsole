<template>
  <div class="panel-grid">
    <el-card class="panel full" shadow="hover">
      <div class="panel-heading">
        <div><h2>每日用量</h2><p>最多展示最近 14 天</p></div>
        <el-button text type="danger" :disabled="usageBusy" @click="clearUsage">清空累计</el-button>
      </div>
      <div class="table-shell">
        <el-table class="usage-table" :data="stats.daily" size="small" empty-text="暂无用量数据">
          <el-table-column prop="date" label="日期" min-width="130"></el-table-column>
          <el-table-column label="请求" min-width="100" align="right"><template #default="{ row }">{{ formatCompact(row.requests) }}</template></el-table-column>
          <el-table-column label="成功" min-width="100" align="right"><template #default="{ row }">{{ formatCompact(row.successfulRequests) }}</template></el-table-column>
          <el-table-column label="输入 Token" min-width="120" align="right"><template #default="{ row }">{{ formatCompact(row.promptTokens) }}</template></el-table-column>
          <el-table-column label="输出 Token" min-width="120" align="right"><template #default="{ row }">{{ formatCompact(row.completionTokens) }}</template></el-table-column>
          <el-table-column label="合计" min-width="110" align="right"><template #default="{ row }">{{ formatCompact(row.promptTokens + row.completionTokens) }}</template></el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-card class="panel full" shadow="hover">
      <div class="panel-heading"><div><h2>近期请求</h2><p>最多保留 {{ MAX_RECENT_REQUESTS }} 条，每页 20 条；仅记录 token、耗时和状态，不保存请求正文</p></div></div>
      <div class="table-shell">
        <el-table class="usage-table" :data="pagedRecent" size="small" empty-text="暂无请求记录">
          <el-table-column label="时间" min-width="165"><template #default="{ row }">{{ formatDate(row.timestamp) }}</template></el-table-column>
          <el-table-column label="模型" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.model || '—' }}</template></el-table-column>
          <el-table-column label="状态" min-width="90"><template #default="{ row }"><el-tag size="small" :type="row.status === 'success' ? 'success' : 'danger'">{{ row.status === 'success' ? '成功' : '失败' }}</el-tag></template></el-table-column>
          <el-table-column label="模式" min-width="90"><template #default="{ row }">{{ row.stream ? '流式' : '非流式' }}</template></el-table-column>
          <el-table-column label="输入" min-width="85" align="right"><template #default="{ row }">{{ formatCompact(row.promptTokens) }}</template></el-table-column>
          <el-table-column label="输出" min-width="85" align="right"><template #default="{ row }">{{ formatCompact(row.completionTokens) }}</template></el-table-column>
          <el-table-column label="耗时" min-width="100" align="right"><template #default="{ row }">{{ formatCompact(row.latencyMs) }} ms</template></el-table-column>
          <el-table-column label="结束原因" min-width="130"><template #default="{ row }">{{ row.status === 'success' ? (row.finishReason || 'stop') : (row.errorCode || 'error') }}</template></el-table-column>
        </el-table>
        <div style="display: flex; justify-content: flex-end; margin-top: 8px;">
          <el-pagination v-model:current-page="recentPage" :page-size="20" :total="(stats.recent || []).length" layout="prev, pager, next, total" />
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { request } from '../api'
import { stats, loadStats } from '../store'
import { formatCompact, formatDate } from '../utils'

const MAX_RECENT_REQUESTS = 500
const recentPage = ref(1)
const usageBusy = ref(false)

const pagedRecent = computed(() => {
  const list = stats.value.recent || []
  const start = Math.max(0, (recentPage.value - 1) * 20)
  return list.slice(start, start + 20)
})

async function clearUsage() {
  try {
    await ElMessageBox.confirm('确定清空全部累计、每日和近期请求统计吗？此操作不可撤销。', '清空累计用量', { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '取消' })
  } catch { return }
  usageBusy.value = true
  try {
    await request('/admin/api/reset-usage', { method: 'POST' })
    ElMessage.success('累计用量已清空')
    await loadStats()
  } catch (error) {
    ElMessage.error(error.message)
  } finally {
    usageBusy.value = false
  }
}
</script>
