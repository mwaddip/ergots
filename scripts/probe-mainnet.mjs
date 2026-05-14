#!/usr/bin/env node
// Throwaway probe: scan recent mainnet boxes, count how often our 22
// deferred opcodes appear. Validates (or refutes) the "rarely used in
// production trees" claim baked into packages/ergoscript/src/wire/parse.ts.
//
// Usage:
//   node scripts/probe-deferred-opcodes.mjs [WINDOW]              — last WINDOW blocks (default 1000)
//   node scripts/probe-deferred-opcodes.mjs random N              — N random heights from 1..tip

import { parseTree } from '../packages/ergoscript/dist/index.js'
import { writeFileSync } from 'node:fs'

const NODE = 'http://localhost:9052'

// Args
const argv = process.argv.slice(2)
const MODE = argv[0] === 'random' ? 'random' : 'last'
const N = MODE === 'random' ? Number(argv[1] ?? 1000) : Number(argv[0] ?? 1000)
// Random reads cold blocks → stress node disk IO. Lower concurrency helps.
const CONCURRENCY = MODE === 'random' ? 4 : 16
const dumpIdx = argv.indexOf('--dump')
const DUMP_PATH = dumpIdx >= 0 ? argv[dumpIdx + 1] : null

async function getJson(path, attempt = 1) {
  try {
    const res = await fetch(`${NODE}${path}`)
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
    return await res.json()
  } catch (e) {
    // Node restarts ~periodically; tolerate up to ~30s of downtime per request
    // by exponential backoff (0.2 + 0.4 + 0.8 + 1.6 + 3.2 + 6.4 + 12.8 ≈ 25s).
    if (attempt < 8) {
      const delay = 100 * Math.pow(2, attempt)
      await new Promise((r) => setTimeout(r, delay))
      return getJson(path, attempt + 1)
    }
    throw e
  }
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16)
  }
  return out
}

async function fetchBlockTrees(height) {
  const ids = await getJson(`/blocks/at/${height}`)
  const trees = []
  for (const id of ids) {
    const block = await getJson(`/blocks/${id}/transactions`)
    for (const tx of block.transactions) {
      for (const out of tx.outputs) {
        if (out.ergoTree) trees.push({ hex: out.ergoTree, height, boxId: out.boxId })
      }
    }
  }
  return trees
}

async function inBatches(items, n, fn) {
  const out = []
  for (let i = 0; i < items.length; i += n) {
    const batch = items.slice(i, i + n)
    out.push(...(await Promise.all(batch.map(fn))))
  }
  return out
}

function pickRandomHeights(n, tip) {
  const set = new Set()
  while (set.size < n) {
    set.add(1 + Math.floor(Math.random() * tip))
  }
  return [...set].sort((a, b) => a - b)
}

