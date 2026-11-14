use ed25519_dalek::{Signer, SigningKey};
use near_parameters::{
    RuntimeConfigStore, RuntimeFeesConfig,
    vm::{Config, VMKind},
};
use near_primitives_core::{
    account::AccountContract,
    types::{Balance, Gas},
};
use near_vm_runner::{
    ContractCode, MockContractRuntimeCache,
    logic::{
        ReturnData, VMContext,
        mocks::mock_external::{MockAction, MockedExternal},
        types::PromiseResult,
    },
    prepare, run,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use wasmparser::{ExternalKind, Parser, Payload, TypeRef};

const NOW_MS: u64 = 1_800_000_000_000;
const TOKEN: &str = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const YOCTO: u128 = 1_000_000_000_000_000_000_000_000;

fn interface(bytes: &[u8]) -> (BTreeMap<String, String>, BTreeMap<String, String>) {
    let mut types = Vec::new();
    let mut functions = Vec::new();
    let mut imports = BTreeMap::new();
    let mut exports = Vec::new();
    for payload in Parser::new(0).parse_all(bytes) {
        match payload.expect("Invalid Wasm") {
            Payload::TypeSection(section) => {
                for item in section.into_iter_err_on_gc_types() {
                    types.push(item.expect("Unsupported Wasm type"));
                }
            }
            Payload::ImportSection(section) => {
                for item in section {
                    let item = item.expect("Invalid import");
                    let signature = match item.ty {
                        TypeRef::Func(index) => {
                            functions.push(index);
                            format!("{:?}", types[index as usize])
                        }
                        other => format!("{other:?}"),
                    };
                    imports.insert(format!("{}::{}", item.module, item.name), signature);
                }
            }
            Payload::FunctionSection(section) => {
                functions.extend(
                    section
                        .into_iter()
                        .map(|item| item.expect("Invalid function")),
                );
            }
            Payload::ExportSection(section) => {
                for item in section {
                    exports.push(item.expect("Invalid export"));
                }
            }
            _ => {}
        }
    }
    let exports = exports
        .into_iter()
        .map(|item| {
            let signature = match item.kind {
                ExternalKind::Func => {
                    format!("{:?}", types[functions[item.index as usize] as usize])
                }
                other => format!("{other:?}"),
            };
            (item.name.to_owned(), signature)
        })
        .collect();
    (imports, exports)
}

struct Instance {
    external: MockedExternal,
    config: Arc<Config>,
    fees: Arc<RuntimeFeesConfig>,
    cache: MockContractRuntimeCache,
    account: String,
    storage_usage: u64,
    now_ms: u64,
    signer_account_pk: Vec<u8>,
}

struct CallResult {
    value: Value,
    error: Option<String>,
    logs: Vec<Value>,
    actions: Value,
}

impl Instance {
    fn new(account: String, code: Vec<u8>) -> Self {
        let store = RuntimeConfigStore::for_chain_id("mainnet");
        let runtime = store.get_config(88);
        let mut config = (*runtime.wasm_config).clone();
        config.vm_kind = VMKind::Wasmtime;
        Self {
            storage_usage: code.len() as u64 + 100,
            now_ms: NOW_MS,
            signer_account_pk: vec![0; 33],
            external: MockedExternal::with_code(ContractCode::new(code, None)),
            config: Arc::new(config),
            fees: runtime.fees.clone(),
            cache: MockContractRuntimeCache::default(),
            account,
        }
    }

    fn call(
        &mut self,
        caller: &str,
        method: &str,
        args: &Value,
        deposit: u128,
        promise: Option<Result<Vec<u8>, ()>>,
    ) -> CallResult {
        self.call_with_results(caller, method, args, deposit, promise.into_iter().collect())
    }

    fn call_with_results(
        &mut self,
        caller: &str,
        method: &str,
        args: &Value,
        deposit: u128,
        promises: Vec<Result<Vec<u8>, ()>>,
    ) -> CallResult {
        let old_storage = self.external.fake_trie.clone();
        let action_start = self.external.action_log.len();
        let context = VMContext {
            current_account_id: self.account.parse().unwrap(),
            signer_account_id: caller.parse().unwrap(),
            signer_account_pk: self.signer_account_pk.clone(),
            predecessor_account_id: caller.parse().unwrap(),
            refund_to_account_id: caller.parse().unwrap(),
            input: serde_json::to_vec(args).unwrap().into(),
            promise_results: promises
                .into_iter()
                .map(|success| match success {
                    Ok(bytes) => PromiseResult::Successful(bytes.into()),
                    Err(()) => PromiseResult::Failed,
                })
                .collect::<Vec<_>>()
                .into(),
            block_height: 100,
            block_timestamp: self.now_ms * 1_000_000,
            epoch_height: 1,
            account_balance: Balance::from_yoctonear(100 * YOCTO),
            account_locked_balance: Balance::ZERO,
            storage_usage: self.storage_usage,
            account_contract: AccountContract::Local(self.external.code_hash),
            attached_deposit: Balance::from_yoctonear(deposit),
            prepaid_gas: Gas::from_teragas(300),
            random_seed: vec![7; 32],
            view_config: None,
            output_data_receivers: Vec::new(),
        };
        let gas = context.make_gas_counter(&self.config);
        let prepared = prepare(
            &self.external,
            self.config.clone(),
            Some(&self.cache),
            gas,
            method,
        );
        let result = run(prepared, &mut self.external, &context, self.fees.clone())
            .expect("Runtime failure");
        let error = result.aborted.map(|value| value.to_string());
        let value = match result.return_data {
            ReturnData::Value(bytes) => {
                serde_json::from_slice(&bytes).expect("Contract returned invalid JSON")
            }
            ReturnData::None => Value::Null,
            ReturnData::ReceiptIndex(index) => json!({"promise_receipt": index}),
        };
        let actions = serde_json::to_value(&self.external.action_log[action_start..]).unwrap();
        if error.is_some() {
            self.external.fake_trie = old_storage;
            self.external.action_log.truncate(action_start);
        } else {
            self.storage_usage = result.storage_usage;
        }
        let logs = result
            .logs
            .into_iter()
            .map(|value| match value.strip_prefix("EVENT_JSON:") {
                Some(payload) => json!({"format":"EVENT_JSON","payload":serde_json::from_str::<Value>(payload).expect("Invalid structured event")}),
                None => serde_json::from_str(&value).unwrap_or(Value::String(value)),
            })
            .collect();
        CallResult {
            value,
            error,
            actions,
            logs,
        }
    }
}

struct Pair {
    original: Instance,
    optimized: Instance,
    name: String,
    calls: usize,
}

fn strip_factory_artifact_terms(value: &mut Value) {
    if let Some(object) = value.as_object_mut() {
        for key in ["treasury_wasm_hash", "treasury_funding", "minimum_deposit"] {
            object.remove(key);
        }
    }
}

impl Pair {
    fn new(name: &str, baseline: &Path, optimized: &Path) -> Self {
        let read = |directory: &Path| {
            fs::read(directory.join(format!("razor_{name}.wasm"))).expect("Missing Wasm artifact")
        };
        let old_code = read(baseline);
        let new_code = read(optimized);
        let (old_imports, old_exports) = interface(&old_code);
        let (new_imports, new_exports) = interface(&new_code);
        assert_eq!(old_exports, new_exports, "{name}: public Wasm ABI changed");
        for (key, signature) in new_imports {
            assert_eq!(
                old_imports.get(&key),
                Some(&signature),
                "{name}: new or changed host import {key}"
            );
        }
        Self {
            original: Instance::new(format!("{name}.near"), old_code),
            optimized: Instance::new(format!("{name}.near"), new_code),
            name: name.into(),
            calls: 0,
        }
    }

    fn call(
        &mut self,
        caller: &str,
        method: &str,
        args: Value,
        deposit: u128,
        expected_error: Option<&str>,
        promise: Option<Result<Vec<u8>, ()>>,
    ) -> Value {
        let old = self
            .original
            .call(caller, method, &args, deposit, promise.clone());
        let new = self.optimized.call(caller, method, &args, deposit, promise);
        for result in [&old, &new] {
            match expected_error {
                Some(expected) => assert!(
                    result
                        .error
                        .as_deref()
                        .is_some_and(|error| error.contains(expected)),
                    "{}::{method}: expected {expected}, got {:?}",
                    self.name,
                    result.error
                ),
                None => assert!(
                    result.error.is_none(),
                    "{}::{method} failed: {:?}",
                    self.name,
                    result.error
                ),
            }
        }
        let mut old_value = old.value;
        let mut new_value = new.value;
        if self.name == "factory" {
            strip_factory_artifact_terms(&mut old_value);
            strip_factory_artifact_terms(&mut new_value);
        }
        assert_eq!(
            old_value, new_value,
            "{}::{method}: return value changed",
            self.name
        );
        assert_eq!(old.logs, new.logs, "{}::{method}: event changed", self.name);
        assert_eq!(
            old.actions, new.actions,
            "{}::{method}: promise actions changed",
            self.name
        );
        assert_eq!(
            self.original.external.fake_trie, self.optimized.external.fake_trie,
            "{}::{method}: persisted state changed",
            self.name
        );
        self.calls += 1;
        new_value
    }

    fn ok(&mut self, caller: &str, method: &str, args: Value, deposit: u128) -> Value {
        self.call(caller, method, args, deposit, None, None)
    }
    fn reject(&mut self, caller: &str, method: &str, args: Value, deposit: u128, error: &str) {
        self.call(caller, method, args, deposit, Some(error), None);
    }
    fn callback(&mut self, method: &str, args: Value, success: bool) -> Value {
        self.call(
            &format!("{}.near", self.name),
            method,
            args,
            0,
            None,
            Some(if success { Ok(Vec::new()) } else { Err(()) }),
        )
    }

    fn report(&self) -> Value {
        json!({"contract":self.name,"differential_calls":self.calls})
    }
}

fn check_treasury(baseline: &Path, optimized: &Path) -> Value {
    let mut pair = Pair::new("treasury", baseline, optimized);
    let init = json!({"owner_id":"owner.near","token_contract":TOKEN,"per_payment_limit":"100000000","daily_limit":"200000000"});
    pair.ok("owner.near", "new", init.clone(), 0);
    pair.reject("owner.near", "new", init, 0, "already been initialized");
    pair.ok("owner.near", "get_config", json!({}), 0);
    pair.ok("owner.near", "refresh_balance", json!({}), 0);
    pair.call(
        "treasury.near",
        "on_balance_sync",
        json!({"epoch":"0"}),
        0,
        None,
        Some(Ok(serde_json::to_vec(&json!("100000000")).unwrap())),
    );
    pair.reject(
        "stranger.near",
        "set_paused",
        json!({"paused":true}),
        1,
        "ONLY_OWNER",
    );
    let recipient = json!({"recipient_id":"employee-one","primary":{"asset_id":format!("nep141:{TOKEN}"),"network":"near","address":"employee.near"},"backup":null,"backup_consent":false,"active":true});
    pair.ok("owner.near", "set_recipient", recipient, 1);
    let payment = json!({"payment_id":"payment-one","recipient_id":"employee-one","amount":"1000000","max_fee":"1000","expires_at_ms":(NOW_MS+60000).to_string(),"reference":"payroll-one","not_before_ms":null});
    pair.ok("owner.near", "propose_payment", payment.clone(), 0);
    pair.reject(
        "owner.near",
        "propose_payment",
        payment.clone(),
        0,
        "PAYMENT_EXISTS",
    );
    let mut large = payment.clone();
    large["payment_id"] = json!("payment-too-large");
    large["reference"] = json!("payroll-too-large");
    large["amount"] = json!("100000001");
    pair.reject("owner.near", "propose_payment", large, 0, "PAYMENT_LIMIT");
    let status = pair.ok(
        "owner.near",
        "get_approval_status",
        json!({"payment_id":"payment-one","attempt_id":null}),
        0,
    );
    pair.reject("owner.near", "approve_payment", json!({"payment_id":"payment-one","expected_policy_version":"1","expected_terms_hash":"bad"}), 1, "APPROVAL_TERMS_CHANGED");
    pair.ok("owner.near", "approve_payment", json!({"payment_id":"payment-one","expected_policy_version":"1","expected_terms_hash":status["payment_terms_hash"]}), 1);
    pair.ok("owner.near", "get_balance", json!({}), 0);
    pair.ok("owner.near", "set_paused", json!({"paused":true}), 1);
    let mut paused = payment;
    paused["payment_id"] = json!("payment-paused");
    paused["reference"] = json!("payroll-paused");
    pair.reject("owner.near", "propose_payment", paused, 0, "PAUSED");
    pair.report()
}

fn factory_config(instance: &mut Instance, treasury: &[u8]) {
    let result = instance.call("owner.near", "get_config", &json!({}), 0, None);
    assert!(result.error.is_none());
    let expected_hash = bs58::encode(Sha256::digest(treasury)).into_string();
    let funding = (treasury.len() as u128 + 8192) * 10_000_000_000_000_000_000 + YOCTO / 20;
    assert_eq!(result.value["treasury_wasm_hash"], expected_hash);
    assert_eq!(result.value["treasury_funding"], funding.to_string());
    assert_eq!(
        result.value["minimum_deposit"],
        (funding + 2048 * 10_000_000_000_000_000_000).to_string()
    );
}

fn check_factory(baseline: &Path, optimized: &Path) -> Value {
    let mut pair = Pair::new("factory", baseline, optimized);
    let init = json!({"owner_id":"owner.near","token_contract":TOKEN});
    pair.ok("owner.near", "new", init.clone(), 0);
    pair.reject("owner.near", "new", init, 0, "already been initialized");
    pair.ok("owner.near", "get_config", json!({}), 0);
    pair.ok(
        "owner.near",
        "quote_creation",
        json!({"owner_id":"owner.near","slug":"company"}),
        0,
    );
    pair.reject(
        "stranger.near",
        "set_paused",
        json!({"paused":true}),
        1,
        "ONLY_OWNER",
    );
    pair.ok("owner.near", "set_paused", json!({"paused":true}), 1);
    pair.ok("owner.near", "get_config", json!({}), 0);
    factory_config(
        &mut pair.original,
        &fs::read(baseline.join("razor_treasury.wasm")).unwrap(),
    );
    factory_config(
        &mut pair.optimized,
        &fs::read(optimized.join("razor_treasury.wasm")).unwrap(),
    );
    pair.report()
}

fn check_clearing(baseline: &Path, optimized: &Path) -> Value {
    let mut pair = Pair::new("clearing", baseline, optimized);
    let init = json!({"owner_id":"owner.near","factory_id":"factory.near","token_contract":TOKEN});
    pair.ok("owner.near", "new", init.clone(), 0);
    pair.reject("owner.near", "new", init, 0, "already been initialized");
    pair.ok("owner.near", "get_config", json!({}), 0);
    pair.ok(
        "owner.near",
        "registration_cost",
        json!({"manifest_json":"sample"}),
        0,
    );
    pair.ok("owner.near", "get_round", json!({"round_id":"missing"}), 0);
    pair.reject(
        "stranger.near",
        "set_paused",
        json!({"paused":true}),
        1,
        "ONLY_OWNER",
    );
    pair.ok("owner.near", "set_paused", json!({"paused":true}), 1);
    pair.reject(
        "owner.near",
        "register_round",
        json!({"manifest_json":"{}","manifest_hash":"a".repeat(64)}),
        YOCTO,
        "PAUSED",
    );
    pair.ok("owner.near", "get_config", json!({}), 0);
    pair.report()
}

fn signed_offer(key: &SigningKey, invoice: &str) -> Value {
    let quote = json!({"version":1,"invoice_id":invoice,"company_id":"company-one","plan_version_id":"pro-one","payer_id":"payer.near","contract_id":"billing.near","network":"mainnet","token_contract":TOKEN,"amount":"29000000","terms_hash":"a".repeat(64),"issued_at_ms":NOW_MS.to_string(),"expires_at_ms":(NOW_MS+60000).to_string()}).to_string();
    json!({"quote_json":quote,"signature":bs58::encode(key.sign(quote.as_bytes()).to_bytes()).into_string()})
}

fn check_billing(baseline: &Path, optimized: &Path) -> Value {
    let mut pair = Pair::new("billing", baseline, optimized);
    let key = SigningKey::from_bytes(&[7; 32]);
    let init = json!({"owner_id":"owner.near","token_contract":TOKEN,"network":"mainnet","issuer_public_key":format!("ed25519:{}",bs58::encode(key.verifying_key().to_bytes()).into_string())});
    pair.ok("owner.near", "new", init.clone(), 0);
    pair.reject("owner.near", "new", init, 0, "already been initialized");
    pair.ok("owner.near", "get_config", json!({}), 0);
    let offer = signed_offer(&key, "invoice-one").to_string();
    let transfer = json!({"sender_id":"payer.near","amount":"30000000","msg":offer});
    pair.reject(
        "fake.near",
        "ft_on_transfer",
        transfer.clone(),
        0,
        "TOKEN_REQUIRED",
    );
    let mut underpaid = transfer.clone();
    underpaid["amount"] = json!("28000000");
    assert_eq!(pair.ok(TOKEN, "ft_on_transfer", underpaid, 0), "28000000");
    let mut invalid = transfer.clone();
    invalid["msg"] = json!(offer.replace("invoice-one", "forged-invoice"));
    assert_eq!(pair.ok(TOKEN, "ft_on_transfer", invalid, 0), "30000000");
    assert_eq!(
        pair.ok(TOKEN, "ft_on_transfer", transfer.clone(), 0),
        "1000000"
    );
    assert_eq!(pair.ok(TOKEN, "ft_on_transfer", transfer, 0), "30000000");
    pair.ok(
        "owner.near",
        "get_invoice",
        json!({"invoice_id":"invoice-one"}),
        0,
    );
    pair.reject(
        "stranger.near",
        "withdraw",
        json!({"amount":"1"}),
        1,
        "ONLY_OWNER",
    );
    pair.ok("owner.near", "set_paused", json!({"paused":true}), 1);
    assert_eq!(pair.ok(TOKEN, "ft_on_transfer", json!({"sender_id":"payer.near","amount":"29000000","msg":signed_offer(&key,"invoice-two").to_string()}), 0), "29000000");
    pair.ok(
        "owner.near",
        "refund_payment",
        json!({"invoice_id":"invoice-one","refund_id":"refund-one","amount":"29000000"}),
        1,
    );
    pair.reject(
        "owner.near",
        "refund_payment",
        json!({"invoice_id":"invoice-one","refund_id":"refund-two","amount":"1"}),
        1,
        "REFUND_PENDING",
    );
    assert_eq!(
        pair.callback(
            "on_refunded",
            json!({"refund_id":"refund-one","nonce":"1"}),
            true
        ),
        true
    );
    assert_eq!(
        pair.callback(
            "on_refunded",
            json!({"refund_id":"refund-one","nonce":"1"}),
            true
        ),
        false
    );
    pair.ok(
        "owner.near",
        "get_invoice",
        json!({"invoice_id":"invoice-one"}),
        0,
    );
    assert_eq!(
        pair.ok("owner.near", "get_config", json!({}), 0)["available"],
        "0"
    );
    pair.report()
}

fn actual_call(
    instance: &mut Instance,
    calls: &mut usize,
    caller: &str,
    method: &str,
    args: Value,
    deposit: u128,
    error: Option<&str>,
    promise: Option<Result<Vec<u8>, ()>>,
) -> Value {
    actual_call_with_results(
        instance,
        calls,
        caller,
        method,
        args,
        deposit,
        error,
        promise.into_iter().collect(),
    )
}

fn actual_call_with_results(
    instance: &mut Instance,
    calls: &mut usize,
    caller: &str,
    method: &str,
    args: Value,
    deposit: u128,
    error: Option<&str>,
    promises: Vec<Result<Vec<u8>, ()>>,
) -> Value {
    let result = instance.call_with_results(caller, method, &args, deposit, promises);
    if let Some(expected) = error {
        assert!(
            result
                .error
                .as_deref()
                .is_some_and(|error| error.contains(expected)),
            "{method}: expected {expected}, got {:?}",
            result.error
        );
    } else {
        assert!(
            result.error.is_none(),
            "{method} failed: {:?}",
            result.error
        );
    }
    *calls += 1;
    result.value
}

fn check_shared_treasury(directory: &Path) -> Value {
    let mut instance = Instance::new(
        "treasury.near".into(),
        fs::read(directory.join("razor_treasury.wasm")).expect("Missing shared treasury artifact"),
    );
    let mut calls = 0;
    let scope = |organization: &str, owner: &str| {
        let suffix = Sha256::digest(owner.as_bytes())
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!("{organization}:{suffix}")
    };
    let a = scope("11111111-1111-4111-8111-111111111111", "alice.near");
    let b = scope("22222222-2222-4222-8222-222222222222", "bob.near");
    actual_call(
        &mut instance,
        &mut calls,
        "operator.near",
        "new",
        json!({"owner_id":"operator.near","token_contract":TOKEN}),
        0,
        None,
        None,
    );
    let platform = actual_call(
        &mut instance,
        &mut calls,
        "operator.near",
        "get_platform_config",
        json!({}),
        0,
        None,
        None,
    );
    assert_eq!(platform["architecture"], "shared_v1");
    for (company, owner) in [(&a, "alice.near"), (&b, "bob.near")] {
        let quote = actual_call(
            &mut instance,
            &mut calls,
            owner,
            "quote_registration",
            json!({"company_id":company}),
            0,
            None,
            None,
        );
        let deposit = quote["minimum_deposit"]
            .as_str()
            .unwrap()
            .parse::<u128>()
            .unwrap();
        let args =
            json!({"company_id":company,"per_payment_limit":"100000000","daily_limit":"200000000"});
        actual_call(
            &mut instance,
            &mut calls,
            "stranger.near",
            "register_company",
            args.clone(),
            deposit,
            Some("COMPANY_OWNER_BINDING_MISMATCH"),
            None,
        );
        let config = actual_call(
            &mut instance,
            &mut calls,
            owner,
            "register_company",
            args.clone(),
            deposit,
            None,
            None,
        );
        assert_eq!(config["owner_id"], owner);
        assert_eq!(config["company_id"], *company);
        actual_call(
            &mut instance,
            &mut calls,
            owner,
            "register_company",
            args,
            deposit,
            Some("COMPANY_ALREADY_REGISTERED"),
            None,
        );
    }
    let funding = |company: &str, id: &str, amount: &str| json!({"sender_id":"intents.near","amount":amount,"msg":json!({"company_id":company,"deposit_id":id,"kind":"funding"}).to_string()});
    assert_eq!(
        actual_call(
            &mut instance,
            &mut calls,
            TOKEN,
            "ft_on_transfer",
            funding(&a, "deposit-one", "1000000"),
            0,
            None,
            None
        ),
        "0"
    );
    assert_eq!(
        actual_call(
            &mut instance,
            &mut calls,
            TOKEN,
            "ft_on_transfer",
            funding(&b, "deposit-two", "2000000"),
            0,
            None,
            None
        ),
        "0"
    );
    actual_call(
        &mut instance,
        &mut calls,
        TOKEN,
        "ft_on_transfer",
        funding(&b, "deposit-one", "1000000"),
        0,
        None,
        None,
    );
    actual_call(
        &mut instance,
        &mut calls,
        TOKEN,
        "ft_on_transfer",
        funding(&a, "deposit-one", "1"),
        0,
        None,
        None,
    );
    actual_call(
        &mut instance,
        &mut calls,
        "wrong-token.near",
        "ft_on_transfer",
        funding(&a, "deposit-three", "1000000"),
        0,
        Some("DEPOSIT_KIND_TOKEN_MISMATCH"),
        None,
    );
    actual_call(
        &mut instance,
        &mut calls,
        TOKEN,
        "ft_on_transfer",
        json!({"sender_id":"intents.near","amount":"1","msg":""}),
        0,
        Some("SCOPED_DEPOSIT_MESSAGE_REQUIRED"),
        None,
    );
    assert!(
        actual_call(
            &mut instance,
            &mut calls,
            "bob.near",
            "get_deposit",
            json!({"company_id":b,"deposit_id":"deposit-one","credit_id":"1"}),
            0,
            None,
            None
        )
        .is_null()
    );
    assert_eq!(
        actual_call(
            &mut instance,
            &mut calls,
            "alice.near",
            "get_deposit",
            json!({"company_id":a,"deposit_id":"deposit-one","credit_id":"1"}),
            0,
            None,
            None
        )["amount"],
        "1000000"
    );
    for (company, amount) in [(&a, "1000001"), (&b, "3000000")] {
        assert_eq!(
            actual_call(
                &mut instance,
                &mut calls,
                "reader.near",
                "get_balance",
                json!({"company_id":company}),
                0,
                None,
                None
            )["balance"],
            amount
        );
    }
    actual_call(
        &mut instance,
        &mut calls,
        "alice.near",
        "withdraw_available",
        json!({"company_id":b,"receiver_id":"alice.near","amount":"1"}),
        1,
        Some("ONLY_OWNER"),
        None,
    );
    actual_call(
        &mut instance,
        &mut calls,
        "alice.near",
        "withdraw_available",
        json!({"company_id":a,"receiver_id":"alice.near","amount":"100000"}),
        1,
        None,
        None,
    );
    let callback = json!({"company_id":a,"withdrawal_id":"1","amount":"100000"});
    actual_call(
        &mut instance,
        &mut calls,
        "treasury.near",
        "on_withdraw_result",
        callback.clone(),
        0,
        None,
        Some(Err(())),
    );
    actual_call(
        &mut instance,
        &mut calls,
        "treasury.near",
        "on_withdraw_result",
        callback,
        0,
        None,
        Some(Err(())),
    );
    assert_eq!(
        actual_call(
            &mut instance,
            &mut calls,
            "reader.near",
            "get_balance",
            json!({"company_id":a}),
            0,
            None,
            None
        )["balance"],
        "1000001"
    );
    assert_eq!(
        actual_call(
            &mut instance,
            &mut calls,
            "reader.near",
            "get_balance",
            json!({"company_id":b}),
            0,
            None,
            None
        )["balance"],
        "3000000"
    );
    actual_call(
        &mut instance,
        &mut calls,
        "stranger.near",
        "on_source_recovery_verified",
        json!({"company_id":a,"payment_id":"payment","attempt_id":"attempt","receipt":"untrusted","epoch":"0","pool_epoch":"0"}),
        0,
        Some("private"),
        Some(Ok(b"\"999999999\"".to_vec())),
    );
    actual_call(
        &mut instance,
        &mut calls,
        "stranger.near",
        "on_retained_recovery_verified",
        json!({"company_id":a,"token_contract":"wrapped.near","withdrawal_id":"1","receipt":"untrusted","epoch":"0","pool_epoch":"0"}),
        0,
        Some("private"),
        Some(Ok(b"\"999999999\"".to_vec())),
    );
    let standing = check_native_standing(&mut instance, &mut calls, &a, &b);
    let distributions = check_claim_distribution(&mut instance, &mut calls, &a);
    json!({"contract":"shared_treasury","actual_wasm_calls":calls,"company_isolation":true,"deposit_credit_records_immutable":true,"withdrawal_callback_replay_protected":true,"native_standing":standing,"claim_distribution":distributions})
}

fn assert_native_transfer_actions(
    instance: &Instance,
    start: usize,
    company: &str,
    payment: &str,
    attempt: &str,
) {
    let calls: Vec<_> = instance.external.action_log[start..]
        .iter()
        .filter_map(|action| match action {
            MockAction::FunctionCallWeight {
                receipt_index,
                method_name,
                args,
                attached_deposit,
                ..
            } => Some((
                *receipt_index,
                method_name,
                serde_json::from_slice::<Value>(args).unwrap(),
                attached_deposit,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].1.as_slice(), b"ft_transfer");
    assert_eq!(
        calls[0].2,
        json!({"receiver_id":"vendor.near","amount":"190000","memo":payment})
    );
    assert_eq!(*calls[0].3, Balance::from_yoctonear(1));
    assert!(matches!(&instance.external.action_log[calls[0].0 as usize],
        MockAction::CreateReceipt { receiver_id, .. } if receiver_id.as_str() == TOKEN));
    assert_eq!(calls[1].1.as_slice(), b"on_transfer_result");
    assert_eq!(
        calls[1].2,
        json!({"company_id":company,"payment_id":payment,"attempt_id":attempt})
    );
    assert!(matches!(&instance.external.action_log[calls[1].0 as usize],
        MockAction::CreateReceipt { receiver_id, .. } if receiver_id.as_str() == "treasury.near"));
}

fn check_native_standing(
    instance: &mut Instance,
    calls: &mut usize,
    company: &str,
    other_company: &str,
) -> Value {
    let day_ms = 86_400_000;
    let key = SigningKey::from_bytes(&[9; 32]);
    let public_key = format!(
        "ed25519:{}",
        bs58::encode(key.verifying_key().to_bytes()).into_string()
    );
    let mut actor_key = vec![0];
    actor_key.extend(key.verifying_key().to_bytes());
    macro_rules! invoke {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr, $error:expr, $promise:expr) => {{
            let args = if $method == "get_pool_liability" { $args } else {
                let mut scoped = json!({"company_id":company});
                scoped.as_object_mut().unwrap().extend($args.as_object().unwrap().clone());
                scoped
            };
            actual_call(instance, calls, $caller, $method, args, $deposit, $error, $promise)
        }};
    }
    macro_rules! ok {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr) => {
            invoke!($caller, $method, $args, $deposit, None, None)
        };
    }
    macro_rules! read {
        ($method:expr, $args:expr) => {
            ok!("reader.near", $method, $args, 0)
        };
    }
    macro_rules! reject {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr, $error:expr) => {
            invoke!($caller, $method, $args, $deposit, Some($error), None)
        };
    }
    macro_rules! callback {
        ($args:expr, $success:expr) => {
            invoke!(
                "treasury.near",
                "on_transfer_result",
                $args,
                0,
                None,
                Some(if $success { Ok(Vec::new()) } else { Err(()) })
            )
        };
    }
    let balance_before = read!("get_balance", json!({}))["balance"]
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    let other_balance = read!("get_balance", json!({"company_id":other_company}));
    let pool_before = read!("get_pool_liability", json!({"token_contract":TOKEN}))
        .as_str()
        .unwrap()
        .parse::<u128>()
        .unwrap();
    ok!("alice.near", "add_storage", json!({}), YOCTO);
    for (account, role) in [("agent.near", "executor"), ("finance.near", "approver")] {
        ok!(
            "alice.near",
            "set_role",
            json!({"account_id":account,"role":role,"enabled":true}),
            1
        );
    }
    let policy = read!("get_config", json!({}));
    ok!(
        "alice.near",
        "set_approval_policy",
        json!({"expected_policy_version":policy["policy_version"],
        "tiers":[{"up_to":"1000000","required_approvals":1},{"up_to":"200000000","required_approvals":2}]}),
        1
    );
    ok!(
        "alice.near",
        "set_recipient",
        json!({"recipient_id":"standing-vendor",
        "primary":{"asset_id":format!("nep141:{TOKEN}"),"network":"near","address":"vendor.near"},
        "backup":null,"backup_consent":false,"active":true}),
        1
    );
    let terms = json!({"id":"native-vendor-grant","recipient_id":"standing-vendor","recipient_version":"1",
        "supplier_profile_hash":"a".repeat(64),"actor_id":"agent.near","actor_public_key":public_key,
        "per_payment_max_input":"200000","period_max_input":"300000","lifetime_max_input":"450000",
        "period_ms":day_ms.to_string(),"valid_from_ms":NOW_MS.to_string(),
        "expires_at_ms":(NOW_MS+10*day_ms).to_string(),"invoice_condition":"accepted_vendor_bill_application_gate"});
    reject!(
        "agent.near",
        "grant_standing_mandate",
        json!({"terms":terms}),
        1,
        "ONLY_OWNER"
    );
    let grant = ok!(
        "alice.near",
        "grant_standing_mandate",
        json!({"terms":terms}),
        1
    );
    assert_eq!(grant["terms"], terms);
    assert_eq!(grant["required_approvals"], 2);
    assert_eq!(grant["approvals"], json!(["alice.near"]));
    assert!(
        read!(
            "get_standing_mandate",
            json!({"company_id":other_company,"mandate_id":"native-vendor-grant"})
        )
        .is_null()
    );
    let execute = |payment: &str, attempt: &str, amount: &str| {
        json!({"mandate_id":"native-vendor-grant",
        "payment_id":payment,"attempt_id":attempt,"amount":amount,"max_fee":"10000",
        "reference":format!("bill:{payment}"),"expected_terms_hash":grant["terms_hash"],"execution_hash":"b".repeat(64)})
    };
    instance.signer_account_pk = actor_key.clone();
    instance.now_ms = NOW_MS + day_ms - 1;
    reject!(
        "agent.near",
        "execute_standing_payment",
        execute("cooldown", "cooldown-attempt", "190000"),
        0,
        "RECIPIENT_COOLDOWN"
    );
    instance.now_ms += 1;
    reject!(
        "agent.near",
        "execute_standing_payment",
        execute("quorum", "quorum-attempt", "190000"),
        0,
        "MANDATE_QUORUM_NOT_MET"
    );
    let approved = ok!(
        "finance.near",
        "approve_standing_mandate",
        json!({"mandate_id":"native-vendor-grant","expected_terms_hash":grant["terms_hash"]}),
        1
    );
    assert_eq!(approved["approvals"], json!(["alice.near", "finance.near"]));
    reject!(
        "stranger.near",
        "execute_standing_payment",
        execute("actor", "actor-attempt", "190000"),
        0,
        "MANDATE_ACTOR_KEY_MISMATCH"
    );
    instance.signer_account_pk = vec![0; 33];
    reject!(
        "agent.near",
        "execute_standing_payment",
        execute("key", "key-attempt", "190000"),
        0,
        "MANDATE_ACTOR_KEY_MISMATCH"
    );
    instance.signer_account_pk = actor_key;
    let first = execute("standing-old", "standing-old-attempt", "190000");
    let action_start = instance.external.action_log.len();
    ok!("agent.near", "execute_standing_payment", first.clone(), 0);
    assert_native_transfer_actions(
        instance,
        action_start,
        company,
        "standing-old",
        "standing-old-attempt",
    );
    reject!(
        "agent.near",
        "execute_standing_payment",
        first,
        0,
        "PAYMENT_EXISTS"
    );
    reject!(
        "agent.near",
        "execute_standing_payment",
        execute("payment-limit", "payment-limit-attempt", "200000"),
        0,
        "MANDATE_PAYMENT_LIMIT"
    );
    reject!(
        "agent.near",
        "execute_standing_payment",
        execute("period-limit", "period-limit-attempt", "100001"),
        0,
        "MANDATE_PERIOD_LIMIT"
    );
    let payment = read!("get_payment", json!({"payment_id":"standing-old"}));
    assert_eq!(payment["approvals"], json!([]));
    assert_eq!(payment["attempts"][0]["route"]["kind"], "direct");
    assert_eq!(
        payment["attempts"][0]["route"]["source_receiver"],
        "vendor.near"
    );
    assert_eq!(payment["attempts"][0]["route"]["input_amount"], "190000");
    assert_eq!(payment["attempts"][0]["route"]["output_amount"], "190000");
    let usage = read!(
        "get_standing_mandate",
        json!({"mandate_id":"native-vendor-grant"})
    );
    assert_eq!(usage["period_used_input"], "200000");
    assert_eq!(usage["lifetime_used_input"], "200000");
    assert_eq!(usage["pending_input"], "200000");
    instance.now_ms = NOW_MS + 2 * day_ms;
    let action_start = instance.external.action_log.len();
    ok!(
        "agent.near",
        "execute_standing_payment",
        execute("standing-new", "standing-new-attempt", "190000"),
        0
    );
    assert_native_transfer_actions(
        instance,
        action_start,
        company,
        "standing-new",
        "standing-new-attempt",
    );
    let pending = read!("get_balance", json!({}));
    assert_eq!(pending["balance"], (balance_before - 380000).to_string());
    assert_eq!(pending["in_flight"], "380000");
    assert_eq!(
        read!("get_pool_liability", json!({"token_contract":TOKEN})),
        pool_before.to_string()
    );
    let old_callback = json!({"payment_id":"standing-old","attempt_id":"standing-old-attempt"});
    assert_eq!(callback!(old_callback.clone(), false), false);
    assert_eq!(callback!(old_callback, false), false);
    let returned = read!("get_balance", json!({}));
    assert_eq!(returned["balance"], (balance_before - 190000).to_string());
    assert_eq!(returned["reserved"], "200000");
    assert_eq!(returned["in_flight"], "190000");
    let usage = read!(
        "get_standing_mandate",
        json!({"mandate_id":"native-vendor-grant"})
    );
    assert_eq!(usage["period_index"], "2");
    assert_eq!(usage["period_used_input"], "200000");
    assert_eq!(usage["lifetime_used_input"], "400000");
    assert_eq!(usage["pending_input"], "200000");
    reject!(
        "agent.near",
        "execute_standing_payment",
        execute("lifetime-limit", "lifetime-limit-attempt", "40001"),
        0,
        "MANDATE_LIFETIME_LIMIT"
    );
    let new_callback = json!({"payment_id":"standing-new","attempt_id":"standing-new-attempt"});
    assert_eq!(callback!(new_callback.clone(), true), true);
    let final_balance = read!("get_balance", json!({}));
    assert_eq!(callback!(new_callback, true), false);
    assert_eq!(read!("get_balance", json!({})), final_balance);
    assert_eq!(
        final_balance["balance"],
        (balance_before - 190000).to_string()
    );
    assert_eq!(final_balance["in_flight"], "0");
    assert_eq!(
        read!("get_pool_liability", json!({"token_contract":TOKEN})),
        (pool_before - 190000).to_string()
    );
    assert_eq!(
        read!("get_balance", json!({"company_id":other_company})),
        other_balance
    );
    let usage = read!(
        "get_standing_mandate",
        json!({"mandate_id":"native-vendor-grant"})
    );
    assert_eq!(usage["pending_input"], "0");
    assert_eq!(usage["lifetime_used_input"], "400000");
    assert_eq!(
        read!("get_payment", json!({"payment_id":"standing-old"}))["status"],
        "held"
    );
    assert_eq!(
        read!("get_payment", json!({"payment_id":"standing-new"}))["status"],
        "paid"
    );
    json!({"owner_grant_highest_quorum_and_actor_key":true,"recipient_cooldown_boundary":true,
        "native_transfer_duplicate_and_budget_holds":true,"late_callback_conservation_and_replay":true})
}

