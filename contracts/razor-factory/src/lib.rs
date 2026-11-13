use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError, env, ext_contract,
    json_types::{U64, U128},
    near, require,
    serde_json::{self, json},
    store::IterableMap,
};

const TREASURY_WASM: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/treasury.wasm"));
const TREASURY_STATE_BYTES: u128 = 8_192;
const FACTORY_RECORD_BYTES: u128 = 2_048;
const OPERATING_RESERVE: u128 = 50_000_000_000_000_000_000_000;

#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_created(&mut self, account_id: AccountId, generation: U64) -> bool;
    fn on_refunded(&mut self, account_id: AccountId, generation: U64) -> bool;
    fn on_creation_refreshed(&mut self, account_id: AccountId, generation: U64) -> bool;
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CreationStatus {
    Pending,
    Ready,
    Failed,
    Refunding,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Creation {
    pub account_id: AccountId,
    pub owner_id: AccountId,
    pub slug: String,
    pub generation: U64,
    pub token_contract: AccountId,
    pub per_payment_limit: U128,
    pub daily_limit: U128,
    pub status: CreationStatus,
    pub treasury_funding: U128,
    pub factory_storage_fee: U128,
    pub refund_amount: U128,
    pub created_at_ms: U64,
}

#[near(serializers = [json])]
pub struct FactoryConfig {
    pub owner_id: AccountId,
    pub token_contract: AccountId,
    pub paused: bool,
    pub treasury_wasm_hash: String,
    pub minimum_deposit: U128,
    pub treasury_funding: U128,
    pub factory_storage_fee: U128,
}

#[near(serializers = [json])]
pub struct CreationQuote {
    pub account_id: AccountId,
    pub owner_id: AccountId,
    pub token_contract: AccountId,
    pub treasury_wasm_hash: String,
    pub minimum_deposit: U128,
    pub treasury_funding: U128,
    pub factory_storage_fee: U128,
}

#[near(serializers = [json])]
struct TreasuryConfig {
    owner_id: AccountId,
    token_contract: AccountId,
    per_payment_limit: U128,
    daily_limit: U128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    owner_id: AccountId,
    token_contract: AccountId,
    paused: bool,
    generation: u64,
    creations: IterableMap<AccountId, Creation>,
}

#[near]
impl Factory {
    #[init]
    pub fn new(owner_id: AccountId, token_contract: AccountId) -> Self {
        require!(
            owner_id != env::current_account_id(),
            "OWNER_MUST_BE_RECOVERABLE"
        );
        Self {
            owner_id,
            token_contract,
            paused: false,
            generation: 0,
            creations: IterableMap::new(b"c"),
        }
    }

    pub fn get_config(&self) -> FactoryConfig {
        let (funding, fee) = deposit_costs();
        FactoryConfig {
            owner_id: self.owner_id.clone(),
            token_contract: self.token_contract.clone(),
            paused: self.paused,
            treasury_wasm_hash: wasm_hash(),
            minimum_deposit: U128(add(funding, fee)),
            treasury_funding: U128(funding),
            factory_storage_fee: U128(fee),
        }
    }

    pub fn quote_creation(&self, owner_id: AccountId, slug: String) -> CreationQuote {
        let (funding, fee) = deposit_costs();
        CreationQuote {
            account_id: derive_account(&owner_id, &slug),
            owner_id,
            token_contract: self.token_contract.clone(),
            treasury_wasm_hash: wasm_hash(),
            minimum_deposit: U128(add(funding, fee)),
            treasury_funding: U128(funding),
            factory_storage_fee: U128(fee),
        }
    }

    pub fn get_treasury(&self, owner_id: AccountId, slug: String) -> Option<Creation> {
        self.creations
            .get(&derive_account(&owner_id, &slug))
            .filter(|creation| creation.owner_id == owner_id && creation.slug == slug)
            .cloned()
    }

    pub fn get_creation(&self, account_id: AccountId) -> Option<Creation> {
        self.creations.get(&account_id).cloned()
    }

    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER");
        near_sdk::assert_one_yocto();
        self.paused = paused;
        emit("factory_pause_changed", json!({"paused": paused}));
    }

    #[payable]
    pub fn create_treasury(
        &mut self,
        slug: String,
        per_payment_limit: U128,
        daily_limit: U128,
    ) -> Promise {
        require!(!self.paused, "PAUSED");
        require!(
            env::prepaid_gas() >= Gas::from_tgas(100),
            "INSUFFICIENT_GAS"
        );
        require!(
            per_payment_limit.0 > 0 && daily_limit.0 >= per_payment_limit.0,
            "INVALID_LIMITS"
        );
        let owner_id = env::predecessor_account_id();
        require!(owner_id != env::current_account_id(), "INVALID_OWNER");
        let account_id = derive_account(&owner_id, &slug);
        if let Some(existing) = self.creations.get(&account_id) {
            require!(
                existing.owner_id == owner_id && existing.slug == slug,
                "ACCOUNT_NAME_COLLISION"
            );
            require!(
                existing.status == CreationStatus::Refunded,
                "TREASURY_ALREADY_REQUESTED"
            );
        }
        let (minimum_funding, storage_fee) = deposit_costs();
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= add(minimum_funding, storage_fee),
            "INSUFFICIENT_CREATION_DEPOSIT"
        );
        let funding = attached - storage_fee;
        self.generation = self.generation.checked_add(1).expect("GENERATION_OVERFLOW");
        let generation = U64(self.generation);
        let creation = Creation {
            account_id: account_id.clone(),
            owner_id: owner_id.clone(),
            slug,
            generation,
            token_contract: self.token_contract.clone(),
            per_payment_limit,
            daily_limit,
            status: CreationStatus::Pending,
            treasury_funding: U128(funding),
            factory_storage_fee: U128(storage_fee),
            refund_amount: U128(0),
            created_at_ms: U64(env::block_timestamp_ms()),
        };
        self.creations.insert(account_id.clone(), creation);
        let args = serde_json::to_vec(
            &json!({"owner_id": owner_id, "token_contract": self.token_contract,
            "per_payment_limit": per_payment_limit, "daily_limit": daily_limit}),
        )
        .expect("SERIALIZATION_FAILED");
        emit(
            "treasury_creation_started",
            json!({"account_id": account_id, "owner_id": owner_id, "generation": generation, "treasury_funding": U128(funding)}),
        );
        Promise::new(account_id.clone())
            .create_account()
            .transfer(NearToken::from_yoctonear(funding))
            .deploy_contract(TREASURY_WASM.to_vec())
            .function_call(
                "new",
                args,
                NearToken::from_yoctonear(0),
                Gas::from_tgas(40),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(20))
                    .on_created(account_id, generation),
            )
    }

    #[private]
    pub fn on_created(&mut self, account_id: AccountId, generation: U64) -> bool {
        let Some(mut creation) = self.creations.get(&account_id).cloned() else {
            return false;
        };
        if creation.generation != generation || creation.status != CreationStatus::Pending {
            return false;
        }
        let success = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if success {
            creation.status = CreationStatus::Ready;
        } else {
            creation.status = CreationStatus::Failed;
            creation.refund_amount = creation.treasury_funding;
        }
        self.creations.insert(account_id.clone(), creation);
        emit(
            "treasury_creation_result",
            json!({"account_id": account_id, "generation": generation, "success": success}),
        );
        success
    }

    pub fn refresh_creation(&mut self, owner_id: AccountId, slug: String) -> Promise {
        let account_id = derive_account(&owner_id, &slug);
        let creation = self.creations.get(&account_id).expect("CREATION_NOT_FOUND");
        require!(
            creation.owner_id == owner_id && creation.status == CreationStatus::Pending,
            "CREATION_NOT_PENDING"
        );
        Promise::new(account_id.clone())
            .function_call(
                "get_config",
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(5),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_creation_refreshed(account_id, creation.generation),
            )
    }

    #[private]
    pub fn on_creation_refreshed(&mut self, account_id: AccountId, generation: U64) -> bool {
        let Some(mut creation) = self.creations.get(&account_id).cloned() else {
            return false;
        };
        if creation.generation != generation || creation.status != CreationStatus::Pending {
            return false;
        }
        let config = env::promise_result_checked(0, 8_192)
            .ok()
            .and_then(|result| serde_json::from_slice::<TreasuryConfig>(&result).ok());
        let Some(config) = config else { return false };
        if config.owner_id != creation.owner_id
            || config.token_contract != creation.token_contract
            || config.per_payment_limit != creation.per_payment_limit
            || config.daily_limit != creation.daily_limit
        {
            return false;
        }
        creation.status = CreationStatus::Ready;
        self.creations.insert(account_id.clone(), creation);
        emit(
            "treasury_creation_recovered",
            json!({"account_id": account_id, "generation": generation}),
        );
        true
    }

    #[payable]
    pub fn claim_refund(&mut self, slug: String) -> Promise {
        near_sdk::assert_one_yocto();
        let owner_id = env::predecessor_account_id();
        let account_id = derive_account(&owner_id, &slug);
        let mut creation = self
            .creations
            .get(&account_id)
            .cloned()
            .expect("CREATION_NOT_FOUND");
        require!(
            creation.owner_id == owner_id && creation.status == CreationStatus::Failed,
            "NO_CLAIMABLE_REFUND"
        );
        let amount = creation.refund_amount.0;
        require!(amount > 0, "NO_CLAIMABLE_REFUND");
        let storage = (env::storage_usage() as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("STORAGE_OVERFLOW");
        require!(
            env::account_balance()
                .as_yoctonear()
                .saturating_sub(storage)
                >= amount,
            "REFUND_NOT_YET_AVAILABLE"
        );
        creation.status = CreationStatus::Refunding;
        let generation = creation.generation;
        self.creations.insert(account_id.clone(), creation);
        Promise::new(owner_id)
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(10))
                    .on_refunded(account_id, generation),
            )
    }

    #[private]
    pub fn on_refunded(&mut self, account_id: AccountId, generation: U64) -> bool {
        let Some(mut creation) = self.creations.get(&account_id).cloned() else {
            return false;
        };
        if creation.generation != generation || creation.status != CreationStatus::Refunding {
            return false;
        }
        let success = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        if success {
            creation.status = CreationStatus::Refunded;
            creation.refund_amount = U128(0);
        } else {
            creation.status = CreationStatus::Failed;
        }
        self.creations.insert(account_id.clone(), creation);
        emit(
            "treasury_creation_refund_result",
            json!({"account_id": account_id, "generation": generation, "success": success}),
        );
        success
    }
}

