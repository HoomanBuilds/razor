use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue, env,
    ext_contract,
    json_types::{U64, U128},
    near, require,
    serde_json::{self, json},
    store::LookupMap,
};

#[path = "../../native-reserve.rs"]
mod native_reserve;

const MAINNET_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DAY: u64 = 86_400_000;
const STORAGE_BYTES: u64 = 32_768;

#[near(serializers=[borsh,json])]
#[derive(Clone)]
#[serde(deny_unknown_fields)]
pub struct Terms {
    pub id: String,
    pub request_id: String,
    pub company_id: String,
    pub borrower: AccountId,
    pub lender: AccountId,
    pub principal: U128,
    pub interest: U128,
    pub fee: U128,
    pub collateral: U128,
    pub tenor_ms: U64,
    pub grace_ms: U64,
    pub fund_by_ms: U64,
    pub repayment_source: String,
    pub receivable_hash: Option<String>,
    pub waterfall: String,
    pub default_rule: String,
    pub collateral_rule: String,
    pub dispute_rule: String,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Pending {
    pub kind: String,
    pub nonce: U64,
    pub amount: U128,
    pub receiver: AccountId,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Loan {
    pub terms: Terms,
    pub terms_json: String,
    pub terms_hash: String,
    pub stage: String,
    pub principal_funded: U128,
    pub collateral_funded: U128,
    pub advanced: U128,
    pub principal_paid: U128,
    pub interest_paid: U128,
    pub fee_paid: U128,
    pub cash_repaid: U128,
    pub collateral_applied: U128,
    pub lender_credit: U128,
    pub lender_withdrawn: U128,
    pub borrower_refund: U128,
    pub borrower_withdrawn: U128,
    pub activated_at_ms: Option<U64>,
    pub due_at_ms: Option<U64>,
    pub nonce: U64,
    pub pending: Option<Pending>,
    pub disputed: bool,
    pub dispute_nonce: U64,
    pub borrower_resumed: bool,
    pub lender_resumed: bool,
    pub principal_deposits: u8,
    pub collateral_deposits: u8,
    pub repayments: u8,
    pub voided_deposits: u8,
}
#[near(serializers=[json])]
#[serde(deny_unknown_fields)]
struct Deposit {
    loan_id: String,
    terms_hash: String,
    kind: String,
    deposit_id: String,
}
#[near(serializers=[json])]
struct TreasuryCredit {
    credited_at_ms: U64,
    company_id: String,
    deposit_id: String,
    token_contract: AccountId,
    sender_id: AccountId,
    amount: U128,
    kind: String,
}
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
}
#[ext_contract(ext_treasury)]
#[allow(dead_code)]
trait SharedTreasury {
    fn get_deposit(
        &self,
        company_id: String,
        deposit_id: String,
        credit_id: Option<U64>,
    ) -> Option<TreasuryCredit>;
}
#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_advanced(&mut self, loan_id: String, nonce: U64) -> bool;
    fn on_advance_recovered(&mut self, loan_id: String, nonce: U64) -> bool;
    fn on_withdrawn(&mut self, loan_id: String, nonce: U64) -> bool;
}
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Credit {
    owner_id: AccountId,
    token_contract: AccountId,
    treasury_id: AccountId,
    network: String,
    paused: bool,
    native_storage_base_bytes: u64,
    native_customer_deposits: u128,
    loans: LookupMap<String, Loan>,
    deposits: LookupMap<Vec<u8>, bool>,
}

