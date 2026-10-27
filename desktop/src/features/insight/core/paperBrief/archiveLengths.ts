/** Length ranges (in 字, see ./lengths) of the archive analysis fields; kept apart so the schema does not import the checker. */
export const ARCHIVE_LENGTHS = {
  abstract: [200, 300], background: [300, 420], backgroundPoint: [100, 140],
  conclusions: [300, 420], conclusion: [100, 140],
  discussion: [300, 420], discussionPart: [100, 140]
} as const satisfies Record<string, readonly [min: number, max: number]>
