import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import type { Token } from '../../src/server/payments/intents';

const port = Number(process.env.RAZOR_DEMO_PORT || 3400);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use an unprivileged local demo port');
const origin = `http://localhost:${port}`;
for (const name of Object.keys(process.env)) if (/^(NEAR_|NEXT_PUBLIC_|PRIVY_|RESEND_|RAZOR_|DATABASE_|DATA_ENCRYPTION|ACCOUNTING_|XERO_|QUICKBOOKS_|NETSUITE_)/.test(name)) delete process.env[name];
Object.assign(process.env, { DATABASE_PATH: ':memory:', DATA_ENCRYPTION_KEY: 'da'.repeat(32), APP_URL: origin, NEAR_NETWORK: 'mainnet', RAZOR_BILLING_MODE: 'pilot', NEAR_TREASURY_ID: 'treasury.demo.near', NEAR_CLEARING_ID: 'clearing.demo.near', NEAR_TREASURY_CODE_HASH: '11111111111111111111111111111111', NEAR_CLEARING_CODE_HASH: '11111111111111111111111111111111' });
process.env.NEAR_CONTRACT_UPGRADE_POLICY = 'owner_controlled';
process.env.NEAR_CONTRACT_UPGRADE_KEYS = JSON.stringify({ 'treasury.demo.near': ['ed25519:11111111111111111111111111111111'], 'clearing.demo.near': ['ed25519:11111111111111111111111111111111'] });
const prices: Record<string, number> = { USDC: 1, USDT: 1, ETH: 2000, NEAR: 5, SOL: 100 };
const tokens = (JSON.parse(readFileSync(new URL('./assets.json', import.meta.url), 'utf8')) as Token[]).map(token => ({ ...token, price: prices[token.symbol], priceUpdatedAt: new Date().toISOString() }));
const upstreamFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === '1click.chaindefuser.com' && url.pathname.endsWith('/tokens')) return Response.json(tokens);
  throw new Error(`Recording sandbox blocked external request to ${url.hostname}`);
};
const { app } = await import('../../src/server/app');
const { getDb } = await import('../../src/server/db');
const { companies, identities, sessions, seed, access, activity, insert, stableId, stamp } = await import('./seed');
const { getPayment, getTreasury } = await import('../../src/server/payments/service');
const { getRecipient } = await import('../../src/server/identity/recipients');
const { getAccess } = await import('../../src/server/identity/session');
const { payrollPreview, approveReviewedPayrollRun } = await import('../../src/server/payment-management/service');
const { executionOverview } = await import('../../src/server/payroll-execution/service');
const { previewFundedRound } = await import('../../src/server/clearing/funded');
let scenario = seed(tokens);
let funded = false;
let settled = false;
let lastFundingId: string | null = null;
const db = getDb();
const state = () => ({ fictional: true, noBroadcast: true, origin, companies, profiles: identities, ...scenario, funded, settled, lastFundingId, treasury: getTreasury(access()), payments: Object.fromEntries(Object.entries(scenario.paymentIds).map(([name, id]) => [name, getPayment(access(), id)])), clearing: previewFundedRound(access(), { linkIds: scenario.clearingLinkIds, startsAt: scenario.startsAt, expiresAt: scenario.expiresAt }) });

