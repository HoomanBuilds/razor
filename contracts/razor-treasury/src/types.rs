use near_sdk::{
    AccountId,
    json_types::{U64, U128},
    near,
};
use std::collections::BTreeSet;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct DistributionAllocation {
    pub claim_id: String,
    pub recipient_id: String,
    pub recipient_version: U64,
    pub amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ClaimStatus {
    Ready,
    Pending,
    Paid,
    Reclaimed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct DistributionClaim {
    pub allocation: DistributionAllocation,
    pub destination: AccountId,
    pub status: ClaimStatus,
    pub nonce: U64,
    pub sent_day: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DistributionStatus {
    Proposed,
    Active,
    Complete,
    Closed,
    Cancelled,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Distribution {
    pub id: String,
    pub reference: String,
    pub network: String,
    pub token_contract: AccountId,
    pub deadline_ms: U64,
    pub total: U128,
    pub unclaimed: U128,
    pub pending: U128,
    pub paid: U128,
    pub reclaimed: U128,
    pub policy_version: U64,
    pub terms_hash: String,
    pub required_approvals: u8,
    pub approvals: BTreeSet<AccountId>,
    pub status: DistributionStatus,
    pub claims: Vec<DistributionClaim>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct ApprovalTier {
    pub up_to: U128,
    pub required_approvals: u8,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Destination {
    pub asset_id: String,
    pub network: String,
    pub address: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Recipient {
    pub id: String,
    pub primary: Destination,
    pub backup: Option<Destination>,
    pub backup_consent: bool,
    pub active: bool,
    pub version: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RouteKind {
    Direct,
    Intents,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Route {
    pub kind: RouteKind,
    pub source_receiver: AccountId,
    pub input_amount: U128,
    pub output_amount: U128,
    pub quote_id: String,
    pub quote_hash: String,
    pub deadline_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PaymentStatus {
    Proposed,
    Approved,
    InFlight,
    Retryable,
    RecoveryPending,
    Held,
    Paid,
    Cancelled,
    AwaitingApprovals,
    PartiallyPaid,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AttemptStatus {
    Prepared,
    Discarded,
    Sending,
    SourceSent,
    Uncertain,
    RefundPending,
    RefundVerifying,
    Refunded,
    TransferFailed,
    Delivered,
    PartiallyDelivered,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SettlementOutcome {
    Delivered,
    Uncertain,
    RefundPending,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Attempt {
    pub id: String,
    pub use_backup: bool,
    pub destination: Destination,
    pub route: Route,
    pub authorized: bool,
    pub approvals: BTreeSet<AccountId>,
    pub approval_policy_version: U64,
    pub status: AttemptStatus,
    pub sent_day: U64,
    pub refund_amount: U128,
    pub receipt: Option<String>,
    pub actual_output: U128,
    pub credited_amount: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub id: String,
    pub recipient_id: String,
    pub recipient_version: U64,
    pub amount: U128,
    pub max_fee: U128,
    pub incurred_cost: U128,
    pub reservation: U128,
    pub expires_at_ms: U64,
    pub not_before_ms: U64,
    pub reference: String,
    pub proposer: AccountId,
    pub approver: Option<AccountId>,
    pub approvals: BTreeSet<AccountId>,
    pub policy_version: U64,
    pub status: PaymentStatus,
    pub attempts: Vec<Attempt>,
}

#[near(serializers = [json])]
pub struct ConfigView {
    pub architecture: String,
    pub company_id: String,
    pub retained_assets_enabled: bool,
    pub max_retained_assets: u32,
    pub owner_id: AccountId,
    pub token_contract: AccountId,
    pub paused: bool,
    pub per_payment_limit: U128,
    pub daily_limit: U128,
    pub policy_version: U64,
    pub settlement_reporter: Option<AccountId>,
    pub executor_trust_daily_budget: U128,
    pub approvers: Vec<AccountId>,
    pub executors: Vec<AccountId>,
    pub approval_tiers: Vec<ApprovalTier>,
    pub approval_amount_basis: String,
}

#[near(serializers = [json])]
pub struct ApprovalStatus {
    pub policy_version: U64,
    pub approval_amount: U128,
    pub required_approvals: u8,
    pub payment_terms_hash: String,
    pub payment_approvals: Vec<AccountId>,
    pub payment_collected: u8,
    pub payment_ready: bool,
    pub attempt_id: Option<String>,
    pub attempt_terms_hash: Option<String>,
    pub attempt_approvals: Vec<AccountId>,
    pub attempt_collected: u8,
    pub attempt_ready: bool,
    pub can_execute: bool,
}

#[near(serializers = [json])]
pub struct BalanceView {
    pub balance: U128,
    pub reserved: U128,
    pub available: U128,
    pub in_flight: U128,
    pub confirmed_at_ms: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct StandingMandateTerms {
    pub id: String,
    pub recipient_id: String,
    pub recipient_version: U64,
    pub supplier_profile_hash: String,
    pub actor_id: AccountId,
    pub actor_public_key: near_sdk::PublicKey,
    pub per_payment_max_input: U128,
    pub period_max_input: U128,
    pub lifetime_max_input: U128,
    pub period_ms: U64,
    pub valid_from_ms: U64,
    pub expires_at_ms: U64,
    pub invoice_condition: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct StandingMandate {
    pub terms: StandingMandateTerms,
    pub destination: Destination,
    pub policy_version: U64,
    pub terms_hash: String,
    pub approvals: BTreeSet<AccountId>,
    pub required_approvals: u8,
    pub paused: bool,
    pub revoked: bool,
    pub period_index: U64,
    pub period_used_input: U128,
    pub lifetime_used_input: U128,
    pub pending_input: U128,
}
