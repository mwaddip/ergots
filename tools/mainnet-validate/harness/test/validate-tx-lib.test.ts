import { describe, it, expect } from 'vitest';
import { buildStatefulDeps, validateTxLib } from '../src/validate-tx-lib.js';
import { HarnessError } from '../src/errors.js';
import type { TxBundle, BlockBundle } from '../src/bundle-types.js';
import type { WalkerState } from '../src/validate-block.js';
import { ByteReader } from '@ergots/scorex';
import type { Header } from '@ergots/scorex';
import { parseSValue } from '@ergots/ergoscript';

const mkHeader = (height: number): Header => ({
  version: 3, parentId: new Uint8Array(32), timestamp: 1700000000000n, nBits: 0x1d00ffff,
  height, votes: new Uint8Array(3), stateRoot: new Uint8Array(33),
  autolykosSolution: { minerPk: new Uint8Array(33) },
} as unknown as Header);

// inputBoxesHex[0] from packages/transaction/test/fixtures/stateful/8551d5a22ab56b1921fddfcc56a3a473f159803fb76a37929eff85e8116a6917.json
// 566 bytes — parses cleanly as an SBox.
const SAMPLE_BOX_HEX =
  '8086c1bafb011b91030f05d005010002000400041004000410050004987c04a09603010004020e20f0868a4b1f5c0632902eb7263f802283bb90a68a37052eb7051ffa86b0d2517004000500d80ed6017ea305d602e4c6a70705d6039a72027300d604e5e30008d17301d6058301027302d606e5e3013c0e0e860272057205d607b2a5730300d608e4c6a70606d609e4c672070606d60ae4c6a70464d60be4c672070464d60ce4c6a70504d60de4c672070504d60ee4c672070705958f72017203d802d60f8c720602d610b1720fea02d19683080193cbd072048c72060193c27207c2a793c17207c1a7959172107304d801d6117cb4720f73057306eceded91721173079372099a72087e72110692721073088f72107309730a93db6401e4dc640c720a0283013c0e0e7206e5e3020e7205db6401720b93720d9a720c730b93720e720293db63087207db6308a77204d1ed93cbc27207730c9683090193c17207c1a793db63087207db6308a793720b720a93720d720c937209720890720e720192720e720393c5a7c5b2a4730d0093e5c672070805730e7202e6ca18012acc02b686940b966475926b6387adaacddba50bb8ededf0a517350e947ab5a88090cad2c60e05644ec61f485b98eb87153f7c57db4f5ecd75556fddbc403b41acf8441fde8e160900072000040006010005ce95310e20c36f120f29fcda40b3894b07ca9fe341877245834f4209240496414267c7ab899d2e5362bf8e59e4818bbc82297044184eae93a6ef16854dc609fa11ed5f470500';

