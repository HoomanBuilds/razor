use super::*;
use crate::cash::{CashPosition, CashStage};
use crate::tests::{account, callbacks, consent, context, manifest, ready, setup, treasury};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};

const NOW: u64 = 1_800_000_000_000;

fn cash_manifest(id: &str) -> Manifest {
    let mut value = manifest(id);
    value.cash = Some(CashTerms {
        mode: "cash_backed_native_v1".into(),
        network: "testnet".into(),
        token_contract: account("usdc.testnet"),
        refund_policy: "return_accepted_deposits_to_fixed_owner_on_cancel".into(),
        positions: vec![
            CashPosition {
                company_id: "company-a".into(),
                deposit_due: U128(30),
                credit_due: U128(0),
                destination: account("alice.testnet"),
            },
            CashPosition {
                company_id: "company-b".into(),
                deposit_due: U128(0),
                credit_due: U128(30),
                destination: account("bob.testnet"),
            },
        ],
    });
    value
}

fn configured() -> Clearing {
    let mut contract = setup();
    testing_env!(context("operator.testnet").build());
    contract.enable_cash("testnet".into(), Some(account("usdc.testnet")));
    contract
}

fn agreed(contract: &mut Clearing, id: &str) -> String {
    let terms = cash_manifest(id);
    validate(&terms);
    contract.require_cash_configuration(&terms);
    let id = ready(contract, terms);
    consent(contract, &id, "company-a", "alice.testnet");
    consent(contract, &id, "company-b", "bob.testnet");
    id
}

fn deposit_at(
    contract: &mut Clearing,
    id: &str,
    deposit_id: &str,
    sender: &str,
    amount: u128,
    at: u64,
    token: &str,
) -> U128 {
    let hash = contract.rounds.get(id).unwrap().hash.clone();
    testing_env!(context(token).block_timestamp(at * 1_000_000).build());
    let result = contract.ft_on_transfer(account(sender), U128(amount), serde_json::json!({
        "kind":"razor_clearing_cash_v1","round_id":id,"manifest_hash":hash,"company_id":"company-a","deposit_id":deposit_id
    }).to_string());
    match result {
        PromiseOrValue::Value(unused) => unused,
        _ => panic!("unexpected asynchronous deposit"),
    }
}

fn deposit(contract: &mut Clearing, id: &str, deposit_id: &str, amount: u128) -> U128 {
    deposit_at(
        contract,
        id,
        deposit_id,
        "alice.testnet",
        amount,
        NOW,
        "usdc.testnet",
    )
}

fn finalized(contract: &mut Clearing, id: &str) {
    testing_env!(context("alice.testnet").build());
    let hash = contract.rounds.get(id).unwrap().hash.clone();
    contract.finalize_round(id.into(), hash).detach();
    let nonce = contract.rounds.get(id).unwrap().finalize_request.unwrap();
    callbacks(vec![
        treasury("alice.testnet", "1"),
        treasury("bob.testnet", "1"),
    ]);
    assert!(contract.on_finalized(id.into(), nonce));
}

fn withdraw(contract: &mut Clearing, id: &str, kind: CashKind, nonce: u64) {
    let (company, caller) = match kind {
        CashKind::Credit => ("company-b", "bob.testnet"),
        CashKind::Refund => ("company-a", "alice.testnet"),
    };
    testing_env!(context(caller).build());
    let hash = contract.rounds.get(id).unwrap().hash.clone();
    contract
        .withdraw_cash(id.into(), hash, company.into(), kind, U64(nonce))
        .detach();
}

fn callback(outcome: PromiseResult) {
    testing_env!(
        context("clearing.testnet").build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![outcome]
    );
}

