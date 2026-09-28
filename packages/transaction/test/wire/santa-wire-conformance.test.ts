// SANTA JVM-blessed Transaction wire vectors (santa@06a6427, @2f95044, @fb35b8d, @2b1acee and
// @9421c11, vectors/wire/v6/authored/, blessed by sigma-state 6.0.6), replayed as Dasher replays them:
// an accept must round-trip to its `expected_bytes_hex` when present (a non-identity round-trip),
// else to its own bytes; a reject must fail parseTransaction, here with the file's own code, or with
// the entry's own code where a file's rejects differ.
// The context-extension id/count files are replayed in context-extension-bounds.test.ts.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTransaction, serializeTransaction } from '../../src/index.ts';
import { hexToBytes, bytesToHex } from '../_helpers';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'conformance');

interface WireEntry { name: string; bytes_hex: string; expected_bytes_hex?: string; error?: 'errored' }
const loadEntries = (file: string): WireEntry[] =>
  (JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as { entries: WireEntry[] }).entries;

const DEPTH = 'max-tree-depth-exceeded';
/** A file's reject code: one for every reject, or one per entry name. */
type RejectCode = string | null | Record<string, string>;
const codeFor = (rejectCode: RejectCode, name: string): string | null => {
  if (rejectCode === null || typeof rejectCode === 'string') return rejectCode;
  const code = rejectCode[name];
  if (code === undefined) throw new Error(`no reject code for ${name}`);
  return code;
};
const FILES: [string, RejectCode, string[]][] = [
  ['Transaction.context_extension_v6_type.json', 'extension-v6-type', [
    'ext-ubi-reject#0', 'ext-bigint-accept#1', 'ext-coll-option-int-empty-reject#2', 'ext-coll-header-empty-reject#3',
    'ext-coll-int-empty-accept#4', 'ext-tuple-int-ubi-reject#5', 'ext-tuple-int-bigint-accept#6']],
  ['Transaction.context_extension_depth_bound.json', DEPTH, ['ext-depth-coll109-accept#0', 'ext-depth-coll110-reject#1']],
  ['Transaction.context_extension_duplicate_ids.json', null,
    ['ext-dup-ids-05-07-05-collapse#0', 'ext-dup-ids-07-05-07-collapse#1']],
  ['Transaction.degraded_tree_depth_leak.json', DEPTH, ['degrade-leak-coll99-accept#0', 'degrade-leak-coll100-reject#1']],
  ['Transaction.nested_degrade_depth_leak.json', DEPTH,
    ['nested-degrade-leak-coll99-accept#0', 'nested-degrade-leak-coll100-reject#1']],
  ['Transaction.register_depth_bound.json', DEPTH, ['register-coll109-accept#0', 'register-coll110-reject#1']],
  ['Transaction.tree_body_depth_bound.json', DEPTH, ['tree-body-108-not-accept#0', 'tree-body-109-not-reject#1']],
  ['Transaction.segregated_constant_depth_bound.json', DEPTH, ['segregated-coll110-accept#0', 'segregated-coll111-reject#1']],
  ['Transaction.sigma_boolean_depth_bound.json', DEPTH, ['sigma-boolean-cand107-accept#0', 'sigma-boolean-cand108-reject#1']],
  ['Transaction.nested_box_depth_bound.json', DEPTH, ['nested-box-coll108-accept#0', 'nested-box-coll109-reject#1']],
  ['Transaction.sized_tree_declared_size.json', null,
    ['transaction-sized-tree-control#0', 'transaction-sized-tree-declared-over#1', 'transaction-sized-tree-declared-under#2']],
  ['Transaction.tree_read_window.json', {
    'transaction-tree-window-peek-past-end-reject#1': 'truncated',
    'transaction-tree-window-unsized-reject#2': 'soft-fork-without-size-bit',
    'transaction-tree-window-box-read-reject#3': 'position-limit-exceeded',
  }, ['transaction-tree-window-degrade-accept#0', 'transaction-tree-window-peek-past-end-reject#1',
      'transaction-tree-window-unsized-reject#2', 'transaction-tree-window-box-read-reject#3',
      'transaction-tree-window-within-accept#4']],
  ['Transaction.tree_root_type_check.json', { 'transaction-unsized-int-root-reject#1': 'soft-fork-without-size-bit' },
    ['transaction-unsized-sigmaprop-root-accept#0', 'transaction-unsized-int-root-reject#1',
     'transaction-sized-int-root-degrade-accept#2']],
];

describe.each(FILES)('SANTA %s (jvm-blessed)', (file, rejectCode, names) => {
  it('holds exactly the expected entries', () => {
    expect(loadEntries(file).map((e) => e.name)).toEqual(names);
  });
  for (const e of loadEntries(file)) {
    if (e.error === 'errored') {
      const code = codeFor(rejectCode, e.name);
      it(`${e.name}: parseTransaction rejects with '${code}'`, () => {
        let err: unknown;
        try { parseTransaction(hexToBytes(e.bytes_hex)); } catch (x) { err = x; }
        expect((err as { code?: unknown } | undefined)?.code).toBe(code);
      });
    } else {
      it(`${e.name}: round-trips${e.expected_bytes_hex ? ' to the JVM re-serialization' : ' byte-identically'}`, () => {
        const out = bytesToHex(serializeTransaction(parseTransaction(hexToBytes(e.bytes_hex))));
        expect(out).toBe(e.expected_bytes_hex ?? e.bytes_hex);
      });
    }
  }
});
