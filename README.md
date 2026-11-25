# REA Model Console

面向低配服务器的中文本地模型服务：基于 Node.js 运行 GGUF 模型，提供 OpenAI 风格 API、模型管理控制台、按需加载和空闲内存回收。适合 2 核、6 GB 内存的纯 Node.js 容器，不需要 systemd、PM2 或 swap。

## 功能

- OpenAI 风格 `GET /v1/models` 与 `POST /v1/chat/completions`
- 流式和非流式回复、请求排队、并发上限和 Token 用量统计
- 模型上传、URL 拉取、自动发现、重命名、删除和批量 ZIP 下载
- 单模型热启动，其余模型闲置后自动回收内存
- `config/models.config.json` 模型链接配置增删改查、鉴权导出和一键差异化拉取
- 下载后校验 GGUF 文件头、文件大小和 SHA-256
- Vue 3 + Element Plus 自适应管理台，展示 CPU、内存、硬盘和模型状态
- 内置保活请求，避免容器因长时间无访问而休眠

## 快速开始

要求 Node.js 20 或更高版本。

```bash
npm ci
npm start
```

默认监听 `0.0.0.0:25682`。启动后访问：

- 管理台：`http://服务器地址:25682/admin`
- 健康检查：`http://服务器地址:25682/health`
- 模型列表：`http://服务器地址:25682/v1/models`

如果没有设置 `API_KEY`，服务会生成随机密钥并打印在启动日志中。设置固定密钥：

```bash
export API_KEY="请替换为你的密钥"
export ADMIN_KEY="请替换为你的管理密钥"
npm start
```

## 模型准备

部署包和 Git 仓库默认不包含 GGUF 模型，避免上传几个 GB 的文件。

1. 打开管理台的“模型管理”。
2. 使用“从 URL 拉取模型”，或上传本地 GGUF 文件。
3. 首次使用也可以直接点击“模型链接配置”中的“一键差异化拉取”。

已预配置以下模型：

- `Qwen3.5-0.8B-Q4_K_M.gguf`
- `Qwen3.5-2B-Q4_K_M.gguf`
- `Qwen3-4B-Instruct-2507-Q6_K.gguf`

差异化拉取只下载“已启用且本地缺失”的模型，不覆盖或删除已有文件。本地大小与配置不一致时会跳过并报告 `size_mismatch`。

## API 示例

```bash
curl http://127.0.0.1:25682/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

```bash
curl http://127.0.0.1:25682/v1/chat/completions \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "Qwen3.5-0.8B-Q4_K_M.gguf",
    "messages": [
      {"role": "user", "content": "请用一句话介绍你自己"}
    ],
    "temperature": 0.7,
    "stream": false
  }'
```

流式请求将 `stream` 设置为 `true` 即可。

## 常用环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `25682` | 服务端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `API_KEY` | 随机生成 | OpenAI 风格 API 密钥 |
| `ADMIN_KEY` | 使用 `API_KEY` | 管理台和下载鉴权密钥 |
| `THREADS` | `2` | 推理线程数 |
| `CONTEXT_SIZE` | `2048` | 默认上下文长度 |
| `MAX_CONCURRENCY` | `1` | 最大同时推理数，可在管理台动态调整 |
| `MAX_QUEUE` | `8` | 最大排队请求数 |
| `MODEL_IDLE_TIMEOUT_MS` | `300000` | 非热启动模型空闲回收时间 |
| `HOT_MODEL` | 自动选择 | 常驻热启动模型文件名 |
| `DEFAULT_MODEL` | 2B 模型 | 默认模型文件名 |
| `MODEL_DIR` | `./models` | 模型目录 |
| `MODEL_LINKS_FILE` | `./config/models.config.json` | 模型链接配置文件 |
| `MEMORY_LIMIT_MB` | `0` | 内存限制，`0` 表示自动探测 |
| `MODEL_PULL_ALLOW_PRIVATE` | `false` | 是否允许从私网地址拉取模型 |
| `PUBLIC_BASE_URL` | `http://se1.nodaroo.fun:25682` | 保活和公开访问地址 |
| `KEEP_ALIVE_ENABLED` | `true` | 是否启用内置保活 |

## 打包

```bash
npm run build
```

产物位于：

```text
dist/rea-server-v1.1.0.zip
dist/rea-server-v1.1.0.zip.sha256
```

ZIP 最外层直接是 `index.js`，解压后不需要再进入额外文件夹。打包脚本只收录运行必需文件：

```text
index.js
workers/inference-worker.js
config/models.config.json
web/index.html
web/assets/*
.env
package.json
package-lock.json
```

不会打包 `node_modules`、GGUF 模型、用量统计、评测结果或历史 ZIP。

服务器部署示例：

```bash
unzip rea-server-v1.1.0.zip -d rea-server
cd rea-server
npm ci --omit=dev
export API_KEY="请替换为你的密钥"
export ADMIN_KEY="请替换为你的管理密钥"
npm start
```

## 上传到 GitHub

`.gitignore` 已排除模型、依赖、打包产物、用量、语料、结果和 `.env` 文件。上传前先检查：

```bash
git status
```

确认没有 `models/`、`usage.json`、`dist/`、`.env` 或任何凭据后执行：

```bash
git init
git add .
git commit -m "feat: add model link config and deployment build"
git branch -M main
git remote add origin <你的 GitHub 仓库地址>
git push -u origin main
```

如需通过 GitHub CLI 发布部署包：

```bash
gh release create v1.1.0 dist/rea-server-v1.1.0.zip \
  --title "REA Model Console v1.1.0" \
  --notes "OpenAI-compatible local GGUF model server with web console"
```

## 安全说明

- 默认禁止从私网、回环和保留 IP 地址拉取模型，防止 SSRF。
- 管理台密钥只应提供给管理员；公网部署建议再配置 HTTPS 和访问频率限制。

如果这个项目对你有帮助，欢迎点 Star。

## License

ISC