function previewFunding(input: { originAsset: string; amount: string; reference: string }) {
  const token = tokens.find(value => value.assetId === input.originAsset);
  if (!token || !/^[1-9]\d{0,29}$/.test(input.amount) || !input.reference?.trim()) throw new Error('Choose a supported demo asset and positive source amount');
  const output = BigInt(input.amount) * BigInt(prices[token.symbol]) * 1000000n / (10n ** BigInt(token.decimals));
  if (output <= 0n || output > 1000000000000n) throw new Error('Use a demo funding value between one microUSDC and one million USDC');
  const id = stableId(`preview:${Date.now()}`), deadline = new Date(Date.now() + 3600000).toISOString();
  insert(db, 'funding_legs', { id, organization_id: companies.northstar.id, reference: input.reference, origin_asset: token.assetId, origin_network: token.blockchain, origin_symbol: token.symbol, origin_decimals: token.decimals, amount_in: input.amount, expected_output: output.toString(), quote: JSON.stringify({ simulated: true, quoteRequest: { deadline }, quote: { amountIn: input.amount, amountOut: output.toString(), deadline } }), deposit_address: 'SIMULATION ONLY - DO NOT SEND FUNDS', recipient_address: 'treasury.demo.near', status: 'pending_deposit', created_at: stamp(), updated_at: stamp() });
  lastFundingId = id;
  return db.prepare('SELECT * FROM funding_legs WHERE id=?').get(id);
}
function settleFunding(id: string) {
  const leg = db.prepare('SELECT * FROM funding_legs WHERE id=? AND organization_id=?').get(id, companies.northstar.id) as { status: string; expected_output: string } | undefined;
  if (!leg) throw new Error('Review a demo funding instruction first');
  if (leg.status === 'confirmed') return state();
  if (leg.status !== 'pending_deposit') throw new Error('This demo funding leg is not awaiting simulation');
  db.exec('BEGIN');
  try {
    const current = db.prepare('SELECT balance,reserved FROM treasury_balances WHERE organization_id=?').get(companies.northstar.id) as { balance: string; reserved: string };
    const after = (BigInt(current.balance) + BigInt(leg.expected_output)).toString();
    db.prepare('UPDATE treasury_balances SET balance=?,updated_at=? WHERE organization_id=?').run(after, stamp(), companies.northstar.id);
    db.prepare("UPDATE funding_legs SET status='confirmed',credited_amount=expected_output,provider_status='SIMULATED_DELIVERED',updated_at=? WHERE id=?").run(stamp(), id);
    insert(db, 'treasury_ledger', { id: stableId(`funding-ledger:${id}`), organization_id: companies.northstar.id, reference: `demo:${id}`, entry_type: 'funding', amount: leg.expected_output, balance_after: after, reserved_after: current.reserved, metadata: JSON.stringify({ simulated: true }), created_at: stamp() });
    activity('funding.credited', id, { amount: leg.expected_output }); db.exec('COMMIT'); funded = true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return state();
}

function fund() {
  if (funded) return state();
  db.exec('BEGIN');
  try {
    const current = db.prepare('SELECT balance,reserved FROM treasury_balances WHERE organization_id=?').get(companies.northstar.id) as { balance: string; reserved: string };
    const after = (BigInt(current.balance) + 5000000000n).toString();
    db.prepare('UPDATE treasury_balances SET balance=?,updated_at=? WHERE organization_id=?').run(after, stamp(), companies.northstar.id);
    insert(db, 'treasury_ledger', { id: stableId('funding-ledger'), organization_id: companies.northstar.id, reference: 'DEMO-MULTI-ASSET-FUNDING', entry_type: 'funding', amount: '5000000000', balance_after: after, reserved_after: current.reserved, metadata: JSON.stringify({ simulated: true }), created_at: stamp() });
    for (const [network, symbol, amountIn, output] of [['eth', 'ETH', '1500000000000000000', '3000000000'], ['base', 'USDC', '2000000000', '2000000000']]) {
      const token = tokens.find(value => value.blockchain === network && value.symbol === symbol)!;
      insert(db, 'funding_legs', { id: stableId(`funding:${network}`), organization_id: companies.northstar.id, reference: `NOVEMBER TOP-UP ${symbol}`, origin_asset: token.assetId, origin_network: network, origin_symbol: symbol, origin_decimals: token.decimals, amount_in: amountIn, expected_output: output, quote: JSON.stringify({ simulated: true, quoteRequest: { deadline: stamp() }, quote: { amountIn, amountOut: output } }), deposit_address: 'DEMO-NO-DEPOSIT', recipient_address: 'treasury.demo.near', status: 'confirmed', provider_status: 'SIMULATED_DELIVERED', credited_amount: output, created_at: stamp(), updated_at: stamp() });
    }
    activity('funding.credited', stableId('funding-ledger'), { amount: '5000000000', sourceAssets: ['ETH on Ethereum', 'USDC on Base'] });
    db.exec('COMMIT'); funded = true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return state();
}
function settle() {
  if (settled) return state();
  const run = db.prepare('SELECT status FROM payroll_runs WHERE id=?').get(scenario.runId) as { status: string };
  if (run.status !== 'approved') throw new Error('Approve this demo payroll before simulating delivery');
  db.exec('BEGIN');
  try {
    let spent = 0n, released = 0n;
    for (const [name, id] of Object.entries(scenario.paymentIds)) {
      const payment = getPayment(access(), id), payee = getRecipient(companies.northstar.id, payment.recipient_id);
      if (payment.status !== 'ready' && payment.status !== 'approved' && payment.status !== 'approved_unfunded') throw new Error('Only the selected approved demo payroll can settle');
      const fee = name === 'maya' ? 400000n : 600000n, total = BigInt(payment.amount) + fee;
      const snapshot = JSON.parse(payment.recipient_snapshot);
      const asset = tokens.find(value => value.symbol === (name === 'maya' ? 'USDC' : 'ETH') && value.blockchain === (name === 'maya' ? 'base' : 'eth'))!;
      if (payee.version !== payment.recipient_version || snapshot.primary_asset !== asset.assetId || payee.primary_asset !== snapshot.primary_asset || payee.primary_network !== snapshot.primary_network || payee.primary_address !== snapshot.primary_address || fee > BigInt(payment.max_fee)) throw new Error('The demo payment route or fee changed. Reset and review its exact terms.');
      released += BigInt(payment.reserved_amount);
      const attempt = stableId(`${name}-payroll-attempt`), output = name === 'maya' ? payment.amount : '1400000000000000000';
      insert(db, 'payout_attempts', { id: attempt, payment_id: id, organization_id: companies.northstar.id, route: 'primary', state: 'delivered', quote: JSON.stringify({ simulated: true, quote: { amountIn: total.toString(), amountOut: output } }), destination_asset: payee.primary_asset, destination_network: payee.primary_network, destination_address: payee.primary_address, destination_symbol: name === 'maya' ? 'USDC' : 'ETH', destination_decimals: name === 'maya' ? 6 : 18, expected_output: output, amount_in: total.toString(), deposit_address: 'DEMO-NO-DEPOSIT', provider_status: 'SIMULATED_DELIVERED', reconciliation: JSON.stringify({ simulated: true, chain: { attempts: [{ id: attempt, actual_output: output }] } }), created_at: stamp(), updated_at: stamp() });
      db.prepare("UPDATE payments SET status='paid',delivered_amount=amount,total_spent=?,reserved_amount='0',chain_reserved='0',updated_at=? WHERE id=?").run(total.toString(), stamp(), id);
      activity('payment.delivered', id, { amount: payment.amount, asset: name === 'maya' ? 'USDC' : 'ETH', output });
      spent += total;
    }
    const current = db.prepare('SELECT balance,reserved FROM treasury_balances WHERE organization_id=?').get(companies.northstar.id) as { balance: string; reserved: string };
    if (BigInt(current.balance) < spent) throw new Error('Demo treasury cannot overspend');
    const after = (BigInt(current.balance) - spent).toString();
    if (BigInt(current.reserved) < released) throw new Error('The approved demo reservation changed');
    const remainingReserved = BigInt(current.reserved) - released;
    if (BigInt(after) < remainingReserved) throw new Error('Other demo payments retain their protected reservations');
    db.prepare('UPDATE treasury_balances SET balance=?,reserved=?,updated_at=? WHERE organization_id=?').run(after, remainingReserved.toString(), stamp(), companies.northstar.id);
    insert(db, 'treasury_ledger', { id: stableId('payroll-ledger'), organization_id: companies.northstar.id, reference: 'DEMO-NOVEMBER-PAYROLL', entry_type: 'payment', amount: (-spent).toString(), balance_after: after, reserved_after: remainingReserved.toString(), metadata: JSON.stringify({ simulated: true }), created_at: stamp() });
    db.exec('COMMIT'); settled = true;
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return state();
}
const allowedWrite = (path: string) => /^\/api\/organizations\/[^/]+\/(?:select|payments|recipients|payroll|bills)$/.test(path)
  || /^\/api\/organizations\/[^/]+\/(?:recipients\/[^/]+|payroll\/[^/]+\/approve|payment-management\/payroll\/[^/]+\/(?:review|approve)|clearing\/(?:rounds\/preview|funded\/preview|invoices\/[^/]+\/(?:accept|share)))$/.test(path)
  || /^\/api\/recipient-workspace\/profiles\/[^/]+\/confirm$/.test(path);
const marker = `<script>(()=>{window.addEventListener('DOMContentLoaded',()=>{const badge=document.createElement('a');badge.id='razor-demo-environment';badge.href='/__demo';badge.target='_blank';badge.textContent='Demo environment · Simulated transfers';badge.style.cssText='position:fixed;bottom:10px;left:96px;z-index:9999;font:11px/1.4 Arial,sans-serif;background:#f1f4ff;color:#405086;border:1px solid #dce3fa;border-radius:20px;padding:6px 12px;text-decoration:none';document.body.append(badge);const names=${JSON.stringify(Object.values(companies).map(company => ({ id: company.id, name: company.name })))};const label=()=>{for(const company of names)for(const node of document.querySelectorAll('span[title="'+company.id+'"]'))if(node.textContent==='Company '+company.id.slice(0,8))node.textContent=company.name};new MutationObserver(label).observe(document.body,{childList:true,subtree:true});label()})})();</script><script src="/__demo/client.js" defer></script>`;
const controls = `<!doctype html><html><head><title>Razor recording controls</title><style>body{font:15px Arial;background:#f6f7fb;color:#10131f;max-width:840px;margin:60px auto}button,a{display:inline-block;padding:12px 18px;border:0;border-radius:12px;background:#1748ff;color:white;margin:6px;text-decoration:none;cursor:pointer}pre{white-space:pre-wrap;background:white;padding:24px;border-radius:20px}h1{font-weight:500}</style></head><body><h1>Razor recording controls</h1><p>Local fictional data only. No blockchain transaction, wallet signature, email or paid AI request can be sent.</p><div><button onclick="change('reset')">Reset story</button><button onclick="change('fund')">Simulate 5,000 USDC funding</button><button onclick="change('approve-payroll')">Approve payroll</button><button onclick="change('settle-payroll')">Simulate payroll delivery</button></div><div><button onclick="profile('owner')">Alex: company owner</button><button onclick="profile('maya')">Maya: receiving account</button><button onclick="profile('leo')">Leo: receiving account</button></div><a href='/app?company=${companies.northstar.id}&section=overview' target='_blank'>Open company dashboard</a><a href='/receive?view=payments' target='_blank'>Open receiver dashboard</a><pre id='status'>Ready.</pre><script>async function change(action,body={}){const r=await fetch('/__demo/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const d=await r.json();document.getElementById('status').textContent=JSON.stringify(d,null,2);return d}async function profile(profile){await change('profile',{profile})}</script></body></html>`;

const server = createServer(async (req, res) => {
  try {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '') || ![`localhost:${port}`, `127.0.0.1:${port}`].includes(req.headers.host || '')) { res.writeHead(403); res.end('Loopback demo only'); return; }
    const url = new URL(req.url || '/', origin), method = req.method || 'GET';
    if (url.origin !== origin || url.pathname.startsWith('//') || url.pathname.includes('%')) { res.writeHead(400); res.end('Use an ordinary local demo path'); return; }
    if (!['GET', 'HEAD'].includes(method) && req.headers.origin && req.headers.origin !== origin && req.headers.origin !== `http://127.0.0.1:${port}`) { res.writeHead(403); res.end('Origin rejected'); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1_048_576) throw new Error('Request too large'); chunks.push(chunk); }
    const body = Buffer.concat(chunks).toString();
    const send = async (response: Response) => {
      const headers = Object.fromEntries(response.headers.entries()); delete headers['set-cookie'];
      res.writeHead(response.status, { ...headers, 'cache-control': 'no-store', 'x-razor-demo': 'simulated-no-broadcast' }); res.end(Buffer.from(await response.arrayBuffer()));
    };
    if (url.pathname === '/__demo') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(controls); return; }
    if (url.pathname === '/__demo/client.js' && method === 'GET') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }); res.end(readFileSync(new URL('./client.js', import.meta.url))); return; }
    if (url.pathname === '/__demo/state' && method === 'GET') { await send(Response.json(state())); return; }
    if (url.pathname.startsWith('/__demo/') && method === 'POST') {
      const action = url.pathname.slice(8);
      if (action === 'profile') {
        const profile = JSON.parse(body).profile;
        if (!Object.hasOwn(identities, profile)) throw new Error('Unknown demo profile');
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `razor_demo_profile=${profile}; Path=/; SameSite=Strict; HttpOnly`, 'cache-control': 'no-store' }); res.end(JSON.stringify({ profile, fictional: true })); return;
      }
      if (action === 'reset') { scenario = seed(tokens); funded = false; settled = false; lastFundingId = null; }
      else if (action === 'fund') { const id = body ? JSON.parse(body).fundingId : null; if (id) settleFunding(id); else fund(); }
      else if (action === 'approve-payroll') { const review = await payrollPreview(access(), scenario.runId); approveReviewedPayrollRun(access(), scenario.runId, review.reviewToken); }
      else if (action === 'settle-payroll') settle();
      else throw new Error('Unknown demo control');
      await send(Response.json(state())); return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/assets' || url.pathname.endsWith('/funding-assets')) { await send(Response.json({ tokens, routingCatalogAvailable: true, simulated: true })); return; }
      const profileName = /(?:^|;\s*)razor_demo_profile=(owner|maya|leo)(?:;|$)/.exec(req.headers.cookie || '')?.[1] || 'owner';
      const organizationId = /^\/api\/organizations\/([^/]+)\//.exec(url.pathname)?.[1];
      if (organizationId) getAccess(identities[profileName as keyof typeof identities].id, organizationId);
      if (method === 'POST' && organizationId === companies.northstar.id && url.pathname.endsWith('/funding')) { await send(Response.json(previewFunding(JSON.parse(body)), { status: 201 })); return; }
      if (method === 'GET' && organizationId && url.pathname.endsWith('/onboarding/config')) { await send(Response.json({ ready: false, network: 'mainnet', treasuryId: 'treasury.demo.near', verifiedWallets: [], reason: 'Treasury registration is disabled in this local recording environment.', simulated: true })); return; }
      if (method === 'GET' && organizationId && (url.pathname.endsWith('/treasury-policy/storage') || url.pathname.endsWith('/retained-assets'))) { await send(Response.json({ configured: false, simulated: true })); return; }
      if (method === 'GET' && organizationId === companies.northstar.id && url.pathname.endsWith(`/payments/${scenario.heldPaymentId}/recovery`)) {
        const payment = getPayment(access(), scenario.heldPaymentId), attempt = db.prepare('SELECT * FROM payout_attempts WHERE payment_id=?').get(scenario.heldPaymentId);
        await send(Response.json({ available: true, payment, attempt, network: 'mainnet', treasuryAccount: 'treasury.demo.near', chainState: 'uncertain', ownerAccounts: [], reporterAccounts: [], refundAccounts: [], sourceRecoveryAccounts: [], executorAccounts: [], providerStatus: 'UNKNOWN', canRecoverSource: false, canReport: false, canReportDelivery: false, canReportRefund: false, canConfirmRefund: false, canClose: false, hasObservedDelivery: false, requiresPlatformRecovery: true, refundReporter: null, message: 'The original outcome is unknown. This obligation remains held; no retry or USDC backup is authorized until this same attempt is reconciled.', simulated: true })); return;
      }
      if (method === 'GET' && organizationId === companies.northstar.id && url.pathname.endsWith(`/payroll/${scenario.runId}/execution`)) {
        const disabled = async () => { throw new Error('No wallet execution exists in this recording environment'); };
        const result = await executionOverview(access(), scenario.runId, { tokens: async () => tokens, authority: async () => ({ policyVersion: '1', paused: false, signerAccounts: [companies.northstar.account], approvalAccounts: [companies.northstar.account] }), quote: disabled, resume: disabled, approval: disabled, reconcile: disabled, close: disabled, receipt: disabled });
        await send(Response.json({ ...result, simulated: true })); return;
      }
      if (!['GET', 'HEAD'].includes(method) && !allowedWrite(url.pathname)) { await send(Response.json({ error: 'This recording environment cannot send money or call external providers. Use the local recording controls for simulated transitions.', code: 'DEMO_EXTERNAL_ACTION_DISABLED' }, { status: 403 })); return; }
      const response = await app.request(url.href, { method, headers: { 'content-type': req.headers['content-type'] || 'application/json', origin, cookie: `razor_session=${sessions[profileName as keyof typeof sessions]}` }, ...(!['GET', 'HEAD'].includes(method) ? { body } : {}) });
      await send(response); return;
    }
    if (!['GET', 'HEAD'].includes(method)) { res.writeHead(405); res.end('Static UI only'); return; }
    const upstream = new URL('http://127.0.0.1:3000'); upstream.pathname = url.pathname; upstream.search = url.search;
    const response = await upstreamFetch(upstream, { redirect: 'manual', headers: { accept: req.headers.accept || '*/*' }, signal: AbortSignal.timeout(20000) });
    const headers = Object.fromEntries(response.headers.entries());
    for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']) delete headers[name];
    headers['cache-control'] = 'no-store';
    headers['content-security-policy'] = "connect-src 'self'; frame-src 'none'; object-src 'none'; form-action 'self'";
    if (headers.location?.startsWith('http://127.0.0.1:3000')) headers.location = headers.location.replace('http://127.0.0.1:3000', origin);
    const data = headers['content-type']?.includes('text/html') ? Buffer.from((await response.text()).replace('</body>', `${marker}</body>`)) : Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, headers); res.end(data);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    const status = typeof (error as { status?: number }).status === 'number' ? (error as { status: number }).status : 500;
    if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Local demo failed', simulated: true }));
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ origin, controls: `${origin}/__demo`, company: companies.northstar.id, scenario, simulated: true, database: ':memory:', externalRequests: 'blocked' })));
