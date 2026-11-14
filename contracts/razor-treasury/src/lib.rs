mod core;
mod types;
pub use core::{RetainedAsset, RetainedWithdrawal, RetainedWithdrawalStatus};
pub use types::*;

use core::CompanyTreasury;
use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, ext_contract,
    json_types::{U64, U128},
    near, require,
    serde_json::json,
    store::LookupMap,
};

const REGISTRATION_BYTES: u64 = 8_192;
const EMERGENCY_BYTES: u64 = 1_024;

#[ext_contract(ext_pool_token)]
#[allow(dead_code)]
trait PoolToken {
    fn ft_balance_of(&self, account_id: AccountId) -> U128;
}

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_distribution_claim_result(
        &mut self,
        company_id: String,
        distribution_id: String,
        claim_id: String,
        nonce: U64,
    ) -> bool;
    fn on_source_recovery_verified(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        receipt: String,
        epoch: U64,
        pool_epoch: U64,
    ) -> bool;
    fn on_retained_recovery_verified(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        withdrawal_id: U64,
        receipt: String,
        epoch: U64,
        pool_epoch: U64,
    ) -> bool;
    fn on_transfer_result(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
    ) -> bool;
    fn on_balance_sync(&mut self, company_id: String, epoch: U64) -> bool;
    fn on_deposit_sync(&mut self, company_id: String, epoch: U64) -> U128;
    fn on_refund_verified(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        epoch: U64,
        pool_epoch: U64,
    ) -> bool;
    fn on_withdraw_result(&mut self, company_id: String, withdrawal_id: U64, amount: U128) -> bool;
    fn on_retained_balance_sync(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        epoch: U64,
    ) -> bool;
    fn on_retained_deposit_sync(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        epoch: U64,
    ) -> U128;
    fn on_retained_withdraw_result(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        withdrawal_id: U64,
    ) -> bool;
}

#[near(serializers = [json])]
pub struct PlatformConfig {
    pub architecture: String,
    pub version: u8,
    pub owner_id: AccountId,
    pub token_contract: AccountId,
    pub paused: bool,
    pub refund_reporter: Option<AccountId>,
    pub registration_storage_bytes: U64,
    pub minimum_registration_deposit: U128,
}

#[near(serializers = [json])]
pub struct RegistrationQuote {
    pub architecture: String,
    pub company_id: String,
    pub token_contract: AccountId,
    pub minimum_deposit: U128,
    pub storage_bytes: U64,
}

#[near(serializers = [json])]
pub struct StorageView {
    pub storage_credit: U128,
    pub storage_used: U128,
    pub storage_available: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct DepositCredit {
    pub credit_id: U64,
    pub company_id: String,
    pub deposit_id: String,
    pub token_contract: AccountId,
    pub sender_id: AccountId,
    pub amount: U128,
    pub kind: String,
    pub credited_at_ms: U64,
}

#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
struct DepositMessage {
    company_id: String,
    deposit_id: String,
    kind: String,
}

#[near(serializers = [borsh])]
struct RefundClaim {
    company_id: String,
    payment_id: String,
    attempt_id: String,
    amount: U128,
    credited: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Treasury {
    owner_id: AccountId,
    token_contract: AccountId,
    paused: bool,
    refund_reporter: Option<AccountId>,
    pool_epoch: u64,
    next_credit_id: u64,
    companies: LookupMap<String, CompanyTreasury>,
    deposits: LookupMap<u64, DepositCredit>,
    latest_deposits: LookupMap<String, U64>,
    liabilities: LookupMap<AccountId, u128>,
    refund_claims: LookupMap<String, RefundClaim>,
}

#[near]
impl Treasury {
    #[init]
    pub fn new(owner_id: AccountId, token_contract: AccountId) -> Self {
        require!(
            owner_id != env::current_account_id(),
            "OWNER_MUST_BE_RECOVERABLE"
        );
        require!(
            token_contract != env::current_account_id(),
            "INVALID_TOKEN_CONTRACT"
        );
        Self {
            owner_id,
            token_contract,
            paused: false,
            refund_reporter: None,
            pool_epoch: 0,
            next_credit_id: 0,
            companies: LookupMap::new(b"C"),
            deposits: LookupMap::new(b"D"),
            latest_deposits: LookupMap::new(b"J"),
            liabilities: LookupMap::new(b"L"),
            refund_claims: LookupMap::new(b"F"),
        }
    }

