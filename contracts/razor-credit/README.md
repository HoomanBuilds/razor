# Razor credit

State version 2 requires a fresh deployment. Earlier populated state cannot be migrated by deploying this artifact.

`get_native_reserve` separates current native NEAR balance, storage backing, protected unused loan-registration budgets and withdrawable excess. `withdraw_native_reserve({amount})` requires the stored platform owner and exactly one yoctoNEAR, and sends a positive amount only to that owner. It remains available while new credit activity is paused. It cannot withdraw USDC, release a loan bond, modify lender credits or resolve pending token transfers.

The first successful loan registration captures the existing storage baseline. Complete native registration deposits, including overpayment, remain protected as prepaid state capacity. Loan cancellation, repayment, default and failed token callbacks do not release this budget because their records remain stored. There is no registration-storage refund promise. Additional operating NEAR above the protected floor can be recovered; native code/state backing remains locked while that storage exists.

A failed native transfer is refunded by NEAR to the contract. Refresh the onchain balance before preparing another withdrawal; there is no synthetic callback credit or timeout reset.
