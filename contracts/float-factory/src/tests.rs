use super::*;
use near_sdk::{
    PromiseResult, RuntimeFeesConfig,
    mock::MockAction,
    test_utils::{VMContextBuilder, get_created_receipts},
    test_vm_config, testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}
fn context(caller: &str, deposit: u128) -> VMContextBuilder {
    let mut builder = VMContextBuilder::new();
    builder
        .current_account_id(account("factory.testnet"))
        .signer_account_id(account(caller))
        .predecessor_account_id(account(caller))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_near(100))
        .prepaid_gas(Gas::from_tgas(300));
    builder
}
fn call(caller: &str, deposit: u128) {
    testing_env!(context(caller, deposit).build());
}
fn callback(result: PromiseResult) {
    testing_env!(
        context("factory.testnet", 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn setup() -> Factory {
    call("platform.testnet", 0);
    Factory::new(account("platform.testnet"), account("usdc.testnet"))
}
fn create(factory: &mut Factory) -> Creation {
    let quote = factory.quote_creation(account("company.testnet"), "company".into());
    call("company.testnet", quote.minimum_deposit.0);
    drop(factory.create_treasury("company".into(), U128(100), U128(1_000)));
    factory
        .get_treasury(account("company.testnet"), "company".into())
        .unwrap()
}

#[test]
fn creation_binds_owner_token_code_and_prevents_duplicate_deployment() {
    let mut factory = setup();
    let creation = create(&mut factory);
    assert_eq!(creation.owner_id, account("company.testnet"));
    assert_eq!(creation.status, CreationStatus::Pending);
    let receipts = get_created_receipts();
    let deployment = receipts
        .iter()
        .find(|receipt| receipt.receiver_id == creation.account_id)
        .unwrap();
    assert!(matches!(
        &deployment.actions[0],
        MockAction::CreateAccount { .. }
    ));
    assert!(
        matches!(&deployment.actions[1], MockAction::Transfer { deposit, .. } if deposit.as_yoctonear() == creation.treasury_funding.0)
    );
    assert!(
        matches!(&deployment.actions[2], MockAction::DeployContract { code, .. } if code == TREASURY_WASM)
    );
    if let MockAction::FunctionCallWeight {
        method_name, args, ..
    } = &deployment.actions[3]
    {
        assert_eq!(method_name, b"new");
        let args: serde_json::Value = serde_json::from_slice(args).unwrap();
        assert_eq!(args["owner_id"], "company.testnet");
        assert_eq!(args["token_contract"], "usdc.testnet");
        assert_eq!(args["per_payment_limit"], "100");
    } else {
        panic!("INITIALIZATION_NOT_SCHEDULED");
    }
    assert!(
        catch_unwind(AssertUnwindSafe(|| factory.create_treasury(
            "company".into(),
            U128(100),
            U128(1_000)
        )))
        .is_err()
    );
    callback(PromiseResult::Successful(vec![]));
    assert!(factory.on_created(creation.account_id.clone(), creation.generation));
    assert!(!factory.on_created(creation.account_id.clone(), creation.generation));
    assert_eq!(
        factory.get_creation(creation.account_id).unwrap().status,
        CreationStatus::Ready
    );
}

#[test]
fn failed_creation_refund_is_owned_idempotent_and_retryable() {
    let mut factory = setup();
    let creation = create(&mut factory);
    callback(PromiseResult::Failed);
    assert!(!factory.on_created(creation.account_id.clone(), creation.generation));
    assert!(!factory.on_created(creation.account_id.clone(), creation.generation));
    assert_eq!(
        factory
            .get_creation(creation.account_id.clone())
            .unwrap()
            .refund_amount,
        creation.treasury_funding
    );
    call("attacker.testnet", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| factory.claim_refund("company".into()))).is_err());
    call("company.testnet", 1);
    drop(factory.claim_refund("company".into()));
    assert!(catch_unwind(AssertUnwindSafe(|| factory.claim_refund("company".into()))).is_err());
    callback(PromiseResult::Failed);
    assert!(!factory.on_refunded(creation.account_id.clone(), creation.generation));
    call("company.testnet", 1);
    drop(factory.claim_refund("company".into()));
    callback(PromiseResult::Successful(vec![]));
    assert!(factory.on_refunded(creation.account_id.clone(), creation.generation));
    assert!(!factory.on_refunded(creation.account_id.clone(), creation.generation));
    let retried = create(&mut factory);
    assert_ne!(retried.generation, creation.generation);
    callback(PromiseResult::Successful(vec![]));
    assert!(!factory.on_created(creation.account_id.clone(), creation.generation));
    assert_eq!(
        factory.get_creation(creation.account_id).unwrap().status,
        CreationStatus::Pending
    );
}

#[test]
fn recovery_requires_positive_matching_initialized_treasury() {
    let mut factory = setup();
    let creation = create(&mut factory);
    callback(PromiseResult::Failed);
    assert!(!factory.on_creation_refreshed(creation.account_id.clone(), creation.generation));
    let wrong = json!({"owner_id":"attacker.testnet","token_contract":"usdc.testnet","per_payment_limit":"100","daily_limit":"1000"});
    callback(PromiseResult::Successful(
        serde_json::to_vec(&wrong).unwrap(),
    ));
    assert!(!factory.on_creation_refreshed(creation.account_id.clone(), creation.generation));
    assert_eq!(
        factory
            .get_creation(creation.account_id.clone())
            .unwrap()
            .refund_amount,
        U128(0)
    );
    let correct = json!({"owner_id":"company.testnet","token_contract":"usdc.testnet","per_payment_limit":"100","daily_limit":"1000"});
    callback(PromiseResult::Successful(
        serde_json::to_vec(&correct).unwrap(),
    ));
    assert!(factory.on_creation_refreshed(creation.account_id.clone(), creation.generation));
    assert_eq!(
        factory.get_creation(creation.account_id).unwrap().status,
        CreationStatus::Ready
    );
}

#[test]
fn deposit_limits_and_pause_are_checked_before_creating_records() {
    let mut factory = setup();
    call("company.testnet", 1);
    assert!(
        catch_unwind(AssertUnwindSafe(|| factory.create_treasury(
            "company".into(),
            U128(100),
            U128(1_000)
        )))
        .is_err()
    );
    assert!(
        factory
            .get_treasury(account("company.testnet"), "company".into())
            .is_none()
    );
    call("platform.testnet", 1);
    factory.set_paused(true);
    let quote = factory.quote_creation(account("company.testnet"), "company".into());
    call("company.testnet", quote.minimum_deposit.0);
    assert!(
        catch_unwind(AssertUnwindSafe(|| factory.create_treasury(
            "company".into(),
            U128(100),
            U128(1_000)
        )))
        .is_err()
    );
    assert!(
        factory
            .get_treasury(account("company.testnet"), "company".into())
            .is_none()
    );
}
