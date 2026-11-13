use super::*;
use near_sdk::{
    PromiseResult, RuntimeFeesConfig,
    test_utils::{VMContextBuilder, get_logs},
    test_vm_config, testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

const NOW: u64 = 1_800_000_000_000;
const UUID_A: &str = "11111111-1111-4111-8111-111111111111";
const UUID_B: &str = "22222222-2222-4222-8222-222222222222";

fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}
fn context(caller: &str, deposit: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("treasury.testnet"))
        .signer_account_id(account(caller))
        .predecessor_account_id(account(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(NOW * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    builder
}
fn call(caller: &str, deposit: u128) {
    testing_env!(context(caller, deposit).build());
}
fn callback(result: PromiseResult) {
    testing_env!(
        context("treasury.testnet", 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn company(uuid: &str, owner: &str) -> String {
    let suffix = env::sha256(owner.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{uuid}:{suffix}")
}
fn setup() -> (Treasury, String, String) {
    call("platform.testnet", 0);
    let mut treasury = Treasury::new(account("platform.testnet"), account("usdc.testnet"));
    let a = company(UUID_A, "alice.testnet");
    let b = company(UUID_B, "bob.testnet");
    call("alice.testnet", NearToken::from_near(1).as_yoctonear());
    treasury.register_company(a.clone(), U128(500), U128(1_000));
    call("bob.testnet", NearToken::from_near(1).as_yoctonear());
    treasury.register_company(b.clone(), U128(500), U128(1_000));
    (treasury, a, b)
}
fn deposit(treasury: &mut Treasury, company_id: &str, deposit_id: &str, amount: u128) {
    call("usdc.testnet", 0);
    let result = treasury.ft_on_transfer(
        account("depositor.testnet"),
        U128(amount),
        json!({"company_id":company_id,"deposit_id":deposit_id,"kind":"funding"}).to_string(),
    );
    assert!(matches!(result, PromiseOrValue::Value(U128(0))));
}

#[test]
fn shared_registration_binds_owner_and_charges_state_without_deploying_code() {
    call("platform.testnet", 0);
    let mut treasury = Treasury::new(account("platform.testnet"), account("usdc.testnet"));
    let id = company(UUID_A, "alice.testnet");
    let quote = treasury.quote_registration(id.clone());
    assert_eq!(
        quote.minimum_deposit,
        U128(storage_cost(REGISTRATION_BYTES))
    );
    assert!(quote.minimum_deposit.0 < NearToken::from_millinear(100).as_yoctonear());
    call("mallory.testnet", quote.minimum_deposit.0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.register_company(
            id.clone(),
            U128(10),
            U128(20)
        )))
        .is_err()
    );
    call("alice.testnet", quote.minimum_deposit.0);
    let config = treasury.register_company(id.clone(), U128(10), U128(20));
    assert_eq!(config.owner_id, account("alice.testnet"));
    assert_eq!(config.company_id, id);
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
    let storage = treasury.get_storage(id.clone());
    assert!(storage.storage_used.0 > 0 && storage.storage_available.0 > 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.register_company(
            id.clone(),
            U128(10),
            U128(20)
        )))
        .is_err()
    );
}

#[test]
fn exact_deposit_allocation_and_policy_authority_are_company_isolated() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "deposit-a", 100);
    deposit(&mut treasury, &b, "deposit-b", 50);
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(100));
    assert_eq!(treasury.get_balance(b.clone()).balance, U128(50));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(150)
    );
    assert!(
        treasury
            .get_deposit(b.clone(), "deposit-a".into(), None)
            .is_none()
    );
    assert_eq!(
        treasury
            .get_deposit(a.clone(), "deposit-a".into(), None)
            .unwrap()
            .amount,
        U128(100)
    );
    assert!(
        get_logs()
            .iter()
            .any(|log| log.contains("deposit_credited") && log.contains(&b))
    );
    call("alice.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_policy(
            b.clone(),
            U128(10),
            U128(20)
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.withdraw_available(
            b.clone(),
            account("alice.testnet"),
            U128(1)
        )))
        .is_err()
    );
}

