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

fn setup(direct: bool) -> CompanyTreasury {
    call("owner.testnet", 0);
    let mut treasury = CompanyTreasury::new(
        "company-a".into(),
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

fn approve(treasury: &mut CompanyTreasury) -> Payment {
    let status = treasury.get_approval_status("payment".into(), None);
    treasury.approve_payment(
        "payment".into(),
        status.policy_version,
        status.payment_terms_hash,
    )
}

fn authorize(treasury: &mut CompanyTreasury, id: &str) -> Payment {
    let status = treasury.get_approval_status("payment".into(), Some(id.into()));
    treasury.authorize_attempt(
        "payment".into(),
        id.into(),
        status.policy_version,
        status.attempt_terms_hash.unwrap(),
    )
}

fn prepare(treasury: &mut CompanyTreasury, id: &str, direct: bool, amount: u128) {
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

fn execute(treasury: &mut CompanyTreasury, id: &str) {
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
    assert_eq!(treasury.unsettled_payments, 1);
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
        None,
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
    assert!(treasury.on_refund_verified(
        "payment".into(),
        "attempt-1".into(),
        epoch,
        U128(treasury.balance),
        true
    ));
    let payment = treasury.get_payment("payment".into()).unwrap();
    assert_eq!(payment.incurred_cost, U128(2));
    assert_eq!(payment.reservation, U128(108));
    assert_eq!(payment.status, PaymentStatus::Retryable);
    assert_eq!(treasury.get_balance().balance, U128(998));
    assert_eq!(treasury.get_balance().available, U128(890));
    assert!(!treasury.on_refund_verified(
        "payment".into(),
        "attempt-1".into(),
        epoch,
        U128(treasury.balance),
        true
    ));
    assert_eq!(treasury.get_balance().reserved, U128(108));
    assert_eq!(treasury.unsettled_payments, 0);
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
    assert_eq!(treasury.unsettled_payments, 0);
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
    assert_eq!(treasury.unsettled_payments, 0);
}

#[test]
fn ownership_recovery_requires_pause_settled_transfers_and_reachable_quorum() {
    let mut treasury = setup(false);
    call("owner.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.transfer_ownership(account("new.testnet"))
        ))
        .is_err()
    );
    treasury.set_role(account("approver.testnet"), "approver".into(), true);
    treasury.set_approval_policy(
        vec![ApprovalTier {
            up_to: U128(1_000),
            required_approvals: 2,
        }],
        U64(treasury.policy_version),
    );
    treasury.set_paused(true);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.transfer_ownership(account("approver.testnet"))
        ))
        .is_err()
    );
    assert_eq!(treasury.get_config().owner_id, account("owner.testnet"));
    treasury.transfer_ownership(account("new.testnet"));
    assert_eq!(treasury.get_config().owner_id, account("new.testnet"));
}

#[test]
fn ownership_recovery_waits_for_final_settlement_even_after_source_callback() {
    let mut treasury = setup(false);
    prepare(&mut treasury, "attempt-1", false, 102);
    execute(&mut treasury, "attempt-1");
    call("owner.testnet", 1);
    treasury.set_paused(true);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.transfer_ownership(account("new.testnet"))
        ))
        .is_err()
    );
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result("payment".into(), "attempt-1".into()));
    call("owner.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.transfer_ownership(account("new.testnet"))
        ))
        .is_err()
    );
    treasury.report_settlement(
        "payment".into(),
        "attempt-1".into(),
        SettlementOutcome::Uncertain,
        "uncertain-final-receipt".into(),
        None,
    );
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.transfer_ownership(account("new.testnet"))
        ))
        .is_err()
    );
    treasury.report_settlement(
        "payment".into(),
        "attempt-1".into(),
        SettlementOutcome::Delivered,
        "delivered-final-receipt".into(),
        Some(U128(100)),
    );
    assert_eq!(treasury.unsettled_payments, 0);
    treasury.transfer_ownership(account("new.testnet"));
    assert_eq!(treasury.get_config().owner_id, account("new.testnet"));
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

