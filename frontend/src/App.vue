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
    <el-menu :default-active="activePage" :collapse="menuCollapsed" @select="navigate">
      <el-menu-item index="home">
        <span class="nav-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V21h13V9.5M9.5 21v-7h5v7"/></svg>
        </span>
        <template #title>主页</template>
      </el-menu-item>
      <el-menu-item index="models">
        <span class="nav-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>
        </span>
        <template #title>模型管理</template>
      </el-menu-item>
      <el-menu-item index="help">
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
          <h1>{{ pageTitle }}</h1>
          <p>{{ pageSubtitle }}</p>
        </div>
      </div>
      <div class="topbar-actions">
        <el-tag v-if="stats.queue.queued > 0" type="warning" effect="plain">排队 {{ stats.queue.queued }}</el-tag>
        <el-tag :type="heartbeatType" effect="plain">{{ heartbeatText }}</el-tag>
        <span v-if="lastUpdated" class="metric-foot" style="margin: 0 4px;">上次更新 {{ formatDate(lastUpdated) }}</span>
        <el-button :loading="loading || linkLoading" @click="refreshAll">立即刷新</el-button>
      </div>
    </header>

    <main class="content">
      <el-alert v-if="loadError" class="page-alert" :title="loadError" type="error" show-icon closable @close="loadError = ''"></el-alert>

      <template v-if="activePage === 'home'">
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
            <div class="metric-foot">等待 {{ stats.queue.queued }} · 队列上限 {{ stats.queue.maxQueue }}</div>
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
              <div><h2>CPU</h2><p>{{ stats.system?.cpu?.cores || 0 }} 个逻辑核心</p></div>
              <el-tag :type="pressureType(stats.system?.cpu?.usagePercent)" effect="plain">{{ formatPercent(stats.system?.cpu?.usagePercent) }}</el-tag>
            </div>
            <div class="resource-value">{{ formatPercent(stats.system?.cpu?.usagePercent) }}</div>
            <el-progress :percentage="percentValue(stats.system?.cpu?.usagePercent)" :color="pressureColor(stats.system?.cpu?.usagePercent)" :stroke-width="9"></el-progress>
            <div class="metric-foot">1 / 5 / 15 分钟负载：{{ (stats.system?.cpu?.loadAverage || [0, 0, 0]).map((value) => Number(value).toFixed(2)).join(' / ') }}</div>
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
              <div><h2>硬盘</h2><p>模型所在磁盘分区</p></div>
              <el-tag :type="pressureType(diskPercent)" effect="plain">{{ formatPercent(diskPercent) }}</el-tag>
            </div>
            <div class="resource-value">{{ formatBytes(stats.system?.disk?.usedBytes) }} <span class="metric-foot">/ {{ formatBytes(stats.system?.disk?.totalBytes) }}</span></div>
            <el-progress :percentage="percentValue(diskPercent)" :color="pressureColor(diskPercent)" :stroke-width="9"></el-progress>
            <div class="metric-foot">模型目录 {{ formatBytes(stats.system?.disk?.modelBytes) }} · 可用 {{ formatBytes(stats.system?.disk?.freeBytes) }}</div>
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

          <el-card v-if="transferBusy || finishedTasks.length" class="panel" shadow="hover">
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

          <el-card class="panel" shadow="hover">
            <div class="panel-heading">
              <div><h2>资源与地址</h2><p>OpenAI 兼容接口</p></div>
              <el-button text type="primary" @click="navigate('models')">管理模型</el-button>
            </div>
            <div class="metric-label">聊天补全</div>
            <div class="endpoint-row"><code>{{ apiUrl }}</code><el-button text @click="copyText(apiUrl)">复制</el-button></div>
            <div class="metric-label" style="margin-top: 16px;">模型列表</div>
            <div class="endpoint-row"><code>{{ modelsUrl }}</code><el-button text @click="copyText(modelsUrl)">复制</el-button></div>
            <el-divider></el-divider>
            <div class="status-line"><span class="metric-label">请求方式</span><code>Authorization: Bearer &lt;key&gt;</code></div>
            <div class="status-line" style="margin-top: 10px;"><span class="metric-label">模型选择</span><span>请求 body.model 使用模型完整文件名</span></div>
            <div class="status-line" style="margin-top: 10px;"><span class="metric-label">模型数量</span><span>{{ stats.models.length }} 个 · 当前 {{ stats.runtime?.id || '无驻留模型' }}</span></div>
          </el-card>

          <el-card class="panel full" shadow="hover">
            <div class="panel-heading">
              <div><h2>访问密钥</h2><p>页面按个人使用需求直接展示密钥</p></div>
              <el-button type="primary" plain @click="copyText(config.apiKey)">复制 API Key</el-button>
            </div>
            <div class="key-row"><code>{{ config.apiKey }}</code></div>
            <div class="metric-foot">控制台无需登录；公网部署时请自行配置访问白名单或反向代理鉴权。</div>
          </el-card>

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
        </section>
      </template>

      <template v-else-if="activePage === 'models'">
        <section class="panel-grid">
          <el-card class="panel full" shadow="hover">
            <div class="panel-heading">
              <div><h2>从 URL 拉取模型</h2><p>服务器直接下载 GGUF，无需先保存到本地电脑</p></div>
              <el-tag effect="plain">HTTP / HTTPS</el-tag>
            </div>
            <el-form label-position="top" @submit.prevent>
              <div class="pull-form">
                <el-form-item label="模型地址" required>
                  <el-input v-model="pullUrl" clearable placeholder="https://huggingface.co/.../resolve/main/model.gguf"></el-input>
                </el-form-item>
                <el-form-item label="保存文件名（可选）">
                  <el-input v-model="pullName" clearable placeholder="留空则自动识别文件名"></el-input>
                </el-form-item>
                <el-button type="success" :loading="pulling" :disabled="pulling" @click="pullModel">拉取模型</el-button>
              </div>
            </el-form>
            <div v-if="activeTask" class="metric-foot" style="margin-bottom: 12px;">正在下载 {{ activeTask.filename || activeTask.name }}（{{ transferStatusText(activeTask.status) }}）：已下载 {{ formatBytes(activeTask.receivedBytes) }}{{ activeTask.totalBytes ? ` / ${formatBytes(activeTask.totalBytes)}` : '' }}</div>
            <el-progress v-if="activeTask && pullPercent > 0" :percentage="pullPercent" :stroke-width="10" style="margin-bottom: 14px;"></el-progress>
            <el-alert v-if="pullError" class="upload-status" :title="pullError" type="error" show-icon closable @close="pullError = ''"></el-alert>
            <el-alert v-else-if="pullMessage" class="upload-status" :title="pullMessage" type="success" show-icon closable @close="pullMessage = ''"></el-alert>
            <div class="metric-foot">默认仅允许公网地址；内网模型仓库可通过 MODEL_PULL_ALLOW_PRIVATE=true 开启。</div>
          </el-card>

          <el-card class="panel full" shadow="hover">
            <div class="panel-heading">
              <div><h2>模型链接配置</h2><p>保存到 {{ modelLinksFile }}；手动拉取成功后自动写入链接与校验信息</p></div>
              <el-tag effect="plain">{{ enabledLinkCount }} 启用 · {{ missingLinkCount }} 缺失</el-tag>
            </div>
            <div class="page-toolbar">
              <span class="metric-foot">差异拉取只下载启用且本地缺失的模型，不覆盖或删除已有文件。</span>
              <div class="toolbar-actions">
                <el-button :disabled="linkBusy || syncingLinks" @click="openLinkEditor()">新增链接</el-button>
                <el-button tag="a" type="primary" href="/admin/api/model-links/export" download>导出备份</el-button>
                <el-button type="success" :loading="syncingLinks" :disabled="syncingLinks || linkBusy" @click="pullMissingLinks">一键差异化拉取</el-button>
              </div>
            </div>
            <el-alert v-if="modelLinksError" class="upload-status" :title="modelLinksError" type="error" show-icon closable @close="modelLinksError = ''"></el-alert>
            <el-alert v-else-if="syncError" class="upload-status" :title="syncError" type="warning" show-icon closable @close="syncError = ''"></el-alert>
            <el-alert v-else-if="syncMessage" class="upload-status" :title="syncMessage" type="success" show-icon closable @close="syncMessage = ''"></el-alert>
            <div class="table-shell">
              <el-table v-loading="linkLoading" class="link-config-table" :data="modelLinks" row-key="id" empty-text="暂无模型链接配置">
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
                      <el-button size="small" type="danger" plain :disabled="linkBusy || syncingLinks" @click="deleteModelLink(row)">删除</el-button>
                    </div>
                  </template>
                </el-table-column>
              </el-table>
            </div>
            <div class="metric-foot">配置可直接编辑 JSON；管理台每次查询都会重新读取。下载完成后会校验文件大小与 SHA-256。</div>
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
              <el-table v-loading="loading" class="model-table" :data="filteredModels" row-key="id" empty-text="暂无模型，请先上传 GGUF 文件">
                <el-table-column width="46" align="center">
                  <template #header><el-checkbox :model-value="allVisibleSelected" :indeterminate="someVisibleSelected" :disabled="filteredModels.length === 0" @change="toggleAllVisible"></el-checkbox></template>
                  <template #default="{ row }"><el-checkbox :model-value="selectedModels.includes(row.id)" @change="toggleModel(row.id, $event)"></el-checkbox></template>
                </el-table-column>
                <el-table-column label="模型文件" min-width="280"><template #default="{ row }"><span class="model-id" :title="row.id">{{ row.id }}</span></template></el-table-column>
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
        </section>
      </template>

      <template v-else>
        <section class="panel-grid">
          <el-card class="panel" shadow="hover">
            <div class="panel-heading">
              <div><h2>接口速览</h2><p>OpenAI 兼容聊天接口，文本模型专用</p></div>
              <el-tag effect="plain">{{ stats.models.length }} 个模型</el-tag>
            </div>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="服务地址"><span class="description-value">{{ stats.publicBaseUrl }}</span></el-descriptions-item>
              <el-descriptions-item label="模型列表"><span class="description-value">GET {{ modelsUrl }}</span></el-descriptions-item>
              <el-descriptions-item label="聊天补全"><span class="description-value">POST {{ apiUrl }}</span></el-descriptions-item>
              <el-descriptions-item label="API Key"><span class="description-value">请求头 Authorization: Bearer &lt;API Key&gt;；本页“资源与地址”卡片可直接查看</span></el-descriptions-item>
              <el-descriptions-item label="模型选择"><span class="description-value">请求体 model 字段填模型文件名；省略时使用默认模型</span></el-descriptions-item>
            </el-descriptions>
            <div class="metric-foot">健康检查：GET /health，无需密钥。</div>
          </el-card>

          <el-card class="panel" shadow="hover">
            <div class="panel-heading">
              <div><h2>调用示例</h2><p>复制后替换模型名与密钥即可</p></div>
            </div>
            <div class="metric-label">列出模型</div>
            <pre class="help-code">curl {{ modelsUrl }} \
  -H "Authorization: Bearer &lt;你的API Key&gt;"</pre>
            <div class="metric-label" style="margin-top: 12px;">聊天补全</div>
            <pre class="help-code">curl {{ apiUrl }} \
  -H "Authorization: Bearer &lt;你的API Key&gt;" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "模型文件名.gguf",
    "messages": [{ "role": "user", "content": "你好" }],
    "max_tokens": 256,
    "stream": false
  }'</pre>
            <div class="metric-label" style="margin-top: 12px;">流式输出</div>
            <pre class="help-code">把上面请求体里的 "stream" 改为 true，返回为标准 SSE（data: {...} 逐块输出，最后 data: [DONE]）。</pre>
          </el-card>

          <el-card class="panel full" shadow="hover">
            <div class="panel-heading">
              <div><h2>能力边界与常见问题</h2><p>请先读完再提问，多数“报错”其实是用法问题</p></div>
            </div>
            <el-descriptions :column="1" border>
              <el-descriptions-item label="支持模态"><span class="description-value">仅文本生成（GGUF 文本模型）。不支持多模态识图、语音转文字或图片生成；Whisper 等语音模型无法在本服务运行。</span></el-descriptions-item>
              <el-descriptions-item label="并发策略"><span class="description-value">超出并发上限的请求自动排队等待（见首页“并发与排队”卡片），排队数超过上限才会返回 429，请重试。</span></el-descriptions-item>
              <el-descriptions-item label="模型下载"><span class="description-value">URL 拉取与差异化拉取都会进入后台下载队列，同一时间只下载一个，其余排队；刷新页面不丢进度，完成记录可在“模型下载队列”清空。</span></el-descriptions-item>
              <el-descriptions-item label="模型常驻"><span class="description-value">热启动模型常驻内存；其余模型闲置超时后自动回收，下次请求会重新加载，首次响应偏慢属正常。</span></el-descriptions-item>
              <el-descriptions-item label="上传与校验"><span class="description-value">上传或下载完成后自动校验 GGUF 文件头，配置了大小 / SHA-256 的链接还会比对完整性，不一致会拒绝并提示。</span></el-descriptions-item>
              <el-descriptions-item label="管理密钥"><span class="description-value">管理台接口使用 ADMIN_KEY（未设置时同 API_KEY）；模型下载走浏览器 Cookie，无需手动携带。</span></el-descriptions-item>
            </el-descriptions>
            <div class="metric-foot">环境变量：PORT / HOST / API_KEY / ADMIN_KEY / MODEL_DIR / MAX_MODEL_BYTES / MAX_CONCURRENCY / MAX_QUEUE / HOT_MODEL / MODEL_PULL_ALLOW_PRIVATE 等，详见 README。</div>
          </el-card>
        </section>
      </template>

      <footer class="footer">REA Model Console · Vue 3 + Element Plus · 数据仅保存在本机</footer>
    </main>
  </div>
