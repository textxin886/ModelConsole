<template>
  <div class="panel-grid">
    <el-card class="panel" shadow="hover">
      <div class="panel-heading">
        <div><h2>接口速览</h2><p>OpenAI 兼容聊天接口，文本模型专用</p></div>
        <el-tag effect="plain">{{ stats.models.length }} 个模型</el-tag>
      </div>
      <el-descriptions :column="1" border>
        <el-descriptions-item label="服务地址"><span class="description-value">{{ stats.publicBaseUrl || config.publicBaseUrl }}</span></el-descriptions-item>
        <el-descriptions-item label="模型列表"><span class="description-value">GET {{ modelsUrl }}</span></el-descriptions-item>
        <el-descriptions-item label="聊天补全"><span class="description-value">POST {{ apiUrl }}</span></el-descriptions-item>
        <el-descriptions-item label="API Key"><span class="description-value">请求头 Authorization: Bearer &lt;API Key&gt;；首页“访问密钥”卡片可直接查看</span></el-descriptions-item>
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
        <el-descriptions-item label="支持模态"><span class="description-value">文本对话由内置引擎推理；多模态识图与语音转文字在 Linux 容器内由自动下载并看护的 llama-server 引擎执行（视觉模型需配套 mmproj*.gguf 放同一 models 目录；whisper 系列 GGUF 直接上传或拉取即可）。图片生成仍为 OpenAI 格式预留接口。模型类型在服务端按 GGUF 元数据自动识别，见“模型管理”类型列。</span></el-descriptions-item>
        <el-descriptions-item label="并发策略"><span class="description-value">超出并发上限的请求自动排队等待（见首页“并发与排队”卡片），排队数量不限制，最长等待 5 分钟；排队超时返回 504，请重试。</span></el-descriptions-item>
        <el-descriptions-item label="模型下载"><span class="description-value">模型管理页新增链接后可立即拉取，差异化拉取会批量补齐缺失模型；所有下载进入后台队列，同一时间只下载一个，完成后自动记录大小与 SHA-256。</span></el-descriptions-item>
        <el-descriptions-item label="模型常驻"><span class="description-value">热启动模型常驻内存；其余模型闲置超时后自动回收，下次请求会重新加载，首次响应偏慢属正常。</span></el-descriptions-item>
        <el-descriptions-item label="思考模式"><span class="description-value">Qwen3 系列默认思考（传 enable_thinking: false 关闭），Qwen3.5 系列默认不思考（传 enable_thinking: true 开启）；也支持 chat_template_kwargs.enable_thinking 与 reasoning_effort（"none" 视为关闭）。思考过程单独放在 reasoning_content 字段返回，content 只含最终回答；流式时思考增量走 delta.reasoning_content。识图请求经 llama-server 原样透传这些参数。</span></el-descriptions-item>
        <el-descriptions-item label="上传与校验"><span class="description-value">上传或下载完成后自动校验 GGUF 文件头，配置了大小 / SHA-256 的链接还会比对完整性，不一致会拒绝并提示。</span></el-descriptions-item>
        <el-descriptions-item label="管理密钥"><span class="description-value">管理台接口使用 ADMIN_KEY（未设置时同 API_KEY）；模型下载走浏览器 Cookie，无需手动携带。</span></el-descriptions-item>
      </el-descriptions>
      <div class="metric-foot">环境变量：PORT / HOST / API_KEY / ADMIN_KEY / MODEL_DIR / MAX_MODEL_BYTES / MAX_CONCURRENCY / MAX_QUEUE / HOT_MODEL / MODEL_PULL_ALLOW_PRIVATE 等，详见 README。</div>
    </el-card>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { config } from '../api'
import { stats } from '../store'

const apiUrl = computed(() => `${stats.value.publicBaseUrl || config.publicBaseUrl}/v1/chat/completions`)
const modelsUrl = computed(() => `${stats.value.publicBaseUrl || config.publicBaseUrl}/v1/models`)
</script>
