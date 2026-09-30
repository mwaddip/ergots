/**
 * Unit tests for `validate-block.ts` output round-trip pass (PLAN.md T9).
 * Since spec 2026-09-28 §12 the check is the JVM's box serialization: the box,
 * re-serialized with its tree re-encoded under the box rules, must equal the
 * chain's box bytes, which are the JVM's own serialization of it.
 *
 * Covers the four PLAN-required cases plus a few defensive checks:
 *
 *   1. Happy path: known-good output bytes across multiple txs → no throw.
 *   2. Empty bundle: zero txs / zero outputs → no throw, returns void.
 *   3. Tampered output: a box whose re-serialization differs from its bytes
 *      → throws `byte-roundtrip-mismatch` with `location.{txIndex, outputIndex}`.
 *   4. First-failure halt: tampered output AFTER a good one → reports the
 *      tampered location only (does not iterate past the first failure).
 *   5. Tree-version-fn errors: thrown / out-of-range value → distinct code.
 *   6. Box-parse failure: unparseable box bytes → `sbox-parse-failed`.
 *   7. Box rules: the mainnet burn box's tree degrades (rule 1001) and
 *      re-encodes to itself, and every output tree reaches the degrade census,
 *      through `validateBlock` too.
 *   8. The chain's box bytes: a register or an index the JVM writes back
 *      differently halts, and so do honest encodings the JVM rewrites (a
 *      Boolean-constant collection read as 0x83, a method call without
 *      arguments read as 0xdc), whose canonical twins pass.
 *
 * # Fixture sourcing
 *
 * The SBox bytes are hand-built and inlined as hex, so this test does not
 * reach into another package's test fixtures (the cross-package
 * import-by-test-file pattern is rejected by the project's
 * "no cross-package relative paths" rule from CLAUDE.md).
 *
 * The `treeVersionFn` stub returns 3, the ergo node's version, as `main.ts`'s
 * `topLevelTreeVersion` does. The version passed to `parseSValue(SBox)`
 * decides how the box's registers are read, types and data.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    validateBlock,
    validateOutputRoundtrips,
    V2_ACTIVATION_HEIGHT_MAINNET,
    type WalkerState,
} from '../src/validate-block.js';
import { DegradeCensus } from '../src/degrade-census.js';
import { HarnessError } from '../src/errors.js';
import type { BlockBundle, TxBundle } from '../src/bundle-types.js';

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
 * Known-good SBox bytes. Decoded:
 *   - value           = VLQ 1_000_000   (`c0 84 3d`)
 *   - ergoTreeBytes   = header 0x09 (v1 + hasSize), bodySize 2, body 0x08d3
 *                       (inline Const(SSigmaProp, sigmaProp(true)))
 *   - creationHeight  = 0       (`00`)
 *   - tokensCount     = 0       (`00`)
 *   - registersCount  = 0       (`00`)
 *   - txId            = 32 zero bytes
 *   - index           = VLQ 0   (`00`)
 *
 * An honest tree: its root types as SigmaProp, so it parses under the box
 * rules, and it declares its true size, so it re-encodes to itself. (The
 * `sbox_minimal` tree this fixture once used, `09 02 01 01`, has a Boolean
 * root, which rule 1001 now degrades.)
 */
const SBOX_MINIMAL_HEX =
    'c0843d090208d3000000000000000000000000000000000000000000000000000000000000000000000000';

const SBOX_MINIMAL_BYTES = hexToBytes(SBOX_MINIMAL_HEX);

/**
 * `treeVersionFn` stub used by every test. Returns 3, the version `main.ts`
 * passes (`topLevelTreeVersion`): the ergo node reads a block's boxes under
 * (3, 3) since 6.0, whatever a box's own tree version, and the version passed
 * to `parseSValue(SBox, ...)` decides how the box's registers are read.
 */
