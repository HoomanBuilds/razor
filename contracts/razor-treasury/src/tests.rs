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
        None,
    );
    call("owner.testnet", 1);
    approve(&mut treasury);
    treasury
}

fn approve(treasury: &mut Treasury) -> Payment {
    let status = treasury.get_approval_status("payment".into(), None);
    treasury.approve_payment(
        "payment".into(),
        status.policy_version,
        status.payment_terms_hash,
    )
}

fn authorize(treasury: &mut Treasury, id: &str) -> Payment {
    let status = treasury.get_approval_status("payment".into(), Some(id.into()));
    treasury.authorize_attempt(
        "payment".into(),
        id.into(),
        status.policy_version,
        status.attempt_terms_hash.unwrap(),
    )
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
    authorize(treasury, id);
}

fn execute(treasury: &mut Treasury, id: &str) {
    call("agent.testnet", 0);
    drop(treasury.execute_payment("payment".into(), id.into()));
}

#[test]
fn executor_cannot_approve_or_redirect_authorized_route() {
    let mut treasury = setup(false);
    call("agent.testnet", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| approve(&mut treasury))).is_err());
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

#[test]
fn disabled_backup_cannot_execute_after_policy_reapproval() {
    let mut treasury = setup(false);
    call("owner.testnet", 1);
    treasury.cancel_payment("payment".into());
    treasury.set_recipient(
        "recipient".into(),
        Destination {
            asset_id: "base-usdc".into(),
            network: "base".into(),
            address: "0x1234".into(),
        },
        Some(Destination {
            asset_id: "nep141:usdc.testnet".into(),
            network: "near".into(),
            address: "fallback.testnet".into(),
        }),
        true,
        true,
    );
    call("agent.testnet", 0);
    treasury.propose_payment(
        "payment-2".into(),
        "recipient".into(),
        U128(100),
        U128(10),
        U64(NOW + 86_400_000),
        "invoice-2".into(),
        None,
    );
    call("owner.testnet", 1);
    let approval = treasury.get_approval_status("payment-2".into(), None);
    treasury.approve_payment(
        "payment-2".into(),
        approval.policy_version,
        approval.payment_terms_hash,
    );
    call("agent.testnet", 0);
    treasury.create_attempt(
        "payment-2".into(),
        "backup-attempt".into(),
        true,
        Route {
            kind: RouteKind::Direct,
            source_receiver: account("fallback.testnet"),
            input_amount: U128(100),
            output_amount: U128(100),
            quote_id: String::new(),
            quote_hash: String::new(),
            deadline_ms: U64(NOW + 60_000),
        },
    );
    call("owner.testnet", 1);
    let approval = treasury.get_approval_status("payment-2".into(), Some("backup-attempt".into()));
    treasury.authorize_attempt(
        "payment-2".into(),
        "backup-attempt".into(),
        approval.policy_version,
        approval.attempt_terms_hash.unwrap(),
    );
    treasury.set_backup_asset("near".into(), None);
    let approval = treasury.get_approval_status("payment-2".into(), None);
    treasury.approve_payment(
        "payment-2".into(),
        approval.policy_version,
        approval.payment_terms_hash,
    );
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.execute_payment("payment-2".into(), "backup-attempt".into())
        ))
        .is_err()
    );
    assert_eq!(treasury.get_balance().in_flight, U128(0));
    assert_eq!(treasury.get_balance().reserved, U128(110));
}

fn two_wallet_policy(treasury: &mut Treasury) {
    call("owner.testnet", 1);
    treasury.set_role(account("finance.testnet"), "approver".into(), true);
    treasury.set_approval_policy(
        vec![
            ApprovalTier {
                up_to: U128(100),
                required_approvals: 1,
            },
            ApprovalTier {
                up_to: U128(1_000),
                required_approvals: 2,
            },
        ],
        U64(treasury.policy_version),
    );
}

#[test]
fn total_cost_tiers_require_distinct_current_wallets_for_exact_route() {
    let mut treasury = setup(false);
    two_wallet_policy(&mut treasury);
    call("owner.testnet", 1);
    approve(&mut treasury);
    assert_eq!(
        treasury
            .get_approval_status("payment".into(), None)
            .required_approvals,
        2
    );
    prepare(&mut treasury, "attempt-1", false, 102);
    call("owner.testnet", 1);
    approve(&mut treasury);
    authorize(&mut treasury, "attempt-1");
    let status = treasury.get_approval_status("payment".into(), None);
    assert_eq!(status.payment_collected, 1);
    assert_eq!(status.attempt_collected, 1);
    assert!(!status.can_execute);
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.execute_payment("payment".into(), "attempt-1".into())
        ))
        .is_err()
    );
    call("finance.testnet", 1);
    approve(&mut treasury);
    assert!(
        !treasury
            .get_approval_status("payment".into(), None)
            .can_execute
    );
    authorize(&mut treasury, "attempt-1");
    assert!(
        treasury
            .get_approval_status("payment".into(), None)
            .can_execute
    );
    assert_eq!(treasury.get_balance().reserved, U128(110));
    execute(&mut treasury, "attempt-1");
    assert_eq!(treasury.get_balance().balance, U128(898));
}

