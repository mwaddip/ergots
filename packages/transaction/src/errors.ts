export type TxParseErrorCode =
  | 'trailing-bytes'
  | 'token-table-index-out-of-range'
  | 'count-out-of-range';
export class TxParseError extends Error {
  readonly code: TxParseErrorCode;
  constructor(message: string, code: TxParseErrorCode) {
    super(message);
    this.name = 'TxParseError';
    this.code = code;
  }
}

export type TxValidationErrorCode =
  // stateless (ergo_transaction.rs:99-116)
  | 'inputs-empty' | 'outputs-empty' | 'duplicate-input' | 'output-sum-overflow'
  // stateful structural (tx_context.rs:151-372 + verify_output)
  | 'input-box-count-mismatch' | 'input-box-id-mismatch' | 'data-input-box-mismatch'
  | 'input-sum-overflow' | 'value-not-conserved'
  | 'output-below-min-value' | 'creation-height-in-future'
  | 'creation-height-below-max-input' | 'creation-height-negative'
  | 'box-size-exceeded' | 'script-size-exceeded'
  | 'token-not-conserved' | 'invalid-minted-token' | 'token-amount-invalid'
  // per-input verify
  | 'non-sigmaprop-result' | 'script-reduced-false' | 'cost-limit-exceeded';
export interface TxValidationLocation {
  inputIndex?: number;
  outputIndex?: number;
  boxId?: Uint8Array;
}
export class TxValidationError extends Error {
  readonly code: TxValidationErrorCode;
  readonly location?: TxValidationLocation;
  constructor(message: string, code: TxValidationErrorCode, location?: TxValidationLocation) {
    super(message);
    this.name = 'TxValidationError';
    this.code = code;
    this.location = location;
  }
}