fn conserved(contract: &Clearing) {
    assert_eq!(
        contract.cash_accepted,
        contract.cash_available + contract.cash_pending + contract.cash_paid
    );
    let mut held = 0;
    let mut pending = 0;
    let mut paid = 0;
    for (_, round) in contract.rounds.iter() {
        let Some(cash) = &round.cash else { continue };
        for account in &cash.accounts {
            held += match cash.stage {
                CashStage::Funding => account.deposited.0,
                _ => account.credit_available.0 + account.refund_available.0,
            };
            pending += account.pending.as_ref().map_or(0, |value| value.amount.0);
            paid += account.credit_paid.0 + account.refund_paid.0;
        }
    }
    assert_eq!(
        (held, pending, paid),
        (
            contract.cash_available,
            contract.cash_pending,
            contract.cash_paid
        )
    );
}

#[test]
fn cash_configuration_requires_owner_and_canonical_or_explicit_testnet_token() {
    let mut contract = setup();
    testing_env!(context("alice.testnet").build());
    assert!(
        catch_unwind(AssertUnwindSafe(
            || contract.enable_cash("testnet".into(), Some(account("usdc.testnet")))
        ))
        .is_err()
    );
    testing_env!(context("operator.testnet").build());
    for (network, token) in [
        ("testnet", None),
        ("testnet", Some(account("wrong.testnet"))),
        ("mainnet", None),
        ("other", None),
    ] {
        assert!(
            catch_unwind(AssertUnwindSafe(
                || contract.enable_cash(network.into(), token)
            ))
            .is_err()
        );
    }
    contract.enable_cash("testnet".into(), Some(account("usdc.testnet")));
    assert!(
        catch_unwind(AssertUnwindSafe(
            || contract.enable_cash("testnet".into(), Some(account("usdc.testnet")))
        ))
        .is_err()
    );
    assert_eq!(
        contract.get_config().cash_network.as_deref(),
        Some("testnet")
    );
    let mut mainnet = Clearing::new(
        account("operator.testnet"),
        account("treasury.testnet"),
        account("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1"),
    );
    mainnet.enable_cash("mainnet".into(), None);
    assert_eq!(
        mainnet.get_config().cash_network.as_deref(),
        Some("mainnet")
    );
}

#[test]
fn exact_cash_positions_and_fixed_destinations_are_validated_onchain() {
    let contract = configured();
    let original = cash_manifest("cash-terms");
    validate(&original);
    let mut wrong = original.clone();
    wrong.cash.as_mut().unwrap().positions[1].credit_due = U128(31);
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&wrong))).is_err());
    wrong = original.clone();
    wrong.cash.as_mut().unwrap().positions[1].destination = account("mallory.testnet");
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&wrong))).is_err());
    wrong = original.clone();
    wrong.cash.as_mut().unwrap().positions.reverse();
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&wrong))).is_err());
    wrong = original.clone();
    wrong.cash.as_mut().unwrap().token_contract = account("wrong.testnet");
    assert!(
        catch_unwind(AssertUnwindSafe(
            || contract.require_cash_configuration(&wrong)
        ))
        .is_err()
    );
    wrong = original.clone();
    wrong.cash.as_mut().unwrap().network = "mainnet".into();
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&wrong))).is_err());
    let mut no_cycle = original.clone();
    for edge in &mut no_cycle.obligations {
        edge.reduction = U128(0);
        edge.residual = edge.original;
    }
    validate(&no_cycle);
    no_cycle.cash = None;
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&no_cycle))).is_err());
    let mut zero = original.clone();
    zero.obligations[0].original = U128(70);
    zero.obligations[0].residual = U128(0);
    for position in &mut zero.cash.as_mut().unwrap().positions {
        position.credit_due = U128(0);
        position.deposit_due = U128(0);
    }
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&zero))).is_err());
    let mut overflow = original.clone();
    let mut extra = overflow.obligations[0].clone();
    extra.id = "overflow-edge".into();
    extra.original = U128(u128::MAX);
    extra.reduction = U128(0);
    extra.residual = U128(u128::MAX);
    overflow.obligations.push(extra);
    assert!(catch_unwind(AssertUnwindSafe(|| validate(&overflow))).is_err());
}

