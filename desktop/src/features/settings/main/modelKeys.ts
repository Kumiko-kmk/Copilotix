import {
  connectionProvider,
  createConnection,
  credentialRefFor,
  KEY_PROVIDERS,
  type ConnectionHealth,
  type KeyProvider,
  type ModelConnection
} from '@platform/models/contract/models'
import type { CredentialAccount } from '@platform/credentials/main/credentialVault'
import type { CredentialStatus, KeyStatus } from '../contract/settingsTypes'

/** 'parser' or a model key's connection id; each owns one vault account and one validation record. */
export type CredentialId = 'parser' | string

export function isKeyConnection(connection: ModelConnection): connection is ModelConnection & { provider: KeyProvider } {
  return connection.provider !== 'codex'
}

export function accountFor(id: CredentialId): CredentialAccount {
  if (id === 'parser') return 'parser-token'
  const ref = credentialRefFor(id)
  if (!ref) throw new Error('Connection has no stored key')
  return ref as CredentialAccount
}

export function validationAccountFor(id: CredentialId): CredentialAccount {
  return `${accountFor(id)}-validation` as CredentialAccount
}

export function credentialProvider(id: CredentialId): 'parser' | KeyProvider {
  if (id === 'parser') return 'parser'
  const provider = connectionProvider(id)
  if (provider !== 'qwen' && provider !== 'deepseek') throw new Error('Connection has no stored key')
  return provider
}

export function isKeyId(id: string): boolean {
  const provider = connectionProvider(id)
  return provider === 'qwen' || provider === 'deepseek'
}

/** Keeps the given order, renumbers priority within each provider and always keeps one Codex connection. */
export function normalizeConnections(connections: readonly ModelConnection[] | undefined): ModelConnection[] {
  const list = [...(connections ?? [])]
  if (!list.some(value => value.provider === 'codex')) list.push(createConnection('codex', 'codex:default', 0))
  const next = new Map<string, number>()
  return list.map(({ label, ...connection }) => {
    const priority = next.get(connection.provider) ?? 0
    next.set(connection.provider, priority + 1)
    // An emptied name arrives as undefined over IPC; omit it so the Core RPC envelope stays plain JSON.
    return { ...connection, ...(label ? { label } : {}), priority }
  })
}

/** Enabled keys of one provider in the order requests try them. */
export function orderedKeys(connections: readonly ModelConnection[], provider: KeyProvider): ModelConnection[] {
  return connections.filter(value => value.provider === provider && value.enabled).sort((a, b) => a.priority - b.priority)
}

export function runtimeHealth(health: ConnectionHealth, now: number): Pick<KeyStatus, 'health' | 'retryAt'> {
  if (health.status === 'invalid') return { health: 'rejected' }
  if (health.status === 'cooldown' && health.nextAllowedAt > now) return { health: 'cooldown', retryAt: health.nextAllowedAt }
  return {}
}

/** A provider is usable when any enabled key is verified; otherwise report the most actionable state. */
export function providerSummary(connections: readonly ModelConnection[], statuses: Record<string, KeyStatus>, provider: KeyProvider): CredentialStatus {
  const enabled = orderedKeys(connections, provider).map(value => statuses[value.connectionId]).filter((value): value is KeyStatus => Boolean(value))
  const pick = (state: CredentialStatus['state']): KeyStatus | undefined => enabled.find(value => value.state === state)
  const chosen = pick('valid') ?? pick('unknown') ?? pick('invalid')
  if (!chosen) return { state: 'missing' }
  const { health: _health, retryAt: _retryAt, ...status } = chosen
  return status
}

export { KEY_PROVIDERS }