#[test]
fn changed_policy_and_revoked_then_regranted_role_cannot_revive_votes() {
    let mut treasury = setup(false);
    two_wallet_policy(&mut treasury);
    call("owner.testnet", 1);
    approve(&mut treasury);
    prepare(&mut treasury, "attempt-1", false, 102);
    call("finance.testnet", 1);
    approve(&mut treasury);
    authorize(&mut treasury, "attempt-1");
    let previous = treasury.get_approval_status("payment".into(), None);
    assert!(previous.can_execute);
    call("owner.testnet", 1);
    treasury.set_role(account("finance.testnet"), "approver".into(), false);
    treasury.set_role(account("finance.testnet"), "approver".into(), true);
    let status = treasury.get_approval_status("payment".into(), None);
    assert_eq!(status.payment_collected, 0);
    assert_eq!(status.attempt_collected, 0);
    assert!(!status.can_execute);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.approve_payment(
            "payment".into(),
            previous.policy_version,
            previous.payment_terms_hash
        )))
        .is_err()
    );
    approve(&mut treasury);
    authorize(&mut treasury, "attempt-1");
    assert_eq!(
        treasury
            .get_approval_status("payment".into(), None)
            .attempt_collected,
        1
    );
    call("finance.testnet", 1);
    approve(&mut treasury);
    authorize(&mut treasury, "attempt-1");
    assert!(
        treasury
            .get_approval_status("payment".into(), None)
            .can_execute
    );
    call("agent.testnet", 0);
    treasury.discard_attempt("payment".into(), "attempt-1".into());
    prepare(&mut treasury, "attempt-2", false, 103);
    let status = treasury.get_approval_status("payment".into(), None);
    assert_eq!(status.attempt_collected, 1);
    assert!(!status.can_execute);
}

#[test]
fn prepared_route_reserves_funds_before_quorum_and_schedule_blocks_early_send() {
    let mut treasury = setup(true);
    call("owner.testnet", 1);
    treasury.cancel_payment("payment".into());
    two_wallet_policy(&mut treasury);
    call("agent.testnet", 0);
    treasury.propose_payment(
        "scheduled".into(),
        "recipient".into(),
        U128(100),
        U128(10),
        U64(NOW + 86_400_000),
        "scheduled-ref".into(),
        Some(U64(NOW + 60_000)),
    );
    treasury.create_attempt(
        "scheduled".into(),
        "scheduled-route".into(),
        false,
        Route {
            kind: RouteKind::Direct,
            source_receiver: account("employee.testnet"),
            input_amount: U128(100),
            output_amount: U128(100),
            quote_id: String::new(),
            quote_hash: String::new(),
            deadline_ms: U64(NOW + 120_000),
        },
    );
    assert_eq!(treasury.get_balance().reserved, U128(110));
    for caller in ["owner.testnet", "finance.testnet"] {
        call(caller, 1);
        let status = treasury.get_approval_status("scheduled".into(), None);
        treasury.approve_payment(
            "scheduled".into(),
            status.policy_version,
            status.payment_terms_hash,
        );
        let status = treasury.get_approval_status("scheduled".into(), None);
        treasury.authorize_attempt(
            "scheduled".into(),
            "scheduled-route".into(),
            status.policy_version,
            status.attempt_terms_hash.unwrap(),
        );
    }
    let status = treasury.get_approval_status("scheduled".into(), None);
    assert!(status.payment_ready && status.attempt_ready);
    assert!(!status.can_execute);
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.execute_payment("scheduled".into(), "scheduled-route".into())
        ))
        .is_err()
    );
    let mut due = context("agent.testnet", 0);
    due.block_timestamp((NOW + 60_000) * 1_000_000);
    testing_env!(due.build());
    assert!(
        treasury
            .get_approval_status("scheduled".into(), None)
            .can_execute
    );
    drop(treasury.execute_payment("scheduled".into(), "scheduled-route".into()));
    assert_eq!(treasury.get_balance().balance, U128(900));
}

#[test]
fn invalid_tier_shapes_and_changed_hash_are_rejected() {
    let mut treasury = setup(false);
    call("owner.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_approval_policy(
            vec![ApprovalTier {
                up_to: U128(1_000),
                required_approvals: 2
            }],
            U64(treasury.policy_version)
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_approval_policy(
            vec![ApprovalTier {
                up_to: U128(999),
                required_approvals: 1
            }],
            U64(treasury.policy_version)
        )))
        .is_err()
    );
    let status = treasury.get_approval_status("payment".into(), None);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.approve_payment(
            "payment".into(),
            status.policy_version,
            "0".repeat(64)
        )))
        .is_err()
    );
    assert_eq!(
        treasury
            .get_approval_status("payment".into(), None)
            .payment_collected,
        1
    );
}
