use super::*;

impl CompanyTreasury {
    pub fn get_distribution(&self, distribution_id: String) -> Option<Distribution> {
        self.distributions.get(&distribution_id).cloned()
    }

    pub fn distribution_voided(&self, distribution_id: String) -> bool {
        self.void_distributions.contains_key(&distribution_id)
    }

    pub fn void_distribution(&mut self, distribution_id: String) -> bool {
        self.assert_owner();
        validate_id(&distribution_id);
        if let Some(value) = self.distributions.get_mut(&distribution_id) {
            require!(
                value.status == DistributionStatus::Proposed
                    || value.status == DistributionStatus::Cancelled,
                "FUNDED_DISTRIBUTION_CANNOT_VOID"
            );
            value.status = DistributionStatus::Cancelled;
        }
        self.void_distributions
            .insert(distribution_id.clone(), true);
        self.emit(
            "distribution_creation_voided",
            json!({"distribution_id":distribution_id}),
        );
        true
    }

    pub fn create_distribution(
        &mut self,
        distribution_id: String,
        reference: String,
        network: String,
        allocations: Vec<DistributionAllocation>,
        expected_total: U128,
        deadline_ms: U64,
        expected_policy_version: U64,
    ) -> Distribution {
        self.assert_owner();
        require!(
            expected_policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(!self.paused, "PAUSED");
        validate_id(&distribution_id);
        validate_id(&reference);
        require!(
            !self.distributions.contains_key(&distribution_id),
            "DISTRIBUTION_EXISTS"
        );
        require!(
            !self.distribution_voided(distribution_id.clone()),
            "DISTRIBUTION_VOIDED"
        );
        let obligation = format!("distribution:{reference}");
        require!(
            !self.obligations.contains_key(&obligation),
            "OBLIGATION_EXISTS"
        );
        require!(
            network == "mainnet" || network == "testnet",
            "NETWORK_REQUIRED"
        );
        require!(
            !allocations.is_empty() && allocations.len() <= 64,
            "ALLOCATION_LIMIT"
        );
        require!(
            deadline_ms.0 > now_ms() && deadline_ms.0 - now_ms() <= 366 * DAY_MS,
            "INVALID_CLAIM_DEADLINE"
        );
        let mut claims = Vec::new();
        let mut total = 0u128;
        let mut ids = BTreeSet::new();
        let mut recipients = BTreeSet::new();
        for allocation in allocations {
            validate_id(&allocation.claim_id);
            require!(
                ids.insert(allocation.claim_id.clone())
                    && recipients.insert(allocation.recipient_id.clone()),
                "DUPLICATE_ALLOCATION"
            );
            require!(
                allocation.amount.0 > 0 && allocation.amount.0 <= self.per_payment_limit,
                "ALLOCATION_AMOUNT_INVALID"
            );
            let recipient = self
                .recipients
                .get(&allocation.recipient_id)
                .expect("RECIPIENT_NOT_FOUND");
            require!(
                recipient.active && recipient.version == allocation.recipient_version,
                "RECIPIENT_CHANGED"
            );
            require!(
                recipient.primary.network == "near"
                    && recipient.primary.asset_id == format!("nep141:{}", self.token_contract),
                "NATIVE_USDC_ONLY"
            );
            let destination: AccountId = recipient
                .primary
                .address
                .parse()
                .expect("INVALID_NEAR_DESTINATION");
            require!(
                destination != env::current_account_id(),
                "INVALID_SOURCE_RECEIVER"
            );
            total = add(total, allocation.amount.0);
            claims.push(DistributionClaim {
                allocation,
                destination,
                status: ClaimStatus::Ready,
                nonce: U64(0),
                sent_day: U64(0),
            });
        }
        require!(total == expected_total.0, "ALLOCATION_TOTAL_MISMATCH");
        let required = self
            .approval_tiers
            .iter()
            .map(|tier| tier.required_approvals)
            .max()
            .expect("APPROVAL_POLICY_REQUIRED");
        let terms_hash = hash_terms(
            json!({"domain":"razor_native_distribution_v1","treasury":env::current_account_id(),
            "company_id":self.company_id,"network":network,"token":self.token_contract,"id":distribution_id,
            "reference":reference,"claims":claims,"total":U128(total),"deadline_ms":deadline_ms,
            "unused_policy":"return_unclaimed_to_company_after_deadline","policy_version":U64(self.policy_version),"required_approvals":required}),
        );
        let mut value = Distribution {
            id: distribution_id.clone(),
            reference,
            network,
            token_contract: self.token_contract.clone(),
            deadline_ms,
            total: U128(total),
            unclaimed: U128(0),
            pending: U128(0),
            paid: U128(0),
            reclaimed: U128(0),
            policy_version: U64(self.policy_version),
            terms_hash,
            required_approvals: required,
            approvals: BTreeSet::from([self.owner_id.clone()]),
            status: DistributionStatus::Proposed,
            claims,
        };
        self.activate_distribution(&mut value);
        self.obligations.insert(obligation, distribution_id.clone());
        self.distributions.insert(distribution_id, value.clone());
        self.emit("distribution_created", json!({"distribution":value}));
        value
    }

    pub fn approve_distribution(
        &mut self,
        distribution_id: String,
        expected_terms_hash: String,
    ) -> Distribution {
        self.assert_approver();
        require!(!self.paused, "PAUSED");
        let mut value = self
            .distributions
            .get(&distribution_id)
            .cloned()
            .expect("DISTRIBUTION_NOT_FOUND");
        require!(
            value.status == DistributionStatus::Proposed,
            "DISTRIBUTION_NOT_PROPOSED"
        );
        require!(
            value.terms_hash == expected_terms_hash
                && value.policy_version.0 == self.policy_version,
            "APPROVAL_TERMS_CHANGED"
        );
        require!(now_ms() < value.deadline_ms.0, "DISTRIBUTION_EXPIRED");
        value.approvals.insert(env::predecessor_account_id());
        self.activate_distribution(&mut value);
        self.distributions
            .insert(distribution_id.clone(), value.clone());
        self.emit("distribution_approved", json!({"distribution_id":distribution_id,"terms_hash":expected_terms_hash,"status":value.status}));
        value
    }

    fn activate_distribution(&mut self, value: &mut Distribution) {
        let count = value
            .approvals
            .iter()
            .filter(|account| self.is_approver(account))
            .count();
        if !value.approvals.contains(&self.owner_id) || count < value.required_approvals as usize {
            return;
        }
        for claim in &value.claims {
            self.assert_distribution_recipient(claim);
        }
        require!(
            value.total.0 <= self.balance.saturating_sub(self.reserved),
            "INSUFFICIENT_CONFIRMED_FUNDS"
        );
        self.reserved = add(self.reserved, value.total.0);
        self.bump_epoch();
        value.unclaimed = value.total;
        value.status = DistributionStatus::Active;
    }

    fn assert_distribution_recipient(&self, claim: &DistributionClaim) {
        let current = self
            .recipients
            .get(&claim.allocation.recipient_id)
            .expect("RECIPIENT_NOT_FOUND");
        require!(
            current.active
                && current.version == claim.allocation.recipient_version
                && current.primary.network == "near"
                && current.primary.asset_id == format!("nep141:{}", self.token_contract)
                && current.primary.address == claim.destination.as_str(),
            "RECIPIENT_CHANGED"
        );
    }

    pub fn claim_distribution(&mut self, distribution_id: String, claim_id: String) -> Promise {
        require!(!self.paused, "PAUSED");
        require!(
            env::attached_deposit().as_yoctonear() == 0,
            "ZERO_DEPOSIT_REQUIRED"
        );
        require!(env::prepaid_gas() >= Gas::from_tgas(80), "INSUFFICIENT_GAS");
        let mut value = self
            .distributions
            .get(&distribution_id)
            .cloned()
            .expect("DISTRIBUTION_NOT_FOUND");
        require!(
            value.status == DistributionStatus::Active,
            "DISTRIBUTION_NOT_ACTIVE"
        );
        require!(
            value.policy_version.0 == self.policy_version,
            "POLICY_CHANGED"
        );
        require!(now_ms() < value.deadline_ms.0, "DISTRIBUTION_EXPIRED");
        let claim = value
            .claims
            .iter_mut()
            .find(|claim| claim.allocation.claim_id == claim_id)
            .expect("CLAIM_NOT_FOUND");
        require!(claim.status == ClaimStatus::Ready, "CLAIM_ALREADY_USED");
        self.assert_distribution_recipient(claim);
        let amount = claim.allocation.amount.0;
        require!(amount <= self.per_payment_limit, "PER_PAYMENT_LIMIT");
        let day = now_ms() / DAY_MS;
        let spent = add(*self.spent_by_day.get(&day).unwrap_or(&0), amount);
        require!(spent <= self.daily_limit, "DAILY_LIMIT");
        claim.status = ClaimStatus::Pending;
        claim.nonce = U64(claim.nonce.0.checked_add(1).expect("NONCE_OVERFLOW"));
        claim.sent_day = U64(day);
        let nonce = claim.nonce;
        let receiver = claim.destination.clone();
        value.unclaimed = U128(
            value
                .unclaimed
                .0
                .checked_sub(amount)
                .expect("CLAIM_UNDERFLOW"),
        );
        value.pending = U128(add(value.pending.0, amount));
        self.reserved = self
            .reserved
            .checked_sub(amount)
            .expect("RESERVATION_UNDERFLOW");
        self.balance = self.balance.checked_sub(amount).expect("BALANCE_UNDERFLOW");
        self.in_flight = add(self.in_flight, amount);
        self.spent_by_day.insert(day, spent);
        self.bump_epoch();
        self.distributions.insert(distribution_id.clone(), value);
        self.emit("distribution_claim_started", json!({"distribution_id":distribution_id,"claim_id":claim_id,"nonce":nonce,"amount":U128(amount),"receiver":receiver}));
        ext_ft::ext(self.token_contract.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_TRANSFER)
            .ft_transfer(
                receiver,
                U128(amount),
                Some(format!("Razor distribution {distribution_id}:{claim_id}")),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(30))
                    .on_distribution_claim_result(
                        self.company_id.clone(),
                        distribution_id,
                        claim_id,
                        nonce,
                    ),
            )
    }

