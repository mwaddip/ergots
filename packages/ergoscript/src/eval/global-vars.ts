/**
 * GlobalVars arm — single MIR variant with internal 6-case dispatch on
 * `e.kind`. Each case has its own cost and produces a different SValue.
 *
 * Sigma-rust ref: ergotree-interpreter/src/eval/global_vars.rs:12-50
 *   match self {
 *     GlobalVars::Height         => { ctx.add_jit_cost(26)?; Ok((ctx.height as i32).into()) }
 *     GlobalVars::SelfBox        => { ctx.add_jit_cost(10)?; Ok(Value::CBox(Ref::from(ctx.self_box))) }
 *     GlobalVars::Outputs        => { ctx.add_jit_cost(10)?; ... }
 *     GlobalVars::Inputs         => { ctx.add_jit_cost(10)?; ... }
 *     GlobalVars::MinerPubKey    => { ctx.add_jit_cost(20)?; ctx.pre_header.miner_pk.sigma_serialize_bytes()?.into() }
 *     GlobalVars::GroupGenerator => { ctx.add_jit_cost(10)?; ergo_chain_types::ec_point::generator().into() }
 *   }
 *
 * Cost-charging order: BEFORE the field check for each case (Pattern A;
 * leaf arm — no child eval). Mirrors sigma-rust's posture where cost is
 * added with `?` before accessing any context field.
 *
 * MinerPubKey returns `Coll[Byte]`, NOT `GroupElement`. Sigma-rust
 * serializes `pre_header.miner_pk` (an EcPoint) to 33-byte compressed SEC1
 * form and returns those bytes as a `Coll[Byte]` value. ErgoScript spec
 * types `MinerPubkey: Coll[Byte]` — the ergo_tree `GlobalVars::MinerPubKey`
 * opcode 0xAC is typed `SColl(SByte)`, not `SGroupElement`.
 *
 * GroupGenerator returns `GroupElement` from the hardcoded
 * `GROUP_GENERATOR_BYTES` constant — no `@noble/curves` dependency (that
 * arrives in phase 2g for actual EcPoint arithmetic).
 *
 * Defensive `'context-field-missing'` throw fires when a required ctx
 * field is `undefined` (e.g., `ctx.selfBox` for SelfBox case). Cost is
 * charged FIRST per Pattern A — if cost overflows the limit, 'cost-limit-
 * exceeded' takes priority.
 */

import type { GlobalVars, SType, SValue } from '../mir/types'
import type { Env } from './env'
import type { EvalContext } from './eval-context'
import { EvalError } from './eval-context'
import { bytesToCollByteSValue } from './_byte-coll'
import { GROUP_GENERATOR_BYTES } from './_group-generator'

// Cost constants — source: sigma-rust eval/global_vars.rs inline comments.
const HEIGHT_COST = 26
const SELF_BOX_COST = 10
const OUTPUTS_COST = 10
const INPUTS_COST = 10
const MINER_PUB_KEY_COST = 20
const GROUP_GENERATOR_COST = 10

// SBox SType singleton used for Coll[Box] elem.
const SBOX_TYPE: SType = { tag: 'SBox' }

export function evalGlobalVars(
  e: GlobalVars,
  _env: Env,
  ctx: EvalContext
): SValue {
  switch (e.kind) {
    case 'Height': {
      ctx.addCost(HEIGHT_COST)
      if (ctx.height === undefined) {
        throw new EvalError(
          'GlobalVars.Height: ctx.height is missing',
          'context-field-missing'
        )
      }
      return { kind: 'Int', value: ctx.height }
    }
    case 'SelfBox': {
      ctx.addCost(SELF_BOX_COST)
      if (ctx.selfBox === undefined) {
        throw new EvalError(
          'GlobalVars.SelfBox: ctx.selfBox is missing',
          'context-field-missing'
        )
      }
      return { kind: 'Box', value: ctx.selfBox }
    }
    case 'Outputs': {
      ctx.addCost(OUTPUTS_COST)
      if (ctx.outputs === undefined) {
        throw new EvalError(
          'GlobalVars.Outputs: ctx.outputs is missing',
          'context-field-missing'
        )
      }
      return {
        kind: 'Coll',
        elem: SBOX_TYPE,
        items: ctx.outputs.map((b) => ({ kind: 'Box' as const, value: b })),
      }
    }
    case 'Inputs': {
      ctx.addCost(INPUTS_COST)
      if (ctx.inputs === undefined) {
        throw new EvalError(
          'GlobalVars.Inputs: ctx.inputs is missing',
          'context-field-missing'
        )
      }
      return {
        kind: 'Coll',
        elem: SBOX_TYPE,
        items: ctx.inputs.map((b) => ({ kind: 'Box' as const, value: b })),
      }
    }
    case 'MinerPubKey': {
      ctx.addCost(MINER_PUB_KEY_COST)
      if (ctx.preHeader === undefined) {
        throw new EvalError(
          'GlobalVars.MinerPubKey: ctx.preHeader is missing',
          'context-field-missing'
        )
      }
      // MinerPubkey returns Coll[Byte] (33 compressed bytes), not GroupElement.
      // Sigma-rust: `ctx.pre_header.miner_pk.sigma_serialize_bytes()?.into()`
      // The miner_pk field in our TS PreHeader is already the 33-byte
      // compressed SEC1 bytes (set by the EvalOpts.preHeader.minerPk field).
      return bytesToCollByteSValue(ctx.preHeader.minerPk)
    }
    case 'GroupGenerator': {
      ctx.addCost(GROUP_GENERATOR_COST)
      // Return a copy of the constant — callers must not mutate the returned value.
      return { kind: 'GroupElement', value: GROUP_GENERATOR_BYTES.slice() }
    }
    default: {
      // Compile-time exhaustiveness check: every kind must be matched above.
      const _exhaust: never = e.kind
      throw new EvalError(
        `GlobalVars: unreachable kind: ${JSON.stringify(_exhaust)}`,
        'not-implemented-yet'
      )
    }
  }
}
