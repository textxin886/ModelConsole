// 跨视图共享的服务端状态（模块级单例，路由切换不丢失）
import { ref, computed } from 'vue'
import { request } from './api'
import { emptyStats } from './utils'

export const stats = ref(emptyStats())
export const loading = ref(false)
export const loadError = ref('')
export const lastUpdated = ref(null)

export const transferTasks = computed(() => stats.value.transfer?.tasks || [])
export const activeTask = computed(() => stats.value.transfer?.active || null)
export const queuedTasks = computed(() => transferTasks.value.filter((task) => task.status === 'queued'))
export const finishedTasks = computed(() => transferTasks.value.filter((task) => ['done', 'failed', 'aborted'].includes(task.status)).slice().reverse())
export const transferBusy = computed(() => !!activeTask.value || queuedTasks.value.length > 0)
export const pullPercent = computed(() => {
  const task = activeTask.value
  if (!task || !task.totalBytes) return 0
  return Math.min(100, Math.round((task.receivedBytes / task.totalBytes) * 100))
})

export async function loadStats() {
  if (loading.value) return
  loading.value = true
  try {
    stats.value = await request('/admin/api/stats')
    lastUpdated.value = new Date().toISOString()
    loadError.value = ''
  } catch (error) {
    loadError.value = `加载失败：${error.message}`
  } finally {
    loading.value = false
  }
}
