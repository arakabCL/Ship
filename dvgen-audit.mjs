#!/usr/bin/env node
/* dvgen-audit.mjs — headless acceptance audit for the DVGEN scenario generator (Agent 2).
   Extracts the DVGEN block from dark-vessel-lite.html by its markers and runs it over
   many seeds, asserting the acceptance criteria from the implementation brief:
     1. spawn counts / board caps / teeth / live-real ceiling every round
     2. patrol solvency (unique arrival rounds; EDF play misses nothing)
     3. run totals in range (20–25 total, 8–10 real, 2–4 decoys, 8–11 innocent)
     4. economy pacing (R1 max ≤125; +150 by R2; <550 through R4; +550 by R5)
     5. ghost caps (no unseen incident before R5; ≤1/round; wedges contain routes)
     6. cloud rules (coverage ≈20%, from R5, drift clears, ≤1 must-act obscured, never deny)
     7. archetype tells (decoys still, spoofers underway, innocent claims honest)
     8. reproducibility (same seed byte-identical, different seeds differ)
   Usage: node dvgen-audit.mjs [nSeeds]   (default 1200; acceptance requires ≥1000) */
import {readFileSync} from 'node:fs';

const html=readFileSync(new URL('./dark-vessel-lite.html',import.meta.url),'utf8');
const B='/* DVGEN:BEGIN */',E='/* DVGEN:END */';
const i0=html.indexOf(B),i1=html.indexOf(E);
if(i0<0||i1<0){ console.error('FAIL: DVGEN markers not found in dark-vessel-lite.html'); process.exit(1); }
const src=html.slice(i0+B.length,i1);
const make=()=>new Function(src+'\nreturn DVGEN;')();
const DVGEN=make(), DVGEN_B=make();            // second module instance: cross-instance determinism

const N=Math.max(1,parseInt(process.argv[2]||'1200',10));
const T=DVGEN.FALLBACK_TUNING;
const CNT=[[2,2],[2,3],[2,3],[2,3],[2,3],[3,3],[3,4],[3,4]];
let fails=0; const sample=[];
const push=(seed,msg)=>{ fails++; if(sample.length<40) sample.push(seed+' → '+msg); };

