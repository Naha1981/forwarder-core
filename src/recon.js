// Vendor invoice reconciliation and per-customer fee split.
// Built from public user reports (Loadstar 8 Jan 2026, DCN 28 Jan 2026, r/CargoWise Dec 2025).
// Real vendor invoice layout is UNKNOWN: columns are mapped by the user. Amounts are never assumed.
export function parseCsv(text){
  const rows=[]; let row=[],f='',q=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){f+='"';i++;} else q=false; } else f+=ch; }
    else if(ch==='"') q=true;
    else if(ch===','){ row.push(f); f=''; }
    else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n') i++; row.push(f); f=''; if(row.some(x=>x.trim()!=='')) rows.push(row); row=[]; }
    else f+=ch;
  }
  row.push(f); if(row.some(x=>x.trim()!=='')) rows.push(row);
  if(!rows.length) return [];
  const head=rows[0].map(h=>h.trim());
  return rows.slice(1).map(r=>Object.fromEntries(head.map((h,i)=>[h,(r[i]??'').trim()])));
}
export function toCents(s){
  if(typeof s==='number') return Math.round(s*100);
  const t=String(s).replace(/[\s,R$]/g,'').replace(/^\((.*)\)$/,'-$1');
  if(!/^-?\d+(\.\d{1,2})?$/.test(t)) throw new Error('Bad amount: '+s);
  return Math.round(parseFloat(t)*100);
}
export const fmt=c=>(c<0?'-':'')+(Math.abs(c)/100).toFixed(2);
export function mapInvoice(rows,m){
  return rows.map((r,i)=>{
    for(const k of ['job','type','amount']) if(!m[k]||!(m[k] in r)) throw new Error(`Column for "${k}" not found in invoice file`);
    return {line:i+2,job:r[m.job].trim().toUpperCase(),type:r[m.type].trim(),amount:toCents(r[m.amount])};
  });
}
export function mapJobs(rows,m){
  return rows.map((r,i)=>{
    for(const k of ['job','customer']) if(!m[k]||!(m[k] in r)) throw new Error(`Column for "${k}" not found in jobs file`);
    return {line:i+2,job:r[m.job].trim().toUpperCase(),customer:r[m.customer].trim()};
  });
}
export const isAdjustment=t=>/adjust|transitional|\bTPP\b|credit|rebate/i.test(t);
export function reconcile(lines,jobs,opts={}){
  const {invoiceTotal=null,expectedRates={},markupPct=0,spreadAdjustments=true}=opts;
  const findings=[]; const jobMap=new Map();
  const dupJobs=new Set();
  for(const j of jobs){ if(jobMap.has(j.job)&&jobMap.get(j.job)!==j.customer) findings.push({code:'JOB_CUSTOMER_CONFLICT',job:j.job,detail:`Job listed under "${jobMap.get(j.job)}" and "${j.customer}"`}); if(jobMap.has(j.job)) dupJobs.add(j.job); jobMap.set(j.job,j.customer); }
  const feeLines=lines.filter(l=>!isAdjustment(l.type)); const adjLines=lines.filter(l=>isAdjustment(l.type));
  const seen=new Map();
  for(const l of feeLines){
    const k=l.job+'|'+l.type+'|'+l.amount; seen.set(k,(seen.get(k)||[]).concat(l));
  }
  for(const [k,ls] of seen) if(ls.length>1) findings.push({code:'POSSIBLE_DUPLICATE',job:ls[0].job,detail:`${ls.length} identical lines "${ls[0].type}" ${fmt(ls[0].amount)} (invoice lines ${ls.map(x=>x.line).join(', ')})`,amount:ls[0].amount*(ls.length-1)});
  for(const l of feeLines){
    if(!jobMap.has(l.job)) findings.push({code:'BILLED_NOT_IN_YOUR_JOBS',job:l.job,detail:`Invoice line ${l.line} "${l.type}" ${fmt(l.amount)}: job not in your own job list`,amount:l.amount});
    const exp=expectedRates[l.type]; if(exp!=null&&toCents(exp)!==l.amount) findings.push({code:'RATE_DIFFERS_FROM_EXPECTED',job:l.job,detail:`Line ${l.line} "${l.type}" billed ${fmt(l.amount)}, you expected ${fmt(toCents(exp))}`,amount:l.amount-toCents(exp)});
  }
  const billedJobs=new Set(feeLines.map(l=>l.job));
  for(const j of jobMap.keys()) if(!billedJobs.has(j)) findings.push({code:'YOUR_JOB_NOT_BILLED',job:j,detail:'In your job list, no fee line on this invoice (may be correct)',amount:0});
  const feeTotal=feeLines.reduce((s,l)=>s+l.amount,0), adjTotal=adjLines.reduce((s,l)=>s+l.amount,0), lineTotal=feeTotal+adjTotal;
  if(invoiceTotal!=null&&toCents(invoiceTotal)!==lineTotal) findings.push({code:'TOTAL_MISMATCH',job:'',detail:`Lines sum to ${fmt(lineTotal)}, invoice total typed in is ${fmt(toCents(invoiceTotal))}`,amount:lineTotal-toCents(invoiceTotal)});
  // Per-customer split
  const cust=new Map();
  const bucket=n=>{ if(!cust.has(n)) cust.set(n,{customer:n,jobs:new Set(),fees:0,adjShare:0}); return cust.get(n); };
  let unassigned=0;
  for(const l of feeLines){ const c=jobMap.get(l.job); if(!c){unassigned+=l.amount;continue;} const b=bucket(c); b.jobs.add(l.job); b.fees+=l.amount; }
  const totalJobs=[...cust.values()].reduce((s,b)=>s+b.jobs.size,0);
  let adjAllocated=0;
  if(spreadAdjustments&&totalJobs>0&&adjTotal!==0){
    const arr=[...cust.values()]; let rem=adjTotal;
    arr.forEach((b,i)=>{ const share=i===arr.length-1?rem:Math.round(adjTotal*b.jobs.size/totalJobs); b.adjShare=share; rem-=share; adjAllocated+=share; });
  }
  const split=[...cust.values()].map(b=>{ const cost=b.fees+b.adjShare; const charge=Math.round(cost*(1+markupPct/100)); return {customer:b.customer,jobs:b.jobs.size,fees:b.fees,adjustments:b.adjShare,cost,charge}; }).sort((a,b)=>a.customer.localeCompare(b.customer));
  return {findings,totals:{lines:lines.length,feeTotal,adjTotal,lineTotal,unassigned,adjUnallocated:adjTotal-adjAllocated},adjustmentLines:adjLines,split};
}
export function splitCsv(split){
  const esc=s=>/[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;
  return ['Customer,Jobs,Fees,Adjustments,Cost,Charge'].concat(split.map(r=>[esc(r.customer),r.jobs,fmt(r.fees),fmt(r.adjustments),fmt(r.cost),fmt(r.charge)].join(','))).join('\n')+'\n';
}
