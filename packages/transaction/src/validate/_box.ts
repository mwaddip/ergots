import { ByteWriter } from '@ergots/scorex';
import { serializeSValue } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';

/** Canonical serialized bytes of a full box (incl. txId+index), at the box's own tree
 *  version — mirrors the proven harness `serializedBoxLen`. The box id is their
 *  blake2b256 (`ergo_box.rs:141,182-185`); the storage-rent fee is on their length. */
export function serializeBox(box: ErgoBox): Uint8Array {
  const tv = box.ergoTreeBytes.length > 0 ? (box.ergoTreeBytes[0]! & 0x07) : 0;
  const w = new ByteWriter();
  serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, tv, w);
  return w.toBytes();
}