fn two_wallet_policy(treasury: &mut CompanyTreasury) {
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

fn register_retained(treasury: &mut CompanyTreasury) {
    call("owner.testnet", 1);
    treasury.set_retained_asset(
        account("wrapped.testnet"),
        "nep141:wrapped.testnet".into(),
        "WRAP".into(),
        8,
        true,
    );
}

#[test]
fn ownership_recovery_waits_for_retained_withdrawal_callbacks() {
    let mut treasury = setup(false);
    register_retained(&mut treasury);
    call("wrapped.testnet", 0);
    drop(treasury.ft_on_transfer(
        account("depositor.testnet"),
        U128(500),
        "razor:retain".into(),
    ));
    drop(treasury.refresh_retained_balance(account("wrapped.testnet")));
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(500)).unwrap(),
    ));
    assert!(treasury.on_retained_balance_sync(account("wrapped.testnet"), epoch));
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    call("owner.testnet", 1);
    drop(treasury.withdraw_retained_asset(
        account("wrapped.testnet"),
        account("owner.testnet"),
        U128(100),
        epoch,
    ));
    treasury.set_paused(true);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.transfer_ownership(account("new.testnet"))
        ))
        .is_err()
    );
    callback(PromiseResult::Failed);
    assert!(treasury.on_retained_withdraw_result(account("wrapped.testnet"), U64(1)));
    call("owner.testnet", 1);
    treasury.transfer_ownership(account("new.testnet"));
    assert_eq!(treasury.get_config().owner_id, account("new.testnet"));
}

#[test]
fn retained_deposits_credit_exact_transfer_without_absorbing_pooled_balance() {
    let mut treasury = setup(false);
    register_retained(&mut treasury);
    call("wrapped.testnet", 0);
    drop(treasury.ft_on_transfer(
        account("depositor.testnet"),
        U128(500),
        "razor:retain".into(),
    ));
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    assert_eq!(
        treasury
            .get_retained_asset(account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(500)
    );
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(450)).unwrap(),
    ));
    assert_eq!(
        treasury.on_retained_deposit_sync(account("wrapped.testnet"), epoch),
        U128(0)
    );
    assert_eq!(
        treasury
            .get_retained_asset(account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(500)
    );
    assert_eq!(treasury.get_balance().balance, U128(1_000));
    assert_eq!(treasury.get_balance().reserved, U128(110));
    call("unknown.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.ft_on_transfer(
            account("depositor.testnet"),
            U128(1),
            "razor:retain".into()
        )))
        .is_err()
    );
    call("usdc.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.ft_on_transfer(
            account("depositor.testnet"),
            U128(1),
            "razor:retain".into()
        )))
        .is_err()
    );
}

#[test]
fn retained_probes_and_withdrawal_callbacks_are_versioned_and_idempotent() {
    let mut treasury = setup(false);
    register_retained(&mut treasury);
    call("wrapped.testnet", 0);
    drop(treasury.ft_on_transfer(
        account("depositor.testnet"),
        U128(500),
        "razor:retain".into(),
    ));
    call("reader.testnet", 0);
    drop(treasury.refresh_retained_balance(account("wrapped.testnet")));
    let older = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    drop(treasury.refresh_retained_balance(account("wrapped.testnet")));
    let current = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(500)).unwrap(),
    ));
    assert!(!treasury.on_retained_balance_sync(account("wrapped.testnet"), older));
    assert!(treasury.on_retained_balance_sync(account("wrapped.testnet"), current));
    assert!(!treasury.on_retained_balance_sync(account("wrapped.testnet"), current));
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    call("owner.testnet", 1);
    drop(treasury.withdraw_retained_asset(
        account("wrapped.testnet"),
        account("owner.testnet"),
        U128(100),
        epoch,
    ));
    let first_id = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .withdrawal
        .unwrap()
        .id;
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.refresh_retained_balance(account("wrapped.testnet"))
        ))
        .is_err()
    );
    callback(PromiseResult::Failed);
    assert!(treasury.on_retained_withdraw_result(account("wrapped.testnet"), first_id));
    assert!(!treasury.on_retained_withdraw_result(account("wrapped.testnet"), first_id));
    assert_eq!(
        treasury
            .get_retained_asset(account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(500)
    );
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    call("owner.testnet", 1);
    drop(treasury.withdraw_retained_asset(
        account("wrapped.testnet"),
        account("owner.testnet"),
        U128(200),
        epoch,
    ));
    let second_id = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .withdrawal
        .unwrap()
        .id;
    callback(PromiseResult::Failed);
    assert!(!treasury.on_retained_withdraw_result(account("wrapped.testnet"), first_id));
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_retained_withdraw_result(account("wrapped.testnet"), second_id));
    assert!(!treasury.on_retained_withdraw_result(account("wrapped.testnet"), second_id));
    assert_eq!(
        treasury
            .get_retained_asset(account("wrapped.testnet"))
            .unwrap()
            .balance,
        U128(300)
    );
    assert_eq!(treasury.get_balance().balance, U128(1_000));
}

