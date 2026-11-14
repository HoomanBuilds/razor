use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseError, env, ext_contract, json_types::{U64, U128}, near, require, serde_json, store::IterableMap};

const MAINNET_USDC: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DAY_MS: u64 = 86_400_000;

#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub version: u8,
    pub invoice_id: String,
    pub company_id: String,
    pub plan_version_id: String,
    pub payer_id: AccountId,
    pub contract_id: AccountId,
    pub network: String,
    pub token_contract: AccountId,
    pub amount: U128,
    pub terms_hash: String,
    pub issued_at_ms: U64,
    pub expires_at_ms: U64,
}
#[near(serializers = [json])]
#[serde(deny_unknown_fields)]
pub struct Envelope { pub quote_json: String, pub signature: String }
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Invoice {
    pub invoice_id: String,
    pub company_id: String,
    pub plan_version_id: String,
    pub payer_id: AccountId,
    pub amount: U128,
    pub terms_hash: String,
    pub quote_hash: String,
    pub paid_at_ms: U64,
    pub paid_at_height: U64,
    pub refunded_amount: U128,
    pub pending_refund: Option<String>,
}
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Refund { pub id: String, pub invoice_id: String, pub amount: U128, pub status: String, pub nonce: U64 }
#[near(serializers = [json])]
pub struct BillingConfig {
    pub owner_id: AccountId,
    pub token_contract: AccountId,
    pub network: String,
    pub issuer_public_key: String,
    pub paused: bool,
    pub available: U128,
    pub withdrawal_pending: bool,
    pub version: u8,
}
#[derive(serde::Serialize)]
struct InvoicePaidData<'a> { invoice_id: &'a str, amount: U128 }
#[derive(serde::Serialize)]
struct InvoicePaidEvent<'a> {
    standard: &'static str,
    version: &'static str,
    event: &'static str,
    data: [InvoicePaidData<'a>; 1],
}
#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken { fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>); }
#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callbacks { fn on_refunded(&mut self, refund_id: String, nonce: U64) -> bool; fn on_withdrawn(&mut self, nonce: U64) -> bool; }

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Billing {
    owner_id: AccountId,
    token_contract: AccountId,
    network: String,
    issuer_public_key: String,
    paused: bool,
    available: u128,
    invoices: IterableMap<String, Invoice>,
    refunds: IterableMap<String, Refund>,
    nonce: u64,
    withdrawal: Option<(u64, u128)>,
}

