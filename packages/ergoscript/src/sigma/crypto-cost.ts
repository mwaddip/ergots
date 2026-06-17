import type { SigmaBoolean } from '../mir/types'

/**
 * Ahead-of-time sigma-protocol *verification* cost of a reduced SigmaBoolean,
 * in JitCost units. Pure structural walk (no crypto performed). The tx cost
 * model scales each input's value to block cost via floor(·/10).
 *
 * Constants from the JVM sigmastate-interpreter (canonical for v6):
 *   Interpreter.scala:554-591 (estimateCryptoVerifyCost),
 *   SigSerializer.scala (ParseChallenge 10, ParsePolynomial base/perChunk 10,
 *     EvaluatePolynomial base/perChunk 3, chunkSize 1),
 *   Interpreter.scala:522-527 (ComputeCommitments_Schnorr 3400 / _DHT 6450),
 *   UnprovenTree.scala:210-221 (ToBytes_Schnorr 570 / _DHT 680 /
 *     ToBytes_ProofTreeConjecture 15).
 *
 * NOTE: the vendored sigma-rust crypto_cost.rs omits the +15
 * (ToBytes_ProofTreeConjecture) for Cthreshold — ergots follows the JVM.
 */
const PROVE_DLOG = 10 + 3400 + 570        // 3980
const PROVE_DHT = 10 + 6450 + 680         // 7140
const TO_BYTES_CONJECTURE = 15            // Cand / Cor / Cthreshold node cost

export function estimateCryptoCost(sb: SigmaBoolean): number {
  switch (sb.tag) {
    case 'TrivialProp':
      return 0
    case 'ProveDlog':
      return PROVE_DLOG
    case 'ProveDhTuple':
      return PROVE_DHT
    case 'Cand':
    case 'Cor':
      return TO_BYTES_CONJECTURE + sumChildren(sb.items)
    case 'Cthreshold': {
      const n = sb.items.length
      const nCoefs = n - sb.k
      const parsePoly = 10 + 10 * nCoefs          // ParsePolynomial PerItemCost(base 10, perChunk 10, chunk 1)
      const evalPoly = (3 + 3 * nCoefs) * n        // EvaluatePolynomial PerItemCost(base 3, perChunk 3, chunk 1) × nChildren
      return parsePoly + evalPoly + TO_BYTES_CONJECTURE + sumChildren(sb.items)
    }
  }
}

function sumChildren(items: SigmaBoolean[]): number {
  let sum = 0
  for (const it of items) sum += estimateCryptoCost(it)
  return sum
}
