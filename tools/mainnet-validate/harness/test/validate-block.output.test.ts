/**
 * Unit tests for `validate-block.ts` output round-trip pass (PLAN.md T9).
 *
 * Covers the four PLAN-required cases plus a few defensive checks:
 *
 *   1. Happy path: known-good output bytes across multiple txs → no throw.
 *   2. Empty bundle: zero txs / zero outputs → no throw, returns void.
 *   3. Tampered output: one byte flipped inside the ErgoTree body section
 *      → throws `byte-roundtrip-mismatch` with `location.{txIndex, outputIndex}`.
 *   4. First-failure halt: tampered output AFTER a good one → reports the
 *      tampered location only (does not iterate past the first failure).
 *   5. Tree-version-fn errors: thrown / out-of-range value → distinct code.
 *   6. Box-parse failure: unparseable box bytes → `sbox-parse-failed`.
 *
 * # Fixture sourcing
 *
 * Known-good SBox bytes are reused from `packages/ergoscript/test/fixtures/
 * wire/sbox-roundtrip.json` (the `sbox_minimal` entry). Inlined as hex here
 * so this test does not reach into another package's test fixtures (the
 * cross-package import-by-test-file pattern is rejected by the project's
 * "no cross-package relative paths" rule from CLAUDE.md).
 *
 * For the "tree-version-derivation" inline closure: the SBox wire layout is
 * `<value VLQ> <ergoTree header byte> <...>`. After consuming the VLQ value
 * prefix, the next byte's low 3 bits give the tree version. The test uses
 * an even simpler stub that always returns 0 — the fixtures' ergoTrees are
 * version 1, and parseSValue(SBox) ignores treeVersion until it encounters
 * SHeader register values (none here), so 0 is safe for the fixtures.
 */

import { describe, expect, it } from 'vitest';

import {
    validateOutputRoundtrips,
} from '../src/validate-block.js';
import { HarnessError } from '../src/errors.js';
import type { BlockBundle, TxBundle } from '../src/protocol.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function hexToBytes(hex: string): Uint8Array {
    if (hex.length % 2 !== 0) {
        throw new Error(`hexToBytes: odd-length input (${hex.length})`);
    }
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
}

/**
 * Known-good SBox bytes — taken from `packages/ergoscript/test/fixtures/
 * wire/sbox-roundtrip.json` entry `sbox_minimal`. Decoded:
 *   - value           = VLQ 1_000_000   (`c0 84 3d`)
 *   - ergoTreeBytes   = header 0x09 (v1 + hasSize), bodySize 2, body 0x0101
 *                       (inline Const(SBoolean, true))
 *   - creationHeight  = 0       (`00`)
 *   - tokensCount     = 0       (`00`)
 *   - registersCount  = 0       (`00`)
 *   - txId            = 32 zero bytes
 *   - index           = VLQ 0   (`00`)
 *
 * Parses cleanly through `parseSValue(SBox, 0, reader)` and the inner
 * ergoTreeBytes (`09020101`) round-trip cleanly through `parseTree` +
 * `serializeTree` — verified by the existing ergoscript SBox round-trip
 * test suite.
 */
const SBOX_MINIMAL_HEX =
    'c0843d09020101000000000000000000000000000000000000000000000000000000000000000000000000';

const SBOX_MINIMAL_BYTES = hexToBytes(SBOX_MINIMAL_HEX);

/**
 * `treeVersionFn` stub used by every test. Returns 0 (the literal version
 * of the `sbox_minimal` ergoTree is 1, but `parseSValue(SBox, ...)`'s
 * `treeVersion` parameter only matters for SHeader register values which
 * the fixture does not contain — 0 is observationally indistinguishable
 * from 1 for this fixture). Mirroring the PLAN's split-out function design
 * so T11's main.ts can swap in a real derivation later without changing
 * the validate-block.ts signature.
 */
function alwaysVersion0(_boxBytes: Uint8Array): number {
    return 0;
}

/** Build a `TxBundle` with the provided outputs. Other fields are zeroed. */
function makeTx(outputs: Uint8Array[]): TxBundle {
    return {
        txId: new Uint8Array(32),
        signingMessage: new Uint8Array(0),
        inputs: [],
        outputs,
        dataInputBoxes: [],
    };
}