#[test]
fn deposit_tags_are_company_scoped_and_untagged_messages_are_rejected() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "same-id", 100);
    deposit(&mut treasury, &b, "same-id", 50);
    let first = treasury
        .get_deposit(a.clone(), "same-id".into(), None)
        .unwrap();
    let second = treasury
        .get_deposit(b.clone(), "same-id".into(), None)
        .unwrap();
    assert_ne!(first.credit_id, second.credit_id);
    assert!(
        treasury
            .get_deposit(b.clone(), "same-id".into(), Some(first.credit_id))
            .is_none()
    );
    call("usdc.testnet", 0);
    for msg in [
        "".to_string(),
        "razor:retain".to_string(),
        json!({"company_id":a,"deposit_id":"x","kind":"funding","extra":true}).to_string(),
    ] {
        assert!(
            catch_unwind(AssertUnwindSafe(|| treasury.ft_on_transfer(
                account("depositor.testnet"),
                U128(1),
                msg
            )))
            .is_err()
        );
    }
    assert_eq!(treasury.get_balance(b).balance, U128(50));
}

#[test]
fn credit_identifier_overflow_cannot_wrap_or_increase_company_balance() {
    let (mut treasury, a, _) = setup();
    treasury.next_credit_id = u64::MAX;
    call("usdc.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.ft_on_transfer(
            account("depositor.testnet"),
            U128(10),
            json!({"company_id":a,"deposit_id":"overflow","kind":"funding"}).to_string(),
        )))
        .is_err()
    );
    assert_eq!(treasury.next_credit_id, u64::MAX);
    assert_eq!(treasury.get_balance(a).balance, U128(0));
}

#[test]
fn copied_deposit_tags_before_and_after_funding_cannot_replace_immutable_credits() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "public-tag", 1);
    let dust = treasury
        .get_deposit(a.clone(), "public-tag".into(), None)
        .unwrap();
    deposit(&mut treasury, &a, "public-tag", 100);
    let intended = treasury
        .get_deposit(a.clone(), "public-tag".into(), None)
        .unwrap();
    deposit(&mut treasury, &a, "public-tag", 2);
    let later = treasury
        .get_deposit(a.clone(), "public-tag".into(), None)
        .unwrap();
    assert!(dust.credit_id.0 < intended.credit_id.0 && intended.credit_id.0 < later.credit_id.0);
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(103));
    assert_eq!(
        treasury
            .get_deposit(a.clone(), "public-tag".into(), Some(intended.credit_id))
            .unwrap()
            .amount,
        U128(100)
    );
    assert_eq!(
        treasury
            .get_deposit(a.clone(), "public-tag".into(), Some(dust.credit_id))
            .unwrap()
            .amount,
        U128(1)
    );
    assert!(
        treasury
            .get_deposit(a.clone(), "other-tag".into(), Some(intended.credit_id))
            .is_none()
    );
    deposit(&mut treasury, &b, "public-tag", 70);
    assert_eq!(treasury.get_balance(b.clone()).balance, U128(70));
    assert!(
        treasury
            .get_deposit(b, "public-tag".into(), Some(intended.credit_id))
            .is_none()
    );
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(173)
    );
}

#[test]
fn pooled_balance_probes_never_allocate_unattributed_funds() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 100);
    let epoch = U64(treasury.company(&a).balance_epoch);
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(10_000)).unwrap(),
    ));
    assert!(treasury.on_balance_sync(a.clone(), epoch));
    assert_eq!(treasury.get_balance(a).balance, U128(100));
    assert_eq!(treasury.get_balance(b).balance, U128(0));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(100)
    );
}

#[test]
fn withdrawal_callbacks_remain_idempotent_with_other_company_money_present() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 100);
    deposit(&mut treasury, &b, "b", 500);
    call("alice.testnet", 1);
    drop(treasury.withdraw_available(a.clone(), account("alice.testnet"), U128(40)));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(600)
    );
    callback(PromiseResult::Failed);
    assert!(!treasury.on_withdraw_result(a.clone(), U64(1), U128(40)));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(100));
    assert!(!treasury.on_withdraw_result(a.clone(), U64(1), U128(40)));
    assert_eq!(treasury.get_balance(a).balance, U128(100));
    assert_eq!(treasury.get_balance(b).balance, U128(500));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(600)
    );
}