#[test]
fn retained_assets_require_owner_identity_and_pause_but_retirement_preserves_withdrawal() {
    let mut treasury = setup(false);
    call("agent.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_retained_asset(
            account("wrapped.testnet"),
            "nep141:wrapped.testnet".into(),
            "WRAP".into(),
            8,
            true
        )))
        .is_err()
    );
    call("owner.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_retained_asset(
            account("usdc.testnet"),
            "nep141:usdc.testnet".into(),
            "USDC".into(),
            6,
            true
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_retained_asset(
            account("wrapped.testnet"),
            "wrong-token".into(),
            "WRAP".into(),
            8,
            true
        )))
        .is_err()
    );
    register_retained(&mut treasury);
    register_retained(&mut treasury);
    assert_eq!(treasury.get_retained_assets().len(), 1);
    call("wrapped.testnet", 0);
    drop(treasury.ft_on_transfer(
        account("depositor.testnet"),
        U128(500),
        "razor:retain".into(),
    ));
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    callback(PromiseResult::Successful(
        near_sdk::serde_json::to_vec(&U128(500)).unwrap(),
    ));
    treasury.on_retained_deposit_sync(account("wrapped.testnet"), epoch);
    call("owner.testnet", 1);
    treasury.set_retained_asset(
        account("wrapped.testnet"),
        "nep141:wrapped.testnet".into(),
        "WRAP".into(),
        8,
        false,
    );
    treasury.set_paused(true);
    let epoch = treasury
        .get_retained_asset(account("wrapped.testnet"))
        .unwrap()
        .balance_epoch;
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.withdraw_retained_asset(
            account("wrapped.testnet"),
            account("owner.testnet"),
            U128(1),
            epoch
        )))
        .is_err()
    );
    treasury.set_paused(false);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_retained_asset(
            account("wrapped.testnet"),
            "nep141:wrapped.testnet".into(),
            "WRAP".into(),
            9,
            true
        )))
        .is_err()
    );
    drop(treasury.withdraw_retained_asset(
        account("wrapped.testnet"),
        account("owner.testnet"),
        U128(500),
        epoch,
    ));
    assert_eq!(
        treasury
            .get_retained_asset(account("wrapped.testnet"))
            .unwrap()
            .in_flight,
        U128(500)
    );
    assert_eq!(treasury.get_balance().reserved, U128(110));
}

fn partial_source() -> CompanyTreasury {
    let mut treasury = setup(false);
    prepare(&mut treasury, "attempt-1", false, 102);
    execute(&mut treasury, "attempt-1");
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result("payment".into(), "attempt-1".into()));
    call("owner.testnet", 0);
    treasury
}

#[test]
fn partial_closure_preserves_source_cost_and_cannot_retry_the_original() {
    let mut treasury = partial_source();
    let hash = treasury.get_payment("payment".into()).unwrap().attempts[0]
        .route
        .quote_hash
        .clone();
    let payment = treasury.report_partial_settlement(
        "payment".into(),
        "attempt-1".into(),
        hash.clone(),
        U128(60),
        U128(60),
        true,
        "terminal-partial-proof".into(),
    );
    assert_eq!(payment.status, PaymentStatus::PartiallyPaid);
    assert_eq!(payment.amount, U128(100));
    assert_eq!(payment.attempts[0].actual_output, U128(60));
    assert_eq!(payment.attempts[0].credited_amount, U128(60));
    assert_eq!(payment.attempts[0].route.input_amount, U128(102));
    assert_eq!(treasury.get_balance().balance, U128(898));
    assert_eq!(treasury.get_balance().reserved, U128(0));
    assert_eq!(treasury.unsettled_payments, 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.report_partial_settlement(
            "payment".into(),
            "attempt-1".into(),
            hash,
            U128(60),
            U128(60),
            true,
            "terminal-partial-proof".into()
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| prepare(
            &mut treasury,
            "attempt-2",
            false,
            42
        )))
        .is_err()
    );
    call("owner.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.cancel_payment("payment".into())
        ))
        .is_err()
    );
}

