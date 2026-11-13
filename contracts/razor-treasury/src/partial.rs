use super::*;

#[near]
impl Treasury {
    pub fn report_partial_settlement(
        &mut self,
        payment_id: String,
        attempt_id: String,
        expected_quote_hash: String,
        actual_output: U128,
        credited_amount: U128,
        route_closed: bool,
        receipt: String,
    ) -> Payment {
        self.assert_reporter();
        validate_receipt(&receipt);
        require!(route_closed, "TERMINAL_ROUTE_CLOSURE_REQUIRED");
        require!(
            !self.partial_receipts.contains_key(&receipt),
            "SETTLEMENT_RECEIPT_REUSED"
        );
        let mut payment = self.load_payment(&payment_id);
        require!(
            matches!(
                payment.status,
                PaymentStatus::InFlight | PaymentStatus::RecoveryPending
            ),
            "PAYMENT_NOT_IN_FLIGHT"
        );
        require!(
            credited_amount.0 > 0 && credited_amount.0 < payment.amount.0,
            "INVALID_PARTIAL_ENTITLEMENT"
        );
        require!(payment.reservation.0 == 0, "RESERVATION_NOT_RELEASED");
        let attempt = last_attempt_mut(&mut payment, &attempt_id);
        require!(
            matches!(
                attempt.status,
                AttemptStatus::SourceSent | AttemptStatus::Uncertain | AttemptStatus::RefundPending
            ),
            "SOURCE_NOT_CONFIRMED"
        );
        require!(
            attempt.route.kind == RouteKind::Intents
                && attempt.route.quote_hash == expected_quote_hash,
            "PARTIAL_ROUTE_MISMATCH"
        );
        require!(
            actual_output.0 > 0 && actual_output.0 < attempt.route.output_amount.0,
            "INVALID_PARTIAL_OUTPUT"
        );
        require!(
            actual_output.0 >= attempt.actual_output.0,
            "OUTPUT_CANNOT_DECREASE"
        );
        if attempt.destination.network == "near"
            && attempt.destination.asset_id == format!("nep141:{}", self.token_contract)
        {
            require!(actual_output == credited_amount, "USDC_CREDIT_MISMATCH");
        }
        attempt.status = AttemptStatus::PartiallyDelivered;
        attempt.actual_output = actual_output;
        attempt.credited_amount = credited_amount;
        attempt.receipt = Some(receipt.clone());
        payment.status = PaymentStatus::PartiallyPaid;
        self.finish_unsettled_payment();
        self.partial_receipts
            .insert(receipt.clone(), format!("{}:{}", payment_id, attempt_id));
        self.payments.insert(payment_id.clone(), payment.clone());
        emit(
            "partial_settlement_reported",
            json!({"payment_id":payment_id,"attempt_id":attempt_id,"quote_hash":expected_quote_hash,"actual_output":actual_output,"credited_amount":credited_amount,"route_closed":true,"receipt":receipt,"reporter":env::predecessor_account_id()}),
        );
        payment
    }
}
