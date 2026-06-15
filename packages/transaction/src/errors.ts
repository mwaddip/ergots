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