fn check_claim_distribution(instance: &mut Instance, calls: &mut usize, company: &str) -> Value {
    macro_rules! invoke {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr, $error:expr, $promise:expr) => {{
            let mut args = $args;
            if $method != "get_pool_liability" {
                args["company_id"] = json!(company);
            }
            actual_call(
                instance, calls, $caller, $method, args, $deposit, $error, $promise,
            )
        }};
    }
    macro_rules! ok {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr) => {
            invoke!($caller, $method, $args, $deposit, None, None)
        };
    }
    macro_rules! read {
        ($method:expr, $args:expr) => {
            ok!("reader.near", $method, $args, 0)
        };
    }
    macro_rules! reject {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr, $error:expr) => {
            invoke!($caller, $method, $args, $deposit, Some($error), None)
        };
    }
    let policy = read!("get_config", json!({}));
    let before = read!("get_balance", json!({}));
    let pool_before = read!("get_pool_liability", json!({"token_contract":TOKEN}));
    let deadline = instance.now_ms + 86_400_000;
    let allocation = json!({"claim_id":"fixed-claim","recipient_id":"standing-vendor","recipient_version":"1","amount":"200"});
    let creation = json!({"distribution_id":"wasm-claims","reference":"wasm-claims","network":"mainnet",
        "allocations":[allocation],"expected_total":"200","deadline_ms":deadline.to_string(),"expected_policy_version":policy["policy_version"]});
    let mut wrong = creation.clone();
    wrong["expected_total"] = json!("201");
    reject!(
        "alice.near",
        "create_distribution",
        wrong,
        1,
        "ALLOCATION_TOTAL_MISMATCH"
    );
    let proposed = ok!("alice.near", "create_distribution", creation, 1);
    assert_eq!(proposed["status"], "proposed");
    assert_eq!(proposed["required_approvals"], 2);
    assert_eq!(
        read!("get_balance", json!({}))["reserved"],
        before["reserved"]
    );
    let claim = json!({"distribution_id":"wasm-claims","claim_id":"fixed-claim"});
    reject!(
        "relayer.near",
        "claim_distribution",
        claim.clone(),
        0,
        "DISTRIBUTION_NOT_ACTIVE"
    );
    let active = ok!(
        "finance.near",
        "approve_distribution",
        json!({"distribution_id":"wasm-claims","expected_terms_hash":proposed["terms_hash"]}),
        1
    );
    assert_eq!(active["status"], "active");
    let action_start = instance.external.action_log.len();
    ok!("relayer.near", "claim_distribution", claim.clone(), 0);
    let functions: Vec<_> = instance.external.action_log[action_start..]
        .iter()
        .filter_map(|action| match action {
            MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } => Some((
                method_name.clone(),
                serde_json::from_slice::<Value>(args).unwrap(),
                *attached_deposit,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(functions.len(), 2);
    assert_eq!(functions[0].0.as_slice(), b"ft_transfer");
    assert_eq!(functions[0].1["receiver_id"], "vendor.near");
    assert_eq!(functions[0].1["amount"], "200");
    assert_eq!(functions[0].2, Balance::from_yoctonear(1));
    assert_eq!(functions[1].0.as_slice(), b"on_distribution_claim_result");
    assert_eq!(functions[1].1["company_id"], company);
    reject!(
        "relayer.near",
        "claim_distribution",
        claim,
        0,
        "CLAIM_ALREADY_USED"
    );
    let pending = read!("get_balance", json!({}));
    assert_eq!(pending["in_flight"], "200");
    instance.now_ms = deadline;
    let reclaim =
        json!({"distribution_id":"wasm-claims","expected_terms_hash":proposed["terms_hash"]});
    reject!(
        "alice.near",
        "reclaim_distribution",
        reclaim.clone(),
        1,
        "NO_RECLAIMABLE_FUNDS"
    );
    let callback = json!({"distribution_id":"wasm-claims","claim_id":"fixed-claim","nonce":"1"});
    invoke!(
        "stranger.near",
        "on_distribution_claim_result",
        callback.clone(),
        0,
        Some("private"),
        Some(Err(()))
    );
    assert_eq!(
        invoke!(
            "treasury.near",
            "on_distribution_claim_result",
            callback.clone(),
            0,
            None,
            Some(Err(()))
        ),
        false
    );
    assert_eq!(
        invoke!(
            "treasury.near",
            "on_distribution_claim_result",
            callback,
            0,
            None,
            Some(Err(()))
        ),
        false
    );
    let returned = ok!("alice.near", "reclaim_distribution", reclaim, 1);
    assert_eq!(returned["reclaimed"], "200");
    assert_eq!(returned["pending"], "0");
    assert_eq!(
        read!("get_balance", json!({}))["balance"],
        before["balance"]
    );
    assert_eq!(
        read!("get_balance", json!({}))["reserved"],
        before["reserved"]
    );
    assert_eq!(
        read!("get_pool_liability", json!({"token_contract":TOKEN})),
        pool_before
    );
    json!({"exact_sum_and_highest_quorum":true,"fixed_transfer_and_duplicate_guard":true,"pending_reclaim_and_callback_replay":true,
        "terms_hash":proposed["terms_hash"],"commitment_input":{"network":"mainnet","treasury":"treasury.near","companyId":company,"token":TOKEN,
        "owner":"alice.near","policyVersion":policy["policy_version"],"requiredApprovals":2,"deadlineMs":deadline.to_string(),"id":"wasm-claims",
        "reference":"wasm-claims","total":"200","allocations":[{"claim_id":"fixed-claim","recipient_id":"standing-vendor","recipient_version":"1","amount":"200","destination":"vendor.near"}]}})
}

fn check_shared_clearing(directory: &Path) -> Value {
    let mut instance = Instance::new(
        "clearing.near".into(),
        fs::read(directory.join("razor_clearing.wasm")).expect("Missing clearing artifact"),
    );
    let mut calls = 0;
    actual_call(
        &mut instance,
        &mut calls,
        "operator.near",
        "new",
        json!({"owner_id":"operator.near","treasury_id":"treasury.near","token_contract":TOKEN}),
        0,
        None,
        None,
    );
    let config = actual_call(
        &mut instance,
        &mut calls,
        "reader.near",
        "get_config",
        json!({}),
        0,
        None,
        None,
    );
    assert_eq!(config["treasury_id"], "treasury.near");
    assert!(config.get("factory_id").is_none());
    actual_call(
        &mut instance,
        &mut calls,
        "stranger.near",
        "set_paused",
        json!({"paused":true}),
        1,
        Some("ONLY_OWNER"),
        None,
    );
    actual_call(
        &mut instance,
        &mut calls,
        "operator.near",
        "set_paused",
        json!({"paused":true}),
        1,
        None,
        None,
    );
    actual_call(
        &mut instance,
        &mut calls,
        "operator.near",
        "register_round",
        json!({"manifest_json":"{}","manifest_hash":"a".repeat(64)}),
        YOCTO,
        Some("PAUSED"),
        None,
    );
    json!({"contract":"shared_clearing","actual_wasm_calls":calls})
}

fn clearing_fixture_manifest(id: &str, cash: bool) -> Value {
    let mut manifest = json!({"id":id,"asset":"USDC","fee":"0","starts_at_ms":(NOW_MS-1000).to_string(),
        "expires_at_ms":(NOW_MS+60000).to_string(),"participants":[
            {"company_id":"company-a","treasury_id":"treasury.near","treasury_company_id":"company-a:aaaaaaaaaaaaaaaa","owner_id":"alice.near","version":"1","policy_version":"1"},
            {"company_id":"company-b","treasury_id":"treasury.near","treasury_company_id":"company-b:bbbbbbbbbbbbbbbb","owner_id":"bob.near","version":"1","policy_version":"1"}],
        "obligations":[{"id":format!("{id}-invoice-a"),"terms_hash":"a".repeat(64),"debtor":"company-a","creditor":"company-b","original":"100","reduction":"70","residual":"30"},
            {"id":format!("{id}-invoice-b"),"terms_hash":"b".repeat(64),"debtor":"company-b","creditor":"company-a","original":"70","reduction":"70","residual":"0"}]});
    if cash {
        manifest["cash"] = json!({"mode":"cash_backed_native_v1","network":"mainnet","token_contract":TOKEN,
            "refund_policy":"return_accepted_deposits_to_fixed_owner_on_cancel","positions":[
                {"company_id":"company-a","deposit_due":"30","credit_due":"0","destination":"alice.near"},
                {"company_id":"company-b","deposit_due":"0","credit_due":"30","destination":"bob.near"}]});
    }
    manifest
}

fn clearing_fixture_authorities() -> Vec<Result<Vec<u8>, ()>> {
    [
        ("company-a:aaaaaaaaaaaaaaaa", "alice.near"),
        ("company-b:bbbbbbbbbbbbbbbb", "bob.near"),
    ]
    .map(|(company, owner)| {
        Ok(
            serde_json::to_vec(&json!({"architecture":"shared_v1","company_id":company,
            "owner_id":owner,"token_contract":TOKEN,"paused":false,"policy_version":"1"}))
            .unwrap(),
        )
    })
    .to_vec()
}

fn register_clearing_fixture(
    instance: &mut Instance,
    calls: &mut usize,
    manifest: &Value,
) -> (String, String, Value) {
    let id = manifest["id"].as_str().unwrap();
    let wire = manifest.to_string();
    let hash = format!("{:x}", Sha256::digest(wire.as_bytes()));
    let cost = actual_call(
        instance,
        calls,
        "reader.near",
        "registration_cost",
        json!({"manifest_json":wire}),
        0,
        None,
        None,
    );
    actual_call(
        instance,
        calls,
        "alice.near",
        "register_round",
        json!({"manifest_json":wire,"manifest_hash":hash}),
        cost.as_str().unwrap().parse().unwrap(),
        None,
        None,
    );
    assert_eq!(
        actual_call_with_results(
            instance,
            calls,
            "clearing.near",
            "on_registered",
            json!({"round_id":id}),
            0,
            None,
            clearing_fixture_authorities()
        ),
        true
    );
    (wire, hash, cost)
}

fn consent_clearing_fixture(instance: &mut Instance, calls: &mut usize, id: &str, hash: &str) {
    for (index, (company, owner)) in [("company-a", "alice.near"), ("company-b", "bob.near")]
        .into_iter()
        .enumerate()
    {
        actual_call(
            instance,
            calls,
            owner,
            "consent",
            json!({"round_id":id,"manifest_hash":hash,"company_id":company}),
            1,
            None,
            None,
        );
        assert_eq!(
            actual_call(
                instance,
                calls,
                "clearing.near",
                "on_consented",
                json!({"round_id":id,"company_id":company,"owner_id":owner,"request_id":(index+1).to_string()}),
                0,
                None,
                Some(clearing_fixture_authorities().remove(index))
            ),
            true
        );
    }
}

fn cash_funding_fixture(id: &str, hash: &str, deposit: &str, amount: &str) -> Value {
    json!({"sender_id":"alice.near","amount":amount,"msg":json!({"kind":"razor_clearing_cash_v1","round_id":id,
        "manifest_hash":hash,"company_id":"company-a","deposit_id":deposit}).to_string()})
}

fn cash_withdraw_fixture(id: &str, hash: &str, kind: &str, nonce: &str) -> Value {
    json!({"round_id":id,"manifest_hash":hash,"company_id":if kind == "credit" {"company-b"} else {"company-a"},"kind":kind,"expected_nonce":nonce})
}

fn accepted_cash_event(instance: &mut Instance, calls: &mut usize, args: Value) -> (Value, Value) {
    let result = instance.call(TOKEN, "ft_on_transfer", &args, 0, None);
    assert!(result.error.is_none(), "funding failed: {:?}", result.error);
    *calls += 1;
    let event = result
        .logs
        .iter()
        .find(|log| log["payload"]["event"] == "cash_deposit_accepted")
        .map(|log| log["payload"].clone())
        .expect("Missing actual cash acceptance event");
    assert_eq!(event["standard"], "razor-clearing");
    assert_eq!(event["version"], "2.0.0");
    assert_eq!(event["data"].as_array().unwrap().len(), 1);
    let msg: Value = serde_json::from_str(args["msg"].as_str().unwrap()).unwrap();
    for field in ["round_id", "manifest_hash", "company_id", "deposit_id"] {
        assert_eq!(event["data"][0][field], msg[field]);
    }
    assert_eq!(event["data"][0]["submitted"], args["amount"]);
    assert_eq!(event["data"][0]["sender_id"], args["sender_id"]);
    (result.value, event)
}

fn cash_callback_fixture(id: &str, kind: &str, nonce: &str, amount: &str) -> Value {
    json!({"round_id":id,"company_id":if kind == "credit" {"company-b"} else {"company-a"},"kind":kind,"nonce":nonce,"amount":amount})
}

fn assert_cash_transfer_actions(
    instance: &Instance,
    start: usize,
    receiver: &str,
    amount: &str,
    callback: Value,
) {
    let functions: Vec<_> = instance.external.action_log[start..]
        .iter()
        .filter_map(|action| match action {
            MockAction::FunctionCallWeight {
                receipt_index,
                method_name,
                args,
                attached_deposit,
                ..
            } => Some((
                *receipt_index,
                method_name,
                serde_json::from_slice::<Value>(args).unwrap(),
                attached_deposit,
            )),
            _ => None,
        })
        .collect();
    assert_eq!(functions.len(), 2);
    assert_eq!(functions[0].1.as_slice(), b"ft_transfer");
    assert_eq!(functions[0].2["receiver_id"], receiver);
    assert_eq!(functions[0].2["amount"], amount);
    assert_eq!(*functions[0].3, Balance::from_yoctonear(1));
    assert!(
        matches!(&instance.external.action_log[functions[0].0 as usize], MockAction::CreateReceipt { receiver_id, .. } if receiver_id.as_str() == TOKEN)
    );
    assert_eq!(functions[1].1.as_slice(), b"on_cash_withdrawn");
    assert_eq!(functions[1].2, callback);
    assert!(
        matches!(&instance.external.action_log[functions[1].0 as usize], MockAction::CreateReceipt { receiver_id, .. } if receiver_id.as_str() == "clearing.near")
    );
}

fn assert_cash_counters(value: &Value, expected: (u128, u128, u128, u128)) {
    let amount = |field: &str| value[field].as_str().unwrap().parse::<u128>().unwrap();
    let values = (
        amount("cash_accepted"),
        amount("cash_available"),
        amount("cash_pending"),
        amount("cash_paid"),
    );
    assert_eq!(values, expected);
    assert_eq!(values.0, values.1 + values.2 + values.3);
}

fn check_funded_clearing(directory: &Path) -> Value {
    let mut instance = Instance::new(
        "clearing.near".into(),
        fs::read(directory.join("razor_clearing.wasm")).expect("Missing clearing artifact"),
    );
    let mut calls = 0;
    macro_rules! invoke {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr, $error:expr, $promise:expr) => {
            actual_call(
                &mut instance,
                &mut calls,
                $caller,
                $method,
                $args,
                $deposit,
                $error,
                $promise,
            )
        };
    }
    macro_rules! ok {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr) => {
            invoke!($caller, $method, $args, $deposit, None, None)
        };
    }
    macro_rules! read {
        ($method:expr, $args:expr) => {
            ok!("reader.near", $method, $args, 0)
        };
    }
    macro_rules! reject {
        ($caller:expr, $method:expr, $args:expr, $deposit:expr, $error:expr) => {
            invoke!($caller, $method, $args, $deposit, Some($error), None)
        };
    }
    ok!(
        "operator.near",
        "new",
        json!({"owner_id":"operator.near","treasury_id":"treasury.near","token_contract":TOKEN}),
        0
    );
    reject!(
        "stranger.near",
        "enable_cash",
        json!({"network":"mainnet","testnet_token_contract":null}),
        1,
        "ONLY_OWNER"
    );
    ok!(
        "operator.near",
        "enable_cash",
        json!({"network":"mainnet","testnet_token_contract":null}),
        1
    );
    let configured = read!("get_config", json!({}));
    assert_eq!(configured["state_version"], 2);
    assert_eq!(configured["cash_network"], "mainnet");
    assert_eq!(configured["max_cash_deposits_per_company"], 8);

    let legacy = clearing_fixture_manifest("wasm-legacy-clearing", false);
    let (legacy_wire, legacy_hash, legacy_cost) =
        register_clearing_fixture(&mut instance, &mut calls, &legacy);
    assert!(!legacy_wire.contains("\"cash\""));
    let legacy_round = read!("get_round", json!({"round_id":legacy["id"]}));
    assert_eq!(legacy_round["manifest_json"], legacy_wire);
    assert_eq!(legacy_round["hash"], legacy_hash);
    assert!(legacy_round["manifest"].get("cash").is_none());
    assert!(legacy_round["cash"].is_null());

    let manifest = clearing_fixture_manifest("wasm-cash-credit", true);
    let mut invalid = manifest.clone();
    invalid["cash"]["positions"][1]["credit_due"] = json!("31");
    let invalid_wire = invalid.to_string();
    reject!(
        "alice.near",
        "register_round",
        json!({"manifest_json":invalid_wire,"manifest_hash":format!("{:x}",Sha256::digest(invalid_wire.as_bytes()))}),
        YOCTO,
        "CASH_NET_POSITION_MISMATCH"
    );
    let (wire, hash, cash_cost) = register_clearing_fixture(&mut instance, &mut calls, &manifest);
    let id = manifest["id"].as_str().unwrap();
    let deposit = cash_funding_fixture(id, &hash, "wasm-deposit-partial", "10");
    assert_eq!(ok!(TOKEN, "ft_on_transfer", deposit.clone(), 0), "10");
    consent_clearing_fixture(&mut instance, &mut calls, id, &hash);
    let finalize = json!({"round_id":id,"manifest_hash":hash});
    reject!(
        "alice.near",
        "finalize_round",
        finalize.clone(),
        1,
        "CASH_EXACT_FUNDING_REQUIRED"
    );
    assert_eq!(
        ok!("foreign.near", "ft_on_transfer", deposit.clone(), 0),
        "10"
    );
    assert_eq!(ok!(TOKEN, "ft_on_transfer", deposit.clone(), 0), "0");
    let accepted_event = instance.external.action_log.len();
    assert_eq!(ok!(TOKEN, "ft_on_transfer", deposit, 0), "10");
    assert_eq!(instance.external.action_log.len(), accepted_event);
    reject!(
        "alice.near",
        "finalize_round",
        finalize.clone(),
        1,
        "CASH_EXACT_FUNDING_REQUIRED"
    );
    let (unused, accepted_event) = accepted_cash_event(
        &mut instance,
        &mut calls,
        cash_funding_fixture(id, &hash, "wasm-deposit-excess", "25"),
    );
    assert_eq!(unused, "5");
    let recorded = read!(
        "get_cash_deposit",
        json!({"round_id":id,"company_id":"company-a","deposit_id":"wasm-deposit-excess"})
    );
    assert_eq!(recorded["accepted"], "20");
    assert_eq!(recorded["unused"], "5");
    assert_eq!(recorded["accepted_at_ms"], NOW_MS.to_string());
    ok!("alice.near", "finalize_round", finalize, 1);
    assert_eq!(
        actual_call_with_results(
            &mut instance,
            &mut calls,
            "clearing.near",
            "on_finalized",
            json!({"round_id":id,"request_id":"3"}),
            0,
            None,
            clearing_fixture_authorities()
        ),
        true
    );
    let finalized = read!("get_round", json!({"round_id":id}));
    assert_eq!(finalized["status"], "finalized");
    assert_eq!(finalized["manifest_json"], wire);
    assert_eq!(finalized["hash"], hash);
    assert_eq!(finalized["cash"]["accounts"][1]["credit_available"], "30");
    assert_eq!(finalized["cash"]["accounts"][0]["credit_available"], "0");
    assert_cash_counters(&read!("get_config", json!({})), (30, 30, 0, 0));
    let credit = cash_withdraw_fixture(id, &hash, "credit", "1");
    reject!(
        "stranger.near",
        "withdraw_cash",
        credit.clone(),
        1,
        "ONLY_FIXED_OWNER"
    );
    let actions = instance.external.action_log.len();
    ok!("bob.near", "withdraw_cash", credit.clone(), 1);
    let callback = cash_callback_fixture(id, "credit", "1", "30");
    assert_cash_transfer_actions(&instance, actions, "bob.near", "30", callback.clone());
    assert_eq!(
        invoke!(
            "clearing.near",
            "on_cash_withdrawn",
            callback.clone(),
            0,
            None,
            None
        ),
        false
    );
    reject!(
        "bob.near",
        "withdraw_cash",
        cash_withdraw_fixture(id, &hash, "credit", "2"),
        1,
        "CASH_TRANSFER_PENDING"
    );
    reject!(
        "stranger.near",
        "on_cash_withdrawn",
        callback.clone(),
        0,
        "private"
    );
    assert_eq!(
        invoke!(
            "clearing.near",
            "on_cash_withdrawn",
            callback.clone(),
            0,
            None,
            Some(Err(()))
        ),
        false
    );
    reject!(
        "bob.near",
        "withdraw_cash",
        credit,
        1,
        "CASH_NONCE_MISMATCH"
    );
    ok!(
        "bob.near",
        "withdraw_cash",
        cash_withdraw_fixture(id, &hash, "credit", "2"),
        1
    );
    assert_eq!(
        invoke!(
            "clearing.near",
            "on_cash_withdrawn",
            callback,
            0,
            None,
            Some(Ok(Vec::new()))
        ),
        false
    );
    let callback = cash_callback_fixture(id, "credit", "2", "30");
    assert_eq!(
        invoke!(
            "clearing.near",
            "on_cash_withdrawn",
            callback.clone(),
            0,
            None,
            Some(Ok(Vec::new()))
        ),
        true
    );
    assert_eq!(
        invoke!(
            "clearing.near",
            "on_cash_withdrawn",
            callback,
            0,
            None,
            Some(Ok(Vec::new()))
        ),
        false
    );

    let refund_manifest = clearing_fixture_manifest("wasm-cash-refund", true);
    let (_, refund_hash, _) =
        register_clearing_fixture(&mut instance, &mut calls, &refund_manifest);
    let refund_id = refund_manifest["id"].as_str().unwrap();
    consent_clearing_fixture(&mut instance, &mut calls, refund_id, &refund_hash);
    assert_eq!(
        ok!(
            TOKEN,
            "ft_on_transfer",
            cash_funding_fixture(refund_id, &refund_hash, "wasm-refund-deposit", "17"),
            0
        ),
        "0"
    );
    ok!(
        "bob.near",
        "revoke",
        json!({"round_id":refund_id,"manifest_hash":refund_hash}),
        1
    );
    ok!(
        "bob.near",
        "revoke",
        json!({"round_id":refund_id,"manifest_hash":refund_hash}),
        1
    );
    let refundable = read!("get_cash_round", json!({"round_id":refund_id}));
    assert_eq!(refundable["accounts"][0]["refund_available"], "17");
    assert_eq!(refundable["accounts"][1]["refund_available"], "0");
    ok!(
        "alice.near",
        "withdraw_cash",
        cash_withdraw_fixture(refund_id, &refund_hash, "refund", "1"),
        1
    );
    assert_eq!(
        invoke!(
            "clearing.near",
            "on_cash_withdrawn",
            cash_callback_fixture(refund_id, "refund", "1", "17"),
            0,
            None,
            Some(Ok(Vec::new()))
        ),
        true
    );

    let expired_manifest = clearing_fixture_manifest("wasm-cash-expired", true);
    let (_, expired_hash, _) =
        register_clearing_fixture(&mut instance, &mut calls, &expired_manifest);
    let expired_id = expired_manifest["id"].as_str().unwrap();
    consent_clearing_fixture(&mut instance, &mut calls, expired_id, &expired_hash);
    assert_eq!(
        ok!(
            TOKEN,
            "ft_on_transfer",
            cash_funding_fixture(expired_id, &expired_hash, "wasm-expired-deposit", "30"),
            0
        ),
        "0"
    );
    ok!(
        "alice.near",
        "finalize_round",
        json!({"round_id":expired_id,"manifest_hash":expired_hash}),
        1
    );
    instance.now_ms = NOW_MS + 60000;
    assert_eq!(
        actual_call_with_results(
            &mut instance,
            &mut calls,
            "clearing.near",
            "on_finalized",
            json!({"round_id":expired_id,"request_id":"3"}),
            0,
            None,
            clearing_fixture_authorities()
        ),
        false
    );
    assert_eq!(
        ok!(
            TOKEN,
            "ft_on_transfer",
            cash_funding_fixture(expired_id, &expired_hash, "wasm-expired-late", "5"),
            0
        ),
        "5"
    );
    ok!("anyone.near", "expire", json!({"round_id":expired_id}), 0);
    ok!(
        "alice.near",
        "withdraw_cash",
        cash_withdraw_fixture(expired_id, &expired_hash, "refund", "1"),
        1
    );
    let held = read!("get_round", json!({"round_id":expired_id}));
    assert_eq!(held["status"], "expired");
    assert_eq!(held["cash"]["stage"], "refunds");
    assert_eq!(held["cash"]["accounts"][0]["pending"]["amount"], "30");
    reject!(
        "alice.near",
        "withdraw_cash",
        cash_withdraw_fixture(expired_id, &expired_hash, "refund", "2"),
        1,
        "CASH_TRANSFER_PENDING"
    );
    let final_config = read!("get_config", json!({}));
    assert_cash_counters(&final_config, (77, 0, 30, 47));
    json!({"contract":"funded_clearing","actual_wasm_calls":calls,"fixture_only":true,"live_network":false,
        "legacy_manifest":{"manifest_json":legacy_wire,"manifest_hash":legacy_hash,"registration_cost":legacy_cost},
        "cash_manifest":{"manifest_json":wire,"manifest_hash":hash,"registration_cost":cash_cost,"onchain_manifest_json":finalized["manifest_json"],"onchain_hash":finalized["hash"]},
        "finalized_credit":finalized["cash"],"excess_deposit":recorded,"accepted_event":accepted_event,"unresolved_refund":held["cash"],"final_config":final_config,
        "checks":{"original_net_validated":true,"all_consent_exact_funding":true,"partial_excess_duplicate":true,"fixed_destination_nonce_and_replay":true,
        "cancelled_depositor_refund":true,"deadline_blocks_late_credit":true,"unknown_stays_pending":true,"global_counters_conserved":true}})
}

