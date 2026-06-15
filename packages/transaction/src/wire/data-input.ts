import type { ByteReader, ByteWriter } from '@ergots/scorex';
import type { DataInput } from '../types';

export function parseDataInput(r: ByteReader): DataInput {
  return { boxId: r.readBytes(32) };
}

export function serializeDataInput(di: DataInput, w: ByteWriter): void {
  w.writeBytes(di.boxId); // 32 bytes, no length prefix
}
