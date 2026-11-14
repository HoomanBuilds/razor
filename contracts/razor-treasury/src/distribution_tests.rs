use super::*;
use near_sdk::{
    PromiseResult, RuntimeFeesConfig, test_utils::VMContextBuilder, test_vm_config, testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

const NOW: u64 = 1_800_000_000_000;
const DAY: u64 = 86_400_000;
fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}
fn context(caller: &str, deposit: u128, at: u64) -> VMContextBuilder {
    let mut value = VMContextBuilder::new();
    value
        .current_account_id(account("treasury.testnet"))
        .signer_account_id(account(caller))
        .predecessor_account_id(account(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .block_timestamp(at * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    value
}
fn call(caller: &str, deposit: u128, at: u64) {
    testing_env!(context(caller, deposit, at).build());
}
fn callback(result: PromiseResult, at: u64) {
    testing_env!(
        context("treasury.testnet", 0, at).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn setup() -> (Treasury, String) {
    call("platform.testnet", 0, NOW);
    let mut treasury = Treasury::new(account("platform.testnet"), account("usdc.testnet"));
    let suffix: String = env::sha256(b"alice.testnet")
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let company = format!("11111111-1111-4111-8111-111111111111:{suffix}");
    call("alice.testnet", NearToken::from_near(1).as_yoctonear(), NOW);
    treasury.register_company(company.clone(), U128(500), U128(1_000));
    call("usdc.testnet", 0, NOW);
    treasury.ft_on_transfer(
        account("alice.testnet"),
        U128(1_000),
        json!({"company_id":company,"deposit_id":"distribution-cash","kind":"funding"}).to_string(),
    );
    call("alice.testnet", 1, NOW);
    treasury.set_recipient(
        company.clone(),
        "vendor".into(),
        Destination {
            asset_id: "nep141:usdc.testnet".into(),
            network: "near".into(),
            address: "vendor.testnet".into(),
        },
        None,
        false,
        true,
    );
    (treasury, company)
}
fn allocations(amount: u128) -> Vec<DistributionAllocation> {
    vec![DistributionAllocation {
        claim_id: "claim-one".into(),
        recipient_id: "vendor".into(),
        recipient_version: U64(1),
        amount: U128(amount),
    }]
}
fn create(treasury: &mut Treasury, company: &String, id: &str, amount: u128) -> Distribution {
    call("alice.testnet", 1, NOW);
    let version = treasury.get_config(company.clone()).policy_version;
    treasury.create_distribution(
        company.clone(),
        id.into(),
        id.into(),
        "testnet".into(),
        allocations(amount),
        U128(amount),
        U64(NOW + DAY),
        version,
    )
}

#[test]
fn distribution_funding_is_exact_native_bound_and_does_not_create_spendable_cash() {
    let (mut treasury, company) = setup();
    call("mallory.testnet", 1, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.create_distribution(
            company.clone(),
            "bad".into(),
            "bad".into(),
            "testnet".into(),
            allocations(200),
            U128(200),
            U64(NOW + DAY),
            U64(1)
        )))
        .is_err()
    );
    call("alice.testnet", 1, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.create_distribution(
            company.clone(),
            "wrong-total".into(),
            "wrong-total".into(),
            "testnet".into(),
            allocations(200),
            U128(201),
            U64(NOW + DAY),
            U64(1)
        )))
        .is_err()
    );
    let value = create(&mut treasury, &company, "pool", 200);
    assert_eq!(value.status, DistributionStatus::Active);
    assert_eq!(value.unclaimed, U128(200));
    let balance = treasury.get_balance(company.clone());
    assert_eq!(balance.balance, U128(1_000));
    assert_eq!(balance.reserved, U128(200));
    assert_eq!(balance.available, U128(800));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(1_000)
    );
    call("alice.testnet", 1, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.withdraw_available(
            company.clone(),
            account("alice.testnet"),
            U128(801)
        )))
        .is_err()
    );
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.create_distribution(
            company.clone(),
            "duplicate".into(),
            "duplicate".into(),
            "testnet".into(),
            vec![allocations(100)[0].clone(), allocations(100)[0].clone()],
            U128(200),
            U64(NOW + DAY),
            U64(1)
        )))
        .is_err()
    );
}

