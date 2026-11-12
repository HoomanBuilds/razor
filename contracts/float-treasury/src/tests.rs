use super::*;
use near_sdk::{
    PromiseResult, RuntimeFeesConfig, test_utils::VMContextBuilder, test_vm_config, testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

const NOW: u64 = 1_800_000_000_000;

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

fn setup(direct: bool) -> Treasury {
    call("owner.testnet", 0);
    let mut treasury = Treasury::new(
        account("owner.testnet"),
        account("usdc.testnet"),
        U128(500),
        U128(1_000),
    );
    treasury.balance = 1_000;
    call("owner.testnet", 1);
    treasury.set_role(account("agent.testnet"), "executor".into(), true);
    treasury.set_recipient(
        "recipient".into(),
        Destination {
            network: if direct { "near".into() } else { "base".into() },
            asset_id: if direct {
                "nep141:usdc.testnet".into()
            } else {
                "nep141:base-usdc".into()
            },
            address: if direct {
                "employee.testnet".into()
            } else {
                "0x1234".into()
            },
        },
        None,
        false,
        true,
    );
    call("agent.testnet", 0);
    treasury.propose_payment(
        "payment".into(),
        "recipient".into(),
        U128(100),
        U128(10),
        U64(NOW + 86_400_000),
        "invoice-1".into(),
    );
    call("owner.testnet", 1);
    treasury.approve_payment("payment".into());
    treasury
}

fn prepare(treasury: &mut Treasury, id: &str, direct: bool, amount: u128) {
    call("agent.testnet", 0);
    treasury.create_attempt(
        "payment".into(),
        id.into(),
        false,
        Route {
            kind: if direct {
                RouteKind::Direct
            } else {
                RouteKind::Intents
            },
            source_receiver: account(if direct {
                "employee.testnet"
            } else {
                "deposit.testnet"
            }),
            input_amount: U128(amount),
            output_amount: U128(100),
            quote_id: "provider-quote".into(),
            quote_hash: "a".repeat(64),
            deadline_ms: U64(NOW + 60_000),
        },
    );
    call("owner.testnet", 1);
    treasury.authorize_attempt("payment".into(), id.into());
}

fn execute(treasury: &mut Treasury, id: &str) {
    call("agent.testnet", 0);
    drop(treasury.execute_payment("payment".into(), id.into()));
}

#[test]
fn executor_cannot_approve_or_redirect_authorized_route() {
    let mut treasury = setup(false);
    call("agent.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.approve_payment("payment".into())
        ))
        .is_err()
    );
    prepare(&mut treasury, "attempt-1", false, 102);
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.create_attempt(
            "payment".into(),
            "attempt-2".into(),
            false,
            Route {
                kind: RouteKind::Intents,
                source_receiver: account("attacker.testnet"),
                input_amount: U128(102),
                output_amount: U128(100),
                quote_id: "different".into(),
                quote_hash: "b".repeat(64),
                deadline_ms: U64(NOW + 60_000),
            }
        )))
        .is_err()
    );
    assert_eq!(treasury.get_config().executor_trust_daily_budget, U128(0));
}

#[test]
fn source_sent_is_not_paid_and_duplicate_execution_is_rejected() {
    let mut treasury = setup(false);
    prepare(&mut treasury, "attempt-1", false, 102);
    execute(&mut treasury, "attempt-1");
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.execute_payment("payment".into(), "attempt-1".into())
        ))
        .is_err()
    );
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result("payment".into(), "attempt-1".into()));
    let payment = treasury.get_payment("payment".into()).unwrap();
    assert_eq!(payment.status, PaymentStatus::InFlight);
    assert_eq!(payment.attempts[0].status, AttemptStatus::SourceSent);
    assert_eq!(treasury.get_balance().balance, U128(898));
    assert!(!treasury.on_transfer_result("payment".into(), "attempt-1".into()));
    assert_eq!(treasury.get_balance().in_flight, U128(0));
}

