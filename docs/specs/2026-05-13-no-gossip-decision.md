# Gossip Layer — Considered and Rejected

**Status:** Decision (2026-05-13)
**Context:** Brainstorming session for the package originally planned as `@mwaddip/ergots-gossip`.

## What was considered

A WebSocket-based "gossip" layer to let browser and Node instances exchange NiPoPoW proofs and tip headers. Originally framed (in the handoff from the previous session) as replicating the *behavior* — not byte-format — of Ergo P2P, with a supernode-mediated star topology suggested.

The brainstorm explored: bridge model vs. peer cache vs. pure peer; binary wire format; code-allocation philosophy (reuse Ergo P2P codes vs. allocate fresh); proof-fetching vs. proof-fetching+tip-following scope.

## Decision: don't build it

The framing was internally inconsistent with the constraint we operate under.

## Reasoning

- **Browsers cannot be active peers.** A browser cannot accept inbound connections, cannot speak raw TCP, and cannot participate in a mesh as a server. Browser-to-browser via WebRTC is technically possible but adds its own signaling layer and provides no actual use case (browsers wanting a NiPoPoW proof want it from an authoritative source, not from another browser).
- **What browsers actually need is already exposed by existing nodes.** A NiPoPoW proof is `GET /nipopow/proof/{m}/{k}` (the user added this endpoint to `ergo-node-rust` mid-Task-15 of the verifier work). Tip headers are reachable via `/info` + `/blocks/at/{height}` + `/blocks/{id}/header`, pollable from any browser. No new wire protocol is required.
- **For lower-latency tip-following, one optional endpoint suffices.** An SSE (or similar) tip-stream endpoint on the Rust node would replace polling. That's a single endpoint, not a gossip protocol with codes, handshakes, and subscription state.
- **The eventual TS full-node, if ever built, does not have the browser constraint.** When/if a full-node-in-TS becomes a goal, it would speak JVM-compatible Ergo P2P (TCP) directly. No intermediate "browser-friendly" protocol layer is needed.

In short: P2P is deferred to a hypothetical future full-node, which won't have the browser constraint and can speak the existing JVM Ergo P2P protocol directly. The browser is a *client* of nodes, not a peer of them, and a client-side library is much smaller than a protocol.

## What replaces it

The phase plan tightens around the actual end-product: a browser that bootstraps trusted state from a NiPoPoW proof, locally verifies a transaction it constructed, and broadcasts it via any conformant Ergo node.

- ✅ **Phase 1:** `@mwaddip/ergots-proof` — DONE.
- 🆕 **Phase 2:** `@mwaddip/ergots-ergoscript` — TS ErgoTree parser + interpreter, validated byte-for-byte against `sigma-rust`'s `ergotree-interpreter` crate. Standalone-useful (tooling, simulators, DApp frontends), and the load-bearing piece for phase 3.
- 🆕 **Phase 3:** wallet / transaction-broadcaster (package naming deferred) — bootstraps state from a verified proof, builds + locally-verifies (using phase 2) + broadcasts transactions. The HTTP-client / data-fetching layer is *internal to phase 3*, not a separate package, because nothing else is planned to consume it.

The choice between "structural verification only" and "full ErgoScript execution" for phase 3 was discussed; the user chose full ErgoScript on the strength of the standalone usefulness of a TS ErgoScript library, independent of the wallet use case.

## Implications

- **No "gossip protocol" design session needed.** The protocol does not exist. HTTP + native browser WebSocket for the optional tip-stream endpoint cover everything.
- **No Rust addon required for v1.** Tip-following can be implemented with polling against existing REST endpoints. An SSE endpoint on `ergo-node-rust` would be a latency optimization, not a load-bearing dependency. If/when added, it's one endpoint, designed in isolation.
- **`@noble/curves` becomes a real runtime dependency in phase 2** (secp256k1 group operations for Sigma propositions). The proof package deliberately excluded it; the ergoscript package cannot.
- **Validation strategy extends naturally.** `fixture-gen/` already calls into sigma-rust at a pinned rev. Adding `ergotree-interpreter` fixtures (ErgoTree bytes + context + expected stack/result) follows the same byte-equality pattern that worked for the verifier.
- **Sizing for phase 2.** sigma-rust's `ergotree-interpreter` crate is tens of thousands of LOC. Porting all of it is a months-long effort. Scoping for v1 (e.g., Sigma propositions + DLOG signatures first, full VM later) is the first question of the phase-2 brainstorm.

## What could revisit this decision

Adding 2026-05-13 (same day, after-the-fact): **libp2p exists and partially refutes the "browsers can't peer" framing.** libp2p's WebRTC and WebTransport transports plus circuit-relay let browsers participate as limited peers in a libp2p mesh — inbound through a relay, NAT-traversed via signaling, with gossipsub providing a working pub/sub primitive (Ethereum consensus, IPFS, Filecoin all run on it in production). So bullet 1 of the reasoning above is too strong as written; the accurate version is "browsers can peer in libp2p, but they can't peer in *Ergo's* P2P network."

What libp2p does not change is bullet 4: libp2p is not protocol-compatible with Ergo P2P. The JVM Ergo node and `~/projects/sigma-rust/sigma-rust/ergo-p2p/` both speak the Scorex P2P protocol over TCP. A libp2p-based browser network would be a *parallel* network, not a way for browsers to talk to existing Ergo peers. "Browser-friendly Ergo P2P" via libp2p means building a libp2p ↔ Scorex bridge somewhere in the topology — a meaningful new component, not a trivial protocol re-skin.

**The decision still stands** for the current scope (bootstrap from a NiPoPoW proof + broadcast a tx via REST). What would justify revisiting:

- A use case appears that needs actual browser-to-browser behavior — e.g., a mesh of Ergo light clients sharing tip headers without trusting any single node operator, or browsers exchanging proofs directly when a central REST endpoint isn't available.
- The Ergo network grows a libp2p-speaking node tier (either by JVM-side adoption or via a parallel TS-implemented full node that picks libp2p as its native transport).
- A specific privacy or censorship-resistance requirement makes "trust a few REST endpoints" unacceptable.

None of those are visible from the wallet/light-client roadmap as currently scoped. If one becomes load-bearing later, the work is "design a libp2p ↔ Ergo P2P bridge + a thin browser libp2p client," not "design our own gossip protocol from scratch."

## Process lesson

The gossip framing came from a handoff that committed to a phase structure. This brainstorm initially designed *within* that framing for several turns before the user broke the spell ("i'm wondering if we're not massively overthinking this"). The right first question would have been "is this framing right?" before "how do we build within it?" Captured as memory `feedback-question-framing-first`.

## References

- `facts/proof.md` — verifier interface contract
- `docs/specs/2026-05-12-nipopow-proof-verifier-design.md` — verifier design rationale (the template phase 2's spec will follow)
- `~/projects/sigma-rust/sigma-rust/` (branch `integration/ergots`, HEAD `ed5452cf` — composition of `ergo-node-integration` cost-parity fixes + upstream PR #862's compiler conformance and Significant-15 corpus, merged 2026-05-13) — reference implementation for the upcoming `ergots-ergoscript` work
