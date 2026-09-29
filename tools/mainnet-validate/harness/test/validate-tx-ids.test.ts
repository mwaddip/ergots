/**
 * Unit tests for `validate-tx-ids.ts`, the ids-and-parse-only validator (`--mode ids`,
 * spec 2026-09-28 §12): ergots' transaction id and re-encoded output boxes against the chain's.
 *
 * # Fixture
 *
 * SANTA `Transaction.sized_tree_declared_size` (santa `2b1acee`, blessed by
 * `jvm:sigma-state-6.0.6`), inlined as hex so this test does not reach into another package's
 * test fixtures. The three entries differ only in the declared size of the one output's tree
 * `09 0N 08 d3` (sigmaProp(true)): #0 declares the body's size 2, #1 declares 3 and #2 declares 1.
 * The JVM accepts all three and re-serializes #1 and #2 to #0's bytes, so all three have #0's
 * transaction id, and the output box the chain holds is #0's candidate with that id.
 */

import { describe, expect, it } from 'vitest';
import { ByteWriter } from '@ergots/scorex';
import { serializeSValue } from '@ergots/ergoscript';
import { parseTransaction, transactionId } from '@ergots/transaction';

import { validateTxIds } from '../src/validate-tx-ids.js';
import { HarnessError } from '../src/errors.js';
import type { BlockBundle, TxBundle } from '../src/bundle-types.js';
import type { WalkerState } from '../src/validate-block.js';

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

function bytesToHex(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += b.toString(16).padStart(2, '0');
    return s;
}

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

const TX_PREFIX =
    '010f9267b537544e9f57a5b1d67dc0da2c6dfd706f28359b7c9021988a7e5b20c000000000018094ebdc03';
/** `transaction-sized-tree-control#0`: the tree declares its body's size, 2. */
const CONTROL_HEX = `${TX_PREFIX}090208d3010000`;
/** `transaction-sized-tree-declared-over#1`: the tree declares 3 for a 2-byte body. */
const OVER_HEX = `${TX_PREFIX}090308d3010000`;
/** `transaction-sized-tree-declared-under#2`: the tree declares 1 for a 2-byte body. */
const UNDER_HEX = `${TX_PREFIX}090108d3010000`;

const CONTROL = parseTransaction(hexToBytes(CONTROL_HEX));
/** The chain's transaction id: the control's, which the JVM gives all three entries. */
const TX_ID = transactionId(CONTROL);

/** The chain's output box: the control's candidate with the transaction id and index 0. */
function canonicalOutput(): Uint8Array {
    const w = new ByteWriter();
    serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: { ...CONTROL.outputCandidates[0]!, txId: TX_ID, index: 0 } }, 0, w);
    return w.toBytes();
}

function bundleFor(txHex: string, overrides: Partial<TxBundle> = {}): TxBundle {
    return {
        txId: TX_ID,
        signingMessage: new Uint8Array(0),
        inputs: [],
        outputs: [canonicalOutput()],
        dataInputBoxes: [],
        txBytes: hexToBytes(txHex),
        ...overrides,
    };
}

const BLOCK: BlockBundle = {
    height: 1,
    blockId: new Uint8Array(32),
    parentId: new Uint8Array(32),
    headerBytes: new Uint8Array(0),
    headerJson: '',
    transactions: [],
    parameters: null,
};

const STATE: WalkerState = {
    lastHeader: null,
    rollingHeaders: [],
    network: 'mainnet',
    v2ActivationHeight: 417792,
};

describe('validateTxIds', () => {
    it('keeps the declared size as received on the output tree it parses', () => {
        // What makes the next test meaningful: the "over" transaction's output carries
        // 09 03 08 d3, so passing requires writing the tree re-encoded, 09 02 08 d3.
        const over = parseTransaction(hexToBytes(OVER_HEX));
        expect(bytesToHex(over.outputCandidates[0]!.ergoTreeBytes)).toBe('090308d3');
        expect(bytesToHex(canonicalOutput())).toContain('8094ebdc03090208d3010000');
    });

    it.each([
        ['control #0', CONTROL_HEX],
        ['declared over #1', OVER_HEX],
        ['declared under #2', UNDER_HEX],
    ])('passes SANTA Transaction.sized_tree_declared_size %s against the chain id and box', (_name, hex) => {
        expect(() => validateTxIds(bundleFor(hex), BLOCK, STATE, 0)).not.toThrow();
    });

    it('throws tx-id-mismatch when the chain id differs', () => {
        const txId = TX_ID.slice();
        txId[0] = txId[0]! ^ 0x01;
        const he = harnessErrorOf(() => validateTxIds(bundleFor(OVER_HEX, { txId }), BLOCK, STATE, 3));
        expect(he.phase).toBe('ids');
        expect(he.code).toBe('tx-id-mismatch');
        expect(he.location).toEqual({ txIndex: 3, txId: bytesToHex(txId) });
    });

    it('throws output-bytes-mismatch when an output box differs', () => {
        const out = canonicalOutput();
        out[1] = out[1]! ^ 0x01; // inside the value VLQ
        const he = harnessErrorOf(() => validateTxIds(bundleFor(OVER_HEX, { outputs: [out] }), BLOCK, STATE, 2));
        expect(he.phase).toBe('ids');
        expect(he.code).toBe('output-bytes-mismatch');
        expect(he.location).toEqual({ txIndex: 2, txId: bytesToHex(TX_ID), outputIndex: 0 });
    });

    it('throws output-count-mismatch when the chain holds a different number of outputs', () => {
        for (const outputs of [[], [canonicalOutput(), canonicalOutput()]]) {
            const he = harnessErrorOf(() => validateTxIds(bundleFor(OVER_HEX, { outputs }), BLOCK, STATE, 0));
            expect(he.code).toBe('output-count-mismatch');
        }
    });

    it('throws ids-tx-bytes-missing when the assembler attached no tx bytes', () => {
        const he = harnessErrorOf(() => validateTxIds(bundleFor(OVER_HEX, { txBytes: undefined }), BLOCK, STATE, 5));
        expect(he.phase).toBe('ids');
        expect(he.code).toBe('ids-tx-bytes-missing');
        expect(he.location).toEqual({ txIndex: 5 });
    });

    it('throws ids-parse-failed when ergots rejects the tx bytes', () => {
        const truncated = hexToBytes(OVER_HEX).slice(0, 40);
        const he = harnessErrorOf(() => validateTxIds(bundleFor(OVER_HEX, { txBytes: truncated }), BLOCK, STATE, 0));
        expect(he.phase).toBe('ids');
        expect(he.code).toBe('ids-parse-failed');
    });
});
