import {
  PARTICLE_ATTRIBUTE_STRIDE,
  readLakeParticle,
  sampleLakeParticle,
  type LakeParticle,
  type LakeParticleField,
  type LakeParticleSample,
  type LakeRendererKind
} from './particleLake'
import { type WaveFieldFrame, type WaveFieldSample } from './waveField'

export type LakeRenderer = {
  readonly kind: LakeRendererKind
  resize(width: number, height: number, pixelRatio: number): void
  setField(field: LakeParticleField): void
  setWaveField(frame: WaveFieldFrame): void
  setPalette(colors: string[]): void
  draw(timeSeconds: number, width: number, height: number, pixelRatio: number): void
  dispose(): void
}

const VERTEX_SHADER = `#version 300 es
precision highp float;

in vec4 a_geometry;
in vec4 a_style;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_pixel_ratio;
uniform float u_wave_samples;
uniform sampler2D u_wave_field;
uniform vec3 u_palette[6];
out vec3 v_color;
out float v_alpha;

vec4 sampleWaveField(float normalizedX, float ridge, out float slope) {
  float position = fract(normalizedX) * u_wave_samples;
  int sampleCount = int(u_wave_samples);
  int leftIndex = int(floor(position)) % sampleCount;
  int rightIndex = (leftIndex + 1) % sampleCount;
  int row = clamp(int(ridge + 0.5), 0, textureSize(u_wave_field, 0).y - 1);
  vec4 leftSample = texelFetch(u_wave_field, ivec2(leftIndex, row), 0);
  vec4 rightSample = texelFetch(u_wave_field, ivec2(rightIndex, row), 0);
  slope = (rightSample.x - leftSample.x) * u_wave_samples;
  return mix(leftSample, rightSample, fract(position));
}

void main() {
  float distanceTravelled = a_style.x * u_time;
  float firstSlope = 0.0;
  float approximateX = fract(a_geometry.x + distanceTravelled / max(1.0, u_resolution.x));
  sampleWaveField(approximateX, a_geometry.z, firstSlope);
  float firstArcScale = length(vec2(1.0, firstSlope * u_resolution.y / max(1.0, u_resolution.x)));
  float normalizedX = fract(a_geometry.x + distanceTravelled / max(1.0, u_resolution.x * firstArcScale));
  float slope = 0.0;
  vec4 wave = sampleWaveField(normalizedX, a_geometry.z, slope);
  vec2 tangent = normalize(vec2(1.0, slope * u_resolution.y / max(1.0, u_resolution.x)));
  vec2 normal = vec2(-tangent.y, tangent.x);
  float depth = clamp(wave.x, 0.0, 1.0);
  float highCycles = 8.0 + mod(a_geometry.z, 6.0);
  float highJitter = sin(normalizedX * 6.28318530718 * highCycles + a_geometry.w + u_time * 0.74) * mix(0.3, 1.2, depth);
  float alongJitter = sin(u_time * 0.34 + a_geometry.w) * 2.6;
  float normalDistance = a_geometry.y * wave.z * u_resolution.y + highJitter;
  vec2 centerPixels = vec2(normalizedX * u_resolution.x, wave.x * u_resolution.y) + tangent * alongJitter;
  vec2 positionPixels = centerPixels + normal * normalDistance;
  positionPixels.x = mod(positionPixels.x + u_resolution.x, u_resolution.x);
  float verticalWeight = exp(-0.5 * a_geometry.y * a_geometry.y);
  float coreWeight = 1.0 - smoothstep(0.2, 0.52, abs(a_geometry.y));
  float haloGate = mix(wave.w, 1.0, coreWeight);
  float localDensity = wave.y * haloGate * verticalWeight;
  float thresholdFade = clamp((localDensity - a_style.w) * 8.0 + 0.5, 0.0, 1.0);
  float continuousCore = coreWeight * (0.34 + wave.y * 0.46);
  float fade = max(thresholdFade, continuousCore);
  float crestBoost = 0.35 + wave.y * 3.25;
  float virtualSize = a_style.y * u_pixel_ratio;
  float subpixelCoverage = min(1.0, virtualSize);

  gl_Position = fade > 0.001
    ? vec4(positionPixels.x / u_resolution.x * 2.0 - 1.0, 1.0 - positionPixels.y / u_resolution.y * 2.0, 0.0, 1.0)
    : vec4(2.0, 2.0, 0.0, 1.0);
  gl_PointSize = max(1.0, virtualSize);
  v_color = u_palette[int(mod(a_geometry.z, 6.0))];
  v_alpha = clamp(a_style.z * crestBoost * (0.3 + verticalWeight * 0.7) * fade * subpixelCoverage, 0.0, 0.8);
}
`

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec3 v_color;
in float v_alpha;
out vec4 outputColor;

