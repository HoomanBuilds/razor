use near_sdk::{
    AccountId,
    json_types::{U64, U128},
    near,
};

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
    pub status: AttemptStatus,
    pub sent_day: U64,
    pub refund_amount: U128,
    pub receipt: Option<String>,
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
    pub reference: String,
    pub proposer: AccountId,
    pub approver: Option<AccountId>,
    pub policy_version: U64,
    pub status: PaymentStatus,
    pub attempts: Vec<Attempt>,
}

#[near(serializers = [json])]
pub struct ConfigView {
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
}

#[near(serializers = [json])]
pub struct BalanceView {
    pub balance: U128,
    pub reserved: U128,
    pub available: U128,
    pub in_flight: U128,
    pub confirmed_at_ms: U64,
}
