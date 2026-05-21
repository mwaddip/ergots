/**
 * CLI argument parser for the mainnet-validate harness.
 *
 * Hand-rolled flag parser — the harness has 9 flags total, no positional
 * args, no sub-commands; pulling in `commander`/`yargs` for that surface
 * is unjustified weight and a transitive-WASM-audit liability.
 *
 * # Why fail on unknown flags?
 *
 * The harness is a developer tool driven by manual invocations; silently
 * accepting `--bogus-flag value` and ignoring it would make typos
 * (`--strat-height` instead of `--start-height`) silently use the
 * checkpoint default instead of the intended override. Failing loud is
 * the only safe default — and it's how every other harness flag we use
 * already behaves (per `main.ts` T6 baseline).
 *
 * # Defaults are relative to cwd
 *
 * The defaults (`./tools/mainnet-validate/...`) assume invocation from
 * the repo root. Users running from elsewhere must pass absolute paths.
 * Documented in the T14 README.
 */

/** Parsed CLI flags. See class-doc above for default semantics. */
export interface CliArgs {
    /** Required: path to the modifiers.redb store (or a copy). */
    storePath: string;
    /** Path to the compiled shim binary. Default points to the standard build location. */
    shimPath: string;
    /** Path to the harness's UTXO sidecar redb (created by shim if absent). */
    sidecarPath: string;
    /** Path to the checkpoint JSON; presence on disk drives resume. */
    checkpointPath: string;
    /** Path to the error-report JSON sidecar; deleted on tip-reached. */
    errorReportPath: string;
    /** Which Ergo network the store represents. */
    network: 'mainnet' | 'testnet';
    /** Override checkpoint's resume height. Unset = resume from checkpoint or start at 1. */
    startHeight?: number;
    /** Cap on the walk's end height. Unset = walk to the shim's reported tip. */
    maxHeight?: number;
    /** Sleep between blocks in ms. 0 = no rate limit. */
    sleepMs: number;
}

/**
 * Default values for every flag with a default. Centralised so the test
 * suite can assert exact-defaults without duplicating the literals.
 */
export const CLI_DEFAULTS = {
    shimPath: './tools/mainnet-validate/shim/target/release/ergots-mainnet-validate-shim',
    sidecarPath: './tools/mainnet-validate/utxo-index.redb',
    checkpointPath: './tools/mainnet-validate/checkpoint.json',
    errorReportPath: './tools/mainnet-validate/error-report.json',
    network: 'mainnet' as const,
    sleepMs: 0,
};

/**
 * Parse the harness's CLI argv (sliced — caller passes `process.argv.slice(2)`).
 *
 * Throws `Error` on:
 *   - Missing required flag (`--store-path`).
 *   - Flag without a value (`--start-height` at end of argv).
 *   - Unknown flag.
 *   - Non-integer / out-of-range numeric value (`--start-height abc`,
 *     `--sleep-ms -1`).
 *   - Invalid network value (`--network foobar`).
 *
 * Returns a fully-populated `CliArgs` (defaults applied) on success.
 */
export function parseCliArgs(argv: readonly string[]): CliArgs {
    let storePath: string | undefined;
    let shimPath: string | undefined;
    let sidecarPath: string | undefined;
    let checkpointPath: string | undefined;
    let errorReportPath: string | undefined;
    let network: 'mainnet' | 'testnet' | undefined;
    let startHeight: number | undefined;
    let maxHeight: number | undefined;
    let sleepMs: number | undefined;

    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i]!;
        // Every flag in our surface takes a value; pull it eagerly and check.
        const valueRaw = argv[i + 1];
        const requireValue = (): string => {
            if (valueRaw === undefined) {
                throw new Error(`flag ${flag} requires a value`);
            }
            return valueRaw;
        };
        const requireNonNegInt = (): number => {
            const v = requireValue();
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0) {
                throw new Error(
                    `flag ${flag} requires a non-negative integer, got "${v}"`,
                );
            }
            return n;
        };
        switch (flag) {
            case '--store-path':
                storePath = requireValue();
                i++;
                break;
            case '--shim-path':
                shimPath = requireValue();
                i++;
                break;
            case '--sidecar-path':
                sidecarPath = requireValue();
                i++;
                break;
            case '--checkpoint-path':
                checkpointPath = requireValue();
                i++;
                break;
            case '--error-report-path':
                errorReportPath = requireValue();
                i++;
                break;
            case '--network': {
                const v = requireValue();
                if (v !== 'mainnet' && v !== 'testnet') {
                    throw new Error(
                        `flag --network requires "mainnet" or "testnet", got "${v}"`,
                    );
                }
                network = v;
                i++;
                break;
            }
            case '--start-height':
                startHeight = requireNonNegInt();
                i++;
                break;
            case '--max-height':
                maxHeight = requireNonNegInt();
                i++;
                break;
            case '--sleep-ms':
                sleepMs = requireNonNegInt();
                i++;
                break;
            default:
                throw new Error(`unknown flag: ${flag}`);
        }
    }

    if (storePath === undefined) {
        throw new Error('--store-path is required');
    }

    const out: CliArgs = {
        storePath,
        shimPath: shimPath ?? CLI_DEFAULTS.shimPath,
        sidecarPath: sidecarPath ?? CLI_DEFAULTS.sidecarPath,
        checkpointPath: checkpointPath ?? CLI_DEFAULTS.checkpointPath,
        errorReportPath: errorReportPath ?? CLI_DEFAULTS.errorReportPath,
        network: network ?? CLI_DEFAULTS.network,
        sleepMs: sleepMs ?? CLI_DEFAULTS.sleepMs,
    };
    if (startHeight !== undefined) {
        out.startHeight = startHeight;
    }
    if (maxHeight !== undefined) {
        out.maxHeight = maxHeight;
    }
    return out;
}

/** Human-readable usage string. Used by main.ts on argv-parse failure. */
export const USAGE = `usage: node dist/main.js --store-path <path> [options]

required:
  --store-path PATH             path to ergo-node modifiers.redb (or copy)

options:
  --shim-path PATH              shim binary (default: ${CLI_DEFAULTS.shimPath})
  --sidecar-path PATH           harness UTXO sidecar (default: ${CLI_DEFAULTS.sidecarPath})
  --checkpoint-path PATH        checkpoint JSON (default: ${CLI_DEFAULTS.checkpointPath})
  --error-report-path PATH      error report JSON (default: ${CLI_DEFAULTS.errorReportPath})
  --network mainnet|testnet     network identifier (default: ${CLI_DEFAULTS.network})
  --start-height N              override checkpoint's resume height
  --max-height M                cap on end height (default: tip)
  --sleep-ms N                  ms to sleep between blocks (default: ${CLI_DEFAULTS.sleepMs})
`;
