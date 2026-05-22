#!/usr/bin/env node
/**
 * Dump a single ErgoBox's raw bytes from a block as hex. Used to capture
 * real-mainnet test fixtures (e.g. phase 2j-pre fix-1 T4).
 *
 * Usage:
 *   node tools/mainnet-validate/harness/scripts/dump-output.mjs \
 *     --store-path PATH \
 *     --sidecar-path PATH \
 *     --shim-path PATH \
 *     --height N \
 *     --tx-index I \
 *     --output-index J
 *
 * Prints the hex-encoded raw box bytes to stdout. Other diagnostics go
 * to stderr.
 */

import { ShimClient } from '../dist/protocol.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag.startsWith('--')) throw new Error(`expected --flag, got: ${flag}`);
    args[flag.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv);
const required = ['store-path', 'sidecar-path', 'shim-path', 'height', 'tx-index', 'output-index'];
for (const k of required) {
  if (args[k] === undefined) {
    console.error(`missing required flag --${k}`);
    process.exit(2);
  }
}

const height = parseInt(args['height'], 10);
const txIndex = parseInt(args['tx-index'], 10);
const outputIndex = parseInt(args['output-index'], 10);

const shim = ShimClient.spawn(args['shim-path'], args['store-path'], args['sidecar-path']);

try {
  const tip = await shim.getTipHeight();
  console.error(`shim tip: ${tip}`);
  const block = await shim.getBlock(height);
  console.error(`got block ${height}; ${block.transactions.length} txs`);
  if (txIndex >= block.transactions.length) {
    console.error(`tx-index ${txIndex} out of range (have ${block.transactions.length})`);
    process.exit(3);
  }
  const tx = block.transactions[txIndex];
  console.error(`tx ${txIndex}: ${tx.outputs.length} outputs`);
  if (outputIndex >= tx.outputs.length) {
    console.error(`output-index ${outputIndex} out of range (have ${tx.outputs.length})`);
    process.exit(4);
  }
  const bytes = tx.outputs[outputIndex];
  const hex = Buffer.from(bytes).toString('hex');
  console.error(`output ${outputIndex} length: ${bytes.length} bytes`);
  process.stdout.write(hex + '\n');
} finally {
  // Shim doesn't expose a clean shutdown; SIGTERM the child.
  process.exit(0);
}
