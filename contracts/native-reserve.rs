use near_sdk::{AccountId, NearToken, Promise, env, json_types::U128, near, require, serde_json::json};

#[near(serializers = [json])]
pub struct NativeReserveView {
    pub balance: U128,
    pub storage_locked: U128,
    pub customer_storage_reserved: U128,
    pub withdrawable: U128,
}

pub fn reserve_view(protected_customer_storage: u128) -> NativeReserveView {
    let balance = env::account_balance().as_yoctonear();
    let storage_locked = u128::from(env::storage_usage())
        .checked_mul(env::storage_byte_cost().as_yoctonear())
        .expect("STORAGE_OVERFLOW");
    NativeReserveView {
        balance: U128(balance),
        storage_locked: U128(storage_locked),
        customer_storage_reserved: U128(protected_customer_storage),
        withdrawable: U128(balance.saturating_sub(storage_locked).saturating_sub(protected_customer_storage)),
    }
}

pub fn withdraw(owner: &AccountId, amount: U128, protected_customer_storage: u128) -> Promise {
    near_sdk::assert_one_yocto();
    require!(&env::predecessor_account_id() == owner, "ONLY_OWNER");
    let available = reserve_view(protected_customer_storage).withdrawable.0.saturating_sub(1);
    require!(amount.0 > 0 && amount.0 <= available, "INSUFFICIENT_NATIVE_RESERVE");
    env::log_str(&format!("EVENT_JSON:{}", json!({
        "standard": "razor-native-reserve", "version": "1.0.0", "event": "withdrawal_requested",
        "data": [{"receiver_id": owner, "amount": amount}]
    })));
    Promise::new(owner.clone()).transfer(NearToken::from_yoctonear(amount.0))
}
