/**
 * `sigmaPropBytesOf` — serialize a SigmaBoolean to its canonical prop_bytes form.
 *
 * This is the serialization produced by sigma-rust's `SigmaProp::prop_bytes()`:
 *   - Wraps the SigmaBoolean as `Const(SSigmaProp, ...)` in a v0 ErgoTree with
 *     **no** constant-segregation (header byte `0x00`).
 *   - Used by the `SigmaPropBytes` eval arm to return `Coll[Byte]`.
 *
 * Source: ergotree-ir/src/sigma_protocol/sigma_boolean.rs:304-311
 *   ```rust
 *   pub fn prop_bytes(&self) -> Result<Vec<u8>, ErgoTreeError> {
 *       let c: Constant = self.clone().into();
 *       let e: Expr = c.into();
 *       let ergo_tree: ErgoTree = e.try_into()?;  // ErgoTree::new(v0(false), &expr) for Const(SSigmaProp)
 *       Ok(ergo_tree.sigma_serialize_bytes()?)
 *   }
 *   ```
 *
 * **Contrast with `propBytes` in `sigma/fiat-shamir.ts`** which uses
 * `constantSegregation=true` (header `0x10`) for Fiat-Shamir challenge
 * computation. These two produce different byte sequences — do NOT substitute
 * one for the other.
 *
 * Wire layout for `sigmaPropBytesOf(sb)`:
 *   0x00                        — ErgoTree header (v0, no hasSize, no segregation)
 *   0x08                        — SSigmaProp type code (doubles as Const opcode in
 *                                 the non-segregated Expr stream)
 *   <sigma-boolean wire bytes>  — TrivialProp/ProveDlog/Cand/Cor/Cthreshold
 */

import type { ErgoTree, SigmaBoolean } from '../mir/types'
import { serializeTree } from '../wire/ergo-tree'

/**
 * Serialize `sb` to its prop_bytes — matching sigma-rust's `SigmaProp::prop_bytes()`.
 *
 * Produces a byte array starting with `0x00 0x08` (v0 header + SSigmaProp type
 * code) followed by the sigma-boolean wire bytes.
 */
export function sigmaPropBytesOf(sb: SigmaBoolean): Uint8Array {
  const tree: ErgoTree = {
    header: {
      version: 0,
      hasSize: false,
      constantSegregation: false,
      rawHeader: 0x00,  // v0, no hasSize, no constantSegregation
    },
    constantTypes: [],
    constants: [],
    body: {
      tag: 'Const',
      tpe: { tag: 'SSigmaProp' },
      value: { kind: 'SigmaProp', value: sb },
    },
  }
  return serializeTree(tree)
}
