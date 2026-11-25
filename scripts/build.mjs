
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const outputDir = path.join(root, 'dist')
const archiveName = `rea-server-v${packageJson.version}.zip`
const archivePath = path.join(outputDir, archiveName)
const runtimeFiles = [
  'index.js',
  'start.js',
  'workers/inference-worker.js',
  'config/models.config.json',
  '.env',
  '.npmrc',
  'package.json',
  'package-lock.json',
]

// 先构建前端（产物输出到仓库根 web/），再打包运行文件 + web/ 全部资源
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
function runNpm(args) {
  const result = spawnSync(`${npmCmd} ${args.join(' ')}`, { cwd: root, stdio: 'inherit', shell: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} 失败，退出码 ${result.status}`)
}

// --soft：postinstall 用，构建失败只警告不报错（start.js 启动时还会重试）
const soft = process.argv.includes('--soft')

async function listWeb(dir) {
  const out = []
  for (const item of await fs.readdir(path.join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${item.name}`
    if (item.isDirectory()) out.push(...await listWeb(rel))
    else out.push(rel)
  }
  return out
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  crcTable[index] = value >>> 0
}

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

function createZip(entries) {
  if (entries.length > 0xffff) throw new Error('ZIP 文件数量超过限制')
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = entry.data
    if (name.length > 0xffff || data.length > 0xffffffff) throw new Error(`文件过大：${entry.name}`)
    const checksum = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0x0800, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0x0021, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(data.length, 18)
    localHeader.writeUInt32LE(data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0x0021, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(data.length, 20)
    centralHeader.writeUInt32LE(data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, name)
    offset += localHeader.length + name.length + data.length
  }

  const localSize = localParts.reduce((total, part) => total + part.length, 0)
  const centralDirectory = Buffer.concat(centralParts)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(entries.length, 8)
  endRecord.writeUInt16LE(entries.length, 10)
  endRecord.writeUInt32LE(centralDirectory.length, 12)
  endRecord.writeUInt32LE(localSize, 16)
  endRecord.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, endRecord])
}

async function main() {
  const frontendModules = await fs.stat(path.join(root, 'frontend', 'node_modules')).catch(() => null)
  if (!frontendModules?.isDirectory()) runNpm(['--prefix', 'frontend', 'install'])
  runNpm(['--prefix', 'frontend', 'run', 'build'])

  await fs.mkdir(outputDir, { recursive: true })
  const files = [...runtimeFiles, ...(await listWeb('web'))]
  const entries = await Promise.all(files.map(async (name) => ({
    name,
    data: await fs.readFile(path.join(root, name)),
  })))
  const archive = createZip(entries)
  await fs.writeFile(archivePath, archive)

  console.log(`已生成：${path.relative(root, archivePath)}`)
  console.log(`文件数：${entries.length}，大小：${archive.length} 字节`)
  console.log(`包含：${entries.map((entry) => entry.name).join(', ')}`)
}

try {
  await main()
} catch (error) {
  if (!soft) throw error
  console.warn(`[build] 构建失败（postinstall 软模式忽略）：${error.message}`)
  console.warn('[build] start.js 启动时会重试构建')
}