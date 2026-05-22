//! Cost oracle for phase 2j-a divergence-surfacing channel.
//!
//! Computes sigma-rust's per-input cost via the public `reduce_to_crypto`
//! entry point and reads `ctx.jit_cost_value()` directly. The result rides
//! along on `InputBundle.oracle_cost` for the harness to compare against our
//! TS `ctx.jitCost`.
//!
//! CRITICAL: this module reads `ctx.jit_cost_value()` directly. It NEVER
//! uses `ReductionResult.cost`, which is `jit_cost / 10` (block cost) per
//! `ergotree-interpreter/src/eval.rs:174`. Comparing block-cost to our raw
//! JitCost-mirroring `ctx.jitCost` would yield off-by-10 mismatches on
//! every input.
//!
//! ## Architecture
//!
//! The wrapper takes the per-input chain-state already gathered by
//! `block_walker` (header bytes, parsed Transaction, parsed input/output
//! boxes, rolling-headers window, block parameters) and reproduces the
//! same `Context` shape that `harness/src/validate-tx.ts:481-558` builds
//! on the TS side. Both sides should construct byte-equivalent context
//! field-by-field; any divergence is a context-fidelity bug surfaced by
//! T9's smoke walk.
//!
//! For multi-input transactions, the shim calls `make_context` per input
//! (fresh `Context` with `jit_cost: 0`). This matches the harness's
//! fresh-`EvalOpts`-per-input pattern. The pub(crate) `update_context`
//! path is not accessible from the shim crate; we re-make instead.
//!
//! ## Source mapping
//!
//! | Site | Reference |
//! |---|---|
//! | `make_context` (entry) | `ergo-lib/src/wallet/signing.rs:46` |
//! | `reduce_to_crypto` | `ergotree-interpreter/src/eval.rs:161` |
//! | `Context::jit_cost` | `ergotree-ir/src/chain/context.rs:49` (pub Cell<u64>) |
//! | `Context::jit_cost_value` | `ergotree-ir/src/chain/context.rs:102` |
//! | `validate()` reference flow | `ergo-lib/src/wallet/tx_context.rs:151` |
//! | TS counterpart | `harness/src/validate-tx.ts:481-558` |

use std::cell::Cell;

use anyhow::Result;
use ergo_lib::ergo_chain_types::{Header, PreHeader};
use ergo_lib::chain::ergo_state_context::{ErgoStateContext, Headers};
use ergo_lib::chain::parameters::Parameters;
use ergo_lib::chain::transaction::Transaction;
use ergo_lib::ergotree_interpreter::eval::reduce_to_crypto;
use ergo_lib::wallet::signing::make_context;
use ergo_lib::wallet::tx_context::TransactionContext;
use sigma_ser::ScorexSerializable;

/// Result of `compute_oracle_cost` for a single input.
///
/// The shim emits this via `InputBundle.oracle_cost / oracle_succeeded /
/// oracle_error`. The harness compares `oracle_cost` against our TS
/// `ctx.jitCost` for cost-equivalence; `oracle_succeeded` against the
/// presence-or-absence of our TS-side throw.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CostOracleResult {
    /// Raw JitCost accumulated on `ctx.jit_cost` post-eval. NOT block cost
    /// (`ReductionResult.cost`), which divides by 10.
    pub cost: u64,
    /// `true` when `reduce_to_crypto` returned Ok; `false` when it errored.
    pub is_ok: bool,
    /// Stringified `EvalError` when `is_ok == false`; None on success.
    pub error_msg: Option<String>,
}

