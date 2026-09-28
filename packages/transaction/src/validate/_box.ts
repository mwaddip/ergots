import { ByteWriter } from '@ergots/scorex';
import { serializeSValue } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';

/** A full box (incl. txId+index) serialized from its fields, at the box's own tree version, with
 *  its tree re-encoded (`reencodeTreeBytes`, as ErgoBoxCandidate.scala:142 writes it). That is the
 *  JVM's `out.bytes` for an output, which is constructed from its candidate
 *  (ErgoLikeTransaction.scala:46-47): the output size checks use it (ErgoTransaction.scala:171, :175).
 *  An input box's id and rent fee do not: they are over its bytes as received (`boxIdOf`, `boxBytesOf`). */
export function serializeBox(box: ErgoBox): Uint8Array {
  const tv = box.ergoTreeBytes.length > 0 ? (box.ergoTreeBytes[0]! & 0x07) : 0;
  const w = new ByteWriter();
  serializeSValue({ tag: 'SBox' }, { kind: 'Box', value: box }, tv, w);
  return w.toBytes();
}
