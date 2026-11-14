use super::*;
use near_sdk::PromiseError;

const MAINNET_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
pub(crate) const MAX_DEPOSITS_PER_COMPANY: u8 = 8;
const MODE: &str = "cash_backed_native_v1";
const REFUND_POLICY: &str = "return_accepted_deposits_to_fixed_owner_on_cancel";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CashPosition {
    pub company_id: String,
    pub deposit_due: U128,
    pub credit_due: U128,
    pub destination: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct CashTerms {
    pub mode: String,
    pub network: String,
    pub token_contract: AccountId,
    pub refund_policy: String,
    pub positions: Vec<CashPosition>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CashKind {
    Credit,
    Refund,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CashStage {
    Funding,
    Credits,
    Refunds,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CashPending {
    pub kind: CashKind,
    pub nonce: U64,
    pub amount: U128,
    pub receiver: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CashTransfer {
    pub kind: CashKind,
    pub nonce: U64,
    pub amount: U128,
    pub status: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CashAccount {
    pub company_id: String,
    pub destination: AccountId,
    pub deposit_due: U128,
    pub credit_due: U128,
    pub deposited: U128,
    pub credit_available: U128,
    pub credit_paid: U128,
    pub refund_available: U128,
    pub refund_paid: U128,
    pub nonce: U64,
    pub pending: Option<CashPending>,
    pub last_transfer: Option<CashTransfer>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CashDeposit {
    pub deposit_id: String,
    pub company_id: String,
    pub sender_id: AccountId,
    pub submitted: U128,
    pub accepted: U128,
    pub unused: U128,
    pub accepted_at_ms: U64,
    pub accepted_height: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CashRound {
    pub stage: CashStage,
    pub accounts: Vec<CashAccount>,
    pub deposits: Vec<CashDeposit>,
}

impl CashRound {
    pub(crate) fn new(terms: &CashTerms) -> Self {
        Self {
            stage: CashStage::Funding,
            accounts: terms
                .positions
                .iter()
                .map(|position| CashAccount {
                    company_id: position.company_id.clone(),
                    destination: position.destination.clone(),
                    deposit_due: position.deposit_due,
                    credit_due: position.credit_due,
                    deposited: U128(0),
                    credit_available: U128(0),
                    credit_paid: U128(0),
                    refund_available: U128(0),
                    refund_paid: U128(0),
                    nonce: U64(0),
                    pending: None,
                    last_transfer: None,
                })
                .collect(),
            deposits: Vec::new(),
        }
    }
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct FundingMessage {
    kind: String,
    round_id: String,
    manifest_hash: String,
    company_id: String,
    deposit_id: String,
}

#[ext_contract(ext_cash_token)]
#[allow(dead_code)]
trait CashToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Clearing {
    #[payable]
    pub fn enable_cash(&mut self, network: String, testnet_token_contract: Option<AccountId>) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER");
        require!(self.cash_network.is_none(), "CASH_ALREADY_CONFIGURED");
        require!(
            match network.as_str() {
                "mainnet" =>
                    self.token_contract.as_str() == MAINNET_USDC && testnet_token_contract.is_none(),
                "testnet" => testnet_token_contract.as_ref() == Some(&self.token_contract),
                _ => false,
            },
            "INVALID_CASH_TOKEN_OR_NETWORK"
        );
        self.cash_network = Some(network);
    }

    pub fn get_cash_round(&self, round_id: String) -> Option<CashRound> {
        self.rounds
            .get(&round_id)
            .and_then(|round| round.cash.clone())
    }

    pub fn get_cash_deposit(
        &self,
        round_id: String,
        company_id: String,
        deposit_id: String,
    ) -> Option<CashDeposit> {
        self.rounds
            .get(&round_id)
            .and_then(|round| round.cash.as_ref())
            .and_then(|cash| {
                cash.deposits.iter().find(|deposit| {
                    deposit.company_id == company_id && deposit.deposit_id == deposit_id
                })
            })
            .cloned()
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if self.paused
            || env::predecessor_account_id() != self.token_contract
            || amount.0 == 0
            || msg.len() > 1024
        {
            return PromiseOrValue::Value(amount);
        }
        let Ok(message) = serde_json::from_str::<FundingMessage>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if message.kind != "razor_clearing_cash_v1" || !valid_deposit_id(&message.deposit_id) {
            return PromiseOrValue::Value(amount);
        }
        let Some(mut round) = self.rounds.get(&message.round_id).cloned() else {
            return PromiseOrValue::Value(amount);
        };
        if round.hash != message.manifest_hash
            || round.status != "ready"
            || env::block_timestamp_ms() >= round.manifest.expires_at_ms.0
            || round.consents.len() != round.manifest.participants.len()
        {
            return PromiseOrValue::Value(amount);
        }
        let Some(cash) = round.cash.as_mut() else {
            return PromiseOrValue::Value(amount);
        };
        if cash.stage != CashStage::Funding
            || cash
                .deposits
                .iter()
                .any(|deposit| deposit.deposit_id == message.deposit_id)
            || cash
                .deposits
                .iter()
                .filter(|deposit| deposit.company_id == message.company_id)
                .count()
                >= MAX_DEPOSITS_PER_COMPANY as usize
        {
            return PromiseOrValue::Value(amount);
        }
        let Some(account) = cash.accounts.iter_mut().find(|account| {
            account.company_id == message.company_id && account.destination == sender_id
        }) else {
            return PromiseOrValue::Value(amount);
        };
        let accepted = amount.0.min(account.deposit_due.0 - account.deposited.0);
        let (Some(accepted_total), Some(available)) = (
            self.cash_accepted.checked_add(accepted),
            self.cash_available.checked_add(accepted),
        ) else {
            return PromiseOrValue::Value(amount);
        };
        if accepted == 0 {
            return PromiseOrValue::Value(amount);
        }
        let unused = U128(amount.0 - accepted);
        account.deposited = U128(account.deposited.0 + accepted);
        let deposit = CashDeposit {
            deposit_id: message.deposit_id,
            company_id: message.company_id,
            sender_id,
            submitted: amount,
            accepted: U128(accepted),
            unused,
            accepted_at_ms: U64(env::block_timestamp_ms()),
            accepted_height: U64(env::block_height()),
        };
        cash.deposits.push(deposit.clone());
        self.cash_accepted = accepted_total;
        self.cash_available = available;
        self.rounds.insert(message.round_id.clone(), round);
        emit(
            "cash_deposit_accepted",
            serde_json::json!({"round_id":message.round_id,"manifest_hash":message.manifest_hash,
            "deposit_id":deposit.deposit_id,"company_id":deposit.company_id,"sender_id":deposit.sender_id,"submitted":deposit.submitted,
            "accepted":deposit.accepted,"unused":deposit.unused,"accepted_at_ms":deposit.accepted_at_ms,"accepted_height":deposit.accepted_height}),
        );
        PromiseOrValue::Value(unused)
    }

    #[payable]
    pub fn withdraw_cash(
        &mut self,
        round_id: String,
        manifest_hash: String,
        company_id: String,
        kind: CashKind,
        expected_nonce: U64,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        let mut round = self.rounds.get(&round_id).expect("ROUND_NOT_FOUND").clone();
        require!(round.hash == manifest_hash, "HASH_MISMATCH");
        let cash = round.cash.as_mut().expect("CASH_ROUND_REQUIRED");
        require!(
            matches!(
                (cash.stage, kind),
                (CashStage::Credits, CashKind::Credit) | (CashStage::Refunds, CashKind::Refund)
            ),
            "CASH_NOT_WITHDRAWABLE"
        );
        let account = cash
            .accounts
            .iter_mut()
            .find(|account| account.company_id == company_id)
            .expect("PARTICIPANT_REQUIRED");
        require!(
            env::predecessor_account_id() == account.destination
                && env::signer_account_id() == account.destination,
            "ONLY_FIXED_OWNER"
        );
        require!(account.pending.is_none(), "CASH_TRANSFER_PENDING");
        let nonce = account.nonce.0.checked_add(1).expect("NONCE_OVERFLOW");
        require!(expected_nonce.0 == nonce, "CASH_NONCE_MISMATCH");
        let amount = match kind {
            CashKind::Credit => account.credit_available,
            CashKind::Refund => account.refund_available,
        };
        require!(amount.0 > 0, "CASH_BALANCE_EMPTY");
        let available = self
            .cash_available
            .checked_sub(amount.0)
            .expect("CASH_ACCOUNTING_MISMATCH");
        let pending = self
            .cash_pending
            .checked_add(amount.0)
            .expect("AMOUNT_OVERFLOW");
        let receiver = account.destination.clone();
        match kind {
            CashKind::Credit => account.credit_available = U128(0),
            CashKind::Refund => account.refund_available = U128(0),
        }
        account.nonce = expected_nonce;
        account.pending = Some(CashPending {
            kind,
            nonce: expected_nonce,
            amount,
            receiver: receiver.clone(),
        });
        self.cash_available = available;
        self.cash_pending = pending;
        self.rounds.insert(round_id.clone(), round);
        emit(
            "cash_withdrawal_started",
            serde_json::json!({"round_id":round_id,"company_id":company_id,"kind":kind,"nonce":expected_nonce,"amount":amount,"receiver":receiver}),
        );
        ext_cash_token::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(
                receiver,
                amount,
                Some(format!("razor-clearing:{round_id}:{nonce}")),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(35))
                    .on_cash_withdrawn(round_id, company_id, kind, expected_nonce, amount),
            )
    }

    #[private]
    pub fn on_cash_withdrawn(
        &mut self,
        round_id: String,
        company_id: String,
        kind: CashKind,
        nonce: U64,
        amount: U128,
    ) -> bool {
        if env::promise_results_count() != 1 {
            return false;
        }
        let Some(mut round) = self.rounds.get(&round_id).cloned() else {
            return false;
        };
        let Some(cash) = round.cash.as_mut() else {
            return false;
        };
        let Some(account) = cash
            .accounts
            .iter_mut()
            .find(|account| account.company_id == company_id)
        else {
            return false;
        };
        if !account.pending.as_ref().is_some_and(|pending| {
            pending.kind == kind
                && pending.nonce == nonce
                && pending.amount == amount
                && pending.receiver == account.destination
        }) {
            return false;
        }
        let success = match env::promise_result_checked(0, 1024) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        self.cash_pending = self
            .cash_pending
            .checked_sub(amount.0)
            .expect("CASH_ACCOUNTING_MISMATCH");
        if success {
            let paid = match kind {
                CashKind::Credit => &mut account.credit_paid,
                CashKind::Refund => &mut account.refund_paid,
            };
            paid.0 = paid.0.checked_add(amount.0).expect("AMOUNT_OVERFLOW");
            self.cash_paid = self
                .cash_paid
                .checked_add(amount.0)
                .expect("AMOUNT_OVERFLOW");
        } else {
            let available = match kind {
                CashKind::Credit => &mut account.credit_available,
                CashKind::Refund => &mut account.refund_available,
            };
            available.0 = available.0.checked_add(amount.0).expect("AMOUNT_OVERFLOW");
            self.cash_available = self
                .cash_available
                .checked_add(amount.0)
                .expect("AMOUNT_OVERFLOW");
        }
        account.pending = None;
        account.last_transfer = Some(CashTransfer {
            kind,
            nonce,
            amount,
            status: if success { "paid" } else { "failed" }.into(),
        });
        self.rounds.insert(round_id.clone(), round);
        emit(
            "cash_withdrawal_resolved",
            serde_json::json!({"round_id":round_id,"company_id":company_id,"kind":kind,"nonce":nonce,"amount":amount,"succeeded":success}),
        );
        success
    }
}

impl Clearing {
    pub(crate) fn require_cash_configuration(&self, manifest: &Manifest) {
        if let Some(terms) = &manifest.cash {
            require!(
                self.cash_network.as_ref() == Some(&terms.network)
                    && terms.token_contract == self.token_contract,
                "CASH_SETUP_REQUIRED"
            );
        }
    }
}

pub(crate) fn validate_terms(manifest: &Manifest) {
    let Some(terms) = &manifest.cash else { return };
    require!(
        terms.mode == MODE
            && terms.refund_policy == REFUND_POLICY
            && ["mainnet", "testnet"].contains(&terms.network.as_str())
            && (terms.network != "mainnet" || terms.token_contract.as_str() == MAINNET_USDC)
            && terms.positions.len() == manifest.participants.len(),
        "INVALID_CASH_TERMS"
    );
    let mut outgoing = BTreeMap::<&str, u128>::new();
    let mut incoming = BTreeMap::<&str, u128>::new();
    for edge in &manifest.obligations {
        let out = outgoing.entry(&edge.debtor).or_default();
        *out = out.checked_add(edge.original.0).expect("AMOUNT_OVERFLOW");
        let received = incoming.entry(&edge.creditor).or_default();
        *received = received
            .checked_add(edge.original.0)
            .expect("AMOUNT_OVERFLOW");
    }
    let mut total_due = 0u128;
    let mut total_credit = 0u128;
    for (party, position) in manifest.participants.iter().zip(&terms.positions) {
        let payable = *outgoing.get(party.company_id.as_str()).unwrap_or(&0);
        let receivable = *incoming.get(party.company_id.as_str()).unwrap_or(&0);
        require!(
            position.company_id == party.company_id
                && position.destination == party.owner_id
                && position.deposit_due.0 == payable.saturating_sub(receivable)
                && position.credit_due.0 == receivable.saturating_sub(payable),
            "CASH_NET_POSITION_MISMATCH"
        );
        total_due = total_due
            .checked_add(position.deposit_due.0)
            .expect("AMOUNT_OVERFLOW");
        total_credit = total_credit
            .checked_add(position.credit_due.0)
            .expect("AMOUNT_OVERFLOW");
    }
    require!(
        total_due > 0 && total_due == total_credit,
        "CASH_CONSERVATION_FAILED"
    );
}

pub(crate) fn require_exact_funding(round: &Round) {
    if let Some(cash) = &round.cash {
        require!(
            cash.stage == CashStage::Funding
                && cash
                    .accounts
                    .iter()
                    .all(|account| account.deposited == account.deposit_due),
            "CASH_EXACT_FUNDING_REQUIRED"
        );
    }
}

pub(crate) fn finalize_cash(round: &mut Round) {
    require_exact_funding(round);
    if let Some(cash) = &mut round.cash {
        cash.stage = CashStage::Credits;
        for account in &mut cash.accounts {
            account.credit_available = account.credit_due;
        }
    }
}

pub(crate) fn refund_cash(round: &mut Round) {
    if let Some(cash) = &mut round.cash {
        if cash.stage == CashStage::Funding {
            cash.stage = CashStage::Refunds;
            for account in &mut cash.accounts {
                account.refund_available = account.deposited;
            }
        }
    }
}

fn valid_deposit_id(value: &str) -> bool {
    (8..=100).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn emit(event: &str, value: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        serde_json::json!({"standard":"razor-clearing","version":"2.0.0","event":event,"data":[value]})
    ));
}
