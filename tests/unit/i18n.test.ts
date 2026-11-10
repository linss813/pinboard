import { afterAll, describe, expect, it } from 'vitest'
import { getLocale, setLocale, t } from '../../src/i18n'

afterAll(() => setLocale('zh-CN'))

describe('i18n', () => {
  it('provides translations for all three locales', () => {
    setLocale('zh-CN')
    expect(t('pinned.title')).toBe('已钉住')
    expect(getLocale()).toBe('zh-CN')
    setLocale('zh-TW')
    expect(t('pinned.title')).toBe('已釘住')
    expect(getLocale()).toBe('zh-TW')
    setLocale('en')
    expect(t('pinned.title')).toBe('Pinned')
    expect(getLocale()).toBe('en')
  })

  it('interpolates values and keeps untranslated tokens intact', () => {
    setLocale('en')
    expect(t('avatar.follow', { name: 'Alex' })).toBe('Follow Alex')
    setLocale('zh-TW')
    expect(t('toast.copied', { n: 3 })).toBe('已複製 3 個內容')
    expect(t('pinnedTime.minutesAgo', { n: 5 })).toBe('5 分鐘前釘住')
  })

  it('falls back to the key for unknown parameters', () => {
    setLocale('zh-CN')
    expect(t('toast.welcome', {})).toBe('欢迎，{name}')
  })
})
