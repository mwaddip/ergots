/**
 * The ES2015 global `Map` type, aliased.
 *
 * `mir/types.ts` declares a local `export interface Map` (the MIR node for the
 * `map` higher-order collection op), which SHADOWS the global `Map` within that
 * module — so a bare `Map<K, V>` there resolves to the non-generic MIR node and
 * fails to compile. This module imports nothing from `types.ts`, so `Map` here
 * is the real generic global. `ContextExtension.values` (order-preserving, see
 * its doc) imports `GlobalMap` to dodge the shadow.
 *
 * (The MIR node's `Map` name is the underlying footgun; renaming it is a broader
 * change than this alias and out of scope here.)
 */
export type GlobalMap<K, V> = Map<K, V>
