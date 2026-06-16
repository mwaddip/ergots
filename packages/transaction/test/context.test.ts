import { describe, it, expect } from 'vitest';
import { buildInputContext } from '../src/context';
import type { ContextExtension, ErgoBox, Header, PreHeader } from '../src/types';

// Minimal synthetic args — buildInputContext only reads headers[0].stateRoot
// (for lastBlockUtxoRootHash) and otherwise threads fields into makeContext.
const selfBox = {
  value: 1000n,
  ergoTreeBytes: new Uint8Array([0x00]),
  creationHeight: 1,
  tokens: [],
  registers: {},
  txId: new Uint8Array(32),
  index: 0,
} as unknown as ErgoBox;
const header = { stateRoot: new Uint8Array(33) } as unknown as Header;
const preHeader = {
  version: 3,
  parentId: new Uint8Array(32),
  timestamp: 0n,
  nBits: 0,
  height: 100,
  minerPk: new Uint8Array(33),
  votes: new Uint8Array(3),
} as unknown as PreHeader;

describe('buildInputContext — inputExtensions threading (v6 getVarFromInput)', () => {
  it('threads inputExtensions through to ctx.inputExtensions', () => {
    // Per-input context extensions, indexed by input position. getVarFromInput
    // (SContext 101:12) reads ctx.inputExtensions[inputIdx]; without this the
    // evaluator returns None and `.get` throws OptionGet — a false-reject on any
    // cross-input getVarFromInput tx (caught at testnet h=92847).
    const inputExtensions: ContextExtension[] = [{ values: new Map() }, { values: new Map() }];
    const ctx = buildInputContext({
      height: 100,
      selfBox,
      inputs: [selfBox],
      outputs: [],
      dataInputs: [],
      preHeader,
      headers: [header],
      extension: { values: new Map() },
      jitCostLimit: 1_000_000,
      treeVersion: 3,
      constants: [],
      inputExtensions,
    });
    expect(ctx.inputExtensions).toBe(inputExtensions);
    expect(ctx.inputExtensions?.length).toBe(2);
  });
});
