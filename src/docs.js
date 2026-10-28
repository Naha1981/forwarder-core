// Release document checklist. Required documents are configured by the user (templates).
// Pain source: r/CargoWise 22 May 2024 (3PL bonded CFS: 3 documents + 1 payment proof before release, chased by email).
// The default template below is an EXAMPLE taken from that post, not a legal or SARS requirement.
export const DEFAULT_TEMPLATE=['Clearance document','Delivery order','Gate pass','Payment proof'];
export const DAY=86400000;
export function newCase(db,{ref,customer,template=DEFAULT_TEMPLATE,now=Date.now()}){
  if(!ref||!ref.trim()) throw new Error('Reference required');
  if(!customer||!customer.trim()) throw new Error('Customer required');
  if(!template.length) throw new Error('Template needs at least one document');
  if(new Set(template.map(t=>t.toLowerCase())).size!==template.length) throw new Error('Duplicate document name in template');
  if(db.cases.some(c=>c.ref.toLowerCase()===ref.trim().toLowerCase())) throw new Error('Reference already exists');
  const c={ref:ref.trim(),customer:customer.trim(),created:now,docs:template.map(name=>({name,state:'missing',requestedAt:now,reminders:0,receivedAt:null,note:''}))};
  db.cases.push(c); return c;
}
export function getDoc(db,ref,name){ const c=db.cases.find(x=>x.ref===ref); if(!c) throw new Error('Case not found'); const d=c.docs.find(x=>x.name===name); if(!d) throw new Error('Document not in checklist'); return d; }
export function receive(db,ref,name,now=Date.now()){ const d=getDoc(db,ref,name); if(d.state==='received') throw new Error('Already received'); d.state='received'; d.receivedAt=now; d.note=''; return d; }
export function reject(db,ref,name,note){ const d=getDoc(db,ref,name); if(!note||!note.trim()) throw new Error('Give a reason for rejecting'); d.state='rejected'; d.note=note.trim(); d.receivedAt=null; return d; }
export function remind(db,ref,name,now=Date.now()){ const d=getDoc(db,ref,name); if(d.state==='received') throw new Error('Already received'); d.reminders++; d.lastReminder=now; return d; }
export function status(c){
  const outstanding=c.docs.filter(d=>d.state!=='received');
  return {ready:outstanding.length===0,received:c.docs.length-outstanding.length,total:c.docs.length,outstanding:outstanding.map(d=>d.name)};
}
export function chaseList(db,{now=Date.now(),afterDays=1}={}){
  const out=[];
  for(const c of db.cases) for(const d of c.docs){ if(d.state==='received') continue;
    const since=d.lastReminder||d.requestedAt; const days=Math.floor((now-since)/DAY);
    if(days>=afterDays) out.push({ref:c.ref,customer:c.customer,doc:d.name,state:d.state,daysSince:days,reminders:d.reminders,note:d.note});
  }
  return out.sort((a,b)=>b.daysSince-a.daysSince||b.reminders-a.reminders);
}
export function reminderText(c,names){
  return `Hi,\n\nFor shipment ${c.ref} we still need: ${names.join(', ')}.\nWe cannot release or arrange delivery until these are received.\n\nThank you`;
}
export function releasedWithin(c,now){ return status(c).ready ? Math.max(...c.docs.map(d=>d.receivedAt))-c.created : null; }
