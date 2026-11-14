use super::*;
use ed25519_dalek::{Signer, SigningKey};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_utils::VMContextBuilder, test_vm_config, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};
fn account(value:&str)->AccountId { value.parse().unwrap() }
fn context(caller:&str,deposit:u128)->VMContextBuilder { let mut value=VMContextBuilder::new(); value.current_account_id(account("billing.testnet")).predecessor_account_id(account(caller)).signer_account_id(account(caller)).attached_deposit(NearToken::from_yoctonear(deposit)).account_balance(NearToken::from_near(100)).prepaid_gas(Gas::from_tgas(300)).block_timestamp(1_000_000_000_000).block_height(100); value }
fn call(caller:&str,deposit:u128) { testing_env!(context(caller,deposit).build()); }
fn callback(success:bool) { testing_env!(context("billing.testnet",0).build(),test_vm_config(),RuntimeFeesConfig::test(),Default::default(),vec![if success {PromiseResult::Successful(vec![])} else {PromiseResult::Failed}]); }
fn key()->SigningKey { SigningKey::from_bytes(&[7;32]) }
fn setup()->Billing { call("owner.testnet",0); Billing::new(account("owner.testnet"),account("usdc.testnet"),"testnet".into(),format!("ed25519:{}",near_sdk::bs58::encode(key().verifying_key().as_bytes()).into_string())) }
fn offer()->Offer { Offer{version:1,invoice_id:"invoice-one".into(),company_id:"company-one".into(),plan_version_id:"pro-v1".into(),payer_id:account("payer.testnet"),contract_id:account("billing.testnet"),network:"testnet".into(),token_contract:account("usdc.testnet"),amount:U128(29_000_000),terms_hash:"a".repeat(64),issued_at_ms:U64(1_000_000),expires_at_ms:U64(2_000_000)} }
fn signed(offer:Offer)->String { let quote_json=serde_json::to_string(&offer).unwrap();let signature=near_sdk::bs58::encode(key().sign(quote_json.as_bytes()).to_bytes()).into_string();serde_json::to_string(&serde_json::json!({"quote_json":quote_json,"signature":signature})).unwrap() }
fn returned(value:PromiseOrValue<U128>)->u128 { match value {PromiseOrValue::Value(value)=>value.0,_=>panic!("EXPECTED_VALUE")} }
fn pay(billing:&mut Billing) { call("usdc.testnet",0);assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(29_000_000),signed(offer()))),0); }
#[test]
fn exact_signed_invoice_accepts_once_and_returns_duplicate_and_excess() { let mut billing=setup();call("usdc.testnet",0);assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(30_000_000),signed(offer()))),1_000_000);assert_eq!(billing.available,29_000_000);assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(29_000_000),signed(offer()))),29_000_000);assert_eq!(billing.available,29_000_000);assert_eq!(billing.get_invoice("invoice-one".into()).unwrap().amount.0,29_000_000); }
#[test]
fn invalid_domain_identity_expiry_amount_and_signature_refund_without_recording() { let mut billing=setup();call("usdc.testnet",0);let mut cases=vec![];let mut value=offer();value.network="mainnet".into();cases.push(value);let mut value=offer();value.payer_id=account("other.testnet");cases.push(value);let mut value=offer();value.contract_id=account("other.testnet");cases.push(value);let mut value=offer();value.expires_at_ms=U64(999_999);cases.push(value);let mut value=offer();value.token_contract=account("other.testnet");cases.push(value);let mut value=offer();value.amount=U128(0);cases.push(value);for value in cases {assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(29_000_000),signed(value))),29_000_000);}assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(28_000_000),signed(offer()))),28_000_000);let invalid=signed(offer()).replace("invoice-one","invoice-two");assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(29_000_000),invalid)),29_000_000);assert!(billing.get_invoice("invoice-one".into()).is_none());assert_eq!(billing.available,0); }
#[test]
fn refunds_are_original_payer_bound_and_callbacks_are_idempotent() { let mut billing=setup();pay(&mut billing);call("owner.testnet",1);drop(billing.refund_payment("invoice-one".into(),"refund-one".into(),U128(10_000_000)));assert_eq!(billing.available,19_000_000);assert!(catch_unwind(AssertUnwindSafe(||billing.refund_payment("invoice-one".into(),"refund-two".into(),U128(1)))).is_err());callback(false);assert!(!billing.on_refunded("refund-one".into(),U64(1)));assert_eq!(billing.available,29_000_000);call("owner.testnet",1);drop(billing.refund_payment("invoice-one".into(),"refund-one".into(),U128(10_000_000)));callback(true);assert!(!billing.on_refunded("refund-one".into(),U64(1)));assert!(billing.on_refunded("refund-one".into(),U64(2)));assert!(!billing.on_refunded("refund-one".into(),U64(2)));assert_eq!(billing.get_invoice("invoice-one".into()).unwrap().refunded_amount.0,10_000_000);call("owner.testnet",1);assert!(matches!(billing.refund_payment("invoice-one".into(),"refund-one".into(),U128(10_000_000)),PromiseOrValue::Value(true)));assert!(catch_unwind(AssertUnwindSafe(||billing.refund_payment("invoice-one".into(),"refund-two".into(),U128(20_000_000)))).is_err()); }
#[test]
fn pause_does_not_block_refund_and_only_owner_can_move_revenue() { let mut billing=setup();pay(&mut billing);call("stranger.testnet",1);assert!(catch_unwind(AssertUnwindSafe(||billing.withdraw(U128(1)))).is_err());call("owner.testnet",1);billing.set_paused(true);call("usdc.testnet",0);let mut next=offer();next.invoice_id="invoice-two".into();assert_eq!(returned(billing.ft_on_transfer(account("payer.testnet"),U128(29_000_000),signed(next))),29_000_000);call("owner.testnet",1);drop(billing.refund_payment("invoice-one".into(),"refund-one".into(),U128(29_000_000)));callback(true);assert!(billing.on_refunded("refund-one".into(),U64(1)));assert_eq!(billing.available,0); }
#[test]
fn withdrawal_failure_restores_available_once_and_never_unlocks_by_time() { let mut billing=setup();pay(&mut billing);call("owner.testnet",1);drop(billing.withdraw(U128(29_000_000)));assert_eq!(billing.available,0);assert!(catch_unwind(AssertUnwindSafe(||billing.withdraw(U128(1)))).is_err());callback(false);assert!(!billing.on_withdrawn(U64(9)));assert!(!billing.on_withdrawn(U64(1)));assert_eq!(billing.available,29_000_000);assert!(!billing.on_withdrawn(U64(1))); }
#[test]
fn wrong_token_and_unrecoverable_mainnet_configuration_are_rejected() { let mut billing=setup();call("fake.testnet",0);assert!(catch_unwind(AssertUnwindSafe(||billing.ft_on_transfer(account("payer.testnet"),U128(29_000_000),signed(offer())))).is_err());call("owner.testnet",0);assert!(catch_unwind(AssertUnwindSafe(||Billing::new(account("owner.testnet"),account("fake.near"),"mainnet".into(),billing.issuer_public_key.clone()))).is_err()); }

