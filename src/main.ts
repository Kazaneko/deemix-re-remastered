import { createApp } from 'vue'
import { createPinia } from 'pinia'
import router from './router'
import i18n from './i18n'
import App from './App.vue'
import { tooltip } from './directives/tooltip'
import { fetchSession, installFetchRewrite, installWebBridge, isHeadlessWeb } from './web/webBridge'
import WebLoginGate from './web/WebLoginGate.vue'
import '@fontsource/archivo-black'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/700.css'
import './assets/main.css'


function mountApp() {
  const app = createApp(App)

  app.use(createPinia())
  app.use(router)
  app.use(i18n)
  app.directive('tooltip', tooltip)

  app.mount('#app')
}

// Web mode (headless server, see src/web/webBridge.ts): log in to the server,
// then provide window.electronAPI over HTTP before any store reads it.
async function start() {
  if (!isHeadlessWeb()) {
    mountApp()
    return
  }
  installFetchRewrite()
  const session = await fetchSession()
  if (session.authRequired && !session.authenticated) {
    createApp(WebLoginGate).use(i18n).mount('#app')
    return
  }
  await installWebBridge()
  mountApp()
}

start().catch(error => {
  console.error('[main] Startup failed:', error)
})