#[near]
impl Billing {
    #[init]
    pub fn new(owner_id: AccountId, token_contract: AccountId, network: String, issuer_public_key: String) -> Self {
        require!(owner_id != env::current_account_id(), "OWNER_MUST_BE_RECOVERABLE");
        require!(network == "mainnet" || network == "testnet", "INVALID_NETWORK");
        require!(network != "mainnet" || token_contract.as_str() == MAINNET_USDC, "NATIVE_USDC_REQUIRED");
        require!(public_key(&issuer_public_key).is_some(), "INVALID_ISSUER_KEY");
        Self { owner_id, token_contract, network, issuer_public_key, paused: false, available: 0, invoices: IterableMap::new(b"i"), refunds: IterableMap::new(b"r"), nonce: 0, withdrawal: None }
    }
    pub fn get_config(&self) -> BillingConfig {
        BillingConfig { owner_id: self.owner_id.clone(), token_contract: self.token_contract.clone(), network: self.network.clone(), issuer_public_key: self.issuer_public_key.clone(), paused: self.paused, available: U128(self.available), withdrawal_pending: self.withdrawal.is_some(), version: 1 }
    }
    pub fn get_invoice(&self, invoice_id: String) -> Option<Invoice> { self.invoices.get(&invoice_id).cloned() }
    pub fn get_refund(&self, refund_id: String) -> Option<Refund> { self.refunds.get(&refund_id).cloned() }
    #[payable]
    pub fn set_paused(&mut self, paused: bool) { self.owner(); self.paused = paused; }
    #[payable]
    pub fn set_issuer_key(&mut self, issuer_public_key: String) { self.owner(); require!(public_key(&issuer_public_key).is_some(), "INVALID_ISSUER_KEY"); self.issuer_public_key = issuer_public_key; }
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == self.token_contract, "TOKEN_REQUIRED");
        if sender_id == self.owner_id && msg == "razor-billing-reserve" {
            self.available = self.available.checked_add(amount.0).expect("BALANCE_OVERFLOW");
            return PromiseOrValue::Value(U128(0));
        }
        let Some((offer, quote_hash)) = self.offer(&sender_id, &msg) else { return PromiseOrValue::Value(amount) };
        if self.paused || amount.0 < offer.amount.0 || self.invoices.contains_key(&offer.invoice_id) { return PromiseOrValue::Value(amount) }
        self.available = self.available.checked_add(offer.amount.0).expect("BALANCE_OVERFLOW");
        let invoice = Invoice { invoice_id: offer.invoice_id.clone(), company_id: offer.company_id, plan_version_id: offer.plan_version_id, payer_id: sender_id, amount: offer.amount, terms_hash: offer.terms_hash, quote_hash, paid_at_ms: U64(env::block_timestamp_ms()), paid_at_height: U64(env::block_height()), refunded_amount: U128(0), pending_refund: None };
        self.invoices.insert(offer.invoice_id.clone(), invoice);
        env::log_str(&serde_json::to_string(&InvoicePaidEvent { standard: "razor-billing", version: "1.0.0", event: "invoice_paid", data: [InvoicePaidData { invoice_id: &offer.invoice_id, amount: offer.amount }] }).unwrap());
        PromiseOrValue::Value(U128(amount.0 - offer.amount.0))
    }
    #[payable]
    pub fn refund_payment(&mut self, invoice_id: String, refund_id: String, amount: U128) -> PromiseOrValue<bool> {
        self.owner(); require!(valid_id(&refund_id), "INVALID_REFUND_ID");
        if let Some(previous) = self.refunds.get(&refund_id) {
            require!(previous.invoice_id == invoice_id && previous.amount.0 == amount.0, "REFUND_TERMS_CHANGED");
            if previous.status == "completed" { return PromiseOrValue::Value(true) }
            require!(previous.status == "failed", "REFUND_PENDING");
        }
        let mut invoice = self.invoices.get(&invoice_id).expect("INVOICE_NOT_FOUND").clone();
        require!(invoice.pending_refund.is_none(), "REFUND_PENDING");
        require!(amount.0 > 0 && amount.0 <= invoice.amount.0.checked_sub(invoice.refunded_amount.0).expect("REFUND_OVERFLOW"), "INVALID_REFUND_AMOUNT");
        require!(amount.0 <= self.available, "REFUND_RESERVE_REQUIRED");
        self.available -= amount.0; self.nonce = self.nonce.checked_add(1).expect("NONCE_OVERFLOW");
        let nonce = U64(self.nonce);
        self.refunds.insert(refund_id.clone(), Refund { id:refund_id.clone(), invoice_id:invoice_id.clone(), amount, status:"pending".into(), nonce });
        invoice.pending_refund = Some(refund_id.clone());
        self.invoices.insert(invoice_id, invoice.clone());
        PromiseOrValue::Promise(ext_ft::ext(self.token_contract.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(Gas::from_tgas(20)).ft_transfer(invoice.payer_id, amount, Some(format!("razor-billing-refund:{refund_id}"))).then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_refunded(refund_id, nonce)))
    }
    #[private]
    pub fn on_refunded(&mut self, refund_id: String, nonce: U64) -> bool {
        let Some(mut refund) = self.refunds.get(&refund_id).cloned() else { return false };
        if refund.status != "pending" || refund.nonce.0 != nonce.0 { return false }
        let mut invoice = self.invoices.get(&refund.invoice_id).expect("INVOICE_NOT_FOUND").clone();
        require!(invoice.pending_refund.as_ref() == Some(&refund_id), "REFUND_BINDING_CHANGED");
        let success = match env::promise_result_checked(0, 0) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        if success { invoice.refunded_amount.0 = invoice.refunded_amount.0.checked_add(refund.amount.0).expect("REFUND_OVERFLOW"); refund.status = "completed".into(); }
        else { self.available = self.available.checked_add(refund.amount.0).expect("BALANCE_OVERFLOW"); refund.status = "failed".into(); }
        invoice.pending_refund = None;
        self.invoices.insert(refund.invoice_id.clone(), invoice); self.refunds.insert(refund_id, refund); success
    }
    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        self.owner(); require!(self.withdrawal.is_none(), "WITHDRAWAL_PENDING"); require!(amount.0 > 0 && amount.0 <= self.available, "AVAILABLE_BALANCE_EXCEEDED");
        self.available -= amount.0; self.nonce = self.nonce.checked_add(1).expect("NONCE_OVERFLOW"); self.withdrawal = Some((self.nonce, amount.0));
        ext_ft::ext(self.token_contract.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(Gas::from_tgas(20)).ft_transfer(self.owner_id.clone(), amount, Some("Razor subscription revenue".into())).then(ext_self::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(15)).on_withdrawn(U64(self.nonce)))
    }
    #[private]
    pub fn on_withdrawn(&mut self, nonce: U64) -> bool {
        let Some((expected, amount)) = self.withdrawal else { return false };
        if nonce.0 != expected { return false }
        let success = match env::promise_result_checked(0, 0) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        if !success { self.available = self.available.checked_add(amount).expect("BALANCE_OVERFLOW"); }
        self.withdrawal = None; success
    }
}
impl Billing {
    fn owner(&self) { near_sdk::assert_one_yocto(); require!(env::predecessor_account_id() == self.owner_id, "ONLY_OWNER"); }
    fn offer(&self, sender: &AccountId, msg: &str) -> Option<(Offer, String)> {
        if msg.len() > 6000 { return None }
        let envelope: Envelope = serde_json::from_str(msg).ok()?;
        let signature: [u8;64] = near_sdk::bs58::decode(envelope.signature).into_vec().ok()?.try_into().ok()?;
        let key = public_key(&self.issuer_public_key)?;
        if !env::ed25519_verify(&signature, envelope.quote_json.as_bytes(), &key) { return None }
        let offer: Offer = serde_json::from_str(&envelope.quote_json).ok()?;
        let now = env::block_timestamp_ms();
        if offer.version != 1 || !valid_id(&offer.invoice_id) || !valid_id(&offer.company_id) || !valid_id(&offer.plan_version_id) || offer.payer_id != *sender || offer.contract_id != env::current_account_id() || offer.token_contract != self.token_contract || offer.network != self.network || offer.amount.0 == 0 || offer.amount.0 > 1_000_000_000_000 || offer.terms_hash.len() != 64 || !offer.terms_hash.bytes().all(|b|b.is_ascii_hexdigit()) || offer.issued_at_ms.0 > now.saturating_add(60_000) || offer.expires_at_ms.0 <= now || offer.expires_at_ms.0 <= offer.issued_at_ms.0 || offer.expires_at_ms.0 > offer.issued_at_ms.0.saturating_add(DAY_MS) { return None }
        Some((offer, hex(&env::sha256(envelope.quote_json.as_bytes()))))
    }
}
fn valid_id(value: &str) -> bool { !value.is_empty() && value.len() <= 128 && value.bytes().all(|b|b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }
fn public_key(value: &str) -> Option<[u8;32]> { near_sdk::bs58::decode(value.strip_prefix("ed25519:")?).into_vec().ok()?.try_into().ok() }
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 15) as usize] as char);
    }
    output
}
#[cfg(test)] mod tests;