/* re-derive the core acceptance numbers without trusting DVGEN.validate */
function independentChecks(seed,scn){
  const specs=DVGEN.allSpecs(scn);
  const reals=specs.filter(s=>s.kind==='real');
  // 2 · solvency
  const arr=reals.map(s=>s.arrivalRound);
  if(new Set(arr).size!==arr.length) push(seed,'indep: duplicate arrival rounds '+arr.join(','));
  reals.forEach(s=>{ if(s.arrivalRound!==s.spawnRound+s.d) push(seed,'indep: '+s.id+' arrival!=spawn+d'); });
  const caught=new Set();
  for(let r=1;r<=8;r++){
    const live=reals.filter(s=>s.spawnRound<=r&&s.arrivalRound>r&&!caught.has(s.id))
      .sort((a,b)=>a.arrivalRound-b.arrivalRound);
    if(live.length) caught.add(live[0].id);
  }
  const missed=reals.filter(s=>s.arrivalRound<=8&&!caught.has(s.id));
  if(missed.length) push(seed,'indep: EDF play misses '+missed.map(s=>s.id).join(','));
  // 1 · curve, caps, teeth, live ceiling
  for(let r=1;r<=8;r++){
    const n=scn.rounds[r].spawns.length;
    if(n<CNT[r-1][0]||n>CNT[r-1][1]) push(seed,'indep: round '+r+' spawn count '+n);
    const occ=specs.filter(s=>s.spawnRound<=r&&r<=Math.min(s.spawnRound+s.d-1,8)).length;
    if(occ>T.BOARD_CAP[r-1]) push(seed,'indep: round '+r+' board '+occ+'>'+T.BOARD_CAP[r-1]);
    const lv=reals.filter(s=>s.spawnRound<=r&&r<s.arrivalRound).length;
    if(lv<1) push(seed,'indep: round '+r+' has no live real');
    if(lv>T.MAX_LIVE_REALS) push(seed,'indep: round '+r+' live reals '+lv);
  }
  // 3 · totals
  const D=specs.filter(s=>s.kind==='fake').length,I=specs.filter(s=>s.kind==='neutral').length;
  if(specs.length<20||specs.length>25) push(seed,'indep: total '+specs.length);
  if(reals.length<8||reals.length>10) push(seed,'indep: reals '+reals.length);
  if(D<2||D>4) push(seed,'indep: decoys '+D);
  if(I<8||I>11) push(seed,'indep: innocents '+I);
  // 4 · economy pacing (optimal play recomputed here from SC)
  let cum=0; const cums=[]; const c2=new Set();
  for(let r=1;r<=8;r++){
    const live=reals.filter(s=>s.spawnRound<=r&&s.arrivalRound>r&&!c2.has(s.id))
      .sort((a,b)=>a.arrivalRound-b.arrivalRound);
    let gain=0;
    if(live.length){ c2.add(live[0].id); gain+=T.SC.catch; }
    gain+=T.SC.clear*specs.filter(s=>s.kind!=='real'&&s.spawnRound===r).length;
    cum+=gain; cums.push(cum);
  }
  if(cums[0]>125) push(seed,'indep: round-1 max earnable '+cums[0]);
  if(cums[1]<T.T2_AT) push(seed,'indep: +'+T.T2_AT+' not crossable by round 2 ('+cums[1]+')');
  if(cums[3]>=T.T3_AT) push(seed,'indep: round-4 cumulative '+cums[3]+' reaches +'+T.T3_AT);
  if(cums[4]<T.T3_AT) push(seed,'indep: +'+T.T3_AT+' not crossable by round 5 ('+cums[4]+')');
  // 5 · ghost caps
  const ghosts=specs.filter(s=>s.archetype==='ghost');
  ghosts.forEach(s=>{ if(s.arrivalRound<T.GHOST_FIRST_INCIDENT) push(seed,'indep: unseen incident possible round '+s.arrivalRound); });
  for(let r=1;r<=8;r++) if(ghosts.filter(s=>s.arrivalRound===r).length>T.MAX_UNSEEN_PER_ROUND)
    push(seed,'indep: >1 unseen incident round '+r);
  // 7 · archetype tells
  specs.forEach(s=>{
    if(s.archetype==='decoy'&&s.kn>=0.5) push(seed,'indep: decoy '+s.id+' moves ('+s.kn+' kn)');
    if(s.archetype==='decoy'&&s.targetZone) push(seed,'indep: decoy '+s.id+' has a target');
    if(s.archetype==='spoofer'&&(!s.targetZone||s.kn<6)) push(seed,'indep: spoofer '+s.id+' not underway');
    if(s.archetype==='local_fishing'&&(s.kn<2||s.kn>5)) push(seed,'indep: fisher speed '+s.kn);
    if(s.archetype==='local_coaster'&&(s.kn<8||s.kn>12)) push(seed,'indep: coaster speed '+s.kn);
    if(s.kind!=='real'&&s.claimedIdentity&&s.claimedIdentity.match<85) push(seed,'indep: weak claim on '+s.id);
  });
  return cums;
}

const stat={contacts:[],reals:[],decoys:[],inns:[],attempts:[],spoofer:0,ghost2:0,laneDecoy:0,
  falseRep:0,cloudBait:0,crossT2:{},crossT3:{}};