    pub fn on_distribution_claim_result(
        &mut self,
        distribution_id: String,
        claim_id: String,
        nonce: U64,
    ) -> bool {
        let success = match env::promise_result_checked(0, 64) {
            Ok(_) | Err(PromiseError::TooLong(_)) => true,
            Err(PromiseError::Failed) => false,
            Err(_) => return false,
        };
        let Some(mut value) = self.distributions.get(&distribution_id).cloned() else {
            return false;
        };
        let Some(claim) = value
            .claims
            .iter_mut()
            .find(|claim| claim.allocation.claim_id == claim_id)
        else {
            return false;
        };
        if claim.status != ClaimStatus::Pending || claim.nonce != nonce {
            return false;
        }
        let amount = claim.allocation.amount.0;
        value.pending = U128(
            value
                .pending
                .0
                .checked_sub(amount)
                .expect("CLAIM_PENDING_UNDERFLOW"),
        );
        self.in_flight = self
            .in_flight
            .checked_sub(amount)
            .expect("IN_FLIGHT_UNDERFLOW");
        if success {
            claim.status = ClaimStatus::Paid;
            value.paid = U128(add(value.paid.0, amount));
        } else {
            claim.status = ClaimStatus::Ready;
            value.unclaimed = U128(add(value.unclaimed.0, amount));
            self.balance = add(self.balance, amount);
            self.reserved = add(self.reserved, amount);
            let spent = *self.spent_by_day.get(&claim.sent_day.0).unwrap_or(&0);
            self.spent_by_day.insert(
                claim.sent_day.0,
                spent.checked_sub(amount).expect("SPEND_UNDERFLOW"),
            );
        }
        self.bump_epoch();
        if value.paid == value.total {
            value.status = DistributionStatus::Complete;
        }
        self.distributions.insert(distribution_id.clone(), value);
        self.emit("distribution_claim_result", json!({"distribution_id":distribution_id,"claim_id":claim_id,"nonce":nonce,"success":success}));
        success
    }

