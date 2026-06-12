/* =====================================================
   SEVEN WONDERS — original wonder-building match-3 PWA
   Engine + persistence + Supabase sync + audio hooks
   ===================================================== */
"use strict";
const COLS = 8, ROWS = 8, CELL = 60;
const GEM_COUNT = 6;
const GEMS = [
  {name:'Ruby',     c1:'#ff7d6e', c2:'#c0271d', shape:'diamond'},
  {name:'Lapis',    c1:'#7fb1ff', c2:'#1d49c0', shape:'circle'},
  {name:'Emerald',  c1:'#7dff9e', c2:'#0f8f3c', shape:'hex'},
  {name:'Amber',    c1:'#ffd97a', c2:'#c07a1d', shape:'triangle'},
  {name:'Amethyst', c1:'#d59bff', c2:'#7a1dc0', shape:'square'},
  {name:'Pearl',    c1:'#ffffff', c2:'#8fa3b8', shape:'tear'},
];
const WONDERS = [
  {name:'The Great Pyramid',    sub:'Wonder I · Giza'},
  {name:'The Hanging Gardens',  sub:'Wonder II · Babylon'},
  {name:'The Temple of Artemis',sub:'Wonder III · Ephesus'},
  {name:'The Statue of Zeus',   sub:'Wonder IV · Olympia'},
  {name:'The Mausoleum',        sub:'Wonder V · Halicarnassus'},
  {name:'The Colossus',         sub:'Wonder VI · Rhodes'},
  {name:'The Great Lighthouse', sub:'Wonder VII · Alexandria'},
];
const LEVELS_PER_WONDER = 2;
const TOTAL_LEVELS = WONDERS.length * LEVELS_PER_WONDER; // 14

/* ---------- canvas ---------- */
const cv = document.getElementById('board');
const ctx = cv.getContext('2d');
const wcv = document.getElementById('wonderCanvas');
const wctx = wcv.getContext('2d');

/* ---------- profile / persistence ---------- */
const STORE_KEY = 'sw_profile_v1';
function uuid(){
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}
function loadProfile(){
  try{
    const p = JSON.parse(localStorage.getItem(STORE_KEY));
    if (p && p.id) return p;
  }catch(e){/* corrupt -> reset */}
  return { id: uuid(), name:'', unlocked:0, bestScore:0, music:true, sfx:true, mode:'timed' };
}
function saveProfile(){
  try{ localStorage.setItem(STORE_KEY, JSON.stringify(profile)); }catch(e){/* storage full/blocked */}
}
let profile = loadProfile();

/* ---------- state ---------- */
let grid, tiles;
let state = 'menu';              // menu | idle | swapping | resolving | collecting | done | fail
let timedMode = true;
let levelIndex = 0;
let score = 0;
let stonesCollected = 0, stoneQuota = 3, stonesToSpawn = 0;
let timeLeft = 120, timeMax = 120;
let chain = 0;
let selected = null;
let dragStart = null;
let swapInfo = null;
let particles = [];
let floaters = [];
let lastTs = 0;
let shakeT = 0;
let runSubmitted = false;        // guards double score submission per run

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const rnd = n => Math.floor(Math.random()*n);
const inB = (r,c) => r>=0 && r<ROWS && c>=0 && c<COLS;
const beep = (f,d,t,g) => window.SWMusic && SWMusic.beep(f,d,t,g);

function makePiece(gem){ return {kind:'gem', gem, special:null, oy:0, ox:0, vy:0, scale:1, dying:0}; }
function makeStone(){ return {kind:'stone', gem:-1, special:null, oy:0, ox:0, vy:0, scale:1, dying:0}; }

/* ---------- level layouts ---------- */
function layerAt(lv, r, c){
  const edge = (r===0||r===ROWS-1||c===0||c===COLS-1);
  switch(lv){
    case 0:  return 1;
    case 1:  return edge ? 2 : 1;
    case 2:  return ((r+c)%2===0) ? 2 : 1;
    case 3:  return (r===3||r===4||c===3||c===4) ? 2 : 1;
    case 4:  return ((r<2&&c<2)||(r<2&&c>5)||(r>5&&c<2)||(r>5&&c>5)) ? 2 : 1;
    case 5:  return (r>=ROWS-3) ? 2 : 1;
    case 6:  return (Math.abs(r-c)<=1 || Math.abs(r-(COLS-1-c))<=1) ? 2 : 1;
    case 7:  return (r%2===0) ? 2 : 1;
    case 8:  return (c>=2&&c<=5&&r>=2&&r<=5) ? 1 : 2;
    case 9:  return ((r+c)%2===0) ? 1 : 2;
    case 10: return (r<2||r>5) ? 2 : ((c<2||c>5)?2:1);
    case 11: return (c%2===0) ? 2 : 1;
    case 12: return ((r>=1&&r<=6&&c>=1&&c<=6) && !(r>=3&&r<=4&&c>=3&&c<=4)) ? 2 : 1;
    default: return 2;
  }
}
function quotaFor(lv){ return Math.min(3 + Math.floor(lv/2), 8); }
function timeFor(lv){ return 130 + lv*8; }

