#[path = "distributions.rs"]
mod distributions;
#[path = "partial.rs"]
mod partial;
#[path = "retained.rs"]
mod retained;
#[path = "standing.rs"]
mod standing;
use crate::{ext_self, types::*};
pub use retained::{RetainedAsset, RetainedWithdrawal, RetainedWithdrawalStatus};

use near_sdk::{
    AccountId, Gas, NearToken, Promise, PromiseError, PromiseOrValue, env, ext_contract,
    json_types::{U64, U128},
    near, require,
    serde_json::json,
    store::IterableMap,
};
use std::collections::BTreeSet;

const DAY_MS: u64 = 86_400_000;
const GAS_TRANSFER: Gas = Gas::from_tgas(20);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const GAS_BALANCE: Gas = Gas::from_tgas(5);
const MAX_ATTEMPTS: usize = 10;
const MAX_APPROVAL_TIERS: usize = 8;
const MAX_REQUIRED_APPROVALS: u8 = 8;
const MAX_APPROVERS: usize = 16;

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[near(serializers = [borsh])]
pub(crate) struct CompanyTreasury {
    pub(crate) company_id: String,
    pub(crate) pool_epoch: u64,
    pub(crate) storage_credit: u128,
    pub(crate) storage_used: u128,
    pub(crate) next_withdrawal: u64,
    pub(crate) withdrawals: IterableMap<u64, (U128, bool)>,
    pub(crate) retained_assets: IterableMap<AccountId, RetainedAsset>,
    pub(crate) next_retained_withdrawal: u64,
    pub(crate) owner_id: AccountId,
    pub(crate) token_contract: AccountId,
    pub(crate) paused: bool,
    pub(crate) per_payment_limit: u128,
    pub(crate) daily_limit: u128,
    pub(crate) policy_version: u64,
    pub(crate) approval_tiers: Vec<ApprovalTier>,
    pub(crate) approvers: BTreeSet<AccountId>,
    pub(crate) executors: BTreeSet<AccountId>,
    pub(crate) settlement_reporter: Option<AccountId>,
    pub(crate) backup_assets: IterableMap<String, String>,
    pub(crate) balance: u128,
    pub(crate) reserved: u128,
    pub(crate) in_flight: u128,
    pub(crate) unsettled_payments: u64,
    pub(crate) balance_epoch: u64,
    pub(crate) confirmed_at_ms: u64,
    pub(crate) recipients: IterableMap<String, Recipient>,
    pub(crate) payments: IterableMap<String, Payment>,
    pub(crate) obligations: IterableMap<String, String>,
    pub(crate) spent_by_day: IterableMap<u64, u128>,
    pub(crate) standing_mandates: IterableMap<String, StandingMandate>,
    pub(crate) standing_payments: IterableMap<String, String>,
    pub(crate) recipient_activation: IterableMap<String, U64>,
    pub(crate) distributions: IterableMap<String, Distribution>,
    pub(crate) void_distributions: IterableMap<String, bool>,
    pub(crate) partial_receipts: IterableMap<String, String>,
}

impl CompanyTreasury {
    pub fn new(
        company_id: String,
        owner_id: AccountId,
        token_contract: AccountId,
        per_payment_limit: U128,
        daily_limit: U128,
    ) -> Self {
        require!(
            owner_id != env::current_account_id(),
            "OWNER_MUST_BE_RECOVERABLE"
        );
        require!(
            per_payment_limit.0 > 0 && daily_limit.0 >= per_payment_limit.0,
            "INVALID_LIMITS"
        );
        let company_prefix = env::sha256(company_id.as_bytes());
        let prefix = |tag: u8| {
            let mut bytes = company_prefix.clone();
            bytes.push(tag);
            bytes
        };
        let mut backup_assets = IterableMap::new(prefix(b'b'));
        backup_assets.insert("near".into(), format!("nep141:{token_contract}"));
        Self {
            company_id: company_id.clone(),
            pool_epoch: 0,
            storage_credit: 0,
            storage_used: 0,
            next_withdrawal: 0,
            withdrawals: IterableMap::new(prefix(b'w')),
            retained_assets: IterableMap::new(prefix(b'h')),
            next_retained_withdrawal: 0,
            owner_id,
            token_contract,
            paused: false,
            per_payment_limit: per_payment_limit.0,
            daily_limit: daily_limit.0,
            policy_version: 1,
            approval_tiers: vec![ApprovalTier {
                up_to: daily_limit,
                required_approvals: 1,
            }],
            approvers: BTreeSet::new(),
            executors: BTreeSet::new(),
            settlement_reporter: None,
            backup_assets,
            balance: 0,
            reserved: 0,
            in_flight: 0,
            unsettled_payments: 0,
            balance_epoch: 0,
            confirmed_at_ms: 0,
            recipients: IterableMap::new(prefix(b'r')),
            payments: IterableMap::new(prefix(b'p')),
            obligations: IterableMap::new(prefix(b'o')),
            spent_by_day: IterableMap::new(prefix(b'd')),
            standing_mandates: IterableMap::new(prefix(b'm')),
            standing_payments: IterableMap::new(prefix(b'n')),
            recipient_activation: IterableMap::new(prefix(b'c')),
            distributions: IterableMap::new(prefix(b'e')),
            void_distributions: IterableMap::new(prefix(b'g')),
            partial_receipts: IterableMap::new(prefix(b't')),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            architecture: "shared_v1".into(),
            company_id: self.company_id.clone(),
            retained_assets_enabled: true,
            max_retained_assets: retained::MAX_RETAINED_ASSETS,
            owner_id: self.owner_id.clone(),
            token_contract: self.token_contract.clone(),
            paused: self.paused,
            per_payment_limit: U128(self.per_payment_limit),
            daily_limit: U128(self.daily_limit),
            policy_version: U64(self.policy_version),
            settlement_reporter: self.settlement_reporter.clone(),
            executor_trust_daily_budget: U128(0),
            approvers: self.approvers.iter().cloned().collect(),
            executors: self.executors.iter().cloned().collect(),
            approval_tiers: self.approval_tiers.clone(),
            approval_amount_basis: "principal_plus_max_fee".into(),
        }
    }

    pub fn get_balance(&self) -> BalanceView {
        BalanceView {
            balance: U128(self.balance),
            reserved: U128(self.reserved),
            available: U128(self.balance.saturating_sub(self.reserved)),
            in_flight: U128(self.in_flight),
            confirmed_at_ms: U64(self.confirmed_at_ms),
        }
    }

