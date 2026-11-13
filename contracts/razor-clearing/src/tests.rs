use super::*;
use near_sdk::{
    PromiseResult, RuntimeFeesConfig, test_utils::VMContextBuilder, test_vm_config, testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

const NOW: u64 = 1_800_000_000_000;

fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}

fn context(caller: &str) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("clearing.testnet"))
        .signer_account_id(account(caller))
        .predecessor_account_id(account(caller))
        .attached_deposit(NearToken::from_yoctonear(1))
        .block_timestamp(NOW * 1_000_000)
        .block_height(100)
        .prepaid_gas(Gas::from_tgas(300));
    builder
}

fn callbacks(values: Vec<serde_json::Value>) {
    testing_env!(
        context("clearing.testnet").build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        values
            .into_iter()
            .map(|value| PromiseResult::Successful(serde_json::to_vec(&value).unwrap()))
            .collect()
    );
}

fn participant(company: &str, treasury: &str, owner: &str) -> Participant {
    Participant {
        company_id: company.into(),
        treasury_id: account(treasury),
        owner_id: account(owner),
        version: U64(1),
        policy_version: U64(1),
    }
}

fn manifest(id: &str) -> Manifest {
    Manifest {
        id: id.into(),
        asset: "USDC".into(),
        fee: U128(0),
        starts_at_ms: U64(NOW - 1_000),
        expires_at_ms: U64(NOW + 60_000),
        participants: vec![
            participant("company-a", "a.factory.testnet", "alice.testnet"),
            participant("company-b", "b.factory.testnet", "bob.testnet"),
        ],
        obligations: vec![
            Obligation {
                id: "invoice-a".into(),
                terms_hash: "a".repeat(64),
                debtor: "company-a".into(),
                creditor: "company-b".into(),
                original: U128(100),
                reduction: U128(70),
                residual: U128(30),
            },
            Obligation {
                id: "invoice-b".into(),
                terms_hash: "b".repeat(64),
                debtor: "company-b".into(),
                creditor: "company-a".into(),
                original: U128(70),
                reduction: U128(70),
                residual: U128(0),
            },
        ],
    }
}

fn ready(contract: &mut Clearing, manifest: Manifest) -> String {
    let id = manifest.id.clone();
    let manifest_json = serde_json::to_string(&manifest).unwrap();
    contract.rounds.insert(
        id.clone(),
        Round {
            hash: digest(&manifest_json),
            manifest,
            manifest_json,
            status: "ready".into(),
            consents: vec![],
            finalized_at_ms: None,
            finalized_height: None,
            request_nonce: U64(0),
            consent_requests: BTreeMap::new(),
            finalize_request: None,
        },
    );
    id
}

fn setup() -> Clearing {
    testing_env!(context("alice.testnet").build());
    Clearing::new(
        account("operator.testnet"),
        account("factory.testnet"),
        account("usdc.testnet"),
    )
}

fn treasury(owner: &str, version: &str) -> serde_json::Value {
    serde_json::json!({"owner_id": owner, "token_contract": "usdc.testnet", "paused": false, "policy_version": version})
}

#[test]
fn typed_views_lookup_arguments_and_digests_preserve_exact_json_bytes() {
    let contract = setup();
    let expected = serde_json::json!({"factory_id":contract.factory_id,"token_contract":contract.token_contract,"paused":contract.paused,"max_participants":8,"max_obligations":32});
    assert_eq!(serde_json::to_vec(&contract.get_config()).unwrap(), serde_json::to_vec(&expected).unwrap());
    let account_id = account("a.factory.testnet");
    assert_eq!(
        serde_json::to_vec(&AccountLookup { account_id: &account_id }).unwrap(),
        serde_json::to_vec(&serde_json::json!({"account_id":account_id})).unwrap(),
    );
    for value in ["", "approval terms", "quoted \"terms\" and unicode λ"] {
        let expected: String = env::sha256(value.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(digest(value), expected);
    }
}

fn request(contract: &mut Clearing, id: &str, company: &str, caller: &str) -> U64 {
    testing_env!(context(caller).build());
    let hash = contract.rounds.get(id).unwrap().hash.clone();
    contract.consent(id.into(), hash, company.into()).detach();
    *contract
        .rounds
        .get(id)
        .unwrap()
        .consent_requests
        .get(company)
        .unwrap()
}

fn consent(contract: &mut Clearing, id: &str, company: &str, caller: &str) {
    let request_id = request(contract, id, company, caller);
    callbacks(vec![treasury(caller, "1")]);
    assert!(contract.on_consented(id.into(), company.into(), account(caller), request_id));
}

#[test]
fn validates_exact_conservation_and_checked_amounts() {
    let _contract = setup();
    validate(&manifest("round-one"));
    let mut invalid = manifest("round-two");
    invalid.obligations[0].reduction = U128(69);
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&invalid))).is_err());
    let mut overflow = manifest("round-three");
    overflow.obligations[0].original = U128(u128::MAX);
    overflow.obligations[0].reduction = U128(u128::MAX);
    overflow.obligations[0].residual = U128(1);
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&overflow))).is_err());
    let mut changed_position = manifest("round-four");
    changed_position.obligations[0].reduction = U128(69);
    changed_position.obligations[0].residual = U128(31);
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&changed_position))).is_err());
}