#[test]
fn tagged_deposits_require_all_consents_and_handle_partial_excess_and_duplicates() {
    let mut contract = configured();
    let id = ready(&mut contract, cash_manifest("cash-deposit"));
    assert_eq!(
        deposit(&mut contract, &id, "deposit-before-consent", 10),
        U128(10)
    );
    consent(&mut contract, &id, "company-a", "alice.testnet");
    consent(&mut contract, &id, "company-b", "bob.testnet");
    assert_eq!(
        deposit_at(
            &mut contract,
            &id,
            "deposit-foreign-token",
            "alice.testnet",
            10,
            NOW,
            "foreign.testnet"
        ),
        U128(10)
    );
    assert_eq!(
        deposit_at(
            &mut contract,
            &id,
            "deposit-foreign-owner",
            "mallory.testnet",
            10,
            NOW,
            "usdc.testnet"
        ),
        U128(10)
    );
    assert_eq!(deposit(&mut contract, &id, "deposit-partial", 10), U128(0));
    assert_eq!(deposit(&mut contract, &id, "deposit-partial", 10), U128(10));
    assert_eq!(deposit(&mut contract, &id, "deposit-excess", 25), U128(5));
    assert_eq!(
        deposit(&mut contract, &id, "deposit-already-full", 9),
        U128(9)
    );
    let cash = contract.get_cash_round(id.clone()).unwrap();
    assert_eq!(cash.accounts[0].deposited, U128(30));
    assert_eq!(cash.deposits.len(), 2);
    let accepted = contract
        .get_cash_deposit(id.clone(), "company-a".into(), "deposit-excess".into())
        .unwrap();
    assert_eq!(
        (accepted.submitted, accepted.accepted, accepted.unused),
        (U128(25), U128(20), U128(5))
    );
    assert_eq!(
        (accepted.accepted_at_ms, accepted.accepted_height),
        (U64(NOW), U64(100))
    );
    assert!(
        contract
            .get_cash_deposit(id, "company-b".into(), "deposit-excess".into())
            .is_none()
    );
    conserved(&contract);
}

#[test]
fn exact_funding_and_current_authority_gate_atomic_credit_creation() {
    let mut contract = configured();
    let id = agreed(&mut contract, "cash-finalize");
    deposit(&mut contract, &id, "funding-partial", 29);
    testing_env!(context("alice.testnet").build());
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    assert!(
        catch_unwind(AssertUnwindSafe(
            || contract.finalize_round(id.clone(), hash.clone())
        ))
        .is_err()
    );
    assert_eq!(
        contract.get_cash_round(id.clone()).unwrap().accounts[1].credit_available,
        U128(0)
    );
    deposit(&mut contract, &id, "funding-complete", 1);
    testing_env!(context("alice.testnet").build());
    contract.finalize_round(id.clone(), hash).detach();
    let nonce = contract.rounds.get(&id).unwrap().finalize_request.unwrap();
    callbacks(vec![
        treasury("alice.testnet", "1"),
        treasury("bob.testnet", "2"),
    ]);
    assert!(!contract.on_finalized(id.clone(), nonce));
    assert_eq!(
        contract.get_cash_round(id.clone()).unwrap().accounts[1].credit_available,
        U128(0)
    );
    callbacks(vec![
        treasury("alice.testnet", "1"),
        treasury("bob.testnet", "1"),
    ]);
    assert!(contract.on_finalized(id.clone(), nonce));
    assert!(!contract.on_finalized(id.clone(), nonce));
    let cash = contract.get_cash_round(id.clone()).unwrap();
    assert_eq!(cash.stage, CashStage::Credits);
    assert_eq!(cash.accounts[1].credit_available, U128(30));
    assert_eq!(cash.accounts[0].credit_available, U128(0));
    assert_eq!(cash.deposits.len(), 2);
    assert!(
        catch_unwind(AssertUnwindSafe(|| contract.require_free(
            "treasury.testnet:company-a:invoice-a",
            "another-round"
        )))
        .is_err()
    );
    conserved(&contract);
}

