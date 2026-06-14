/**
 * svalueToSantaJson struct arms — canonical-bytes round-trip pins (F4 Task 2).
 *
 * AvlTree/Box/Header SValues serialize to `{ kind, bytes_hex }` via
 * `serializeSValue` — the exact inverse of `hydrateCanonicalBytes`
 * (test/_helpers/index.ts:51, parseSValue at version 3). The version
 * constant is the version-free data-layer channel rationale from F2
 * (hydrateCanonicalBytes consolidation, 531c8fa).
 *
 * bytes_hex sources:
 *   AvlTree — verbatim from SANTA's JVM-blessed AvlTree.insertOrUpdate.json
 *             fresh-key expected value (digest f1b5df03… + flags 07 +
 *             keyLength 32 + valueLengthOpt Some(8)); vendored at
 *             test/fixtures/conformance/v6/authored/AvlTree.insertOrUpdate.json.
 *   Box     — first bytes_hex Box found in a vendored SANTA vector
 *             (scan order v5/spec → v5/authored → v6/spec → v6/authored,
 *             filenames sorted).
 *   Header  — first bytes_hex Header found in a vendored SANTA vector
 *             (any Header-carrying file is equally valid, the pin only
 *             asserts the round-trip of whatever hex the scan returns).
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { hydrateSValue } from '../_helpers'
import { svalueToSantaJson } from './_santa'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const v5dir = path.join(__dirname, '../fixtures/conformance/v5')
const v6dir = path.join(__dirname, '../fixtures/conformance/v6')

/** Round-trip: hydrate {kind, bytes_hex} → SValue → svalueToSantaJson → same JSON. */
function roundTrip(kind: string, bytesHex: string): void {
  const json = { kind, bytes_hex: bytesHex }
  const v = hydrateSValue(json)
  expect(svalueToSantaJson(v)).toEqual(json)
}

describe('svalueToSantaJson — canonical-bytes struct arms', () => {
  it('AvlTree round-trips (insertOrUpdate fresh-key expected bytes)', () => {
    roundTrip(
      'AvlTree',
      'f1b5df03eaef0fc804d5db5ad0be313d36e9be3aecbd10ec9175fd2a489a3cc60407200108'
    )
  })

  it('Box round-trips (first bytes_hex found in a vendored SANTA vector)', () => {
    const hex = firstBytesHexOfKind('Box')
    roundTrip('Box', hex)
  })

  it('Header round-trips (first bytes_hex found in a vendored SANTA vector)', () => {
    const hex = firstBytesHexOfKind('Header')
    roundTrip('Header', hex)
  })
})

/**
 * Scan vendored SANTA vector files (v5 then v6, spec then authored tier,
 * filenames sorted) for the first `{kind, bytes_hex}` SValue of the given
 * kind (inputs or expected values) — keeps the pins anchored to real
 * JVM-blessed bytes without hardcoding long hex strings here.
 */
function firstBytesHexOfKind(kind: string): string {
  for (const base of [v5dir, v6dir]) {
    for (const tier of ['spec', 'authored'] as const) {
      const dir = path.join(base, tier)
      for (const f of fs.readdirSync(dir).sort()) {
        if (!f.endsWith('.json')) continue
        const doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        const found = scan(doc)
        if (found !== null) return found
      }
    }
  }
  throw new Error(`no ${kind} bytes_hex in any vendored SANTA vector`)

  function scan(node: unknown): string | null {
    if (node === null || typeof node !== 'object') return null
    const o = node as Record<string, unknown>
    if (o.kind === kind && typeof o.bytes_hex === 'string') return o.bytes_hex as string
    // Object.values on an array yields its elements, so arrays are covered here.
    for (const v of Object.values(o)) {
      const r = scan(v)
      if (r !== null) return r
    }
    return null
  }
}