fn main() {
    assert_eq!(
        env::var("RAYON_NUM_THREADS").as_deref(),
        Ok("1"),
        "Run with RAYON_NUM_THREADS=1 to bound runtime compilation"
    );
    let mut args = env::args_os().skip(1);
    let first = args
        .next()
        .expect("Pass --shared ARTIFACT_DIRECTORY or BASELINE OPTIMIZED");
    if first == "--shared" {
        let directory = PathBuf::from(args.next().expect("Pass shared artifact directory"));
        assert!(
            args.next().is_none(),
            "Pass only --shared and its artifact directory"
        );
        let treasury = check_shared_treasury(&directory);
        let clearing = check_shared_clearing(&directory);
        let funded_clearing = check_funded_clearing(&directory);
        let billing = check_billing(&directory, &directory);
        println!(
            "{}",
            json!({"runtime":"near-vm-runner 0.35.1 / Wasmtime","configuration":"mainnet runtime store requested at protocol88; latest available configuration before88 is84","architecture":"shared_v1","actual_wasm":true,"live_network":false,"results":[treasury,clearing,billing,funded_clearing]})
        );
        return;
    }
    let baseline = PathBuf::from(first);
    let optimized = PathBuf::from(args.next().expect("Pass optimized artifact directory"));
    assert!(
        args.next().is_none(),
        "Pass only the two artifact directories"
    );
    let mut results = Vec::new();
    for check in [check_treasury, check_factory, check_clearing, check_billing] {
        let result = check(&baseline, &optimized);
        println!("{}", result);
        results.push(result);
    }
    println!(
        "{}",
        json!({"runtime":"near-vm-runner 0.35.1 / Wasmtime","configuration":"mainnet runtime store requested at protocol88; latest available configuration before88 is84","actual_wasm":true,"differential_results":results})
    );
}