fn derive_account(owner_id: &AccountId, slug: &str) -> AccountId {
    require!(
        !slug.is_empty()
            && slug.len() <= 24
            && slug
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            && !slug.starts_with('-')
            && !slug.ends_with('-'),
        "INVALID_SLUG"
    );
    let digest = env::sha256(owner_id.as_bytes());
    let suffix: String = digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("{slug}-{suffix}.{}", env::current_account_id())
        .parse()
        .expect("SUBACCOUNT_NAME_TOO_LONG")
}
fn deposit_costs() -> (u128, u128) {
    let byte_cost = env::storage_byte_cost().as_yoctonear();
    let funding = (add(TREASURY_WASM.len() as u128, TREASURY_STATE_BYTES))
        .checked_mul(byte_cost)
        .and_then(|storage| storage.checked_add(OPERATING_RESERVE))
        .expect("STORAGE_OVERFLOW");
    let fee = FACTORY_RECORD_BYTES
        .checked_mul(byte_cost)
        .expect("STORAGE_OVERFLOW");
    (funding, fee)
}
fn wasm_hash() -> String {
    near_sdk::bs58::encode(env::sha256(TREASURY_WASM)).into_string()
}
fn add(left: u128, right: u128) -> u128 {
    left.checked_add(right).expect("AMOUNT_OVERFLOW")
}
fn emit(event: &str, data: serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({"standard":"razor","version":"1.0.0","event":event,"data":[data]})
    ));
}

#[cfg(test)]
mod tests;
