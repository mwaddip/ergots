/**
 * Unit tests for `validate-block.ts` header pass (PLAN.md T8).
 *
 * Covers all five PLAN-required cases plus a few defensive checks:
 *
 *   1. Valid V2 block header → state.lastHeader + rollingHeaders update.
 *   2. Mutated header bytes (trailing-garbage variant) fail serialize-
 *      byte-equal → throws `byte-roundtrip-mismatch`.
 *   3. V1 header below activation → no throw, PoW NOT verified.
 *   4. V1 header at/above activation → throws `v1-header-after-v2-activation`.
 *   5. Wrong parent-id → throws `parent-link-mismatch`.
 *   6. Rolling window cap at 10 entries (defensive).
 *   7. Failed validation does NOT mutate state (defensive).
 *
 * # Fixture sourcing
 *
 * The V2 test fixture is the real mainnet header at height 420000, taken
 * from `packages/scorex/test/fixtures/autolykos_v2.json` (where it is
 * already proven to have a valid PoW). Inlined as hex here so this test
 * does not reach into another package's test fixtures.
 *
 * V1 test fixtures are constructed in-process by building a synthetic V1
 * `Header` object and serializing it — no V1 mainnet header is available
 * in the scorex fixture corpus, and the harness's V1 path does no PoW
 * verification anyway (the whole point: AutolykosV1NotSupportedError is
 * avoided structurally).
 */

import { describe, expect, it } from 'vitest';

import {
    ByteReader,
    parseHeader,
    serializeHeader,
    type Header,
    type AutolykosSolution,
} from '@ergots/scorex';

import {
    validateHeader,
    V2_ACTIVATION_HEIGHT_MAINNET,
    type WalkerState,
} from '../src/validate-block.js';
import { HarnessError } from '../src/errors.js';
import type { BlockBundle } from '../src/bundle-types.js';

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
 * Mainnet V2 header at height 420000 — known-valid PoW.
 * Source: `packages/scorex/test/fixtures/autolykos_v2.json` (label
 * "mainnet-h420000"). 220 bytes on the wire.
 */
const MAINNET_H420000_HEX =
    '0269f4bb5aec68c7d4d501841f1ecea52dad4fed49e033e35da7003324bc81eec3' +
    '546a9808dd302f55b23b6948d0c71aea7d0cef0fdb24b5f7130490419fa937a9d' +
    '1911820795bae5b836fd244e5fed04d1ba47af9da505d2e539b332c05dc1607cb' +
    '12765b168406222b13117434128c8fd1b83cdbd84a9fd08261d03c267c7e27139' +
    '9adedf6f92ee640a5da07e72c2abbd9b94c71b3d55695e2f9bab9413ab3642cf0' +
    '3dfcfecd8406011765a0d1190000000002ebaaeb381c9d855af1807781fa20ef6' +
    'c0c34833275ce7913a9e4469f7bcb3bec02e634b8da8e9f60';

const MAINNET_H420000_BYTES = hexToBytes(MAINNET_H420000_HEX);

/** Minimal `BlockBundle` factory — only the fields the header pass reads. */
function makeBundle(headerBytes: Uint8Array, height: number): BlockBundle {
    return {
        height,
        blockId: new Uint8Array(32),
        parentId: new Uint8Array(32),
        headerBytes,
        headerJson: '',
        transactions: [],
        parameters: null,
    };
}

/** Fresh WalkerState for mainnet with empty history. */
function freshMainnetState(): WalkerState {
    return {
        lastHeader: null,
        rollingHeaders: [],
        network: 'mainnet',
        v2ActivationHeight: V2_ACTIVATION_HEIGHT_MAINNET,
    };
}

/**
 * Build a synthetic V1 `Header` at the given height. All non-PoW fields
 * are zero-filled placeholders — the harness's V1 path does not verify
 * PoW, so the AutolykosSolution body just needs to be parseable.
 */
function makeSyntheticV1Header(height: number): Header {
    const solution: AutolykosSolution = {
        minerPk: new Uint8Array(33), // any 33 bytes; PoW not verified for V1
        powOnetimePk: new Uint8Array(33),
        nonce: new Uint8Array(8),
        powDistance: 0n,
    };
    // `id` will be re-derived via parseHeader; the field is required by the
    // Header type but is recomputed from serialized bytes on parse.
    const header: Header = {
        version: 1,
        id: new Uint8Array(32),
        parentId: new Uint8Array(32),
        adProofsRoot: new Uint8Array(32),
        stateRoot: new Uint8Array(33),
        transactionRoot: new Uint8Array(32),
        timestamp: 1_000_000,
        nBits: 0x07_0339_b8, // arbitrary valid-shaped compact bits
        height,
        extensionRoot: new Uint8Array(32),
        autolykosSolution: solution,
        votes: new Uint8Array(3),
        unparsedBytes: new Uint8Array(0), // V1 has no unparsedBytes section
    };
    return header;
}

