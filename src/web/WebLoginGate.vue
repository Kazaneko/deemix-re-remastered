<script setup lang="ts">
// Password screen shown by the web UI (headless server) before the app loads.
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { SUPPORTED_LOCALES, setLocale } from '../i18n'
import { loginToServer } from './webBridge'

const { t } = useI18n()
const password = ref('')
const busy = ref(false)
const error = ref('')
const input = ref<HTMLInputElement | null>(null)

// Saved settings are behind the login, so follow the browser's language here.
function browserLocale(): string | null {
  for (const lang of navigator.languages ?? [navigator.language]) {
    const lower = (lang || '').toLowerCase()
    const exact = SUPPORTED_LOCALES.find(l => l.code === lower)
    if (exact) return exact.code
    const base = SUPPORTED_LOCALES.find(l => l.code === lower.split('-')[0])
    if (base) return base.code
    if (lower.startsWith('pt')) return 'pt-pt'
    if (lower.startsWith('zh')) return /tw|hk|hant/.test(lower) ? 'zh-tw' : 'zh-cn'
  }
  return null
}

onMounted(async () => {
  const locale = browserLocale()
  if (locale && locale !== 'en') await setLocale(locale).catch(() => undefined)
  input.value?.focus()
})

async function submit() {
  if (!password.value || busy.value) return
  busy.value = true
  error.value = ''
  const outcome = await loginToServer(password.value)
  if (outcome === 'ok') {
    window.location.reload()
    return
  }
  busy.value = false
  password.value = ''
  error.value = outcome === 'rate-limited'
    ? t('web.tooManyAttempts')
    : outcome === 'invalid'
      ? t('login.failed')
      : t('login.serverConnectFailed')
  input.value?.focus()
}
</script>

<template>
  <div class="min-h-full flex items-center justify-center bg-background-main text-foreground p-6">
    <form
      class="w-full max-w-sm border border-white/[0.08] bg-background-secondary p-8 space-y-6"
      @submit.prevent="submit"
    >
      <h1 class="font-display text-2xl tracking-tight">Deemix Remastered</h1>
      <div>
        <label for="web-password" class="block text-sm font-medium mb-2">{{ t('login.password') }}</label>
        <input
          id="web-password"
          ref="input"
          v-model="password"
          type="password"
          autocomplete="current-password"
          class="input w-full"
          :class="{ 'border-red-500': error }"
          :disabled="busy"
        />
        <p v-if="error" class="mt-2 text-sm text-red-400" role="alert">{{ error }}</p>
      </div>
      <button type="submit" class="btn btn-primary w-full" :disabled="busy || !password">
        {{ busy ? t('login.loggingIn') : t('login.logIn') }}
      </button>
    </form>
  </div>
</template>