    pub fn get_payment(&self, payment_id: String) -> Option<Payment> {
        self.payments.get(&payment_id).cloned()
    }
    pub fn get_recipient(&self, recipient_id: String) -> Option<Recipient> {
        self.recipients.get(&recipient_id).cloned()
    }
    pub fn get_attempt(&self, payment_id: String, attempt_id: String) -> Option<Attempt> {
        self.payments.get(&payment_id).and_then(|payment| {
            payment
                .attempts
                .iter()
                .find(|attempt| attempt.id == attempt_id)
                .cloned()
        })
    }
    pub fn get_approval_status(
        &self,
        payment_id: String,
        attempt_id: Option<String>,
    ) -> ApprovalStatus {
        let payment = self.load_payment(&payment_id);
        let attempt = attempt_id
            .as_ref()
            .and_then(|id| payment.attempts.iter().find(|attempt| &attempt.id == id))
            .or_else(|| {
                if attempt_id.is_none() {
                    payment.attempts.last()
                } else {
                    None
                }
            });
        self.approval_status(&payment, attempt)
    }
    pub fn get_obligation(&self, reference: String) -> Option<String> {
        self.obligations.get(&reference).cloned()
    }
    pub fn get_backup_asset(&self, network: String) -> Option<String> {
        self.backup_assets.get(&network).cloned()
    }
    pub fn list_payments(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Payment> {
        self.payments
            .values()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(25).min(100) as usize)
            .cloned()
            .collect()
    }
    pub fn get_daily_spend(&self, day: U64) -> U128 {
        U128(*self.spent_by_day.get(&day.0).unwrap_or(&0))
    }

    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        self.emit("pause_changed", json!({"paused": paused}));
    }

    pub fn set_policy(&mut self, per_payment_limit: U128, daily_limit: U128) {
        self.assert_owner();
        require!(
            per_payment_limit.0 > 0 && daily_limit.0 >= per_payment_limit.0,
            "INVALID_LIMITS"
        );
        self.per_payment_limit = per_payment_limit.0;
        self.daily_limit = daily_limit.0;
        if let Some(tier) = self.approval_tiers.last_mut() {
            if tier.up_to.0 < daily_limit.0 {
                tier.up_to = daily_limit;
            }
        }
        self.policy_version = self
            .policy_version
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        self.emit(
            "policy_changed",
            json!({"version": U64(self.policy_version)}),
        );
    }

    pub fn set_approval_policy(&mut self, tiers: Vec<ApprovalTier>, expected_policy_version: U64) {
        self.assert_owner();
        require!(
            expected_policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(
            !tiers.is_empty() && tiers.len() <= MAX_APPROVAL_TIERS,
            "INVALID_APPROVAL_TIERS"
        );
        let eligible = self
            .approvers
            .iter()
            .filter(|account| *account != &self.owner_id)
            .count()
            + 1;
        let mut previous_amount = 0u128;
        let mut previous_required = 1u8;
        for tier in &tiers {
            require!(
                tier.up_to.0 > previous_amount,
                "APPROVAL_TIERS_NOT_ASCENDING"
            );
            require!(
                tier.required_approvals >= previous_required
                    && tier.required_approvals <= MAX_REQUIRED_APPROVALS,
                "INVALID_APPROVAL_QUORUM"
            );
            require!(
                tier.required_approvals as usize <= eligible,
                "INSUFFICIENT_APPROVER_ACCOUNTS"
            );
            previous_amount = tier.up_to.0;
            previous_required = tier.required_approvals;
        }
        require!(
            previous_amount >= self.daily_limit,
            "APPROVAL_TIERS_MUST_COVER_DAILY_LIMIT"
        );
        self.approval_tiers = tiers;
        self.policy_version = self
            .policy_version
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        self.emit(
            "approval_policy_changed",
            json!({"policy_version": U64(self.policy_version), "tiers": self.approval_tiers, "amount_basis": "principal_plus_max_fee"}),
        );
    }

    pub fn set_role(&mut self, account_id: AccountId, role: String, enabled: bool) {
        self.assert_owner();
        require!(
            account_id != env::current_account_id(),
            "INVALID_ROLE_ACCOUNT"
        );
        let set = match role.as_str() {
            "approver" => &mut self.approvers,
            "executor" => &mut self.executors,
            _ => env::panic_str("INVALID_ROLE"),
        };
        if role == "approver" && enabled && !set.contains(&account_id) {
            require!(set.len() < MAX_APPROVERS, "APPROVER_LIMIT");
        }
        let changed = if enabled {
            set.insert(account_id.clone())
        } else {
            set.remove(&account_id)
        };
        if role == "approver" && changed {
            self.policy_version = self
                .policy_version
                .checked_add(1)
                .expect("VERSION_OVERFLOW");
        }
        self.emit(
            "role_changed",
            json!({"account_id": account_id, "role": role, "enabled": enabled, "policy_version": U64(self.policy_version)}),
        );
    }

    pub fn set_settlement_reporter(&mut self, account_id: Option<AccountId>) {
        self.assert_owner();
        self.settlement_reporter = account_id.clone();
        self.emit(
            "settlement_reporter_changed",
            json!({"account_id": account_id}),
        );
    }

    pub fn transfer_ownership(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        require!(self.paused, "OWNER_TRANSFER_REQUIRES_PAUSE");
        require!(self.in_flight == 0, "OWNER_TRANSFER_SOURCE_PENDING");
        require!(
            self.unsettled_payments == 0,
            "OWNER_TRANSFER_SETTLEMENT_PENDING"
        );
        require!(
            self.retained_assets
                .values()
                .all(|asset| asset.in_flight.0 == 0),
            "OWNER_TRANSFER_RETAINED_PENDING"
        );
        require!(
            new_owner_id != env::current_account_id(),
            "OWNER_MUST_BE_RECOVERABLE"
        );
        let available = self
            .approvers
            .iter()
            .filter(|account| *account != &new_owner_id)
            .count()
            + 1;
        require!(
            self.approval_tiers
                .iter()
                .all(|tier| tier.required_approvals as usize <= available),
            "OWNER_TRANSFER_QUORUM_UNREACHABLE"
        );
        self.owner_id = new_owner_id.clone();
        self.policy_version = self
            .policy_version
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        self.emit("owner_changed", json!({"owner_id": new_owner_id}));
    }

    pub fn set_backup_asset(&mut self, network: String, asset_id: Option<String>) {
        self.assert_owner();
        require!(
            matches!(
                network.as_str(),
                "near"
                    | "base"
                    | "arb"
                    | "arbitrum"
                    | "pol"
                    | "polygon"
                    | "sol"
                    | "solana"
                    | "eth"
                    | "ethereum"
            ),
            "BACKUP_NETWORK_NOT_ALLOWED"
        );
        if let Some(asset) = &asset_id {
            require!(!asset.is_empty() && asset.len() <= 256, "INVALID_ASSET");
            self.backup_assets.insert(network.clone(), asset.clone());
        } else {
            self.backup_assets.remove(&network);
        }
        self.policy_version = self
            .policy_version
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        self.emit(
            "backup_asset_changed",
            json!({"network": network, "asset_id": asset_id}),
        );
    }

    pub fn set_recipient(
        &mut self,
        recipient_id: String,
        primary: Destination,
        backup: Option<Destination>,
        backup_consent: bool,
        active: bool,
    ) -> Recipient {
        self.assert_owner();
        validate_id(&recipient_id);
        validate_destination(&primary);
        if let Some(destination) = &backup {
            validate_destination(destination);
            require!(destination != &primary, "DUPLICATE_BACKUP");
            require!(
                self.backup_assets.get(&destination.network) == Some(&destination.asset_id),
                "BACKUP_USDC_NOT_CONFIGURED"
            );
        }
        require!(
            !backup_consent || backup.is_some(),
            "BACKUP_DESTINATION_REQUIRED"
        );
        let version = self
            .recipients
            .get(&recipient_id)
            .map_or(1, |r| r.version.0.checked_add(1).expect("VERSION_OVERFLOW"));
        let recipient = Recipient {
            id: recipient_id.clone(),
            primary,
            backup,
            backup_consent,
            active,
            version: U64(version),
        };
        let activates_at = U64(now_ms().checked_add(DAY_MS).expect("TIME_OVERFLOW"));
        self.recipient_activation
            .insert(recipient_id.clone(), activates_at);
        self.recipients
            .insert(recipient_id.clone(), recipient.clone());
        self.emit(
            "recipient_changed",
            json!({"recipient_id": recipient_id, "version": U64(version), "standing_activates_at_ms": activates_at}),
        );
        recipient
    }

    pub fn propose_payment(
        &mut self,
        payment_id: String,
        recipient_id: String,
        amount: U128,
        max_fee: U128,
        expires_at_ms: U64,
        reference: String,
        not_before_ms: Option<U64>,
    ) -> Payment {
        self.assert_executor();
        require!(!self.paused, "PAUSED");
        validate_id(&payment_id);
        validate_id(&reference);
        require!(!self.payments.contains_key(&payment_id), "PAYMENT_EXISTS");
        require!(
            !self.obligations.contains_key(&reference),
            "OBLIGATION_EXISTS"
        );
        require!(
            amount.0 > 0 && amount.0 <= self.per_payment_limit,
            "PAYMENT_LIMIT"
        );
        let total = add(amount.0, max_fee.0);
        require!(total <= self.daily_limit, "DAILY_LIMIT");
        require!(expires_at_ms.0 > now_ms(), "PAYMENT_EXPIRED");
        let not_before_ms = not_before_ms.unwrap_or(U64(0));
        require!(not_before_ms.0 < expires_at_ms.0, "INVALID_SCHEDULE");
        let recipient = self
            .recipients
            .get(&recipient_id)
            .expect("RECIPIENT_NOT_FOUND");
        require!(recipient.active, "RECIPIENT_INACTIVE");
        let payment = Payment {
            id: payment_id.clone(),
            recipient_id,
            recipient_version: recipient.version,
            amount,
            max_fee,
            incurred_cost: U128(0),
            reservation: U128(0),
            expires_at_ms,
            not_before_ms,
            reference: reference.clone(),
            proposer: env::predecessor_account_id(),
            approver: None,
            approvals: BTreeSet::new(),
            policy_version: U64(self.policy_version),
            status: PaymentStatus::Proposed,
            attempts: Vec::new(),
        };
        self.obligations.insert(reference, payment_id.clone());
        self.payments.insert(payment_id.clone(), payment.clone());
        self.emit(
            "payment_proposed",
            json!({"payment_id": payment_id, "amount": amount, "max_fee": max_fee}),
        );
        payment
    }

    pub fn approve_payment(
        &mut self,
        payment_id: String,
        expected_policy_version: U64,
        expected_terms_hash: String,
    ) -> Payment {
        self.assert_approver();
        require!(!self.paused, "PAUSED");
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Proposed
                    | PaymentStatus::AwaitingApprovals
                    | PaymentStatus::Held
                    | PaymentStatus::Approved
                    | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_APPROVABLE"
        );
        self.assert_current(&payment);
        require!(
            expected_policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(
            expected_terms_hash == self.payment_terms_hash(&payment),
            "APPROVAL_TERMS_CHANGED"
        );
        require!(
            payment.incurred_cost.0 <= payment.max_fee.0,
            "FEE_LIMIT_EXHAUSTED"
        );
        require!(payment.amount.0 <= self.per_payment_limit, "PAYMENT_LIMIT");
        require!(
            add(payment.amount.0, payment.max_fee.0) <= self.daily_limit,
            "DAILY_LIMIT"
        );
        if payment.policy_version.0 != self.policy_version {
            payment.approvals.clear();
            for attempt in &mut payment.attempts {
                if attempt.status == AttemptStatus::Prepared {
                    attempt.approvals.clear();
                    attempt.authorized = false;
                    attempt.approval_policy_version = U64(self.policy_version);
                }
            }
        }
        payment.policy_version = U64(self.policy_version);
        let caller = env::predecessor_account_id();
        payment.approvals.insert(caller.clone());
        payment.approver = Some(caller.clone());
        let required = self.required_approvals(&payment);
        let collected = self.payment_approvals(&payment).len();
        if collected >= required as usize {
            let reservation = add(payment.amount.0, payment.max_fee.0) - payment.incurred_cost.0;
            let new_reserved = add(self.reserved - payment.reservation.0, reservation);
            require!(self.balance >= new_reserved, "INSUFFICIENT_CONFIRMED_FUNDS");
            self.reserved = new_reserved;
            payment.reservation = U128(reservation);
            payment.status = PaymentStatus::Approved;
        } else {
            payment.status = PaymentStatus::AwaitingApprovals;
        }
        self.payments.insert(payment_id.clone(), payment.clone());
        self.emit(
            "payment_approved",
            json!({"payment_id": payment_id, "reservation": payment.reservation, "approver": caller, "required_approvals": required, "collected_approvals": collected, "policy_version": expected_policy_version, "terms_hash": expected_terms_hash}),
        );
        payment
    }

    pub fn create_attempt(
        &mut self,
        payment_id: String,
        attempt_id: String,
        use_backup: bool,
        route: Route,
    ) -> Payment {
        self.assert_executor();
        require!(!self.paused, "PAUSED");
        validate_id(&attempt_id);
        let mut payment = self.load_payment(&payment_id);
        self.assert_current(&payment);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Proposed
                    | PaymentStatus::AwaitingApprovals
                    | PaymentStatus::Approved
                    | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_READY"
        );
        require!(
            payment.policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(payment.attempts.len() < MAX_ATTEMPTS, "ATTEMPT_LIMIT");
        require!(
            !payment.attempts.iter().any(|a| a.id == attempt_id),
            "ATTEMPT_EXISTS"
        );
        if let Some(last) = payment.attempts.last() {
            require!(
                matches!(
                    last.status,
                    AttemptStatus::Refunded
                        | AttemptStatus::TransferFailed
                        | AttemptStatus::Discarded
                ),
                "PRIOR_ATTEMPT_NOT_CLOSED"
            );
        }
        require!(
            payment.incurred_cost.0 <= payment.max_fee.0,
            "FEE_LIMIT_EXHAUSTED"
        );
        require!(
            payment.amount.0 <= self.per_payment_limit
                && add(payment.amount.0, payment.max_fee.0) <= self.daily_limit,
            "PAYMENT_LIMIT"
        );
        let reservation = add(payment.amount.0, payment.max_fee.0) - payment.incurred_cost.0;
        let new_reserved = add(self.reserved - payment.reservation.0, reservation);
        require!(self.balance >= new_reserved, "INSUFFICIENT_CONFIRMED_FUNDS");
        let recipient = self
            .recipients
            .get(&payment.recipient_id)
            .expect("RECIPIENT_NOT_FOUND");
        let destination = if use_backup {
            require!(recipient.backup_consent, "BACKUP_NOT_AUTHORIZED");
            let backup = recipient.backup.clone().expect("BACKUP_NOT_CONFIGURED");
            require!(
                self.backup_assets.get(&backup.network) == Some(&backup.asset_id),
                "BACKUP_USDC_NOT_CONFIGURED"
            );
            backup
        } else {
            recipient.primary.clone()
        };
        require!(
            route.input_amount.0 > 0
                && route.input_amount.0
                    <= add(payment.amount.0, payment.max_fee.0)
                        .checked_sub(payment.incurred_cost.0)
                        .expect("FEE_LIMIT_EXHAUSTED"),
            "COST_LIMIT"
        );
        require!(route.output_amount.0 > 0, "OUTPUT_AMOUNT_REQUIRED");
        if use_backup || self.backup_assets.get(&destination.network) == Some(&destination.asset_id)
        {
            require!(
                route.output_amount == payment.amount,
                "USDC_ENTITLEMENT_MISMATCH"
            );
        }
        require!(
            route.deadline_ms.0 > now_ms() && route.deadline_ms.0 <= payment.expires_at_ms.0,
            "INVALID_QUOTE_DEADLINE"
        );
        if payment.not_before_ms.0 > now_ms() {
            require!(
                route.deadline_ms.0 >= payment.not_before_ms.0.saturating_add(60_000),
                "SCHEDULE_OUTLIVES_ROUTE"
            );
        }
        require!(
            route.source_receiver != env::current_account_id(),
            "INVALID_SOURCE_RECEIVER"
        );
        if route.kind == RouteKind::Direct {
            require!(destination.network == "near", "DIRECT_REQUIRES_NEAR");
            require!(
                destination.asset_id == format!("nep141:{}", self.token_contract),
                "DIRECT_REQUIRES_TREASURY_TOKEN"
            );
            require!(
                destination.address == route.source_receiver.as_str(),
                "RECIPIENT_MISMATCH"
            );
            require!(
                route.input_amount == payment.amount,
                "DIRECT_AMOUNT_MISMATCH"
            );
            require!(
                route.output_amount == payment.amount,
                "DIRECT_AMOUNT_MISMATCH"
            );
        } else {
            require!(
                !route.quote_id.is_empty() && route.quote_id.len() <= 128,
                "QUOTE_ID_REQUIRED"
            );
            require!(
                route.quote_hash.len() == 64
                    && route.quote_hash.bytes().all(|b| b.is_ascii_hexdigit()),
                "QUOTE_HASH_REQUIRED"
            );
        }
        self.reserved = new_reserved;
        payment.reservation = U128(reservation);
        payment.attempts.push(Attempt {
            id: attempt_id.clone(),
            use_backup,
            destination,
            route,
            authorized: false,
            approvals: BTreeSet::new(),
            approval_policy_version: U64(self.policy_version),
            status: AttemptStatus::Prepared,
            sent_day: U64(0),
            refund_amount: U128(0),
            receipt: None,
            actual_output: U128(0),
            credited_amount: U128(0),
        });
        self.payments.insert(payment_id.clone(), payment.clone());
        self.emit(
            "attempt_created",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "use_backup": use_backup}),
        );
        payment
    }

    pub fn authorize_attempt(
        &mut self,
        payment_id: String,
        attempt_id: String,
        expected_policy_version: U64,
        expected_terms_hash: String,
    ) -> Payment {
        self.assert_approver();
        require!(!self.paused, "PAUSED");
        let mut payment = self.load_payment(&payment_id);
        self.assert_current(&payment);
        require!(
            matches!(
                payment.status,
                PaymentStatus::AwaitingApprovals
                    | PaymentStatus::Approved
                    | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_READY"
        );
        require!(
            expected_policy_version.0 == self.policy_version
                && payment.policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        let status = self.approval_status(&payment, payment.attempts.last());
        require!(
            status.attempt_id.as_deref() == Some(attempt_id.as_str())
                && status.attempt_terms_hash.as_deref() == Some(expected_terms_hash.as_str()),
            "APPROVAL_TERMS_CHANGED"
        );
        let caller = env::predecessor_account_id();
        require!(
            self.payment_approvals(&payment).contains(&caller),
            "PAYMENT_APPROVAL_REQUIRED"
        );
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.status == AttemptStatus::Prepared,
            "ATTEMPT_NOT_PREPARED"
        );
        if attempt.use_backup {
            require!(
                self.backup_assets.get(&attempt.destination.network)
                    == Some(&attempt.destination.asset_id),
                "BACKUP_USDC_NOT_CONFIGURED"
            );
        }
        require!(attempt.route.deadline_ms.0 > now_ms(), "QUOTE_EXPIRED");
        if attempt.approval_policy_version.0 != self.policy_version {
            attempt.approvals.clear();
        }
        attempt.approval_policy_version = U64(self.policy_version);
        attempt.approvals.insert(caller.clone());
        let status = self.approval_status(&payment, payment.attempts.last());
        payment
            .attempts
            .last_mut()
            .expect("ATTEMPT_NOT_FOUND")
            .authorized = status.attempt_ready;
        self.payments.insert(payment_id.clone(), payment.clone());
        self.emit(
            "attempt_authorized",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "approver": caller, "required_approvals": status.required_approvals, "collected_approvals": status.attempt_collected, "policy_version": expected_policy_version, "terms_hash": expected_terms_hash}),
        );
        payment
    }

    pub fn discard_attempt(&mut self, payment_id: String, attempt_id: String) -> Payment {
        self.assert_executor();
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Proposed
                    | PaymentStatus::AwaitingApprovals
                    | PaymentStatus::Approved
                    | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_READY"
        );
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.status == AttemptStatus::Prepared,
            "SOURCE_MAY_STILL_DELIVER"
        );
        attempt.status = AttemptStatus::Discarded;
        attempt.authorized = false;
        self.payments.insert(payment_id.clone(), payment.clone());
        self.emit(
            "attempt_discarded",
            json!({"payment_id": payment_id, "attempt_id": attempt_id}),
        );
        payment
    }

    pub fn execute_payment(&mut self, payment_id: String, attempt_id: String) -> Promise {
        self.assert_executor();
        require!(!self.paused, "PAUSED");
        require!(env::prepaid_gas() >= Gas::from_tgas(50), "INSUFFICIENT_GAS");
        let mut payment = self.load_payment(&payment_id);
        self.assert_current(&payment);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Approved | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_READY"
        );
        require!(
            payment.policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(now_ms() >= payment.not_before_ms.0, "PAYMENT_NOT_DUE");
        require!(
            self.approval_status(&payment, payment.attempts.last())
                .can_execute,
            "APPROVAL_QUORUM_NOT_MET"
        );
        let amount_limit = payment.reservation.0;
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.authorized && attempt.status == AttemptStatus::Prepared,
            "ATTEMPT_NOT_AUTHORIZED"
        );
        if attempt.use_backup {
            require!(
                self.backup_assets.get(&attempt.destination.network)
                    == Some(&attempt.destination.asset_id),
                "BACKUP_USDC_NOT_CONFIGURED"
            );
        }
        require!(attempt.route.deadline_ms.0 > now_ms(), "QUOTE_EXPIRED");
        let amount = attempt.route.input_amount.0;
        require!(
            amount > 0 && amount <= amount_limit && amount <= self.balance,
            "INSUFFICIENT_RESERVED_FUNDS"
        );
        let day = now_ms() / DAY_MS;
        let spent = *self.spent_by_day.get(&day).unwrap_or(&0);
        require!(add(spent, amount) <= self.daily_limit, "DAILY_LIMIT");
        attempt.status = AttemptStatus::Sending;
        attempt.sent_day = U64(day);
        let receiver = attempt.route.source_receiver.clone();
        self.spent_by_day.insert(day, add(spent, amount));
        self.reserved -= payment.reservation.0;
        payment.reservation = U128(0);
        self.balance -= amount;
        self.in_flight = add(self.in_flight, amount);
        self.unsettled_payments = self
            .unsettled_payments
            .checked_add(1)
            .expect("ACTIVE_PAYMENT_OVERFLOW");
        self.bump_epoch();
        payment.status = PaymentStatus::InFlight;
        self.payments.insert(payment_id.clone(), payment);
        self.emit(
            "source_transfer_started",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "amount": U128(amount), "receiver_id": receiver}),
        );
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(receiver, U128(amount), Some(payment_id.clone()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_transfer_result(self.company_id.clone(), payment_id, attempt_id),
            )
    }

    pub fn on_transfer_result(&mut self, payment_id: String, attempt_id: String) -> bool {
        let success = match env::promise_result_checked(0, 64) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        self.resolve_source_transfer(payment_id, attempt_id, success)
    }

    pub fn recover_source_transfer(
        &mut self,
        payment_id: String,
        attempt_id: String,
        succeeded: bool,
        receipt: String,
    ) -> bool {
        validate_receipt(&receipt);
        let mut payment = self.load_payment(&payment_id);
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.status == AttemptStatus::Sending,
            "SOURCE_ALREADY_RESOLVED"
        );
        attempt.receipt = Some(receipt);
        self.payments.insert(payment_id.clone(), payment);
        self.emit(
            "source_recovery_attested",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "succeeded": succeeded, "owner": env::predecessor_account_id()}),
        );
        self.resolve_source_transfer(payment_id, attempt_id, succeeded)
    }

    fn resolve_source_transfer(
        &mut self,
        payment_id: String,
        attempt_id: String,
        success: bool,
    ) -> bool {
        let Some(mut payment) = self.payments.get(&payment_id).cloned() else {
            return false;
        };
        let Some(attempt) = payment.attempts.last_mut() else {
            return false;
        };
        if attempt.id != attempt_id || attempt.status != AttemptStatus::Sending {
            return false;
        }
        let amount = attempt.route.input_amount.0;
        let standing = self.standing_payments.get(&payment_id).cloned();
        if let Some(id) = &standing {
            let mandate = self
                .standing_mandates
                .get_mut(id)
                .expect("MANDATE_NOT_FOUND");
            mandate.pending_input = U128(
                mandate
                    .pending_input
                    .0
                    .checked_sub(add(payment.amount.0, payment.max_fee.0))
                    .expect("MANDATE_PENDING_UNDERFLOW"),
            );
        }
        self.in_flight = self
            .in_flight
            .checked_sub(amount)
            .expect("IN_FLIGHT_UNDERFLOW");
        self.bump_epoch();
        if success {
            if attempt.route.kind == RouteKind::Direct {
                attempt.status = AttemptStatus::Delivered;
                attempt.actual_output = attempt.route.output_amount;
                attempt.credited_amount = payment.amount;
                payment.status = PaymentStatus::Paid;
                self.finish_unsettled_payment();
            } else {
                attempt.status = AttemptStatus::SourceSent;
            }
        } else {
            self.finish_unsettled_payment();
            self.balance = add(self.balance, amount);
            let spent = *self.spent_by_day.get(&attempt.sent_day.0).unwrap_or(&0);
            self.spent_by_day.insert(
                attempt.sent_day.0,
                spent.checked_sub(amount).expect("SPEND_UNDERFLOW"),
            );
            attempt.status = AttemptStatus::TransferFailed;
            let reserve = add(payment.amount.0, payment.max_fee.0) - payment.incurred_cost.0;
            if self.balance >= add(self.reserved, reserve) {
                self.reserved = add(self.reserved, reserve);
                payment.reservation = U128(reserve);
                payment.status = PaymentStatus::Retryable;
            } else {
                payment.status = PaymentStatus::Held;
            }
        }
        if standing.is_some() && !success {
            payment.status = PaymentStatus::Held;
        }
        let status = payment.status.clone();
        self.payments.insert(payment_id.clone(), payment);
        self.emit(
            "source_transfer_result",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "success": success, "payment_status": status}),
        );
        success
    }

    pub fn report_settlement(
        &mut self,
        payment_id: String,
        attempt_id: String,
        outcome: SettlementOutcome,
        receipt: String,
        actual_output: Option<U128>,
    ) -> Payment {
        self.assert_reporter();
        validate_receipt(&receipt);
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::InFlight | PaymentStatus::RecoveryPending
            ),
            "PAYMENT_NOT_IN_FLIGHT"
        );
        let entitlement = payment.amount;
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            matches!(
                attempt.status,
                AttemptStatus::SourceSent | AttemptStatus::Uncertain | AttemptStatus::RefundPending
            ),
            "SOURCE_NOT_CONFIRMED"
        );
        attempt.receipt = Some(receipt);
        match outcome {
            SettlementOutcome::Delivered => {
                let actual = actual_output.expect("ACTUAL_OUTPUT_REQUIRED");
                require!(
                    actual.0 >= attempt.route.output_amount.0,
                    "DELIVERY_BELOW_EXPECTED"
                );
                attempt.status = AttemptStatus::Delivered;
                attempt.actual_output = actual;
                attempt.credited_amount = entitlement;
                payment.status = PaymentStatus::Paid;
                self.finish_unsettled_payment();
            }
            SettlementOutcome::Uncertain => {
                if let Some(actual) = actual_output {
                    require!(
                        actual.0 >= attempt.actual_output.0,
                        "OUTPUT_CANNOT_DECREASE"
                    );
                    attempt.actual_output = actual;
                }
                attempt.status = AttemptStatus::Uncertain;
                payment.status = PaymentStatus::RecoveryPending;
            }
            SettlementOutcome::RefundPending => {
                require!(
                    attempt.actual_output.0 == 0 && actual_output.unwrap_or(U128(0)).0 == 0,
                    "DELIVERY_ALREADY_OBSERVED"
                );
                attempt.status = AttemptStatus::RefundPending;
                payment.status = PaymentStatus::RecoveryPending;
            }
        }
        self.payments.insert(payment_id.clone(), payment.clone());
        self.emit(
            "settlement_reported",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "outcome": outcome, "reporter": env::predecessor_account_id()}),
        );
        payment
    }

    pub fn confirm_refund(
        &mut self,
        payment_id: String,
        attempt_id: String,
        refund_amount: U128,
        receipt: String,
    ) -> Promise {
        validate_receipt(&receipt);
        require!(self.in_flight == 0, "SOURCE_CALLBACK_PENDING");
        let mut payment = self.load_payment(&payment_id);
        require!(
            payment.status == PaymentStatus::RecoveryPending,
            "NOT_RECOVERING"
        );
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.status == AttemptStatus::RefundPending,
            "REFUND_NOT_REPORTED"
        );
        require!(attempt.actual_output.0 == 0, "DELIVERY_ALREADY_OBSERVED");
        require!(
            refund_amount.0 <= attempt.route.input_amount.0,
            "REFUND_EXCEEDS_INPUT"
        );
        attempt.status = AttemptStatus::RefundVerifying;
        attempt.refund_amount = refund_amount;
        attempt.receipt = Some(receipt);
        self.payments.insert(payment_id.clone(), payment);
        ext_ft::ext(self.token_contract.clone())
            .with_static_gas(GAS_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_refund_verified(
                        self.company_id.clone(),
                        payment_id,
                        attempt_id,
                        U64(self.balance_epoch),
                        U64(self.pool_epoch),
                    ),
            )
    }

    pub fn on_refund_verified(
        &mut self,
        payment_id: String,
        attempt_id: String,
        epoch: U64,
        accounted: U128,
        pool_current: bool,
    ) -> bool {
        let Some(mut payment) = self.payments.get(&payment_id).cloned() else {
            return false;
        };
        let Some(attempt) = payment.attempts.last_mut() else {
            return false;
        };
        if attempt.id != attempt_id || attempt.status != AttemptStatus::RefundVerifying {
            return false;
        }
        let Some(actual) = read_balance() else {
            attempt.status = AttemptStatus::RefundPending;
            self.payments.insert(payment_id, payment);
            return false;
        };
        if !pool_current
            || epoch.0 != self.balance_epoch
            || self.in_flight != 0
            || actual < add(accounted.0, attempt.refund_amount.0)
        {
            attempt.status = AttemptStatus::RefundPending;
            self.payments.insert(payment_id, payment);
            return false;
        }
        self.balance = add(self.balance, attempt.refund_amount.0);
        self.confirmed_at_ms = now_ms();
        self.bump_epoch();
        let lost = attempt.route.input_amount.0 - attempt.refund_amount.0;
        payment.incurred_cost = U128(add(payment.incurred_cost.0, lost));
        attempt.status = AttemptStatus::Refunded;
        self.finish_unsettled_payment();
        if payment.incurred_cost.0 <= payment.max_fee.0 {
            let needed = add(payment.amount.0, payment.max_fee.0) - payment.incurred_cost.0;
            if self.balance >= add(self.reserved, needed) {
                self.reserved = add(self.reserved, needed);
                payment.reservation = U128(needed);
                payment.status = PaymentStatus::Retryable;
            } else {
                payment.status = PaymentStatus::Held;
            }
        } else {
            payment.status = PaymentStatus::Held;
        }
        self.payments.insert(payment_id.clone(), payment);
        self.emit(
            "refund_verified",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "actual_balance": U128(actual)}),
        );
        true
    }

    pub fn cancel_payment(&mut self, payment_id: String) {
        self.assert_approver();
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Proposed
                    | PaymentStatus::AwaitingApprovals
                    | PaymentStatus::Approved
                    | PaymentStatus::Retryable
                    | PaymentStatus::Held
            ),
            "PAYMENT_MAY_STILL_DELIVER"
        );
        self.reserved -= payment.reservation.0;
        payment.reservation = U128(0);
        payment.status = PaymentStatus::Cancelled;
        self.payments.insert(payment_id.clone(), payment);
        self.emit("payment_cancelled", json!({"payment_id": payment_id}));
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token_contract = env::predecessor_account_id();
        if token_contract != self.token_contract {
            return self.retained_deposit(token_contract, sender_id, amount, msg);
        }
        require!(msg != retained::RETAIN_MESSAGE, "USDC_IS_PAYMENT_CASH");
        require!(amount.0 > 0, "DEPOSIT_AMOUNT_REQUIRED");
        self.balance = add(self.balance, amount.0);
        self.confirmed_at_ms = now_ms();
        self.bump_epoch();
        PromiseOrValue::Value(U128(0))
    }

    pub fn refresh_balance(&mut self) -> Promise {
        require!(self.in_flight == 0, "SOURCE_CALLBACK_PENDING");
        ext_ft::ext(self.token_contract.clone())
            .with_static_gas(GAS_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_balance_sync(self.company_id.clone(), U64(self.balance_epoch)),
            )
    }

    pub fn on_balance_sync(&mut self, epoch: U64) -> bool {
        if epoch.0 != self.balance_epoch || self.in_flight != 0 {
            return false;
        }
        if let Some(actual) = read_balance() {
            if actual < add(self.balance, self.in_flight) {
                return false;
            }
            self.confirmed_at_ms = now_ms();
            self.bump_epoch();
            true
        } else {
            false
        }
    }

    pub fn on_deposit_sync(&mut self, epoch: U64) -> U128 {
        self.on_balance_sync(epoch);
        U128(0)
    }

    pub fn withdraw_available(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.balance.saturating_sub(self.reserved),
            "INSUFFICIENT_AVAILABLE_FUNDS"
        );
        require!(receiver_id != env::current_account_id(), "INVALID_RECEIVER");
        self.next_withdrawal = self
            .next_withdrawal
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        let withdrawal_id = U64(self.next_withdrawal);
        self.withdrawals.insert(withdrawal_id.0, (amount, false));
        self.balance -= amount.0;
        self.in_flight = add(self.in_flight, amount.0);
        self.bump_epoch();
        self.emit(
            "withdrawal_started",
            json!({"withdrawal_id":withdrawal_id,"receiver_id":receiver_id,"amount":amount}),
        );
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(receiver_id, amount, Some("Razor owner withdrawal".into()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw_result(self.company_id.clone(), withdrawal_id, amount),
            )
    }

    pub fn on_withdraw_result(&mut self, withdrawal_id: U64, amount: U128) -> bool {
        let Some((expected, resolved)) = self.withdrawals.get(&withdrawal_id.0) else {
            return false;
        };
        if *resolved || *expected != amount {
            return false;
        }
        self.withdrawals.insert(withdrawal_id.0, (amount, true));
        let success = match env::promise_result_checked(0, 64) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        self.in_flight = self
            .in_flight
            .checked_sub(amount.0)
            .expect("IN_FLIGHT_UNDERFLOW");
        self.bump_epoch();
        if !success {
            self.balance = add(self.balance, amount.0);
        }
        self.emit(
            "withdrawal_result",
            json!({"withdrawal_id":withdrawal_id,"amount": amount, "success": success}),
        );
        success
    }
}

