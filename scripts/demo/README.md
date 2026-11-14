# Local recording workspace

This is an isolated recording fixture for Razor's actual interface. It is not a production payment adapter. Company records, people, prices and transfers are fictional. The browser carries a simulation marker, and transaction hashes are not fabricated.

Use Node.js 24.22.1 or later. Keep the existing Next.js UI running on port 3000, then run from the repository root:

```sh
npm run demo:local
```

Open `http://localhost:3400/app` for the company workspace and `http://localhost:3400/__demo` for recording controls. The proxy binds only to loopback. Do not expose it through a public tunnel or deploy it as the application server.

The sandbox uses a separate in-memory database, clears provider configuration before importing application handlers, and blocks external requests. It reads static application pages and assets from the local UI server; all `/api/` requests use the fixture's handlers and identities. It does not read `.env.local`, copy the real database, send email, call paid AI, connect a wallet or broadcast transactions.

## Recording sequence

1. Reset the story once in the controls page. Open the company dashboard as Alex.
2. In Treasury, choose ETH on Ethereum, enter `2.5`, add a reference and a compatible fictional refund address, and review the funding instructions. The fixture quotes 5,000 USDC at its fictional price. Click **Simulate this funding deposit** to credit that exact reviewed leg.
3. Switch to Maya or Leo in the controls page and reload the personal workspace. Maya receives USDC on Base with a USDC backup on Arbitrum. Leo receives ETH on Ethereum with a USDC backup on Base. Both also have a separate Harbor Labs profile.
4. Switch back to Alex. Open Payroll, review the 7,000 USDC run and approve it in the actual application screen. Open execution and click **Simulate payroll delivery**. The fixture requires the reviewed approval and unchanged receiving terms.
5. Switch to each receiver and open the matching payment. Maya's entitlement is 4,200 USDC. Leo's entitlement is 2,800 USDC, with a distinct 1.4 ETH receiving amount at the fixture price.
6. Open Business clearing, select Cash-backed rounds, expand the accepted invoices, select all three, use their common accepted window and calculate deposits and credits. The existing algorithm calculates 2,700 USDC of invoice liabilities and 600 USDC of net backing. This preview is not an executed escrow round.

Opening company balance is 28,450 USDC. The recorded funding raises it to 33,450. Payroll spends 7,000 principal plus 1 in simulated cost, leaving 26,449. A separate unknown transfer continues to reserve 2,152, leaving 24,297 available after payroll. Repeating settlement does not debit again. Resetting or restarting discards only the in-memory recording state.

The controls page also has a shortcut funding action: 3,000 USDC equivalent from ETH plus 2,000 USDC from Base. That shortcut is a different fixture from the single reviewed 2.5 ETH funding leg. Use one path per take, not both.

## Reset and focused verification

`GET /__demo/state` exposes current fictional company, payment, run and receiving-profile IDs for the capture scripts. IDs created by actual application handlers can change after reset; always resolve them again. Profile switching uses a browser cookie, so switch in the same browser used for the take and reload its application tab.

```sh
node --import tsx --test scripts/demo/sandbox.test.ts
```

The focused check covers isolation, identity separation, prior approval, funding amounts, reservation conservation, payout units, repeated execution and reset. It uses its own loopback port and in-memory database. No full application build or real financial verification is performed.

The asset catalog in `assets.json` is a recording fixture, not Razor's production asset source. The sandbox supplies fixed fictional prices. Production continues to use its actual catalog and quote checks. Known fictional counterparty labels and the simulation buttons are added only by this proxy; the production interface is unchanged.
