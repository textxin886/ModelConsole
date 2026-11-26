import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(root, 'dist')
const runtimeFiles = [
  'server/index.js',
  'start.js',
  'workers/inference-worker.js',
  'config/models.config.json',
  '.env',
  '.npmrc',
  'package.json',
  'package-lock.json',
]

// --soft：postinstall 用，构建失败只警告不报错（start.js 启动时还会重试）
const soft = process.argv.includes('--soft')

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function runNpm(args) {
  const result = spawnSync(`${npmCmd} ${args.join(' ')}`, { cwd: root, stdio: 'inherit', shell: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败，退出码 ${result.status}`)
}

async function copyTree(from, to) {
  await fs.mkdir(to, { recursive: true })
  for (const item of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, item.name)
    const dst = path.join(to, item.name)
    if (item.isDirectory()) await copyTree(src, dst)
    else await fs.copyFile(src, dst)
  }
}

async function countFiles(dir) {
  let total = 0
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    total += item.isDirectory() ? await countFiles(path.join(dir, item.name)) : 1
  }
  return total
}

async function main() {
  const frontendModules = await fs.stat(path.join(root, 'frontend', 'node_modules')).catch(() => null)
  if (!frontendModules?.isDirectory()) runNpm(['--prefix', 'frontend', 'install'])
  runNpm(['--prefix', 'frontend', 'run', 'build'])

  await fs.rm(outputDir, { recursive: true, force: true })
  await fs.mkdir(outputDir, { recursive: true })
  for (const name of runtimeFiles) {
    const target = path.join(outputDir, name)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.copyFile(path.join(root, name), target)
  }
  await copyTree(path.join(root, 'web'), path.join(outputDir, 'web'))

  console.log(`部署目录已生成：${path.relative(root, outputDir)}/（${await countFiles(outputDir)} 个文件，直接整体上传即可，无需解压）`)
}

try {
  await main()
} catch (error) {
  if (!soft) throw error
  console.warn(`[build] 构建失败（postinstall 软模式忽略）：${error.message}`)
  console.warn('[build] start.js 启动时会重试构建')
}