#[test]
fn refund_reservation_uses_actual_cash_and_cumulative_fee_budget() {
    let mut treasury = setup(false);
    prepare(&mut treasury, "attempt-1", false, 102);
    execute(&mut treasury, "attempt-1");
    callback(PromiseResult::Successful(vec![]));
    treasury.on_transfer_result("payment".into(), "attempt-1".into());
    call("owner.testnet", 0);
    treasury.report_settlement(
        "payment".into(),
        "attempt-1".into(),
        SettlementOutcome::RefundPending,
        "provider-refund-pending".into(),
    );
    drop(treasury.confirm_refund(
        "payment".into(),
        "attempt-1".into(),
        U128(100),
        "source-refund-transaction".into(),
    ));
    let epoch = U64(treasury.balance_epoch);
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(998)).unwrap(),
    ));
    assert!(treasury.on_refund_verified("payment".into(), "attempt-1".into(), epoch));
    let payment = treasury.get_payment("payment".into()).unwrap();
    assert_eq!(payment.incurred_cost, U128(2));
    assert_eq!(payment.reservation, U128(108));
    assert_eq!(payment.status, PaymentStatus::Retryable);
    assert_eq!(treasury.get_balance().balance, U128(998));
    assert_eq!(treasury.get_balance().available, U128(890));
    assert!(!treasury.on_refund_verified("payment".into(), "attempt-1".into(), epoch));
    assert_eq!(treasury.get_balance().reserved, U128(108));
}

#[test]
fn failed_transfer_does_not_overreserve_reused_fee_headroom() {
    let mut treasury = setup(false);
    treasury.balance = 110;
    prepare(&mut treasury, "attempt-1", false, 100);
    execute(&mut treasury, "attempt-1");
    call("owner.testnet", 1);
    drop(treasury.withdraw_available(account("owner.testnet"), U128(10)));
    callback(PromiseResult::Failed);
    assert!(!treasury.on_transfer_result("payment".into(), "attempt-1".into()));
    assert_eq!(
        treasury.get_payment("payment".into()).unwrap().status,
        PaymentStatus::Held
    );
    assert_eq!(treasury.get_balance().balance, U128(100));
    assert_eq!(treasury.get_balance().reserved, U128(0));
    assert_eq!(treasury.get_daily_spend(U64(NOW / DAY_MS)), U128(0));
}

#[test]
fn pause_blocks_spending_and_owner_can_cancel_reservations() {
    let mut treasury = setup(true);
    prepare(&mut treasury, "attempt-1", true, 100);
    call("owner.testnet", 1);
    treasury.set_paused(true);
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.execute_payment("payment".into(), "attempt-1".into())
        ))
        .is_err()
    );
    call("owner.testnet", 1);
    treasury.cancel_payment("payment".into());
    assert_eq!(treasury.get_balance().reserved, U128(0));
    assert_eq!(treasury.get_balance().available, U128(1_000));
}

#[test]
fn direct_transfer_callback_confirms_delivery() {
    let mut treasury = setup(true);
    prepare(&mut treasury, "attempt-1", true, 100);
    execute(&mut treasury, "attempt-1");
    callback(PromiseResult::Successful(vec![]));
    treasury.on_transfer_result("payment".into(), "attempt-1".into());
    assert_eq!(
        treasury.get_payment("payment".into()).unwrap().status,
        PaymentStatus::Paid
    );
}

#[test]
fn discarded_unsent_route_requires_fresh_authorization() {
    let mut treasury = setup(false);
    prepare(&mut treasury, "attempt-1", false, 102);
    call("agent.testnet", 0);
    treasury.discard_attempt("payment".into(), "attempt-1".into());
    prepare(&mut treasury, "attempt-2", false, 103);
    assert_eq!(treasury.get_balance().reserved, U128(110));
    assert_eq!(
        treasury
            .get_attempt("payment".into(), "attempt-1".into())
            .unwrap()
            .status,
        AttemptStatus::Discarded
    );
    assert_eq!(
        treasury.get_obligation("invoice-1".into()),
        Some("payment".into())
    );
}

#[test]
fn owner_source_recovery_makes_late_callback_harmless() {
    let mut treasury = setup(false);
    prepare(&mut treasury, "attempt-1", false, 102);
    execute(&mut treasury, "attempt-1");
    call("owner.testnet", 1);
    assert!(treasury.recover_source_transfer(
        "payment".into(),
        "attempt-1".into(),
        true,
        "final-near-source-receipt".into()
    ));
    callback(PromiseResult::Successful(vec![]));
    assert!(!treasury.on_transfer_result("payment".into(), "attempt-1".into()));
    assert_eq!(treasury.get_balance().balance, U128(898));
    assert_eq!(treasury.get_balance().in_flight, U128(0));
    assert_eq!(
        treasury.get_payment("payment".into()).unwrap().status,
        PaymentStatus::InFlight
    );
}
