import assert from 'node:assert/strict'
import { Entry } from '@napi-rs/keyring'

const [action, fixtureId] = process.argv.slice(2)
assert(/^[a-f0-9]{32}$/u.test(fixtureId ?? ''), 'Invalid test credential ID')
const entry = new Entry('Copilotix-Translation', `setup-test-${fixtureId}`)
const marker = `installer-preservation-${fixtureId}`
if (action === 'create') {
  assert(entry.getPassword() == null, 'Refusing to overwrite an existing credential')
  entry.setPassword(marker)
} else if (action === 'verify') {
  assert.equal(entry.getPassword(), marker, 'Installer removed or changed credential-manager state')
} else if (action === 'remove') {
  entry.deleteCredential()
} else {
  throw new Error('Unknown credential fixture action')
}