/* ---------- board setup ---------- */
function gemSafeAt(r,c){
  let tries = 0;
  while (true){
    const g = rnd(GEM_COUNT);
    const h = c>=2 && grid[r][c-1] && grid[r][c-2] && grid[r][c-1].gem===g && grid[r][c-2].gem===g;
    const v = r>=2 && grid[r-1][c] && grid[r-2][c] && grid[r-1][c].gem===g && grid[r-2][c].gem===g;
    if ((!h && !v) || ++tries>40) return g;
  }
}
function startLevel(lv){
  levelIndex = lv;
  grid = []; tiles = [];
  for (let r=0;r<ROWS;r++){
    grid.push(new Array(COLS).fill(null));
    tiles.push(new Array(COLS).fill(0));
  }
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
    tiles[r][c] = layerAt(lv, r, c);
    grid[r][c] = makePiece(gemSafeAt(r,c));
  }
  stoneQuota = quotaFor(lv);
  stonesToSpawn = stoneQuota;
  stonesCollected = 0;
  chain = 0; selected = null; swapInfo = null;
  particles = []; floaters = [];
  timeMax = timeFor(lv); timeLeft = timedMode ? timeMax : Infinity;
  state = 'idle';
  ensureMoves();
  syncHud(`Level ${lv+1}: shatter every tile, deliver ${stoneQuota} cornerstones.`);
  hideOverlays();
}

/* ---------- matching ---------- */
function findMatches(){
  const hit = new Set();
  for (let r=0;r<ROWS;r++){
    let run=1;
    for (let c=1;c<=COLS;c++){
      const same = c<COLS && grid[r][c] && grid[r][c-1] &&
        grid[r][c].kind==='gem' && grid[r][c-1].kind==='gem' &&
        grid[r][c].gem===grid[r][c-1].gem;
      if (same) run++;
      else { if (run>=3) for(let k=c-run;k<c;k++) hit.add(r+','+k); run=1; }
    }
  }
  for (let c=0;c<COLS;c++){
    let run=1;
    for (let r=1;r<=ROWS;r++){
      const same = r<ROWS && grid[r][c] && grid[r-1][c] &&
        grid[r][c].kind==='gem' && grid[r-1][c].kind==='gem' &&
        grid[r][c].gem===grid[r-1][c].gem;
      if (same) run++;
      else { if (run>=3) for(let k=r-run;k<r;k++) hit.add(k+','+c); run=1; }
    }
  }
  return hit;
}
function runLengthsAt(set){
  const len = {};
  for (const key of set){
    const [r,c] = key.split(',').map(Number);
    const g = grid[r][c].gem;
    let h=1,v=1;
    for(let k=c-1;k>=0 && set.has(r+','+k) && grid[r][k].gem===g;k--) h++;
    for(let k=c+1;k<COLS && set.has(r+','+k) && grid[r][k].gem===g;k++) h++;
    for(let k=r-1;k>=0 && set.has(k+','+c) && grid[k][c].gem===g;k--) v++;
    for(let k=r+1;k<ROWS && set.has(k+','+c) && grid[k][c].gem===g;k++) v++;
    len[key] = Math.max(h,v);
  }
  return len;
}
function wouldMatchAfterSwap(r1,c1,r2,c2){
  const a=grid[r1][c1], b=grid[r2][c2];
  grid[r1][c1]=b; grid[r2][c2]=a;
  const ok = findMatches().size>0;
  grid[r1][c1]=a; grid[r2][c2]=b;
  return ok;
}
function hasMoves(){
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
    if (!grid[r][c] || grid[r][c].kind!=='gem') continue;
    if (c+1<COLS && grid[r][c+1] && grid[r][c+1].kind==='gem' && wouldMatchAfterSwap(r,c,r,c+1)) return true;
    if (r+1<ROWS && grid[r+1][c] && grid[r+1][c].kind==='gem' && wouldMatchAfterSwap(r,c,r+1,c)) return true;
  }
  return false;
}
function ensureMoves(){
  let guard = 0;
  while (!hasMoves() && guard++ < 60){
    const bag = [];
    for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++)
      if (grid[r][c] && grid[r][c].kind==='gem') bag.push(grid[r][c].gem);
    for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
      if (grid[r][c] && grid[r][c].kind==='gem'){
        grid[r][c].gem = bag.splice(rnd(bag.length),1)[0];
        grid[r][c].special = null;
      }
    }
    let m = findMatches(), g2 = 0;
    while (m.size>0 && g2++ < 30){
      for (const key of m){
        const [r,c] = key.split(',').map(Number);
        grid[r][c].gem = rnd(GEM_COUNT);
      }
      m = findMatches();
    }
  }
}

