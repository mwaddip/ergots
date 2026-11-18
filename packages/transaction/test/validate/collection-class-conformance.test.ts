// SANTA vectors/transaction/v6/authored/patch-array-class.json (248 entries) and
// generic-producers.json (129 entries) — spends authored around the pair / specialised / generic
// collection split, blessed by ergo-core 6.0.6 validateStateful at the versions each entry pins.
// Vendored verbatim; the pattern mirrors kept-tree-bytes-conformance.test.ts.
//
// A red entry is listed in collection-class-red.json under one reason id; the reason ids and their
// sentences are the full-context registry's (`../conformance-eval/_full-context`).
//
// The red check is both-ways: a row absent from the table must match (the test fails if it does
// not), and a row listed in the table must NOT match (the test fails with "row is green; remove
// it from the red table" if it does).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateStateful } from '../../src/validate/stateful';
import { TxValidationError, TxParseError } from '../../src/errors';
import {
  EvalError,
  ExprParseError,
  SValueParseError,
  SValueSerializeError,
  STypeParseError,
  ErgoTreeParseError,
  SigmaBooleanParseError,
} from '@ergots/ergoscript';
import { ReaderError } from '@ergots/scorex';
import { loadSantaTxEntries, santaTxInputs, type SantaTxEntry } from './_santa-tx';
import { RED_REASONS } from '../conformance-eval/_full-context';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RED_TABLE_PATH = path.join(__dirname, '../fixtures/conformance/collection-class-red.json');

const FILES = ['patch-array-class.json', 'generic-producers.json'] as const;

type RedTable = Record<string, Record<string, string[]>>;

function loadRedTable(): RedTable {
  if (!fs.existsSync(RED_TABLE_PATH)) return {};
  return JSON.parse(fs.readFileSync(RED_TABLE_PATH, 'utf8')) as RedTable;
}

function redReason(file: string, name: string): string | null {
  const byReason = loadRedTable()[file];
  if (byReason === undefined) return null;
  for (const [reason, names] of Object.entries(byReason)) {
    if (names.includes(name)) return reason;
  }
  return null;
}

/**
 * The actual outcome of running `validateStateful` on one entry's transaction.
 * `error` is `null` on accept, `{ kind: 'tx', code }` for a TxValidationError or TxParseError,
 * `{ kind: 'eval', code }` for an EvalError raised during the per-input verify, `{ kind: 'wire',
 * name }` for a typed wire refusal thrown out of the transaction or a box parse, and
 * `{ kind: 'other', message }` for anything else (a panic-net defect).
 */
type Actual =
  | { ok: true }
  | { ok: false; kind: 'tx'; code: string }
  | { ok: false; kind: 'eval'; code: string }
  | { ok: false; kind: 'wire'; name: string }
  | { ok: false; kind: 'other'; message: string };

function isWireRefusal(err: unknown): boolean {
  return (
    err instanceof ExprParseError ||
    err instanceof STypeParseError ||
    err instanceof SValueParseError ||
    err instanceof SValueSerializeError ||
    err instanceof SigmaBooleanParseError ||
    err instanceof ErgoTreeParseError ||
    err instanceof ReaderError
  );
}

function run(e: SantaTxEntry): Actual {
  let tx, deps;
  try {
    const built = santaTxInputs(e);
    tx = built.tx;
    deps = built.deps;
  } catch (err) {
    if (err instanceof TxValidationError) return { ok: false, kind: 'tx', code: err.code };
    if (err instanceof TxParseError) return { ok: false, kind: 'tx', code: err.code };
    if (isWireRefusal(err)) return { ok: false, kind: 'wire', name: (err as Error).name };
    return { ok: false, kind: 'other', message: err instanceof Error ? err.message : String(err) };
  }
  try {
    validateStateful(tx, deps);
    return { ok: true };
  } catch (err) {
    if (err instanceof TxValidationError) return { ok: false, kind: 'tx', code: err.code };
    if (err instanceof TxParseError) return { ok: false, kind: 'tx', code: err.code };
    if (err instanceof EvalError) return { ok: false, kind: 'eval', code: err.code };
    if (isWireRefusal(err)) return { ok: false, kind: 'wire', name: (err as Error).name };
    return { ok: false, kind: 'other', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * `null` if ergots agrees with the entry's blessed verdict, a short string otherwise.
 * An accept-vs-accept match is unconditional green; a reject-vs-reject match treats any
 * TxValidationError as matching the JVM's `Scripts of all transaction inputs should pass
 * verification` — the same convention the sibling `kept-tree-bytes-conformance.test.ts` uses.
 */
function mismatch(e: SantaTxEntry): string | null {
  const actual = run(e);
  if (e.expected.valid) {
    if (actual.ok) return null;
    if (actual.kind === 'eval') return `expected accept, got EvalError '${actual.code}'`;
    if (actual.kind === 'tx') return `expected accept, got TxError '${actual.code}'`;
    if (actual.kind === 'wire') return `expected accept, got wire refusal '${actual.name}'`;
    return `expected accept, got panic: ${actual.message}`;
  }
  // Expected reject
  if (!actual.ok) return null;
  return 'expected reject, got accept';
}

describe('red-table shape + coverage', () => {
  const table = loadRedTable();
  it('every file key is one of the vendored files', () => {
    for (const key of Object.keys(table)) {
      expect(FILES, `unknown file key '${key}'`).toContain(key as (typeof FILES)[number]);
    }
  });
  it('every reason id is known', () => {
    const known = new Set(Object.keys(RED_REASONS));
    for (const byReason of Object.values(table)) {
      for (const reason of Object.keys(byReason)) {
        expect(known.has(reason), `unknown reason id '${reason}'`).toBe(true);
      }
    }
  });
  it('every listed entry exists in its file, and no entry is listed twice', () => {
    for (const file of FILES) {
      const byReason = table[file];
      if (byReason === undefined) continue;
      const names = new Set(loadSantaTxEntries(file).map((e) => e.name));
      const seen = new Set<string>();
      for (const [reason, listed] of Object.entries(byReason)) {
        for (const name of listed) {
          expect(names.has(name), `'${file}' '${reason}' names unknown entry '${name}'`).toBe(true);
          expect(seen.has(name), `'${file}' lists entry '${name}' twice`).toBe(false);
          seen.add(name);
        }
      }
    }
  });
});

for (const file of FILES) {
  const entries = loadSantaTxEntries(file);
  describe(`SANTA ${file} (${entries.length} entries, jvm-blessed)`, () => {
    for (const e of entries) {
      it(e.name, () => {
        const listed = redReason(file, e.name);
        const m = mismatch(e);
        if (listed === null) {
          expect(m, `entry ${e.name}: ${m ?? ''}`).toBeNull();
        } else {
          expect(
            m,
            `entry ${e.name}: row is green; remove it from the red table (listed under '${listed}')`,
          ).not.toBeNull();
        }
      });
    }
  });
}