#[test]
fn registration_requires_current_factory_creation_owner_and_policy() {
    let mut contract = setup();
    let id = ready(&mut contract, manifest("round-register"));
    contract.rounds.get_mut(&id).unwrap().status = "verifying".into();
    callbacks(vec![
        serde_json::json!({"account_id":"a.factory.testnet","token_contract":"usdc.testnet","status":"ready"}),
        treasury("alice.testnet", "1"),
        serde_json::json!({"account_id":"b.factory.testnet","token_contract":"usdc.testnet","status":"ready"}),
        treasury("rotated.testnet", "2"),
    ]);
    assert!(!contract.on_registered(id.clone()));
    assert_eq!(contract.rounds.get(&id).unwrap().status, "rejected");
}

#[test]
fn creditor_consent_locks_only_its_own_payables() {
    let mut contract = setup();
    let id = ready(&mut contract, manifest("round-lock"));
    consent(&mut contract, &id, "company-b", "bob.testnet");
    assert_eq!(contract.locks.get("b.factory.testnet:invoice-b"), Some(&id));
    assert!(contract.locks.get("a.factory.testnet:invoice-a").is_none());
    assert_eq!(
        contract.rounds.get(&id).unwrap().consents,
        vec!["company-b"]
    );
}

#[test]
fn stale_consent_requests_and_changed_treasury_authority_are_rejected() {
    let mut contract = setup();
    let id = ready(&mut contract, manifest("round-consent"));
    let old = request(&mut contract, &id, "company-a", "alice.testnet");
    let latest = request(&mut contract, &id, "company-a", "alice.testnet");
    callbacks(vec![treasury("alice.testnet", "1")]);
    assert!(!contract.on_consented(
        id.clone(),
        "company-a".into(),
        account("alice.testnet"),
        old
    ));
    callbacks(vec![treasury("rotated.testnet", "2")]);
    assert!(!contract.on_consented(
        id.clone(),
        "company-a".into(),
        account("alice.testnet"),
        latest
    ));
    callbacks(vec![treasury("alice.testnet", "2")]);
    assert!(!contract.on_consented(
        id.clone(),
        "company-a".into(),
        account("alice.testnet"),
        latest
    ));
    assert!(contract.locks.is_empty());
    assert!(contract.rounds.get(&id).unwrap().consents.is_empty());
}

#[test]
fn finalization_rechecks_all_authorities_and_fences_callback_replays() {
    let mut contract = setup();
    let id = ready(&mut contract, manifest("round-final"));
    consent(&mut contract, &id, "company-a", "alice.testnet");
    testing_env!(context("alice.testnet").build());
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    assert!(
        catch_unwind(AssertUnwindSafe(
            || contract.finalize_round(id.clone(), hash.clone())
        ))
        .is_err()
    );
    consent(&mut contract, &id, "company-b", "bob.testnet");
    testing_env!(context("alice.testnet").build());
    contract.finalize_round(id.clone(), hash.clone()).detach();
    let old = contract.rounds.get(&id).unwrap().finalize_request.unwrap();
    contract.finalize_round(id.clone(), hash).detach();
    let latest = contract.rounds.get(&id).unwrap().finalize_request.unwrap();
    callbacks(vec![
        treasury("alice.testnet", "1"),
        treasury("bob.testnet", "1"),
    ]);
    assert!(!contract.on_finalized(id.clone(), old));
    callbacks(vec![
        treasury("alice.testnet", "1"),
        treasury("bob.testnet", "2"),
    ]);
    assert!(!contract.on_finalized(id.clone(), latest));
    callbacks(vec![
        treasury("alice.testnet", "1"),
        treasury("bob.testnet", "1"),
    ]);
    assert!(contract.on_finalized(id.clone(), latest));
    assert!(!contract.on_finalized(id.clone(), latest));
    let finalized = contract.rounds.get(&id).unwrap();
    assert_eq!(finalized.status, "finalized");
    assert_eq!(finalized.finalized_height, Some(U64(100)));
    assert!(
        catch_unwind(AssertUnwindSafe(
            || contract.require_free("a.factory.testnet:invoice-a", "other-round")
        ))
        .is_err()
    );
}

#[test]
fn revocation_ignores_inflight_consent_and_releases_obligation_locks() {
    let mut contract = setup();
    let id = ready(&mut contract, manifest("round-revoke"));
    consent(&mut contract, &id, "company-a", "alice.testnet");
    let request_id = request(&mut contract, &id, "company-b", "bob.testnet");
    testing_env!(context("alice.testnet").build());
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    contract.revoke(id.clone(), hash);
    callbacks(vec![treasury("bob.testnet", "1")]);
    assert!(!contract.on_consented(id, "company-b".into(), account("bob.testnet"), request_id));
    contract.require_free("a.factory.testnet:invoice-a", "next-round");
}