/* ---------- resolve cycle ---------- */
function explodeSet(baseSet){
  const final = new Set(baseSet);
  let changed = true;
  while (changed){
    changed = false;
    for (const key of Array.from(final)){
      const [r,c] = key.split(',').map(Number);
      const p = grid[r][c];
      if (!p || !p.special || p._spent) continue;
      p._spent = true; changed = true;
      if (p.special==='bomb'){
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){
          const rr=r+dr, cc=c+dc;
          if (inB(rr,cc) && grid[rr][cc] && grid[rr][cc].kind==='gem') final.add(rr+','+cc);
        }
        shakeT = 0.25; beep(160,0.15,'sawtooth',0.07);
      } else if (p.special==='storm'){
        for (let cc=0;cc<COLS;cc++) if (grid[r][cc] && grid[r][cc].kind==='gem') final.add(r+','+cc);
        for (let rr=0;rr<ROWS;rr++) if (grid[rr][c] && grid[rr][c].kind==='gem') final.add(rr+','+c);
        shakeT = 0.3; beep(120,0.2,'sawtooth',0.08);
      }
    }
  }
  return final;
}
function applyMatches(set, forgeAt){
  const lens = runLengthsAt(set);
  const final = explodeSet(set);
  let removed = 0;
  let forge = null;
  for (const key of set){
    if (lens[key]>=5){ forge = {key, kind:'storm'}; break; }
    if (lens[key]>=4 && !forge) forge = {key, kind:'bomb'};
  }
  if (forge && forgeAt && set.has(forgeAt)) forge.key = forgeAt;

  for (const key of final){
    const [r,c] = key.split(',').map(Number);
    const p = grid[r][c];
    if (!p || p.kind!=='gem') continue;
    if (forge && key===forge.key){
      p.special = forge.kind; p._spent = false; p.scale = 1.25;
      continue;
    }
    spawnBurst(c,r,p);
    grid[r][c] = null;
    removed++;
    if (tiles[r][c]>0){ tiles[r][c]--; beep(520+tiles[r][c]*120,0.06,'square',0.04); }
  }
  chain++;
  const pts = removed * 10 * chain;
  if (removed>0){
    score += pts;
    addFloater(pts, final);
    if (timedMode) timeLeft = Math.min(timeMax, timeLeft + removed*0.35);
    beep(300+chain*90, 0.09, 'triangle', 0.05);
  }
  return removed;
}
function addFloater(pts, set){
  let sr=0, sc=0, n=0;
  for (const key of set){ const [r,c]=key.split(',').map(Number); sr+=r; sc+=c; n++; }
  if (!n) return;
  floaters.push({x:(sc/n+0.5)*CELL, y:(sr/n+0.5)*CELL, txt:'+'+pts, t:0});
}
function spawnBurst(c,r,p){
  const g = p.kind==='stone' ? {c1:'#cfd6df',c2:'#7d8794'} : GEMS[p.gem];
  for (let i=0;i<7;i++){
    particles.push({
      x:(c+0.5)*CELL, y:(r+0.5)*CELL,
      vx:(Math.random()-0.5)*240, vy:(Math.random()-0.8)*240,
      t:0, life:0.45+Math.random()*0.25, col: Math.random()<0.5?g.c1:g.c2, sz:3+Math.random()*4
    });
  }
}

/* ---------- gravity & refill ---------- */
function applyGravity(){
  let moved = false;
  for (let c=0;c<COLS;c++){
    let write = ROWS-1;
    for (let r=ROWS-1;r>=0;r--){
      if (grid[r][c]){
        if (write !== r){
          grid[write][c] = grid[r][c];
          grid[write][c].oy -= (write-r)*CELL;
          grid[r][c] = null;
          moved = true;
        }
        write--;
      }
    }
    let spawnDepth = 0;
    for (let r=write; r>=0; r--){
      spawnDepth++;
      let p;
      const stonesOnBoard = countStonesOnBoard();
      if (stonesToSpawn>0 && stonesOnBoard<2 && Math.random()<0.16){
        p = makeStone(); stonesToSpawn--;
      } else {
        p = makePiece(rnd(GEM_COUNT));
      }
      p.oy = -spawnDepth*CELL - rnd(20);
      grid[r][c] = p;
      moved = true;
    }
  }
  return moved;
}
function countStonesOnBoard(){
  let n=0;
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++)
    if (grid[r][c] && grid[r][c].kind==='stone') n++;
  return n;
}
function collectBottomStones(){
  let any = false;
  for (let c=0;c<COLS;c++){
    const p = grid[ROWS-1][c];
    if (p && p.kind==='stone'){ p.dying = 0.0001; any = true; }
  }
  return any;
}

/* ---------- completion / persistence / cloud ---------- */
function tilesRemaining(){
  let n=0;
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) n += tiles[r][c];
  return n;
}
function persistProgress(){
  profile.unlocked = Math.max(profile.unlocked, Math.min(levelIndex+1, TOTAL_LEVELS-1));
  profile.bestScore = Math.max(profile.bestScore, score);
  profile.mode = timedMode ? 'timed' : 'relaxed';
  saveProfile();
  if (window.SWCloud){
    SWCloud.upsertSave({
      id: profile.id,
      name: profile.name || 'Builder',
      level_reached: Math.min(levelIndex+1, TOTAL_LEVELS),
      best_score: profile.bestScore,
      settings: { music: profile.music, sfx: profile.sfx, mode: profile.mode },
    }).catch(()=>{ flash('Offline — progress saved on this device.'); });
  }
}
function submitRun(){
  if (runSubmitted || score<=0) return;
  runSubmitted = true;
  if (!window.SWCloud) return;
  SWCloud.submitScore({
    player_id: profile.id,
    name: profile.name || 'Builder',
    score: score,
    level: Math.min(levelIndex+1, TOTAL_LEVELS),
    mode: timedMode ? 'timed' : 'relaxed',
  }).then(()=>flash('Score recorded in the Hall of Builders.'))
    .catch(()=>flash('Offline — score not submitted.'));
}
function checkComplete(){
  if (tilesRemaining()===0 && stonesCollected>=stoneQuota){
    state = 'done';
    const wIdx = Math.floor(levelIndex / LEVELS_PER_WONDER);
    const lastOfWonder = (levelIndex % LEVELS_PER_WONDER) === LEVELS_PER_WONDER-1;
    const lastLevel = levelIndex === TOTAL_LEVELS-1;
    if (timedMode) score += Math.floor(timeLeft)*5;
    persistProgress();
    syncHud();
    const t = $('doneTitle'), x = $('doneText');
    if (lastLevel){
      t.textContent = 'ALL SEVEN WONDERS RAISED';
      x.textContent = `Magnificent. Final score: ${score.toLocaleString()}. The ancient world stands complete.`;
      $('btnNext').textContent = 'Finish';
      submitRun();
    } else if (lastOfWonder){
      t.textContent = WONDERS[wIdx].name.toUpperCase() + ' COMPLETE';
      x.textContent = 'The builders cheer — a wonder rises against the dusk. Onward to the next marvel.';
      $('btnNext').textContent = 'Next Wonder';
    } else {
      t.textContent = 'LEVEL COMPLETE';
      x.textContent = 'The foundation is laid. One more stage will finish this wonder.';
      $('btnNext').textContent = 'Continue';
    }
    beep(523,0.12); setTimeout(()=>beep(659,0.12),120); setTimeout(()=>beep(784,0.2),240);
    $('doneOverlay').classList.remove('hidden');
  }
}