#[test]
fn typed_views_events_and_hex_preserve_exact_json_and_hash_bytes() {
    let mut billing = setup();
    billing.available = u128::MAX;
    billing.paused = true;
    billing.withdrawal = Some((1, 1));
    let expected = serde_json::json!({"owner_id":billing.owner_id,"token_contract":billing.token_contract,"network":billing.network,"issuer_public_key":billing.issuer_public_key,"paused":billing.paused,"available":U128(billing.available),"withdrawal_pending":billing.withdrawal.is_some(),"version":1});
    assert_eq!(serde_json::to_vec(&billing.get_config()).unwrap(), serde_json::to_vec(&expected).unwrap());
    let invoice_id = "invoice-\"\\\n";
    let event = InvoicePaidEvent {
        standard: "razor-billing",
        version: "1.0.0",
        event: "invoice_paid",
        data: [InvoicePaidData { invoice_id, amount: U128(u128::MAX) }],
    };
    let expected = serde_json::json!({"standard":"razor-billing","version":"1.0.0","event":"invoice_paid","data":[{"invoice_id":invoice_id,"amount":U128(u128::MAX)}]});
    assert_eq!(serde_json::to_vec(&event).unwrap(), serde_json::to_vec(&expected).unwrap());
    let bytes: Vec<u8> = (0..=255).collect();
    assert_eq!(hex(&bytes), bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
    assert_eq!(hex(&[]), "");
}


fn oversized_callback() {
    testing_env!(
        context("billing.testnet", 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![PromiseResult::Successful(vec![b'x'; 262_144])]
    );
}

#[test]
fn oversized_successful_refund_never_restores_cash_or_refunds_twice() {
    let mut billing = setup();
    pay(&mut billing);
    call("owner.testnet", 1);
    drop(billing.refund_payment("invoice-one".into(), "refund-large".into(), U128(10_000_000)));
    assert_eq!(billing.available, 19_000_000);
    oversized_callback();
    assert!(!billing.on_refunded("refund-large".into(), U64(9)));
    assert_eq!(billing.get_invoice("invoice-one".into()).unwrap().pending_refund.as_deref(), Some("refund-large"));
    assert!(billing.on_refunded("refund-large".into(), U64(1)));
    assert_eq!(billing.available, 19_000_000);
    let invoice = billing.get_invoice("invoice-one".into()).unwrap();
    assert_eq!(invoice.refunded_amount, U128(10_000_000));
    assert!(invoice.pending_refund.is_none());
    assert_eq!(billing.get_refund("refund-large".into()).unwrap().status, "completed");
    assert!(!billing.on_refunded("refund-large".into(), U64(1)));
    callback(false);
    assert!(!billing.on_refunded("refund-large".into(), U64(1)));
    assert_eq!(billing.available, 19_000_000);
    call("owner.testnet", 1);
    assert!(matches!(billing.refund_payment("invoice-one".into(), "refund-large".into(), U128(10_000_000)), PromiseOrValue::Value(true)));
    assert_eq!(billing.available, 19_000_000);
    assert!(catch_unwind(AssertUnwindSafe(|| billing.refund_payment("invoice-one".into(), "refund-over".into(), U128(19_000_001)))).is_err());
}

#[test]
fn failed_refund_retries_exact_amount_and_oversized_success_closes_only_the_new_nonce() {
    let mut billing = setup();
    pay(&mut billing);
    call("owner.testnet", 1);
    drop(billing.refund_payment("invoice-one".into(), "refund-retry".into(), U128(7_000_000)));
    callback(false);
    assert!(!billing.on_refunded("refund-retry".into(), U64(1)));
    assert_eq!(billing.available, 29_000_000);
    assert!(!billing.on_refunded("refund-retry".into(), U64(1)));
    assert_eq!(billing.available, 29_000_000);
    call("owner.testnet", 1);
    drop(billing.refund_payment("invoice-one".into(), "refund-retry".into(), U128(7_000_000)));
    assert_eq!(billing.available, 22_000_000);
    oversized_callback();
    assert!(!billing.on_refunded("refund-retry".into(), U64(1)));
    assert_eq!(billing.get_invoice("invoice-one".into()).unwrap().pending_refund.as_deref(), Some("refund-retry"));
    assert!(billing.on_refunded("refund-retry".into(), U64(2)));
    assert!(!billing.on_refunded("refund-retry".into(), U64(2)));
    assert_eq!(billing.available, 22_000_000);
    assert_eq!(billing.get_invoice("invoice-one".into()).unwrap().refunded_amount, U128(7_000_000));
}

#[test]
fn revenue_withdrawal_failure_restores_once_and_oversized_success_does_not_restore() {
    let mut billing = setup();
    pay(&mut billing);
    call("owner.testnet", 1);
    drop(billing.withdraw(U128(10_000_000)));
    callback(false);
    assert!(!billing.on_withdrawn(U64(1)));
    assert_eq!(billing.available, 29_000_000);
    assert!(!billing.on_withdrawn(U64(1)));
    assert_eq!(billing.available, 29_000_000);
    call("owner.testnet", 1);
    drop(billing.withdraw(U128(10_000_000)));
    assert_eq!(billing.available, 19_000_000);
    oversized_callback();
    assert!(!billing.on_withdrawn(U64(1)));
    assert_eq!(billing.withdrawal, Some((2, 10_000_000)));
    assert!(billing.on_withdrawn(U64(2)));
    assert!(billing.withdrawal.is_none());
    assert_eq!(billing.available, 19_000_000);
    assert!(!billing.on_withdrawn(U64(2)));
    callback(false);
    assert!(!billing.on_withdrawn(U64(2)));
    assert_eq!(billing.available, 19_000_000);
}

#[test]
fn native_reserve_rejects_unauthorized_zero_and_storage_backed_amounts() {
    let mut billing = setup();
    call("stranger.testnet", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| billing.withdraw_native_reserve(U128(1)))).is_err());
    for deposit in [0, 2] {
        call("owner.testnet", deposit);
        assert!(catch_unwind(AssertUnwindSafe(|| billing.withdraw_native_reserve(U128(1)))).is_err());
    }
    call("owner.testnet", 1);
    assert!(catch_unwind(AssertUnwindSafe(|| billing.withdraw_native_reserve(U128(0)))).is_err());
    let excess = billing.get_native_reserve().withdrawable.0;
    assert!(excess > 1);
    assert!(catch_unwind(AssertUnwindSafe(|| billing.withdraw_native_reserve(U128(excess)))).is_err());
    assert!(catch_unwind(AssertUnwindSafe(|| billing.withdraw_native_reserve(U128(u128::MAX)))).is_err());
    assert!(near_sdk::test_utils::get_created_receipts().is_empty());
}

