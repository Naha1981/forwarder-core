// Core domain logic. Concepts follow public vendor descriptions of forwarding systems (INFERRED, not CargoWise internals).
export const QUOTE_STATES = ['draft','sent','accepted','rejected','expired'];
export const BOOKING_STATES = ['requested','confirmed','cancelled'];
export const SHIPMENT_STATES = ['open','in_transit','arrived','cleared','delivered','closed'];
export const MILESTONES = ['Booked','Cargo received','Departed','Arrived','Customs released','Delivered'];
export const ORG_ROLES = ['customer','supplier','carrier','agent','consignee'];

let seq = 0;
export function nextId(prefix, n){ return prefix + String(n).padStart(5,'0'); }
export function emptyDb(){ return {orgs:[],quotes:[],bookings:[],shipments:[],counters:{org:0,quote:0,booking:0,shipment:0}}; }

export function addOrg(db,{name,roles=['customer'],country='ZA',email=''}){
  if(!name||!name.trim()) throw new Error('Organisation name required');
  roles.forEach(r=>{ if(!ORG_ROLES.includes(r)) throw new Error('Unknown role '+r); });
  if(db.orgs.some(o=>o.name.toLowerCase()===name.trim().toLowerCase())) throw new Error('Duplicate organisation');
  db.counters.org++;
  const o={id:nextId('ORG',db.counters.org),name:name.trim(),roles,country,email};
  db.orgs.push(o); return o;
}
export function lineTotal(l){ return round2((Number(l.qty)||0)*(Number(l.unit)||0)); }
export function round2(x){ return Math.round((x+Number.EPSILON)*100)/100; }
export function quoteTotals(q){
  const sell=round2(q.lines.reduce((s,l)=>s+lineTotal(l),0));
  const cost=round2(q.lines.reduce((s,l)=>s+(Number(l.qty)||0)*(Number(l.cost)||0),0));
  return {sell,cost,margin:round2(sell-cost),marginPct: sell? round2((sell-cost)/sell*100):0};
}
export function addQuote(db,{customerId,origin,destination,mode='sea',lines=[]}){
  const c=db.orgs.find(o=>o.id===customerId); if(!c) throw new Error('Customer not found');
  if(!origin||!destination) throw new Error('Origin and destination required');
  if(!['sea','air','road'].includes(mode)) throw new Error('Bad mode');
  db.counters.quote++;
  const q={id:nextId('Q',db.counters.quote),customerId,origin,destination,mode,lines,state:'draft'};
  db.quotes.push(q); return q;
}
export function setQuoteState(db,id,state){
  const q=db.quotes.find(x=>x.id===id); if(!q) throw new Error('Quote not found');
  const ok={draft:['sent'],sent:['accepted','rejected','expired'],accepted:[],rejected:[],expired:[]};
  if(!ok[q.state].includes(state)) throw new Error(`Cannot move quote ${q.state} -> ${state}`);
  if(state==='sent' && !q.lines.length) throw new Error('Cannot send a quote with no lines');
  q.state=state; return q;
}
export function bookFromQuote(db,quoteId,{carrierId,etd}={}){
  const q=db.quotes.find(x=>x.id===quoteId); if(!q) throw new Error('Quote not found');
  if(q.state!=='accepted') throw new Error('Quote must be accepted before booking');
  if(db.bookings.some(b=>b.quoteId===quoteId&&b.state!=='cancelled')) throw new Error('Quote already booked');
  if(carrierId&&!db.orgs.find(o=>o.id===carrierId&&o.roles.includes('carrier'))) throw new Error('Carrier not found');
  db.counters.booking++;
  const b={id:nextId('B',db.counters.booking),quoteId,carrierId:carrierId||null,etd:etd||null,state:'requested'};
  db.bookings.push(b); return b;
}
export function confirmBooking(db,id,ref){
  const b=db.bookings.find(x=>x.id===id); if(!b) throw new Error('Booking not found');
  if(b.state!=='requested') throw new Error('Booking not in requested state');
  if(!ref) throw new Error('Carrier booking reference required');
  b.state='confirmed'; b.carrierRef=ref; return b;
}
export function shipmentFromBooking(db,bookingId){
  const b=db.bookings.find(x=>x.id===bookingId); if(!b) throw new Error('Booking not found');
  if(b.state!=='confirmed') throw new Error('Booking must be confirmed');
  if(db.shipments.some(s=>s.bookingId===bookingId)) throw new Error('Shipment already exists');
  const q=db.quotes.find(x=>x.id===b.quoteId);
  db.counters.shipment++;
  const s={id:nextId('S',db.counters.shipment),bookingId,quoteId:q.id,customerId:q.customerId,origin:q.origin,destination:q.destination,mode:q.mode,state:'open',containers:[],milestones:[{name:'Booked',at:new Date().toISOString()}],costs:[]};
  db.shipments.push(s); return s;
}
export function isContainerNo(n){
  // ISO 6346 shape plus check digit.
  if(!/^[A-Z]{4}\d{7}$/.test(n)) return false;
  const vals={}; let v=10; for(const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'){ if(v%11===0) v++; vals[ch]=v++; }
  let sum=0; for(let i=0;i<10;i++){ const x=i<4?vals[n[i]]:Number(n[i]); sum+=x*Math.pow(2,i); }
  return (sum%11)%10===Number(n[10]);
}
export function addContainer(db,shipId,no,type='20GP'){
  const s=db.shipments.find(x=>x.id===shipId); if(!s) throw new Error('Shipment not found');
  no=no.toUpperCase().replace(/\s/g,'');
  if(!isContainerNo(no)) throw new Error('Invalid container number (ISO 6346)');
  if(db.shipments.some(x=>x.containers.some(c=>c.no===no)&&x.state!=='closed')) throw new Error('Container already on an open shipment');
  s.containers.push({no,type}); return s;
}
export function addMilestone(db,shipId,name){
  const s=db.shipments.find(x=>x.id===shipId); if(!s) throw new Error('Shipment not found');
  const i=MILESTONES.indexOf(name); if(i<0) throw new Error('Unknown milestone');
  if(s.milestones.some(m=>m.name===name)) throw new Error('Milestone already recorded');
  const prev=MILESTONES.slice(0,i); if(!prev.every(p=>s.milestones.some(m=>m.name===p))) throw new Error('Earlier milestones missing');
  s.milestones.push({name,at:new Date().toISOString()});
  const map={Departed:'in_transit',Arrived:'arrived','Customs released':'cleared',Delivered:'delivered'};
  if(map[name]) s.state=map[name]; return s;
}
export function addCost(db,shipId,{supplierId,desc,amount}){
  const s=db.shipments.find(x=>x.id===shipId); if(!s) throw new Error('Shipment not found');
  if(!db.orgs.find(o=>o.id===supplierId)) throw new Error('Supplier not found');
  if(!(Number(amount)>0)) throw new Error('Amount must be positive');
  s.costs.push({supplierId,desc,amount:round2(Number(amount))}); return s;
}
export function jobProfit(db,shipId){
  const s=db.shipments.find(x=>x.id===shipId); const q=db.quotes.find(x=>x.id===s.quoteId);
  const revenue=quoteTotals(q).sell; const cost=round2(s.costs.reduce((a,c)=>a+c.amount,0));
  return {revenue,cost,profit:round2(revenue-cost)};
}
export function closeShipment(db,id){
  const s=db.shipments.find(x=>x.id===id);
  if(s.state!=='delivered') throw new Error('Only delivered shipments can be closed');
  s.state='closed'; return s;
}