/* ---------- input ---------- */
function cellFromEvent(e){
  const rect = cv.getBoundingClientRect();
  const x = (e.clientX - rect.left) * (cv.width/rect.width);
  const y = (e.clientY - rect.top) * (cv.height/rect.height);
  const c = Math.floor(x/CELL), r = Math.floor(y/CELL);
  return inB(r,c) ? {r,c} : null;
}
function trySwap(a,b){
  if (!inB(a.r,a.c)||!inB(b.r,b.c)) return;
  if (Math.abs(a.r-b.r)+Math.abs(a.c-b.c)!==1) return;
  const pa = grid[a.r][a.c], pb = grid[b.r][b.c];
  if (!pa||!pb||pa.kind!=='gem'||pb.kind!=='gem') { flash('Cornerstones can only fall — clear gems beneath them.'); return; }
  selected = null;
  const ok = wouldMatchAfterSwap(a.r,a.c,b.r,b.c);
  swapInfo = {a:{...a}, b:{...b}, t:0, revert:!ok};
  state = 'swapping';
  const dx = (b.c-a.c)*CELL, dy = (b.r-a.r)*CELL;
  pa._tx = dx; pa._ty = dy; pb._tx = -dx; pb._ty = -dy;
  beep(ok?440:220, 0.05);
}
cv.addEventListener('pointerdown', e=>{
  if (window.SWMusic) SWMusic.start(); // satisfy autoplay policy
  if (state!=='idle') return;
  const cel = cellFromEvent(e);
  if (!cel) return;
  dragStart = cel;
  const p = grid[cel.r][cel.c];
  if (!p) return;
  if (p.kind!=='gem'){ flash('Cornerstones can only fall — clear gems beneath them.'); return; }
  if (selected && (Math.abs(selected.r-cel.r)+Math.abs(selected.c-cel.c)===1)){
    trySwap(selected, cel);
  } else if (selected && selected.r===cel.r && selected.c===cel.c){
    selected = null;
  } else {
    selected = cel; beep(660,0.04,'sine',0.03);
  }
});
cv.addEventListener('pointermove', e=>{
  if (state!=='idle' || !dragStart) return;
  const cel = cellFromEvent(e);
  if (!cel) return;
  if (cel.r!==dragStart.r || cel.c!==dragStart.c){
    const dr = Math.sign(cel.r-dragStart.r), dc = Math.sign(cel.c-dragStart.c);
    const target = Math.abs(cel.r-dragStart.r) >= Math.abs(cel.c-dragStart.c)
      ? {r:dragStart.r+dr, c:dragStart.c}
      : {r:dragStart.r, c:dragStart.c+dc};
    const p = grid[dragStart.r][dragStart.c];
    if (p && p.kind==='gem') trySwap(dragStart, target);
    dragStart = null;
  }
});
cv.addEventListener('pointerup', ()=>{ dragStart = null; });

/* ---------- main loop ---------- */
function update(dt){
  particles = particles.filter(p=>{
    p.t += dt; p.x += p.vx*dt; p.y += p.vy*dt; p.vy += 500*dt;
    return p.t < p.life;
  });
  floaters = floaters.filter(f=>{ f.t += dt; return f.t < 0.9; });
  if (shakeT>0) shakeT -= dt;

  if (state==='swapping' && swapInfo){
    swapInfo.t += dt*6;
    if (swapInfo.t>=1){
      const {a,b,revert} = swapInfo;
      const pa = grid[a.r][a.c], pb = grid[b.r][b.c];
      delete pa._tx; delete pa._ty; delete pb._tx; delete pb._ty;
      grid[a.r][a.c]=pb; grid[b.r][b.c]=pa;
      if (revert){
        swapInfo = {a:swapInfo.b, b:swapInfo.a, t:0, revert:false, noMatch:true};
        const dx=(swapInfo.b.c-swapInfo.a.c)*CELL, dy=(swapInfo.b.r-swapInfo.a.r)*CELL;
        grid[swapInfo.a.r][swapInfo.a.c]._tx=dx; grid[swapInfo.a.r][swapInfo.a.c]._ty=dy;
        grid[swapInfo.b.r][swapInfo.b.c]._tx=-dx; grid[swapInfo.b.r][swapInfo.b.c]._ty=-dy;
      } else if (swapInfo.noMatch){
        swapInfo = null; state = 'idle';
      } else {
        const forgeKey = b.r+','+b.c;
        swapInfo = null;
        chain = 0;
        const m = findMatches();
        if (m.size>0){ applyMatches(m, forgeKey); applyGravity(); state='resolving'; }
        else state = 'idle';
      }
    }
  }
  else if (state==='resolving'){
    let settled = true;
    for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
      const p = grid[r][c];
      if (!p) continue;
      if (p.oy!==0){
        p.vy += 2600*dt;
        p.oy += p.vy*dt;
        if (p.oy>=0){ p.oy=0; p.vy=0; }
        else settled = false;
      }
      if (p.scale>1){ p.scale = Math.max(1, p.scale - dt*1.2); }
    }
    if (settled){
      const m = findMatches();
      if (m.size>0){
        applyMatches(m, null);
        applyGravity();
      } else {
        if (collectBottomStones()){ state='collecting'; }
        else {
          ensureMoves();
          state='idle';
          checkComplete();
        }
      }
    }
  }
  else if (state==='collecting'){
    let busy = false;
    for (let c=0;c<COLS;c++){
      const p = grid[ROWS-1][c];
      if (p && p.kind==='stone' && p.dying>0){
        p.dying += dt*2.2;
        busy = true;
        if (p.dying>=1){
          spawnBurst(c, ROWS-1, p);
          grid[ROWS-1][c]=null;
          stonesCollected++;
          score += 150;
          beep(880,0.12,'sine',0.06);
          flash('Cornerstone delivered!');
        }
      }
    }
    if (!busy){
      syncHud();
      if (applyGravity()) state='resolving';
      else { ensureMoves(); state='idle'; checkComplete(); }
    }
  }

  if (timedMode && (state==='idle'||state==='swapping'||state==='resolving'||state==='collecting')){
    timeLeft -= dt;
    if (timeLeft<=0){
      timeLeft = 0; state='fail';
      $('failText').textContent = `Time has expired at ${score.toLocaleString()} points.`;
      submitRun();
      $('failOverlay').classList.remove('hidden');
      beep(150,0.4,'sawtooth',0.06);
    }
  }
  syncBars();
}