</div>

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
      <el-form-item label="保存文件名" required class="full">
        <el-input v-model="linkForm.id" maxlength="240" clearable placeholder="例如：Qwen3.5-2B-Q4_K_M.gguf"></el-input>
      </el-form-item>
      <el-form-item label="模型下载地址" required class="full">
        <el-input v-model="linkForm.url" clearable placeholder="https://huggingface.co/.../resolve/main/model.gguf"></el-input>
      </el-form-item>
      <el-form-item label="期望大小（字节，可选）">
        <el-input v-model="linkForm.sizeBytes" inputmode="numeric" clearable placeholder="留空则不校验大小"></el-input>
      </el-form-item>
      <el-form-item label="SHA-256（可选）">
        <el-input v-model="linkForm.sha256" maxlength="64" clearable placeholder="64 位十六进制字符串"></el-input>
      </el-form-item>
      <el-form-item label="参与差异拉取" class="full">
        <el-switch v-model="linkForm.enabled"></el-switch>
      </el-form-item>
    </div>
    <div class="dialog-tip">文件名将作为本地模型 ID；地址仅支持公网 HTTP/HTTPS，下载完成后自动校验并保存。</div>
  </el-form>
  <template #footer>
    <el-button @click="linkDialog = false">取消</el-button>
    <el-button type="primary" :loading="linkBusy" @click="saveModelLink">保存配置</el-button>
  </template>
