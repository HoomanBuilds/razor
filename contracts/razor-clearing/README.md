# Razor clearing

State version 3 requires a fresh deployment. Earlier populated state cannot be migrated by deploying this artifact.

`get_native_reserve` separates current native NEAR balance, storage backing, protected unused registration budgets and withdrawable excess. `withdraw_native_reserve({amount})` requires the stored platform owner and exactly one yoctoNEAR, and sends a positive amount only to that owner. It remains available while clearing is paused. It cannot withdraw USDC or change creditor, debtor or pending-transfer rights.

The first successful round registration captures the existing storage baseline. Every complete native registration deposit, including overpayment, remains protected alongside that baseline as prepaid state capacity. Rejected, expired and revoked rounds keep this protection because their records remain stored. There is no registration-storage refund promise. Additional operating NEAR above this floor can be recovered. Native storage backing remains locked while the corresponding code and state exist.

A failed native transfer is refunded by NEAR to the contract. Refresh the onchain balance before preparing another withdrawal; there is no synthetic callback credit or timeout reset.