/* ---------- drawing ---------- */
function roundRect(g,x,y,w,h,r){
  g.beginPath();
  g.moveTo(x+r,y); g.arcTo(x+w,y,x+w,y+h,r); g.arcTo(x+w,y+h,x,y+h,r);
  g.arcTo(x,y+h,x,y,r); g.arcTo(x,y,x+w,y,r); g.closePath();
}
function drawTile(r,c){
  const x=c*CELL, y=r*CELL, L=tiles[r][c];
  ctx.fillStyle = (r+c)%2===0 ? '#1c1433' : '#181029';
  ctx.fillRect(x,y,CELL,CELL);
  if (L>0){
    const grad = ctx.createLinearGradient(x,y,x,y+CELL);
    if (L===2){ grad.addColorStop(0,'#9a7f55'); grad.addColorStop(1,'#6d5538'); }
    else      { grad.addColorStop(0,'#d9b27c'); grad.addColorStop(1,'#b08a55'); }
    ctx.fillStyle = grad;
    roundRect(ctx, x+2.5, y+2.5, CELL-5, CELL-5, 7); ctx.fill();
    ctx.strokeStyle = L===2 ? '#4f3d27' : '#8a6a3e';
    ctx.lineWidth = 1.5; ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth=1;
    ctx.beginPath();
    ctx.moveTo(x+6, y+CELL*0.45); ctx.lineTo(x+CELL-6, y+CELL*0.45);
    ctx.moveTo(x+CELL*0.5, y+CELL*0.45); ctx.lineTo(x+CELL*0.5, y+CELL-6);
    ctx.stroke();
    if (L===2){
      ctx.strokeStyle='rgba(255,255,255,0.12)';
      ctx.strokeRect(x+7.5,y+7.5,CELL-15,CELL-15);
    }
  } else {
    ctx.fillStyle = 'rgba(232,198,106,0.05)';
    ctx.fillRect(x+2,y+2,CELL-4,CELL-4);
  }
}
function drawGemShape(g, p, x, y, s){
  const G = GEMS[p.gem];
  const cx = x+CELL/2, cy = y+CELL/2, R = (CELL*0.34)*s;
  const grad = g.createRadialGradient(cx-R*0.4, cy-R*0.5, R*0.15, cx, cy, R*1.25);
  grad.addColorStop(0, '#ffffff'); grad.addColorStop(0.25, G.c1); grad.addColorStop(1, G.c2);
  g.fillStyle = grad;
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.5;
  g.beginPath();
  switch(G.shape){
    case 'circle': g.arc(cx,cy,R,0,Math.PI*2); break;
    case 'diamond': g.moveTo(cx,cy-R*1.1); g.lineTo(cx+R*0.9,cy); g.lineTo(cx,cy+R*1.1); g.lineTo(cx-R*0.9,cy); g.closePath(); break;
    case 'triangle': g.moveTo(cx,cy-R*1.05); g.lineTo(cx+R,cy+R*0.8); g.lineTo(cx-R,cy+R*0.8); g.closePath(); break;
    case 'square': roundRect(g, cx-R*0.9, cy-R*0.9, R*1.8, R*1.8, R*0.3); break;
    case 'hex': for(let i=0;i<6;i++){ const a=Math.PI/3*i - Math.PI/6; const px=cx+Math.cos(a)*R, py=cy+Math.sin(a)*R; i?g.lineTo(px,py):g.moveTo(px,py);} g.closePath(); break;
    case 'tear': g.arc(cx,cy+R*0.18,R*0.85,Math.PI*0.85,Math.PI*0.15); g.lineTo(cx,cy-R*1.05); g.closePath(); break;
  }
  g.fill(); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath(); g.ellipse(cx-R*0.35, cy-R*0.42, R*0.18, R*0.10, -0.6, 0, Math.PI*2); g.fill();
  if (p.special==='bomb'){
    g.strokeStyle = '#ffb347'; g.lineWidth = 3;
    g.beginPath(); g.arc(cx,cy,R*1.18 + Math.sin(performance.now()/120)*2,0,Math.PI*2); g.stroke();
  } else if (p.special==='storm'){
    g.strokeStyle = '#9ad8ff'; g.lineWidth = 2.5;
    const t = performance.now()/100;
    g.beginPath();
    for (let i=0;i<8;i++){
      const a = t/3 + i*Math.PI/4;
      g.moveTo(cx+Math.cos(a)*R*1.05, cy+Math.sin(a)*R*1.05);
      g.lineTo(cx+Math.cos(a)*R*1.35, cy+Math.sin(a)*R*1.35);
    }
    g.stroke();
  }
}
function drawStone(g, p, x, y){
  const s = 1 - (p.dying||0)*0.9;
  const cx=x+CELL/2, cy=y+CELL/2, R=CELL*0.36*s;
  g.save();
  if (p.dying>0){ g.globalAlpha = Math.max(0,1-p.dying); }
  const grad = g.createLinearGradient(cx,cy-R,cx,cy+R);
  grad.addColorStop(0,'#eef2f7'); grad.addColorStop(0.5,'#aeb9c6'); grad.addColorStop(1,'#75808e');
  g.fillStyle = grad;
  roundRect(g, cx-R, cy-R*0.85, R*2, R*1.7, 6); g.fill();
  g.strokeStyle = '#4d5662'; g.lineWidth=2; g.stroke();
  g.strokeStyle = '#566170'; g.lineWidth=2;
  g.beginPath();
  g.moveTo(cx-R*0.45, cy+R*0.45); g.lineTo(cx, cy-R*0.5); g.lineTo(cx+R*0.45, cy+R*0.45);
  g.moveTo(cx-R*0.22, cy+R*0.05); g.lineTo(cx+R*0.22, cy+R*0.05);
  g.stroke();
  g.restore();
}
function draw(){
  ctx.save();
  ctx.clearRect(0,0,cv.width,cv.height);
  if (shakeT>0){
    ctx.translate((Math.random()-0.5)*6, (Math.random()-0.5)*6);
  }
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) drawTile(r,c);

  ctx.fillStyle = 'rgba(232,198,106,0.10)';
  ctx.fillRect(0, (ROWS-1)*CELL, COLS*CELL, CELL);
  ctx.strokeStyle = 'rgba(232,198,106,0.35)';
  ctx.setLineDash([6,5]);
  ctx.strokeRect(1.5,(ROWS-1)*CELL+1.5, COLS*CELL-3, CELL-3);
  ctx.setLineDash([]);

  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
    const p = grid[r][c];
    if (!p) continue;
    let dx = p.ox||0, dy = p.oy||0;
    if (p._tx!==undefined && swapInfo){
      const t = Math.min(1, swapInfo.t);
      const ease = t<0.5 ? 2*t*t : 1-Math.pow(-2*t+2,2)/2;
      dx += p._tx*ease; dy += p._ty*ease;
    }
    const x = c*CELL+dx, y = r*CELL+dy;
    if (p.kind==='stone') drawStone(ctx,p,x,y);
    else drawGemShape(ctx,p,x,y,p.scale||1);
  }

  if (selected && state==='idle'){
    const {r,c} = selected;
    ctx.strokeStyle = '#ffe9ad';
    ctx.lineWidth = 3;
    const pul = 2+Math.sin(performance.now()/160)*1.5;
    roundRect(ctx, c*CELL+3-pul/2, r*CELL+3-pul/2, CELL-6+pul, CELL-6+pul, 9);
    ctx.stroke();
  }

  for (const p of particles){
    ctx.globalAlpha = Math.max(0, 1 - p.t/p.life);
    ctx.fillStyle = p.col;
    ctx.fillRect(p.x-p.sz/2, p.y-p.sz/2, p.sz, p.sz);
  }
  ctx.globalAlpha = 1;

  ctx.font = '700 18px Cinzel, Georgia, serif';
  ctx.textAlign = 'center';
  for (const f of floaters){
    ctx.globalAlpha = Math.max(0, 1 - f.t/0.9);
    ctx.fillStyle = '#ffe9ad';
    ctx.fillText(f.txt, f.x, f.y - f.t*40);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/* ---------- wonder panel ---------- */
function drawWonderPanel(){
  const W = wcv.width, H = wcv.height;
  wctx.clearRect(0,0,W,H);
  const sky = wctx.createLinearGradient(0,0,0,H);
  sky.addColorStop(0,'#2c1f55'); sky.addColorStop(0.55,'#7a4470'); sky.addColorStop(0.8,'#c4683f'); sky.addColorStop(1,'#8a4630');
  wctx.fillStyle = sky; wctx.fillRect(0,0,W,H);
  wctx.fillStyle = 'rgba(255,220,150,0.9)';
  wctx.beginPath(); wctx.arc(W*0.78, H*0.62, 16, 0, Math.PI*2); wctx.fill();
  wctx.fillStyle = '#3a2a22'; wctx.fillRect(0,H-18,W,18);

  const wIdx = Math.min(WONDERS.length-1, Math.floor(levelIndex / LEVELS_PER_WONDER));
  const lvlInWonder = levelIndex % LEVELS_PER_WONDER;
  let prog = (lvlInWonder + Math.min(1, stoneQuota? (stonesCollected/stoneQuota):0)) / LEVELS_PER_WONDER;
  if (state==='done' || state==='menu') prog = state==='menu'?0.15:1;
  prog = Math.max(0.06, Math.min(1, prog));

  wctx.save();
  const revealH = (H-18) * prog;
  wctx.beginPath(); wctx.rect(0, (H-18)-revealH, W, revealH+0.5); wctx.clip();
  wctx.fillStyle = '#241a30';
  wctx.strokeStyle = '#170f20';
  drawWonderShape(wctx, wIdx, W, H-18);
  wctx.restore();

  if (prog<1 && state!=='menu'){
    wctx.strokeStyle = 'rgba(255,233,173,0.7)'; wctx.setLineDash([4,4]);
    wctx.beginPath(); wctx.moveTo(8,(H-18)-revealH); wctx.lineTo(W-8,(H-18)-revealH); wctx.stroke();
    wctx.setLineDash([]);
  }
}
function drawWonderShape(g, idx, W, baseY){
  const cx = W*0.42;
  g.beginPath();
  switch(idx){
    case 0:
      g.moveTo(cx-78, baseY); g.lineTo(cx, baseY-108); g.lineTo(cx+78, baseY); g.closePath(); g.fill();
      g.fillStyle='rgba(255,255,255,0.06)';
      g.beginPath(); g.moveTo(cx, baseY-108); g.lineTo(cx+78, baseY); g.lineTo(cx+20, baseY); g.closePath(); g.fill();
      break;
    case 1:
      for (let i=0;i<4;i++){
        const w = 150 - i*34, h = 24, y = baseY - i*26 - h;
        g.fillRect(cx-w/2, y, w, h);
      }
      g.beginPath();
      for (let i=0;i<5;i++) g.arc(cx-60+i*30, baseY-104, 12, 0, Math.PI*2);
      g.fill();
      break;
    case 2:
      g.fillRect(cx-80, baseY-14, 160, 14);
      for (let i=0;i<7;i++) g.fillRect(cx-72+i*22, baseY-72, 10, 58);
      g.fillRect(cx-80, baseY-86, 160, 14);
      g.moveTo(cx-86, baseY-86); g.lineTo(cx, baseY-122); g.lineTo(cx+86, baseY-86); g.closePath(); g.fill();
      break;
    case 3:
      g.fillRect(cx-58, baseY-26, 116, 26);
      g.fillRect(cx-50, baseY-96, 16, 70);
      g.beginPath(); g.arc(cx-6, baseY-92, 14, 0, Math.PI*2); g.fill();
      g.fillRect(cx-26, baseY-78, 44, 36);
      g.fillRect(cx-26, baseY-44, 56, 18);
      g.fillRect(cx+24, baseY-104, 6, 80);
      break;
    case 4:
      g.fillRect(cx-66, baseY-20, 132, 20);
      for (let i=0;i<6;i++) g.fillRect(cx-58+i*22, baseY-62, 9, 42);
      g.fillRect(cx-66, baseY-74, 132, 12);
      g.moveTo(cx-56, baseY-74); g.lineTo(cx-24, baseY-112); g.lineTo(cx+24, baseY-112); g.lineTo(cx+56, baseY-74);
      g.closePath(); g.fill();
      g.fillRect(cx-10, baseY-126, 20, 14);
      break;
    case 5:
      g.fillRect(cx-44, baseY-16, 36, 16); g.fillRect(cx+8, baseY-16, 36, 16);
      g.fillRect(cx-34, baseY-66, 16, 50); g.fillRect(cx+18, baseY-66, 16, 50);
      g.fillRect(cx-30, baseY-104, 60, 40);
      g.beginPath(); g.arc(cx, baseY-114, 13, 0, Math.PI*2); g.fill();
      g.fillRect(cx+28, baseY-130, 9, 56);
      g.beginPath(); g.arc(cx+32, baseY-134, 7, 0, Math.PI*2); g.fill();
      break;
    case 6:
      g.fillRect(cx-46, baseY-34, 92, 34);
      g.fillRect(cx-30, baseY-82, 60, 48);
      g.fillRect(cx-18, baseY-118, 36, 36);
      g.fillRect(cx-10, baseY-132, 20, 14);
      g.fillStyle='rgba(255,233,173,0.9)';
      g.beginPath(); g.arc(cx, baseY-138, 5, 0, Math.PI*2); g.fill();
      break;
  }
}

/* ---------- HUD ---------- */
function syncHud(message){
  const wIdx = Math.min(WONDERS.length-1, Math.floor(levelIndex / LEVELS_PER_WONDER));
  $('wonderName').textContent = WONDERS[wIdx].name;
  $('wonderSub').textContent = WONDERS[wIdx].sub;
  $('score').textContent = score.toLocaleString();
  $('level').textContent = (levelIndex+1)+' / '+TOTAL_LEVELS;
  $('stones').textContent = stonesCollected+' / '+stoneQuota;
  const strip = $('wondersStrip');
  strip.innerHTML='';
  for (let i=0;i<WONDERS.length;i++){
    const d = document.createElement('div');
    d.className = 'wdot' + (i<wIdx || (i===wIdx && state==='done' && (levelIndex%LEVELS_PER_WONDER)===LEVELS_PER_WONDER-1) ? ' done' : (i===wIdx?' cur':''));
    strip.appendChild(d);
  }
  $('timeRow').style.display = timedMode? 'flex':'none';
  $('timeBarWrap').style.display = timedMode? 'block':'none';
  if (message) flash(message);
}
function syncBars(){
  $('stoneFill').style.width = (stoneQuota? Math.min(100, stonesCollected/stoneQuota*100):0)+'%';
  if (timedMode){
    $('timeFill').style.width = Math.max(0, timeLeft/timeMax*100)+'%';
    const m = Math.floor(Math.max(0,timeLeft)/60), s = Math.floor(Math.max(0,timeLeft)%60);
    $('timeTxt').textContent = m+':'+String(s).padStart(2,'0');
  }
  $('score').textContent = score.toLocaleString();
  $('stones').textContent = stonesCollected+' / '+stoneQuota;
}
let flashTimer = null;
function flash(t){
  $('msg').textContent = t;
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(()=>{ $('msg').textContent=''; }, 3500);
}
function hideOverlays(){
  ['menuOverlay','doneOverlay','failOverlay','boardOverlay'].forEach(id=>$(id).classList.add('hidden'));
}
function showMenu(){
  state='menu'; hideOverlays();
  $('menuOverlay').classList.remove('hidden');
  $('btnContinue').classList.toggle('hidden', profile.unlocked<=0);
  $('btnContinue').textContent = 'Continue · Lv '+(Math.min(profile.unlocked, TOTAL_LEVELS-1)+1);
  syncHud();
}

/* ---------- leaderboard ---------- */
async function openLeaderboard(){
  hideOverlays();
  $('boardOverlay').classList.remove('hidden');
  const list = $('boardList');
  list.innerHTML = '<li class="dim">Loading…</li>';
  try{
    const rows = await SWCloud.topScores(15);
    if (!rows || rows.length===0){
      list.innerHTML = '<li class="dim">No scores yet — be the first builder.</li>';
      return;
    }
    list.innerHTML = '';
    for (const r of rows){
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.textContent = r.name;
      const sc = document.createElement('span'); sc.className='sc'; sc.textContent = Number(r.score).toLocaleString();
      const mt = document.createElement('span'); mt.className='meta';
      mt.textContent = `Lv ${r.level} · ${r.mode} · ${new Date(r.created_at).toLocaleDateString()}`;
      li.appendChild(nm); li.appendChild(sc); li.appendChild(mt);
      list.appendChild(li);
    }
  }catch(e){
    list.innerHTML = '<li class="dim">Could not reach the Hall of Builders (offline?).</li>';
  }
}

/* ---------- buttons & settings ---------- */
function readName(){
  const v = $('nameInput').value.trim().slice(0,24);
  if (v){ profile.name = v; saveProfile(); }
}
function beginRun(lv, timed){
  if (window.SWMusic) SWMusic.start();
  readName();
  timedMode = timed;
  score = 0; runSubmitted = false;
  startLevel(lv);
}
$('btnTimed').addEventListener('click', ()=> beginRun(0, true));
$('btnRelax').addEventListener('click', ()=> beginRun(0, false));
$('btnContinue').addEventListener('click', ()=> beginRun(Math.min(profile.unlocked, TOTAL_LEVELS-1), profile.mode!=='relaxed'));
$('btnNext').addEventListener('click', ()=>{
  if (levelIndex===TOTAL_LEVELS-1){ showMenu(); }
  else startLevel(levelIndex+1);
});
$('btnRetry').addEventListener('click', ()=>{ score=0; runSubmitted=false; startLevel(levelIndex); });
$('btnMenu').addEventListener('click', showMenu);
$('btnQuit').addEventListener('click', ()=>{ if(state!=='menu') showMenu(); });
$('btnBoard').addEventListener('click', openLeaderboard);
$('btnBoardBack').addEventListener('click', showMenu);

function refreshToggles(){
  $('btnMusic').setAttribute('aria-pressed', String(profile.music));
  $('btnSfx').setAttribute('aria-pressed', String(profile.sfx));
}
$('btnMusic').addEventListener('click', ()=>{
  profile.music = !profile.music; saveProfile(); refreshToggles();
  if (window.SWMusic){ SWMusic.start(); SWMusic.setMusic(profile.music); }
});
$('btnSfx').addEventListener('click', ()=>{
  profile.sfx = !profile.sfx; saveProfile(); refreshToggles();
  if (window.SWMusic){ SWMusic.setSfx(profile.sfx); }
});

/* ---------- boot ---------- */
function boot(){
  grid=[]; tiles=[];
  for (let r=0;r<ROWS;r++){ grid.push(new Array(COLS).fill(null)); tiles.push(new Array(COLS).fill(1)); }
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) grid[r][c]=makePiece(gemSafeAt(r,c));
  if (window.SWMusic){ SWMusic.musicOn = profile.music; SWMusic.sfxOn = profile.sfx; }
  refreshToggles();
  $('nameInput').value = profile.name || '';
  $('verTag').textContent = window.SW_CONFIG.APP_VERSION;
  $('netTag').textContent = navigator.onLine===false ? 'offline' : 'online';
  window.addEventListener('online',  ()=>{ $('netTag').textContent='online'; });
  window.addEventListener('offline', ()=>{ $('netTag').textContent='offline'; });
  // pull cloud save if it is ahead of this device
  if (window.SWCloud){
    SWCloud.loadSave(profile.id).then(s=>{
      if (s && (s.level_reached||0) > profile.unlocked){
        profile.unlocked = s.level_reached;
        profile.bestScore = Math.max(profile.bestScore, Number(s.best_score)||0);
        saveProfile(); showMenu();
      }
    }).catch(()=>{/* offline */});
  }
  showMenu();
}
function loop(ts){
  const dt = Math.min(0.05, (ts-lastTs)/1000 || 0.016);
  lastTs = ts;
  if (state!=='menu') update(dt);
  draw();
  drawWonderPanel();
  requestAnimationFrame(loop);
}
boot();
requestAnimationFrame(loop);