#[test]
fn distribution_highest_quorum_and_policy_version_gate_funding() {
    let (mut treasury, company) = setup();
    call("alice.testnet", 1, NOW);
    treasury.set_role(
        company.clone(),
        account("finance.testnet"),
        "approver".into(),
        true,
    );
    treasury.set_approval_policy(
        company.clone(),
        vec![
            ApprovalTier {
                up_to: U128(500),
                required_approvals: 1,
            },
            ApprovalTier {
                up_to: U128(1_000),
                required_approvals: 2,
            },
        ],
        U64(2),
    );
    let value = create(&mut treasury, &company, "quorum", 200);
    assert_eq!(value.required_approvals, 2);
    assert_eq!(value.status, DistributionStatus::Proposed);
    assert_eq!(treasury.get_balance(company.clone()).reserved, U128(0));
    call("mallory.testnet", 1, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.approve_distribution(
            company.clone(),
            value.id.clone(),
            value.terms_hash.clone()
        )))
        .is_err()
    );
    call("finance.testnet", 1, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.approve_distribution(
            company.clone(),
            value.id.clone(),
            "0".repeat(64)
        )))
        .is_err()
    );
    let active = treasury.approve_distribution(company.clone(), value.id.clone(), value.terms_hash);
    assert_eq!(active.status, DistributionStatus::Active);
    assert_eq!(treasury.get_balance(company.clone()).reserved, U128(200));
    call("alice.testnet", 1, NOW);
    treasury.set_policy(company.clone(), U128(500), U128(1_100));
    call("relayer.testnet", 0, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.claim_distribution(
            company,
            active.id,
            "claim-one".into()
        )))
        .is_err()
    );
}

#[test]
fn distribution_claim_callbacks_and_deadline_reclaim_conserve_pending_liabilities() {
    let (mut treasury, company) = setup();
    let value = create(&mut treasury, &company, "claims", 200);
    call("relayer.testnet", 0, NOW);
    treasury.claim_distribution(company.clone(), value.id.clone(), "claim-one".into());
    let balance = treasury.get_balance(company.clone());
    assert_eq!(balance.balance, U128(800));
    assert_eq!(balance.in_flight, U128(200));
    assert_eq!(balance.reserved, U128(0));
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.claim_distribution(
            company.clone(),
            value.id.clone(),
            "claim-one".into()
        )))
        .is_err()
    );
    call("alice.testnet", 1, NOW + DAY);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.reclaim_distribution(
            company.clone(),
            value.id.clone(),
            value.terms_hash.clone()
        )))
        .is_err()
    );
    callback(PromiseResult::Failed, NOW + DAY);
    assert!(!treasury.on_distribution_claim_result(
        company.clone(),
        value.id.clone(),
        "claim-one".into(),
        U64(1)
    ));
    assert_eq!(treasury.get_balance(company.clone()).reserved, U128(200));
    assert!(!treasury.on_distribution_claim_result(
        company.clone(),
        value.id.clone(),
        "claim-one".into(),
        U64(1)
    ));
    call("alice.testnet", 1, NOW + DAY);
    let closed = treasury.reclaim_distribution(company.clone(), value.id, value.terms_hash);
    assert_eq!(closed.reclaimed, U128(200));
    assert_eq!(closed.pending, U128(0));
    let balance = treasury.get_balance(company);
    assert_eq!(balance.balance, U128(1_000));
    assert_eq!(balance.available, U128(1_000));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(1_000)
    );
}

