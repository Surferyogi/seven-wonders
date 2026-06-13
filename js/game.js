/* =====================================================
   SEVEN WONDERS — original wonder-building match-3 PWA
   Engine + persistence + Supabase sync + audio hooks
   ===================================================== */
"use strict";
/* visible error trap: surfaces script errors on screen (mobile has no console) */
window.addEventListener('error', function(e){
  try{
    var m = document.getElementById('msg');
    if (m) m.textContent = '\u26A0 Error: ' + (e.message || 'script error');
    var v = document.getElementById('verTag');
    if (v && window.SW_CONFIG) v.textContent = SW_CONFIG.APP_VERSION + ' \u00B7 ERROR';
  }catch(_){}
});
const COLS = 10, ROWS = 10, CELL = 48;
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
let idleT = 0;                   // seconds of no player input while idle
let hintCells = null;            // {a:{r,c}, b:{r,c}} valid swap to highlight
const HINT_DELAY = 5;            // seconds before a hint appears
let gemCount = GEM_COUNT;        // colors in play this level (5 on level 1)
const REFILL_COPY_BIAS = 0.14;   // chance a refilled gem copies the gem below it -> slightly more 4/5 matches
let forgedCount = 0;             // lifetime Bomb/Storm forges (tuning telemetry)

/* ---------- celebrations ---------- */
const fw = {active:false, until:0, next:0, rockets:[], sparks:[]};
const finale = {active:false, t:0, next:0, btnShown:false, glyphs:[], confetti:[], sparks:[]};
function startFireworks(durMs){
  fw.active = true;
  fw.until = performance.now() + durMs;
  fw.next = 0;
  fw.rockets.length = 0; fw.sparks.length = 0;
}
function startFinale(){
  finale.active = true; finale.t = 0; finale.next = 0; finale.btnShown = false;
  finale.glyphs.length = 0; finale.confetti.length = 0; finale.sparks.length = 0;
  hideOverlays();
  if (window.SWMusic) SWMusic.flourish();
}
function stopCelebrations(){
  fw.active = false; fw.rockets.length = 0; fw.sparks.length = 0;
  finale.active = false; finale.glyphs.length = 0; finale.confetti.length = 0; finale.sparks.length = 0;
  $('doneOverlay').classList.remove('celebrate');
}

/* ---------- pause & mid-level save (resume) ---------- */
const RESUME_KEY = 'sw_resume_v1';
let pausedFrom = null;
function pauseGame(){
  pausedFrom = state;
  state = 'paused';
  $('pauseOverlay').classList.remove('hidden');
}
function unpauseGame(){
  $('pauseOverlay').classList.add('hidden');
  state = pausedFrom || 'idle';
  pausedFrom = null;
  resetHint();
}
function saveSnapshot(){
  const cells = [];
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
    const p = grid[r][c];
    cells.push(p ? {k:p.kind==='stone'?1:0, g:p.gem, s:p.special||0} : 0);
  }
  const snap = {
    v:1, lv:levelIndex, score, timed:timedMode,
    timeLeft: timedMode ? Math.max(1, Math.ceil(timeLeft)) : -1,
    stonesCollected, stonesToSpawn, runSubmitted,
    tiles: tiles.map(row=>row.slice()),
    cells,
  };
  try{ localStorage.setItem(RESUME_KEY, JSON.stringify(snap)); }catch(e){/* storage blocked */}
}
function loadSnapshot(){
  try{
    const s = JSON.parse(localStorage.getItem(RESUME_KEY));
    if (s && s.v===1 && Array.isArray(s.cells) && s.cells.length===ROWS*COLS &&
        Array.isArray(s.tiles) && s.tiles.length===ROWS &&
        Number.isInteger(s.lv) && s.lv>=0 && s.lv<TOTAL_LEVELS) return s;
  }catch(e){/* corrupt */}
  return null;
}
function clearSnapshot(){
  try{ localStorage.removeItem(RESUME_KEY); }catch(e){}
}
function inPlay(){
  return state==='idle'||state==='swapping'||state==='resolving'||state==='collecting'||state==='paused';
}
function autoSave(){ if (inPlay()) saveSnapshot(); }
function resumeSnapshot(){
  const s = loadSnapshot();
  if (!s) return false;
  levelIndex = s.lv;
  gemCount = gemCountFor(s.lv);
  stopCelebrations();
  grid = []; tiles = [];
  for (let r=0;r<ROWS;r++){
    grid.push(new Array(COLS).fill(null));
    tiles.push(s.tiles[r].slice());
  }
  let i = 0;
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
    const cd = s.cells[i++];
    if (!cd) continue;
    const p = cd.k===1 ? makeStone() : makePiece(cd.g);
    if (cd.s) { p.special = cd.s; p._spent = false; }
    grid[r][c] = p;
  }
  timedMode = s.timed;
  score = s.score;
  runSubmitted = !!s.runSubmitted;
  stoneQuota = quotaFor(s.lv);
  stonesCollected = s.stonesCollected;
  stonesToSpawn = s.stonesToSpawn;
  timeMax = timeFor(s.lv);
  timeLeft = timedMode ? Math.min(s.timeLeft, timeMax) : Infinity;
  chain = 0; selected = null; swapInfo = null; pausedFrom = null;
  particles = []; floaters = [];
  resetHint();
  state = 'resolving';   // engine settles, collects any bottom stones, then goes idle
  syncHud(`Resumed level ${s.lv+1}.`);
  hideOverlays();
  return true;
}

