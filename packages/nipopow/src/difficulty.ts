/**
 * Difficulty-recalculation epoch math + continuous-mode membership check.
 *
 * Clean-room port of the JVM's DifficultyAdjustment height selectors
 * (~/projects/ergo-jvm-pr ergo-core .../mining/difficulty/DifficultyAdjustment.scala:27-55)
 * and NipopowProof.hasValidDifficultyHeaders (.../popow/NipopowProof.scala:82-105).
 * The difficulty *arithmetic* (bitcoinCalculate / eip37Calculate / interpolate)
 * is deliberately NOT ported — the proof layer checks header membership only.
 */

/**
 * Effective mainnet epoch length for difficulty recalculation: the JVM
 * computes eip37EpochLength.getOrElse(epochLength) = 128 (EIP-37) at both
 * the prover and verifier call sites, with no height gating — the pre-EIP-37
 * value 1024 never participates in this machinery. Testnet is also 128.
 */
export const EPOCH_LENGTH_MAINNET = 128;
/** Mainnet/testnet chainSettings.useLastEpochs. */
export const USE_LAST_EPOCHS_MAINNET = 8;

export interface DifficultyParams {
  epochLength?: number;
  useLastEpochs?: number;
}

/**
 * Apply mainnet defaults and validate (JVM DifficultyAdjustment constructor
 * requires: useLastEpochs > 1, epochLength > 0, epochLength bounded so the
 * epoch-span product cannot overflow). Bad values are a caller-configuration
 * defect, not a proof defect — hence RangeError, outside the proof-error
 * class taxonomy.
 */
export function resolveDifficultyParams(
  opts: DifficultyParams = {},
): { epochLength: number; useLastEpochs: number } {
  const epochLength = opts.epochLength ?? EPOCH_LENGTH_MAINNET;
  const useLastEpochs = opts.useLastEpochs ?? USE_LAST_EPOCHS_MAINNET;
  if (!Number.isInteger(epochLength) || epochLength < 1) {
    throw new RangeError(`epochLength must be an integer >= 1, got ${epochLength}`);
  }
  if (!Number.isInteger(useLastEpochs) || useLastEpochs < 2) {
    throw new RangeError(`useLastEpochs must be an integer >= 2, got ${useLastEpochs}`);
  }
  if (epochLength * useLastEpochs > 2 ** 31) {
    throw new RangeError(
      `epochLength * useLastEpochs must be <= 2^31, got ${epochLength * useLastEpochs}`,
    );
  }
  return { epochLength, useLastEpochs };
}

/** Height at which difficulty is recalculated next after `height`. */
export function nextRecalculationHeight(height: number, epochLength: number): number {
  if (height % epochLength === 0) return height + 1;
  return (Math.floor(height / epochLength) + 1) * epochLength + 1;
}

/** Heights of previous headers required to recalculate difficulty at `height`. */
export function previousHeightsRequiredForRecalculation(
  height: number,
  epochLength: number,
  useLastEpochs: number,
): number[] {
  if ((height - 1) % epochLength === 0 && epochLength > 1) {
    const out: number[] = [];
    for (let i = useLastEpochs; i >= 0; i--) {
      const h = height - 1 - i * epochLength;
      if (h >= 0) out.push(h);
    }
    return out;
  } else if ((height - 1) % epochLength === 0 && height > epochLength * useLastEpochs) {
    // Reachable only when epochLength === 1 (the branch above eats every
    // epochLength > 1 case). Ported anyway — faithful includes the branches
    // real configs never take. Unlike the first branch, no >= 0 filter.
    const out: number[] = [];
    for (let i = useLastEpochs; i >= 0; i--) out.push(height - 1 - i * epochLength);
    return out;
  } else {
    return [height - 1];
  }
}

/** Heights needed to recalculate difficulty after a block at `height`. */
export function heightsForNextRecalculation(
  height: number,
  epochLength: number,
  useLastEpochs: number,
): number[] {
  return previousHeightsRequiredForRecalculation(
    nextRecalculationHeight(height, epochLength),
    epochLength,
    useLastEpochs,
  );
}