#[test]
fn native_reserve_withdrawal_is_owner_bound_and_preserves_pending_usdc_while_paused() {
    let mut billing = setup();
    pay(&mut billing);
    call("owner.testnet", 1);
    drop(billing.withdraw(U128(10_000_000)));
    billing.set_paused(true);
    let previous = (billing.available, billing.withdrawal, billing.nonce);
    call("owner.testnet", 1);
    let amount = NearToken::from_near(1).as_yoctonear();
    drop(billing.withdraw_native_reserve(U128(amount)));
    assert_eq!((billing.available, billing.withdrawal, billing.nonce), previous);
    assert!(billing.paused);
    assert_eq!(billing.get_invoice("invoice-one".into()).unwrap().amount, U128(29_000_000));
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].receiver_id, account("owner.testnet"));
    assert!(matches!(receipts[0].actions.as_slice(), [near_sdk::mock::MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == amount));
}

#[test]
fn native_reserve_quote_and_exact_boundary_preserve_current_storage() {
    let mut billing = setup();
    let storage_bytes = 400;
    let storage_cost = env::storage_byte_cost().as_yoctonear() * storage_bytes as u128;
    let mut builder = context("owner.testnet", 1);
    builder.storage_usage(storage_bytes).account_balance(NearToken::from_yoctonear(storage_cost + 5));
    testing_env!(builder.build());
    let quote = billing.get_native_reserve();
    assert_eq!(quote.balance, U128(storage_cost + 5));
    assert_eq!(quote.storage_locked, U128(storage_cost));
    assert_eq!(quote.customer_storage_reserved, U128(0));
    assert_eq!(quote.withdrawable, U128(5));
    drop(billing.withdraw_native_reserve(U128(4)));
    let receipts = near_sdk::test_utils::get_created_receipts();
    assert!(matches!(receipts[0].actions.as_slice(), [near_sdk::mock::MockAction::Transfer { deposit, .. }] if deposit.as_yoctonear() == 4));
    let mut builder = context("owner.testnet", 1);
    builder.storage_usage(storage_bytes).account_balance(NearToken::from_yoctonear(storage_cost - 1));
    testing_env!(builder.build());
    assert_eq!(billing.get_native_reserve().withdrawable, U128(0));
    assert!(catch_unwind(AssertUnwindSafe(|| billing.withdraw_native_reserve(U128(1)))).is_err());
}