#[test]
fn partial_closure_requires_reporter_exact_quote_amount_bounds_and_terminal_evidence() {
    let mut treasury = partial_source();
    let hash = treasury.get_payment("payment".into()).unwrap().attempts[0]
        .route
        .quote_hash
        .clone();
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.report_partial_settlement(
            "payment".into(),
            "attempt-1".into(),
            hash.clone(),
            U128(60),
            U128(60),
            true,
            "partial-proof".into()
        )))
        .is_err()
    );
    call("owner.testnet", 0);
    for (actual, credit, closed, quote) in [
        (0, 60, true, hash.clone()),
        (100, 60, true, hash.clone()),
        (60, 0, true, hash.clone()),
        (60, 100, true, hash.clone()),
        (60, 60, false, hash.clone()),
        (60, 60, true, "0".repeat(64)),
    ] {
        assert!(
            catch_unwind(AssertUnwindSafe(|| treasury.report_partial_settlement(
                "payment".into(),
                "attempt-1".into(),
                quote,
                U128(actual),
                U128(credit),
                closed,
                "partial-proof".into()
            )))
            .is_err()
        );
    }
    assert_eq!(
        treasury.get_payment("payment".into()).unwrap().status,
        PaymentStatus::InFlight
    );
    assert_eq!(treasury.unsettled_payments, 1);
}

#[test]
fn full_delivery_requires_actual_output_and_short_output_never_closes_as_paid() {
    let mut treasury = partial_source();
    for actual in [None, Some(U128(0)), Some(U128(60))] {
        assert!(
            catch_unwind(AssertUnwindSafe(|| treasury.report_settlement(
                "payment".into(),
                "attempt-1".into(),
                SettlementOutcome::Delivered,
                "delivery-proof".into(),
                actual
            )))
            .is_err()
        );
    }
    assert_eq!(
        treasury.get_payment("payment".into()).unwrap().status,
        PaymentStatus::InFlight
    );
    assert_eq!(
        treasury
            .report_settlement(
                "payment".into(),
                "attempt-1".into(),
                SettlementOutcome::Delivered,
                "delivery-proof".into(),
                Some(U128(100))
            )
            .status,
        PaymentStatus::Paid
    );
}

#[test]
fn observed_partial_output_cannot_be_turned_into_full_refund_recovery() {
    let mut treasury = partial_source();
    treasury.report_settlement(
        "payment".into(),
        "attempt-1".into(),
        SettlementOutcome::Uncertain,
        "observed-output-proof".into(),
        Some(U128(60)),
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.report_settlement(
            "payment".into(),
            "attempt-1".into(),
            SettlementOutcome::RefundPending,
            "refund-proof".into(),
            None
        )))
        .is_err()
    );
    let hash = treasury.get_payment("payment".into()).unwrap().attempts[0]
        .route
        .quote_hash
        .clone();
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.report_partial_settlement(
            "payment".into(),
            "attempt-1".into(),
            hash.clone(),
            U128(50),
            U128(50),
            true,
            "smaller-output-proof".into()
        )))
        .is_err()
    );
    assert_eq!(
        treasury
            .report_partial_settlement(
                "payment".into(),
                "attempt-1".into(),
                hash,
                U128(60),
                U128(60),
                true,
                "terminal-partial-proof".into()
            )
            .status,
        PaymentStatus::PartiallyPaid
    );
}

fn standing_time(caller: &str, deposit: u128, time: u64) {
    let mut builder = context(caller, deposit);
    builder.block_timestamp(time * 1_000_000);
    testing_env!(builder.build());
}

fn standing_grant(treasury: &mut CompanyTreasury) -> StandingMandate {
    call("owner.testnet", 1);
    treasury.grant_standing_mandate(StandingMandateTerms {
        id: "vendor-grant".into(),
        recipient_id: "recipient".into(),
        recipient_version: U64(1),
        supplier_profile_hash: "a".repeat(64),
        actor_id: account("agent.testnet"),
        actor_public_key: env::signer_account_pk(),
        per_payment_max_input: U128(200),
        period_max_input: U128(300),
        lifetime_max_input: U128(450),
        period_ms: U64(DAY_MS),
        valid_from_ms: U64(NOW),
        expires_at_ms: U64(NOW + 10 * DAY_MS),
        invoice_condition: "accepted_vendor_bill_application_gate".into(),
    })
}

