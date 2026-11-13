use near_sdk::{
    AccountId, Gas, NearToken, PanicOnDefault, Promise, env, ext_contract,
    json_types::{U64, U128},
    near, require, serde_json,
    store::IterableMap,
};
use std::collections::{BTreeMap, BTreeSet};

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Participant {
    pub company_id: String,
    pub treasury_id: AccountId,
    pub owner_id: AccountId,
    pub version: U64,
    pub policy_version: U64,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Obligation {
    pub id: String,
    pub terms_hash: String,
    pub debtor: String,
    pub creditor: String,
    pub original: U128,
    pub reduction: U128,
    pub residual: U128,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub id: String,
    pub asset: String,
    pub fee: U128,
    pub starts_at_ms: U64,
    pub expires_at_ms: U64,
    pub participants: Vec<Participant>,
    pub obligations: Vec<Obligation>,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Round {
    pub manifest: Manifest,
    pub manifest_json: String,
    pub hash: String,
    pub status: String,
    pub consents: Vec<String>,
    pub finalized_at_ms: Option<U64>,
    pub finalized_height: Option<U64>,
    pub request_nonce: U64,
    pub consent_requests: BTreeMap<String, U64>,
    pub finalize_request: Option<U64>,
}
#[near(serializers = [json])]
struct Treasury {
    owner_id: AccountId,
    token_contract: AccountId,
    paused: bool,
    policy_version: U64,
}
#[near(serializers = [json])]
struct Creation {
    account_id: AccountId,
    token_contract: AccountId,
    status: String,
}
#[near(serializers = [json])]
pub struct ClearingConfig {
    pub factory_id: AccountId,
    pub token_contract: AccountId,
    pub paused: bool,
    pub max_participants: u8,
    pub max_obligations: u8,
}
#[derive(serde::Serialize)]
struct AccountLookup<'a> {
    account_id: &'a AccountId,
}
#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks {
    fn on_registered(&mut self, round_id: String) -> bool;
    fn on_consented(
        &mut self,
        round_id: String,
        company_id: String,
        owner_id: AccountId,
        request_id: U64,
    ) -> bool;
    fn on_finalized(&mut self, round_id: String, request_id: U64) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Clearing {
    owner_id: AccountId,
    factory_id: AccountId,
    token_contract: AccountId,
    paused: bool,
    rounds: IterableMap<String, Round>,
    locks: IterableMap<String, String>,
}

#[near]
impl Clearing {
    #[init]
    pub fn new(owner_id: AccountId, factory_id: AccountId, token_contract: AccountId) -> Self {
        Self {
            owner_id,
            factory_id,
            token_contract,
            paused: false,
            rounds: IterableMap::new(b"r"),
            locks: IterableMap::new(b"l"),
        }
    }
    pub fn get_config(&self) -> ClearingConfig {
        ClearingConfig {
            factory_id: self.factory_id.clone(),
            token_contract: self.token_contract.clone(),
            paused: self.paused,
            max_participants: 8,
            max_obligations: 32,
        }
    }
    pub fn get_round(&self, round_id: String) -> Option<Round> {
        self.rounds.get(&round_id).cloned()
    }
    pub fn registration_cost(&self, manifest_json: String) -> U128 {
        U128((manifest_json.len() as u128 * 4 + 8192) * env::storage_byte_cost().as_yoctonear())
    }
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        near_sdk::assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER");
        self.paused = paused;
    }
    #[payable]
    pub fn register_round(&mut self, manifest_json: String, manifest_hash: String) -> Promise {
        require!(!self.paused, "PAUSED");
        require!(manifest_json.len() <= 30000, "MANIFEST_TOO_LARGE");
        let manifest: Manifest = serde_json::from_str(&manifest_json).expect("INVALID_MANIFEST");
        validate(&manifest);
        require!(
            manifest.expires_at_ms.0 > env::block_timestamp_ms()
                && manifest.expires_at_ms.0 <= env::block_timestamp_ms() + 86_400_000,
            "INVALID_WINDOW"
        );
        require!(digest(&manifest_json) == manifest_hash, "HASH_MISMATCH");
        require!(!self.rounds.contains_key(&manifest.id), "ROUND_EXISTS");
        require!(
            manifest
                .participants
                .iter()
                .any(|party| party.owner_id == env::predecessor_account_id()),
            "PARTICIPANT_REQUIRED"
        );
        require!(
            env::attached_deposit().as_yoctonear()
                >= self.registration_cost(manifest_json.clone()).0,
            "STORAGE_DEPOSIT_REQUIRED"
        );
        let mut calls: Option<Promise> = None;
        for party in &manifest.participants {
            let factory = Promise::new(self.factory_id.clone()).function_call(
                "get_creation",
                serde_json::to_vec(&AccountLookup { account_id: &party.treasury_id }).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(4),
            );
            let config = treasury_call(&party.treasury_id);
            let pair = factory.and(config);
            calls = Some(match calls {
                Some(previous) => previous.and(pair),
                None => pair,
            });
        }
        let round_id = manifest.id.clone();
        self.rounds.insert(
            round_id.clone(),
            Round {
                manifest,
                manifest_json,
                hash: manifest_hash,
                status: "verifying".into(),
                consents: vec![],
                finalized_at_ms: None,
                finalized_height: None,
                request_nonce: U64(0),
                consent_requests: BTreeMap::new(),
                finalize_request: None,
            },
        );
        calls.unwrap().then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(40))
                .on_registered(round_id),
        )
    }
    #[private]
    pub fn on_registered(&mut self, round_id: String) -> bool {
        let mut round = self.rounds.get(&round_id).expect("ROUND_NOT_FOUND").clone();
        if round.status != "verifying" {
            return false;
        }
        let valid = env::promise_results_count() == round.manifest.participants.len() as u64 * 2
            && !self.paused
            && round.manifest.expires_at_ms.0 > env::block_timestamp_ms()
            && round
                .manifest
                .participants
                .iter()
                .enumerate()
                .all(|(index, party)| {
                    let creation: Option<Creation> = result(index as u64 * 2);
                    let treasury: Option<Treasury> = result(index as u64 * 2 + 1);
                    creation.is_some_and(|value| {
                        value.account_id == party.treasury_id
                            && value.token_contract == self.token_contract
                            && value.status == "ready"
                    }) && treasury.is_some_and(|value| {
                        value.owner_id == party.owner_id
                            && value.token_contract == self.token_contract
                            && value.policy_version.0 == party.policy_version.0
                            && !value.paused
                    })
                });
        round.status = if valid { "ready" } else { "rejected" }.into();
        self.rounds.insert(round_id, round);
        valid
    }
    #[payable]
    pub fn consent(
        &mut self,
        round_id: String,
        manifest_hash: String,
        company_id: String,
    ) -> Promise {
        near_sdk::assert_one_yocto();
        require!(!self.paused, "PAUSED");
        let mut round = self.live(&round_id, &manifest_hash);
        let party = round
            .manifest
            .participants
            .iter()
            .find(|party| party.company_id == company_id)
            .expect("PARTICIPANT_REQUIRED");
        require!(
            env::predecessor_account_id() == party.owner_id
                && env::signer_account_id() == party.owner_id,
            "ONLY_TREASURY_OWNER"
        );
        let treasury_id = party.treasury_id.clone();
        let owner_id = party.owner_id.clone();
        round.request_nonce = U64(round
            .request_nonce
            .0
            .checked_add(1)
            .expect("REQUEST_OVERFLOW"));
        let request_id = round.request_nonce;
        round
            .consent_requests
            .insert(company_id.clone(), request_id);
        round.finalize_request = None;
        self.rounds.insert(round_id.clone(), round);
        treasury_call(&treasury_id).then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(30))
                .on_consented(round_id, company_id, owner_id, request_id),
        )
    }
    #[private]
    pub fn on_consented(
        &mut self,
        round_id: String,
        company_id: String,
        owner_id: AccountId,
        request_id: U64,
    ) -> bool {
        let mut round = self.rounds.get(&round_id).expect("ROUND_NOT_FOUND").clone();
        if self.paused
            || round.status != "ready"
            || round.manifest.expires_at_ms.0 <= env::block_timestamp_ms()
            || round.consent_requests.get(&company_id) != Some(&request_id)
            || env::promise_results_count() != 1
        {
            return false;
        }
        let party = round
            .manifest
            .participants
            .iter()
            .find(|party| party.company_id == company_id && party.owner_id == owner_id)
            .expect("PARTICIPANT_REQUIRED");
        let treasury: Option<Treasury> = result(0);
        if !treasury.is_some_and(|value| {
            value.owner_id == owner_id
                && value.token_contract == self.token_contract
                && value.policy_version.0 == party.policy_version.0
                && !value.paused
        }) {
            return false;
        }
        let keys: Vec<String> = round
            .manifest
            .obligations
            .iter()
            .filter(|edge| edge.debtor == company_id)
            .map(|edge| obligation_key(&round.manifest, edge))
            .collect();
        for key in &keys {
            self.require_free(key, &round_id);
        }
        for key in keys {
            self.locks.insert(key, round_id.clone());
        }
        round.consent_requests.remove(&company_id);
        if !round.consents.contains(&company_id) {
            round.consents.push(company_id);
        }
        self.rounds.insert(round_id, round);
        true
    }
    #[payable]
    pub fn finalize_round(&mut self, round_id: String, manifest_hash: String) -> Promise {
        near_sdk::assert_one_yocto();
        require!(!self.paused, "PAUSED");
        let mut round = self.live(&round_id, &manifest_hash);
        require!(
            env::block_timestamp_ms() >= round.manifest.starts_at_ms.0,
            "WINDOW_NOT_STARTED"
        );
        require!(
            round.consents.len() == round.manifest.participants.len(),
            "CONSENTS_REQUIRED"
        );
        require!(
            round
                .manifest
                .participants
                .iter()
                .any(|party| party.owner_id == env::predecessor_account_id()),
            "PARTICIPANT_REQUIRED"
        );
        let calls = round
            .manifest
            .participants
            .iter()
            .map(|party| treasury_call(&party.treasury_id))
            .reduce(|a, b| a.and(b))
            .unwrap();
        round.request_nonce = U64(round
            .request_nonce
            .0
            .checked_add(1)
            .expect("REQUEST_OVERFLOW"));
        let request_id = round.request_nonce;
        round.finalize_request = Some(request_id);
        self.rounds.insert(round_id.clone(), round);
        calls.then(
            ext_self::ext(env::current_account_id())
                .with_static_gas(Gas::from_tgas(40))
                .on_finalized(round_id, request_id),
        )
    }
    #[private]
    pub fn on_finalized(&mut self, round_id: String, request_id: U64) -> bool {
        let mut round = self.rounds.get(&round_id).expect("ROUND_NOT_FOUND").clone();
        if self.paused
            || round.status != "ready"
            || round.manifest.expires_at_ms.0 <= env::block_timestamp_ms()
            || round.consents.len() != round.manifest.participants.len()
            || round.finalize_request != Some(request_id)
            || env::block_timestamp_ms() < round.manifest.starts_at_ms.0
        {
            return false;
        }
        if env::promise_results_count() != round.manifest.participants.len() as u64
            || !round
                .manifest
                .participants
                .iter()
                .enumerate()
                .all(|(index, party)| {
                    result::<Treasury>(index as u64).is_some_and(|value| {
                        value.owner_id == party.owner_id
                            && value.token_contract == self.token_contract
                            && value.policy_version.0 == party.policy_version.0
                            && !value.paused
                    })
                })
        {
            return false;
        }
        for edge in &round.manifest.obligations {
            require!(
                self.locks.get(&obligation_key(&round.manifest, edge)) == Some(&round_id),
                "OBLIGATION_REUSED"
            );
        }
        round.status = "finalized".into();
        round.finalized_at_ms = Some(U64(env::block_timestamp_ms()));
        round.finalized_height = Some(U64(env::block_height()));
        self.rounds.insert(round_id, round);
        true
    }
    #[payable]
    pub fn revoke(&mut self, round_id: String, manifest_hash: String) {
        near_sdk::assert_one_yocto();
        let mut round = self.rounds.get(&round_id).expect("ROUND_NOT_FOUND").clone();
        require!(
            round.hash == manifest_hash && round.status != "finalized",
            "ROUND_FINAL_OR_MISMATCHED"
        );
        require!(
            round
                .manifest
                .participants
                .iter()
                .any(|party| party.owner_id == env::predecessor_account_id()),
            "PARTICIPANT_REQUIRED"
        );
        round.status = "revoked".into();
        self.rounds.insert(round_id, round);
    }
    pub fn expire(&mut self, round_id: String) {
        let mut round = self.rounds.get(&round_id).expect("ROUND_NOT_FOUND").clone();
        require!(
            round.status != "finalized"
                && round.manifest.expires_at_ms.0 <= env::block_timestamp_ms(),
            "NOT_EXPIRED"
        );
        round.status = "expired".into();
        self.rounds.insert(round_id, round);
    }
}

