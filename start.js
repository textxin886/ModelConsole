// 容器入口：git pull 后前端源码可能已变化，必须每次重新构建，再启动服务
const { execSync } = require('node:child_process')

console.log('[start] building...')
execSync('npm run build', { stdio: 'inherit' })

console.log('[start] starting...')
require('./server/index.js')