    pub fn get_platform_config(&self) -> PlatformConfig {
        PlatformConfig {
            architecture: "shared_v1".into(),
            version: 1,
            owner_id: self.owner_id.clone(),
            token_contract: self.token_contract.clone(),
            paused: self.paused,
            refund_reporter: self.refund_reporter.clone(),
            registration_storage_bytes: U64(REGISTRATION_BYTES),
            minimum_registration_deposit: U128(storage_cost(REGISTRATION_BYTES)),
        }
    }

    #[payable]
    pub fn set_platform_paused(&mut self, paused: bool) {
        self.assert_platform_owner();
        self.paused = paused;
    }

    #[payable]
    pub fn set_refund_reporter(&mut self, account_id: Option<AccountId>) {
        self.assert_platform_owner();
        require!(
            account_id.as_ref() != Some(&env::current_account_id()),
            "INVALID_REPORTER"
        );
        self.refund_reporter = account_id;
    }

    pub fn quote_registration(&self, company_id: String) -> RegistrationQuote {
        validate_company_id(&company_id);
        RegistrationQuote {
            architecture: "shared_v1".into(),
            company_id,
            token_contract: self.token_contract.clone(),
            minimum_deposit: U128(storage_cost(REGISTRATION_BYTES)),
            storage_bytes: U64(REGISTRATION_BYTES),
        }
    }

    #[payable]
    pub fn register_company(
        &mut self,
        company_id: String,
        per_payment_limit: U128,
        daily_limit: U128,
    ) -> ConfigView {
        require!(!self.paused, "PLATFORM_PAUSED");
        validate_company_id(&company_id);
        let expected_owner = env::sha256(env::predecessor_account_id().as_bytes())
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        require!(
            company_id.rsplit_once(':').map(|(_, suffix)| suffix) == Some(expected_owner.as_str()),
            "COMPANY_OWNER_BINDING_MISMATCH"
        );
        require!(
            !self.companies.contains_key(&company_id),
            "COMPANY_ALREADY_REGISTERED"
        );
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= storage_cost(REGISTRATION_BYTES),
            "INSUFFICIENT_REGISTRATION_STORAGE"
        );
        let before = env::storage_usage();
        let mut company = CompanyTreasury::new(
            company_id.clone(),
            env::predecessor_account_id(),
            self.token_contract.clone(),
            per_payment_limit,
            daily_limit,
        );
        company.storage_credit = attached;
        company.flush();
        self.companies.insert(company_id.clone(), company);
        self.flush();
        let used = storage_cost(
            env::storage_usage()
                .checked_sub(before)
                .expect("STORAGE_ACCOUNTING"),
        );
        require!(
            used <= attached.saturating_sub(storage_cost(EMERGENCY_BYTES)),
            "INSUFFICIENT_REGISTRATION_STORAGE"
        );
        let company = self
            .companies
            .get_mut(&company_id)
            .expect("COMPANY_NOT_FOUND");
        company.storage_used = used;
        company.get_config()
    }

    pub fn get_company(&self, company_id: String) -> Option<ConfigView> {
        self.companies
            .get(&company_id)
            .map(CompanyTreasury::get_config)
    }

    pub fn get_storage(&self, company_id: String) -> StorageView {
        let company = self.company(&company_id);
        StorageView {
            storage_credit: U128(company.storage_credit),
            storage_used: U128(company.storage_used),
            storage_available: U128(company.storage_credit.saturating_sub(company.storage_used)),
        }
    }

    #[payable]
    pub fn add_storage(&mut self, company_id: String) -> StorageView {
        let amount = env::attached_deposit().as_yoctonear();
        require!(amount > 0, "STORAGE_DEPOSIT_REQUIRED");
        let company = self
            .companies
            .get_mut(&company_id)
            .expect("COMPANY_NOT_FOUND");
        company.storage_credit = checked_add(company.storage_credit, amount);
        self.get_storage(company_id)
    }

    pub fn get_deposit(
        &self,
        company_id: String,
        deposit_id: String,
        credit_id: Option<U64>,
    ) -> Option<DepositCredit> {
        let credit_id = credit_id.or_else(|| {
            self.latest_deposits
                .get(&format!("{company_id}:{deposit_id}"))
                .copied()
        })?;
        self.deposits
            .get(&credit_id.0)
            .filter(|credit| credit.company_id == company_id && credit.deposit_id == deposit_id)
            .cloned()
    }

