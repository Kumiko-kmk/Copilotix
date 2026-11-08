import { describe, expect, it } from 'vitest'
import { V2Database } from '@platform/database/utility/v2Database'
import { V2TaskRepositoryCompat } from '@features/library/utility'
describe('removed provider settings migration', () => {
  it.each([
    [['bing', 'deepseek', 'qwen', 'transmart', 'codex'], ['bing', 'deepseek'], ['deepseek'], 'deepseek'],
    [['bing', 'deepseek', 'qwen', 'transmart', 'codex'], ['bing', 'transmart'], [], null],
    [['qwen', 'codex', 'deepseek', 'bing', 'transmart'], [], [], null]
  ])('preserves remaining order and explicit disabled services', (order, enabled, expected, preferred) => {
    const db = new V2Database(':memory:')
    try {
      const statement = db.connection.prepare('INSERT INTO settings(key,value) VALUES(?,?)')
      statement.run('translationProviderOrder', JSON.stringify(order))
      statement.run('enabledTranslationProviders', JSON.stringify(enabled))
      statement.run('translationProvider', JSON.stringify('bing'))
      const settings = new V2TaskRepositoryCompat(db).getSettings('C:/fixture')
      expect(settings.enabledTranslationProviders).toEqual(expected)
      expect(settings.translationProvider).toBe(preferred)
      expect(settings.translationProviderOrder).toEqual(order.filter(id => id !== 'bing' && id !== 'transmart'))
      expect(JSON.parse((db.connection.prepare("SELECT value FROM settings WHERE key='translationProvider'").get() as { value: string }).value)).toBe('bing')
    } finally { db.close() }
  })
})
