/**
 * Integration test for the phase 2j-a cost-equivalence halt path
 * (Layer 4, T8).
 *
 * Verifies the producer→writer pipeline end-to-end:
 *
 *     validateTx throws HarnessError
 *  →  classifyError flattens 2j-a payload into ErrorReport
 *  →  writeErrorReport serializes to disk
 *  →  on-disk JSON matches the schema in
 *     `docs/specs/2026-05-22-ergoscript-2j-a-cost-oracle-design.md` §146-177
 *
 * # Why direct invocation, not subprocess + mock-shim
 *
 * PLAN.md T8 sketched a `runHarness({ shim: mockShim, ... })` pattern, but
 * the existing harness `main(argv)` constructs its own `ShimClient` inline
 * (`main.ts:381`) with no injection seam. A full mock-shim subprocess
 * would require either: refactoring `main.ts` to accept an injected shim
 * factory (bigger than T8's scope), or implementing the CBOR wire protocol
 * in a fake-shim JS script (substantial new code).
 *
 * The direct-invocation approach instead drives the validation primitives
 * straight from synthetic in-process BlockBundles, then runs the same
 * `classifyError → writeErrorReport` pipeline that `main.ts:461-464`
 * invokes. That's the integration surface T8's done criterion actually
 * cares about ("halts with structured `error-report.json`"). The
 * subprocess + checkpoint advance + tip-reach paths are covered by the
 * existing `halt-path.test.ts` and the T9 Layer-5 smoke.
 *
 * # What this test does NOT cover
 *
 * The actual `main.ts:458-468` routing (`try { validateBlock(...) } catch
 * { classifyError + writeErrorReport }`) is exercised here only by manual
 * invocation. End-to-end "harness halt → on-disk JSON" through subprocess
 * + ShimClient is verified by the T9 Layer-5 smoke against real mainnet
 * data; if main.ts is wired wrong for the 2j-a phases, T9 catches it.
 *
 * # Helpers
 *
 * Inlined from `test/validate-tx.test.ts` (P2PK ergo-tree + SBox + state
 * builders) so this file stays self-contained. Cross-test-file imports
 * are awkward; the duplication is minimal.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateTx } from '../../src/validate-tx.js';
import { classifyError } from '../../src/main.js';
import { writeErrorReport, type ErrorReport } from '../../src/error-report.js';
import { HarnessError } from '../../src/errors.js';
import {
    V2_ACTIVATION_HEIGHT_MAINNET,
    type WalkerState,
} from '../../src/validate-block.js';
import type {
    BlockBundle,
    TxBundle,
    InputBundle,
    ContextExtensionEntry,
} from '../../src/protocol.js';
import type { Header } from '@ergots/scorex';

// ─── Fixture: prove-dlog-0 from packages/ergoscript verifier-positive ──

function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    }
    return out;
}

const PK_HEX = '03e803e81dd75bcf33c7975d8827910d85a6fbc72932fb87a52b154f0ff1b54461';
const SIGNATURE_HEX =
    '6e76772204b960a58dd4344339d429915ddbe1a7cff9b79f19ac51f5f4c1cb4becaa77007a9cef879c1cea3d822d37ec8cbe0acbcea88572';

const PK_BYTES = hexToBytes(PK_HEX);
const SIGNATURE_BYTES = hexToBytes(SIGNATURE_HEX);

// ─── Helpers ─────────────────────────────────────────────────────────────

function p2pkErgoTreeBytes(pk: Uint8Array): Uint8Array {
    const out = new Uint8Array(2 + 2 + 33);
    out[0] = 0x08; // v0 + hasSize
    out[1] = 0x23; // bodySize VLQ = 35
    out[2] = 0x08; // SType SSigmaProp (inline Const)
    out[3] = 0xcd; // ProveDlog opcode
    out.set(pk, 4);
    return out;
}

function sboxBytes(ergoTree: Uint8Array): Uint8Array {
    const prefix = new Uint8Array([0x01]); // value VLQ = 1
    const suffix = new Uint8Array(1 + 1 + 1 + 32 + 1); // ch + tc + rc + txid + idx
    const out = new Uint8Array(prefix.length + ergoTree.length + suffix.length);
    out.set(prefix, 0);
    out.set(ergoTree, prefix.length);
    out.set(suffix, prefix.length + ergoTree.length);
    return out;
}

function fakeHeader(height: number): Header {
    return {
        version: 2,
        id: new Uint8Array(32),
        parentId: new Uint8Array(32),
        adProofsRoot: new Uint8Array(32),
        stateRoot: new Uint8Array(33),
        transactionRoot: new Uint8Array(32),
        timestamp: 1_700_000_000_000 + height,
        nBits: 0,
        height,
        extensionRoot: new Uint8Array(32),
        autolykosSolution: {
            minerPk: new Uint8Array(33),
            powOnetimePk: null,
            nonce: new Uint8Array(8),
            powDistance: null,
        },
        votes: new Uint8Array(3),
        unparsedBytes: new Uint8Array(0),
    };
}

function makeState(rolling: Header[]): WalkerState {
    return {
        lastHeader: rolling[0] ?? null,
        rollingHeaders: rolling,
        network: 'mainnet',
        v2ActivationHeight: V2_ACTIVATION_HEIGHT_MAINNET,
    };
}

function makeInput(opts: {
    spentBoxBytes: Uint8Array;
    signatureBytes: Uint8Array;
    contextExtension?: ContextExtensionEntry[];
    oracleCost: bigint;
    oracleSucceeded: boolean;
    oracleError: string | null;
}): InputBundle {
    return {
        boxId: new Uint8Array(32),
        spentBoxBytes: opts.spentBoxBytes,
        signatureBytes: opts.signatureBytes,
        contextExtension: opts.contextExtension ?? [],
        oracleCost: opts.oracleCost,
        oracleSucceeded: opts.oracleSucceeded,
        oracleError: opts.oracleError,
    };
}

function makeTx(inputs: InputBundle[]): TxBundle {
    return {
        txId: new Uint8Array(32),
        signingMessage: new Uint8Array(0),
        inputs,
        outputs: [],
        dataInputBoxes: [],
    };
}

function makeBundle(tx: TxBundle, height = 100, maxBlockCost = 1_000_000): BlockBundle {
    return {
        height,
        blockId: new Uint8Array(32),
        parentId: new Uint8Array(32),
        // Non-empty so `bundleExcerpt.headerHex` lands a recognisable value.
        headerBytes: new Uint8Array([0xab, 0xcd, 0xef, 0x12, 0x34]),
        headerJson: '',
        transactions: [tx],
        parameters: { maxBlockCost },
    };
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('cost-equivalence halt path (Layer 4 — phase 2j-a, direct invocation)', () => {
    let scratchDir: string | null = null;
    afterEach(() => {
        if (scratchDir !== null) {
            rmSync(scratchDir, { recursive: true, force: true });
            scratchDir = null;
        }
    });

    /**
     * Drive a synthetic single-input tx through `validateTx`, then funnel
     * the thrown HarnessError through `classifyError → writeErrorReport`
     * exactly as `main.ts:461-464` does. Returns the parsed on-disk JSON.
     */
    function captureErrorReportFor(input: InputBundle, maxBlockCost = 1_000_000): ErrorReport {
        scratchDir = mkdtempSync(join(tmpdir(), 'ergots-t8-'));
        const errorReportPath = join(scratchDir, 'error-report.json');
        const tx = makeTx([input]);
        const block = makeBundle(tx, 100, maxBlockCost);
        const state = makeState([fakeHeader(100), fakeHeader(99)]);

        let captured: unknown = null;
        try {
            validateTx(tx, block, state, 0);
        } catch (e) {
            captured = e;
        }
        // T8 contract: cost-equivalence violations MUST surface as
        // HarnessError. Bare throw would mean the producer side is broken.
        expect(captured).toBeInstanceOf(HarnessError);
        const report = classifyError(captured, block.height, block);
        writeErrorReport(errorReportPath, report);
        expect(existsSync(errorReportPath)).toBe(true);
        return JSON.parse(readFileSync(errorReportPath, 'utf8')) as ErrorReport;
    }

    it('halts with structured error-report.json on cost-drift', () => {
        const input = makeInput({
            spentBoxBytes: sboxBytes(p2pkErgoTreeBytes(PK_BYTES)),
            signatureBytes: SIGNATURE_BYTES,
            oracleCost: 999n, // mismatch vs P2PK actual cost 50
            oracleSucceeded: true,
            oracleError: null,
        });

        const report = captureErrorReportFor(input);

        // Phase + code per spec §146-177.
        expect(report.phase).toBe('evaluate-cost');
        expect(report.errorCode).toBe('cost-drift');
        expect(report.errorClass).toBe('HarnessError');

        // Structured payload survived classifyError + writeErrorReport.
        expect(report.evaluateCost).toEqual({
            expected: 999,
            actual: 50,
            delta: 949,
        });

        // Location identifies the per-input site. `txId` was added in
        // T8-review-fix so operators triaging halts see the tx hex
        // directly (spec §location, error-report.ts:101).
        expect(report.location.txIndex).toBe(0);
        expect(report.location.txId).toMatch(/^[0-9a-f]+$/);
        expect(report.location.inputIndex).toBe(0);
        expect(report.location.spentBoxId).toMatch(/^[0-9a-f]+$/);
        expect(report.location.ergoTreeHex).toMatch(/^[0-9a-f]+$/);

        // Bundle excerpt carries the header bytes hex.
        expect(report.bundleExcerpt.headerHex).toBe('abcdef1234');

        // Cost-mismatch-specific fields are NOT set for cost-drift.
        expect(report.oracleError).toBeUndefined();
        expect(report.ourError).toBeUndefined();
        expect(report.ourEvaluateCost).toBeUndefined();
    });

    it('halts with structured error-report.json on oracle-mismatch (ours-succeeded-oracle-errored)', () => {
        const input = makeInput({
            spentBoxBytes: sboxBytes(p2pkErgoTreeBytes(PK_BYTES)),
            signatureBytes: SIGNATURE_BYTES,
            oracleCost: 0n,
            oracleSucceeded: false,
            oracleError: 'simulated oracle eval error',
        });

        const report = captureErrorReportFor(input);

        expect(report.phase).toBe('evaluate-oracle-mismatch');
        expect(report.errorCode).toBe('ours-succeeded-oracle-errored');
        expect(report.errorClass).toBe('HarnessError');

        // Flat oracle-mismatch fields populated; evaluateCost left undefined.
        expect(report.oracleError).toBe('simulated oracle eval error');
        expect(report.ourError).toBeNull();
        expect(report.ourEvaluateCost).toBe(50);
        expect(report.evaluateCost).toBeUndefined();

        expect(report.location.txIndex).toBe(0);
        expect(report.location.txId).toMatch(/^[0-9a-f]+$/);
        expect(report.location.inputIndex).toBe(0);
        expect(report.bundleExcerpt.headerHex).toBe('abcdef1234');
    });
});