    pub fn get_pool_liability(&self, token_contract: AccountId) -> U128 {
        U128(*self.liabilities.get(&token_contract).unwrap_or(&0))
    }

    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(msg.len() <= 1024, "DEPOSIT_MESSAGE_TOO_LONG");
        let message: DepositMessage =
            near_sdk::serde_json::from_str(&msg).expect("SCOPED_DEPOSIT_MESSAGE_REQUIRED");
        validate_company_id(&message.company_id);
        validate_deposit_id(&message.deposit_id);
        require!(amount.0 > 0, "DEPOSIT_AMOUNT_REQUIRED");
        let token_contract = env::predecessor_account_id();
        require!(
            (message.kind == "funding" && token_contract == self.token_contract)
                || (message.kind == "retained" && token_contract != self.token_contract),
            "DEPOSIT_KIND_TOKEN_MISMATCH"
        );
        self.next_credit_id = self
            .next_credit_id
            .checked_add(1)
            .expect("CREDIT_ID_OVERFLOW");
        let credit = DepositCredit {
            credit_id: U64(self.next_credit_id),
            company_id: message.company_id.clone(),
            deposit_id: message.deposit_id.clone(),
            token_contract,
            sender_id: sender_id.clone(),
            amount,
            kind: message.kind.clone(),
            credited_at_ms: U64(env::block_timestamp_ms()),
        };
        self.company(&message.company_id);
        self.deposits.insert(credit.credit_id.0, credit.clone());
        self.latest_deposits.insert(
            format!("{}:{}", message.company_id, message.deposit_id),
            credit.credit_id,
        );
        let accepted = self.with_company(&message.company_id, |company| {
            company.ft_on_transfer(
                sender_id,
                amount,
                if message.kind == "retained" {
                    "razor:retain".into()
                } else {
                    String::new()
                },
            )
        });
        env::log_str(&format!(
            "EVENT_JSON:{}",
            json!({"standard":"razor","version":"2.0.0","event":"deposit_credited","data":[credit]})
        ));
        accepted
    }

    pub fn confirm_refund(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        refund_amount: U128,
        receipt: String,
    ) -> Promise {
        self.assert_refund_reporter();
        if let Some(claim) = self.refund_claims.get(&receipt) {
            require!(
                !claim.credited
                    && claim.company_id == company_id
                    && claim.payment_id == payment_id
                    && claim.attempt_id == attempt_id
                    && claim.amount == refund_amount,
                "REFUND_RECEIPT_REUSED"
            );
        }
        self.refund_claims.insert(
            receipt.clone(),
            RefundClaim {
                company_id: company_id.clone(),
                payment_id: payment_id.clone(),
                attempt_id: attempt_id.clone(),
                amount: refund_amount,
                credited: false,
            },
        );
        self.with_company(&company_id, |company| {
            company.confirm_refund(payment_id, attempt_id, refund_amount, receipt)
        })
    }

    #[private]
    pub fn on_refund_verified(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        epoch: U64,
        pool_epoch: U64,
    ) -> bool {
        let accounted = U128(*self.liabilities.get(&self.token_contract).unwrap_or(&0));
        let pool_current = pool_epoch.0 == self.pool_epoch;
        let receipt = self
            .company(&company_id)
            .get_attempt(payment_id.clone(), attempt_id.clone())
            .and_then(|attempt| attempt.receipt);
        let success = self.with_company_emergency(&company_id, |company| {
            company.on_refund_verified(payment_id, attempt_id, epoch, accounted, pool_current)
        });
        if success {
            let key = receipt.expect("REFUND_RECEIPT_REQUIRED");
            self.refund_claims
                .get_mut(&key)
                .expect("REFUND_CLAIM_REQUIRED")
                .credited = true;
        }
        success
    }

