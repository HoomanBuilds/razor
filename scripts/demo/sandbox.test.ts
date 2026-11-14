import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';

const port = 3417;
const origin = `http://localhost:${port}`;

test('recording sandbox preserves financial state and blocks production boundaries', { timeout: 30000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/demo/server.ts'], { env: { ...process.env, RAZOR_DEMO_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', chunk => { log += chunk; });
  child.stderr.on('data', chunk => { log += chunk; });
  const call = async (path: string, body?: object, profile?: string) => {
    const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(profile ? { cookie: `razor_demo_profile=${profile}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const rawStatus = (path: string, host = `localhost:${port}`) => new Promise<number>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, headers: { host } }, res => { res.resume(); resolve(res.statusCode!); });
    req.on('error', reject); req.end();
  });
  try {
    for (let index = 0; !log.includes('"externalRequests":"blocked"'); index++) {
      if (child.exitCode !== null || index > 100) throw new Error(`Sandbox failed to start: ${log}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const start = (await call('/__demo/state')).body;
    const company = start.companies.northstar.id;
    assert.equal(start.fictional, true);
    assert.equal(start.noBroadcast, true);
    assert.equal(start.treasury.balance, '28450000000');
    assert.equal(start.treasury.reserved, '2152000000');
    assert.equal(start.clearing.totalEscrowRequired, '600000000');
    assert.equal(start.clearing.fullObligationValue, '2700000000');
    assert.equal((await call('/__demo/settle-payroll', {})).status, 500);
    assert.equal((await call(`/api/organizations/${company}/treasury`, undefined, 'maya')).status, 403);
    assert.equal((await call(`/api/organizations/${company}/treasury/sync`, {})).status, 403);
    assert.equal(await rawStatus('/__demo/state', 'attacker.invalid'), 403);
    assert.equal(await rawStatus('//attacker.invalid/api/auth/session'), 400);
    assert.equal(await rawStatus('/%61pi/auth/session'), 400);
    const approved = (await call('/__demo/approve-payroll', {})).body;
    assert.equal(approved.treasury.reserved, '9154000000');
    const funded = (await call('/__demo/fund', {})).body;
    assert.equal(funded.treasury.balance, '33450000000');
    assert.equal(funded.treasury.reserved, '9154000000');
    assert.equal((await call('/__demo/fund', {})).body.treasury.balance, funded.treasury.balance);
    const paid = (await call('/__demo/settle-payroll', {})).body;
    assert.equal(paid.treasury.balance, '26449000000');
    assert.equal(paid.treasury.reserved, '2152000000');
    assert.equal((await call('/__demo/settle-payroll', {})).body.treasury.balance, paid.treasury.balance);
    const leo = (await call(`/api/recipient-workspace/payments/${start.paymentIds.leo}`, undefined, 'leo')).body.payment;
    assert.equal(leo.status, 'paid');
    assert.equal(leo.delivered_amount, '2800000000');
    assert.equal(leo.attempts[0].confirmedOutputAtomic, '1400000000000000000');
    assert.equal(leo.attempts[0].destination_symbol, 'ETH');
    assert.equal(leo.attempts[0].destination_tx_hash, null);
    const held = (await call(`/api/organizations/${company}/payments/${start.heldPaymentId}`)).body.payment;
    assert.equal(held.status, 'unknown');
    assert.equal(held.delivered_amount, '0');
    assert.equal(held.reserved_amount, '2152000000');
    assert.equal((await call(`/api/recipient-workspace/payments/${start.paymentIds.maya}`, undefined, 'leo')).status, 404);
    const reset = (await call('/__demo/reset', {})).body;
    assert.equal(reset.treasury.balance, '28450000000');
    assert.equal(reset.payments.maya.status, 'draft');
    const assets = (await call('/api/assets')).body.tokens;
    const eth = assets.find((token: { symbol: string; blockchain: string }) => token.symbol === 'ETH' && token.blockchain === 'eth');
    const preview = (await call(`/api/organizations/${company}/funding`, { originAsset: eth.assetId, amount: '2500000000000000000', reference: 'RECORDING TEST' })).body;
    assert.equal(preview.expected_output, '5000000000');
    assert.equal(preview.deposit_address, 'SIMULATION ONLY - DO NOT SEND FUNDS');
    assert.equal((await call('/__demo/fund', { fundingId: preview.id })).body.treasury.balance, '33450000000');
    assert.equal((await call('/__demo/fund', { fundingId: preview.id })).body.treasury.balance, '33450000000');
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
});