#[test]
fn fixed_credit_withdrawals_hold_unknown_results_and_fence_callback_replays() {
    let mut contract = configured();
    let id = agreed(&mut contract, "cash-withdraw");
    deposit(&mut contract, &id, "funding-withdraw", 30);
    finalized(&mut contract, &id);
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    testing_env!(context("mallory.testnet").build());
    assert!(
        catch_unwind(AssertUnwindSafe(|| contract.withdraw_cash(
            id.clone(),
            hash,
            "company-b".into(),
            CashKind::Credit,
            U64(1)
        )))
        .is_err()
    );
    withdraw(&mut contract, &id, CashKind::Credit, 1);
    assert_eq!(
        (
            contract.cash_available,
            contract.cash_pending,
            contract.cash_paid
        ),
        (0, 30, 0)
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| withdraw(
            &mut contract,
            &id,
            CashKind::Credit,
            2
        )))
        .is_err()
    );
    testing_env!(context("clearing.testnet").build());
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(1),
        U128(30)
    ));
    assert!(
        contract.get_cash_round(id.clone()).unwrap().accounts[1]
            .pending
            .is_some()
    );
    callback(PromiseResult::Successful(vec![]));
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(2),
        U128(30)
    ));
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Refund,
        U64(1),
        U128(30)
    ));
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(1),
        U128(29)
    ));
    assert!(contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(1),
        U128(30)
    ));
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(1),
        U128(30)
    ));
    assert!(
        catch_unwind(AssertUnwindSafe(|| withdraw(
            &mut contract,
            &id,
            CashKind::Credit,
            2
        )))
        .is_err()
    );
    assert_eq!(
        contract.get_cash_round(id).unwrap().accounts[1].credit_paid,
        U128(30)
    );
    conserved(&contract);
}

#[test]
fn definitive_failure_restores_only_matching_credit_and_requires_next_nonce() {
    let mut contract = configured();
    let id = agreed(&mut contract, "cash-failed");
    deposit(&mut contract, &id, "funding-failed", 30);
    finalized(&mut contract, &id);
    withdraw(&mut contract, &id, CashKind::Credit, 1);
    callback(PromiseResult::Failed);
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(1),
        U128(30)
    ));
    assert_eq!(
        contract.get_cash_round(id.clone()).unwrap().accounts[1].credit_available,
        U128(30)
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| withdraw(
            &mut contract,
            &id,
            CashKind::Credit,
            1
        )))
        .is_err()
    );
    withdraw(&mut contract, &id, CashKind::Credit, 2);
    callback(PromiseResult::Failed);
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-b".into(),
        CashKind::Credit,
        U64(1),
        U128(30)
    ));
    assert_eq!(contract.cash_pending, 30);
    callback(PromiseResult::Successful(vec![]));
    assert!(contract.on_cash_withdrawn(id, "company-b".into(), CashKind::Credit, U64(2), U128(30)));
    conserved(&contract);
}

#[test]
fn cancelled_and_expired_rounds_refund_only_their_accepted_depositors() {
    let mut contract = configured();
    let id = agreed(&mut contract, "cash-refund");
    deposit(&mut contract, &id, "funding-refund", 17);
    testing_env!(context("bob.testnet").build());
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    contract.revoke(id.clone(), hash.clone());
    contract.revoke(id.clone(), hash);
    assert_eq!(
        contract.get_cash_round(id.clone()).unwrap().accounts[0].refund_available,
        U128(17)
    );
    assert_eq!(
        deposit(&mut contract, &id, "funding-after-revoke", 13),
        U128(13)
    );
    contract.require_free("treasury.testnet:company-a:invoice-a", "next-round");
    withdraw(&mut contract, &id, CashKind::Refund, 1);
    testing_env!(
        context("anyone.testnet")
            .block_timestamp((NOW + 60_000) * 1_000_000)
            .build()
    );
    contract.expire(id.clone());
    assert!(
        contract.get_cash_round(id.clone()).unwrap().accounts[0]
            .pending
            .is_some()
    );
    callback(PromiseResult::Failed);
    assert!(!contract.on_cash_withdrawn(
        id.clone(),
        "company-a".into(),
        CashKind::Refund,
        U64(1),
        U128(17)
    ));
    withdraw(&mut contract, &id, CashKind::Refund, 2);
    callback(PromiseResult::Successful(vec![]));
    assert!(contract.on_cash_withdrawn(
        id.clone(),
        "company-a".into(),
        CashKind::Refund,
        U64(2),
        U128(17)
    ));
    assert_eq!(
        contract.get_cash_round(id).unwrap().accounts[0].refund_paid,
        U128(17)
    );
    conserved(&contract);
}

