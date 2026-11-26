<template>
  <div class="app-shell" :class="{ 'is-collapsed': collapsed }">
    <aside class="sidebar" :class="{ 'is-open': mobileOpen }" aria-label="主导航">
      <div class="brand">
        <div class="brand-mark">R</div>
        <div class="brand-copy">
          <div class="brand-title">REA Console</div>
          <div class="brand-subtitle">本地模型控制台</div>
        </div>
      </div>
      <el-menu router :default-active="route.path" :collapse="menuCollapsed">
        <el-menu-item index="/">
          <span class="nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5M9.5 21v-7h5v7"/></svg>
          </span>
          <template #title>主页</template>
        </el-menu-item>
        <el-menu-item index="/models">
          <span class="nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
          </span>
          <template #title>模型管理</template>
        </el-menu-item>
        <el-menu-item index="/usage">
          <span class="nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/></svg>
          </span>
          <template #title>用量统计</template>
        </el-menu-item>
        <el-menu-item index="/logs">
          <span class="nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
          </span>
          <template #title>服务日志</template>
        </el-menu-item>
        <el-menu-item index="/help">
          <span class="nav-icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5Z"/></svg>
          </span>
          <template #title>使用手册</template>
        </el-menu-item>
      </el-menu>
      <div class="sidebar-footer">
        <el-button text @click="toggleSidebar" :title="isMobile ? (mobileOpen ? '关闭侧栏' : '打开侧栏') : (collapsed ? '展开侧栏' : '折叠侧栏')">
          <span aria-hidden="true">{{ isMobile ? (mobileOpen ? '‹' : '›') : (collapsed ? '»' : '«') }}</span>
          <span v-if="!menuCollapsed && !isMobile" style="margin-left: 6px;">折叠侧栏</span>
        </el-button>
        <div class="sidebar-note">最常用模型热启动<br>其余空闲自动回收</div>
      </div>
    </aside>

    <div v-if="mobileOpen" class="sidebar-mask" @click="mobileOpen = false"></div>

    <div class="workspace">
      <header class="topbar">
        <div class="topbar-heading">
          <el-button class="mobile-menu" text circle aria-label="打开导航" @click="mobileOpen = true">
            <span style="font-size: 22px; line-height: 1;" aria-hidden="true">☰</span>
          </el-button>
          <div>
            <h1>{{ route.meta.title }}</h1>
            <p>{{ route.meta.subtitle }}</p>
          </div>
        </div>
        <div class="topbar-actions">
          <el-tag v-if="stats.queue.queued > 0" type="warning" effect="plain">排队 {{ stats.queue.queued }}</el-tag>
          <el-tag v-if="transferBusy" type="primary" effect="plain">下载中 {{ pullPercent }}%</el-tag>
          <el-tag :type="heartbeatType" effect="plain">{{ heartbeatText }}</el-tag>
          <span v-if="lastUpdated" class="metric-foot" style="margin: 0 4px;">上次更新 {{ formatDate(lastUpdated) }}</span>
          <el-button :loading="loading" @click="loadStats">立即刷新</el-button>
        </div>
      </header>

      <main class="content">
        <el-alert v-if="loadError" class="page-alert" :title="loadError" type="error" show-icon closable @close="loadError = ''"></el-alert>
        <router-view />
        <footer class="footer">REA Model Console · Vue 3 + Element Plus · 数据仅保存在本机</footer>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute } from 'vue-router'
import { stats, loading, loadError, lastUpdated, loadStats, transferBusy, pullPercent } from './store'
import { formatDate } from './utils'

const route = useRoute()
const collapsed = ref(false)
const isMobile = ref(window.innerWidth < 900)
const mobileOpen = ref(false)
let refreshTimer = null

try { collapsed.value = localStorage.getItem('rea-sidebar-collapsed') === 'true' } catch {}

const menuCollapsed = computed(() => collapsed.value && !isMobile.value)
const heartbeatText = computed(() => {
  const heartbeat = stats.value.heartbeat
  if (!heartbeat.enabled) return '保活已关闭'
  if (heartbeat.lastError) return '保活异常'
  if (heartbeat.lastSuccessAt) return `保活正常 · ${formatDate(heartbeat.lastSuccessAt)}`
  return '等待首次心跳'
})
const heartbeatType = computed(() => {
  const heartbeat = stats.value.heartbeat
  if (!heartbeat.enabled) return 'info'
  return heartbeat.lastError ? 'danger' : heartbeat.lastSuccessAt ? 'success' : 'warning'
})

function toggleSidebar() {
  if (isMobile.value) mobileOpen.value = !mobileOpen.value
  else {
    collapsed.value = !collapsed.value
    try { localStorage.setItem('rea-sidebar-collapsed', String(collapsed.value)) } catch {}
  }
}

function onResize() {
  isMobile.value = window.innerWidth < 900
  if (!isMobile.value) mobileOpen.value = false
}

onMounted(() => {
  window.addEventListener('resize', onResize)
  loadStats()
  // 有下载活动时每 2 秒轮询进度；空闲时不自动轮询
  refreshTimer = setInterval(() => {
    if (transferBusy.value) loadStats().catch(() => {})
  }, 2000)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>
