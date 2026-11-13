import type { ComponentType, SVGProps } from "react";
import { Coins, Globe } from "lucide-react";
import TokenUSDC from "@web3icons/react/icons/tokens/TokenUSDC";
import TokenUSDT from "@web3icons/react/icons/tokens/TokenUSDT";
import TokenDAI from "@web3icons/react/icons/tokens/TokenDAI";
import TokenEURC from "@web3icons/react/icons/tokens/TokenEURC";
import TokenETH from "@web3icons/react/icons/tokens/TokenETH";
import TokenBTC from "@web3icons/react/icons/tokens/TokenBTC";
import TokenWBTC from "@web3icons/react/icons/tokens/TokenWBTC";
import TokenNEAR from "@web3icons/react/icons/tokens/TokenNEAR";
import TokenSOL from "@web3icons/react/icons/tokens/TokenSOL";
import TokenBNB from "@web3icons/react/icons/tokens/TokenBNB";
import TokenAVAX from "@web3icons/react/icons/tokens/TokenAVAX";
import TokenTRX from "@web3icons/react/icons/tokens/TokenTRX";
import TokenXRP from "@web3icons/react/icons/tokens/TokenXRP";
import TokenDOGE from "@web3icons/react/icons/tokens/TokenDOGE";
import TokenLTC from "@web3icons/react/icons/tokens/TokenLTC";
import TokenBCH from "@web3icons/react/icons/tokens/TokenBCH";
import TokenZEC from "@web3icons/react/icons/tokens/TokenZEC";
import TokenADA from "@web3icons/react/icons/tokens/TokenADA";
import TokenSUI from "@web3icons/react/icons/tokens/TokenSUI";
import TokenAPT from "@web3icons/react/icons/tokens/TokenAPT";
import TokenTON from "@web3icons/react/icons/tokens/TokenTON";
import TokenXLM from "@web3icons/react/icons/tokens/TokenXLM";
import TokenLINK from "@web3icons/react/icons/tokens/TokenLINK";
import TokenUNI from "@web3icons/react/icons/tokens/TokenUNI";
import TokenAAVE from "@web3icons/react/icons/tokens/TokenAAVE";
import TokenARB from "@web3icons/react/icons/tokens/TokenARB";
import TokenOP from "@web3icons/react/icons/tokens/TokenOP";
import TokenSHIB from "@web3icons/react/icons/tokens/TokenSHIB";
import TokenPEPE from "@web3icons/react/icons/tokens/TokenPEPE";
import NetworkNearProtocol from "@web3icons/react/icons/networks/NetworkNearProtocol";
import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkArbitrumOne from "@web3icons/react/icons/networks/NetworkArbitrumOne";
import NetworkPolygon from "@web3icons/react/icons/networks/NetworkPolygon";
import NetworkSolana from "@web3icons/react/icons/networks/NetworkSolana";
import NetworkOptimism from "@web3icons/react/icons/networks/NetworkOptimism";
import NetworkBitcoin from "@web3icons/react/icons/networks/NetworkBitcoin";
import NetworkBinanceSmartChain from "@web3icons/react/icons/networks/NetworkBinanceSmartChain";
import NetworkAvalanche from "@web3icons/react/icons/networks/NetworkAvalanche";
import NetworkAurora from "@web3icons/react/icons/networks/NetworkAurora";
import NetworkTron from "@web3icons/react/icons/networks/NetworkTron";
import NetworkTon from "@web3icons/react/icons/networks/NetworkTon";
import NetworkAptos from "@web3icons/react/icons/networks/NetworkAptos";
import NetworkSui from "@web3icons/react/icons/networks/NetworkSui";
import NetworkDogecoin from "@web3icons/react/icons/networks/NetworkDogecoin";
import NetworkLitecoin from "@web3icons/react/icons/networks/NetworkLitecoin";
import NetworkBitcoinCash from "@web3icons/react/icons/networks/NetworkBitcoinCash";
import NetworkZcash from "@web3icons/react/icons/networks/NetworkZcash";
import NetworkXrp from "@web3icons/react/icons/networks/NetworkXrp";
import NetworkStellar from "@web3icons/react/icons/networks/NetworkStellar";
import NetworkCardano from "@web3icons/react/icons/networks/NetworkCardano";
import NetworkLinea from "@web3icons/react/icons/networks/NetworkLinea";
import NetworkMantle from "@web3icons/react/icons/networks/NetworkMantle";
import NetworkBlast from "@web3icons/react/icons/networks/NetworkBlast";
import NetworkCelo from "@web3icons/react/icons/networks/NetworkCelo";
import NetworkZksync from "@web3icons/react/icons/networks/NetworkZksync";
import NetworkAbstract from "@web3icons/react/icons/networks/NetworkAbstract";
import NetworkGnosis from "@web3icons/react/icons/networks/NetworkGnosis";
import NetworkBerachain from "@web3icons/react/icons/networks/NetworkBerachain";
import TokenHYPE from "@web3icons/react/icons/tokens/TokenHYPE";
import TokenMON from "@web3icons/react/icons/tokens/TokenMON";
import TokenPOL from "@web3icons/react/icons/tokens/TokenPOL";
import TokenAURORA from "@web3icons/react/icons/tokens/TokenAURORA";
import TokenFRAX from "@web3icons/react/icons/tokens/TokenFRAX";
import TokenUSDE from "@web3icons/react/icons/tokens/TokenUSDE";
import TokenRAY from "@web3icons/react/icons/tokens/TokenRAY";
import TokenJUP from "@web3icons/react/icons/tokens/TokenJUP";
import TokenUSDD from "@web3icons/react/icons/tokens/TokenUSDD";
import NetworkPlasma from "@web3icons/react/icons/networks/NetworkPlasma";
import NetworkMonad from "@web3icons/react/icons/networks/NetworkMonad";
import NetworkXLayer from "@web3icons/react/icons/networks/NetworkXLayer";
import NetworkScroll from "@web3icons/react/icons/networks/NetworkScroll";
import NetworkAdiChain from "@web3icons/react/icons/networks/NetworkAdiChain";
import NetworkRobinhood from "@web3icons/react/icons/networks/NetworkRobinhood";
import NetworkHyperEvm from "@web3icons/react/icons/networks/NetworkHyperEvm";
import { networkIdentity } from "@/lib/asset-identity";