#[test]
fn company_owner_and_platform_owner_cannot_self_attest_pooled_refunds() {
    let (mut treasury, a, _) = setup();
    for caller in ["alice.testnet", "platform.testnet"] {
        call(caller, 0);
        assert!(
            catch_unwind(AssertUnwindSafe(|| treasury.confirm_refund(
                a.clone(),
                "payment".into(),
                "attempt".into(),
                U128(1),
                "receipt".into()
            )))
            .is_err()
        );
    }
    call("platform.testnet", 1);
    treasury.set_refund_reporter(Some(account("reporter.testnet")));
    call("alice.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.recover_source_transfer(
            a.clone(),
            "payment".into(),
            "attempt".into(),
            false,
            "receipt".into()
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.recover_retained_withdrawal(
            a.clone(),
            account("wrapped.testnet"),
            U64(1),
            false,
            "receipt".into()
        )))
        .is_err()
    );
}

#[test]
fn restricted_reporter_recovery_accepts_zero_deposit_without_relaxing_owner_authority() {
    let (mut treasury, a, _) = setup();
    call("platform.testnet", 1);
    treasury.set_refund_reporter(Some(account("reporter.testnet")));
    for deposit in [0, 1] {
        call("reporter.testnet", deposit);
        treasury.assert_recovery_authority(&a, false);
        treasury.assert_recovery_authority(&a, true);
    }
    call("reporter.testnet", 2);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.assert_recovery_authority(&a, false)
        ))
        .is_err()
    );
    call("alice.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.assert_recovery_authority(&a, true)
        ))
        .is_err()
    );
    call("mallory.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.assert_recovery_authority(&a, true)
        ))
        .is_err()
    );
    call("alice.testnet", 1);
    treasury.assert_recovery_authority(&a, true);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.assert_recovery_authority(&a, false)
        ))
        .is_err()
    );
}

