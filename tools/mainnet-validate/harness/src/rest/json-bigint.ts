/**
 * BigInt-preserving JSON parser/stringifier for REST responses.
 *
 * The node's `/blocks/{id}` JSON includes `outputs[].value` (box value, nanoERG)
 * and `outputs[].assets[].amount` as JSON numbers; some mainnet boxes carry
 * values up to `i64::MAX = 9223372036854775807`, which exceeds JS
 * `Number.MAX_SAFE_INTEGER` (2^53 - 1). The native `JSON.parse` silently
 * truncates to the nearest representable double, and a subsequent
 * `JSON.stringify(tx)` (which the bundle-assembler hands to the WASM cost
 * oracle) then emits a mangled value. Sigma-rust's box-from-JSON parser
 * recomputes the box id from the (now-different) serialized bytes and
 * rejects the tx with `InvalidBoxId` — surfaced first at mainnet h=209638
 * (asset amount i64::MAX on a token-minting tx).
 *
 * `json-bigint` with `useNativeBigInt: true` parses numbers > MAX_SAFE_INTEGER
 * as native `bigint` and stringifies them back as unquoted JSON number literals
 * (which sigma-rust accepts). Numbers within the safe range stay as `number`
 * so existing call sites that read e.g. `header.height: number` are unaffected.
 */

import JSONBigFactory from 'json-bigint'

const JSONBig = JSONBigFactory({ useNativeBigInt: true })

export function parseLossless(text: string): unknown {
    return JSONBig.parse(text)
}

export function stringifyLossless(value: unknown): string {
    return JSONBig.stringify(value)
}