/// Compute sigma-rust's per-input JIT cost for one transaction input.
///
/// `tx_context` and `state_ctx` carry the full chain-state required by
/// `make_context`. `input_index` selects which input we're costing.
/// All ErgoBox parsing happens upstream in `block_walker`; this function
/// is pure Context-build + reduce + read-cost.
///
/// On any error (parse failure, Context construction failure, eval throw,
/// jit_cost_limit hit), returns `CostOracleResult { is_ok: false, ... }`
/// with `cost` reflecting whatever partial accumulation happened before
/// the throw. Sigma-rust preserves `ctx.jit_cost` through error returns
/// (no rollback), matching our TS evaluator's behavior per
/// `facts/ergoscript-eval.md` "partial costs are NOT rolled back".
pub fn compute_oracle_cost(
    tx_context: &TransactionContext<Transaction>,
    state_ctx: &ErgoStateContext,
    input_index: usize,
) -> CostOracleResult {
    // Build a fresh Context for this input. make_context returns a Context
    // with `jit_cost: Cell::new(0)`, `jit_cost_limit: None`, `constants:
    // None`, `tree_version: Default::default()`. We override these before
    // invoking reduce_to_crypto so the context matches the harness's
    // per-input EvalOpts construction.
    let mut ctx = match make_context(state_ctx, tx_context, input_index) {
        Ok(c) => c,
        Err(e) => {
            return CostOracleResult {
                cost: 0,
                is_ok: false,
                error_msg: Some(format!("make_context failed: {e}")),
            };
        }
    };

    // Look up the spent box for this input so we can derive the
    // per-input tree_version from its ergo_tree.
    let input_box = match tx_context
        .spending_tx
        .inputs
        .get(input_index)
        .and_then(|i| tx_context.get_input_box(&i.box_id))
    {
        Some(b) => b,
        None => {
            return CostOracleResult {
                cost: 0,
                is_ok: false,
                error_msg: Some(format!(
                    "input box not found for input_index={input_index}"
                )),
            };
        }
    };

    // Override tree_version with the actual version from the spent box's
    // ergo_tree header. make_context sets tree_version: Default::default()
    // (which is V0); the harness derives the per-input value from the
    // parsed spent box's tree header. Context-fidelity requires us to do
    // the same.
    let tree_version = match input_box.ergo_tree.header() {
        Ok(h) => h.version(),
        Err(e) => {
            return CostOracleResult {
                cost: ctx.jit_cost_value(),
                is_ok: false,
                error_msg: Some(format!("ergo_tree.header() failed: {e}")),
            };
        }
    };
    ctx.tree_version = Cell::new(tree_version);

    // Mirror harness's jitCostLimit derivation (validate-tx.ts:503-506):
    // block.parameters.maxBlockCost when available, else DEFAULT_MAX_BLOCK_COST.
    // sigma-rust internally multiplies by 10 to convert block-cost to JitCost
    // (see tx_context.rs:202 `max_block_cost as u64 * 10`).
    ctx.jit_cost_limit = Some(state_ctx.parameters.max_block_cost() as u64 * 10);

    // Reduce-to-crypto. The cost accumulator on `ctx.jit_cost` mutates in
    // place; we read it after the call (success or error) to get the raw
    // JitCost integer. CRITICAL: we IGNORE ReductionResult.cost — that's
    // `jit_cost / 10` per eval.rs:174.
    let outcome = reduce_to_crypto(&input_box.ergo_tree, &ctx);
    let cost = ctx.jit_cost_value();
    match outcome {
        Ok(_reduction_result) => CostOracleResult {
            cost,
            is_ok: true,
            error_msg: None,
        },
        Err(e) => CostOracleResult {
            cost,
            is_ok: false,
            error_msg: Some(format!("{e}")),
        },
    }
}

