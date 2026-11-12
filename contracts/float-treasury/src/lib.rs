mod types;
pub use types::*;

use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
    ext_contract,
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

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_transfer_result(&mut self, payment_id: String, attempt_id: String) -> bool;
    fn on_balance_sync(&mut self, epoch: U64) -> bool;
    fn on_deposit_sync(&mut self, epoch: U64) -> U128;
    fn on_refund_verified(&mut self, payment_id: String, attempt_id: String, epoch: U64) -> bool;
    fn on_withdraw_result(&mut self, amount: U128) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    owner_id: AccountId,
    token_contract: AccountId,
    paused: bool,
    per_payment_limit: u128,
    daily_limit: u128,
    policy_version: u64,
    approvers: BTreeSet<AccountId>,
    executors: BTreeSet<AccountId>,
    settlement_reporter: Option<AccountId>,
    backup_assets: IterableMap<String, String>,
    balance: u128,
    reserved: u128,
    in_flight: u128,
    balance_epoch: u64,
    confirmed_at_ms: u64,
    recipients: IterableMap<String, Recipient>,
    payments: IterableMap<String, Payment>,
    obligations: IterableMap<String, String>,
    spent_by_day: IterableMap<u64, u128>,
}

#[near]
impl Treasury {
    #[init]
    pub fn new(
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
        let mut backup_assets = IterableMap::new(b"b");
        backup_assets.insert("near".into(), format!("nep141:{token_contract}"));
        Self {
            owner_id,
            token_contract,
            paused: false,
            per_payment_limit: per_payment_limit.0,
            daily_limit: daily_limit.0,
            policy_version: 1,
            approvers: BTreeSet::new(),
            executors: BTreeSet::new(),
            settlement_reporter: None,
            backup_assets,
            balance: 0,
            reserved: 0,
            in_flight: 0,
            balance_epoch: 0,
            confirmed_at_ms: 0,
            recipients: IterableMap::new(b"r"),
            payments: IterableMap::new(b"p"),
            obligations: IterableMap::new(b"o"),
            spent_by_day: IterableMap::new(b"d"),
        }
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
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

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        emit("pause_changed", json!({"paused": paused}));
    }

    #[payable]
    pub fn set_policy(&mut self, per_payment_limit: U128, daily_limit: U128) {
        self.assert_owner();
        require!(
            per_payment_limit.0 > 0 && daily_limit.0 >= per_payment_limit.0,
            "INVALID_LIMITS"
        );
        self.per_payment_limit = per_payment_limit.0;
        self.daily_limit = daily_limit.0;
        self.policy_version = self
            .policy_version
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        emit(
            "policy_changed",
            json!({"version": U64(self.policy_version)}),
        );
    }

