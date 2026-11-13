interface NetworkIdentity {key:string;name:string}
const NETWORKS:Record<string,NetworkIdentity>={
  plasma:{key:"plasma",name:"Plasma"},monad:{key:"monad",name:"Monad"},xlayer:{key:"xlayer",name:"X Layer"},scroll:{key:"scroll",name:"Scroll"},adi:{key:"adi",name:"ADI Chain"},hood:{key:"robinhood",name:"Robinhood"},hlevm:{key:"hyperliquid",name:"Hyperliquid EVM"},hypercore:{key:"hypercore",name:"Hyperliquid HyperCore"},
  near:{key:"near",name:"NEAR"},"near-protocol":{key:"near",name:"NEAR"},
  eth:{key:"ethereum",name:"Ethereum"},ethereum:{key:"ethereum",name:"Ethereum"},
  base:{key:"base",name:"Base"},arb:{key:"arbitrum",name:"Arbitrum"},arbitrum:{key:"arbitrum",name:"Arbitrum"},"arbitrum-one":{key:"arbitrum",name:"Arbitrum"},
  pol:{key:"polygon",name:"Polygon"},polygon:{key:"polygon",name:"Polygon"},"polygon-pos":{key:"polygon",name:"Polygon"},
  sol:{key:"solana",name:"Solana"},solana:{key:"solana",name:"Solana"},op:{key:"optimism",name:"Optimism"},optimism:{key:"optimism",name:"Optimism"},
  btc:{key:"bitcoin",name:"Bitcoin"},bitcoin:{key:"bitcoin",name:"Bitcoin"},
  bsc:{key:"bsc",name:"BNB Chain"},"binance-smart-chain":{key:"bsc",name:"BNB Chain"},
  avax:{key:"avalanche",name:"Avalanche"},avalanche:{key:"avalanche",name:"Avalanche"},
  aurora:{key:"aurora",name:"Aurora"},tron:{key:"tron",name:"TRON"},trx:{key:"tron",name:"TRON"},
  ton:{key:"ton",name:"TON"},aptos:{key:"aptos",name:"Aptos"},sui:{key:"sui",name:"Sui"},
  doge:{key:"dogecoin",name:"Dogecoin"},dogecoin:{key:"dogecoin",name:"Dogecoin"},
  ltc:{key:"litecoin",name:"Litecoin"},litecoin:{key:"litecoin",name:"Litecoin"},
  bch:{key:"bitcoin-cash",name:"Bitcoin Cash"},"bitcoin-cash":{key:"bitcoin-cash",name:"Bitcoin Cash"},
  zec:{key:"zcash",name:"Zcash"},zcash:{key:"zcash",name:"Zcash"},xrp:{key:"xrp",name:"XRP Ledger"},
  xlm:{key:"stellar",name:"Stellar"},stellar:{key:"stellar",name:"Stellar"},
  ada:{key:"cardano",name:"Cardano"},cardano:{key:"cardano",name:"Cardano"},
  linea:{key:"linea",name:"Linea"},mantle:{key:"mantle",name:"Mantle"},blast:{key:"blast",name:"Blast"},
  celo:{key:"celo",name:"Celo"},zksync:{key:"zksync",name:"ZKsync"},abs:{key:"abstract",name:"Abstract"},abstract:{key:"abstract",name:"Abstract"},
  gnosis:{key:"gnosis",name:"Gnosis"},xdai:{key:"gnosis",name:"Gnosis"},
  bera:{key:"berachain",name:"Berachain"},berachain:{key:"berachain",name:"Berachain"},
};

export function networkIdentity(network:string):NetworkIdentity {
  return NETWORKS[network.trim().toLowerCase()] || {key:network.trim().toLowerCase(),name:network};
}

export function matchesAssetSearch(asset:{assetId:string;symbol:string;blockchain:string;contractAddress?:string|null},query:string):boolean {
  const haystack=`${asset.symbol} ${asset.blockchain} ${networkIdentity(asset.blockchain).name} ${asset.assetId} ${asset.contractAddress || ""}`.toLowerCase();
  return query.trim().toLowerCase().split(/\s+/).every(term=>haystack.includes(term));
}
