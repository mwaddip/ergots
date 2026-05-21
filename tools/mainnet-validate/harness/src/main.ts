/**
 * Minimal harness entry point for T6: parse argv, spawn the shim, send
 * `GET_TIP_HEIGHT`, print the result, exit. No validation yet — T8+ wires
 * the actual per-block walk loop.
 *
 * Argv shape (per PLAN.md T11 spec, but T6 only consumes the two required flags):
 *
 *   node dist/main.js --store-path <path> --shim-path <path> [--sidecar-path <path>]
 *
 * Defaults:
 *   --sidecar-path → `./utxo-index.redb` (under cwd; the shim creates if absent).
 */

import { ShimClient, ShimError } from './protocol.js';

/** Result of CLI parsing — extended with more flags in T11. */
interface CliFlags {
    storePath: string;
    shimPath: string;
    sidecarPath: string;
}

function parseArgv(argv: readonly string[]): CliFlags {
    const flags: Partial<CliFlags> = {};
    for (let i = 0; i < argv.length; i++) {
        const flag = argv[i];
        const value = argv[i + 1];
        if (flag === undefined) {
            continue;
        }
        if (value === undefined) {
            throw new Error(`flag ${flag} requires a value`);
        }
        switch (flag) {
            case '--store-path':
                flags.storePath = value;
                i++;
                break;
            case '--shim-path':
                flags.shimPath = value;
                i++;
                break;
            case '--sidecar-path':
                flags.sidecarPath = value;
                i++;
                break;
            default:
                throw new Error(`unknown flag: ${flag}`);
        }
    }
    if (flags.storePath === undefined) {
        throw new Error('--store-path is required');
    }
    if (flags.shimPath === undefined) {
        throw new Error('--shim-path is required');
    }
    return {
        storePath: flags.storePath,
        shimPath: flags.shimPath,
        sidecarPath: flags.sidecarPath ?? './utxo-index.redb',
    };
}

async function main(): Promise<number> {
    let flags: CliFlags;
    try {
        flags = parseArgv(process.argv.slice(2));
    } catch (err) {
        process.stderr.write(
            `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.stderr.write(
            'usage: node dist/main.js --store-path <path> --shim-path <path> [--sidecar-path <path>]\n',
        );
        return 2;
    }

    const client = ShimClient.spawn(flags.shimPath, flags.storePath, flags.sidecarPath);
    try {
        const tip = await client.getTipHeight();
        process.stdout.write(`Tip height: ${tip}\n`);
        return 0;
    } catch (err) {
        if (err instanceof ShimError) {
            // err.message already includes the `[code]` prefix; don't double-print.
            process.stderr.write(`${err.message}\n`);
            return 1;
        }
        process.stderr.write(
            `error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        return 1;
    } finally {
        await client.close();
    }
}

main().then(
    (code) => {
        process.exit(code);
    },
    (err: unknown) => {
        process.stderr.write(`unhandled: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        process.exit(1);
    },
);