function nodeVersion3(_boxBytes: Uint8Array): number {
    return 3;
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
        headerJson: '',
        transactions,
        parameters: null,
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('validateOutputRoundtrips: happy path', () => {
    it('returns void on a single known-good output', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES])]);
        expect(() => validateOutputRoundtrips(bundle, nodeVersion3)).not.toThrow();
    });

    it('returns void on multiple txs each with multiple good outputs', () => {
        const bundle = makeBundle([
            makeTx([SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES]),
            makeTx([SBOX_MINIMAL_BYTES]),
            makeTx([SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES, SBOX_MINIMAL_BYTES]),
        ]);
        expect(() => validateOutputRoundtrips(bundle, nodeVersion3)).not.toThrow();
    });

    it('returns void on an empty bundle (no txs)', () => {
        const bundle = makeBundle([]);
        expect(() => validateOutputRoundtrips(bundle, nodeVersion3)).not.toThrow();
    });

    it('returns void on a bundle of txs each with zero outputs', () => {
        const bundle = makeBundle([makeTx([]), makeTx([])]);
        expect(() => validateOutputRoundtrips(bundle, nodeVersion3)).not.toThrow();
    });
});

describe('validateOutputRoundtrips: byte-roundtrip-mismatch', () => {
    /**
     * Construct a tampered SBox whose tree re-encodes to other bytes than it
     * arrived as. The trick: VLQ encodings can be "non-canonical" — `2` can
     * be encoded as `0x02` (canonical, 1 byte) or `0x82 0x00` (non-canonical,
     * 2 bytes). The size read accepts both forms, as the JVM's `getUInt`
     * does, but the re-encoding writes the canonical 1-byte form. So a tree
     * whose on-wire body-size is encoded non-canonically re-encodes to fewer
     * bytes — exactly the `byte-roundtrip-mismatch` path we need to exercise.
     *
     * The SBox bytes:
     *   Original (43 bytes):
     *     c0 84 3d         value VLQ = 1_000_000
     *     09 02 08 d3      ergoTree: header(v1+hasSize) + size(2) + body(08 d3)
     *     00 00 00         creationHeight=0, tokens=0, regs=0
     *     [32x 00]         txId = all zeros
     *     00               index VLQ = 0
     *
     *   Tampered (44 bytes):
     *     c0 84 3d         value VLQ = 1_000_000
     *     09 82 00 08 d3   ergoTree: header + NON-CANONICAL size(2 as 82 00) + body
     *     00 00 00         creationHeight=0, tokens=0, regs=0
     *     [32x 00]         txId
     *     00               index VLQ = 0
     *
     * SBox parser extracts ergoTreeBytes = `09 82 00 08 d3` (5 bytes). The
     * root types as SigmaProp, so the tree parses under the box rules, and
     * reencodeTreeBytes re-emits `09 02 08 d3` (4 bytes). 5 != 4 →
     * byte-roundtrip-mismatch. (With a non-SigmaProp body, such as
     * `01 01`, rule 1001 would degrade the tree and it would re-encode as
     * received.)
     */
    const TAMPERED_SBOX_HEX =
        // value VLQ 1M
        'c0843d' +
        // ergoTree: header 0x09 + non-canonical size VLQ for 2 (`82 00`) + body
        '09' + '8200' + '08d3' +
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
            validateOutputRoundtrips(bundle, nodeVersion3);
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
            validateOutputRoundtrips(bundle, nodeVersion3);
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
            validateOutputRoundtrips(bundle, nodeVersion3);
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
            validateOutputRoundtrips(bundle, nodeVersion3);
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
            validateOutputRoundtrips(bundle, nodeVersion3);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            const he = err as HarnessError;
            expect(he.code).toBe('sbox-parse-failed');
            expect(he.message).toMatch(/trailing bytes/);
        }
    });
});

// ─── Box rules and the degrade census (spec 2026-09-28 §12) ──────────────

/** The HarnessError `fn` throws, or a failure if it throws nothing or something else. */
function harnessErrorOf(fn: () => void): HarnessError {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(HarnessError);
        return e as HarnessError;
    }
    throw new Error('expected a HarnessError, got no throw');
}

/** A box around `treeHex`: value 1, creation height 0, no tokens or registers, zero txId, index 0. */
function boxAround(treeHex: string): Uint8Array {
    return hexToBytes(`01${treeHex}000000${'00'.repeat(32)}00`);
}

