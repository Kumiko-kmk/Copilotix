import { expect, it } from 'vitest'
import { matchesTitleSearch } from '@features/library/core/titleSearch'

it('matches Chinese, English keywords, abbreviations, full-width text and diacritics locally', () => {
  const titles = ['混合模式断裂研究 — Mixed-Mode Fracture Mechanics.pdf', '研究原稿.pdf']
  for (const query of ['混合断裂', '断裂 研究', 'FRACTURE mixed', 'ＭＩＸＥＤ', 'mmfm', '原稿']) {
    expect(matchesTitleSearch(titles, query), query).toBe(true)
  }
  expect(matchesTitleSearch(['Étude of damage'], 'etude')).toBe(true)
  expect(matchesTitleSearch(titles, 'quantum computing')).toBe(false)
  expect(matchesTitleSearch(titles, '')).toBe(true)
})
