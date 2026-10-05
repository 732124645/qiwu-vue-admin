import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon } from 'element-plus'
// Element Plus dark palette under `html.dark` (useDark in the app store toggles it), then the design
// tokens and their Element Plus mapping, which must come after it (styles/element.css)
import 'element-plus/theme-chalk/dark/css-vars.css'
import '@/styles/tokens.css'
import '@/styles/element.css'
import App from './App.vue'
import router, { reloadOnPermChange } from '@/core/router'
import { i18n } from '@/core/i18n'
import { vPerm } from '@/core/permission'
import { startRealtime } from '@/core/realtime/socket'

const app = createApp(App)
// the CronEditor's picker (@vue-js-cron) renders these by tag name, as under app.use(ElementPlus); the
// rest of Element Plus stays imported on demand
for (const c of [ElButton, ElDropdown, ElDropdownItem, ElDropdownMenu, ElIcon]) app.use(c)
app.use(createPinia()).use(i18n).use(router).directive('perm', vPerm).mount('#app')
reloadOnPermChange(router)
startRealtime()