impl Clearing {
    fn live(&self, round_id: &str, manifest_hash: &str) -> Round {
        let round = self.rounds.get(round_id).expect("ROUND_NOT_FOUND").clone();
        require!(
            round.hash == manifest_hash
                && round.status == "ready"
                && round.manifest.expires_at_ms.0 > env::block_timestamp_ms(),
            "ROUND_NOT_LIVE"
        );
        round
    }
    fn require_free(&self, key: &str, round_id: &str) {
        if let Some(previous) = self.locks.get(key) {
            if previous == round_id {
                return;
            }
            let old = self.rounds.get(previous).expect("ROUND_NOT_FOUND");
            require!(
                old.status != "finalized"
                    && (old.status == "revoked"
                        || old.status == "rejected"
                        || old.status == "expired"
                        || old.manifest.expires_at_ms.0 <= env::block_timestamp_ms()),
                "OBLIGATION_REUSED"
            );
        }
    }
}
fn treasury_call(account: &AccountId) -> Promise {
    Promise::new(account.clone()).function_call(
        "get_config",
        b"{}".to_vec(),
        NearToken::from_yoctonear(0),
        Gas::from_tgas(4),
    )
}
fn result<T: near_sdk::serde::de::DeserializeOwned>(index: u64) -> Option<T> {
    env::promise_result_checked(index, 65536)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
}
fn digest(value: &str) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let bytes = env::sha256(value.as_bytes());
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 15) as usize] as char);
    }
    output
}
fn obligation_key(manifest: &Manifest, edge: &Obligation) -> String {
    format!(
        "{}:{}",
        manifest
            .participants
            .iter()
            .find(|party| party.company_id == edge.debtor)
            .unwrap()
            .treasury_id,
        edge.id
    )
}
fn validate(manifest: &Manifest) {
    require!(
        manifest.id.len() >= 8
            && manifest.id.len() <= 100
            && manifest.asset == "USDC"
            && manifest.fee.0 == 0,
        "INVALID_TERMS"
    );
    require!(
        manifest.starts_at_ms.0 < manifest.expires_at_ms.0
            && (2..=8).contains(&manifest.participants.len())
            && (2..=32).contains(&manifest.obligations.len()),
        "INVALID_ROUND_SIZE_OR_WINDOW"
    );
    let companies: BTreeSet<_> = manifest
        .participants
        .iter()
        .map(|party| party.company_id.clone())
        .collect();
    let treasuries: BTreeSet<_> = manifest
        .participants
        .iter()
        .map(|party| party.treasury_id.clone())
        .collect();
    require!(
        companies.len() == manifest.participants.len()
            && treasuries.len() == manifest.participants.len(),
        "DUPLICATE_PARTICIPANT"
    );
    require!(
        manifest
            .participants
            .iter()
            .all(|party| (8..=100).contains(&party.company_id.len())
                && party.version.0 > 0
                && party.policy_version.0 > 0),
        "INVALID_PARTICIPANT"
    );
    let mut ids = BTreeSet::new();
    let mut positions: BTreeMap<String, (u128, u128)> = BTreeMap::new();
    let mut reduced = false;
    for edge in &manifest.obligations {
        require!(
            ids.insert(edge.id.clone())
                && edge.id.len() <= 100
                && edge.id.len() >= 8
                && edge.terms_hash.len() == 64
                && edge
                    .terms_hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)),
            "DUPLICATE_OR_INVALID_OBLIGATION"
        );
        require!(
            companies.contains(&edge.debtor)
                && companies.contains(&edge.creditor)
                && edge.debtor != edge.creditor
                && edge.original.0 > 0,
            "INVALID_PARTIES"
        );
        require!(
            edge.reduction.0.checked_add(edge.residual.0) == Some(edge.original.0),
            "CONSERVATION_FAILED"
        );
        reduced |= edge.reduction.0 > 0;
        let debtor = positions.entry(edge.debtor.clone()).or_default();
        debtor.0 = debtor
            .0
            .checked_add(edge.reduction.0)
            .expect("AMOUNT_OVERFLOW");
        let creditor = positions.entry(edge.creditor.clone()).or_default();
        creditor.1 = creditor
            .1
            .checked_add(edge.reduction.0)
            .expect("AMOUNT_OVERFLOW");
    }
    require!(
        reduced
            && positions.len() == companies.len()
            && positions
                .values()
                .all(|(outgoing, incoming)| outgoing == incoming),
        "NET_POSITIONS_CHANGED"
    );
}

#[cfg(test)]
mod tests;
