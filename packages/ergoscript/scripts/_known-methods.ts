/**
 * (typeId, methodId) → sigma-rust method name + implementation status.
 *
 * Sourced from `~/projects/sigma-rust/sigma-rust/ergotree-ir/src/types/`.
 * Coverage is intentionally partial at Task B start — only 2g.5's three
 * implemented methods + six plausible 2g.6 candidates from the handoff
 * projection. Widened iteratively during Task 5 as the analyzer surfaces
 * real (typeId, methodId) pairs from mainnet boxes.
 */

export interface KnownMethod {
  name: string
  implemented: boolean
  implementedIn?: string
}

export const KNOWN_METHODS: Map<string, KnownMethod> = new Map([
  // ---- Implemented in phase 2g.5 ----
  ['99:8', { name: 'SBox.tokens', implemented: true, implementedIn: '2g.5' }],
  ['101:1', { name: 'SContext.dataInputs', implemented: true, implementedIn: '2g.5' }],
  ['12:26', { name: 'SColl.indexOf', implemented: true, implementedIn: '2g.5' }],

  // ---- Plausible 2g.6 candidates (per handoff projection; not yet implemented) ----
  // SColl utilities — typeId 12. Method IDs from sigma-rust's
  // ergotree-ir/src/types/scoll.rs; widen iteratively during Task 5.
  ['12:14', { name: 'SColl.indices', implemented: false }],
  ['12:29', { name: 'SColl.zip', implemented: false }],
  ['12:30', { name: 'SColl.zipWith', implemented: false }],
  ['12:21', { name: 'SColl.reverse', implemented: false }],
  ['12:15', { name: 'SColl.flatten', implemented: false }],
  ['12:25', { name: 'SColl.getOrElse', implemented: false }],

  // ---- Widened in Task B5 based on wider corpus survey ----
  // SGlobal methods (typeId 106) — from sglobal.rs
  ['106:1', { name: 'SGlobal.groupGenerator', implemented: false }],

  // SAvlTree methods (typeId 100) — from savltree.rs
  ['100:1',  { name: 'SAvlTree.digest', implemented: false }],
  ['100:10', { name: 'SAvlTree.get', implemented: false }],
  ['100:11', { name: 'SAvlTree.getMany', implemented: false }],
  ['100:12', { name: 'SAvlTree.insert', implemented: false }],
  ['100:13', { name: 'SAvlTree.update', implemented: false }],

  // SContext methods (typeId 101) — from scontext.rs
  ['101:3',  { name: 'SContext.preHeader', implemented: false }],

  // SPreHeader methods (typeId 105) — from spreheader.rs
  ['105:3',  { name: 'SPreHeader.timestamp', implemented: false }],

  // SGroupElement methods (typeId 7) — from sgroup_elem.rs
  ['7:2',    { name: 'SGroupElement.getEncoded', implemented: false }],
])
