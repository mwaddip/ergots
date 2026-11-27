import { describe, it, expect } from 'vitest';
import { buildStatefulDeps } from '../src/validate-tx-lib.js';
import type { TxBundle, BlockBundle } from '../src/bundle-types.js';
import type { WalkerState } from '../src/validate-block.js';
import type { Header } from '@ergots/scorex';

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

  it("an input box is read at tree version 1 with nothing set on its reader", () => {
    // The spent box tree is a v4 tree, which parses only when the reader's
    // activatedVersion is unset (outside any context) or set to 4 or more.
    // A box from the UTXO set is read outside any context, as the JVM does
    // (UtxoStateReader.scala:122-130). With tree version 1 and nothing set
    // on the reader, this v4 box parses cleanly.
    //
    // An ErgoBox with a one-byte v4 tree body (0208d3 is a size-flagged v0
    // sigmaProp(true); at header 0c it is a v4 size-flagged sigmaProp(true)):
    // value(VLQ)=1, ergoTree=0c0208d3, creationHeight(VLQ)=0, tokens(0), additionalRegisters(0),
    // txId(32)=0, index(2)=0
    const boxHex = '01' + '0c0208d3' + '00' + '00' + '00' + '00'.repeat(32) + '0000';
    const boxBytes = hexToBytes(boxHex);
    const tx = {
      txId: new Uint8Array(32), signingMessage: new Uint8Array(),
      inputs: [{
        boxId: new Uint8Array(32), spentBoxBytes: boxBytes,
        signatureBytes: new Uint8Array(), contextExtension: [],
        oracleCost: 0n, oracleSucceeded: true, oracleError: null,
      }],
      outputs: [], dataInputBoxes: [], txBytes: new Uint8Array(),
    } as TxBundle;

    // A block at version 3 (activated 2 on its reader) would reject a v4
    // tree if the harness set activatedVersion on the reader. The read
    // succeeds because nothing is set — the JVM's UTXO read.
    const block = blockWith({
      sectionBlockVersion: 3,
      parameters: { maxBlockCost: 1_000_000, blockVersion: 3 },
    });
    const state: WalkerState = {
      lastHeader: mkHeader(100),
      rollingHeaders: [mkHeader(100), mkHeader(99)],
      network: 'mainnet',
      v2ActivationHeight: 0,
    };

    const deps = buildStatefulDeps(tx, block, state);
    expect(deps.inputBoxes.length).toBe(1);
  });
});
