/** Main compatibility surface; title parsing and sanitization are shared pure functions. */
export {
  extractPaperTitle,
  cleanTitleText,
  sanitizeTitleStem,
  titleFileName,
  MAX_TITLE_STEM_LENGTH
} from '@shared/titleNaming'
