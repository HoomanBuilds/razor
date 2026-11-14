# Cash-backed company clearing

This optional mode settles accepted business invoices through canonical native NEAR USDC held by the clearing contract. Ordinary supported-asset payroll/payments and the existing debt-discharge mode remain separate. Employee wages and personal contractor payments cannot enter a business clearing round.

If A owes B 100 USDC and B owes A 70 USDC, both owners may consent to A depositing 30 USDC into round escrow and B receiving a fixed 30 USDC creditor right. Finalization retires both selected invoices, with 170 USDC of escrow-backed invoice discharge and zero residual payment drafts. The 170 USDC is invoice face value; the net funded principal is 30 USDC. Delivered token amounts come only from actual withdrawal callbacks.

## Exact consent and custody

A proposal binds the existing accepted invoice versions, participating company IDs, shared treasury identities, owners, policies, original net positions, token/network, funding deadline and fixed owner destinations. The existing limits remain eight companies, 32 obligations and a common window ending within 24 hours. Purely balanced cycles use the debt-discharge mode without positive cash funding. Legacy raw manifest bytes and their hashes remain unchanged.

Every company owner consents to the same exact manifest before a debtor can deposit. Original net debtor requirements and creditor rights are recomputed from invoice amounts onchain. All required deposits and every consent are necessary before finalization. Invoice approval, payment, replacement and concurrent-round application paths share the existing obligation locks. Direct owner-wallet or off-platform actions remain outside those application locks; this is not a claim of atomic control over unrelated contracts or bank transfers.

Funding uses `ft_transfer_call` from the frozen debtor owner wallet into the clearing contract, with the exact round, manifest, company and unique deposit ID. Shared treasury cash is never debited or credited by this path. A company can make up to eight accepted partial deposits. Acceptance is capped at the remaining exact debit; excess, invalid, late and duplicate submissions return through the token resolver. Source verification binds the canonical token call, final accepted event/record, used amount and any exact unused return. Balance differences or a wallet-reported hash alone do not prove acceptance.

## Finalization and financial records

After verified finalization, one database transaction retires the selected drafts, records the entire selected invoice face value in `bills.funded_clearing_amount` and immutable `clearing_funded_discharges`, and saves scoped creditor/refund positions. It creates no residual payout, delivered payroll amount, project revenue or shared treasury balance credit. `bills.setoff_amount` remains exclusively noncash debt discharge. Remaining invoice liability subtracts actual delivery, noncash setoff and funded discharge separately. A fully discharged invoice cannot acquire another installment, replacement payment, standing autopay instruction or purchase rematch.

The bill, recipient history, customer API/MCP, project reports and CSV exports show these categories separately. Company escrow positions expose only the authorized company's fixed destination, debit/credit, accepted deposits, available rights, pending transfer, completed withdrawal and proof reference. Invoice face-value discharge must not be added to escrow principal as another cash amount.

## Withdrawal, cancellation and recovery

Credit and refund withdrawals pay only the frozen owner destination and require its direct signature plus the expected next nonce. Available rights move to pending before the token call. A matching successful callback records paid; a definitive failure restores only the original available amount. Callback replay cannot spend or restore it twice. Unknown or missing callbacks remain held. No owner declaration, support message or timeout resets them, and there is no trusted reporter recovery path in this mode.

An unfinished revoked or expired round preserves depositor refund rights without finalizing invoice discharge. Expiry does not release a pending withdrawal. Refunds and credits have separate counters, with accepted principal conserved as available, pending or paid. Changed owners, policies or invoice state hold unsafe actions instead of silently redirecting a destination. Fixed owner-wallet rights survive company authority changes; reconcile them and plan their custody before changing business ownership.

A completely unsigned local proposal can be discarded for free, without configured NEAR services or a transaction. Transactional review-generation checks reject stale reviews after discard. Once registration signing starts or a source reference/unknown action exists, its identity and locks remain held until authoritative reconciliation, revocation or expiry. A missing round view cannot prove an initiated registration never executed. A cancellation of unknown registration can register its exact identity and revoke it together, with the displayed onchain storage/gas cost.

## Deployment and costs

Use a fresh clearing state-version-2 deployment alongside the current treasury state-version-3 deployment. There is no populated-state migration. The constructor is unchanged; cash mode additionally requires the platform owner to register clearing-contract USDC storage once and call `enable_cash` once with the selected network. Mainnet requires canonical native USDC and a null test token. Testnet requires the explicit configured test token. The unsigned deployment plan includes these optional setup descriptors and requires a live token storage quote before any spend.

Owner wallets pay transaction gas. Round registration includes an explicit non-refundable NEAR storage budget; recipient owner wallets may need a separate USDC storage registration. Each wallet review shows exact actions and attached deposits. No automatic sponsorship, bank service, cross-chain escrow withdrawal or zero-cost storage is promised. Existing supported-asset funding and primary/USDC-backup payouts continue through their ordinary workflows.

Current evidence is local source/service verification and compiled WASM execution in the official local NEAR runtime. Real owner signing, configured deployment, canonical-token funding/resolver outcomes and final creditor/refund delivery remain live evidence gates in the competitive checklist. Missing-callback recovery stays an explicit held-state limitation.
