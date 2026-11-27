import { serializeBoxAtTreeVersion } from '@ergots/ergoscript';
import type { ErgoBox } from '@ergots/ergoscript';

/** A full box (incl. txId+index) as the JVM writes an output's bytes in validation: at tree version 1,
 *  because `out.bytes` of an output promoted from its candidate is first serialized on a thread that
 *  entered no version context (ErgoBox.scala:87-92; ErgoBoxCandidate.scala:163-180), whatever the box's own
 *  tree version. The tree is re-encoded (`reencodeTreeBytes`, as ErgoBoxCandidate.scala:142 writes it). The
 *  output size checks use these bytes (ErgoTransaction.scala:171, :175). A box whose registers hold a type
 *  the writer has no case for at tree version 1 (a function type) throws `STypeSerializeError`.
 *  An input box's id and rent fee do not: they are over its bytes as received (`boxIdOf`, `boxBytesOf`). */
export function serializeBox(box: ErgoBox): Uint8Array {
  return serializeBoxAtTreeVersion(box, 1);
}
