export function shouldDisableGpuSandbox(env: {
  NODE_ENV?: string
  COPILOTIX_E2E_DISABLE_GPU_SANDBOX?: string
}): boolean {
  return env.NODE_ENV === 'test' && env.COPILOTIX_E2E_DISABLE_GPU_SANDBOX === 'true'
}