/** Build a `BlockBundle` with the provided transactions. Other fields are zeroed. */
function makeBundle(transactions: TxBundle[]): BlockBundle {
    return {
        height: 100_000,
        blockId: new Uint8Array(32),
        parentId: new Uint8Array(32),
        headerBytes: new Uint8Array(0),
        transactions,
        parameters: null,
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('validateOutputRoundtrips: happy path', () => {
    it('returns void on a single known-good output', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES])]);
        expect(() => validateOutputRoundtrips(bundle, alwaysVersion0)).not.toThrow();
    });

    it('returns void on multiple txs each with multiple good outputs', () => {
        const bundle = makeBundle([
            makeTx([SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES]),
            makeTx([SBOX_MINIMAL_BYTES]),
            makeTx([SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES]),
        ]);
        expect(() => validateOutputRoundtrips(bundle, alwaysVersion0)).not.toThrow();
    });

    it('returns void on an empty bundle (no txs)', () => {
        const bundle = makeBundle([]);
        expect(() => validateOutputRoundtrips(bundle, alwaysVersion0)).not.toThrow();
    });

    it('returns void on a bundle of txs each with zero outputs', () => {
        const bundle = makeBundle([makeTx([]), makeTx([])]);
        expect(() => validateOutputRoundtrips(bundle, alwaysVersion0)).not.toThrow();
    });
});

describe('validateOutputRoundtrips: byte-roundtrip-mismatch', () => {
    /**
     * Construct a tampered SBox whose ergoTreeBytes parse-then-serialize
     * round-trip is NOT byte-identical. The trick: VLQ encodings can be
     * "non-canonical" — `2` can be encoded as `0x02` (canonical, 1 byte) or
     * `0x82 0x00` (non-canonical, 2 bytes). `readVlqBigInt` in
     * `@ergots/scorex` accepts both forms; `parseTree` happily consumes the
     * 2-byte form for the ErgoTree body-size VLQ, but `serializeTree` emits
     * the canonical 1-byte form. So a tree whose on-wire body-size is
     * encoded non-canonically will round-trip to fewer bytes — exactly the
     * `byte-roundtrip-mismatch` path we need to exercise.
     *
     * The SBox bytes:
     *   Original (43 bytes):
     *     c0 84 3d         value VLQ = 1_000_000
     *     09 02 01 01      ergoTree: header(v1+hasSize) + size(2) + body(01 01)
     *     00 00 00         creationHeight=0, tokens=0, regs=0
     *     [32x 00]         txId = all zeros
     *     00               index VLQ = 0
     *
     *   Tampered (44 bytes):
     *     c0 84 3d         value VLQ = 1_000_000
     *     09 82 00 01 01   ergoTree: header + NON-CANONICAL size(2 as 82 00) + body
     *     00 00 00         creationHeight=0, tokens=0, regs=0
     *     [32x 00]         txId
     *     00               index VLQ = 0
     *
     * SBox parser extracts ergoTreeBytes = `09 82 00 01 01` (5 bytes).
     * parseTree accepts it (non-canonical VLQ tolerated). serializeTree
     * re-emits `09 02 01 01` (4 bytes). 5 != 4 → byte-roundtrip-mismatch.
     */
    const TAMPERED_SBOX_HEX =
        // value VLQ 1M
        'c0843d' +
        // ergoTree: header 0x09 + non-canonical size VLQ for 2 (`82 00`) + body
        '09' + '8200' + '0101' +
        // creationHeight=0, tokensCount=0, regsCount=0
        '000000' +
        // txId (32 zero bytes)
        '0000000000000000000000000000000000000000000000000000000000000000' +
        // index VLQ 0
        '00';

    const TAMPERED_SBOX_BYTES = hexToBytes(TAMPERED_SBOX_HEX);

    it('throws byte-roundtrip-mismatch on an output with non-canonical VLQ tree-size', () => {
        const bundle = makeBundle([makeTx([TAMPERED_SBOX_BYTES])]);

        try {
            validateOutputRoundtrips(bundle, alwaysVersion0);
            throw new Error('expected validateOutputRoundtrips to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.phase).toBe('output-roundtrip');
            expect(he.code).toBe('byte-roundtrip-mismatch');
            expect(he.location?.txIndex).toBe(0);
            expect(he.location?.outputIndex).toBe(0);
        }
    });

    it('reports the right tx/output index when the tampered output is not first', () => {
        // Tx 1, output 2 carries the tampered box. Everything else is good.
        const bundle = makeBundle([
            makeTx([SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES]),
            makeTx([
                SBOX_MINIMAL_BYTES,
                SBOX_MINIMAL_BYTES,
                TAMPERED_SBOX_BYTES,
                SBOX_MINIMAL_BYTES,
            ]),
        ]);

        try {
            validateOutputRoundtrips(bundle, alwaysVersion0);
            throw new Error('expected validateOutputRoundtrips to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.code).toBe('byte-roundtrip-mismatch');
            expect(he.location?.txIndex).toBe(1);
            expect(he.location?.outputIndex).toBe(2);
        }
    });

    it('halts on the FIRST failure (does not collect multiple mismatches)', () => {
        // Two tampered outputs in different positions. The harness should
        // report the FIRST one (tx 0, output 1) and not iterate to tx 1.
        const bundle = makeBundle([
            makeTx([SBOX_MINIMAL_BYTES, TAMPERED_SBOX_BYTES]),
            makeTx([TAMPERED_SBOX_BYTES]),
        ]);

        try {
            validateOutputRoundtrips(bundle, alwaysVersion0);
            throw new Error('expected validateOutputRoundtrips to throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.location?.txIndex).toBe(0);
            expect(he.location?.outputIndex).toBe(1);
        }
    });
});

describe('validateOutputRoundtrips: tree-version derivation errors', () => {
    it('wraps a thrown treeVersionFn as tree-version-derivation-failed', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES])]);
        const throwingFn = (_b: Uint8Array): number => {
            throw new Error('synthetic derivation failure');
        };

        try {
            validateOutputRoundtrips(bundle, throwingFn);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.code).toBe('tree-version-derivation-failed');
            expect(he.location?.txIndex).toBe(0);
            expect(he.location?.outputIndex).toBe(0);
            expect(he.message).toContain('synthetic derivation failure');
        }
    });

    it('rejects out-of-range tree versions (e.g. 8)', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES])]);
        const outOfRangeFn = (_b: Uint8Array): number => 8;

        try {
            validateOutputRoundtrips(bundle, outOfRangeFn);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.code).toBe('tree-version-derivation-failed');
        }
    });

    it('rejects negative tree versions', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES])]);
        const negativeFn = (_b: Uint8Array): number => -1;

        try {
            validateOutputRoundtrips(bundle, negativeFn);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            expect((err as HarnessError).code).toBe('tree-version-derivation-failed');
        }
    });
});

