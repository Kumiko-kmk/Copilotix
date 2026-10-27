/** Resolves a candidate path strictly inside a root; implemented by `PathPolicy`. */
export interface PathPolicyPort {
  resolveChild(root: string, candidate: string): string
}