fn standing_pay(treasury: &mut CompanyTreasury, grant: &StandingMandate, id: &str, amount: u128) {
    drop(treasury.execute_standing_payment(
        grant.terms.id.clone(),
        id.into(),
        format!("attempt-{id}"),
        U128(amount),
        U128(10),
        format!("bill-{id}"),
        grant.terms_hash.clone(),
        "b".repeat(64),
    ));
}

#[test]
fn standing_native_routes_are_constructed_and_worst_case_budget_is_atomic() {
    let mut treasury = setup(true);
    let grant = standing_grant(&mut treasury);
    call("agent.testnet", 0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "too-soon",
            100
        )))
        .is_err()
    );
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    standing_pay(&mut treasury, &grant, "first", 180);
    let payment = treasury.get_payment("first".into()).unwrap();
    assert_eq!(payment.approvals.len(), 0);
    assert_eq!(
        payment.attempts[0].route.source_receiver,
        account("employee.testnet")
    );
    assert_eq!(payment.attempts[0].route.input_amount, U128(180));
    assert_eq!(payment.attempts[0].route.output_amount, U128(180));
    assert_eq!(payment.attempts[0].destination, grant.destination);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "second",
            110
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "first",
            1
        )))
        .is_err()
    );
    let usage = treasury.get_standing_mandate(grant.terms.id).unwrap();
    assert_eq!(usage.period_used_input, U128(190));
    assert_eq!(usage.lifetime_used_input, U128(190));
    assert_eq!(usage.pending_input, U128(190));
}

#[test]
fn standing_failed_and_duplicate_callbacks_never_reopen_period_or_lifetime_usage() {
    let mut treasury = setup(true);
    let grant = standing_grant(&mut treasury);
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    standing_pay(&mut treasury, &grant, "old", 180);
    standing_time("agent.testnet", 0, NOW + 2 * DAY_MS);
    standing_pay(&mut treasury, &grant, "new", 180);
    callback(PromiseResult::Failed);
    assert!(!treasury.on_transfer_result("old".into(), "attempt-old".into()));
    let balance = treasury.get_balance().balance;
    assert!(!treasury.on_transfer_result("old".into(), "attempt-old".into()));
    assert_eq!(treasury.get_balance().balance, balance);
    let usage = treasury
        .get_standing_mandate(grant.terms.id.clone())
        .unwrap();
    assert_eq!(usage.period_used_input, U128(190));
    assert_eq!(usage.lifetime_used_input, U128(380));
    assert_eq!(usage.pending_input, U128(190));
    assert_eq!(
        treasury.get_payment("old".into()).unwrap().status,
        PaymentStatus::Held
    );
    standing_time("agent.testnet", 0, NOW + 3 * DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "lifetime",
            80
        )))
        .is_err()
    );
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result("new".into(), "attempt-new".into()));
    assert!(!treasury.on_transfer_result("new".into(), "attempt-new".into()));
    assert_eq!(
        treasury
            .get_standing_mandate(grant.terms.id)
            .unwrap()
            .pending_input,
        U128(0)
    );
}

#[test]
fn standing_owner_grant_requires_highest_company_quorum_and_current_versions() {
    let mut treasury = setup(true);
    call("owner.testnet", 1);
    treasury.set_role(account("finance.testnet"), "approver".into(), true);
    treasury.set_approval_policy(
        vec![
            ApprovalTier {
                up_to: U128(100),
                required_approvals: 1,
            },
            ApprovalTier {
                up_to: U128(1000),
                required_approvals: 2,
            },
        ],
        U64(treasury.policy_version),
    );
    let grant = standing_grant(&mut treasury);
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "small",
            10
        )))
        .is_err()
    );
    standing_time("finance.testnet", 1, NOW + DAY_MS);
    treasury.approve_standing_mandate(grant.terms.id.clone(), grant.terms_hash.clone());
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    standing_pay(&mut treasury, &grant, "quorum", 10);
    standing_time("owner.testnet", 1, NOW + DAY_MS);
    treasury.set_policy(U128(500), U128(1000));
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "stale",
            10
        )))
        .is_err()
    );
}