#[test]
fn failed_retained_recovery_restores_only_after_current_global_coverage() {
    let (mut treasury, a, b) = setup();
    for (id, owner, amount) in [(&a, "alice.testnet", 50), (&b, "bob.testnet", 70)] {
        call(owner, 1);
        treasury.set_retained_asset(
            id.clone(),
            account("wrapped.testnet"),
            "nep141:wrapped.testnet".into(),
            "WRAP".into(),
            8,
            true,
        );
        call("wrapped.testnet", 0);
        drop(treasury.ft_on_transfer(
            account("depositor.testnet"),
            U128(amount),
            json!({"company_id":id,"deposit_id":"retained","kind":"retained"}).to_string(),
        ));
    }
    let asset_epoch = treasury
        .get_retained_asset(a.clone(), account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    call("alice.testnet", 1);
    drop(treasury.withdraw_retained_asset(
        a.clone(),
        account("wrapped.testnet"),
        account("alice.testnet"),
        U128(20),
        asset_epoch,
    ));
    enable_reporter(&mut treasury);
    call("reporter.testnet", 0);
    drop(treasury.recover_retained_withdrawal(
        a.clone(),
        account("wrapped.testnet"),
        U64(1),
        false,
        "final-failed-receipt".into(),
    ));
    let epoch = treasury
        .get_retained_asset(a.clone(), account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    let pool = U64(treasury.pool_epoch);
    assert_eq!(
        treasury
            .get_retained_asset(a.clone(), account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(30)
    );
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(100)).unwrap(),
    ));
    assert!(!treasury.on_retained_recovery_verified(
        a.clone(),
        account("wrapped.testnet"),
        U64(1),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(
        treasury
            .get_retained_asset(a.clone(), account("wrapped.testnet"))
            .unwrap()
            .in_flight,
        U128(20)
    );
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(120)).unwrap(),
    ));
    assert!(!treasury.on_retained_recovery_verified(
        a.clone(),
        account("wrapped.testnet"),
        U64(2),
        "wrong-withdrawal".into(),
        epoch,
        pool
    ));
    assert!(treasury.on_retained_recovery_verified(
        a.clone(),
        account("wrapped.testnet"),
        U64(1),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    let recovered = treasury
        .get_retained_asset(a.clone(), account("wrapped.testnet"))
        .unwrap();
    assert_eq!(recovered.balance, U128(50));
    assert_eq!(recovered.in_flight, U128(0));
    assert_eq!(
        recovered.withdrawal.unwrap().status,
        RetainedWithdrawalStatus::Failed
    );
    assert_eq!(
        treasury
            .get_retained_asset(b, account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(70)
    );
    assert!(!treasury.on_retained_recovery_verified(
        a,
        account("wrapped.testnet"),
        U64(1),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
}

#[test]
fn storage_topups_increase_only_storage_credit() {
    let (mut treasury, a, _) = setup();
    let before = treasury.get_storage(a.clone());
    call("sponsor.testnet", 1234);
    let after = treasury.add_storage(a.clone());
    assert_eq!(after.storage_credit.0, before.storage_credit.0 + 1234);
    assert_eq!(after.storage_used, before.storage_used);
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(0));
    call("sponsor.testnet", 0);
    assert!(catch_unwind(AssertUnwindSafe(|| treasury.add_storage(a))).is_err());
}

fn prepare_sending(treasury: &mut Treasury, company_id: &str, owner: &str) {
    call(owner, 1);
    treasury.set_recipient(
        company_id.into(),
        "recipient".into(),
        Destination {
            asset_id: "nep141:base-usdc".into(),
            network: "base".into(),
            address: "0x1234".into(),
        },
        None,
        false,
        true,
    );
    call(owner, 0);
    treasury.propose_payment(
        company_id.into(),
        "payment".into(),
        "recipient".into(),
        U128(100),
        U128(10),
        U64(NOW + 86_400_000),
        "invoice-1".into(),
        None,
    );
    call(owner, 1);
    let status = treasury.get_approval_status(company_id.into(), "payment".into(), None);
    treasury.approve_payment(
        company_id.into(),
        "payment".into(),
        status.policy_version,
        status.payment_terms_hash,
    );
    call(owner, 0);
    treasury.create_attempt(
        company_id.into(),
        "payment".into(),
        "attempt".into(),
        false,
        Route {
            kind: RouteKind::Intents,
            source_receiver: account("deposit.testnet"),
            input_amount: U128(102),
            output_amount: U128(100),
            quote_id: "provider-quote".into(),
            quote_hash: "a".repeat(64),
            deadline_ms: U64(NOW + 60_000),
        },
    );
    call(owner, 1);
    let status =
        treasury.get_approval_status(company_id.into(), "payment".into(), Some("attempt".into()));
    treasury.authorize_attempt(
        company_id.into(),
        "payment".into(),
        "attempt".into(),
        status.policy_version,
        status.attempt_terms_hash.unwrap(),
    );
    call(owner, 0);
    drop(treasury.execute_payment(company_id.into(), "payment".into(), "attempt".into()));
}

fn prepare_refund(treasury: &mut Treasury, company_id: &str, owner: &str) {
    prepare_sending(treasury, company_id, owner);
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result(company_id.into(), "payment".into(), "attempt".into()));
    call(owner, 0);
    treasury.report_settlement(
        company_id.into(),
        "payment".into(),
        "attempt".into(),
        SettlementOutcome::RefundPending,
        "provider-pending".into(),
        None,
    );
}

fn enable_reporter(treasury: &mut Treasury) {
    call("platform.testnet", 1);
    treasury.set_refund_reporter(Some(account("reporter.testnet")));
}

fn start_source_recovery(treasury: &mut Treasury, company_id: &str) -> (U64, U64) {
    call("reporter.testnet", 0);
    assert!(matches!(
        treasury.recover_source_transfer(
            company_id.into(),
            "payment".into(),
            "attempt".into(),
            false,
            "final-failed-receipt".into()
        ),
        PromiseOrValue::Promise(_)
    ));
    (
        U64(treasury.company(&company_id.to_string()).balance_epoch),
        U64(treasury.pool_epoch),
    )
}

#[test]
fn failed_source_recovery_checks_solvency_before_restoring_credit_and_rejects_replay() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 500);
    prepare_sending(&mut treasury, &a, "alice.testnet");
    enable_reporter(&mut treasury);
    let (epoch, pool) = start_source_recovery(&mut treasury, &a);
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(898));
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_398)).unwrap(),
    ));
    assert!(!treasury.on_source_recovery_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).in_flight, U128(102));
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_500)).unwrap(),
    ));
    assert!(treasury.on_source_recovery_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(1_000));
    assert_eq!(treasury.get_balance(a.clone()).in_flight, U128(0));
    assert_eq!(treasury.get_balance(b).balance, U128(500));
    assert!(!treasury.on_source_recovery_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a).balance, U128(1_000));
}