describe('validateOutputRoundtrips: sbox-parse-failed', () => {
    it('reports sbox-parse-failed when output bytes are truncated', () => {
        // Truncate the SBox to fewer than 32 bytes — parseSValue will throw
        // while reading the txId. Distinct code from byte-roundtrip-mismatch
        // so the operator can tell apart "shim emitted garbage" from
        // "library round-trip drift".
        const truncated = SBOX_MINIMAL_BYTES.slice(0, 10);
        const bundle = makeBundle([makeTx([truncated])]);

        try {
            validateOutputRoundtrips(bundle, alwaysVersion0);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.phase).toBe('output-roundtrip');
            expect(he.code).toBe('sbox-parse-failed');
            expect(he.location?.txIndex).toBe(0);
            expect(he.location?.outputIndex).toBe(0);
        }
    });

    it('reports sbox-parse-failed on trailing bytes after a structurally-valid SBox', () => {
        // Append a stray byte. parseSValue happily parses the SBox cleanly,
        // but our explicit `isExhausted` check catches the trailing byte —
        // the shim contract is exactly-one-box-per-output-bytes.
        const padded = new Uint8Array(SBOX_MINIMAL_BYTES.length + 1);
        padded.set(SBOX_MINIMAL_BYTES, 0);
        padded[SBOX_MINIMAL_BYTES.length] = 0xff;
        const bundle = makeBundle([makeTx([padded])]);

        try {
            validateOutputRoundtrips(bundle, alwaysVersion0);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.code).toBe('sbox-parse-failed');
            expect(he.message).toMatch(/trailing bytes/);
        }
    });
});
