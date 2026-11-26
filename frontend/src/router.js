import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

const routes = [
  { path: '/', name: 'home', component: HomeView, meta: { title: 'REA Model Console', subtitle: '模型目录、按需推理、资源回收与 Token 消耗' } },
  { path: '/models', name: 'models', component: () => import('./views/ModelsView.vue'), meta: { title: '模型管理', subtitle: '链接配置、URL 拉取、上传与本地模型操作' } },
  { path: '/usage', name: 'usage', component: () => import('./views/UsageView.vue'), meta: { title: '用量统计', subtitle: '每日 Token 消耗与近期请求记录' } },
  { path: '/logs', name: 'logs', component: () => import('./views/LogsView.vue'), meta: { title: '服务日志', subtitle: '主进程与推理 Worker 的运行日志' } },
  { path: '/help', name: 'help', component: () => import('./views/HelpView.vue'), meta: { title: '使用手册', subtitle: '接口用法、能力边界与常见问题' } },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
})