/**
 * The mainnet burn box's tree (h=545,684, tx 1, output 0): header 0xcd (v5, the size flag,
 * bits 6-7 set), declared size 7, a Byte-constant body `02 1a` and five trailing bytes. Rule 1001
 * degrades it to its declared span, the whole 9 bytes, which re-encode as received.
 */
const BURN_TREE_HEX = 'cd07021a8e6f59fd4a';
const BURN_BOX_BYTES = boxAround(BURN_TREE_HEX);

/**
 * Mainnet V2 header at height 420000 — known-valid PoW, so `validateBlock`'s header pass
 * succeeds. Source: `packages/scorex/test/fixtures/autolykos_v2.json` ("mainnet-h420000"), as
 * inlined by `validate-block.header.test.ts`.
 */
const MAINNET_H420000_BYTES = hexToBytes(
    '0269f4bb5aec68c7d4d501841f1ecea52dad4fed49e033e35da7003324bc81eec3' +
    '546a9808dd302f55b23b6948d0c71aea7d0cef0fdb24b5f7130490419fa937a9d' +
    '1911820795bae5b836fd244e5fed04d1ba47af9da505d2e539b332c05dc1607cb' +
    '12765b168406222b13117434128c8fd1b83cdbd84a9fd08261d03c267c7e27139' +
    '9adedf6f92ee640a5da07e72c2abbd9b94c71b3d55695e2f9bab9413ab3642cf0' +
    '3dfcfecd8406011765a0d1190000000002ebaaeb381c9d855af1807781fa20ef6' +
    'c0c34833275ce7913a9e4469f7bcb3bec02e634b8da8e9f60',
);

describe('validateOutputRoundtrips: box-rules re-encoding', () => {
    it('passes the burn box: rule 1001 degrades its tree, which re-encodes as received', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES]), makeTx([BURN_BOX_BYTES])]);
        expect(() => validateOutputRoundtrips(bundle, nodeVersion3)).not.toThrow();
    });

    it('fails a tree that declares 3 bytes for its 2-byte body: it re-encodes with size 2', () => {
        const bundle = makeBundle([makeTx([boxAround('090308d3')])]);
        const he = harnessErrorOf(() => validateOutputRoundtrips(bundle, nodeVersion3));
        expect(he.phase).toBe('output-roundtrip');
        expect(he.code).toBe('byte-roundtrip-mismatch');
        expect(he.location).toEqual({ txIndex: 0, outputIndex: 0 });
    });
});

// ─── The chain's box bytes (spec 2026-09-28 §12, final review I1) ────────

/** A box around `treeHex` with the given registers and index: value 1, creation height 0, no tokens, zero txId. */
function boxWith(treeHex: string, regsHex: string, indexHex: string): Uint8Array {
    return hexToBytes(`01${treeHex}0000${regsHex}${'00'.repeat(32)}${indexHex}`);
}

