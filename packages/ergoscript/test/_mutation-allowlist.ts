/**
 * Mutations expected to survive (i.e., the operator produces a structurally
 * equivalent variant that the evaluator correctly handles identically).
 * Examples: O2 on commutative BinOps (a+b == b+a); O3 on Coll items only
 * referenced for length (SizeOf).
 *
 * Format: `${arm}:${entryName}:${operatorName}:${siteIndex}`
 * Populated by Task 12 calibration.
 */
export const EXPECTED_SURVIVALS = new Set<string>([])
