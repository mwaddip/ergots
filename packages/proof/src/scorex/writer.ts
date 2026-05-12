export class ByteWriter {
  private chunks: Uint8Array[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  writeU8(byte: number): void {
    if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
      throw new Error(`writeU8: out of range: ${byte}`);
    }
    this.chunks.push(new Uint8Array([byte]));
    this._length += 1;
  }

  writeBytes(bytes: Uint8Array): void {
    this.chunks.push(bytes);
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
