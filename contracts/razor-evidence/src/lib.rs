use near_sdk::{env, json_types::U64, near, require, serde_json::json};

#[near(contract_state)]
#[derive(Default)]
pub struct Evidence {}

#[near(serializers = [json])]
pub struct Challenge {
    nonce: String,
    context_hash: String,
    salt: String,
    recorder: String,
    block_height: U64,
    timestamp_ms: U64,
}

#[near]
impl Evidence {
    #[init]
    pub fn new() -> Self {
        Self {}
    }

    pub fn challenge(&self, context_hash: String, salt: String) -> Challenge {
        direct_caller();
        digest_input(&context_hash);
        digest_input(&salt);
        let recorder = env::signer_account_id().to_string();
        let mut material = b"razor-evidence:challenge:v1\0".to_vec();
        material.extend_from_slice(&env::random_seed_array());
        material.extend_from_slice(env::current_account_id().as_bytes());
        material.push(0);
        material.extend_from_slice(recorder.as_bytes());
        material.push(0);
        material.extend_from_slice(&env::block_height().to_le_bytes());
        material.extend_from_slice(&env::block_timestamp().to_le_bytes());
        material.extend_from_slice(context_hash.as_bytes());
        material.extend_from_slice(salt.as_bytes());
        let result = Challenge {
            nonce: hex(&env::sha256(&material)),
            context_hash,
            salt,
            recorder,
            block_height: U64(env::block_height()),
            timestamp_ms: U64(env::block_timestamp_ms()),
        };
        emit("challenge", near_sdk::serde_json::to_value(&result).expect("INVALID_CHALLENGE"));
        result
    }

    pub fn record_response(
        &self,
        challenge_transaction_hash: String,
        nonce: String,
        request_sha256: String,
        response_sha256: String,
        reports_sha256: String,
    ) {
        direct_caller();
        require!(
            (32..=64).contains(&challenge_transaction_hash.len())
                && challenge_transaction_hash.bytes().all(|byte| b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".contains(&byte)),
            "INVALID_TRANSACTION_HASH"
        );
        for value in [&nonce, &request_sha256, &response_sha256, &reports_sha256] {
            digest_input(value);
        }
        emit("response_commitment", json!({
            "challenge_transaction_hash": challenge_transaction_hash,
            "nonce": nonce,
            "request_sha256": request_sha256,
            "response_sha256": response_sha256,
            "reports_sha256": reports_sha256,
            "recorder": env::signer_account_id(),
            "block_height": U64(env::block_height()),
            "timestamp_ms": U64(env::block_timestamp_ms()),
        }));
    }
}

fn direct_caller() {
    require!(env::predecessor_account_id() == env::signer_account_id(), "DIRECT_RECORDING_REQUIRED");
    require!(env::attached_deposit().as_yoctonear() == 0, "NO_DEPOSIT_REQUIRED");
}

fn digest_input(value: &str) {
    require!(value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)), "INVALID_SHA256");
}

fn hex(value: &[u8]) -> String {
    const DIGITS: &[u8] = b"0123456789abcdef";
    let mut result = String::with_capacity(value.len() * 2);
    for byte in value {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!("EVENT_JSON:{}", json!({"standard":"razor-evidence","version":"1.0.0","event":event,"data":[data]})));
}