</el-dialog>
</template>

<script>
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'

const config = JSON.parse(document.getElementById('runtime-config').textContent)
  const number = new Intl.NumberFormat('zh-CN')
  const dateTime = new Intl.DateTimeFormat('zh-CN', { hour12: false })

  function emptyStats() {
    return {
      models: [],
      runtime: null,
      serverRssBytes: 0,
      memoryLimitBytes: 0,
      modelIdleTimeoutMs: 0,
      maxModelBytes: 0,
      maxConcurrencyLimit: 8,
      hotModelId: null,
      hotModelPinned: false,
      system: {
        cpu: { usagePercent: 0, cores: 0, perCore: [], loadAverage: [0, 0, 0] },
        memory: { totalBytes: 0, freeBytes: 0, usedBytes: 0, runtimeBytes: 0 },
        disk: { totalBytes: 0, freeBytes: 0, usedBytes: 0, modelBytes: 0 },
      },
      transfer: null,
      publicBaseUrl: config.publicBaseUrl,
      uptimeSeconds: 0,
      queue: { active: 0, queued: 0, maxActive: 1, maxQueue: 0 },
      heartbeat: { enabled: false, lastSuccessAt: null, lastError: null },
      totals: { requests: 0, successfulRequests: 0, failedRequests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      daily: [],
      recent: [],
    }
  }

export default {

    setup() {
      const activePage = ref(location.hash === '#models' ? 'models' : 'home')
      const collapsed = ref(false)
      const isMobile = ref(window.innerWidth < 900)
      const mobileOpen = ref(false)
      const stats = ref(emptyStats())
      const loading = ref(false)
      const loadError = ref('')
      const lastUpdated = ref(null)
      const modelSearch = ref('')
      const fileInput = ref(null)
      const uploading = ref(false)
      const uploadPercent = ref(0)
      const uploadMessage = ref('')
      const uploadError = ref('')
      const pullUrl = ref('')
      const pullName = ref('')
      const pulling = ref(false)
      const pullMessage = ref('')
      const pullError = ref('')
      const modelLinks = ref([])
      const modelLinksFile = ref('models.config.json')
      const linkLoading = ref(false)
      const modelLinksError = ref('')
      const linkBusy = ref(false)
      const linkActionId = ref('')
      const syncingLinks = ref(false)
      const syncMessage = ref('')
      const syncError = ref('')
      const linkDialog = ref(false)
      const linkEditingId = ref(null)
      const linkForm = ref({ id: '', url: '', enabled: true, sizeBytes: '', sha256: '' })
      const selectedModels = ref([])
      const concurrencyDraft = ref(1)
      const concurrencyDirty = ref(false)
      const concurrencyBusy = ref(false)
      const actionLoading = ref(false)
      const actionModel = ref('')
      const usageBusy = ref(false)
      const renameDialog = ref(false)
      const renameName = ref('')
      const renameModel = ref(null)
      const renaming = ref(false)
      let refreshTimer = null
      const hotModelLoading = ref(false)
      const pullingLink = ref('')
      const linkPullError = ref('')
      const recentPage = ref(1)
      const MAX_RECENT_REQUESTS = 500
      const logStream = ref('server')
      const logLines = ref([])
      const logFile = ref('')
      const logLoading = ref(false)
      const logViewerRef = ref(null)

      try { collapsed.value = localStorage.getItem('rea-sidebar-collapsed') === 'true' } catch {}

      const pageTitle = computed(() => activePage.value === 'home' ? 'REA Model Console' : activePage.value === 'models' ? '模型管理' : '使用手册')
      const pageSubtitle = computed(() => activePage.value === 'home' ? '模型目录、按需推理、资源回收与 Token 消耗' : activePage.value === 'models' ? '上传、查询、重命名、加载、卸载与删除模型' : '接口用法、能力边界与常见问题')
      const menuCollapsed = computed(() => collapsed.value && !isMobile.value)
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
      const memoryPercent = computed(() => {
        const memory = stats.value.system?.memory
        return memory?.totalBytes > 0 ? memory.usedBytes / memory.totalBytes * 100 : 0
      })
      const diskPercent = computed(() => {
        const disk = stats.value.system?.disk
        return disk?.totalBytes > 0 ? disk.usedBytes / disk.totalBytes * 100 : 0
      })
      const transferTasks = computed(() => stats.value.transfer?.tasks || [])
      const activeTask = computed(() => stats.value.transfer?.active || null)
      const queuedTasks = computed(() => transferTasks.value.filter((task) => task.status === 'queued'))
      const finishedTasks = computed(() => transferTasks.value.filter((task) => ['done', 'failed', 'aborted'].includes(task.status)).slice().reverse())
      const transferBusy = computed(() => !!activeTask.value || queuedTasks.value.length > 0)
      const transferStatusNames = computed(() => new Set(transferTasks.value.filter((task) => !['done', 'failed', 'aborted'].includes(task.status)).map((task) => String(task.name || '').toLowerCase())))
      const pullPercent = computed(() => {
        const task = activeTask.value
        if (!task || !task.totalBytes) return 0
        return Math.min(100, Math.round((task.receivedBytes / task.totalBytes) * 100))
      })
      const pagedRecent = computed(() => {
        const list = stats.value.recent || []
        const start = Math.max(0, (recentPage.value - 1) * 20)
        return list.slice(start, start + 20)
      })
      const apiUrl = computed(() => `${stats.value.publicBaseUrl}/v1/chat/completions`)
      const modelsUrl = computed(() => `${stats.value.publicBaseUrl}/v1/models`)
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

      function formatNumber(value) { return number.format(Number(value) || 0) }
      function formatCompact(value) {
        const count = Number(value) || 0
        if (count >= 1e9) return `${(count / 1e9).toFixed(2)}B`
        if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`
        if (count >= 1e3) return `${(count / 1e3).toFixed(2)}K`
        return formatNumber(count)
      }
      function formatBytes(value) {
        const bytes = Number(value) || 0
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
        if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
        return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
      }
      function percentValue(value) { return Math.max(0, Math.min(100, Math.round(Number(value) || 0))) }
      function formatPercent(value) { return `${percentValue(value)}%` }
      function pressureType(value) {
        const percent = percentValue(value)
        return percent >= 85 ? 'danger' : percent >= 60 ? 'warning' : 'success'
      }
      function pressureColor(value) {
        const percent = percentValue(value)
        return percent >= 85 ? '#ff7b86' : percent >= 60 ? '#e6a23c' : '#55d6a5'
      }
      function formatUptime(seconds) {
        const value = Number(seconds) || 0
        const days = Math.floor(value / 86400)
        const hours = Math.floor(value % 86400 / 3600)
        const minutes = Math.floor(value % 3600 / 60)
        return days > 0 ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分`
      }
      function formatDate(value) {
        if (!value) return '—'
        const date = new Date(value)
        return Number.isNaN(date.getTime()) ? '—' : dateTime.format(date)
      }
      function statusText(status) {
        return status === 'loaded' ? '运行中' : status === 'loading' ? '加载中' : '未加载'
      }
      function statusType(status) {
        return status === 'loaded' ? 'success' : status === 'loading' ? 'warning' : 'info'
      }
      function linkLocalStatusText(status) {
        return status === 'present' ? '已存在' : status === 'size_mismatch' ? '大小不一致' : '缺失'
      }
      function linkLocalStatusType(status) {
        return status === 'present' ? 'success' : status === 'size_mismatch' ? 'warning' : 'danger'
      }

      async function request(path, options = {}) {
        const headers = { Authorization: `Bearer ${config.adminKey}`, ...(options.headers || {}) }
        if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json'
        const response = await fetch(path, { ...options, headers })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(payload.error?.message || `HTTP ${response.status}`)
        return payload
      }

      async function loadStats() {
        if (loading.value) return
        loading.value = true
        try {
          stats.value = await request('/admin/api/stats')
          const available = new Set(stats.value.models.map((item) => item.id))
          selectedModels.value = selectedModels.value.filter((id) => available.has(id))
          if (!concurrencyBusy.value && !concurrencyDirty.value) concurrencyDraft.value = stats.value.queue.maxActive
          lastUpdated.value = new Date().toISOString()
          loadError.value = ''
        } catch (error) {
          loadError.value = `加载失败：${error.message}`
        } finally {
          loading.value = false
        }
      }

      async function refreshAll() {
        await Promise.all([loadStats(), loadModelLinks(), refreshLog()])
      }

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
          const { value } = await ElMessageBox.confirm(
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
          // 用户选完时读 radio + 数字 input
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

      function navigate(page) {
        activePage.value = ['home', 'models', 'help'].includes(page) ? page : 'home'
        mobileOpen.value = false
        if (location.hash !== `#${activePage.value}`) location.hash = activePage.value
      }

      function toggleSidebar() {
        if (isMobile.value) mobileOpen.value = !mobileOpen.value
        else {
          collapsed.value = !collapsed.value
          try { localStorage.setItem('rea-sidebar-collapsed', String(collapsed.value)) } catch {}
        }
      }

      async function copyText(text) {
        try {
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
          ElMessage.success('已复制')
        } catch {
          ElMessage.error('复制失败，请手动选择文本')
        }
      }

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

      function modelDownloadUrl(row) {
        return `/admin/api/models/download?model=${encodeURIComponent(row.id)}`
      }

      function transferStatusText(status) {
        return { queued: '排队中', connecting: '连接中', downloading: '下载中', verifying: '校验中', done: '完成', failed: '失败', aborted: '已停止' }[status] || status
      }

      function transferStatusType(status) {
        if (status === 'done') return 'success'
        if (status === 'failed' || status === 'aborted') return 'danger'
        if (status === 'queued') return 'info'
        return 'warning'
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

      async function pullModel() {
        const url = pullUrl.value.trim()
        if (!url) {
          pullError.value = '请填写模型下载地址'
          return
        }
        try { new URL(url) } catch {
          pullError.value = '模型下载地址格式不正确'
          return
        }
        pulling.value = true
        pullError.value = ''
        pullMessage.value = ''
        try {
          const payload = await request('/admin/api/models/pull', {
            method: 'POST',
            body: JSON.stringify({ url, name: pullName.value.trim() || undefined }),
          })
          pullMessage.value = `已加入下载队列：${payload.task.name || payload.task.filename || '未命名模型'}，进度与记录见首页“模型下载队列”`
          pullUrl.value = ''
          pullName.value = ''
          ElMessage.success('已加入下载队列')
          await loadStats()
        } catch (error) {
          pullError.value = `拉取失败：${error.message}`
        } finally {
          pulling.value = false
        }
      }

      function resetLinkEditor() {
        linkEditingId.value = null
        linkForm.value = { id: '', url: '', enabled: true, sizeBytes: '', sha256: '' }
      }

      function openLinkEditor(row) {
        linkEditingId.value = row?.id || null
        linkForm.value = {
          id: row?.id || '',
          url: row?.url || '',
          enabled: row?.enabled ?? true,
          sizeBytes: row?.sizeBytes ? String(row.sizeBytes) : '',
          sha256: row?.sha256 || '',
        }
        linkDialog.value = true
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
        let sizeBytes = null
        if (String(linkForm.value.sizeBytes).trim()) {
          sizeBytes = Number(linkForm.value.sizeBytes)
          if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
            ElMessage.warning('期望大小必须是正整数')
            return
          }
        }
        const sha256 = linkForm.value.sha256.trim() || null
        if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
          ElMessage.warning('SHA-256 必须是 64 位十六进制字符串')
          return
        }
        linkBusy.value = true
        try {
          const editingId = linkEditingId.value
          await request(editingId ? `/admin/api/model-links/${encodeURIComponent(editingId)}` : '/admin/api/model-links', {
            method: editingId ? 'PUT' : 'POST',
            body: JSON.stringify({ id, url, enabled: linkForm.value.enabled, sizeBytes, sha256 }),
          })
          linkDialog.value = false
          ElMessage.success(editingId ? '模型链接已更新' : '模型链接已新增')
          await loadModelLinks()
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
          await ElMessageBox.confirm(`确定删除 ${row.id} 的链接配置吗？本地模型文件不会被删除。`, '删除链接配置', { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' })
        } catch { return }
        linkBusy.value = true
        linkActionId.value = row.id
        try {
          await request(`/admin/api/model-links/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
          ElMessage.success('链接配置已删除')
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
          syncMessage.value = `已入队 ${payload.queued} 个缺失模型，进度见首页“模型下载队列”`
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
          await loadStats()
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

      async function pullSingleLink(id) {
        pullError.value = ''
        pullingLink.value = id
        try {
          const payload = await request(`/admin/api/model-links/${encodeURIComponent(id)}/pull`, { method: 'POST' })
          ElMessage.success(`已入队下载：${payload.task.name || id}`)
          await loadStats()
        } catch (error) {
          pullError.value = `${id}：${error.message}`
          ElMessage.error(error)
        } finally {
          pullingLink.value = ''
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
          await loadStats()
        } catch (error) {
          ElMessage.error(error.message)
        } finally {
          renaming.value = false
        }
      }

      function onResize() {
        isMobile.value = window.innerWidth < 900
        if (!isMobile.value) mobileOpen.value = false
      }

      function onHashChange() {
        activePage.value = location.hash === '#models' ? 'models' : location.hash === '#help' ? 'help' : 'home'
      }

      onMounted(() => {
        window.addEventListener('resize', onResize)
        window.addEventListener('hashchange', onHashChange)
        refreshAll()
        // 有拉取/上传活动时，每 2 秒刷一次 stats 显示进度；空闲时不自动轮询
        refreshTimer = setInterval(() => {
          const transfer = stats.value?.transfer
          const active = uploading.value || transferBusy.value
          if (active) loadStats().catch(() => {})
        }, 2000)
      })

      onBeforeUnmount(() => {
        window.removeEventListener('resize', onResize)
        window.removeEventListener('hashchange', onHashChange)
        if (refreshTimer) clearInterval(refreshTimer)
      })

      return {
        config, activePage, collapsed, isMobile, mobileOpen, menuCollapsed, stats, loading, loadError, lastUpdated,
        modelSearch, fileInput, uploading, uploadPercent, uploadMessage, uploadError,
        pullUrl, pullName, pulling, pullMessage, pullError, pullPercent,
        transferBusy, activeTask, queuedTasks, finishedTasks, transferStatusNames,
        transferStatusText, transferStatusType, abortAllTransfers, clearTransfers,
        modelLinks, modelLinksFile, linkLoading, modelLinksError, linkBusy, linkActionId,
        syncingLinks, syncMessage, syncError, linkDialog, linkEditingId, linkForm,
        enabledLinkCount, missingLinkCount, linkDialogTitle,
        selectedModels, allVisibleSelected, someVisibleSelected, batchDownloadUrl,
        concurrencyDraft, concurrencyDirty, concurrencyBusy, memoryPercent, diskPercent,
        actionLoading, actionModel, usageBusy, renameDialog, renameName, renameModel, renaming,
        hotModelLoading, pullingLink, linkPullError, recentPage, pagedRecent, MAX_RECENT_REQUESTS,
        logStream, logLines, logFile, logLoading, logViewerRef, refreshLog, openLogCleanup,
        pageTitle, pageSubtitle, filteredModels, apiUrl, modelsUrl, heartbeatText, heartbeatType,
        formatCompact, formatBytes, formatUptime, formatDate, statusText, statusType,
        linkLocalStatusText, linkLocalStatusType,
        percentValue, formatPercent, pressureType, pressureColor, loadStats, loadModelLinks, refreshAll, navigate, toggleSidebar,
        copyText, clearUsage, applyConcurrency, toggleModel, toggleAllVisible, modelDownloadUrl,
        pullModel, openLinkEditor, resetLinkEditor, saveModelLink, toggleModelLink, deleteModelLink, pullMissingLinks,
        selectFile, uploadModel, modelAction, openRename, confirmRename, toggleHotModel, pullSingleLink,
      }
    },
}
</script>
