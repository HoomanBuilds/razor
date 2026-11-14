interface LiabilityPayment {amount:string;delivered_amount:string;total_spent:string;status:string}
const positive=(value:bigint)=>value>0n?value:0n;

export function liabilityTotals(amount:string,payments:readonly LiabilityPayment[],setoff="0",fundedClearing="0") {
  const delivered=payments.reduce((sum,payment)=>sum+BigInt(payment.delivered_amount),0n),sourceSpent=payments.reduce((sum,payment)=>sum+BigInt(payment.total_spent),0n);
  const remaining=positive(BigInt(amount)-delivered-BigInt(setoff)-BigInt(fundedClearing));
  const activePrincipal=payments.filter(payment=>!["paid","cancelled","partially_paid"].includes(payment.status)).reduce((sum,payment)=>sum+positive(BigInt(payment.amount)-BigInt(payment.delivered_amount)),0n);
  return {delivered,remaining,sourceSpent,netCost:sourceSpent-delivered,activePrincipal,unprepared:positive(remaining-activePrincipal)};
}
