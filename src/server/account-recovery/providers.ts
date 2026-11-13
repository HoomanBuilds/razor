export const OWNER_WALLET_PROVIDERS = [
  {id:"near-mobile",name:"NEAR Mobile",networks:["mainnet"],creationUrl:"https://www.nearmobile.app/what-is-near-mobile",recoveryUrl:"https://www.nearmobile.app/blog/near-mobile-4-1-post-quantum-vaults",custody:"The wallet provider documents self-custodial Google, Apple ID and email account creation. Choose a regular NEAR account and complete the provider's recovery setup.",recovery:"Supported social accounts use the provider's onchain recovery. Keep access to the selected identity and follow its account-specific backup instructions. Razor does not operate that recovery service."},
  {id:"meteor-wallet",name:"Meteor Wallet",networks:["mainnet","testnet"],creationUrl:"https://wallet.meteorwallet.app/",recoveryUrl:"https://docs.meteorwallet.app/wallet-settings/easy-recovery-for-seed-phrases-and-private-key",custody:"Create a new self-custodial wallet in the provider. It generates your recovery phrase; an existing seed is not required.",recovery:"Back up the recovery phrase in the wallet provider. Its password alone is not a recovery backup. Manage and rotate full-access keys in the provider's Security and Recovery settings."},
] as const;

export function ownerWalletProviders(network:string) {
  const providers=OWNER_WALLET_PROVIDERS.filter(provider=>(provider.networks as readonly string[]).includes(network));
  const preferred=process.env.NEAR_OWNER_WALLET_PROVIDER;
  return {providers,preferredProvider:providers.find(provider=>provider.id===preferred)?.id || providers[0]?.id || null};
}
