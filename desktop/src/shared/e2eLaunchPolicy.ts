export function shouldDisableGpuSandbox(env: {
  NODE_ENV?: string
  MINERU_E2E_DISABLE_GPU_SANDBOX?: string
}): boolean {
  return env.NODE_ENV === 'test' && env.MINERU_E2E_DISABLE_GPU_SANDBOX === 'true'
}
