interface Invoice {id:string;recipient_id:string;reference:string;amount:string;created_at:string}

function normalizedReference(value:string) {return value.toLowerCase().replace(/[^a-z0-9]/g,"");}
function nearbyReference(left:string,right:string) {
  if(left===right)return true;
  if(left.length===right.length&&left.length>=5)return [...left].filter((char,index)=>char!==right[index]).length<=1;
  const a=/^(.*?)(\d+)$/.exec(left),b=/^(.*?)(\d+)$/.exec(right);
  if(!a||!b||a[1]!==b[1])return false;
  const distance=BigInt(a[2])-BigInt(b[2]);return distance>=-2n&&distance<=2n;
}

export function duplicateInvoiceWarnings(invoices:Invoice[]) {
  const groups=new Map<string,Invoice[]>(),warnings:Array<{code:string;message:string;invoiceIds:string[];references:string[];recipientId:string;amountUSDC:string}>=[];
  for(const invoice of [...invoices].sort((a,b)=>a.created_at.localeCompare(b.created_at))) {
    const key=`${invoice.recipient_id}:${invoice.amount}`,previous=groups.get(key) || [];
    for(const other of previous.slice(-10)) {
      const left=normalizedReference(other.reference),right=normalizedReference(invoice.reference),days=Math.abs(Date.parse(invoice.created_at)-Date.parse(other.created_at))/86400000;
      if(left===right || days<=31&&nearbyReference(left,right))warnings.push({code:"POSSIBLE_DUPLICATE_INVOICE",message:"The same supplier has equal invoice amounts and similar references. Review the source documents before approving another payment.",invoiceIds:[other.id,invoice.id],references:[other.reference,invoice.reference],recipientId:invoice.recipient_id,amountUSDC:invoice.amount});
    }
    previous.push(invoice);groups.set(key,previous);
  }
  return warnings.slice(-100);
}