const hexToBytes = (h: string) => {
  const a = new Uint8Array(h.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return a;
};

const blockWith = (overrides: Partial<BlockBundle> = {}): BlockBundle => ({
  height: 100, blockId: new Uint8Array(32), parentId: new Uint8Array(32),
  headerBytes: new Uint8Array(), headerJson: '', transactions: [],
  sectionBlockVersion: 1,
  parameters: { maxBlockCost: 2_000_000, blockVersion: 1 },
  ...overrides,
});

describe('buildStatefulDeps', () => {
  it('maps a bundle to StatefulDeps: inputBoxes parsed, headers = preceding, preHeader = block H', () => {
    const boxBytes = hexToBytes(SAMPLE_BOX_HEX);
    expect(boxBytes.length).toBe(566); // sanity

    const tx = {
      txId: new Uint8Array(32), signingMessage: new Uint8Array(),
      inputs: [{
        boxId: new Uint8Array(32), spentBoxBytes: boxBytes,
        signatureBytes: new Uint8Array(), contextExtension: [],
        oracleCost: 0n, oracleSucceeded: true, oracleError: null,
      }],
      outputs: [], dataInputBoxes: [], txBytes: new Uint8Array(),
    } as TxBundle;

    const block = blockWith();

    const state: WalkerState = {
      lastHeader: mkHeader(100),
      rollingHeaders: [mkHeader(100), mkHeader(99), mkHeader(98)],
      network: 'testnet',
      v2ActivationHeight: 0,
    };

    const deps = buildStatefulDeps(tx, block, state);
    expect(deps.inputBoxes.length).toBe(1);
    expect(deps.dataInputBoxes.length).toBe(0);
    // preceding = slice(1) = [99, 98]; preHeader from rollingHeaders[0] = height 100
    expect(deps.stateContext.headers.map((h) => h.height)).toEqual([99, 98]);
    expect(deps.stateContext.preHeader.height).toBe(100);
    expect(deps.stateContext.parameters?.maxBlockCost).toBe(2_000_000);
  });

  it("carries the voted block version through to stateContext.parameters.blockVersion", () => {
    const boxBytes = hexToBytes(SAMPLE_BOX_HEX);
    const tx = {
      txId: new Uint8Array(32), signingMessage: new Uint8Array(),
      inputs: [{
        boxId: new Uint8Array(32), spentBoxBytes: boxBytes,
        signatureBytes: new Uint8Array(), contextExtension: [],
        oracleCost: 0n, oracleSucceeded: true, oracleError: null,
      }],
      outputs: [], dataInputBoxes: [], txBytes: new Uint8Array(),
    } as TxBundle;

    const block = blockWith({
      parameters: { maxBlockCost: 1_234_567, blockVersion: 5 },
    });
    const state: WalkerState = {
      lastHeader: mkHeader(100),
      rollingHeaders: [mkHeader(100), mkHeader(99)],
      network: 'mainnet',
      v2ActivationHeight: 0,
    };

    const deps = buildStatefulDeps(tx, block, state);
    expect(deps.stateContext.parameters?.blockVersion).toBe(5);
    expect(deps.stateContext.parameters?.maxBlockCost).toBe(1_234_567);
  });

  // A hand-built box whose R4 is an empty `Coll[Int => Int]` — a register
  // type that exists only from tree version 3 (ergo-core
  // `ErgoBoxCandidate.scala:231`, `CheckV6Type` at `:232`). The ergots test
  // at `packages/ergoscript/test/wire/jvm-type-reads.test.ts:945-957` pins
  // the JVM's verdict: a read under (3, 3) accepts it and a read under
  // (1, 1) refuses it with rule 1008.
  // Shape: value(VLQ=1) + ergoTree(`00 08 d3`) + creationHeight(VLQ=1) +
  //         tokens(VLQ=0) + registers(VLQ=1) + Const(`0c 70 01 04 04 00`) +
  //         txId(32·0) + index(2·0).
  const V3_ONLY_REGISTER_BOX_HEX = `0100d101010000010c700104040000${'00'.repeat(33)}`;

  it("an input box is read at tree version 1: an R4 of type Coll[Int => Int] is refused", () => {
    // Sanity: a `parseSValue(SBox, 3, …)` call accepts this box.
    const r3 = new ByteReader(hexToBytes(V3_ONLY_REGISTER_BOX_HEX));
    const sv = parseSValue({ tag: 'SBox' }, 3, r3);
    expect(sv.kind).toBe('Box');

    // The tree-version-1 call refuses it (SFunc is not an elem type below tree v3).
    const r1 = new ByteReader(hexToBytes(V3_ONLY_REGISTER_BOX_HEX));
    expect(() => parseSValue({ tag: 'SBox' }, 1, r1)).toThrow();

    // `buildStatefulDeps` reads the spent box through the tree-version-1
    // call, so handing the box in refuses the whole deps build.
    const tx = {
      txId: new Uint8Array(32), signingMessage: new Uint8Array(),
      inputs: [{
        boxId: new Uint8Array(32), spentBoxBytes: hexToBytes(V3_ONLY_REGISTER_BOX_HEX),
        signatureBytes: new Uint8Array(), contextExtension: [],
        oracleCost: 0n, oracleSucceeded: true, oracleError: null,
      }],
      outputs: [], dataInputBoxes: [], txBytes: new Uint8Array(),
    } as TxBundle;
    const block = blockWith();
    const state: WalkerState = {
      lastHeader: mkHeader(100),
      rollingHeaders: [mkHeader(100), mkHeader(99)],
      network: 'mainnet',
      v2ActivationHeight: 0,
    };
    expect(() => buildStatefulDeps(tx, block, state)).toThrow();
  });

  it("when the bundle carries no parameters, falls back to the walk's network launch value", () => {
    const tx = {
      txId: new Uint8Array(32), signingMessage: new Uint8Array(),
      inputs: [], outputs: [], dataInputBoxes: [], txBytes: new Uint8Array(),
    } as TxBundle;
    const block = blockWith({ parameters: null });
    const stateMainnet: WalkerState = {
      lastHeader: mkHeader(100), rollingHeaders: [mkHeader(100), mkHeader(99)],
      network: 'mainnet', v2ActivationHeight: 0,
    };
    const stateTestnet: WalkerState = { ...stateMainnet, network: 'testnet' };
    expect(buildStatefulDeps(tx, block, stateMainnet).stateContext.parameters?.blockVersion).toBe(1);
    expect(buildStatefulDeps(tx, block, stateTestnet).stateContext.parameters?.blockVersion).toBe(4);
  });
});

// A hand-built transaction with one input and one output whose tree is v4
// (`0c0208d3`, header 0x0c = version 4 with hasSize). Mirrors
// `test/validate-tx-ids.test.ts`'s V4_TX_HEX: at section block version 3 the
// parse context is (1, 1) and the v4 tree parses; at section block version 4
// it is (3, 3) and the v4 tree is refused.
//
// Same TX_PREFIX layout: 1 input + boxId (32) + empty proof + empty extension
//   + 0 data inputs + 0 token ids + 1 output + value VLQ + ergoTree
//   + creationHeight(VLQ=1) + tokens(VLQ=0) + registers(VLQ=0).
const TX_PREFIX =
  '010f9267b537544e9f57a5b1d67dc0da2c6dfd706f28359b7c9021988a7e5b20c000000000018094ebdc03';
const V4_TX_HEX = `${TX_PREFIX}0c0208d3010000`;

// A plain v0 SigmaProp(true) box (`0008d3`), so `parseBox` accepts it as an
// input and `validateStateful` receives real deps. Its `boxId` is a fixed
// 32 zero bytes; the input references that id.
const V0_BOX_HEX = `0100d101010000000000${'00'.repeat(32)}0000`;

describe('validateTxLib: parse context from the section', () => {
  function bundleFor(
    txHex: string,
    sectionBlockVersion: number,
    inputBoxId: Uint8Array,
  ): { tx: TxBundle; block: BlockBundle; state: WalkerState } {
    const tx: TxBundle = {
      txId: new Uint8Array(32), signingMessage: new Uint8Array(0),
      inputs: [{
        boxId: inputBoxId, spentBoxBytes: hexToBytes(V0_BOX_HEX),
        signatureBytes: new Uint8Array(0), contextExtension: [],
        oracleCost: 0n, oracleSucceeded: true, oracleError: null,
      }],
      outputs: [new Uint8Array(0)], dataInputBoxes: [],
      txBytes: hexToBytes(txHex),
    };
    const block: BlockBundle = {
      height: 100, blockId: new Uint8Array(32), parentId: new Uint8Array(32),
      headerBytes: new Uint8Array(0), headerJson: '', transactions: [tx],
      sectionBlockVersion,
      parameters: { maxBlockCost: 1_000_000, blockVersion: sectionBlockVersion },
    };
    const state: WalkerState = {
      lastHeader: mkHeader(100), rollingHeaders: [mkHeader(100), mkHeader(99)],
      network: 'mainnet', v2ActivationHeight: 0,
    };
    return { tx, block, state };
  }

  it("section v3 admits a v4 output tree: parse under (1, 1) reaches validateStateful", () => {
    // The test relies only on the parse reaching validateStateful.
    // validateStateful rejects the deps (the parsed input boxId `0f92…`
    // does not match the deps box, built from `V0_BOX_HEX`), so the call
    // throws; the assertion is that the HarnessError's code is not
    // `lib-parse-failed`. The TxBundle's input `boxId` is a 32-zero placeholder.
    const { tx, block, state } = bundleFor(V4_TX_HEX, 3, new Uint8Array(32));
    try {
      validateTxLib(tx, block, state, 0);
    } catch (e) {
      // Any error must NOT be the parse one — the call got past the parse.
      expect(e).toBeInstanceOf(HarnessError);
      const he = e as HarnessError;
      expect(he.code).not.toBe('lib-parse-failed');
    }
  });

  it("section v4 refuses a v4 output tree: parse under (3, 3) raises lib-parse-failed", () => {
    const { tx, block, state } = bundleFor(V4_TX_HEX, 4, new Uint8Array(32));
    try {
      validateTxLib(tx, block, state, 0);
      // The call must throw before reaching validateStateful.
      expect.fail('expected validateTxLib to throw lib-parse-failed');
    } catch (e) {
      expect(e).toBeInstanceOf(HarnessError);
      const he = e as HarnessError;
      expect(he.phase).toBe('lib-validate');
      expect(he.code).toBe('lib-parse-failed');
      expect(he.message).toMatch(/tree-version-above-activated|tree version 4 is above/i);
    }
  });
});