describe('validateOutputRoundtrips: the re-serialized box must equal the chain\'s box bytes', () => {
    // The chain's box bytes are the JVM's own serialization of the box: they hash to the box id,
    // which the indexer client checks. So they are a fixed point of the JVM's re-encoding, and
    // ergots, which re-serializes the box it parsed from them as the JVM does, must reproduce them.
    it('a register the JVM writes back differently halts: an identity GroupElement with a non-zero tail', () => {
        // R4: SGroupElement (07), a 0x00-lead point with a 0x11 tail. The JVM, and ergots, read any
        // 0x00-lead point as the identity and write it as 33 zeros (GroupElementSerializer.scala:20-42),
        // so no chain box carries this encoding. The tree alone re-encodes to itself.
        const box = boxWith('0008d3', `0107` + '00' + '11'.repeat(32), '00');
        const he = harnessErrorOf(() => validateOutputRoundtrips(makeBundle([makeTx([box])]), nodeVersion3));
        expect(he.phase).toBe('output-roundtrip');
        expect(he.code).toBe('byte-roundtrip-mismatch');
        expect(he.location).toEqual({ txIndex: 0, outputIndex: 0 });
    });

    it('an index the JVM cannot write halts: 0x8000, a negative Short', () => {
        // ErgoBox.scala:211, 218, 224: parsed as getUShort().toShort, written with putUShort.
        const box = boxWith('0008d3', '00', '808002');
        const he = harnessErrorOf(() => validateOutputRoundtrips(makeBundle([makeTx([box])]), nodeVersion3));
        expect(he.phase).toBe('output-roundtrip');
        expect(he.code).toBe('box-serialize-failed');
        expect(he.location).toEqual({ txIndex: 0, outputIndex: 0 });
    });

    for (const [name, wire, canonical] of [
        // The JVM writes a ConcreteCollection of Boolean constants as 0x85 (values.scala:871-875).
        ['a Boolean-constant collection read as 0x83', '00d19683020101010100', '00d196850201'],
        // The JVM writes a MethodCall without arguments as a PropertyCall, 0xdb (values.scala:1351).
        ['a MethodCall without arguments read as 0xdc', '00d191dc6301a7000500', '00d191db6301a70500'],
    ] as const) {
        it(`${name} halts: the JVM's box bytes carry the canonical form, which passes`, () => {
            const he = harnessErrorOf(() => validateOutputRoundtrips(makeBundle([makeTx([boxAround(wire)])]), nodeVersion3));
            expect(he.code).toBe('byte-roundtrip-mismatch');
            expect(() => validateOutputRoundtrips(makeBundle([makeTx([boxAround(canonical)])]), nodeVersion3)).not.toThrow();
        });
    }
});

describe('validateOutputRoundtrips: degrade census', () => {
    let dir: string;
    let censusPath: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ergots-census-'));
        censusPath = join(dir, 'census-expected.json');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('sends every output tree to the census: the burn box halts when unlisted', () => {
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES]), makeTx([BURN_BOX_BYTES])]);
        const he = harnessErrorOf(() => validateOutputRoundtrips(bundle, nodeVersion3, new DegradeCensus(censusPath)));
        expect(he.phase).toBe('census');
        expect(he.code).toBe('census-unexpected-degrade');
        expect(he.location).toEqual({ txIndex: 1, outputIndex: 0, ergoTreeHex: BURN_TREE_HEX });
    });

    it('passes the burn box when the census lists it', () => {
        writeFileSync(censusPath, JSON.stringify([
            { height: 100_000, txIndex: 1, outputIndex: 0, reason: 'burn box: rule 1001' },
        ]));
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES]), makeTx([BURN_BOX_BYTES])]);
        expect(() => validateOutputRoundtrips(bundle, nodeVersion3, new DegradeCensus(censusPath))).not.toThrow();
    });

    it('halts after the output pass when a census entry names an output the block lacks', () => {
        writeFileSync(censusPath, JSON.stringify([
            { height: 100_000, txIndex: 2, outputIndex: 0, reason: 'no such transaction in this block' },
        ]));
        const bundle = makeBundle([makeTx([SBOX_MINIMAL_BYTES]), makeTx([SBOX_MINIMAL_BYTES])]);
        const he = harnessErrorOf(() => validateOutputRoundtrips(bundle, nodeVersion3, new DegradeCensus(censusPath)));
        expect(he.phase).toBe('census');
        expect(he.code).toBe('census-expected-position-missing');
        expect(he.location).toEqual({ txIndex: 2, outputIndex: 0 });
    });

    it('validateBlock threads the census to the output pass', () => {
        const bundle: BlockBundle = {
            ...makeBundle([makeTx([BURN_BOX_BYTES])]),
            height: 420000,
            headerBytes: MAINNET_H420000_BYTES,
        };
        const state: WalkerState = {
            lastHeader: null,
            rollingHeaders: [],
            network: 'mainnet',
            v2ActivationHeight: V2_ACTIVATION_HEIGHT_MAINNET,
        };
        const noTxValidation = (): void => {};
        const he = harnessErrorOf(() =>
            validateBlock(bundle, state, nodeVersion3, noTxValidation, new DegradeCensus(censusPath)),
        );
        expect(he.code).toBe('census-unexpected-degrade');
    });
});
