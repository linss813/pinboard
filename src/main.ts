import './style.css'
import { App } from './app'
import { initI18n } from './i18n'

initI18n()
const app = new App()

if (import.meta.env.DEV) {
  ;(window as unknown as { __pinboard?: App }).__pinboard = app
}
