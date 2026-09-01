// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ParticleLakeBackground from '../src/renderer/components/ParticleLakeBackground'

const canvasContext = {
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  setTransform: vi.fn(),
  fillStyle: '',
  globalAlpha: 1
}

function createWebGlContext(): WebGL2RenderingContext {
  const context = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    BLEND: 0x0be2,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    COLOR_BUFFER_BIT: 0x4000,
    POINTS: 0x0000,
    TEXTURE0: 0x84c0,
    TEXTURE_2D: 0x0de1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    RGBA32F: 0x8814,
    RGBA: 0x1908,
    createShader: vi.fn(() => ({})),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ''),
    deleteShader: vi.fn(),
    createProgram: vi.fn(() => ({})),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true),
    getProgramInfoLog: vi.fn(() => ''),
    deleteProgram: vi.fn(),
    createVertexArray: vi.fn(() => ({})),
    bindVertexArray: vi.fn(),
    deleteVertexArray: vi.fn(),
    createBuffer: vi.fn(() => ({})),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    deleteBuffer: vi.fn(),
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    pixelStorei: vi.fn(),
    texImage2D: vi.fn(),
    texSubImage2D: vi.fn(),
    getAttribLocation: vi.fn((_program, name: string) => name === 'a_geometry' ? 0 : 1),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn(() => ({})),
    useProgram: vi.fn(),
    uniform2f: vi.fn(),
    uniform1f: vi.fn(),
    uniform1i: vi.fn(),
    uniform3fv: vi.fn(),
    enable: vi.fn(),
    blendFunc: vi.fn(),
    clearColor: vi.fn(),
    viewport: vi.fn(),
    clear: vi.fn(),
    drawArrays: vi.fn()
  }
  return context as unknown as WebGL2RenderingContext
}

class ResizeObserverMock {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element): void {
    this.callback([{ target } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  disconnect(): void {}
  unobserve(): void {}
}

function installMatchMedia(reducedMotion: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    matches: query.includes('reduced-motion') ? reducedMotion : true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  })))
}

describe('ParticleLakeBackground', () => {
  let webGlContext: WebGL2RenderingContext

  beforeEach(() => {
    vi.clearAllMocks()
    webGlContext = createWebGlContext()
    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => {
      if (type === 'webgl2') return webGlContext
      if (type === '2d') return canvasContext as unknown as CanvasRenderingContext2D
      return null
    }) as typeof HTMLCanvasElement.prototype.getContext)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1100,
      height: 700,
      top: 0,
      right: 1100,
      bottom: 700,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({})
    })
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('draws a high-density static WebGL frame for reduced motion', () => {
    installMatchMedia(true)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
    const view = render(<ParticleLakeBackground seed={21} />)
    const lake = view.getByTestId('particle-lake')

    expect(lake.getAttribute('data-renderer')).toBe('webgl2')
    expect(lake.getAttribute('data-render-state')).toBe('static')
    expect(Number(lake.getAttribute('data-particle-count'))).toBeGreaterThanOrEqual(128_000)
    expect((webGlContext.drawArrays as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    expect((webGlContext.texSubImage2D as ReturnType<typeof vi.fn>)).toHaveBeenCalled()
    expect(lake.getAttribute('data-wave-sample')).toBeTruthy()
    expect(lake.getAttribute('data-tangent-sample')).toBeTruthy()
    expect(Number(lake.getAttribute('data-ridge-count'))).toBe(7)
    const depthProfile = lake.getAttribute('data-depth-profile')!.split(',').map(Number)
    expect(depthProfile[1]).toBeGreaterThan(depthProfile[0] ?? 0)
    expect(depthProfile[2]).toBeGreaterThan(depthProfile[0] ?? 0)
    expect(requestFrame).not.toHaveBeenCalled()
  })

  it('falls back on context loss and restores WebGL without leaking animation frames', () => {
    installMatchMedia(false)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(17)
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    const view = render(<ParticleLakeBackground seed={22} />)
    const lake = view.getByTestId('particle-lake')
    const webGlCanvas = view.container.querySelector<HTMLCanvasElement>('[data-particle-canvas="webgl2"]')!

    expect(lake.getAttribute('data-renderer')).toBe('webgl2')
    expect(requestFrame).toHaveBeenCalled()
    const contextLost = new Event('webglcontextlost', { cancelable: true })
    fireEvent(webGlCanvas, contextLost)
    expect(contextLost.defaultPrevented).toBe(true)
    expect(lake.getAttribute('data-renderer')).toBe('canvas2d')
    expect(Number(lake.getAttribute('data-particle-count'))).toBeGreaterThanOrEqual(18_000)
    expect(Number(lake.getAttribute('data-ridge-count'))).toBe(7)

    fireEvent(webGlCanvas, new Event('webglcontextrestored'))
    expect(lake.getAttribute('data-renderer')).toBe('webgl2')
    expect(Number(lake.getAttribute('data-particle-count'))).toBeGreaterThanOrEqual(128_000)
    view.unmount()
    expect(cancelFrame).toHaveBeenCalledWith(17)
  })

  it('uses Canvas when shader compilation fails and pauses while hidden', () => {
    installMatchMedia(false)
    vi.mocked(webGlContext.getShaderParameter).mockReturnValue(false)
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(23)
    const view = render(<ParticleLakeBackground seed={23} />)
    const lake = view.getByTestId('particle-lake')

    expect(lake.getAttribute('data-renderer')).toBe('canvas2d')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    fireEvent(document, new Event('visibilitychange'))
    expect(lake.getAttribute('data-render-state')).toBe('paused')
  })
})