impl CompanyTreasury {
    fn emit(&self, event: &str, mut data: near_sdk::serde_json::Value) {
        data["company_id"] = json!(self.company_id);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard":"razor","version":"2.0.0","event":event,"data":[data]})
        ));
    }

    pub(crate) fn flush(&mut self) {
        self.retained_assets.flush();
        self.backup_assets.flush();
        self.recipients.flush();
        self.payments.flush();
        self.obligations.flush();
        self.spent_by_day.flush();
        self.partial_receipts.flush();
        self.standing_mandates.flush();
        self.standing_payments.flush();
        self.recipient_activation.flush();
        self.distributions.flush();
        self.void_distributions.flush();
        self.withdrawals.flush();
    }

    pub(crate) fn liabilities(&self) -> std::collections::BTreeMap<AccountId, u128> {
        let mut amounts = std::collections::BTreeMap::new();
        amounts.insert(
            self.token_contract.clone(),
            add(self.balance, self.in_flight),
        );
        for asset in self.retained_assets.values() {
            amounts.insert(
                asset.token_contract.clone(),
                add(asset.balance.0, asset.in_flight.0),
            );
        }
        amounts
    }

    fn finish_unsettled_payment(&mut self) {
        self.unsettled_payments = self
            .unsettled_payments
            .checked_sub(1)
            .expect("ACTIVE_PAYMENT_UNDERFLOW");
    }

    fn is_approver(&self, account: &AccountId) -> bool {
        account == &self.owner_id || self.approvers.contains(account)
    }
    fn required_approvals(&self, payment: &Payment) -> u8 {
        let amount = add(payment.amount.0, payment.max_fee.0);
        self.approval_tiers
            .iter()
            .find(|tier| amount <= tier.up_to.0)
            .or_else(|| self.approval_tiers.last())
            .expect("APPROVAL_POLICY_REQUIRED")
            .required_approvals
    }
    fn approval_context_current(&self, payment: &Payment) -> bool {
        payment.policy_version.0 == self.policy_version
            && payment.expires_at_ms.0 > now_ms()
            && payment.amount.0 <= self.per_payment_limit
            && add(payment.amount.0, payment.max_fee.0) <= self.daily_limit
            && payment.incurred_cost.0 <= payment.max_fee.0
            && self
                .recipients
                .get(&payment.recipient_id)
                .is_some_and(|recipient| {
                    recipient.active && recipient.version == payment.recipient_version
                })
    }
    fn payment_approvals(&self, payment: &Payment) -> Vec<AccountId> {
        if !self.approval_context_current(payment) {
            return Vec::new();
        }
        payment
            .approvals
            .iter()
            .filter(|account| self.is_approver(account))
            .cloned()
            .collect()
    }
    fn payment_terms_hash(&self, payment: &Payment) -> String {
        hash_terms(
            json!({"domain":"razor_payment_approval_v1","treasury":env::current_account_id(),"company_id":self.company_id,"payment_id":payment.id,
            "recipient_id":payment.recipient_id,"recipient_version":payment.recipient_version,"amount":payment.amount,"max_fee":payment.max_fee,
            "expires_at_ms":payment.expires_at_ms,"not_before_ms":payment.not_before_ms,"reference":payment.reference,"policy_version":U64(self.policy_version),"required_approvals":self.required_approvals(payment)}),
        )
    }
    fn attempt_terms_hash(&self, payment: &Payment, attempt: &Attempt) -> String {
        self.attempt_terms_hash_with_payment_hash(&self.payment_terms_hash(payment), attempt)
    }
    fn attempt_terms_hash_with_payment_hash(
        &self,
        payment_terms_hash: &str,
        attempt: &Attempt,
    ) -> String {
        hash_terms(
            json!({"domain":"razor_route_approval_v1","payment_terms_hash":payment_terms_hash,"attempt_id":attempt.id,
            "destination":attempt.destination,"route":attempt.route,"use_backup":attempt.use_backup,"policy_version":U64(self.policy_version)}),
        )
    }
    fn approval_status(&self, payment: &Payment, attempt: Option<&Attempt>) -> ApprovalStatus {
        let required = self.required_approvals(payment);
        let payment_approvals = self.payment_approvals(payment);
        let payment_ready = payment_approvals.len() >= required as usize;
        let attempt_approvals: Vec<AccountId> = attempt
            .filter(|attempt| attempt.approval_policy_version.0 == self.policy_version)
            .map(|attempt| {
                attempt
                    .approvals
                    .iter()
                    .filter(|account| payment_approvals.contains(account))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let attempt_ready = attempt.is_some_and(|attempt| {
            attempt.status == AttemptStatus::Prepared && attempt.route.deadline_ms.0 > now_ms()
        }) && attempt_approvals.len() >= required as usize;
        let can_execute = !self.paused
            && now_ms() >= payment.not_before_ms.0
            && payment_ready
            && attempt_ready
            && matches!(
                payment.status,
                PaymentStatus::Approved | PaymentStatus::Retryable
            )
            && attempt.is_some_and(|attempt| {
                payment
                    .attempts
                    .last()
                    .is_some_and(|latest| latest.id == attempt.id)
                    && attempt.route.input_amount.0 <= payment.reservation.0
                    && attempt.route.input_amount.0 <= self.balance
                    && add(
                        *self.spent_by_day.get(&(now_ms() / DAY_MS)).unwrap_or(&0),
                        attempt.route.input_amount.0,
                    ) <= self.daily_limit
                    && (!attempt.use_backup
                        || self.backup_assets.get(&attempt.destination.network)
                            == Some(&attempt.destination.asset_id))
            });
        let payment_terms_hash = self.payment_terms_hash(payment);
        let attempt_terms_hash = attempt
            .map(|attempt| self.attempt_terms_hash_with_payment_hash(&payment_terms_hash, attempt));
        ApprovalStatus {
            policy_version: U64(self.policy_version),
            approval_amount: U128(add(payment.amount.0, payment.max_fee.0)),
            required_approvals: required,
            payment_terms_hash,
            payment_collected: payment_approvals.len() as u8,
            payment_approvals,
            payment_ready,
            attempt_id: attempt.map(|attempt| attempt.id.clone()),
            attempt_terms_hash,
            attempt_collected: attempt_approvals.len() as u8,
            attempt_approvals,
            attempt_ready,
            can_execute,
        }
    }
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER");
        near_sdk::assert_one_yocto();
    }
    fn assert_approver(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.approvers.contains(&caller),
            "ONLY_APPROVER"
        );
        near_sdk::assert_one_yocto();
    }
    fn assert_executor(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id
                || self.approvers.contains(&caller)
                || self.executors.contains(&caller),
            "ONLY_EXECUTOR"
        );
    }
    fn assert_reporter(&self) {
        let caller = env::predecessor_account_id();
        require!(
            caller == self.owner_id || self.settlement_reporter.as_ref() == Some(&caller),
            "ONLY_SETTLEMENT_REPORTER"
        );
    }
    fn assert_current(&self, payment: &Payment) {
        require!(payment.expires_at_ms.0 > now_ms(), "PAYMENT_EXPIRED");
        let recipient = self
            .recipients
            .get(&payment.recipient_id)
            .expect("RECIPIENT_NOT_FOUND");
        require!(
            recipient.active && recipient.version == payment.recipient_version,
            "RECIPIENT_CHANGED"
        );
    }
    fn load_payment(&self, id: &str) -> Payment {
        self.payments
            .get(&id.to_string())
            .cloned()
            .expect("PAYMENT_NOT_FOUND")
    }
    fn bump_epoch(&mut self) {
        self.balance_epoch = self.balance_epoch.checked_add(1).expect("EPOCH_OVERFLOW");
    }
}