#[test]
fn another_company_credit_invalidates_a_pending_failed_source_recovery_probe() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 500);
    prepare_sending(&mut treasury, &a, "alice.testnet");
    enable_reporter(&mut treasury);
    let (epoch, pool) = start_source_recovery(&mut treasury, &a);
    deposit(&mut treasury, &b, "later", 50);
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_550)).unwrap(),
    ));
    assert!(!treasury.on_source_recovery_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(898));
    let (epoch, pool) = start_source_recovery(&mut treasury, &a);
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_550)).unwrap(),
    ));
    assert!(treasury.on_source_recovery_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a).balance, U128(1_000));
    assert_eq!(treasury.get_balance(b).balance, U128(550));
}

#[test]
fn an_original_source_callback_cannot_be_overridden_by_pending_manual_recovery() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 500);
    prepare_sending(&mut treasury, &a, "alice.testnet");
    enable_reporter(&mut treasury);
    let (epoch, pool) = start_source_recovery(&mut treasury, &a);
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result(a.clone(), "payment".into(), "attempt".into()));
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_500)).unwrap(),
    ));
    assert!(!treasury.on_source_recovery_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        "final-failed-receipt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(898));
    assert_eq!(
        treasury
            .get_attempt(a, "payment".into(), "attempt".into())
            .unwrap()
            .status,
        AttemptStatus::SourceSent
    );
}

fn start_refund(treasury: &mut Treasury, company_id: &str, receipt: &str) -> (U64, U64) {
    call("reporter.testnet", 0);
    drop(treasury.confirm_refund(
        company_id.into(),
        "payment".into(),
        "attempt".into(),
        U128(100),
        receipt.into(),
    ));
    (
        U64(treasury.company(&company_id.to_string()).balance_epoch),
        U64(treasury.pool_epoch),
    )
}

#[test]
fn refund_credit_requires_surplus_above_every_company_liability() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 500);
    prepare_refund(&mut treasury, &a, "alice.testnet");
    enable_reporter(&mut treasury);
    let (epoch, pool) = start_refund(&mut treasury, &a, "final-refund");
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_398)).unwrap(),
    ));
    assert!(!treasury.on_refund_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(898));
    assert_eq!(treasury.get_balance(b.clone()).balance, U128(500));
    let (epoch, pool) = start_refund(&mut treasury, &a, "final-refund");
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_498)).unwrap(),
    ));
    assert!(treasury.on_refund_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        epoch,
        pool
    ));
    assert!(!treasury.on_refund_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(998));
    assert_eq!(treasury.get_balance(b.clone()).balance, U128(500));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(1_498)
    );
    call("reporter.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.confirm_refund(
            b,
            "payment".into(),
            "attempt".into(),
            U128(100),
            "final-refund".into()
        )))
        .is_err()
    );
}

#[test]
fn another_company_deposit_invalidates_pending_refund_snapshot() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 500);
    prepare_refund(&mut treasury, &a, "alice.testnet");
    enable_reporter(&mut treasury);
    let (epoch, pool) = start_refund(&mut treasury, &a, "final-refund");
    deposit(&mut treasury, &b, "b-later", 50);
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_548)).unwrap(),
    ));
    assert!(!treasury.on_refund_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a.clone()).balance, U128(898));
    assert_eq!(treasury.get_balance(b.clone()).balance, U128(550));
    let (epoch, pool) = start_refund(&mut treasury, &a, "final-refund");
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_548)).unwrap(),
    ));
    assert!(treasury.on_refund_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a).balance, U128(998));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(1_548)
    );
}