/* ---------- helpers ---------- */
const $ = id => document.getElementById(id);
const rnd = n => Math.floor(Math.random()*n);
const inB = (r,c) => r>=0 && r<ROWS && c>=0 && c<COLS;
const beep = (f,d,t,g) => window.SWMusic && SWMusic.beep(f,d,t,g);

function makePiece(gem){ return {kind:'gem', gem, special:null, oy:0, ox:0, vy:0, scale:1, dying:0}; }
function makeStone(){ return {kind:'stone', gem:-1, special:null, oy:0, ox:0, vy:0, scale:1, dying:0}; }

/* ---------- level layouts (size-agnostic) ---------- */
function layerAt(lv, r, c){
  const LR = ROWS-1, LC = COLS-1;
  const m1 = Math.floor(ROWS/2)-1, m2 = Math.floor(ROWS/2);
  const edge = (r===0||r===LR||c===0||c===LC);
  switch(lv){
    case 0:  return 1;
    case 1:  return edge ? 2 : 1;
    case 2:  return ((r+c)%2===0) ? 2 : 1;
    case 3:  return (r===m1||r===m2||c===m1||c===m2) ? 2 : 1;
    case 4:  return ((r<3&&c<3)||(r<3&&c>LC-3)||(r>LR-3&&c<3)||(r>LR-3&&c>LC-3)) ? 2 : 1;
    case 5:  return (r>=ROWS-3) ? 2 : 1;
    case 6:  return (Math.abs(r-c)<=1 || Math.abs(r-(LC-c))<=1) ? 2 : 1;
    case 7:  return (r%2===0) ? 2 : 1;
    case 8:  return (c>=3&&c<=LC-3&&r>=3&&r<=LR-3) ? 1 : 2;
    case 9:  return ((r+c)%2===0) ? 1 : 2;
    case 10: return (r<3||r>LR-3) ? 2 : ((c<3||c>LC-3)?2:1);
    case 11: return (c%2===0) ? 2 : 1;
    case 12: return ((r>=1&&r<=LR-1&&c>=1&&c<=LC-1) && !(r>=m1&&r<=m2&&c>=m1&&c<=m2)) ? 2 : 1;
    default: return 2;
  }
}
function quotaFor(lv){
  if (lv===0) return 2;                       // gentler first level
  return Math.min(3 + Math.floor(lv/2), 8);
}
function timeFor(lv){ return 300; } // 5 minutes per level (flat)
function gemCountFor(lv){ return lv===0 ? 5 : GEM_COUNT; } // 5 colors on level 1 = easier matches