    #[payable]
    pub fn recover_source_transfer(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        succeeded: bool,
        receipt: String,
    ) -> PromiseOrValue<bool> {
        self.assert_recovery_authority(&company_id, succeeded);
        if succeeded {
            return PromiseOrValue::Value(self.with_company(&company_id, |company| {
                company.recover_source_transfer(payment_id, attempt_id, true, receipt)
            }));
        }
        require!(
            !receipt.is_empty() && receipt.len() <= 1024,
            "RECEIPT_REQUIRED"
        );
        let epoch = U64(self.company(&company_id).balance_epoch);
        require!(
            self.source_recovery_current(&company_id, &payment_id, &attempt_id, epoch),
            "SOURCE_ALREADY_RESOLVED"
        );
        PromiseOrValue::Promise(
            ext_pool_token::ext(self.token_contract.clone())
                .with_static_gas(Gas::from_tgas(5))
                .ft_balance_of(env::current_account_id())
                .then(
                    ext_self::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(30))
                        .on_source_recovery_verified(
                            company_id,
                            payment_id,
                            attempt_id,
                            receipt,
                            epoch,
                            U64(self.pool_epoch),
                        ),
                ),
        )
    }

    #[private]
    pub fn on_source_recovery_verified(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        receipt: String,
        epoch: U64,
        pool_epoch: U64,
    ) -> bool {
        if pool_epoch.0 != self.pool_epoch
            || !self.source_recovery_current(&company_id, &payment_id, &attempt_id, epoch)
            || !self.pool_covers_liability(&self.token_contract)
        {
            return false;
        }
        self.with_company_emergency(&company_id, |company| {
            company.recover_source_transfer(payment_id, attempt_id, false, receipt);
            true
        })
    }

    #[payable]
    pub fn recover_retained_withdrawal(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        withdrawal_id: U64,
        succeeded: bool,
        receipt: String,
    ) -> Promise {
        self.assert_recovery_authority(&company_id, succeeded);
        if succeeded {
            return self.with_company(&company_id, |company| {
                company.recover_retained_withdrawal(token_contract, withdrawal_id, true, receipt)
            });
        }
        require!(
            !receipt.is_empty() && receipt.len() <= 2000,
            "RECEIPT_REQUIRED"
        );
        let epoch = self
            .company(&company_id)
            .get_retained_asset(token_contract.clone())
            .expect("RETAINED_ASSET_NOT_FOUND")
            .balance_epoch;
        require!(
            self.retained_recovery_current(&company_id, &token_contract, withdrawal_id, epoch),
            "RETAINED_RECOVERY_NOT_REQUIRED"
        );
        ext_pool_token::ext(token_contract.clone())
            .with_static_gas(Gas::from_tgas(5))
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_retained_recovery_verified(
                        company_id,
                        token_contract,
                        withdrawal_id,
                        receipt,
                        epoch,
                        U64(self.pool_epoch),
                    ),
            )
    }

    #[private]
    pub fn on_retained_recovery_verified(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        withdrawal_id: U64,
        receipt: String,
        epoch: U64,
        pool_epoch: U64,
    ) -> bool {
        if pool_epoch.0 != self.pool_epoch
            || !self.retained_recovery_current(&company_id, &token_contract, withdrawal_id, epoch)
            || !self.pool_covers_liability(&token_contract)
        {
            return false;
        }
        self.with_company_emergency(&company_id, |company| {
            if !company.finish_retained_withdrawal(
                token_contract.clone(),
                withdrawal_id,
                false,
                Some(receipt),
            ) {
                return false;
            }
            let current_epoch = company
                .get_retained_asset(token_contract.clone())
                .expect("RETAINED_ASSET_NOT_FOUND")
                .balance_epoch;
            require!(
                company.on_retained_balance_sync(token_contract, current_epoch),
                "RECOVERY_BALANCE_SYNC_FAILED"
            );
            true
        })
    }

    #[private]
    pub fn on_withdraw_result(
        &mut self,
        company_id: String,
        withdrawal_id: U64,
        amount: U128,
    ) -> bool {
        self.with_company_emergency(&company_id, |company| {
            company.on_withdraw_result(withdrawal_id, amount)
        })
    }
    pub fn get_config(&self, company_id: String) -> ConfigView {
        self.company(&company_id).get_config()
    }

    pub fn get_balance(&self, company_id: String) -> BalanceView {
        self.company(&company_id).get_balance()
    }

    pub fn get_payment(&self, company_id: String, payment_id: String) -> Option<Payment> {
        self.company(&company_id).get_payment(payment_id)
    }

    pub fn get_recipient(&self, company_id: String, recipient_id: String) -> Option<Recipient> {
        self.company(&company_id).get_recipient(recipient_id)
    }

    pub fn get_attempt(
        &self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
    ) -> Option<Attempt> {
        self.company(&company_id)
            .get_attempt(payment_id, attempt_id)
    }

    pub fn get_approval_status(
        &self,
        company_id: String,
        payment_id: String,
        attempt_id: Option<String>,
    ) -> ApprovalStatus {
        self.company(&company_id)
            .get_approval_status(payment_id, attempt_id)
    }

    pub fn get_obligation(&self, company_id: String, reference: String) -> Option<String> {
        self.company(&company_id).get_obligation(reference)
    }

    pub fn get_backup_asset(&self, company_id: String, network: String) -> Option<String> {
        self.company(&company_id).get_backup_asset(network)
    }

    pub fn list_payments(
        &self,
        company_id: String,
        from_index: Option<u32>,
        limit: Option<u32>,
    ) -> Vec<Payment> {
        self.company(&company_id).list_payments(from_index, limit)
    }

    pub fn get_daily_spend(&self, company_id: String, day: U64) -> U128 {
        self.company(&company_id).get_daily_spend(day)
    }

    #[payable]
    pub fn set_paused(&mut self, company_id: String, paused: bool) {
        self.with_company(&company_id, |company| company.set_paused(paused))
    }

    #[payable]
    pub fn set_policy(&mut self, company_id: String, per_payment_limit: U128, daily_limit: U128) {
        self.with_company(&company_id, |company| {
            company.set_policy(per_payment_limit, daily_limit)
        })
    }

    #[payable]
    pub fn set_approval_policy(
        &mut self,
        company_id: String,
        tiers: Vec<ApprovalTier>,
        expected_policy_version: U64,
    ) {
        self.with_company(&company_id, |company| {
            company.set_approval_policy(tiers, expected_policy_version)
        })
    }

    #[payable]
    pub fn set_role(
        &mut self,
        company_id: String,
        account_id: AccountId,
        role: String,
        enabled: bool,
    ) {
        self.with_company(&company_id, |company| {
            company.set_role(account_id, role, enabled)
        })
    }

    #[payable]
    pub fn set_settlement_reporter(&mut self, company_id: String, account_id: Option<AccountId>) {
        self.with_company(&company_id, |company| {
            company.set_settlement_reporter(account_id)
        })
    }

    #[payable]
    pub fn transfer_ownership(&mut self, company_id: String, new_owner_id: AccountId) {
        self.with_company(&company_id, |company| {
            company.transfer_ownership(new_owner_id)
        })
    }

    #[payable]
    pub fn set_backup_asset(
        &mut self,
        company_id: String,
        network: String,
        asset_id: Option<String>,
    ) {
        self.with_company(&company_id, |company| {
            company.set_backup_asset(network, asset_id)
        })
    }

    #[payable]
    pub fn set_recipient(
        &mut self,
        company_id: String,
        recipient_id: String,
        primary: Destination,
        backup: Option<Destination>,
        backup_consent: bool,
        active: bool,
    ) -> Recipient {
        self.with_company(&company_id, |company| {
            company.set_recipient(recipient_id, primary, backup, backup_consent, active)
        })
    }

    pub fn get_distribution(
        &self,
        company_id: String,
        distribution_id: String,
    ) -> Option<Distribution> {
        self.company(&company_id).get_distribution(distribution_id)
    }

    pub fn get_distribution_recipients(
        &self,
        company_id: String,
        recipient_ids: Vec<String>,
    ) -> Vec<Option<Recipient>> {
        require!(recipient_ids.len() <= 64, "ALLOCATION_LIMIT");
        recipient_ids
            .into_iter()
            .map(|id| self.company(&company_id).get_recipient(id))
            .collect()
    }

    pub fn distribution_voided(&self, company_id: String, distribution_id: String) -> bool {
        self.company(&company_id)
            .distribution_voided(distribution_id)
    }

    #[payable]
    pub fn void_distribution(&mut self, company_id: String, distribution_id: String) -> bool {
        self.with_company_emergency(&company_id, |company| {
            company.void_distribution(distribution_id)
        })
    }

    #[payable]
    pub fn create_distribution(
        &mut self,
        company_id: String,
        distribution_id: String,
        reference: String,
        network: String,
        allocations: Vec<DistributionAllocation>,
        expected_total: U128,
        deadline_ms: U64,
        expected_policy_version: U64,
    ) -> Distribution {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.create_distribution(
                distribution_id,
                reference,
                network,
                allocations,
                expected_total,
                deadline_ms,
                expected_policy_version,
            )
        })
    }

    #[payable]
    pub fn approve_distribution(
        &mut self,
        company_id: String,
        distribution_id: String,
        expected_terms_hash: String,
    ) -> Distribution {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.approve_distribution(distribution_id, expected_terms_hash)
        })
    }

    pub fn claim_distribution(
        &mut self,
        company_id: String,
        distribution_id: String,
        claim_id: String,
    ) -> Promise {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.claim_distribution(distribution_id, claim_id)
        })
    }

    #[private]
    pub fn on_distribution_claim_result(
        &mut self,
        company_id: String,
        distribution_id: String,
        claim_id: String,
        nonce: U64,
    ) -> bool {
        self.with_company_emergency(&company_id, |company| {
            company.on_distribution_claim_result(distribution_id, claim_id, nonce)
        })
    }

    #[payable]
    pub fn reclaim_distribution(
        &mut self,
        company_id: String,
        distribution_id: String,
        expected_terms_hash: String,
    ) -> Distribution {
        self.with_company_emergency(&company_id, |company| {
            company.reclaim_distribution(distribution_id, expected_terms_hash)
        })
    }

    pub fn get_standing_mandate(
        &self,
        company_id: String,
        mandate_id: String,
    ) -> Option<StandingMandate> {
        self.company(&company_id).get_standing_mandate(mandate_id)
    }

    pub fn get_recipient_activation(
        &self,
        company_id: String,
        recipient_id: String,
    ) -> Option<U64> {
        self.company(&company_id)
            .get_recipient_activation(recipient_id)
    }

    pub fn get_standing_payment(&self, company_id: String, payment_id: String) -> Option<String> {
        self.company(&company_id).get_standing_payment(payment_id)
    }

    #[payable]
    pub fn grant_standing_mandate(
        &mut self,
        company_id: String,
        terms: StandingMandateTerms,
    ) -> StandingMandate {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| company.grant_standing_mandate(terms))
    }

    #[payable]
    pub fn approve_standing_mandate(
        &mut self,
        company_id: String,
        mandate_id: String,
        expected_terms_hash: String,
    ) -> StandingMandate {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.approve_standing_mandate(mandate_id, expected_terms_hash)
        })
    }

    #[payable]
    pub fn set_standing_mandate_status(
        &mut self,
        company_id: String,
        mandate_id: String,
        paused: bool,
        revoke: bool,
    ) -> StandingMandate {
        self.with_company_emergency(&company_id, |company| {
            company.set_standing_mandate_status(mandate_id, paused, revoke)
        })
    }

    pub fn execute_standing_payment(
        &mut self,
        company_id: String,
        mandate_id: String,
        payment_id: String,
        attempt_id: String,
        amount: U128,
        max_fee: U128,
        reference: String,
        expected_terms_hash: String,
        execution_hash: String,
    ) -> Promise {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.execute_standing_payment(
                mandate_id,
                payment_id,
                attempt_id,
                amount,
                max_fee,
                reference,
                expected_terms_hash,
                execution_hash,
            )
        })
    }

    pub fn propose_payment(
        &mut self,
        company_id: String,
        payment_id: String,
        recipient_id: String,
        amount: U128,
        max_fee: U128,
        expires_at_ms: U64,
        reference: String,
        not_before_ms: Option<U64>,
    ) -> Payment {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.propose_payment(
                payment_id,
                recipient_id,
                amount,
                max_fee,
                expires_at_ms,
                reference,
                not_before_ms,
            )
        })
    }

    #[payable]
    pub fn approve_payment(
        &mut self,
        company_id: String,
        payment_id: String,
        expected_policy_version: U64,
        expected_terms_hash: String,
    ) -> Payment {
        self.with_company(&company_id, |company| {
            company.approve_payment(payment_id, expected_policy_version, expected_terms_hash)
        })
    }

    pub fn create_attempt(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        use_backup: bool,
        route: Route,
    ) -> Payment {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.create_attempt(payment_id, attempt_id, use_backup, route)
        })
    }

    #[payable]
    pub fn authorize_attempt(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        expected_policy_version: U64,
        expected_terms_hash: String,
    ) -> Payment {
        self.with_company(&company_id, |company| {
            company.authorize_attempt(
                payment_id,
                attempt_id,
                expected_policy_version,
                expected_terms_hash,
            )
        })
    }

    pub fn discard_attempt(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
    ) -> Payment {
        self.with_company(&company_id, |company| {
            company.discard_attempt(payment_id, attempt_id)
        })
    }

    pub fn execute_payment(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
    ) -> Promise {
        require!(!self.paused, "PLATFORM_PAUSED");
        self.with_company(&company_id, |company| {
            company.execute_payment(payment_id, attempt_id)
        })
    }

    #[private]
    pub fn on_transfer_result(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
    ) -> bool {
        self.with_company_emergency(&company_id, |company| {
            company.on_transfer_result(payment_id, attempt_id)
        })
    }

    pub fn report_settlement(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        outcome: SettlementOutcome,
        receipt: String,
        actual_output: Option<U128>,
    ) -> Payment {
        self.with_company(&company_id, |company| {
            company.report_settlement(payment_id, attempt_id, outcome, receipt, actual_output)
        })
    }

    #[payable]
    pub fn cancel_payment(&mut self, company_id: String, payment_id: String) {
        self.with_company(&company_id, |company| company.cancel_payment(payment_id))
    }

    pub fn refresh_balance(&mut self, company_id: String) -> Promise {
        self.with_company(&company_id, |company| company.refresh_balance())
    }

    #[private]
    pub fn on_balance_sync(&mut self, company_id: String, epoch: U64) -> bool {
        if !self.pool_covers_liability(&self.token_contract) {
            return false;
        }
        self.with_company_emergency(&company_id, |company| company.on_balance_sync(epoch))
    }

    #[private]
    pub fn on_deposit_sync(&mut self, company_id: String, epoch: U64) -> U128 {
        if !self.pool_covers_liability(&self.token_contract) {
            return U128(0);
        }
        self.with_company_emergency(&company_id, |company| company.on_deposit_sync(epoch))
    }

    #[payable]
    pub fn withdraw_available(
        &mut self,
        company_id: String,
        receiver_id: AccountId,
        amount: U128,
    ) -> Promise {
        self.with_company(&company_id, |company| {
            company.withdraw_available(receiver_id, amount)
        })
    }

    pub fn get_retained_assets(&self, company_id: String) -> Vec<RetainedAsset> {
        self.company(&company_id).get_retained_assets()
    }

    pub fn get_retained_asset(
        &self,
        company_id: String,
        token_contract: AccountId,
    ) -> Option<RetainedAsset> {
        self.company(&company_id).get_retained_asset(token_contract)
    }

    #[payable]
    pub fn set_retained_asset(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        asset_id: String,
        symbol: String,
        decimals: u8,
        enabled: bool,
    ) -> RetainedAsset {
        self.with_company(&company_id, |company| {
            company.set_retained_asset(token_contract, asset_id, symbol, decimals, enabled)
        })
    }

    pub fn refresh_retained_balance(
        &mut self,
        company_id: String,
        token_contract: AccountId,
    ) -> Promise {
        self.with_company(&company_id, |company| {
            company.refresh_retained_balance(token_contract)
        })
    }

    #[private]
    pub fn on_retained_balance_sync(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        epoch: U64,
    ) -> bool {
        if !self.pool_covers_liability(&token_contract) {
            return false;
        }
        self.with_company_emergency(&company_id, |company| {
            company.on_retained_balance_sync(token_contract, epoch)
        })
    }

    #[private]
    pub fn on_retained_deposit_sync(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        epoch: U64,
    ) -> U128 {
        if !self.pool_covers_liability(&token_contract) {
            return U128(0);
        }
        self.with_company_emergency(&company_id, |company| {
            company.on_retained_deposit_sync(token_contract, epoch)
        })
    }

    #[payable]
    pub fn withdraw_retained_asset(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        receiver_id: AccountId,
        amount: U128,
        expected_epoch: U64,
    ) -> Promise {
        self.with_company(&company_id, |company| {
            company.withdraw_retained_asset(token_contract, receiver_id, amount, expected_epoch)
        })
    }

    #[private]
    pub fn on_retained_withdraw_result(
        &mut self,
        company_id: String,
        token_contract: AccountId,
        withdrawal_id: U64,
    ) -> bool {
        self.with_company_emergency(&company_id, |company| {
            company.on_retained_withdraw_result(token_contract, withdrawal_id)
        })
    }

    pub fn report_partial_settlement(
        &mut self,
        company_id: String,
        payment_id: String,
        attempt_id: String,
        expected_quote_hash: String,
        actual_output: U128,
        credited_amount: U128,
        route_closed: bool,
        receipt: String,
    ) -> Payment {
        self.with_company(&company_id, |company| {
            company.report_partial_settlement(
                payment_id,
                attempt_id,
                expected_quote_hash,
                actual_output,
                credited_amount,
                route_closed,
                receipt,
            )
        })
    }
}

