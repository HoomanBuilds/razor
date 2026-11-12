export interface Organization { id: string; name: string; timezone: string; role: string; paused?: number; settlement_asset: string; permissions?: string[] }
export interface Session { user: { id: string; email: string | null; name: string | null }; organizations: Organization[]; activeOrganizationId: string | null; wallets: Wallet[] }
export interface Wallet { id: string; family: string; address: string; network: string; label: string | null }
export interface Recipient { id: string; name: string; email: string | null; kind: string; primary_asset: string; primary_network: string; primary_address: string; backup_network: string | null; backup_address: string | null; fallback_consent: number; version: number }
export interface Payment { id: string; recipient_id: string; kind: string; reference: string; amount: string; max_fee: string; status: string; scheduled_for: string | null; hold_reason: string | null; created_at: string; delivered_amount: string }
export interface Treasury { balance: string; reserved: string; available: string; lastSyncedAt: string | null; config: { near_account_id: string; network: string; token_contract: string } | null }
export interface Token { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number; contractAddress?: string }
export interface Bill { id: string; recipient_id: string; reference: string; title: string; amount: string; max_fee: string; due_date: string | null; status: string; payment: Payment | null }
export interface PayrollItem { id: string; recipient_id: string; amount: string; max_fee: string; payment: Payment | null }
export interface PayrollRun { id: string; reference: string; period_start: string; period_end: string; status: string; total: string; maxFees: string; scheduled_for: string | null; items: PayrollItem[] }
export type Section = "overview" | "payments" | "payroll" | "bills" | "recipients" | "treasury" | "assistant" | "activity" | "settings";