#[test]
fn standing_pause_revoke_recipient_changes_and_actual_key_fail_closed() {
    let mut treasury = setup(true);
    let grant = standing_grant(&mut treasury);
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    let mut wrong_key = context("agent.testnet", 0);
    wrong_key
        .block_timestamp((NOW + DAY_MS) * 1_000_000)
        .signer_account_pk(
            near_sdk::PublicKey::from_parts(near_sdk::CurveType::ED25519, vec![7; 32]).unwrap(),
        );
    testing_env!(wrong_key.build());
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "key",
            10
        )))
        .is_err()
    );
    standing_time("owner.testnet", 1, NOW + DAY_MS);
    treasury.set_standing_mandate_status(grant.terms.id.clone(), true, false);
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "paused",
            10
        )))
        .is_err()
    );
    standing_time("owner.testnet", 1, NOW + DAY_MS);
    treasury.set_standing_mandate_status(grant.terms.id.clone(), false, false);
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    standing_pay(&mut treasury, &grant, "pending", 10);
    standing_time("owner.testnet", 1, NOW + DAY_MS);
    treasury.set_standing_mandate_status(grant.terms.id.clone(), true, true);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.set_standing_mandate_status(
            grant.terms.id.clone(),
            false,
            false
        )))
        .is_err()
    );
    callback(PromiseResult::Successful(vec![]));
    assert!(treasury.on_transfer_result("pending".into(), "attempt-pending".into()));
    assert_eq!(
        treasury
            .get_standing_mandate(grant.terms.id.clone())
            .unwrap()
            .pending_input,
        U128(0)
    );
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "revoked",
            10
        )))
        .is_err()
    );
}

#[test]
fn standing_recipient_replacement_and_expiry_cannot_reuse_authority() {
    let mut treasury = setup(true);
    let grant = standing_grant(&mut treasury);
    standing_time("owner.testnet", 1, NOW + DAY_MS);
    treasury.set_recipient(
        "recipient".into(),
        grant.destination.clone(),
        None,
        false,
        true,
    );
    standing_time("agent.testnet", 0, NOW + 3 * DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "changed",
            10
        )))
        .is_err()
    );
    let mut terms = grant.terms.clone();
    terms.id = "replacement".into();
    terms.recipient_version = U64(2);
    standing_time("owner.testnet", 1, NOW + 3 * DAY_MS);
    let replacement = treasury.grant_standing_mandate(terms);
    standing_time("agent.testnet", 0, replacement.terms.expires_at_ms.0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &replacement,
            "expired",
            10
        )))
        .is_err()
    );
}

#[test]
fn standing_limits_reject_overflow_cross_chain_and_executor_self_grants() {
    let mut treasury = setup(true);
    let grant = standing_grant(&mut treasury);
    standing_time("agent.testnet", 0, NOW + DAY_MS);
    assert!(
        catch_unwind(AssertUnwindSafe(|| standing_pay(
            &mut treasury,
            &grant,
            "overflow",
            u128::MAX
        )))
        .is_err()
    );
    assert!(treasury.get_payment("overflow".into()).is_none());
    assert_eq!(
        treasury
            .get_standing_mandate(grant.terms.id.clone())
            .unwrap()
            .lifetime_used_input,
        U128(0)
    );
    standing_time("agent.testnet", 1, NOW + DAY_MS);
    let mut self_terms = grant.terms;
    self_terms.id = "self-grant".into();
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.grant_standing_mandate(self_terms)
        ))
        .is_err()
    );
    let mut cross_chain = setup(false);
    assert!(catch_unwind(AssertUnwindSafe(|| standing_grant(&mut cross_chain))).is_err());
}