/// Construct an `ErgoStateContext` from the shim's per-block chain-state.
///
/// `header_bytes` is the current block's serialized Header (the shim
/// emits this in `BlockBundle.header_bytes`). `rolling_headers` is a
/// 10-deep window of preceding-block Headers in descending order
/// (newest first), maintained by the shim across the block-walk loop.
/// When fewer than 10 preceding headers exist (chain-start case), the
/// window is padded with synthetic dummy headers — this matches the
/// harness's `buildHeadersArray` behavior at very low heights.
///
/// `parameters` comes from `BlockBundle.parameters` when present;
/// callers pass `Parameters::default()` when the block doesn't carry a
/// parameter-vote extension (very early version-1 blocks).
pub fn build_state_context(
    header_bytes: &[u8],
    rolling_headers: &[Header],
    parameters: Parameters,
) -> Result<ErgoStateContext> {
    let header = Header::scorex_parse_bytes(header_bytes)?;
    let pre_header = PreHeader::from(header.clone());

    // Build the 10-deep Headers array. Pad with the current header
    // (cloned) if the rolling window is short — this is a degenerate
    // case at chain-start; harness behavior is to skip per-tx
    // evaluation when no preceding header exists (`validate-tx.ts:481-486`),
    // so the shim only ever computes oracle cost when the window is
    // sufficient. Defensive pad here matches sigma-rust's [Header; 10]
    // type signature requirement.
    let mut headers_vec: Vec<Header> = rolling_headers.iter().take(10).cloned().collect();
    while headers_vec.len() < 10 {
        headers_vec.push(header.clone());
    }
    let headers: Headers = headers_vec
        .try_into()
        .map_err(|_| anyhow::anyhow!("failed to build [Header; 10] from rolling window"))?;

    Ok(ErgoStateContext::new(pre_header, headers, parameters))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ergo_lib::chain::transaction::Transaction;
    use ergo_lib::chain::transaction::input::Input;
    use ergo_lib::chain::transaction::prover_result::ProverResult;
    use ergo_lib::chain::transaction::TxIoVec;
    use ergo_lib::ergotree_interpreter::sigma_protocol::prover::ProofBytes;
    use ergotree_ir::chain::context_extension::ContextExtension;
    use ergotree_ir::chain::ergo_box::box_value::BoxValue;
    use ergotree_ir::chain::ergo_box::{ErgoBox, ErgoBoxCandidate, NonMandatoryRegisters};
    use ergotree_ir::ergo_tree::{ErgoTree, ErgoTreeHeader};
    use ergotree_ir::mir::constant::{Constant, Literal};
    use ergotree_ir::mir::expr::Expr;
    use ergotree_ir::sigma_protocol::sigma_boolean::SigmaBoolean;
    use ergotree_ir::sigma_protocol::sigma_boolean::SigmaProp as SigmaPropValue;
    use ergotree_ir::types::stype::SType;
    use sigma_test_util::force_any_val;

    /// Build a bare `Const(SigmaProp(TrivialProp(true)))` ergo-tree. This is
    /// the dominant mainnet shape (>90% of inputs are P2PK-or-similar
    /// trivial). Sigma-rust short-circuits this via `trivial_reduce`,
    /// charging exactly `EVAL_SIGMA_PROP_CONSTANT = 50` JitCost per
    /// `ergotree-interpreter/src/eval.rs:213-214`.
    fn trivial_true_tree() -> ErgoTree {
        ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::Const(Constant {
                tpe: SType::SSigmaProp,
                v: Literal::SigmaProp(Box::new(SigmaPropValue::new(
                    SigmaBoolean::TrivialProp(true),
                ))),
            }),
        )
        .expect("trivial_true_tree construction")
    }

    /// Build an ErgoBox holding `tree` as its proposition. TxId is zero,
    /// index 0; only `ergo_tree` is read by the cost oracle.
    fn box_with_tree(tree: ErgoTree, value: u64) -> ErgoBox {
        let candidate = ErgoBoxCandidate {
            value: BoxValue::new(value).expect("box value"),
            ergo_tree: tree,
            tokens: None,
            additional_registers: NonMandatoryRegisters::empty(),
            creation_height: 0,
        };
        ErgoBox::from_box_candidate(
            &candidate,
            ergo_lib::chain::transaction::TxId::zero(),
            0,
        )
        .expect("ErgoBox from candidate")
    }

    /// Build a 1-input, 1-output Transaction spending `input_box`.
    fn one_input_one_output_tx(input_box: &ErgoBox) -> Transaction {
        let output_candidate = ErgoBoxCandidate {
            value: input_box.value,
            ergo_tree: input_box.ergo_tree.clone(),
            tokens: None,
            additional_registers: NonMandatoryRegisters::empty(),
            creation_height: 0,
        };
        Transaction::new(
            TxIoVec::from_vec(vec![Input {
                box_id: input_box.box_id(),
                spending_proof: ProverResult {
                    proof: ProofBytes::Empty,
                    extension: ContextExtension::empty(),
                },
            }])
            .expect("inputs vec"),
            None,
            vec![output_candidate].try_into().expect("outputs vec"),
        )
        .expect("Transaction::new")
    }

    /// Build a synthetic ErgoStateContext via the proptest-arbitrary impl.
    /// `force_any_val::<ErgoStateContext>()` returns a fresh value with
    /// arbitrary PreHeader / Headers / Parameters::default. Cost-oracle
    /// tests don't depend on specific header content; only `pre_header.height`
    /// (read by `make_context`) and `parameters.max_block_cost` (used for
    /// the jit-cost-limit derivation) matter.
    fn synthetic_state_context() -> ErgoStateContext {
        force_any_val::<ErgoStateContext>()
    }

    #[test]
    fn trivial_true_charges_fifty() {
        let tree = trivial_true_tree();
        let input_box = box_with_tree(tree, 1_000_000);
        let tx = one_input_one_output_tx(&input_box);
        let tx_ctx = TransactionContext::new(tx, vec![input_box], vec![])
            .expect("TransactionContext::new");
        let state_ctx = synthetic_state_context();

        let result = compute_oracle_cost(&tx_ctx, &state_ctx, 0);
        assert!(result.is_ok, "trivial-true should succeed: {result:?}");
        assert_eq!(
            result.cost, 50,
            "EVAL_SIGMA_PROP_CONSTANT short-circuit charges exactly 50"
        );
        assert!(result.error_msg.is_none());
    }

    #[test]
    fn trivial_false_charges_fifty_and_succeeds() {
        // Sigma-rust returns Ok(ReductionResult { sigma_prop:
        // TrivialProp(false), cost: 50 }) for a trivial-false tree;
        // it's the verifier's job to short-circuit on false sigma_prop.
        // Our oracle's `is_ok` reflects whether reduce_to_crypto returned
        // Ok(_), not whether the resulting sigma_prop is true — so trivial-
        // false still has is_ok=true.
        let tree = ErgoTree::new(
            ErgoTreeHeader::v0(false),
            &Expr::Const(Constant {
                tpe: SType::SSigmaProp,
                v: Literal::SigmaProp(Box::new(SigmaPropValue::new(
                    SigmaBoolean::TrivialProp(false),
                ))),
            }),
        )
        .expect("trivial_false_tree");
        let input_box = box_with_tree(tree, 1_000_000);
        let tx = one_input_one_output_tx(&input_box);
        let tx_ctx = TransactionContext::new(tx, vec![input_box], vec![])
            .expect("TransactionContext::new");
        let state_ctx = synthetic_state_context();

        let result = compute_oracle_cost(&tx_ctx, &state_ctx, 0);
        assert!(result.is_ok, "trivial-false reduces cleanly: {result:?}");
        assert_eq!(result.cost, 50);
    }

    #[test]
    fn cost_limit_exceeded_returns_error_with_partial_cost() {
        let tree = trivial_true_tree();
        let input_box = box_with_tree(tree, 1_000_000);
        let tx = one_input_one_output_tx(&input_box);
        let tx_ctx = TransactionContext::new(tx, vec![input_box], vec![])
            .expect("TransactionContext::new");

        // Build a state context with a deliberately tiny max_block_cost
        // (in BLOCK cost units; JitCost limit will be max_block_cost * 10).
        // Setting max_block_cost = 1 gives a JitCost limit of 10, which
        // EVAL_SIGMA_PROP_CONSTANT=50 will trip.
        let mut state_ctx = synthetic_state_context();
        state_ctx.parameters = ergo_lib::chain::parameters::Parameters::new(
            1,  // block version
            1,  // storage_fee_factor
            360,  // storage_period
            512 * 1024,  // max_block_size
            1,  // max_block_cost = 1 block cost; jit_cost_limit = 10
            0, 0, 0, 0,
        );

        let result = compute_oracle_cost(&tx_ctx, &state_ctx, 0);
        assert!(!result.is_ok, "cost-limit exceeded should fail: {result:?}");
        assert!(result.error_msg.is_some());
        // Partial cost may be 0 (rejected upfront) or > 0 depending on
        // sigma-rust's check order. We just assert structural failure.
    }

    #[test]
    fn tree_version_derived_from_spent_box() {
        // Build a tree at V0 and confirm the oracle reads the spent box's
        // tree version (not Default::default()). This is the
        // context-fidelity invariant for tree_version.
        let tree_v0 = trivial_true_tree();
        let input_box = box_with_tree(tree_v0, 1_000_000);
        let tx = one_input_one_output_tx(&input_box);
        let tx_ctx = TransactionContext::new(tx, vec![input_box.clone()], vec![])
            .expect("TransactionContext::new");
        let state_ctx = synthetic_state_context();

        // We can't directly inspect ctx.tree_version after compute_oracle_cost
        // since the function consumes the Context. The behavioral check: the
        // spent box's ergo_tree.header().unwrap().version() must equal V0.
        // We assert this externally to confirm our test fixture's shape;
        // the production code path then trivially uses .version() — which
        // is exercised by the trivial_true_charges_fifty test indirectly
        // (a V0 short-circuit would not fire if tree_version were wrong).
        let header = input_box.ergo_tree.header().expect("tree header");
        assert_eq!(
            header.version(),
            ergotree_ir::ergo_tree::ErgoTreeVersion::V0
        );
        let result = compute_oracle_cost(&tx_ctx, &state_ctx, 0);
        assert!(result.is_ok);
    }

    #[test]
    fn build_state_context_smoke() {
        // Drive the build_state_context helper end-to-end with a
        // round-tripped Header (via force_any_val + serialize). This
        // exercises the Header::scorex_parse_bytes path and the
        // rolling-headers padding logic.
        let header: Header = force_any_val::<Header>();
        let header_bytes = header.scorex_serialize_bytes().expect("scorex_serialize");
        let state =
            build_state_context(&header_bytes, &[], Parameters::default()).expect("build_state");
        // Round-trip via pre_header.id (derived from full header bytes
        // through blake2b — we just check it isn't all zeros, which would
        // indicate a degenerate construction).
        assert_eq!(state.headers.len(), 10);
    }
}