/** Serialize a synthetic V1 header to its wire bytes. */
function makeSyntheticV1Bytes(height: number): Uint8Array {
    return serializeHeader(makeSyntheticV1Header(height));
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('validateHeader: happy path (V2 mainnet)', () => {
    it('updates state.lastHeader + rollingHeaders on a valid V2 header', () => {
        const state = freshMainnetState();
        const bundle = makeBundle(MAINNET_H420000_BYTES, 420000);

        validateHeader(bundle, state);

        expect(state.lastHeader).not.toBeNull();
        expect(state.lastHeader?.height).toBe(420000);
        expect(state.lastHeader?.version).toBe(2);
        expect(state.rollingHeaders).toHaveLength(1);
        expect(state.rollingHeaders[0]?.height).toBe(420000);
        // Most-recent-first invariant: index 0 IS the just-validated header.
        expect(state.rollingHeaders[0]).toBe(state.lastHeader);
    });

    it('caps rollingHeaders at 10 entries', () => {
        const state = freshMainnetState();
        // Walk the same valid header through 12 times, bypassing the parent-link
        // check by resetting lastHeader=null each iteration. We're only testing
        // the rolling-window cap here — not chain continuity.
        for (let i = 0; i < 12; i++) {
            state.lastHeader = null;
            const bundle = makeBundle(MAINNET_H420000_BYTES, 420000);
            validateHeader(bundle, state);
        }
        expect(state.rollingHeaders.length).toBe(10);
    });
});

describe('validateHeader: byte-roundtrip-mismatch', () => {
    it('throws when bundle.headerBytes has trailing garbage', () => {
        const state = freshMainnetState();
        // Append a single trailing byte. parseHeader stops at the end of the
        // header; serializeHeader produces only the canonical length. So the
        // round-trip output is shorter than the input → byte-roundtrip-mismatch.
        const corrupted = new Uint8Array(MAINNET_H420000_BYTES.length + 1);
        corrupted.set(MAINNET_H420000_BYTES, 0);
        corrupted[MAINNET_H420000_BYTES.length] = 0xff;
        const bundle = makeBundle(corrupted, 420000);

        expect(() => validateHeader(bundle, state)).toThrow(HarnessError);
        try {
            validateHeader(bundle, state);
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            expect((err as HarnessError).phase).toBe('header');
            expect((err as HarnessError).code).toBe('byte-roundtrip-mismatch');
        }
    });

    it('does not mutate state when validation fails', () => {
        const state = freshMainnetState();
        const corrupted = new Uint8Array(MAINNET_H420000_BYTES.length + 1);
        corrupted.set(MAINNET_H420000_BYTES, 0);
        const bundle = makeBundle(corrupted, 420000);

        expect(() => validateHeader(bundle, state)).toThrow(HarnessError);
        expect(state.lastHeader).toBeNull();
        expect(state.rollingHeaders).toHaveLength(0);
    });
});

describe('validateHeader: V1 below activation (skip PoW)', () => {
    it('accepts a V1 header at height < v2ActivationHeight without PoW verify', () => {
        const state = freshMainnetState();
        // height = 100 << 417792 → V1 path, no PoW verification (would otherwise
        // throw AutolykosV1NotSupportedError; the harness must NOT bubble that
        // up as a header-pass failure on legacy headers).
        const v1Bytes = makeSyntheticV1Bytes(100);
        const bundle = makeBundle(v1Bytes, 100);

        expect(() => validateHeader(bundle, state)).not.toThrow();
        expect(state.lastHeader?.version).toBe(1);
        expect(state.lastHeader?.height).toBe(100);
    });
});

describe('validateHeader: V1 above activation (forged-prefix rejection)', () => {
    it('throws v1-header-after-v2-activation at the boundary height', () => {
        const state = freshMainnetState();
        // height == v2ActivationHeight: must reject (>= comparison).
        const v1Bytes = makeSyntheticV1Bytes(V2_ACTIVATION_HEIGHT_MAINNET);
        const bundle = makeBundle(v1Bytes, V2_ACTIVATION_HEIGHT_MAINNET);

        try {
            validateHeader(bundle, state);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            expect((err as HarnessError).phase).toBe('header');
            expect((err as HarnessError).code).toBe('v1-header-after-v2-activation');
        }
    });

    it('throws v1-header-after-v2-activation well past activation', () => {
        const state = freshMainnetState();
        const v1Bytes = makeSyntheticV1Bytes(2_000_000);
        const bundle = makeBundle(v1Bytes, 2_000_000);

        try {
            validateHeader(bundle, state);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            expect((err as HarnessError).code).toBe('v1-header-after-v2-activation');
        }
    });
});

describe('validateHeader: parent-link', () => {
    it('throws parent-link-mismatch when header.parentId !== state.lastHeader.id', () => {
        const state = freshMainnetState();
        // Seed state.lastHeader with a synthetic header whose id will NOT
        // match the V2 fixture's parentId. We re-parse the V2 fixture first
        // to get a "previous" header object, then mutate its id to something
        // that cannot match the next header's parentId.
        const prevHeader = parseHeader(new ByteReader(MAINNET_H420000_BYTES));
        const tamperedPrev: Header = {
            ...prevHeader,
            id: new Uint8Array(32).fill(0xaa), // guaranteed mismatch
        };
        state.lastHeader = tamperedPrev;

        const bundle = makeBundle(MAINNET_H420000_BYTES, 420001);
        try {
            validateHeader(bundle, state);
            throw new Error('expected throw');
        } catch (err) {
            expect(err).toBeInstanceOf(HarnessError);
            expect((err as HarnessError).phase).toBe('header');
            expect((err as HarnessError).code).toBe('parent-link-mismatch');
        }
    });

    it('skips parent-link check at the first block (state.lastHeader === null)', () => {
        const state = freshMainnetState();
        // state.lastHeader === null on entry; parent-link MUST be skipped.
        const bundle = makeBundle(MAINNET_H420000_BYTES, 420000);
        expect(() => validateHeader(bundle, state)).not.toThrow();
    });
});