void main() {
  float distanceFromCenter = distance(gl_PointCoord, vec2(0.5));
  float particleEdge = 1.0 - smoothstep(0.28, 0.58, distanceFromCenter);
  if (particleEdge <= 0.01 || v_alpha <= 0.001) discard;
  outputColor = vec4(v_color, v_alpha * particleEdge);
}
`

export function createWebGlLakeRenderer(canvas: HTMLCanvasElement): LakeRenderer | null {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    powerPreference: 'high-performance',
    premultipliedAlpha: true
  })
  if (!gl) return null

  let pendingVertexShader: WebGLShader | null = null
  let pendingFragmentShader: WebGLShader | null = null
  let pendingProgram: WebGLProgram | null = null
  let pendingVertexArray: WebGLVertexArrayObject | null = null
  let pendingBuffer: WebGLBuffer | null = null
  let pendingTexture: WebGLTexture | null = null

  try {
    pendingVertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
    pendingFragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
    const program = linkProgram(gl, pendingVertexShader, pendingFragmentShader)
    pendingProgram = program
    gl.deleteShader(pendingVertexShader)
    gl.deleteShader(pendingFragmentShader)
    pendingVertexShader = null
    pendingFragmentShader = null

    const vertexArray = gl.createVertexArray()
    const buffer = gl.createBuffer()
    const waveTexture = gl.createTexture()
    if (!vertexArray || !buffer || !waveTexture) throw new Error('WebGL particle resources are unavailable')
    pendingVertexArray = vertexArray
    pendingBuffer = buffer
    pendingTexture = waveTexture

    const geometryLocation = gl.getAttribLocation(program, 'a_geometry')
    const styleLocation = gl.getAttribLocation(program, 'a_style')
    const resolutionLocation = requireUniform(gl, program, 'u_resolution')
    const timeLocation = requireUniform(gl, program, 'u_time')
    const pixelRatioLocation = requireUniform(gl, program, 'u_pixel_ratio')
    const waveSamplesLocation = requireUniform(gl, program, 'u_wave_samples')
    const waveFieldLocation = requireUniform(gl, program, 'u_wave_field')
    const paletteLocation = requireUniform(gl, program, 'u_palette[0]')
    if (geometryLocation < 0 || styleLocation < 0) throw new Error('WebGL particle attributes are incomplete')

    gl.bindVertexArray(vertexArray)
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    const strideBytes = PARTICLE_ATTRIBUTE_STRIDE * Float32Array.BYTES_PER_ELEMENT
    gl.enableVertexAttribArray(geometryLocation)
    gl.vertexAttribPointer(geometryLocation, 4, gl.FLOAT, false, strideBytes, 0)
    gl.enableVertexAttribArray(styleLocation)
    gl.vertexAttribPointer(styleLocation, 4, gl.FLOAT, false, strideBytes, 4 * Float32Array.BYTES_PER_ELEMENT)
    gl.bindVertexArray(null)

    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, waveTexture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 512, 1, 0, gl.RGBA, gl.FLOAT, null)
    gl.useProgram(program)
    gl.uniform1i(waveFieldLocation, 0)
    gl.uniform1f(waveSamplesLocation, 512)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.clearColor(0, 0, 0, 0)

    let particleCount = 0
    let textureSamples = 512
    let textureFields = 1

    return {
      kind: 'webgl2',
      resize(width, height, pixelRatio) {
        canvas.width = Math.max(1, Math.round(width * pixelRatio))
        canvas.height = Math.max(1, Math.round(height * pixelRatio))
        gl.viewport(0, 0, canvas.width, canvas.height)
      },
      setField(field) {
        particleCount = field.count
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
        gl.bufferData(gl.ARRAY_BUFFER, field.attributes, gl.STATIC_DRAW)
      },
      setWaveField(frame) {
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, waveTexture)
        if (textureSamples !== frame.samples || textureFields !== frame.fields) {
          textureSamples = frame.samples
          textureFields = frame.fields
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, frame.samples, frame.fields, 0, gl.RGBA, gl.FLOAT, frame.data)
          gl.useProgram(program)
          gl.uniform1f(waveSamplesLocation, frame.samples)
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, frame.samples, frame.fields, gl.RGBA, gl.FLOAT, frame.data)
        }
      },
      setPalette(colors) {
        gl.useProgram(program)
        gl.uniform3fv(paletteLocation, paletteFloats(colors))
      },
      draw(timeSeconds, width, height, pixelRatio) {
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.useProgram(program)
        gl.uniform2f(resolutionLocation, Math.max(1, width), Math.max(1, height))
        gl.uniform1f(timeLocation, timeSeconds)
        gl.uniform1f(pixelRatioLocation, pixelRatio)
        gl.bindVertexArray(vertexArray)
        gl.drawArrays(gl.POINTS, 0, particleCount)
        gl.bindVertexArray(null)
      },
      dispose() {
        gl.deleteTexture(waveTexture)
        gl.deleteBuffer(buffer)
        gl.deleteVertexArray(vertexArray)
        gl.deleteProgram(program)
      }
    }
  } catch {
    if (pendingTexture) gl.deleteTexture(pendingTexture)
    if (pendingBuffer) gl.deleteBuffer(pendingBuffer)
    if (pendingVertexArray) gl.deleteVertexArray(pendingVertexArray)
    if (pendingProgram) gl.deleteProgram(pendingProgram)
    if (pendingVertexShader) gl.deleteShader(pendingVertexShader)
    if (pendingFragmentShader) gl.deleteShader(pendingFragmentShader)
    return null
  }
}

export function createCanvasLakeRenderer(canvas: HTMLCanvasElement): LakeRenderer | null {
  const context = canvas.getContext('2d', { alpha: true })
  if (!context) return null
  const particle: LakeParticle = { arc: 0, normal: 0, ridge: 0, phase: 0, speed: 18, size: 0.8, opacity: 0.08, visibility: 0.5 }
  const sample: LakeParticleSample = {
    x: 0, y: 0, centerX: 0, centerY: 0, tangentX: 1, tangentY: 0, normalX: 0, normalY: 1,
    opacity: 0, size: 1, density: 0, gap: 0
  }
  const waveSample: WaveFieldSample = { center: 0, density: 0, thickness: 0.05, gap: 0, slope: 0 }
  let field: LakeParticleField = { count: 0, attributes: new Float32Array() }
  let waveFrame: WaveFieldFrame | null = null
  let palette = ['#4db99f']

  return {
    kind: 'canvas2d',
    resize(width, height, pixelRatio) {
      canvas.width = Math.max(1, Math.round(width * pixelRatio))
      canvas.height = Math.max(1, Math.round(height * pixelRatio))
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0)
    },
    setField(nextField) {
      field = nextField
    },
    setWaveField(nextFrame) {
      waveFrame = nextFrame
    },
    setPalette(colors) {
      palette = colors.length > 0 ? colors : palette
    },
    draw(timeSeconds, width, height) {
      context.clearRect(0, 0, width, height)
      if (!waveFrame) return
      let activeRidge = -1
      for (let index = 0; index < field.count; index += 1) {
        readLakeParticle(field, index, particle)
        if (particle.ridge !== activeRidge) {
          activeRidge = particle.ridge
          context.fillStyle = palette[activeRidge % palette.length] ?? '#4db99f'
        }
        sampleLakeParticle(particle, waveFrame, timeSeconds, width, height, sample, waveSample)
        if (sample.opacity <= 0.001) continue
        context.globalAlpha = sample.opacity
        context.fillRect(sample.x, sample.y, sample.size, sample.size)
      }
      context.globalAlpha = 1
    },
    dispose() {
      field = { count: 0, attributes: new Float32Array() }
      waveFrame = null
    }
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('Unable to create WebGL shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const details = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error'
    gl.deleteShader(shader)
    throw new Error(details)
  }
  return shader
}

function linkProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram {
  const program = gl.createProgram()
  if (!program) throw new Error('Unable to create WebGL program')
  gl.attachShader(program, vertexShader)
  gl.attachShader(program, fragmentShader)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const details = gl.getProgramInfoLog(program) || 'Unknown shader link error'
    gl.deleteProgram(program)
    throw new Error(details)
  }
  return program
}

function requireUniform(gl: WebGL2RenderingContext, program: WebGLProgram, name: string): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name)
  if (!location) throw new Error(`WebGL uniform is unavailable: ${name}`)
  return location
}

function paletteFloats(colors: string[]): Float32Array {
  const output = new Float32Array(18)
  for (let index = 0; index < 6; index += 1) {
    const color = parseCssColor(colors[index] ?? colors[0] ?? '#4db99f')
    output[index * 3] = color[0]
    output[index * 3 + 1] = color[1]
    output[index * 3 + 2] = color[2]
  }
  return output
}

function parseCssColor(value: string): [number, number, number] {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1]
  if (hex) {
    const expanded = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex
    return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255) as [number, number, number]
  }
  const rgb = value.match(/rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)/i)
  if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255]
  return [0.302, 0.725, 0.624]
}