async function main() {
  const info = await getJson('/info')
  const tip = info.fullHeight

  let heights
  if (MODE === 'random') {
    heights = pickRandomHeights(N, tip)
    console.log(`Probing ${N} random heights drawn uniformly from 1..${tip}`)
  } else {
    const start = tip - N + 1
    heights = Array.from({ length: N }, (_, i) => start + i)
    console.log(`Probing heights ${start}..${tip} (${N} blocks)`)
  }
  const t0 = Date.now()

  let done = 0
  const allTrees = []
  await inBatches(heights, CONCURRENCY, async (h) => {
    const trees = await fetchBlockTrees(h)
    allTrees.push(...trees)
    done++
    if (done % 100 === 0) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`  ${done}/${N} blocks, ${allTrees.length} boxes, ${elapsed}s`)
    }
  })

  console.log(`\nFetched ${allTrees.length} boxes across ${N} blocks in ${((Date.now()-t0)/1000).toFixed(1)}s`)

  // Dedupe by ergoTree hex — same tree appearing in N boxes counts once for
  // "does this opcode exist in the wild" purposes; we record one example boxId
  // and one example height for traceability.
  const uniq = new Map() // hex -> { occurrences, exampleBoxId, exampleHeight }
  for (const t of allTrees) {
    const ex = uniq.get(t.hex)
    if (ex) ex.occurrences++
    else uniq.set(t.hex, { occurrences: 1, exampleBoxId: t.boxId, exampleHeight: t.height })
  }
  console.log(`Unique ergo trees: ${uniq.size}`)

  // Classify each unique tree by parse outcome.
  const buckets = {
    success: 0,
    notImplementedYet: new Map(),  // opcode-name -> { count, example }
    unknownOpcode: new Map(),       // byte hex -> { count, example }
    otherExprParseError: new Map(), // code -> { count, example }
    otherErrorClass: new Map(),     // class+code -> { count, example, message }
  }

  for (const [hex, meta] of uniq) {
    try {
      parseTree(hexToBytes(hex))
      buckets.success++
    } catch (e) {
      const code = e.code ?? '<no-code>'
      const cls = e.constructor.name
      const example = { ...meta, hex: hex.slice(0, 80) + (hex.length > 80 ? '…' : '') }

      if (cls === 'ExprParseError' && code === 'not-implemented-yet') {
        // Pull opcode name from message: "<Name> opcode not implemented..."
        const m = /^(\S+) opcode/.exec(e.message) ?? /^(\S+) /.exec(e.message)
        const name = m ? m[1] : '<unparsed>'
        const slot = buckets.notImplementedYet.get(name) ?? { count: 0, example, occurrences: 0 }
        slot.count++
        slot.occurrences += meta.occurrences
        buckets.notImplementedYet.set(name, slot)
      } else if (cls === 'ExprParseError' && code === 'unknown-opcode') {
        const m = /0x([0-9a-fA-F]+)/.exec(e.message)
        const byte = m ? `0x${m[1]}` : '<no-byte>'
        const slot = buckets.unknownOpcode.get(byte) ?? { count: 0, example, occurrences: 0 }
        slot.count++
        slot.occurrences += meta.occurrences
        buckets.unknownOpcode.set(byte, slot)
      } else if (cls === 'ExprParseError') {
        const slot = buckets.otherExprParseError.get(code) ?? { count: 0, example, occurrences: 0, messages: new Set() }
        slot.count++
        slot.occurrences += meta.occurrences
        slot.messages.add(e.message)
        buckets.otherExprParseError.set(code, slot)
      } else {
        const k = `${cls}:${code}`
        const slot = buckets.otherErrorClass.get(k) ?? { count: 0, example, occurrences: 0, message: e.message }
        slot.count++
        slot.occurrences += meta.occurrences
        buckets.otherErrorClass.set(k, slot)
      }
    }
  }

  console.log('\n=== Results ===')
  console.log(`Successful parse: ${buckets.success} unique trees`)

  function report(label, m) {
    console.log(`\n${label}: ${m.size} distinct`)
    if (m.size === 0) return
    const rows = [...m.entries()].sort((a, b) => b[1].occurrences - a[1].occurrences)
    for (const [k, v] of rows) {
      console.log(`  ${k}: ${v.count} unique tree(s), ${v.occurrences} box occurrence(s)`)
      console.log(`    example: box ${v.example.exampleBoxId} @ height ${v.example.exampleHeight}`)
      if (v.message) console.log(`    message: ${v.message}`)
      if (v.messages) for (const msg of v.messages) console.log(`    msg: ${msg}`)
    }
  }
  report('not-implemented-yet (deferred opcodes)', buckets.notImplementedYet)
  report('unknown-opcode (byte not in sigma-rust table)', buckets.unknownOpcode)
  report('other ExprParseError codes', buckets.otherExprParseError)
  report('other error classes', buckets.otherErrorClass)

  // Distinct expr-tpe variant gaps (extracted from val-def-rhs-tpe messages).
  const variantRegex = /exprTpe: variant '([A-Za-z]+)' not yet supported/
  const variantTallies = new Map() // name -> { trees, occurrences, exampleBoxId, exampleHeight }
  const valDefSlot = buckets.otherExprParseError.get('val-def-rhs-tpe')
  if (valDefSlot) {
    // Walk all unique trees again and re-classify by inner variant name. This
    // recovers the full per-variant distribution that the message-Set printout
    // doesn't capture clearly.
    for (const [hex, meta] of uniq) {
      try {
        parseTree(hexToBytes(hex))
      } catch (e) {
        if (e.code !== 'val-def-rhs-tpe') continue
        const m = variantRegex.exec(e.message)
        if (!m) continue
        const name = m[1]
        const t = variantTallies.get(name) ?? { trees: 0, occurrences: 0, exampleBoxId: meta.exampleBoxId, exampleHeight: meta.exampleHeight }
        t.trees++
        t.occurrences += meta.occurrences
        variantTallies.set(name, t)
      }
    }
  }
  if (variantTallies.size > 0) {
    console.log(`\n=== expr-tpe variant gaps (deduped) ===`)
    const rows = [...variantTallies.entries()].sort((a, b) => b[1].occurrences - a[1].occurrences)
    for (const [name, t] of rows) {
      console.log(`  ${name}: ${t.trees} unique tree(s), ${t.occurrences} box occurrence(s)`)
      console.log(`    example: box ${t.exampleBoxId} @ height ${t.exampleHeight}`)
    }
  }

  // Optional dump: write distinct failing trees as JSON for fixture capture.
  if (DUMP_PATH) {
    const failing = []
    for (const [hex, meta] of uniq) {
      try {
        parseTree(hexToBytes(hex))
      } catch (e) {
        const m = variantRegex.exec(e.message)
        const variant = m ? m[1] : null
        failing.push({
          box_id: meta.exampleBoxId,
          ergo_tree_hex: hex,
          block_height: meta.exampleHeight,
          occurrences: meta.occurrences,
          error_class: e.constructor.name,
          error_code: e.code ?? null,
          error_message: e.message,
          ...(variant ? { tpe_gap_variant: variant } : {}),
        })
      }
    }
    failing.sort((a, b) => b.occurrences - a.occurrences)
    writeFileSync(DUMP_PATH, JSON.stringify(failing, null, 2))
    console.log(`\nDumped ${failing.length} distinct failing trees to ${DUMP_PATH}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