    pub fn reclaim_distribution(
        &mut self,
        distribution_id: String,
        expected_terms_hash: String,
    ) -> Distribution {
        self.assert_owner();
        let mut value = self
            .distributions
            .get(&distribution_id)
            .cloned()
            .expect("DISTRIBUTION_NOT_FOUND");
        require!(
            value.terms_hash == expected_terms_hash,
            "APPROVAL_TERMS_CHANGED"
        );
        if value.status == DistributionStatus::Proposed {
            value.status = DistributionStatus::Cancelled;
        } else {
            require!(
                now_ms() >= value.deadline_ms.0,
                "CLAIM_DEADLINE_NOT_REACHED"
            );
            require!(
                value.status == DistributionStatus::Active
                    || value.status == DistributionStatus::Closed,
                "DISTRIBUTION_CLOSED"
            );
            let mut returned = 0u128;
            for claim in &mut value.claims {
                if claim.status == ClaimStatus::Ready {
                    returned = add(returned, claim.allocation.amount.0);
                    claim.status = ClaimStatus::Reclaimed;
                }
            }
            require!(returned > 0, "NO_RECLAIMABLE_FUNDS");
            require!(returned == value.unclaimed.0, "CLAIM_TOTAL_MISMATCH");
            self.reserved = self
                .reserved
                .checked_sub(returned)
                .expect("RESERVATION_UNDERFLOW");
            value.reclaimed = U128(add(value.reclaimed.0, returned));
            value.unclaimed = U128(0);
            value.status = DistributionStatus::Closed;
            self.bump_epoch();
        }
        self.distributions
            .insert(distribution_id.clone(), value.clone());
        self.emit("distribution_reclaimed", json!({"distribution_id":distribution_id,"returned":value.reclaimed,"pending":value.pending}));
        value
    }
}
