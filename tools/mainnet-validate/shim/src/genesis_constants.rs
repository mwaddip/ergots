//! Genesis-state box construction constants.
//!
//! These are COPIED from ergo-node-rust/src/main.rs (lines cited in each
//! block's SOURCE comment). The constants live in the binary crate there,
//! not exposed via lib.rs — path-dep is impossible. Copying with source
//! citations is the only viable path; lifecycle is low (constants change
//! only at chain-genesis-rewrite events, never on production).
//!
//! Decision 6 in `docs/specs/2026-05-22-mainnet-validate-fix-2-genesis-
//! box-seeding-design.md` adds a defensive expected-box-id assertion at
//! shim startup to catch any drift loudly.

// SOURCE: ergo-node-rust/src/main.rs:32-39
/// Testnet no-premine proof strings (UTF-8, stored in R4-R8).
pub const TESTNET_NO_PREMINE_PROOFS: &[&str] = &[
    "'Chaos reigns': what the papers say about the no-deal Brexit vote",
    "\u{4e60}\u{8fd1}\u{5e73}\u{7684}\u{4e24}\u{4f1a}\u{65f6}\u{95f4}|\u{8fd9}\u{91cc}\u{6709}\u{4efd}\u{4e60}\u{8fd1}\u{5e73}\u{4e24}\u{4f1a}\u{65e5}\u{5386}\u{ff0c}\u{8bf7}\u{67e5}\u{6536}\u{ff01}",
    "\u{0422}\u{0410}\u{0421}\u{0421} \u{0441}\u{043e}\u{043e}\u{0431}\u{0449}\u{0438}\u{043b} \u{043e}\u{0431} \u{043e}\u{0431}\u{043d}\u{0430}\u{0440}\u{0443}\u{0436}\u{0435}\u{043d}\u{0438}\u{0438} \u{043d}\u{0435}\u{0441}\u{043a}\u{043e}\u{043b}\u{044c}\u{043a}\u{0438}\u{0445} \u{043c}\u{0430}\u{0439}\u{043d}\u{0438}\u{043d}\u{0433}\u{043e}\u{0432}\u{044b}\u{0445} \u{0444}\u{0435}\u{0440}\u{043c} \u{043d}\u{0430} \u{0441}\u{0442}\u{043e}\u{043b}\u{0438}\u{0447}\u{043d}\u{044b}\u{0445} \u{0440}\u{044b}\u{043d}\u{043a}\u{0430}\u{0445}",
    "000000000000000000139a3e61bd5721827b51a5309a8bfeca0b8c4b5c060931",
    "0xef1d584d77e74e3c509de625dc17893b22b73d040b5d5302bbf832065f928d03",
];

// SOURCE: ergo-node-rust/src/main.rs:41-49
/// Mainnet no-premine proof strings (UTF-8, stored in R4-R8).
/// Source: JVM mainnet.conf:24-30 (July 2019 headlines + block hashes).
pub const MAINNET_NO_PREMINE_PROOFS: &[&str] = &[
    "00000000000000000014c2e2e7e33d51ae7e66f6ccb6942c3437127b36c33747",
    "0xd07a97293468d9132c5a2adab2e52a23009e6798608e47b0d2623c7e3e923463",
    "Brexit: both Tory sides play down risk of no-deal after business alarm",
    "\u{8ff0}\u{8bc4}\u{ff1a}\u{5e73}\u{8861}\u{3001}\u{6301}\u{7eed}\u{3001}\u{5305}\u{5bb9}\u{2014}\u{2014}\u{65b0}\u{65f6}\u{4ee3}\u{5e94}\u{5bf9}\u{5168}\u{7403}\u{5316}\u{6311}\u{6218}\u{7684}\u{4e2d}\u{56fd}\u{4e4b}\u{9053}",
    "\u{0414}\u{0438}\u{0432}\u{0438}\u{0434}\u{0435}\u{043d}\u{0434}\u{044b} \u{0427}\u{0422}\u{041f}\u{0417} \u{0432}\u{044b}\u{0440}\u{0430}\u{0441}\u{0442}\u{0443}\u{0442} \u{043d}\u{0430} 33% \u{043d}\u{0430} \u{0430}\u{043a}\u{0446}\u{0438}\u{044e}",
];

// SOURCE: ergo-node-rust/src/main.rs:51-57
/// Founders' public keys (hex-encoded compressed EC points).
/// Shared between mainnet and testnet. Source: JVM application.conf:209-213.
pub const FOUNDERS_PKS: &[&str] = &[
    "039bb5fe52359a64c99a60fd944fc5e388cbdc4d37ff091cc841c3ee79060b8647",
    "031fb52cf6e805f80d97cde289f4f757d49accf0c83fb864b27d2cf982c37f9a8b",
    "0352ac2a471339b0d23b3d2c5ce0db0e81c969f77891b9edf0bda7fd39a78184e7",
];

/// Network selection for genesis-box seeding. Self-contained 2-variant
/// enum so we don't pull in enr-p2p just for the type.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum Network {
    Mainnet,
    Testnet,
}

impl Network {
    /// Network-specific no-premine proof strings stored in R4-R8 of the
    /// no_premine genesis box. Used to compute the network-specific
    /// no_premine box id.
    pub fn no_premine_proofs(&self) -> &'static [&'static str] {
        match self {
            Network::Mainnet => MAINNET_NO_PREMINE_PROOFS,
            Network::Testnet => TESTNET_NO_PREMINE_PROOFS,
        }
    }

    /// Parse from CLI flag value. Used by the shim's --network arg.
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "mainnet" => Some(Network::Mainnet),
            "testnet" => Some(Network::Testnet),
            _ => None,
        }
    }
}