fn last_attempt_mut<'a>(payment: &'a mut Payment, attempt_id: &str) -> &'a mut Attempt {
    let attempt = payment.attempts.last_mut().expect("ATTEMPT_NOT_FOUND");
    require!(attempt.id == attempt_id, "NOT_LATEST_ATTEMPT");
    attempt
}
fn now_ms() -> u64 {
    env::block_timestamp_ms()
}
fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).expect("AMOUNT_OVERFLOW")
}
fn hash_terms(value: near_sdk::serde_json::Value) -> String {
    env::sha256(&near_sdk::serde_json::to_vec(&value).expect("APPROVAL_SERIALIZATION_FAILED"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
fn validate_id(id: &str) {
    require!(
        !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control),
        "INVALID_ID"
    );
}
fn validate_destination(destination: &Destination) {
    require!(
        !destination.network.is_empty() && destination.network.len() <= 32,
        "INVALID_NETWORK"
    );
    require!(
        !destination.asset_id.is_empty() && destination.asset_id.len() <= 256,
        "INVALID_ASSET"
    );
    require!(
        !destination.address.is_empty()
            && destination.address.len() <= 256
            && !destination.address.chars().any(char::is_whitespace),
        "INVALID_DESTINATION"
    );
}
fn validate_receipt(receipt: &str) {
    require!(
        !receipt.is_empty() && receipt.len() <= 1024,
        "RECEIPT_REQUIRED"
    );
}
fn read_balance() -> Option<u128> {
    env::promise_result_checked(0, 128)
        .ok()
        .and_then(|bytes| near_sdk::serde_json::from_slice::<U128>(&bytes).ok())
        .map(|n| n.0)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