#[test]
fn deadline_prevents_new_funding_and_late_finalization_without_erasing_refunds() {
    let mut contract = configured();
    let id = agreed(&mut contract, "cash-deadline");
    deposit(&mut contract, &id, "funding-at-deadline", 30);
    testing_env!(context("alice.testnet").build());
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    contract.finalize_round(id.clone(), hash).detach();
    let nonce = contract.rounds.get(&id).unwrap().finalize_request.unwrap();
    let mut builder = context("clearing.testnet");
    builder.block_timestamp((NOW + 60_000) * 1_000_000);
    testing_env!(
        builder.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![
            PromiseResult::Successful(serde_json::to_vec(&treasury("alice.testnet", "1")).unwrap()),
            PromiseResult::Successful(serde_json::to_vec(&treasury("bob.testnet", "1")).unwrap())
        ]
    );
    assert!(!contract.on_finalized(id.clone(), nonce));
    assert_eq!(
        deposit_at(
            &mut contract,
            &id,
            "funding-too-late",
            "alice.testnet",
            1,
            NOW + 60_000,
            "usdc.testnet"
        ),
        U128(1)
    );
    contract.expire(id.clone());
    assert_eq!(
        contract.get_cash_round(id).unwrap().accounts[0].refund_available,
        U128(30)
    );
    conserved(&contract);
}

#[test]
fn deposit_history_is_bounded_and_storage_budget_covers_recorded_cash_state() {
    let mut contract = configured();
    let terms = cash_manifest("cash-bounded");
    let wire = serde_json::to_string(&terms).unwrap();
    let budget =
        contract.registration_cost(wire.clone()).0 / env::storage_byte_cost().as_yoctonear();
    let base = env::storage_usage();
    let id = ready(&mut contract, terms);
    consent(&mut contract, &id, "company-a", "alice.testnet");
    consent(&mut contract, &id, "company-b", "bob.testnet");
    for index in 0..8 {
        assert_eq!(
            deposit(
                &mut contract,
                &id,
                &format!("deposit-{index}-{}", "a".repeat(80)),
                1
            ),
            U128(0)
        );
    }
    assert_eq!(
        deposit(&mut contract, &id, "deposit-over-bound", 22),
        U128(22)
    );
    assert_eq!(
        contract.get_cash_round(id.clone()).unwrap().deposits.len(),
        8
    );
    contract.rounds.flush();
    contract.locks.flush();
    assert!((env::storage_usage() - base) as u128 <= budget);
    testing_env!(context("alice.testnet").build());
    let hash = contract.rounds.get(&id).unwrap().hash.clone();
    contract.revoke(id.clone(), hash);
    withdraw(&mut contract, &id, CashKind::Refund, 1);
    callback(PromiseResult::Failed);
    contract.on_cash_withdrawn(id, "company-a".into(), CashKind::Refund, U64(1), U128(8));
    conserved(&contract);
}

#[test]
fn legacy_manifest_json_excludes_cash_and_keeps_old_storage_pricing() {
    let contract = configured();
    let terms = manifest("legacy-still-debt");
    let wire = serde_json::to_string(&terms).unwrap();
    assert!(!wire.contains("\"cash\""));
    assert_eq!(
        contract.registration_cost(wire.clone()),
        U128((wire.len() as u128 * 4 + 8192) * env::storage_byte_cost().as_yoctonear())
    );
    let decoded: Manifest = serde_json::from_str(&wire).unwrap();
    assert!(decoded.cash.is_none());
}
