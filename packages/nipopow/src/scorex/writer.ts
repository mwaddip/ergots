export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  writeU8(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      // Programming error, not user input — serializers must never pass an
      // out-of-range byte. Plain Error matches facts/nipopow.md's taxonomy for
      // internal contract violations. Do NOT introduce a typed WriterError
      // class; the asymmetry with ReaderError is intentional.
      throw new Error(`writeU8: out of range: ${byte}`);
    }
    this.chunks.push(new Uint8Array([byte]));
    this._length += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    // Defensive copy: avoid aliasing the caller's buffer so a later mutation
    // of `bytes` doesn't silently corrupt our accumulated output.
    this.chunks.push(bytes.slice());
    this._length += bytes.length;
  }

  toBytes(): Uint8Array {
    const out = new Uint8Array(this._length);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}