#[test]
fn company_collection_prefixes_preserve_the_original_borsh_bytes() {
    call("owner.testnet", 0);
    let company_id = "company-prefix-compatibility".to_string();
    let treasury = CompanyTreasury::new(
        company_id.clone(),
        account("owner.testnet"),
        account("usdc.testnet"),
        U128(500),
        U128(1_000),
    );
    macro_rules! check_prefix {
        ($field:ident, $tag:expr, $key:ty, $value:ty) => {{
            let mut expected_prefix = env::sha256(company_id.as_bytes());
            expected_prefix.push($tag);
            let expected = IterableMap::<$key, $value>::new(expected_prefix);
            assert_eq!(
                near_sdk::borsh::to_vec(&treasury.$field).unwrap(),
                near_sdk::borsh::to_vec(&expected).unwrap(),
                stringify!($field),
            );
        }};
    }
    let mut expected_prefix = env::sha256(company_id.as_bytes());
    expected_prefix.push(b'b');
    let mut backup_assets = IterableMap::<String, String>::new(expected_prefix);
    backup_assets.insert("near".into(), "nep141:usdc.testnet".into());
    assert_eq!(
        near_sdk::borsh::to_vec(&treasury.backup_assets).unwrap(),
        near_sdk::borsh::to_vec(&backup_assets).unwrap(),
    );
    check_prefix!(withdrawals, b'w', u64, (U128, bool));
    check_prefix!(retained_assets, b'h', AccountId, RetainedAsset);
    check_prefix!(recipients, b'r', String, Recipient);
    check_prefix!(payments, b'p', String, Payment);
    check_prefix!(obligations, b'o', String, String);
    check_prefix!(spent_by_day, b'd', u64, u128);
    check_prefix!(standing_mandates, b'm', String, StandingMandate);
    check_prefix!(standing_payments, b'n', String, String);
    check_prefix!(recipient_activation, b'c', String, U64);
    check_prefix!(distributions, b'e', String, Distribution);
    check_prefix!(void_distributions, b'g', String, bool);
    check_prefix!(partial_receipts, b't', String, String);
}

#[test]
fn approval_status_hash_reuse_preserves_legacy_payment_and_route_bytes() {
    let mut treasury = setup(false);
    prepare(&mut treasury, "hash-compatible-attempt", false, 102);
    let payment = treasury.get_payment("payment".into()).unwrap();
    let attempt = payment.attempts.last().unwrap();
    let legacy_payment = hash_terms(
        json!({"domain":"razor_payment_approval_v1","treasury":env::current_account_id(),"company_id":treasury.company_id,"payment_id":payment.id,
        "recipient_id":payment.recipient_id,"recipient_version":payment.recipient_version,"amount":payment.amount,"max_fee":payment.max_fee,
        "expires_at_ms":payment.expires_at_ms,"not_before_ms":payment.not_before_ms,"reference":payment.reference,"policy_version":U64(treasury.policy_version),"required_approvals":treasury.required_approvals(&payment)}),
    );
    let legacy_attempt = hash_terms(
        json!({"domain":"razor_route_approval_v1","payment_terms_hash":legacy_payment,"attempt_id":attempt.id,
        "destination":attempt.destination,"route":attempt.route,"use_backup":attempt.use_backup,"policy_version":U64(treasury.policy_version)}),
    );
    let status = treasury.get_approval_status("payment".into(), Some(attempt.id.clone()));
    assert_eq!(status.payment_terms_hash, legacy_payment);
    assert_eq!(
        status.attempt_terms_hash.as_deref(),
        Some(legacy_attempt.as_str())
    );
    assert_eq!(
        treasury.attempt_terms_hash(&payment, attempt),
        legacy_attempt
    );
    assert_eq!(
        treasury
            .get_approval_status("payment".into(), None)
            .attempt_terms_hash,
        Some(legacy_attempt.clone())
    );
    let mut changed_payment = payment.clone();
    changed_payment.amount = U128(payment.amount.0 + 1);
    assert_ne!(
        treasury.payment_terms_hash(&changed_payment),
        legacy_payment
    );
    assert_ne!(
        treasury.attempt_terms_hash(&changed_payment, attempt),
        legacy_attempt
    );
    let mut changed_attempt = attempt.clone();
    changed_attempt.route.quote_hash = "b".repeat(64);
    assert_ne!(
        treasury.attempt_terms_hash(&payment, &changed_attempt),
        legacy_attempt
    );
    treasury.policy_version += 1;
    assert_ne!(treasury.payment_terms_hash(&payment), legacy_payment);
    assert_ne!(
        treasury.attempt_terms_hash(&payment, attempt),
        legacy_attempt
    );
}