let prevJson=null;
const t0=Date.now();
for(let i=0;i<N;i++){
  const seed='SEED-'+i;
  let scn;
  try{ scn=DVGEN.generate(seed); }
  catch(e){ push(seed,'generate threw: '+e.message); continue; }
  const v=DVGEN.validate(scn);
  if(!v.ok) v.errors.slice(0,3).forEach(m=>push(seed,'validate: '+m));
  independentChecks(seed,scn);
  // 8 · reproducibility
  const j1=JSON.stringify(scn);
  if(JSON.stringify(DVGEN.generate(seed))!==j1) push(seed,'not reproducible (same instance)');
  if(i%97===0&&JSON.stringify(DVGEN_B.generate(seed))!==j1) push(seed,'not reproducible (fresh instance)');
  if(prevJson!==null&&prevJson===j1) push(seed,'identical to previous seed');
  prevJson=j1;
  // distribution stats
  stat.contacts.push(scn.meta.totals.contacts); stat.reals.push(scn.meta.totals.real);
  stat.decoys.push(scn.meta.totals.fake); stat.inns.push(scn.meta.totals.neutral);
  stat.attempts.push(scn.meta.attempts);
  if(scn.meta.spoofer)stat.spoofer++;
  if(scn.meta.ghost2Round)stat.ghost2++;
  if(scn.meta.ghostLaneDecoy)stat.laneDecoy++;
  if(scn.meta.falseReports)stat.falseRep++;
  if(scn.meta.cloudBaiting)stat.cloudBait++;
  const op=scn.meta.optimal;
  stat.crossT2[op.crossT2]=(stat.crossT2[op.crossT2]||0)+1;
  stat.crossT3[op.crossT3]=(stat.crossT3[op.crossT3]||0)+1;
}
const ms=Date.now()-t0;

/* distribution-level assertions (need the full population, not one seed) */
const frac=x=>x/N;
if(frac(stat.spoofer)<.38||frac(stat.spoofer)>.62) push('POPULATION','spoofer fraction '+frac(stat.spoofer).toFixed(2)+' (want ~0.5)');
if(frac(stat.ghost2)<.4) push('POPULATION','second-ghost fraction low: '+frac(stat.ghost2).toFixed(2));
if(Object.keys(stat.crossT2).join(',')!=='2') push('POPULATION','T2 crossing rounds seen: '+JSON.stringify(stat.crossT2)+' (want all =2)');
if(Object.keys(stat.crossT3).join(',')!=='5') push('POPULATION','T3 crossing rounds seen: '+JSON.stringify(stat.crossT3)+' (want all =5)');
const sorted=stat.attempts.slice().sort((a,b)=>a-b);
const p99=sorted[Math.floor(sorted.length*.99)]||0;
if(p99>8) push('POPULATION','generation attempts p99='+p99+' (construction too loose)');

const avg=a=>(a.reduce((x,y)=>x+y,0)/(a.length||1)).toFixed(1);
const lohi=a=>a.length?Math.min(...a)+'–'+Math.max(...a):'—';
console.log('DVGEN audit — '+N+' seeds in '+(ms/1000).toFixed(1)+'s');
console.log('  contacts/run  avg '+avg(stat.contacts)+'  range '+lohi(stat.contacts));
console.log('  reals         avg '+avg(stat.reals)+'   range '+lohi(stat.reals));
console.log('  decoys        avg '+avg(stat.decoys)+'   range '+lohi(stat.decoys));
console.log('  innocents     avg '+avg(stat.inns)+'   range '+lohi(stat.inns));
console.log('  attempts      avg '+avg(stat.attempts)+'   p99 '+p99+'  max '+(sorted[sorted.length-1]||0));
console.log('  spoofer runs  '+(100*frac(stat.spoofer)).toFixed(0)+'%   second ghost '+(100*frac(stat.ghost2)).toFixed(0)+'%   ghost-lane decoy '+(100*frac(stat.laneDecoy)).toFixed(0)+'%');
console.log('  false reports '+(100*frac(stat.falseRep)).toFixed(0)+'%   runner routed under cloud '+(100*frac(stat.cloudBait)).toFixed(0)+'%');
console.log('  T2 crossing rounds '+JSON.stringify(stat.crossT2)+'   T3 '+JSON.stringify(stat.crossT3));
if(fails){
  console.log('\nFAIL — '+fails+' assertion failure(s). First '+sample.length+':');
  sample.forEach(m=>console.log('  · '+m));
  process.exit(1);
}
console.log('\nPASS — all acceptance criteria hold over '+N+' seeds.');
