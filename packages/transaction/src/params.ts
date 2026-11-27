import type { ChainParameters } from './types';

// sigma-rust ergo-lib/src/chain/parameters.rs Parameters::default() (parameters.rs:157-168) — CONFIRMED.
// The voted block version has no chain-wide default and is required of every caller; it stays off this record.
export const DEFAULT_PARAMETERS: Omit<ChainParameters, 'blockVersion'> = {
  maxBlockCost: 1_000_000,
  storageFeeFactor: 1_250_000,
  minValuePerByte: 360,       // == 30 * 12; also BoxValue::MIN_VALUE_PER_BOX_BYTE
  inputCost: 2_000,
  dataInputCost: 100,
  outputCost: 100,
  tokenAccessCost: 100,
};

// Per-output size caps — CONSTANTS, not parameters (ergo_box.rs:108-110).
export const MAX_BOX_SIZE = 4096;
export const MAX_SCRIPT_SIZE = 4096;
// Fixed per-tx interpreter init cost, BLOCK-cost units (tx_context.rs:110).
export const INTERPRETER_INIT_COST = 10_000;

export function resolveParameters(partial: Partial<ChainParameters> & { blockVersion: number }): ChainParameters {
  return { ...DEFAULT_PARAMETERS, ...partial };
}