#[test]
fn pending_owner_withdrawal_is_not_available_as_refund_surplus() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 500);
    prepare_refund(&mut treasury, &a, "alice.testnet");
    enable_reporter(&mut treasury);
    call("bob.testnet", 1);
    drop(treasury.withdraw_available(b.clone(), account("bob.testnet"), U128(100)));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(1_398)
    );
    let (epoch, pool) = start_refund(&mut treasury, &a, "final-refund");
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(1_398)).unwrap(),
    ));
    assert!(!treasury.on_refund_verified(
        a.clone(),
        "payment".into(),
        "attempt".into(),
        epoch,
        pool
    ));
    assert_eq!(treasury.get_balance(a).balance, U128(898));
    assert_eq!(treasury.get_balance(b).in_flight, U128(100));
}

#[test]
fn same_payment_identifiers_have_different_company_approval_hashes() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 1_000);
    deposit(&mut treasury, &b, "b", 1_000);
    prepare_refund(&mut treasury, &a, "alice.testnet");
    prepare_refund(&mut treasury, &b, "bob.testnet");
    let hash_a = treasury
        .get_approval_status(a, "payment".into(), None)
        .payment_terms_hash;
    let hash_b = treasury
        .get_approval_status(b, "payment".into(), None)
        .payment_terms_hash;
    assert_ne!(hash_a, hash_b);
}

#[test]
fn pool_probe_rejects_insolvency_even_if_it_covers_one_company_balance() {
    let (mut treasury, a, b) = setup();
    deposit(&mut treasury, &a, "a", 100);
    deposit(&mut treasury, &b, "b", 500);
    let epoch = U64(treasury.company(&a).balance_epoch);
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(100)).unwrap(),
    ));
    assert!(!treasury.on_balance_sync(a.clone(), epoch));
    assert_eq!(treasury.get_balance(a).balance, U128(100));
    assert_eq!(treasury.get_balance(b).balance, U128(500));
}

#[test]
fn retained_token_ledgers_and_callbacks_are_company_scoped() {
    let (mut treasury, a, b) = setup();
    for (id, owner) in [(&a, "alice.testnet"), (&b, "bob.testnet")] {
        call(owner, 1);
        treasury.set_retained_asset(
            id.clone(),
            account("wrapped.testnet"),
            "nep141:wrapped.testnet".into(),
            "WRAP".into(),
            8,
            true,
        );
    }
    for (id, deposit_id, amount) in [(&a, "retained-a", 50), (&b, "retained-b", 70)] {
        call("wrapped.testnet", 0);
        let result = treasury.ft_on_transfer(
            account("depositor.testnet"),
            U128(amount),
            json!({"company_id":id,"deposit_id":deposit_id,"kind":"retained"}).to_string(),
        );
        assert!(matches!(result, PromiseOrValue::Value(U128(0))));
    }
    assert_eq!(
        treasury.get_pool_liability(account("wrapped.testnet")),
        U128(120)
    );
    call("alice.testnet", 1);
    let epoch = treasury
        .get_retained_asset(a.clone(), account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    drop(treasury.withdraw_retained_asset(
        a.clone(),
        account("wrapped.testnet"),
        account("alice.testnet"),
        U128(20),
        epoch,
    ));
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_retained_withdraw_result(a.clone(), account("wrapped.testnet"), U64(1)));
    assert!(!treasury.on_retained_withdraw_result(a.clone(), account("wrapped.testnet"), U64(1)));
    assert_eq!(
        treasury
            .get_retained_asset(a, account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(30)
    );
    assert_eq!(
        treasury
            .get_retained_asset(b, account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(70)
    );
    assert_eq!(
        treasury.get_pool_liability(account("wrapped.testnet")),
        U128(100)
    );
}
