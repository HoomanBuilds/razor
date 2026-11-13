use super::*;

pub const MAX_RETAINED_ASSETS: u32 = 16;
pub const RETAIN_MESSAGE: &str = "razor:retain";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RetainedWithdrawalStatus {
    Pending,
    Succeeded,
    Failed,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RetainedWithdrawal {
    pub id: U64,
    pub receiver_id: AccountId,
    pub amount: U128,
    pub status: RetainedWithdrawalStatus,
    pub receipt: Option<String>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RetainedAsset {
    pub token_contract: AccountId,
    pub asset_id: String,
    pub symbol: String,
    pub decimals: u8,
    pub enabled: bool,
    pub balance: U128,
    pub in_flight: U128,
    pub balance_epoch: U64,
    pub confirmed_at_ms: U64,
    pub withdrawal: Option<RetainedWithdrawal>,
}

impl CompanyTreasury {
    pub fn get_retained_assets(&self) -> Vec<RetainedAsset> {
        self.retained_assets.values().cloned().collect()
    }

    pub fn get_retained_asset(&self, token_contract: AccountId) -> Option<RetainedAsset> {
        self.retained_assets.get(&token_contract).cloned()
    }

    pub fn set_retained_asset(
        &mut self,
        token_contract: AccountId,
        asset_id: String,
        symbol: String,
        decimals: u8,
        enabled: bool,
    ) -> RetainedAsset {
        self.assert_owner();
        require!(
            token_contract != self.token_contract,
            "USDC_IS_PAYMENT_CASH"
        );
        require!(
            token_contract != env::current_account_id(),
            "INVALID_TOKEN_CONTRACT"
        );
        require!(
            asset_id == format!("nep141:{token_contract}"),
            "RETAINED_TOKEN_IDENTITY_MISMATCH"
        );
        require!(
            !symbol.is_empty()
                && symbol.len() <= 32
                && !symbol.chars().any(char::is_control)
                && decimals <= 38,
            "INVALID_TOKEN_METADATA"
        );
        if enabled {
            require!(!self.paused, "PAUSED");
        }
        let asset = if let Some(existing) = self.retained_assets.get(&token_contract) {
            require!(
                existing.asset_id == asset_id
                    && existing.symbol == symbol
                    && existing.decimals == decimals,
                "RETAINED_TOKEN_IDENTITY_IMMUTABLE"
            );
            let mut asset = existing.clone();
            asset.enabled = enabled;
            asset
        } else {
            require!(enabled, "RETAINED_ASSET_NOT_FOUND");
            require!(
                self.retained_assets.len() < MAX_RETAINED_ASSETS,
                "RETAINED_ASSET_LIMIT"
            );
            RetainedAsset {
                token_contract: token_contract.clone(),
                asset_id,
                symbol,
                decimals,
                enabled,
                balance: U128(0),
                in_flight: U128(0),
                balance_epoch: U64(0),
                confirmed_at_ms: U64(0),
                withdrawal: None,
            }
        };
        self.retained_assets
            .insert(token_contract.clone(), asset.clone());
        self.emit(
            "retained_asset_policy_changed",
            json!({"token_contract":token_contract,"asset_id":asset.asset_id,"symbol":asset.symbol,"decimals":asset.decimals,"enabled":enabled}),
        );
        asset
    }

    pub fn refresh_retained_balance(&mut self, token_contract: AccountId) -> Promise {
        let mut asset = self.load_retained(&token_contract);
        require!(asset.in_flight.0 == 0, "RETAINED_WITHDRAWAL_PENDING");
        asset.balance_epoch = U64(asset
            .balance_epoch
            .0
            .checked_add(1)
            .expect("VERSION_OVERFLOW"));
        let epoch = asset.balance_epoch;
        self.retained_assets.insert(token_contract.clone(), asset);
        self.retained_balance_probe(token_contract, epoch)
    }

    pub fn on_retained_balance_sync(&mut self, token_contract: AccountId, epoch: U64) -> bool {
        let mut asset = self.load_retained(&token_contract);
        if asset.balance_epoch != epoch || asset.in_flight.0 != 0 {
            return false;
        }
        let Some(actual) = read_balance() else {
            return false;
        };
        if actual < add(asset.balance.0, asset.in_flight.0) {
            return false;
        }
        asset.confirmed_at_ms = U64(now_ms());
        asset.balance_epoch = U64(asset
            .balance_epoch
            .0
            .checked_add(1)
            .expect("VERSION_OVERFLOW"));
        self.retained_assets.insert(token_contract.clone(), asset);
        self.emit(
            "retained_balance_observed",
            json!({"token_contract":token_contract,"amount":U128(actual)}),
        );
        true
    }

    pub fn on_retained_deposit_sync(&mut self, token_contract: AccountId, epoch: U64) -> U128 {
        self.on_retained_balance_sync(token_contract, epoch);
        U128(0)
    }

    pub fn withdraw_retained_asset(
        &mut self,
        token_contract: AccountId,
        receiver_id: AccountId,
        amount: U128,
        expected_epoch: U64,
    ) -> Promise {
        self.assert_owner();
        require!(!self.paused, "PAUSED");
        require!(env::prepaid_gas() >= Gas::from_tgas(50), "INSUFFICIENT_GAS");
        require!(receiver_id != env::current_account_id(), "INVALID_RECEIVER");
        let mut asset = self.load_retained(&token_contract);
        require!(
            asset.balance_epoch == expected_epoch,
            "RETAINED_BALANCE_CHANGED"
        );
        require!(asset.in_flight.0 == 0, "RETAINED_WITHDRAWAL_PENDING");
        require!(
            asset.confirmed_at_ms.0 != 0 && amount.0 > 0 && amount.0 <= asset.balance.0,
            "INSUFFICIENT_RETAINED_BALANCE"
        );
        self.next_retained_withdrawal = self
            .next_retained_withdrawal
            .checked_add(1)
            .expect("VERSION_OVERFLOW");
        let withdrawal_id = U64(self.next_retained_withdrawal);
        asset.balance.0 -= amount.0;
        asset.in_flight = amount;
        asset.balance_epoch = U64(asset
            .balance_epoch
            .0
            .checked_add(1)
            .expect("VERSION_OVERFLOW"));
        asset.withdrawal = Some(RetainedWithdrawal {
            id: withdrawal_id,
            receiver_id: receiver_id.clone(),
            amount,
            status: RetainedWithdrawalStatus::Pending,
            receipt: None,
        });
        self.retained_assets.insert(token_contract.clone(), asset);
        self.emit(
            "retained_withdrawal_started",
            json!({"token_contract":token_contract,"withdrawal_id":withdrawal_id,"receiver_id":receiver_id,"amount":amount}),
        );
        ext_ft::ext(token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(
                receiver_id,
                amount,
                Some(format!("Razor retained withdrawal {}", withdrawal_id.0)),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_retained_withdraw_result(
                        self.company_id.clone(),
                        token_contract,
                        withdrawal_id,
                    ),
            )
    }

    pub fn on_retained_withdraw_result(
        &mut self,
        token_contract: AccountId,
        withdrawal_id: U64,
    ) -> bool {
        let success = match env::promise_result_checked(0, 64) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        self.finish_retained_withdrawal(token_contract, withdrawal_id, success, None)
    }

    pub fn recover_retained_withdrawal(
        &mut self,
        token_contract: AccountId,
        withdrawal_id: U64,
        succeeded: bool,
        receipt: String,
    ) -> Promise {
        require!(
            !receipt.is_empty() && receipt.len() <= 2_000,
            "RECEIPT_REQUIRED"
        );
        require!(
            self.finish_retained_withdrawal(
                token_contract.clone(),
                withdrawal_id,
                succeeded,
                Some(receipt)
            ),
            "RETAINED_RECOVERY_NOT_REQUIRED"
        );
        self.refresh_retained_balance(token_contract)
    }
}

impl CompanyTreasury {
    fn load_retained(&self, token_contract: &AccountId) -> RetainedAsset {
        require!(
            token_contract != &self.token_contract,
            "USDC_IS_PAYMENT_CASH"
        );
        self.retained_assets
            .get(token_contract)
            .cloned()
            .expect("RETAINED_ASSET_NOT_FOUND")
    }

    fn retained_balance_probe(&self, token_contract: AccountId, epoch: U64) -> Promise {
        ext_ft::ext(token_contract.clone())
            .with_static_gas(GAS_BALANCE)
            .ft_balance_of(env::current_account_id())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_retained_balance_sync(self.company_id.clone(), token_contract, epoch),
            )
    }

    pub(crate) fn retained_deposit(
        &mut self,
        token_contract: AccountId,
        _sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(!self.paused, "PAUSED");
        require!(msg == RETAIN_MESSAGE, "RETAINED_DEPOSIT_MESSAGE_REQUIRED");
        require!(amount.0 > 0, "DEPOSIT_AMOUNT_REQUIRED");
        let mut asset = self.load_retained(&token_contract);
        require!(asset.enabled, "RETAINED_DEPOSITS_DISABLED");
        asset.balance = U128(add(asset.balance.0, amount.0));
        asset.balance_epoch = U64(asset
            .balance_epoch
            .0
            .checked_add(1)
            .expect("VERSION_OVERFLOW"));
        asset.confirmed_at_ms = U64(now_ms());
        self.retained_assets.insert(token_contract, asset);
        PromiseOrValue::Value(U128(0))
    }

    fn finish_retained_withdrawal(
        &mut self,
        token_contract: AccountId,
        withdrawal_id: U64,
        succeeded: bool,
        receipt: Option<String>,
    ) -> bool {
        let mut asset = self.load_retained(&token_contract);
        let Some(withdrawal) = asset.withdrawal.as_mut() else {
            return false;
        };
        if withdrawal.id != withdrawal_id || withdrawal.status != RetainedWithdrawalStatus::Pending
        {
            return false;
        }
        require!(
            asset.in_flight == withdrawal.amount,
            "RETAINED_WITHDRAWAL_MISMATCH"
        );
        asset.in_flight = U128(0);
        if !succeeded {
            asset.balance = U128(add(asset.balance.0, withdrawal.amount.0));
        }
        withdrawal.status = if succeeded {
            RetainedWithdrawalStatus::Succeeded
        } else {
            RetainedWithdrawalStatus::Failed
        };
        withdrawal.receipt = receipt;
        asset.balance_epoch = U64(asset
            .balance_epoch
            .0
            .checked_add(1)
            .expect("VERSION_OVERFLOW"));
        self.retained_assets.insert(token_contract.clone(), asset);
        self.emit(
            "retained_withdrawal_result",
            json!({"token_contract":token_contract,"withdrawal_id":withdrawal_id,"succeeded":succeeded}),
        );
        true
    }
}
