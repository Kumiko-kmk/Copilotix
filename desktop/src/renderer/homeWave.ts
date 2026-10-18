/**
 * Home page decryption waves, shared by the cipher backdrop and the wordmark so the title decodes
 * letter by letter exactly as a wave front crosses it. The backdrop owns the waves: it handles
 * requests (a click on the wordmark) and announces every wave it starts.
 */
export interface HomeWave {
  /** Origin in client pixels. */
  x: number
  y: number
  /** performance.now() when the front left the origin. */
  start: number
  /** Front speed in client pixels per millisecond. */
  speed: number
}

const listeners = new Set<(wave: HomeWave) => void>()
let requestHandler: ((x: number, y: number) => void) | null = null

export function onHomeWave(listener: (wave: HomeWave) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitHomeWave(wave: HomeWave): void {
  for (const listener of listeners) listener(wave)
}

export function handleHomeWaveRequests(handler: (x: number, y: number) => void): () => void {
  requestHandler = handler
  return () => { if (requestHandler === handler) requestHandler = null }
}

/** Asks the backdrop for a wave from a client point; false when no backdrop is running. */
export function requestHomeWave(x: number, y: number): boolean {
  if (!requestHandler) return false
  requestHandler(x, y)
  return true
}