interface IconProps extends SVGProps<SVGSVGElement> {size?:number;variant?:"branded"|"mono"|"background"}
type Icon=ComponentType<IconProps>;
const TOKENS:Record<string,Icon>={HYPE:TokenHYPE,MON:TokenMON,POL:TokenPOL,AURORA:TokenAURORA,FRAX:TokenFRAX,USDE:TokenUSDE,RAY:TokenRAY,JUP:TokenJUP,USDD:TokenUSDD,WNEAR:TokenNEAR,USDC:TokenUSDC,USDT:TokenUSDT,DAI:TokenDAI,EURC:TokenEURC,ETH:TokenETH,WETH:TokenETH,BTC:TokenBTC,WBTC:TokenWBTC,NEAR:TokenNEAR,SOL:TokenSOL,BNB:TokenBNB,AVAX:TokenAVAX,TRX:TokenTRX,XRP:TokenXRP,DOGE:TokenDOGE,LTC:TokenLTC,BCH:TokenBCH,ZEC:TokenZEC,ADA:TokenADA,SUI:TokenSUI,APT:TokenAPT,TON:TokenTON,XLM:TokenXLM,LINK:TokenLINK,UNI:TokenUNI,AAVE:TokenAAVE,ARB:TokenARB,OP:TokenOP,SHIB:TokenSHIB,PEPE:TokenPEPE};
const NETWORK_ICONS:Record<string,Icon>={plasma:NetworkPlasma,monad:NetworkMonad,xlayer:NetworkXLayer,scroll:NetworkScroll,adi:NetworkAdiChain,robinhood:NetworkRobinhood,hyperliquid:NetworkHyperEvm,near:NetworkNearProtocol,ethereum:NetworkEthereum,base:NetworkBase,arbitrum:NetworkArbitrumOne,polygon:NetworkPolygon,solana:NetworkSolana,optimism:NetworkOptimism,bitcoin:NetworkBitcoin,bsc:NetworkBinanceSmartChain,avalanche:NetworkAvalanche,aurora:NetworkAurora,tron:NetworkTron,ton:NetworkTon,aptos:NetworkAptos,sui:NetworkSui,dogecoin:NetworkDogecoin,litecoin:NetworkLitecoin,"bitcoin-cash":NetworkBitcoinCash,zcash:NetworkZcash,xrp:NetworkXrp,stellar:NetworkStellar,cardano:NetworkCardano,linea:NetworkLinea,mantle:NetworkMantle,blast:NetworkBlast,celo:NetworkCelo,zksync:NetworkZksync,abstract:NetworkAbstract,gnosis:NetworkGnosis,berachain:NetworkBerachain};

export function NetworkLogo({network,size=20,className=""}:{network:string;size?:number;className?:string}) {
  const icon=NETWORK_ICONS[networkIdentity(network).key],Icon=icon || Globe;
  return <span className={`inline-flex shrink-0 items-center justify-center ${className}`} style={{width:size,height:size}} aria-hidden="true"><Icon size={size} {...(icon?{variant:"branded" as const}:{})} focusable="false"/></span>;
}

export function TokenLogo({symbol,network,size=28,className=""}:{symbol:string;network?:string;size?:number;className?:string}) {
  const icon=TOKENS[symbol.trim().toUpperCase()],Icon=icon || Coins;
  return <span className={`relative inline-flex shrink-0 items-center justify-center rounded-full bg-card ${className}`} style={{width:size,height:size}} aria-hidden="true"><Icon size={size} {...(icon?{variant:"branded" as const}:{})} focusable="false"/>{network?<span className="absolute -bottom-1 -right-1 rounded-full border-2 border-card bg-card"><NetworkLogo network={network} size={Math.max(12,Math.round(size*0.48))}/></span>:null}</span>;
}

export function NetworkIdentity({network,label,className=""}:{network:string;label?:string;className?:string}) {
  return <span className={`inline-flex max-w-full items-center gap-2 ${className}`}><NetworkLogo network={network}/><span className="min-w-0 [overflow-wrap:anywhere]">{label || networkIdentity(network).name}</span></span>;
}

export function AssetIdentity({symbol,network,assetId,showAssetId=false,className="",size=28}:{symbol:string;network:string;assetId?:string;showAssetId?:boolean;className?:string;size?:number}) {
  return <span className={`inline-flex min-w-0 max-w-full items-center gap-3 ${className}`} title={assetId}><TokenLogo symbol={symbol} network={network} size={size}/><span className="min-w-0 text-left"><span className="block text-sm font-medium [overflow-wrap:anywhere]">{symbol} <span className="font-normal text-muted-foreground">on {networkIdentity(network).name}</span></span>{showAssetId&&assetId?<span className="mt-1 block break-all font-mono text-[10px] leading-4 text-muted-foreground">{assetId}</span>:null}</span></span>;
}