impl Treasury {
    fn source_recovery_current(
        &self,
        company_id: &String,
        payment_id: &String,
        attempt_id: &String,
        epoch: U64,
    ) -> bool {
        let company = self.company(company_id);
        company.balance_epoch == epoch.0
            && company
                .payments
                .get(payment_id)
                .and_then(|payment| payment.attempts.last())
                .is_some_and(|attempt| {
                    attempt.id == *attempt_id && attempt.status == AttemptStatus::Sending
                })
    }

    fn retained_recovery_current(
        &self,
        company_id: &String,
        token_contract: &AccountId,
        withdrawal_id: U64,
        epoch: U64,
    ) -> bool {
        self.company(company_id)
            .get_retained_asset(token_contract.clone())
            .is_some_and(|asset| {
                asset.balance_epoch == epoch
                    && asset.withdrawal.is_some_and(|withdrawal| {
                        withdrawal.id == withdrawal_id
                            && withdrawal.status == RetainedWithdrawalStatus::Pending
                    })
            })
    }

    fn pool_covers_liability(&self, token_contract: &AccountId) -> bool {
        near_sdk::env::promise_result_checked(0, 128)
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice::<U128>(&bytes).ok())
            .is_some_and(|actual| actual.0 >= *self.liabilities.get(token_contract).unwrap_or(&0))
    }

    fn assert_platform_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner_id,
            "ONLY_PLATFORM_OWNER"
        );
        near_sdk::assert_one_yocto();
    }

    fn assert_refund_reporter(&self) {
        require!(
            self.refund_reporter.as_ref() == Some(&env::predecessor_account_id()),
            "ONLY_REFUND_REPORTER"
        );
    }

    fn assert_recovery_authority(&self, company_id: &String, succeeded: bool) {
        let caller = env::predecessor_account_id();
        let reporter = self.refund_reporter.as_ref() == Some(&caller);
        require!(
            reporter || (succeeded && self.company(company_id).owner_id == caller),
            "VERIFIED_RECOVERY_REPORTER_REQUIRED"
        );
        if reporter {
            require!(
                env::attached_deposit().as_yoctonear() <= 1,
                "RECOVERY_DEPOSIT_MUST_BE_ZERO_OR_ONE"
            );
        } else {
            near_sdk::assert_one_yocto();
        }
    }

    fn company(&self, company_id: &String) -> &CompanyTreasury {
        self.companies.get(company_id).expect("COMPANY_NOT_FOUND")
    }

    fn with_company<T>(
        &mut self,
        company_id: &String,
        operation: impl FnOnce(&mut CompanyTreasury) -> T,
    ) -> T {
        self.run_company(company_id, false, operation)
    }

    fn with_company_emergency<T>(
        &mut self,
        company_id: &String,
        operation: impl FnOnce(&mut CompanyTreasury) -> T,
    ) -> T {
        self.run_company(company_id, true, operation)
    }

    fn run_company<T>(
        &mut self,
        company_id: &String,
        emergency: bool,
        operation: impl FnOnce(&mut CompanyTreasury) -> T,
    ) -> T {
        let storage_before = env::storage_usage();
        let company = self
            .companies
            .get_mut(company_id)
            .expect("COMPANY_NOT_FOUND");
        company.pool_epoch = self.pool_epoch;
        let before = company.liabilities();
        let result = operation(company);
        company.flush();
        let after = company.liabilities();
        let mut changed = false;
        for (token, previous) in &before {
            let next = *after.get(token).unwrap_or(&0);
            let total = *self.liabilities.get(token).unwrap_or(&0);
            let adjusted = checked_add(
                total.checked_sub(*previous).expect("LIABILITY_UNDERFLOW"),
                next,
            );
            if total != adjusted {
                changed = true;
                self.liabilities.insert(token.clone(), adjusted);
            }
        }
        for (token, next) in &after {
            if !before.contains_key(token) && *next != 0 {
                changed = true;
                let total = *self.liabilities.get(token).unwrap_or(&0);
                self.liabilities
                    .insert(token.clone(), checked_add(total, *next));
            }
        }
        if changed {
            self.pool_epoch = self.pool_epoch.checked_add(1).expect("EPOCH_OVERFLOW");
        }
        self.flush();
        let storage_after = env::storage_usage();
        let company = self
            .companies
            .get_mut(company_id)
            .expect("COMPANY_NOT_FOUND");
        if storage_after >= storage_before {
            company.storage_used = checked_add(
                company.storage_used,
                storage_cost(storage_after - storage_before),
            );
        } else {
            company.storage_used = company
                .storage_used
                .saturating_sub(storage_cost(storage_before - storage_after));
        }
        let reserve = if emergency {
            0
        } else {
            storage_cost(EMERGENCY_BYTES)
        };
        require!(
            company.storage_used <= company.storage_credit.saturating_sub(reserve),
            "COMPANY_STORAGE_TOPUP_REQUIRED"
        );
        result
    }

    fn flush(&mut self) {
        self.companies.flush();
        self.deposits.flush();
        self.latest_deposits.flush();
        self.liabilities.flush();
        self.refund_claims.flush();
    }
}

fn storage_cost(bytes: u64) -> u128 {
    (bytes as u128)
        .checked_mul(env::storage_byte_cost().as_yoctonear())
        .expect("STORAGE_OVERFLOW")
}

fn checked_add(left: u128, right: u128) -> u128 {
    left.checked_add(right).expect("AMOUNT_OVERFLOW")
}

fn validate_company_id(company_id: &str) {
    let parts = company_id.split(':').collect::<Vec<_>>();
    require!(
        parts.len() == 2 && parts[0].len() == 36 && parts[1].len() == 16,
        "INVALID_COMPANY_ID"
    );
    require!(
        parts[0]
            .bytes()
            .enumerate()
            .all(|(index, byte)| if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()
            })
            && parts[1]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()),
        "INVALID_COMPANY_ID"
    );
}

fn validate_deposit_id(deposit_id: &str) {
    require!(
        !deposit_id.is_empty()
            && deposit_id.len() <= 128
            && deposit_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "INVALID_DEPOSIT_ID"
    );
}

#[cfg(test)]
mod distribution_tests;
#[cfg(test)]
mod shared_tests;
