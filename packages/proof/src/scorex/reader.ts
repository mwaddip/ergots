export class ReaderError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'ReaderError';
  }
}

export class ByteReader {
  private _position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this._position;
  }

  get remaining(): number {
    return this.bytes.length - this._position;
  }

  get isExhausted(): boolean {
    return this._position >= this.bytes.length;
  }

  readU8(): number {
    if (this._position >= this.bytes.length) {
      throw new ReaderError('readU8: EOF', 'truncated');
    }
    return this.bytes[this._position++]!;
  }

  readBytes(n: number): Uint8Array {
    if (this.remaining < n) {
      throw new ReaderError(`readBytes(${n}): only ${this.remaining} available`, 'truncated');
    }
    const out = this.bytes.subarray(this._position, this._position + n);
    this._position += n;
    return out;
  }
}
