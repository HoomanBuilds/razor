use super::*;

impl CompanyTreasury {
    pub fn get_standing_mandate(&self, mandate_id: String) -> Option<StandingMandate> {
        self.standing_mandates.get(&mandate_id).cloned()
    }

    pub fn get_recipient_activation(&self, recipient_id: String) -> Option<U64> {
        self.recipient_activation.get(&recipient_id).copied()
    }

    pub fn get_standing_payment(&self, payment_id: String) -> Option<String> {
        self.standing_payments.get(&payment_id).cloned()
    }

    pub fn grant_standing_mandate(&mut self, terms: StandingMandateTerms) -> StandingMandate {
        self.assert_owner();
        require!(!self.paused, "PAUSED");
        validate_id(&terms.id);
        require!(
            !self.standing_mandates.contains_key(&terms.id),
            "MANDATE_EXISTS"
        );
        require!(
            terms.actor_id != self.owner_id
                && !self.approvers.contains(&terms.actor_id)
                && self.executors.contains(&terms.actor_id),
            "DEDICATED_EXECUTOR_REQUIRED"
        );
        require!(
            terms.supplier_profile_hash.len() == 64
                && terms
                    .supplier_profile_hash
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit()),
            "SUPPLIER_HASH_REQUIRED"
        );
        require!(
            terms.invoice_condition == "accepted_vendor_bill_application_gate",
            "INVOICE_CONDITION_REQUIRED"
        );
        require!(
            terms.per_payment_max_input.0 > 0
                && terms.per_payment_max_input.0 <= self.per_payment_limit
                && terms.per_payment_max_input.0 <= self.daily_limit
                && terms.period_max_input.0 >= terms.per_payment_max_input.0
                && terms.lifetime_max_input.0 >= terms.period_max_input.0,
            "INVALID_MANDATE_LIMITS"
        );
        require!(
            terms.period_ms.0 >= DAY_MS && terms.period_ms.0 <= 366 * DAY_MS,
            "INVALID_MANDATE_PERIOD"
        );
        require!(
            terms.valid_from_ms.0 < terms.expires_at_ms.0
                && terms.expires_at_ms.0 > now_ms()
                && terms.expires_at_ms.0 - terms.valid_from_ms.0 <= 366 * DAY_MS,
            "INVALID_MANDATE_VALIDITY"
        );
        let recipient = self
            .recipients
            .get(&terms.recipient_id)
            .expect("RECIPIENT_NOT_FOUND");
        require!(
            recipient.active && recipient.version == terms.recipient_version,
            "RECIPIENT_CHANGED"
        );
        require!(
            recipient.primary.network == "near"
                && recipient.primary.asset_id == format!("nep141:{}", self.token_contract),
            "NATIVE_USDC_ONLY"
        );
        let receiver: AccountId = recipient
            .primary
            .address
            .parse()
            .expect("INVALID_NEAR_DESTINATION");
        require!(
            receiver != env::current_account_id(),
            "INVALID_SOURCE_RECEIVER"
        );
        let required = self
            .approval_tiers
            .iter()
            .map(|tier| tier.required_approvals)
            .max()
            .expect("APPROVAL_POLICY_REQUIRED");
        let hash = hash_terms(
            json!({"domain":"razor_native_standing_v1","company_id":self.company_id,
            "treasury":env::current_account_id(),"terms":terms,"destination":recipient.primary,
            "policy_version":U64(self.policy_version),"required_approvals":required}),
        );
        let mandate = StandingMandate {
            terms: terms.clone(),
            destination: recipient.primary.clone(),
            policy_version: U64(self.policy_version),
            terms_hash: hash,
            approvals: BTreeSet::from([self.owner_id.clone()]),
            required_approvals: required,
            paused: false,
            revoked: false,
            period_index: U64(0),
            period_used_input: U128(0),
            lifetime_used_input: U128(0),
            pending_input: U128(0),
        };
        self.standing_mandates
            .insert(terms.id.clone(), mandate.clone());
        self.emit("standing_mandate_granted", json!({"mandate":mandate}));
        mandate
    }

    pub fn approve_standing_mandate(
        &mut self,
        mandate_id: String,
        expected_terms_hash: String,
    ) -> StandingMandate {
        self.assert_approver();
        let mut mandate = self
            .standing_mandates
            .get(&mandate_id)
            .cloned()
            .expect("MANDATE_NOT_FOUND");
        self.assert_standing_current(&mandate, false);
        require!(
            mandate.terms_hash == expected_terms_hash,
            "APPROVAL_TERMS_CHANGED"
        );
        mandate.approvals.insert(env::predecessor_account_id());
        self.standing_mandates
            .insert(mandate_id.clone(), mandate.clone());
        self.emit("standing_mandate_approved", json!({"mandate_id":mandate_id,"approver":env::predecessor_account_id(),"terms_hash":expected_terms_hash}));
        mandate
    }

    pub fn set_standing_mandate_status(
        &mut self,
        mandate_id: String,
        paused: bool,
        revoke: bool,
    ) -> StandingMandate {
        self.assert_owner();
        let mandate = self
            .standing_mandates
            .get_mut(&mandate_id)
            .expect("MANDATE_NOT_FOUND");
        require!(!mandate.revoked || revoke, "MANDATE_REVOKED");
        mandate.paused = paused;
        mandate.revoked |= revoke;
        let result = mandate.clone();
        self.emit(
            "standing_mandate_status",
            json!({"mandate_id":mandate_id,"paused":paused,"revoked":result.revoked}),
        );
        result
    }

    pub fn execute_standing_payment(
        &mut self,
        mandate_id: String,
        payment_id: String,
        attempt_id: String,
        amount: U128,
        max_fee: U128,
        reference: String,
        expected_terms_hash: String,
        execution_hash: String,
    ) -> Promise {
        require!(!self.paused, "PAUSED");
        require!(env::prepaid_gas() >= Gas::from_tgas(50), "INSUFFICIENT_GAS");
        require!(
            env::attached_deposit().as_yoctonear() == 0,
            "ZERO_DEPOSIT_REQUIRED"
        );
        validate_id(&payment_id);
        validate_id(&attempt_id);
        validate_id(&reference);
        require!(
            execution_hash.len() == 64 && execution_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "EXECUTION_HASH_REQUIRED"
        );
        require!(!self.payments.contains_key(&payment_id), "PAYMENT_EXISTS");
        require!(
            !self.obligations.contains_key(&reference),
            "OBLIGATION_EXISTS"
        );
        let mut mandate = self
            .standing_mandates
            .get(&mandate_id)
            .cloned()
            .expect("MANDATE_NOT_FOUND");
        self.assert_standing_current(&mandate, true);
        require!(
            mandate.terms_hash == expected_terms_hash,
            "APPROVAL_TERMS_CHANGED"
        );
        require!(
            env::predecessor_account_id() == mandate.terms.actor_id
                && env::signer_account_id() == mandate.terms.actor_id
                && env::signer_account_pk() == mandate.terms.actor_public_key,
            "MANDATE_ACTOR_KEY_MISMATCH"
        );
        let worst_case = add(amount.0, max_fee.0);
        require!(
            amount.0 > 0 && worst_case <= mandate.terms.per_payment_max_input.0,
            "MANDATE_PAYMENT_LIMIT"
        );
        let period = (now_ms() - mandate.terms.valid_from_ms.0) / mandate.terms.period_ms.0;
        if mandate.period_index.0 != period {
            mandate.period_index = U64(period);
            mandate.period_used_input = U128(0);
        }
        let period_used = add(mandate.period_used_input.0, worst_case);
        let lifetime_used = add(mandate.lifetime_used_input.0, worst_case);
        require!(
            period_used <= mandate.terms.period_max_input.0,
            "MANDATE_PERIOD_LIMIT"
        );
        require!(
            lifetime_used <= mandate.terms.lifetime_max_input.0,
            "MANDATE_LIFETIME_LIMIT"
        );
        require!(
            amount.0 <= self.balance.saturating_sub(self.reserved),
            "INSUFFICIENT_CONFIRMED_FUNDS"
        );
        let day = now_ms() / DAY_MS;
        let spent = add(*self.spent_by_day.get(&day).unwrap_or(&0), amount.0);
        require!(spent <= self.daily_limit, "DAILY_LIMIT");
        let receiver: AccountId = mandate
            .destination
            .address
            .parse()
            .expect("INVALID_NEAR_DESTINATION");
        let payment = Payment {
            id: payment_id.clone(),
            recipient_id: mandate.terms.recipient_id.clone(),
            recipient_version: mandate.terms.recipient_version,
            amount,
            max_fee,
            incurred_cost: U128(0),
            reservation: U128(0),
            expires_at_ms: mandate.terms.expires_at_ms,
            not_before_ms: U64(0),
            reference: reference.clone(),
            proposer: env::predecessor_account_id(),
            approver: None,
            approvals: BTreeSet::new(),
            policy_version: U64(self.policy_version),
            status: PaymentStatus::InFlight,
            attempts: vec![Attempt {
                id: attempt_id.clone(),
                use_backup: false,
                destination: mandate.destination.clone(),
                route: Route {
                    kind: RouteKind::Direct,
                    source_receiver: receiver.clone(),
                    input_amount: amount,
                    output_amount: amount,
                    quote_id: mandate_id.clone(),
                    quote_hash: execution_hash,
                    deadline_ms: mandate.terms.expires_at_ms,
                },
                authorized: true,
                approvals: BTreeSet::new(),
                approval_policy_version: U64(self.policy_version),
                status: AttemptStatus::Sending,
                sent_day: U64(day),
                refund_amount: U128(0),
                receipt: None,
                actual_output: U128(0),
                credited_amount: U128(0),
            }],
        };
        // Charges are permanent even when a transfer fails. Callbacks only close pending input.
        mandate.period_used_input = U128(period_used);
        mandate.lifetime_used_input = U128(lifetime_used);
        mandate.pending_input = U128(add(mandate.pending_input.0, worst_case));
        self.standing_mandates.insert(mandate_id.clone(), mandate);
        self.standing_payments
            .insert(payment_id.clone(), mandate_id.clone());
        self.obligations.insert(reference, payment_id.clone());
        self.payments.insert(payment_id.clone(), payment);
        self.spent_by_day.insert(day, spent);
        self.balance -= amount.0;
        self.in_flight = add(self.in_flight, amount.0);
        self.unsettled_payments = self
            .unsettled_payments
            .checked_add(1)
            .expect("ACTIVE_PAYMENT_OVERFLOW");
        self.bump_epoch();
        self.emit("standing_payment_started", json!({"mandate_id":mandate_id,"payment_id":payment_id,"attempt_id":attempt_id,"amount":amount,"receiver_id":receiver}));
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(receiver, amount, Some(payment_id.clone()))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_transfer_result(self.company_id.clone(), payment_id, attempt_id),
            )
    }

    fn assert_standing_current(&self, mandate: &StandingMandate, execution: bool) {
        require!(
            !self.paused && !mandate.paused && !mandate.revoked,
            "MANDATE_INACTIVE"
        );
        require!(
            mandate.policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(now_ms() < mandate.terms.expires_at_ms.0, "MANDATE_EXPIRED");
        require!(
            self.executors.contains(&mandate.terms.actor_id)
                && !self.is_approver(&mandate.terms.actor_id),
            "DEDICATED_EXECUTOR_REQUIRED"
        );
        let recipient = self
            .recipients
            .get(&mandate.terms.recipient_id)
            .expect("RECIPIENT_NOT_FOUND");
        require!(
            recipient.active
                && recipient.version == mandate.terms.recipient_version
                && recipient.primary == mandate.destination,
            "RECIPIENT_CHANGED"
        );
        if execution {
            require!(
                now_ms() >= mandate.terms.valid_from_ms.0,
                "MANDATE_NOT_STARTED"
            );
            require!(
                self.recipient_activation
                    .get(&recipient.id)
                    .is_some_and(|time| now_ms() >= time.0),
                "RECIPIENT_COOLDOWN"
            );
            require!(
                mandate.approvals.contains(&self.owner_id)
                    && mandate
                        .approvals
                        .iter()
                        .filter(|account| self.is_approver(account))
                        .count()
                        >= mandate.required_approvals as usize,
                "MANDATE_QUORUM_NOT_MET"
            );
        }
    }
}