#[near]
impl Credit {
    #[init]
    pub fn new(
        owner_id: AccountId,
        token_contract: AccountId,
        treasury_id: AccountId,
        network: String,
    ) -> Self {
        require!(
            owner_id != env::current_account_id()
                && token_contract != env::current_account_id()
                && treasury_id != env::current_account_id(),
            "INVALID_IDENTITY"
        );
        require!(
            network == "mainnet" || network == "testnet",
            "INVALID_NETWORK"
        );
        require!(
            network != "mainnet" || token_contract.as_str() == MAINNET_USDC,
            "NATIVE_USDC_REQUIRED"
        );
        Self {
            owner_id,
            token_contract,
            treasury_id,
            network,
            paused: false,
            native_storage_base_bytes: 0,
            native_customer_deposits: 0,
            loans: LookupMap::new(b"c"),
            deposits: LookupMap::new(b"d"),
        }
    }
    pub fn get_native_reserve(&self) -> native_reserve::NativeReserveView {
        native_reserve::reserve_view(self.protected_native_storage())
    }
    #[payable]
    pub fn withdraw_native_reserve(&mut self, amount: U128) -> Promise {
        native_reserve::withdraw(&self.owner_id, amount, self.protected_native_storage())
    }
    pub fn get_config(&self) -> serde_json::Value {
        json!({"version":2,"network":self.network,"token_contract":self.token_contract,"treasury_id":self.treasury_id,"paused":self.paused,"storage_bytes":U64(STORAGE_BYTES),"minimum_registration_deposit":self.registration_cost()})
    }
    pub fn registration_cost(&self) -> U128 {
        U128(
            (STORAGE_BYTES as u128)
                .checked_mul(env::storage_byte_cost().as_yoctonear())
                .expect("STORAGE_OVERFLOW"),
        )
    }
    pub fn get_loan(&self, loan_id: String) -> Option<Loan> {
        self.loans.get(&loan_id).cloned()
    }
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        near_sdk::assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ONLY_OPERATOR"
        );
        self.paused = paused;
    }
    #[payable]
    pub fn register_loan(&mut self, terms_json: String, terms_hash: String) -> Loan {
        require!(!self.paused, "PAUSED");
        require!(terms_json.len() <= 4096, "TERMS_TOO_LARGE");
        let terms: Terms = serde_json::from_str(&terms_json).expect("INVALID_TERMS");
        require!(
            digest(terms_json.as_bytes()) == terms_hash,
            "TERMS_HASH_MISMATCH"
        );
        require!(
            valid_id(&terms.id)
                && valid_id(&terms.request_id)
                && terms.borrower != terms.lender
                && terms.id
                    == digest(format!("{}:{}", terms.borrower, terms.request_id).as_bytes()),
            "INVALID_PARTIES"
        );
        require!(
            env::predecessor_account_id() == terms.borrower
                && env::signer_account_id() == terms.borrower,
            "ONLY_BORROWER"
        );
        let owner_hash = digest(terms.borrower.as_bytes());
        require!(
            (20..=120).contains(&terms.company_id.len())
                && terms
                    .company_id
                    .rsplit_once(':')
                    .is_some_and(|(_, suffix)| suffix == &owner_hash[..16]),
            "COMPANY_OWNER_BINDING_MISMATCH"
        );
        require!(
            terms.principal.0 > 0
                && terms.principal.0 <= 10u128.pow(30)
                && terms.collateral.0 <= 10u128.pow(30)
                && add(terms.interest.0, terms.fee.0) <= terms.principal.0,
            "INVALID_AMOUNTS"
        );
        require!(
            (DAY..=366 * DAY).contains(&terms.tenor_ms.0)
                && terms.grace_ms.0 <= 30 * DAY
                && terms.fund_by_ms.0 > now()
                && terms.fund_by_ms.0 <= now().checked_add(30 * DAY).expect("TIME_OVERFLOW"),
            "INVALID_WINDOW"
        );
        require!(
            !terms.repayment_source.is_empty()
                && terms.repayment_source.len() <= 500
                && terms.receivable_hash.as_ref().is_none_or(
                    |hash| hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
                ),
            "INVALID_REPAYMENT_SOURCE"
        );
        require!(
            terms.waterfall == "principal_interest_fee"
                && terms.default_rule == "fixed_bond_only_after_due_plus_grace"
                && terms.collateral_rule == "remaining_bond_to_borrower"
                && terms.dispute_rule == "bilateral_resume_no_repricing",
            "UNSUPPORTED_RULES"
        );
        require!(!self.loans.contains_key(&terms.id), "LOAN_EXISTS");
        require!(
            env::attached_deposit().as_yoctonear() >= self.registration_cost().0,
            "STORAGE_DEPOSIT_REQUIRED"
        );
        if self.native_customer_deposits == 0 {
            self.native_storage_base_bytes = env::storage_usage();
        }
        self.native_customer_deposits = self
            .native_customer_deposits
            .checked_add(env::attached_deposit().as_yoctonear())
            .expect("NATIVE_STORAGE_OVERFLOW");
        let loan = Loan {
            terms: terms.clone(),
            terms_json,
            terms_hash,
            stage: "funding".into(),
            principal_funded: U128(0),
            collateral_funded: U128(0),
            advanced: U128(0),
            principal_paid: U128(0),
            interest_paid: U128(0),
            fee_paid: U128(0),
            cash_repaid: U128(0),
            collateral_applied: U128(0),
            lender_credit: U128(0),
            lender_withdrawn: U128(0),
            borrower_refund: U128(0),
            borrower_withdrawn: U128(0),
            activated_at_ms: None,
            due_at_ms: None,
            nonce: U64(0),
            pending: None,
            disputed: false,
            dispute_nonce: U64(0),
            borrower_resumed: false,
            lender_resumed: false,
            principal_deposits: 0,
            collateral_deposits: 0,
            repayments: 0,
            voided_deposits: 0,
        };
        self.loans.insert(terms.id.clone(), loan.clone());
        emit(
            "loan_registered",
            json!({"loan_id":terms.id,"terms_hash":loan.terms_hash}),
        );
        loan
    }
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        if env::predecessor_account_id() != self.token_contract || amount.0 == 0 || msg.len() > 1024
        {
            return PromiseOrValue::Value(amount);
        }
        let Ok(message) = serde_json::from_str::<Deposit>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        if !valid_id(&message.deposit_id) {
            return PromiseOrValue::Value(amount);
        }
        let key = env::sha256(format!("{}:{}", message.loan_id, message.deposit_id).as_bytes());
        if self.deposits.contains_key(&key) {
            return PromiseOrValue::Value(amount);
        }
        let Some(mut loan) = self.loans.get(&message.loan_id).cloned() else {
            return PromiseOrValue::Value(amount);
        };
        if message.terms_hash != loan.terms_hash || loan.pending.is_some() {
            return PromiseOrValue::Value(amount);
        }
        let remaining = match message.kind.as_str() {
            "principal"
                if !self.paused
                    && loan.stage == "funding"
                    && now() < loan.terms.fund_by_ms.0
                    && sender_id == loan.terms.lender
                    && loan.principal_deposits < 16 =>
            {
                loan.terms.principal.0 - loan.principal_funded.0
            }
            "collateral"
                if !self.paused
                    && loan.stage == "funding"
                    && now() < loan.terms.fund_by_ms.0
                    && sender_id == loan.terms.borrower
                    && loan.collateral_deposits < 16 =>
            {
                loan.terms.collateral.0 - loan.collateral_funded.0
            }
            "repayment"
                if (loan.stage == "active" || loan.stage == "defaulted")
                    && sender_id == loan.terms.borrower
                    && loan.repayments < 32 =>
            {
                outstanding(&loan)
            }
            _ => return PromiseOrValue::Value(amount),
        };
        let accepted = amount.0.min(remaining);
        if accepted == 0 {
            return PromiseOrValue::Value(amount);
        }
        if (message.kind == "principal" && loan.principal_deposits == 15
            || message.kind == "collateral" && loan.collateral_deposits == 15
            || message.kind == "repayment" && loan.repayments == 31)
            && accepted != remaining
        {
            return PromiseOrValue::Value(amount);
        }
        match message.kind.as_str() {
            "principal" => {
                loan.principal_funded = U128(add(loan.principal_funded.0, accepted));
                loan.principal_deposits += 1;
            }
            "collateral" => {
                loan.collateral_funded = U128(add(loan.collateral_funded.0, accepted));
                loan.collateral_deposits += 1;
            }
            _ => {
                allocate(&mut loan, accepted);
                loan.cash_repaid = U128(add(loan.cash_repaid.0, accepted));
                loan.repayments += 1;
                settle(&mut loan);
            }
        }
        self.deposits.insert(key, true);
        self.loans.insert(message.loan_id.clone(), loan);
        emit(
            "loan_deposit",
            json!({"loan_id":message.loan_id,"deposit_id":message.deposit_id,"kind":message.kind,"amount":U128(accepted),"sender_id":sender_id}),
        );
        PromiseOrValue::Value(U128(amount.0 - accepted))
    }
    pub fn deposit_seen(&self, loan_id: String, deposit_id: String) -> bool {
        self.deposits
            .contains_key(&env::sha256(format!("{loan_id}:{deposit_id}").as_bytes()))
    }
    #[payable]
    pub fn void_deposit(
        &mut self,
        loan_id: String,
        terms_hash: String,
        deposit_id: String,
    ) -> bool {
        near_sdk::assert_one_yocto();
        let mut loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        require!(valid_id(&deposit_id), "INVALID_DEPOSIT_ID");
        let key = env::sha256(format!("{loan_id}:{deposit_id}").as_bytes());
        if self.deposits.contains_key(&key) {
            return true;
        }
        require!(loan.voided_deposits < 32, "VOID_CAPACITY");
        loan.voided_deposits += 1;
        self.deposits.insert(key, true);
        self.loans.insert(loan_id, loan);
        true
    }
    #[payable]
    pub fn advance(&mut self, loan_id: String, terms_hash: String) -> Promise {
        near_sdk::assert_one_yocto();
        require!(!self.paused, "PAUSED");
        let mut loan = self.load(&loan_id, &terms_hash);
        borrower(&loan);
        require!(
            loan.stage == "funding"
                && !loan.disputed
                && loan.pending.is_none()
                && now() < loan.terms.fund_by_ms.0,
            "ADVANCE_HELD"
        );
        require!(
            loan.principal_funded == loan.terms.principal
                && loan.collateral_funded == loan.terms.collateral,
            "EXACT_FUNDING_REQUIRED"
        );
        loan.nonce = U64(loan.nonce.0.checked_add(1).expect("NONCE_OVERFLOW"));
        let nonce = loan.nonce;
        let amount = loan.terms.principal;
        loan.pending = Some(Pending {
            kind: "advance".into(),
            nonce,
            amount,
            receiver: self.treasury_id.clone(),
        });
        loan.stage = "advance_pending".into();
        let msg=json!({"company_id":loan.terms.company_id,"deposit_id":format!("loan:{loan_id}"),"kind":"funding"}).to_string();
        self.loans.insert(loan_id.clone(), loan);
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(100))
            .ft_transfer_call(self.treasury_id.clone(), amount, None, msg)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_advanced(loan_id, nonce),
            )
    }
    #[private]
    pub fn on_advanced(&mut self, loan_id: String, nonce: U64) -> bool {
        let Some(mut loan) = self.loans.get(&loan_id).cloned() else {
            return false;
        };
        if !advance_pending(&loan, nonce) {
            return false;
        }
        let used = match env::promise_result_checked(0, 128) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes).ok(),
            _ => None,
        };
        if used == Some(loan.terms.principal) {
            activate(&mut loan);
            self.loans.insert(loan_id.clone(), loan);
            emit("loan_advanced", json!({"loan_id":loan_id,"nonce":nonce}));
            true
        } else if used == Some(U128(0)) {
            loan.pending = None;
            loan.stage = "funding".into();
            self.loans.insert(loan_id, loan);
            false
        } else {
            false
        }
    }
    pub fn recover_advance(
        &mut self,
        loan_id: String,
        terms_hash: String,
        credit_id: Option<U64>,
    ) -> Promise {
        let loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        let pending = loan.pending.as_ref().expect("NO_PENDING_ADVANCE");
        require!(pending.kind == "advance", "NOT_ADVANCE");
        ext_treasury::ext(self.treasury_id.clone())
            .with_static_gas(Gas::from_tgas(10))
            .get_deposit(loan.terms.company_id, format!("loan:{loan_id}"), credit_id)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .on_advance_recovered(loan_id, pending.nonce),
            )
    }
    #[private]
    pub fn on_advance_recovered(&mut self, loan_id: String, nonce: U64) -> bool {
        let Some(mut loan) = self.loans.get(&loan_id).cloned() else {
            return false;
        };
        if !advance_pending(&loan, nonce) {
            return false;
        }
        let credit = env::promise_result_checked(0, 2048)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Option<TreasuryCredit>>(&bytes).ok())
            .flatten();
        let Some(credit) = credit else { return false };
        if !(credit.company_id == loan.terms.company_id
            && credit.deposit_id == format!("loan:{loan_id}")
            && credit.token_contract == self.token_contract
            && credit.sender_id == env::current_account_id()
            && credit.amount == loan.terms.principal
            && credit.kind == "funding"
            && credit.credited_at_ms.0 > 0
            && credit.credited_at_ms.0 <= now()
            && credit
                .credited_at_ms
                .0
                .checked_add(loan.terms.tenor_ms.0)
                .is_some())
        {
            return false;
        }
        activate_at(&mut loan, credit.credited_at_ms.0);
        self.loans.insert(loan_id.clone(), loan);
        emit(
            "loan_advanced_recovered",
            json!({"loan_id":loan_id,"nonce":nonce}),
        );
        true
    }
    #[payable]
    pub fn cancel(&mut self, loan_id: String, terms_hash: String) -> Loan {
        near_sdk::assert_one_yocto();
        let mut loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        require!(
            loan.stage == "funding" && loan.pending.is_none() && !loan.disputed,
            "CANCELLATION_HELD"
        );
        require!(
            now() >= loan.terms.fund_by_ms.0
                || env::predecessor_account_id() == loan.terms.borrower,
            "FUNDING_WINDOW_ACTIVE"
        );
        loan.lender_credit = U128(add(loan.lender_credit.0, loan.principal_funded.0));
        loan.borrower_refund = U128(add(loan.borrower_refund.0, loan.collateral_funded.0));
        loan.stage = "cancelled".into();
        self.loans.insert(loan_id, loan.clone());
        loan
    }
    #[payable]
    pub fn default_loan(&mut self, loan_id: String, terms_hash: String) -> Loan {
        near_sdk::assert_one_yocto();
        let mut loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        require!(
            loan.stage == "active" && !loan.disputed && loan.pending.is_none(),
            "DEFAULT_HELD"
        );
        require!(
            now()
                >= loan
                    .due_at_ms
                    .expect("ADVANCE_REQUIRED")
                    .0
                    .checked_add(loan.terms.grace_ms.0)
                    .expect("TIME_OVERFLOW"),
            "GRACE_ACTIVE"
        );
        let applied = loan.collateral_funded.0.min(outstanding(&loan));
        allocate(&mut loan, applied);
        loan.collateral_applied = U128(applied);
        loan.borrower_refund = U128(loan.collateral_funded.0 - applied);
        loan.stage = "defaulted".into();
        settle(&mut loan);
        self.loans.insert(loan_id, loan.clone());
        loan
    }
    #[payable]
    pub fn dispute(&mut self, loan_id: String, terms_hash: String) -> Loan {
        near_sdk::assert_one_yocto();
        let mut loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        require!(
            !loan.disputed
                && loan.pending.is_none()
                && ["funding", "active", "defaulted"].contains(&loan.stage.as_str()),
            "DISPUTE_HELD"
        );
        loan.disputed = true;
        loan.dispute_nonce = U64(loan.dispute_nonce.0.checked_add(1).expect("NONCE_OVERFLOW"));
        loan.borrower_resumed = false;
        loan.lender_resumed = false;
        self.loans.insert(loan_id, loan.clone());
        loan
    }
    #[payable]
    pub fn resume(&mut self, loan_id: String, terms_hash: String, dispute_nonce: U64) -> Loan {
        near_sdk::assert_one_yocto();
        let mut loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        require!(
            loan.disputed && loan.dispute_nonce == dispute_nonce,
            "DISPUTE_CHANGED"
        );
        if env::predecessor_account_id() == loan.terms.borrower {
            loan.borrower_resumed = true
        } else {
            loan.lender_resumed = true
        }
        if loan.borrower_resumed && loan.lender_resumed {
            loan.disputed = false
        }
        self.loans.insert(loan_id, loan.clone());
        loan
    }
    #[payable]
    pub fn withdraw(
        &mut self,
        loan_id: String,
        terms_hash: String,
        expected_nonce: U64,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        let mut loan = self.load(&loan_id, &terms_hash);
        party(&loan);
        require!(loan.pending.is_none(), "TRANSFER_PENDING");
        let (kind, amount, receiver) = if env::predecessor_account_id() == loan.terms.lender {
            ("lender", loan.lender_credit, loan.terms.lender.clone())
        } else {
            (
                "borrower",
                loan.borrower_refund,
                loan.terms.borrower.clone(),
            )
        };
        require!(amount.0 > 0, "NO_WITHDRAWABLE_CREDIT");
        let nonce = U64(loan.nonce.0.checked_add(1).expect("NONCE_OVERFLOW"));
        require!(expected_nonce == nonce, "NONCE_CHANGED");
        if kind == "lender" {
            loan.lender_credit = U128(0)
        } else {
            loan.borrower_refund = U128(0)
        }
        loan.nonce = nonce;
        loan.pending = Some(Pending {
            kind: kind.into(),
            nonce,
            amount,
            receiver: receiver.clone(),
        });
        self.loans.insert(loan_id.clone(), loan);
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(
                receiver,
                amount,
                Some(format!("razor-loan:{loan_id}:{}", nonce.0)),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .on_withdrawn(loan_id, nonce),
            )
    }
    #[private]
    pub fn on_withdrawn(&mut self, loan_id: String, nonce: U64) -> bool {
        let Some(mut loan) = self.loans.get(&loan_id).cloned() else {
            return false;
        };
        let Some(pending) = loan.pending.clone() else {
            return false;
        };
        if pending.nonce != nonce || !["lender", "borrower"].contains(&pending.kind.as_str()) {
            return false;
        }
        let success = match env::promise_result_checked(0, 0) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        if pending.kind == "lender" {
            if success {
                loan.lender_withdrawn = U128(add(loan.lender_withdrawn.0, pending.amount.0))
            } else {
                loan.lender_credit = U128(add(loan.lender_credit.0, pending.amount.0))
            }
        } else if success {
            loan.borrower_withdrawn = U128(add(loan.borrower_withdrawn.0, pending.amount.0))
        } else {
            loan.borrower_refund = U128(add(loan.borrower_refund.0, pending.amount.0))
        }
        loan.pending = None;
        self.loans.insert(loan_id.clone(), loan);
        emit(
            "loan_withdrawal_resolved",
            json!({"loan_id":loan_id,"kind":pending.kind,"nonce":nonce,"amount":pending.amount,"succeeded":success}),
        );
        success
    }
}
impl Credit {
    fn protected_native_storage(&self) -> u128 {
        let price = env::storage_byte_cost().as_yoctonear();
        let baseline = (self.native_storage_base_bytes as u128)
            .checked_mul(price)
            .expect("NATIVE_STORAGE_OVERFLOW");
        let protected = baseline
            .checked_add(self.native_customer_deposits)
            .expect("NATIVE_STORAGE_OVERFLOW");
        let used = (env::storage_usage() as u128)
            .checked_mul(price)
            .expect("NATIVE_STORAGE_OVERFLOW");
        protected.saturating_sub(used)
    }
    fn load(&self, id: &String, hash: &str) -> Loan {
        let loan = self.loans.get(id).cloned().expect("LOAN_NOT_FOUND");
        require!(loan.terms_hash == hash, "TERMS_HASH_MISMATCH");
        loan
    }
}
fn borrower(loan: &Loan) {
    require!(
        env::predecessor_account_id() == loan.terms.borrower
            && env::signer_account_id() == loan.terms.borrower,
        "ONLY_BORROWER"
    )
}
fn party(loan: &Loan) {
    let actor = env::predecessor_account_id();
    require!(
        env::signer_account_id() == actor
            && (actor == loan.terms.borrower || actor == loan.terms.lender),
        "ONLY_PARTICIPANT"
    )
}
fn activate(loan: &mut Loan) {
    activate_at(loan, now());
}
fn activate_at(loan: &mut Loan, advanced_at_ms: u64) {
    loan.advanced = loan.terms.principal;
    loan.activated_at_ms = Some(U64(advanced_at_ms));
    loan.due_at_ms = Some(U64(advanced_at_ms
        .checked_add(loan.terms.tenor_ms.0)
        .expect("TIME_OVERFLOW")));
    loan.pending = None;
    loan.stage = "active".into();
}
fn advance_pending(loan: &Loan, nonce: U64) -> bool {
    loan.stage == "advance_pending"
        && loan.pending.as_ref().is_some_and(|pending| {
            pending.kind == "advance"
                && pending.nonce == nonce
                && pending.amount == loan.terms.principal
        })
}
fn outstanding(loan: &Loan) -> u128 {
    add(
        add(
            loan.terms.principal.0 - loan.principal_paid.0,
            loan.terms.interest.0 - loan.interest_paid.0,
        ),
        loan.terms.fee.0 - loan.fee_paid.0,
    )
}
fn allocate(loan: &mut Loan, amount: u128) {
    let principal = amount.min(loan.terms.principal.0 - loan.principal_paid.0);
    loan.principal_paid = U128(add(loan.principal_paid.0, principal));
    let rest = amount - principal;
    let interest = rest.min(loan.terms.interest.0 - loan.interest_paid.0);
    loan.interest_paid = U128(add(loan.interest_paid.0, interest));
    let fee = rest - interest;
    require!(
        fee <= loan.terms.fee.0 - loan.fee_paid.0,
        "REPAYMENT_OVERFLOW"
    );
    loan.fee_paid = U128(add(loan.fee_paid.0, fee));
    loan.lender_credit = U128(add(loan.lender_credit.0, amount));
}
fn settle(loan: &mut Loan) {
    if outstanding(loan) == 0 {
        loan.stage = "repaid".into();
        loan.borrower_refund = U128(loan.collateral_funded.0 - loan.collateral_applied.0);
    }
}
fn add(a: u128, b: u128) -> u128 {
    a.checked_add(b).expect("AMOUNT_OVERFLOW")
}
fn now() -> u64 {
    env::block_timestamp_ms()
}
fn valid_id(value: &str) -> bool {
    (1..=100).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn digest(value: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let bytes = env::sha256(value);
    let mut out = String::with_capacity(64);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 15) as usize] as char)
    }
    out
}
fn emit(event: &str, data: serde_json::Value) {
    env::log_str(
        &json!({"standard":"razor-credit","version":"1.0.0","event":event,"data":[data]})
            .to_string(),
    );
}
