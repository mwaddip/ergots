/**
 * The surface of the internal `coll/` module for the rest of
 * `@ergots/ergoscript`. `CollClass` and `ArrayClass` are also re-exported as
 * types from the package root (`src/index.ts`).
 *
 * `withClass` is intentionally not re-exported: it is for the module's own
 * operations (the next tasks' `coll/ops.ts`), which import it from `./build`
 * directly.
 */

export type {
  ArrayClass,
  CollClass,
  CollValue,
  PrimitiveArrayClass,
  ReferenceArrayClass,
} from './class'
export {
  arrayClassOf,
  classOf,
  CollArrayStore,
  CollClassCast,
  CollTypeRefused,
  dataClass,
  runtimeClassOf,
} from './class'
export { byteColl, collOverArray, fromArray, fromData } from './build'
export {
  endsWith,
  filtered,
  flatMapped,
  getOrElse,
  indices,
  mapped,
  patch,
  reversed,
  slice,
  startsWith,
  zip,
} from './ops'
