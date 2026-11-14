import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Token } from '../../src/server/payments/intents';
import { getDb } from '../../src/server/db';
import { hashToken, encrypt } from '../../src/server/identity/crypto';
import { PERMISSIONS } from '../../src/server/identity/session';
import { getRecipient } from '../../src/server/identity/recipients';
import { createBill, createPayrollRun } from '../../src/server/business/service';
import { offerInvoice, acceptInvoice, shareInvoice } from '../../src/server/clearing/service';

export const stableId = (name: string) => {
  const hash = createHash('sha256').update(`razor-local-recording:${name}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
export const companies = {
  northstar: { id: stableId('northstar'), name: 'Northstar Studio', account: 'northstar.demo.near' },
  harbor: { id: stableId('harbor'), name: 'Harbor Labs', account: 'harbor.demo.near' },
  meridian: { id: stableId('meridian'), name: 'Meridian Creative', account: 'meridian.demo.near' },
};
export const identities = {
  owner: { id: stableId('owner'), name: 'Alex Morgan', email: 'alex@northstar.example' },
  maya: { id: stableId('maya'), name: 'Maya Chen', email: 'maya@northstar.example' },
  leo: { id: stableId('leo'), name: 'Leo Martins', email: 'leo@northstar.example' },
};
export type Profile = keyof typeof identities;
export const sessions = Object.fromEntries(Object.keys(identities).map(name => [name, `local-recording-${name}-${stableId(name)}`])) as Record<Profile, string>;
export const nearUsdc = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const access = (company = companies.northstar.id) => ({ userId: identities.owner.id, organizationId: company, permissions: PERMISSIONS });
export interface DemoSeed { runId: string; paymentIds: { maya: string; leo: string }; heldPaymentId: string; recipientIds: { maya: string; leo: string; mayaHarbor: string }; clearingLinkIds: string[]; startsAt: string; expiresAt: string }
export const stamp = () => new Date().toISOString();
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

export function insert(db: DatabaseSync, table: string, record: Record<string, string | number | null>) {
  const keys = Object.keys(record);
  db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(record));
}
export function activity(action: string, entity: string, details: object = {}, company = companies.northstar.id) {
  insert(getDb(), 'activity', { id: stableId(`${action}:${entity}:${Date.now()}`), organization_id: company, actor_id: identities.owner.id, action, entity_id: entity, details: JSON.stringify({ ...details, simulated: true }), created_at: stamp() });
}

export function seed(tokens: Token[]): DemoSeed {
  if (process.env.DATABASE_PATH !== ':memory:') throw new Error('Recording fixtures require an isolated in-memory database');
  const db = getDb();
  db.exec('PRAGMA foreign_keys = OFF');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name!='schema_migrations'").all() as { name: string }[];
  for (const table of tables) if (!table.name.startsWith('billing_')) db.exec(`DELETE FROM "${table.name}"`);
  db.exec('PRAGMA foreign_keys = ON');
  const now = stamp();
  for (const [profile, person] of Object.entries(identities)) {
    insert(db, 'users', { ...person, created_at: daysAgo(90) });
    insert(db, 'sessions', { id: stableId(`session:${profile}`), user_id: person.id, token_hash: hashToken(sessions[profile as Profile]), organization_id: profile === 'owner' ? companies.northstar.id : null, expires_at: new Date(Date.now() + 86400000).toISOString(), created_at: now });
  }
  for (const [name, company] of Object.entries(companies)) {
    insert(db, 'organizations', { id: company.id, name: company.name, timezone: 'America/New_York', settlement_asset: 'USDC', owner_id: identities.owner.id, near_network: 'mainnet', treasury_account_id: 'treasury.demo.near', created_at: daysAgo(90), updated_at: now });
    const role = stableId(`${name}:owner`);
    insert(db, 'organization_roles', { id: role, organization_id: company.id, name: 'Owner', permissions_json: JSON.stringify(PERMISSIONS), is_owner: 1, created_at: daysAgo(90) });
    insert(db, 'memberships', { organization_id: company.id, user_id: identities.owner.id, role_id: role, created_at: daysAgo(90) });
    insert(db, 'linked_wallets', { id: stableId(`wallet:${name}`), user_id: identities.owner.id, family: 'near', address: company.account, network: 'mainnet', label: `${company.name} owner`, created_at: daysAgo(90) });
    insert(db, 'treasury_config', { organization_id: company.id, near_account_id: 'treasury.demo.near', network: 'mainnet', token_contract: nearUsdc, architecture: 'shared_v1', company_id: `${company.id}:abcdef0123456789`, created_at: daysAgo(90) });
    insert(db, 'treasury_balances', { organization_id: company.id, balance: name === 'northstar' ? '28450000000' : '12400000000', reserved: '0', updated_at: now });
    insert(db, 'clearing_companies', { organization_id: company.id, owner_user_id: identities.owner.id, treasury_id: 'treasury.demo.near', owner_account_id: company.account, policy_version: '1', network: 'mainnet', token_contract: nearUsdc, created_at: now, updated_at: now });
  }
  const tokenFor = (symbol: string, network: string) => tokens.find(t => t.symbol === symbol && t.blockchain === network)!;
  function recipient(key: string, name: string, kind: string, network: string, symbol: string, company = companies.northstar.id, user: string | null = null, address?: string) {
    const id = stableId(key), primary = tokenFor(symbol, network);
    insert(db, 'recipients', { id, organization_id: company, user_id: user, name: encrypt(name), email: encrypt(`${key}@example.invalid`), kind, primary_asset: primary.assetId, primary_network: network, primary_address: address ?? `0x${createHash('sha256').update(key).digest('hex').slice(0, 40)}`, backup_network: 'base', backup_address: `0x${createHash('sha256').update(`backup:${key}`).digest('hex').slice(0, 40)}`, fallback_consent: network === 'base' && symbol === 'USDC' ? 0 : 1, preference_status: 'confirmed', confirmed_at: daysAgo(30), created_at: daysAgo(45), updated_at: now });
    if (network === 'base' && symbol === 'USDC') db.prepare("UPDATE recipients SET backup_network='arb',fallback_consent=1 WHERE id=?").run(id);
    insert(db, 'recipient_versions', { recipient_id: id, version: 1, profile_ciphertext: encrypt(JSON.stringify(getRecipient(company, id))), changed_by: user ?? identities.owner.id, created_at: daysAgo(30) });
    return id;
  }
  const maya = recipient('maya-payee', 'Maya Chen', 'employee', 'base', 'USDC', companies.northstar.id, identities.maya.id);
  const leo = recipient('leo-payee', 'Leo Martins', 'contractor', 'eth', 'ETH', companies.northstar.id, identities.leo.id);
  const nia = recipient('nia-payee', 'Nia Williams', 'employee', 'arb', 'USDC');
  const omar = recipient('omar-payee', 'Omar Hassan', 'contractor', 'sol', 'USDC', companies.northstar.id, null, '11111111111111111111111111111111');
  const mayaHarbor = recipient('maya-harbor', 'Maya Chen', 'contractor', 'base', 'USDC', companies.harbor.id, identities.maya.id);
  const leoHarbor = recipient('leo-harbor', 'Leo Martins', 'contractor', 'eth', 'ETH', companies.harbor.id, identities.leo.id);
  const businessRecipients = [
    recipient('harbor-payee', companies.harbor.name, 'business', 'near', 'USDC', companies.northstar.id, identities.owner.id, companies.harbor.account),
    recipient('meridian-payee', companies.meridian.name, 'business', 'near', 'USDC', companies.harbor.id, identities.owner.id, companies.meridian.account),
    recipient('northstar-payee', companies.northstar.name, 'business', 'near', 'USDC', companies.meridian.id, identities.owner.id, companies.northstar.account),
  ];
  for (let i = 0; i < 42; i++) {
    const payee = [maya, leo, nia, omar][i % 4], amount = String((500n + BigInt(i * 127 % 1900)) * 1000000n), date = daysAgo(1 + (41 - i) / 2), status = i % 11 === 0 ? 'draft' : i % 13 === 0 ? 'held' : 'paid';
    insert(db, 'payments', { id: stableId(`history:${i}`), organization_id: companies.northstar.id, recipient_id: payee, kind: i % 3 === 0 ? 'payroll' : 'contractor', reference: `NS-${String(1000 + i)}`, amount, max_fee: '1000000', status, recipient_version: 1, recipient_snapshot: JSON.stringify(getRecipient(companies.northstar.id, payee)), metadata: JSON.stringify({ simulated: true, displayReference: `NS-${String(1000 + i)}` }), delivered_amount: status === 'paid' ? amount : '0', total_spent: status === 'paid' ? String(BigInt(amount) + 400000n) : '0', hold_reason: status === 'held' ? 'Awaiting recipient review' : null, created_at: date, updated_at: date });
  }
  const heldPaymentId = stableId('history:13'), held = getRecipient(companies.northstar.id, leo);
  db.prepare("UPDATE payments SET status='unknown',reserved_amount='2152000000',hold_reason='Original transfer outcome is unknown. Reconcile this attempt before retrying or using a backup.',updated_at=? WHERE id=?").run(now, heldPaymentId);
  db.prepare("UPDATE treasury_balances SET reserved='2152000000' WHERE organization_id=?").run(companies.northstar.id);
  insert(db, 'payout_attempts', { id: stableId('uncertain-original-attempt'), payment_id: heldPaymentId, organization_id: companies.northstar.id, route: 'primary', state: 'unknown', quote: JSON.stringify({ simulated: true, quoteRequest: { deadline: daysAgo(1) }, quote: { amountIn: '2152000000', amountOut: '1075500000000000000', deadline: daysAgo(1) } }), destination_asset: held.primary_asset, destination_network: held.primary_network, destination_address: held.primary_address, destination_symbol: 'ETH', destination_decimals: 18, expected_output: '1075500000000000000', amount_in: '2152000000', deposit_address: 'DEMO-NO-DEPOSIT', provider_status: 'UNKNOWN', created_at: daysAgo(1), updated_at: now });
  insert(db, 'payments', { id: stableId('maya-harbor-history'), organization_id: companies.harbor.id, recipient_id: mayaHarbor, kind: 'contractor', reference: 'HARBOR-RETAINER', amount: '950000000', max_fee: '1000000', status: 'paid', recipient_version: 1, recipient_snapshot: JSON.stringify(getRecipient(companies.harbor.id, mayaHarbor)), delivered_amount: '950000000', total_spent: '950400000', created_at: daysAgo(5), updated_at: daysAgo(5) });
  insert(db, 'payments', { id: stableId('leo-harbor-history'), organization_id: companies.harbor.id, recipient_id: leoHarbor, kind: 'contractor', reference: 'HARBOR-ENGINEERING', amount: '1250000000', max_fee: '1000000', status: 'paid', recipient_version: 1, recipient_snapshot: JSON.stringify(getRecipient(companies.harbor.id, leoHarbor)), delivered_amount: '1250000000', total_spent: '1250600000', created_at: daysAgo(3), updated_at: daysAgo(3) });
  const run = createPayrollRun(access(), { reference: 'NOVEMBER TEAM PAY', periodStart: '2026-11-01', periodEnd: '2026-11-15', items: [{ recipientId: maya, amount: '4200000000', baseAmount: '4000000000', bonusAmount: '200000000', adjustmentAmount: '0', note: 'Product release bonus', maxFee: '1000000' }, { recipientId: leo, amount: '2800000000', maxFee: '1000000', note: 'November engineering retainer' }] });
  const startsAt = new Date(Date.now() - 3600000).toISOString(), expiresAt = new Date(Date.now() + 23 * 3600000).toISOString();
  const clearingLinkIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const debtor = Object.values(companies)[i], creditor = Object.values(companies)[(i + 1) % 3];
    const bill = createBill(access(debtor.id), { recipientId: businessRecipients[i], reference: `PARTNER-${i + 1}`, title: ['Platform integration', 'Brand and product design', 'Research services'][i], amount: ['1200000000', '900000000', '600000000'][i], maxFee: '1000000' });
    const offer = offerInvoice(access(debtor.id), { billId: bill.id, creditorId: creditor.id, startsAt, expiresAt });
    acceptInvoice(access(creditor.id), offer.id, offer.terms_hash);
    const third = Object.values(companies)[(i + 2) % 3].id;
    shareInvoice(access(debtor.id), offer.id, third);
    shareInvoice(access(creditor.id), offer.id, third);
    clearingLinkIds.push(offer.id);
  }
  for (let i = 0; i < 9; i++) {
    const bill = createBill(access(), { recipientId: [leo, businessRecipients[0], omar][i % 3], reference: `INV-2026-${400 + i}`, title: ['Engineering retainer', 'Infrastructure services', 'Product design sprint'][i % 3], amount: String(BigInt(450 + i * 150) * 1000000n), maxFee: '1000000', dueDate: new Date(Date.now() + (i + 1) * 86400000).toISOString(), lineItems: [{ description: 'Professional services', quantity: 1, unitPrice: 450 + i * 150 }] });
    if (i % 3) db.prepare("UPDATE payments SET status='paid',delivered_amount=amount,total_spent=amount WHERE id=?").run(bill.payment_id);
  }
  for (let i = 0; i < 12; i++) insert(db, 'activity', { id: stableId(`activity:${i}`), organization_id: companies.northstar.id, actor_id: identities.owner.id, action: ['payment.delivered', 'recipient.preferences_confirmed', 'payroll.approved', 'funding.credited'][i % 4], entity_id: stableId(`history:${i}`), details: JSON.stringify({ simulated: true, reference: `NS-${1000 + i}` }), created_at: daysAgo(i / 3) });
  const historicalSpend = (db.prepare("SELECT total_spent FROM payments WHERE organization_id=? AND status='paid'").all(companies.northstar.id) as { total_spent: string }[]).reduce((sum, payment) => sum + BigInt(payment.total_spent), 0n);
  const historicalFunding = 28450000000n + historicalSpend;
  for (const [index, amount] of [historicalFunding / 2n, historicalFunding - historicalFunding / 2n].entries()) {
    const token = tokenFor('USDC', index ? 'eth' : 'base'), date = daysAgo(35 - index);
    insert(db, 'funding_legs', { id: stableId(`opening-funding:${index}`), organization_id: companies.northstar.id, reference: ['OCTOBER OPERATING CAPITAL', 'NOVEMBER OPERATING CAPITAL'][index], origin_asset: token.assetId, origin_network: token.blockchain, origin_symbol: token.symbol, origin_decimals: token.decimals, amount_in: amount.toString(), expected_output: amount.toString(), credited_amount: amount.toString(), quote: JSON.stringify({ simulated: true, quoteRequest: { deadline: date }, quote: { amountIn: amount.toString(), amountOut: amount.toString() } }), deposit_address: 'DEMO-NO-DEPOSIT', recipient_address: 'treasury.demo.near', status: 'confirmed', provider_status: 'SIMULATED_DELIVERED', created_at: date, updated_at: date });
  }
  return { runId: run.id, paymentIds: { maya: run.items[0].payment_id!, leo: run.items[1].payment_id! }, heldPaymentId, recipientIds: { maya, leo, mayaHarbor }, clearingLinkIds, startsAt, expiresAt };
}