/* ---------- board setup ---------- */
function gemSafeAt(r,c){
  let tries = 0;
  while (true){
    const g = rnd(gemCount);
    const h = c>=2 && grid[r][c-1] && grid[r][c-2] && grid[r][c-1].gem===g && grid[r][c-2].gem===g;
    const v = r>=2 && grid[r-1][c] && grid[r-2][c] && grid[r-1][c].gem===g && grid[r-2][c].gem===g;
    if ((!h && !v) || ++tries>40) return g;
  }
}
function startLevel(lv){
  levelIndex = lv;
  gemCount = gemCountFor(lv);
  stopCelebrations();
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
  resetHint();
  timeMax = timeFor(lv); timeLeft = timedMode ? timeMax : Infinity;
  state = 'idle';
  ensureMoves();
  syncHud(`Level ${lv+1}: shatter every tile, deliver ${stoneQuota} cornerstones.`);
  hideOverlays();
  autoSave();
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
function findHint(){
  const moves = [];
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++){
    if (!grid[r][c] || grid[r][c].kind!=='gem') continue;
    if (c+1<COLS && grid[r][c+1] && grid[r][c+1].kind==='gem' && wouldMatchAfterSwap(r,c,r,c+1))
      moves.push({a:{r,c}, b:{r,c:c+1}});
    if (r+1<ROWS && grid[r+1][c] && grid[r+1][c].kind==='gem' && wouldMatchAfterSwap(r,c,r+1,c))
      moves.push({a:{r,c}, b:{r:r+1,c}});
  }
  return moves.length ? moves[rnd(moves.length)] : null;
}
function resetHint(){ idleT = 0; hintCells = null; }
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
        grid[r][c].gem = rnd(gemCount);
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
      forgedCount++;
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
      if (stonesToSpawn>0 && stonesOnBoard<3 && Math.random()<0.16){
        p = makeStone(); stonesToSpawn--;
      } else {
        let g = rnd(gemCount);
        const below = (r+1<ROWS) ? grid[r+1][c] : null;
        if (below && below.kind==='gem' && Math.random() < REFILL_COPY_BIAS) g = below.gem;
        p = makePiece(g);
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
    clearSnapshot();
    persistProgress();
    syncHud();
    if (lastLevel){
      submitRun();
      startFinale();                          // Egyptian grand finale on the board canvas
      return;
    }
    const t = $('doneTitle'), x = $('doneText');
    if (lastOfWonder){
      t.textContent = WONDERS[wIdx].name.toUpperCase() + ' COMPLETE';
      x.textContent = 'The builders cheer — a wonder rises against the dusk. Onward to the next marvel.';
      $('btnNext').textContent = 'Next Wonder';
    } else {
      t.textContent = 'LEVEL COMPLETE';
      x.textContent = 'The foundation is laid. One more stage will finish this wonder.';
      $('btnNext').textContent = 'Continue';
    }
    beep(523,0.12); setTimeout(()=>beep(659,0.12),120); setTimeout(()=>beep(784,0.2),240);
    $('doneOverlay').classList.add('celebrate');
    $('doneOverlay').classList.remove('hidden');
    startFireworks(4500);
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
  resetHint();
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

  const nowMs = performance.now();
  if (fw.active) stepFireworks(dt, nowMs);
  if (finale.active) stepFinale(dt);

  // hint timer: only ticks while waiting for player input
  if (state==='idle'){
    idleT += dt;
    if (!hintCells && idleT >= HINT_DELAY) hintCells = findHint();
  } else {
    idleT = 0; hintCells = null;
  }

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
          autoSave();   // no-op if the level just completed
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
      else { ensureMoves(); state='idle'; checkComplete(); autoSave(); }
    }
  }

  if (timedMode && (state==='idle'||state==='swapping'||state==='resolving'||state==='collecting')){
    timeLeft -= dt;
    if (timeLeft<=0){
      timeLeft = 0; state='fail';
      clearSnapshot();
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
  if (finale.active){ drawFinale(); return; }
  ctx.save();
  ctx.clearRect(0,0,cv.width,cv.height);
  if (shakeT>0){
    ctx.translate((Math.random()-0.5)*6, (Math.random()-0.5)*6);
  }
  for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) drawTile(r,c);

  ctx.fillStyle = 'rgba(232,198,106,0.10)';
  ctx.fillRect(0, (ROWS-1)*CELL, COLS*CELL, CELL);

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

  // hint: pulsing rings on a valid swap pair after idling
  if (hintCells && state==='idle'){
    const glow = 0.45 + 0.35*Math.sin(performance.now()/200);
    ctx.strokeStyle = `rgba(255,233,173,${glow})`;
    ctx.lineWidth = 3.5;
    for (const cell of [hintCells.a, hintCells.b]){
      const pul = 3+Math.sin(performance.now()/180)*2;
      roundRect(ctx, cell.c*CELL+2-pul/2, cell.r*CELL+2-pul/2, CELL-4+pul, CELL-4+pul, 10);
      ctx.stroke();
    }
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
  if (fw.active) drawFireworks();
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

  drawWorkers(wctx, W, H-18);
}

/* ---------- animated builders (stateless, driven by the clock) ---------- */
function drawWorkers(g, W, groundY){
  const t = performance.now()/1000;
  // three walkers crossing the ground, two carrying cornerstones
  const walkers = [
    {speed:26, off:0,    dir: 1, carry:true },
    {speed:20, off:0.45, dir:-1, carry:false},
    {speed:32, off:0.78, dir: 1, carry:true },
  ];
  for (const w of walkers){
    const span = W + 36;
    let x = ((t*w.speed + w.off*span) % span) - 18;
    if (w.dir<0) x = W - x;
    drawWalker(g, x, groundY, t*7 + w.off*10, w.dir, w.carry);
  }
  // one hammerer working at the base of the wonder
  drawHammerer(g, W*0.42 + 52, groundY, t);
}
function drawWalker(g, x, gy, phase, dir, carry){
  const s = Math.sin(phase), c = Math.cos(phase);
  const bob = Math.abs(s)*1.2;
  const hipY = gy - 7 - bob, headY = gy - 13.5 - bob;
  g.strokeStyle = '#1c1326'; g.fillStyle = '#1c1326';
  g.lineWidth = 1.6; g.lineCap = 'round';
  // legs
  g.beginPath();
  g.moveTo(x, hipY); g.lineTo(x + dir*s*3.2, gy);
  g.moveTo(x, hipY); g.lineTo(x - dir*s*3.2, gy);
  // body
  g.moveTo(x, hipY); g.lineTo(x, headY+2.5);
  // arms (opposite swing; carriers keep one arm up on the load)
  g.moveTo(x, headY+4.5); g.lineTo(x - dir*c*3.0, hipY-1);
  if (carry) { g.moveTo(x, headY+4.5); g.lineTo(x + dir*1.8, headY-1.5); }
  else       { g.moveTo(x, headY+4.5); g.lineTo(x + dir*c*3.0, hipY-1); }
  g.stroke();
  // head
  g.beginPath(); g.arc(x, headY, 2.3, 0, Math.PI*2); g.fill();
  // carried stone block on the shoulder
  if (carry){
    g.fillStyle = '#cfd6df';
    g.fillRect(x + dir*0.5 - 3, headY - 6.5, 6, 4.4);
    g.strokeStyle = '#75808e'; g.lineWidth = 0.8;
    g.strokeRect(x + dir*0.5 - 3, headY - 6.5, 6, 4.4);
  }
}
function drawHammerer(g, x, gy, t){
  const swing = Math.sin(t*5);                 // -1..1 hammer cycle
  const a = -0.5 - Math.max(0, swing)*1.1;     // arm angle: raise then strike
  const hipY = gy - 7, headY = gy - 13.5;
  g.strokeStyle = '#1c1326'; g.fillStyle = '#1c1326';
  g.lineWidth = 1.6; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x, hipY); g.lineTo(x-2.6, gy);
  g.moveTo(x, hipY); g.lineTo(x+2.6, gy);
  g.moveTo(x, hipY); g.lineTo(x, headY+2.5);
  g.moveTo(x, headY+4.5); g.lineTo(x-3, hipY-1); // rear arm
  g.stroke();
  g.beginPath(); g.arc(x, headY, 2.3, 0, Math.PI*2); g.fill();
  // hammer arm + head
  const hx = x + Math.cos(a)*7, hy = headY+4.5 + Math.sin(a)*7;
  g.beginPath(); g.moveTo(x, headY+4.5); g.lineTo(hx, hy); g.stroke();
  g.fillStyle = '#75808e';
  g.fillRect(hx-2.2, hy-2.2, 4.4, 4.4);
  // strike spark at the moment of impact
  if (swing < -0.86){
    g.fillStyle = 'rgba(255,233,173,0.9)';
    g.beginPath(); g.arc(x+7.5, gy-2, 2.1, 0, Math.PI*2); g.fill();
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

/* ---------- fireworks (level complete) ---------- */
function stepFireworks(dt, now){
  if (now < fw.until && now > fw.next && fw.rockets.length < 4){
    fw.rockets.push({
      x: 60 + Math.random()*(COLS*CELL-120),
      y: ROWS*CELL - 10,
      vy: -(330 + Math.random()*100),
      targetY: 60 + Math.random()*(ROWS*CELL*0.35),
      col: GEMS[rnd(GEM_COUNT)].c1,
      trail: [],
    });
    fw.next = now + 280 + Math.random()*370;
  }
  for (let i=fw.rockets.length-1; i>=0; i--){
    const r = fw.rockets[i];
    r.y += r.vy*dt; r.vy += 60*dt;
    r.trail.push({x:r.x, y:r.y}); if (r.trail.length>8) r.trail.shift();
    if (r.y <= r.targetY){
      const n = 70 + rnd(50);
      for (let k=0;k<n;k++){
        const a = Math.random()*Math.PI*2, sp = 40 + Math.random()*170;
        fw.sparks.push({x:r.x, y:r.y, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp,
          life:0.7+Math.random()*0.7, t:0, col: Math.random()<0.35 ? '#ffe9ad' : r.col,
          sz:1.6+Math.random()*1.6});
      }
      fw.rockets.splice(i,1);
    }
  }
  for (let i=fw.sparks.length-1; i>=0; i--){
    const s = fw.sparks[i];
    s.t += dt; s.x += s.vx*dt; s.y += s.vy*dt; s.vy += 170*dt; s.vx *= 0.985;
    if (s.t >= s.life) fw.sparks.splice(i,1);
  }
  if (now >= fw.until && fw.rockets.length===0 && fw.sparks.length===0) fw.active = false;
}
function drawFireworks(){
  for (const r of fw.rockets){
    ctx.strokeStyle = 'rgba(255,233,173,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    r.trail.forEach((p,i)=> i ? ctx.lineTo(p.x,p.y) : ctx.moveTo(p.x,p.y));
    ctx.stroke();
    ctx.fillStyle = '#ffe9ad';
    ctx.beginPath(); ctx.arc(r.x, r.y, 2.4, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalCompositeOperation = 'lighter';
  for (const s of fw.sparks){
    ctx.globalAlpha = Math.max(0, 1 - s.t/s.life);
    ctx.fillStyle = s.col;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.sz, 0, Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/* ---------- Egyptian grand finale (campaign complete) ---------- */
function stepFinale(dt){
  finale.t += dt;
  if (!finale.btnShown && finale.t > 4.5){
    finale.btnShown = true;
    $('finaleOverlay').classList.remove('hidden');
  }
  if (Math.random() < dt*5){
    const kinds = ['ankh','eye','scarab'];
    finale.glyphs.push({kind:kinds[rnd(3)], x:40+Math.random()*(COLS*CELL-80), y:ROWS*CELL-90,
      vy:-(18+Math.random()*16), t:0, life:4+Math.random()*2.5,
      s:0.7+Math.random()*0.55, rot:(Math.random()-0.5)*0.3});
  }
  if (Math.random() < dt*40){
    finale.confetti.push({x:Math.random()*COLS*CELL, y:-6, vy:28+Math.random()*27,
      vx:(Math.random()-0.5)*24, t:0, sz:2+Math.random()*2.2,
      col: Math.random()<0.6 ? '#e8c66a' : '#ffe9ad', spin:2+Math.random()*4});
  }
  const now = performance.now();
  if (now > finale.next){
    const bx = 60+Math.random()*(COLS*CELL-120), by = 50+Math.random()*100;
    for (let i=0;i<60;i++){
      const a = Math.random()*Math.PI*2, sp = 30+Math.random()*140;
      finale.sparks.push({x:bx, y:by, vx:Math.cos(a)*sp, vy:Math.sin(a)*sp,
        t:0, life:0.6+Math.random()*0.6, sz:1.5+Math.random()*1.3});
    }
    finale.next = now + 700 + Math.random()*700;
  }
  for (let i=finale.glyphs.length-1;i>=0;i--){
    const g = finale.glyphs[i]; g.t += dt; g.y += g.vy*dt;
    if (g.t >= g.life) finale.glyphs.splice(i,1);
  }
  for (let i=finale.confetti.length-1;i>=0;i--){
    const c = finale.confetti[i]; c.t += dt; c.y += c.vy*dt; c.x += c.vx*dt;
    if (c.y > ROWS*CELL+8) finale.confetti.splice(i,1);
  }
  for (let i=finale.sparks.length-1;i>=0;i--){
    const s = finale.sparks[i]; s.t += dt; s.x += s.vx*dt; s.y += s.vy*dt; s.vy += 150*dt;
    if (s.t >= s.life) finale.sparks.splice(i,1);
  }
}
function drawFinaleGlyph(g){
  const a = Math.min(1, g.t*2) * Math.max(0, 1-(g.t/g.life));
  ctx.save();
  ctx.translate(g.x, g.y); ctx.rotate(g.rot); ctx.scale(g.s, g.s);
  ctx.globalAlpha = a;
  ctx.strokeStyle = '#ffe9ad'; ctx.fillStyle = '#ffe9ad'; ctx.lineWidth = 2; ctx.lineCap = 'round';
  if (g.kind==='ankh'){
    ctx.beginPath(); ctx.ellipse(0,-9,5,7,0,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,-2); ctx.lineTo(0,14); ctx.moveTo(-7,3); ctx.lineTo(7,3); ctx.stroke();
  } else if (g.kind==='eye'){
    ctx.beginPath(); ctx.moveTo(-10,0); ctx.quadraticCurveTo(0,-9,10,0); ctx.quadraticCurveTo(0,7,-10,0); ctx.stroke();
    ctx.beginPath(); ctx.arc(0,-0.5,2.6,0,Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(4,5); ctx.lineTo(7,13); ctx.moveTo(-2,6); ctx.quadraticCurveTo(-4,12,-9,12); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.ellipse(0,0,6,8,0,0,Math.PI*2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0,-8); ctx.lineTo(0,8); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-6,-3); ctx.quadraticCurveTo(-14,-6,-16,0);
    ctx.moveTo(6,-3); ctx.quadraticCurveTo(14,-6,16,0); ctx.stroke();
    for (const sgn of [-1,1]) for (let i=0;i<3;i++){
      ctx.beginPath(); ctx.moveTo(sgn*5,-4+i*4); ctx.lineTo(sgn*10,-2+i*4.5); ctx.stroke();
    }
  }
  ctx.restore(); ctx.globalAlpha = 1;
}
function drawTorchWalker(x, gy, phase, dir){
  const s = Math.sin(phase);
  const bob = Math.abs(s)*1.2, hipY = gy-7-bob, headY = gy-13.5-bob;
  ctx.strokeStyle = '#14101f'; ctx.fillStyle = '#14101f'; ctx.lineWidth = 1.7; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x,hipY); ctx.lineTo(x+dir*s*3.2,gy);
  ctx.moveTo(x,hipY); ctx.lineTo(x-dir*s*3.2,gy);
  ctx.moveTo(x,hipY); ctx.lineTo(x,headY+2.5);
  ctx.moveTo(x,headY+4.5); ctx.lineTo(x+dir*3.4,headY-4);
  ctx.stroke();
  ctx.beginPath(); ctx.arc(x,headY,2.3,0,Math.PI*2); ctx.fill();
  const fl = 1.6 + Math.sin(phase*5)*0.8;
  ctx.fillStyle = 'rgba(255,200,110,0.95)';
  ctx.beginPath(); ctx.arc(x+dir*3.9, headY-6.2, fl, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = 'rgba(255,240,200,0.8)';
  ctx.beginPath(); ctx.arc(x+dir*3.9, headY-6.2, fl*0.45, 0, Math.PI*2); ctx.fill();
}
function drawFinale(){
  const Wp = COLS*CELL, Hp = ROWS*CELL, T = finale.t;
  const sky = ctx.createLinearGradient(0,0,0,Hp);
  sky.addColorStop(0,'#241a4a'); sky.addColorStop(0.5,'#6e3f6c');
  sky.addColorStop(0.78,'#c4683f'); sky.addColorStop(1,'#7e4029');
  ctx.fillStyle = sky; ctx.fillRect(0,0,Wp,Hp);

  const cxp = Wp/2, apexY = Hp*0.40, sunY = apexY-26;
  ctx.save(); ctx.translate(cxp,sunY); ctx.rotate(T*0.12);
  ctx.strokeStyle = 'rgba(255,225,160,0.30)'; ctx.lineWidth = 3;
  for (let i=0;i<12;i++){ ctx.rotate(Math.PI/6);
    ctx.beginPath(); ctx.moveTo(0,34); ctx.lineTo(0,52+6*Math.sin(T*2+i)); ctx.stroke(); }
  ctx.restore();
  ctx.fillStyle = 'rgba(255,225,160,0.95)';
  ctx.beginPath(); ctx.arc(cxp,sunY,20,0,Math.PI*2); ctx.fill();

  ctx.fillStyle = '#3a2a22'; ctx.fillRect(0,Hp-70,Wp,70);

  ctx.fillStyle = '#231933';
  ctx.beginPath(); ctx.moveTo(cxp-150,Hp-70); ctx.lineTo(cxp,apexY); ctx.lineTo(cxp+150,Hp-70); ctx.closePath(); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath(); ctx.moveTo(cxp,apexY); ctx.lineTo(cxp+150,Hp-70); ctx.lineTo(cxp+44,Hp-70); ctx.closePath(); ctx.fill();
  const beamA = 0.18 + 0.12*Math.sin(T*2.2);
  const beam = ctx.createLinearGradient(0,0,0,apexY);
  beam.addColorStop(0,'rgba(255,233,173,0)'); beam.addColorStop(1,'rgba(255,233,173,'+beamA+')');
  ctx.fillStyle = beam;
  ctx.beginPath(); ctx.moveTo(cxp-7,apexY); ctx.lineTo(cxp-30,0); ctx.lineTo(cxp+30,0); ctx.lineTo(cxp+7,apexY); ctx.closePath(); ctx.fill();

  const dots = Math.min(7, Math.floor(T/0.8));
  for (let i=0;i<7;i++){
    const x = Wp/2+(i-3)*42, y = 30;
    ctx.beginPath(); ctx.arc(x,y,9,0,Math.PI*2);
    if (i<dots){ ctx.fillStyle='#e8c66a'; ctx.shadowColor='#e8c66a'; ctx.shadowBlur=12; ctx.fill(); ctx.shadowBlur=0; }
    else { ctx.strokeStyle='#5b478f'; ctx.lineWidth=1.5; ctx.stroke(); }
  }

  for (let i=0;i<6;i++){
    const speed = 22+i*4, span = Wp+30;
    let x = ((T*speed + i*span/6) % span) - 15;
    drawTorchWalker(x, Hp-26-(i%2)*9, T*7+i*2, i%2 ? -1 : 1);
  }

  for (const g of finale.glyphs) drawFinaleGlyph(g);
  for (const c of finale.confetti){
    ctx.save(); ctx.translate(c.x,c.y); ctx.rotate(c.t*c.spin);
    ctx.fillStyle = c.col; ctx.fillRect(-c.sz/2,-c.sz/4,c.sz,c.sz/2); ctx.restore();
  }
  ctx.globalCompositeOperation = 'lighter';
  for (const s of finale.sparks){
    ctx.globalAlpha = Math.max(0,1-s.t/s.life); ctx.fillStyle = '#ffe9ad';
    ctx.beginPath(); ctx.arc(s.x,s.y,s.sz,0,Math.PI*2); ctx.fill();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';

  const sh = 0.5+0.5*Math.sin(T*3);
  ctx.textAlign = 'center';
  ctx.font = "900 26px Cinzel, Georgia, serif";
  ctx.fillStyle = 'rgb('+(232+Math.floor(23*sh))+','+(198+Math.floor(35*sh))+','+(106+Math.floor(67*sh))+')';
  ctx.shadowColor = 'rgba(232,198,106,0.6)'; ctx.shadowBlur = 16;
  ctx.fillText('ALL SEVEN WONDERS RAISED', Wp/2, Hp-118);
  ctx.shadowBlur = 0;
  ctx.font = "13.5px 'Segoe UI', sans-serif"; ctx.fillStyle = '#f0d6a8';
  ctx.fillText('The ancient world stands complete.', Wp/2, Hp-96);
  ctx.font = "700 17px Cinzel, Georgia, serif"; ctx.fillStyle = '#ffe9ad';
  ctx.fillText('Final score: '+score.toLocaleString(), Wp/2, Hp-72);
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
  ['menuOverlay','doneOverlay','failOverlay','boardOverlay','finaleOverlay','pauseOverlay'].forEach(id=>$(id).classList.add('hidden'));
  $('doneOverlay').classList.remove('celebrate');
}
function showMenu(){
  state='menu'; stopCelebrations(); hideOverlays();
  $('menuOverlay').classList.remove('hidden');
  $('btnContinue').classList.toggle('hidden', profile.unlocked<=0);
  $('btnContinue').textContent = 'Continue · Lv '+(Math.min(profile.unlocked, TOTAL_LEVELS-1)+1);
  const snap = loadSnapshot();
  $('btnResumeGame').classList.toggle('hidden', !snap);
  if (snap) $('btnResumeGame').textContent = 'Resume Game · Lv '+(snap.lv+1);
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
  clearSnapshot();
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
$('btnQuit').addEventListener('click', ()=>{
  if (state==='idle'||state==='swapping'||state==='resolving'||state==='collecting') pauseGame();
  else if (state!=='menu' && state!=='paused') showMenu();
});
$('btnResumePlay').addEventListener('click', unpauseGame);
$('btnEndGame').addEventListener('click', ()=>{
  saveSnapshot();
  showMenu();
  flash('Game saved — Resume Game continues from this exact point.');
});
$('btnResumeGame').addEventListener('click', ()=>{
  if (window.SWMusic) SWMusic.start();
  readName();
  if (!resumeSnapshot()){ flash('No saved game found.'); showMenu(); }
});
$('btnFinaleDone').addEventListener('click', ()=>{ stopCelebrations(); showMenu(); });
$('btnBoard').addEventListener('click', openLeaderboard);
$('btnBoardBack').addEventListener('click', showMenu);
$('btnBoardReset').addEventListener('click', async ()=>{
  const pin = prompt('Admin PIN to reset the leaderboard:');
  if (pin===null || pin==='') return;
  if (!confirm('Permanently delete ALL leaderboard scores?')) return;
  const list = $('boardList');
  list.innerHTML = '<li class="dim">Resetting…</li>';
  try{
    const n = await SWCloud.resetLeaderboard(pin.trim());
    flash(`Leaderboard reset — ${n} score${n===1?'':'s'} removed.`);
    openLeaderboard();
  }catch(e){
    list.innerHTML = '<li class="dim">Reset refused — wrong PIN or offline.</li>';
  }
});

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
  // safety net: persist mid-level progress when the app is backgrounded or closed
  document.addEventListener('visibilitychange', ()=>{ if (document.hidden) autoSave(); });
  window.addEventListener('pagehide', ()=>{ autoSave(); });
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