#[test]
fn distribution_paid_entitlement_never_reopens_and_profile_changes_hold_new_claims() {
    let (mut treasury, company) = setup();
    let value = create(&mut treasury, &company, "paid", 200);
    call("relayer.testnet", 0, NOW);
    treasury.claim_distribution(company.clone(), value.id.clone(), "claim-one".into());
    callback(PromiseResult::Successful(vec![]), NOW);
    assert!(treasury.on_distribution_claim_result(
        company.clone(),
        value.id.clone(),
        "claim-one".into(),
        U64(1)
    ));
    assert!(!treasury.on_distribution_claim_result(
        company.clone(),
        value.id.clone(),
        "claim-one".into(),
        U64(1)
    ));
    assert_eq!(
        treasury.get_pool_liability(account("usdc.testnet")),
        U128(800)
    );
    call("relayer.testnet", 0, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.claim_distribution(
            company.clone(),
            value.id,
            "claim-one".into()
        )))
        .is_err()
    );
    let held = create(&mut treasury, &company, "held", 200);
    call("alice.testnet", 1, NOW);
    treasury.set_recipient(
        company.clone(),
        "vendor".into(),
        Destination {
            asset_id: "nep141:usdc.testnet".into(),
            network: "near".into(),
            address: "changed.testnet".into(),
        },
        None,
        false,
        true,
    );
    call("relayer.testnet", 0, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.claim_distribution(
            company.clone(),
            held.id,
            "claim-one".into()
        )))
        .is_err()
    );
}

#[test]
fn voided_creation_cannot_arrive_late_or_cancel_a_funded_commitment() {
    let (mut treasury, company) = setup();
    call("alice.testnet", 1, NOW);
    assert!(treasury.void_distribution(company.clone(), "uncertain".into()));
    assert!(treasury.distribution_voided(company.clone(), "uncertain".into()));
    assert!(
        catch_unwind(AssertUnwindSafe(|| create(
            &mut treasury,
            &company,
            "uncertain",
            200
        )))
        .is_err()
    );
    let funded = create(&mut treasury, &company, "funded", 200);
    call("alice.testnet", 1, NOW);
    assert!(
        catch_unwind(AssertUnwindSafe(
            || treasury.void_distribution(company.clone(), funded.id)
        ))
        .is_err()
    );
    assert_eq!(treasury.get_balance(company).reserved, U128(200));
}

#[test]
fn failed_pending_claim_after_partial_reclaim_is_reclaimable_once() {
    let (mut treasury, company) = setup();
    call("alice.testnet", 1, NOW);
    treasury.set_recipient(
        company.clone(),
        "second".into(),
        Destination {
            asset_id: "nep141:usdc.testnet".into(),
            network: "near".into(),
            address: "second.testnet".into(),
        },
        None,
        false,
        true,
    );
    let mut entries = allocations(200);
    entries.push(DistributionAllocation {
        claim_id: "claim-two".into(),
        recipient_id: "second".into(),
        recipient_version: U64(1),
        amount: U128(200),
    });
    let value = treasury.create_distribution(
        company.clone(),
        "partial-reclaim".into(),
        "partial-reclaim".into(),
        "testnet".into(),
        entries,
        U128(400),
        U64(NOW + DAY),
        U64(1),
    );
    call("relayer.testnet", 0, NOW);
    treasury.claim_distribution(company.clone(), value.id.clone(), "claim-one".into());
    call("alice.testnet", 1, NOW + DAY);
    let partial =
        treasury.reclaim_distribution(company.clone(), value.id.clone(), value.terms_hash.clone());
    assert_eq!(partial.status, DistributionStatus::Closed);
    assert_eq!(partial.reclaimed, U128(200));
    assert_eq!(partial.pending, U128(200));
    callback(PromiseResult::Failed, NOW + DAY);
    assert!(!treasury.on_distribution_claim_result(
        company.clone(),
        value.id.clone(),
        "claim-one".into(),
        U64(1)
    ));
    call("alice.testnet", 1, NOW + DAY);
    let final_state =
        treasury.reclaim_distribution(company.clone(), value.id.clone(), value.terms_hash.clone());
    assert_eq!(final_state.reclaimed, U128(400));
    assert_eq!(final_state.pending, U128(0));
    assert_eq!(treasury.get_balance(company.clone()).available, U128(1_000));
    assert!(
        catch_unwind(AssertUnwindSafe(|| treasury.reclaim_distribution(
            company,
            value.id,
            value.terms_hash
        )))
        .is_err()
    );
}
