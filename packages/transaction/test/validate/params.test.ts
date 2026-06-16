import { describe, it, expect } from 'vitest';
import { DEFAULT_PARAMETERS, resolveParameters, MAX_BOX_SIZE, MAX_SCRIPT_SIZE, INTERPRETER_INIT_COST } from '../../src/params';
import { TxValidationError } from '../../src/errors';

describe('parameters + TxValidationError', () => {
  it('DEFAULT_PARAMETERS carries the confirmed sigma-rust defaults (parameters.rs:157-168)', () => {
    expect(DEFAULT_PARAMETERS.maxBlockCost).toBe(1_000_000);
    expect(DEFAULT_PARAMETERS.storageFeeFactor).toBe(1_250_000);
    expect(DEFAULT_PARAMETERS.minValuePerByte).toBe(360);
    expect(DEFAULT_PARAMETERS.inputCost).toBe(2_000);
    expect(DEFAULT_PARAMETERS.dataInputCost).toBe(100);
    expect(DEFAULT_PARAMETERS.outputCost).toBe(100);
    expect(DEFAULT_PARAMETERS.tokenAccessCost).toBe(100);
  });
  it('exposes the confirmed size caps + init cost constants', () => {
    expect(MAX_BOX_SIZE).toBe(4096);
    expect(MAX_SCRIPT_SIZE).toBe(4096);
    expect(INTERPRETER_INIT_COST).toBe(10_000);
  });
  it('resolveParameters fills gaps from the defaults', () => {
    const p = resolveParameters({ maxBlockCost: 2_000_000 });
    expect(p.maxBlockCost).toBe(2_000_000);
    expect(p.storageFeeFactor).toBe(DEFAULT_PARAMETERS.storageFeeFactor);
  });
  it('TxValidationError carries code + location', () => {
    const e = new TxValidationError('boom', 'value-not-conserved', { inputIndex: 1 });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('value-not-conserved');
    expect(e.location?.inputIndex).toBe(1);
  });
});