    #[payable]
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
        if enabled {
            set.insert(account_id.clone());
        } else {
            set.remove(&account_id);
        }
        emit(
            "role_changed",
            json!({"account_id": account_id, "role": role, "enabled": enabled}),
        );
    }

    #[payable]
    pub fn set_settlement_reporter(&mut self, account_id: Option<AccountId>) {
        self.assert_owner();
        self.settlement_reporter = account_id.clone();
        emit(
            "settlement_reporter_changed",
            json!({"account_id": account_id}),
        );
    }

    #[payable]
    pub fn transfer_ownership(&mut self, new_owner_id: AccountId) {
        self.assert_owner();
        require!(
            new_owner_id != env::current_account_id(),
            "OWNER_MUST_BE_RECOVERABLE"
        );
        self.owner_id = new_owner_id.clone();
        self.policy_version = self
            .policy_version
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        emit("owner_changed", json!({"owner_id": new_owner_id}));
    }

    #[payable]
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
        emit(
            "backup_asset_changed",
            json!({"network": network, "asset_id": asset_id}),
        );
    }

    #[payable]
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
        self.recipients
            .insert(recipient_id.clone(), recipient.clone());
        emit(
            "recipient_changed",
            json!({"recipient_id": recipient_id, "version": U64(version)}),
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
            reference: reference.clone(),
            proposer: env::predecessor_account_id(),
            approver: None,
            policy_version: U64(self.policy_version),
            status: PaymentStatus::Proposed,
            attempts: Vec::new(),
        };
        self.obligations.insert(reference, payment_id.clone());
        self.payments.insert(payment_id.clone(), payment.clone());
        emit(
            "payment_proposed",
            json!({"payment_id": payment_id, "amount": amount, "max_fee": max_fee}),
        );
        payment
    }

    #[payable]
    pub fn approve_payment(&mut self, payment_id: String) -> Payment {
        self.assert_approver();
        require!(!self.paused, "PAUSED");
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Proposed
                    | PaymentStatus::Held
                    | PaymentStatus::Approved
                    | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_APPROVABLE"
        );
        self.assert_current(&payment);
        require!(
            payment.incurred_cost.0 <= payment.max_fee.0,
            "FEE_LIMIT_EXHAUSTED"
        );
        let reservation = add(payment.amount.0, payment.max_fee.0) - payment.incurred_cost.0;
        let new_reserved = add(self.reserved - payment.reservation.0, reservation);
        require!(self.balance >= new_reserved, "INSUFFICIENT_CONFIRMED_FUNDS");
        require!(payment.amount.0 <= self.per_payment_limit, "PAYMENT_LIMIT");
        self.reserved = new_reserved;
        payment.reservation = U128(reservation);
        payment.policy_version = U64(self.policy_version);
        payment.approver = Some(env::predecessor_account_id());
        payment.status = PaymentStatus::Approved;
        self.payments.insert(payment_id.clone(), payment.clone());
        emit(
            "payment_approved",
            json!({"payment_id": payment_id, "reservation": payment.reservation}),
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
                PaymentStatus::Approved | PaymentStatus::Retryable
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
            route.input_amount.0 > 0 && route.input_amount.0 <= payment.reservation.0,
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
        payment.attempts.push(Attempt {
            id: attempt_id.clone(),
            use_backup,
            destination,
            route,
            authorized: false,
            status: AttemptStatus::Prepared,
            sent_day: U64(0),
            refund_amount: U128(0),
            receipt: None,
        });
        self.payments.insert(payment_id.clone(), payment.clone());
        emit(
            "attempt_created",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "use_backup": use_backup}),
        );
        payment
    }

    #[payable]
    pub fn authorize_attempt(&mut self, payment_id: String, attempt_id: String) -> Payment {
        self.assert_approver();
        require!(!self.paused, "PAUSED");
        let mut payment = self.load_payment(&payment_id);
        self.assert_current(&payment);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Approved | PaymentStatus::Retryable
            ),
            "PAYMENT_NOT_READY"
        );
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.status == AttemptStatus::Prepared,
            "ATTEMPT_NOT_PREPARED"
        );
        require!(attempt.route.deadline_ms.0 > now_ms(), "QUOTE_EXPIRED");
        attempt.authorized = true;
        self.payments.insert(payment_id.clone(), payment.clone());
        emit(
            "attempt_authorized",
            json!({"payment_id": payment_id, "attempt_id": attempt_id}),
        );
        payment
    }

    pub fn discard_attempt(&mut self, payment_id: String, attempt_id: String) -> Payment {
        self.assert_executor();
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Approved | PaymentStatus::Retryable
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
        emit(
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
        self.bump_epoch();
        payment.status = PaymentStatus::InFlight;
        self.payments.insert(payment_id.clone(), payment);
        emit(
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
                    .on_transfer_result(payment_id, attempt_id),
            )
    }

    #[private]
    pub fn on_transfer_result(&mut self, payment_id: String, attempt_id: String) -> bool {
        let success = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        self.resolve_source_transfer(payment_id, attempt_id, success)
    }

    #[payable]
    pub fn recover_source_transfer(
        &mut self,
        payment_id: String,
        attempt_id: String,
        succeeded: bool,
        receipt: String,
    ) -> bool {
        self.assert_owner();
        validate_receipt(&receipt);
        let mut payment = self.load_payment(&payment_id);
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            attempt.status == AttemptStatus::Sending,
            "SOURCE_ALREADY_RESOLVED"
        );
        attempt.receipt = Some(receipt);
        self.payments.insert(payment_id.clone(), payment);
        emit(
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
        self.in_flight = self
            .in_flight
            .checked_sub(amount)
            .expect("IN_FLIGHT_UNDERFLOW");
        self.bump_epoch();
        if success {
            if attempt.route.kind == RouteKind::Direct {
                attempt.status = AttemptStatus::Delivered;
                payment.status = PaymentStatus::Paid;
            } else {
                attempt.status = AttemptStatus::SourceSent;
            }
        } else {
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
        let status = payment.status.clone();
        self.payments.insert(payment_id.clone(), payment);
        emit(
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
                attempt.status = AttemptStatus::Delivered;
                payment.status = PaymentStatus::Paid;
            }
            SettlementOutcome::Uncertain => {
                attempt.status = AttemptStatus::Uncertain;
                payment.status = PaymentStatus::RecoveryPending;
            }
            SettlementOutcome::RefundPending => {
                attempt.status = AttemptStatus::RefundPending;
                payment.status = PaymentStatus::RecoveryPending;
            }
        }
        self.payments.insert(payment_id.clone(), payment.clone());
        emit(
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
        self.assert_reporter();
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
                    .on_refund_verified(payment_id, attempt_id, U64(self.balance_epoch)),
            )
    }

    #[private]
    pub fn on_refund_verified(
        &mut self,
        payment_id: String,
        attempt_id: String,
        epoch: U64,
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
        if epoch.0 != self.balance_epoch || self.in_flight != 0 {
            attempt.status = AttemptStatus::RefundPending;
            self.payments.insert(payment_id, payment);
            return false;
        }
        self.balance = actual;
        self.confirmed_at_ms = now_ms();
        let lost = attempt.route.input_amount.0 - attempt.refund_amount.0;
        payment.incurred_cost = U128(add(payment.incurred_cost.0, lost));
        attempt.status = AttemptStatus::Refunded;
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
        emit(
            "refund_verified",
            json!({"payment_id": payment_id, "attempt_id": attempt_id, "actual_balance": U128(actual)}),
        );
        true
    }

    #[payable]
    pub fn cancel_payment(&mut self, payment_id: String) {
        self.assert_approver();
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::Proposed
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
        emit("payment_cancelled", json!({"payment_id": payment_id}));
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token_contract,
            "ONLY_TREASURY_TOKEN"
        );
        require!(msg.len() <= 1024, "DEPOSIT_MESSAGE_TOO_LONG");
        self.bump_epoch();
        emit(
            "deposit_received",
            json!({"sender_id": sender_id, "amount": amount}),
        );
        if self.in_flight != 0 {
            return PromiseOrValue::Value(U128(0));
        }
        PromiseOrValue::Promise(
            ext_ft::ext(self.token_contract.clone())
                .with_static_gas(GAS_BALANCE)
                .ft_balance_of(env::current_account_id())
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(GAS_CALLBACK)
                        .on_deposit_sync(U64(self.balance_epoch)),
                ),
        )
    }

    pub fn refresh_balance(&mut self) -> Promise {
        require!(self.in_flight == 0, "SOURCE_CALLBACK_PENDING");
        ext_ft::ext(self.token_contract.clone())
            .with_static_gas(GAS_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_balance_sync(U64(self.balance_epoch)),
            )
    }

    #[private]
    pub fn on_balance_sync(&mut self, epoch: U64) -> bool {
        if epoch.0 != self.balance_epoch || self.in_flight != 0 {
            return false;
        }
        if let Some(actual) = read_balance() {
            self.balance = actual;
            self.confirmed_at_ms = now_ms();
            true
        } else {
            false
        }
    }

    #[private]
    pub fn on_deposit_sync(&mut self, epoch: U64) -> U128 {
        self.on_balance_sync(epoch);
        U128(0)
    }

    #[payable]
    pub fn withdraw_available(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        require!(
            amount.0 > 0 && amount.0 <= self.balance.saturating_sub(self.reserved),
            "INSUFFICIENT_AVAILABLE_FUNDS"
        );
        require!(receiver_id != env::current_account_id(), "INVALID_RECEIVER");
        self.balance -= amount.0;
        self.in_flight = add(self.in_flight, amount.0);
        self.bump_epoch();
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(receiver_id, amount, Some("FLOAT owner withdrawal".into()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw_result(amount),
            )
    }

    #[private]
    pub fn on_withdraw_result(&mut self, amount: U128) -> bool {
        let success = !matches!(
            env::promise_result_checked(0, 64),
            Err(PromiseError::Failed)
        );
        self.in_flight = self
            .in_flight
            .checked_sub(amount.0)
            .expect("IN_FLIGHT_UNDERFLOW");
        self.bump_epoch();
        if !success {
            self.balance = add(self.balance, amount.0);
        }
        emit(
            "withdrawal_result",
            json!({"amount": amount, "success": success}),
        );
        success
    }
}

impl Treasury {
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
fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"float","version":"1.0.0","event":event,"data":[data]})
    ));
}

#[cfg(test)]
mod tests;
