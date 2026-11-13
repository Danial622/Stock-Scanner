'use strict';

// ─────────────────────────────────────────────────────────────
//  TSE Quant Engine — Scanner v2.3  (reliability release)
//  Optimized for GitHub Actions execution (faster, shorter pool)
// ─────────────────────────────────────────────────────────────

const fs   = require('fs');
const path = require('path');

const BASE       = 'https://cdn.tsetmc.com/api';
const CACHE_FILE = path.join(__dirname, 'daily_signals.json');
const HIST_FILE  = path.join(__dirname, 'history_cache.json');
const FUND_FILE  = path.join(__dirname, 'fund_cache.json');
const FD = require('./tse-fundamentals');

const CFG = {
  POOL_SIZE     : 20,      // Reduced from 80. Scan the top 20 by volume (much faster)
  CONCURRENCY   : 4,       // parallel history workers
  PER_PROXY_MAX : 2,       // max simultaneous requests per proxy
  EXHAUST_COOLDOWN: 60_000,// after a probe round finds nothing, pause probing this long
  MF_TOP        : 10,      // top 10 setups that get real/institutional money-flow enrichment
  FUND_TOP      : 10,      // top 10 setups that get fundamentals (TSETMC EPS/P-E + Codal)
  FUND_TTL      : 24*3600_000, // fundamentals cache lifetime
  CODAL_DAYS    : 200,     // how far back to read Codal disclosures
  MW_TTL        : 15*60_000, // reuse market-watch snapshot
  HIST_DAYS     : 300,     // days of history kept
  MIN_HIST      : 60,      // need ≥60 days for EMA50
  REQ_TIMEOUT   : 15000,   // Increased to 15s to give slow proxies a chance
  ATTEMPTS      : 3,       // Reduced from 5. Fail faster on dead proxies
  WANT_HEALTHY  : 6,       // healthy proxies to keep warm
  PROBE_BATCH   : 40,      // proxies probed in parallel
  MAX_SCAN_MS   : 45 * 60_000, // Increased to 45 mins to ensure completion
  RETRY_MIN     : 10,      // scheduler retry interval (minutes)
};

const fetchFn = (() => { try { return require('node-fetch'); } catch (_) { return global.fetch || null; } })();
let HttpsProxyAgent; try { HttpsProxyAgent = require('https-proxy-agent').HttpsProxyAgent; } catch (_) {}
let _fetch = fetchFn;                       // swappable for tests

// ── scan state ───────────────────────────────
const scanState = { isScanning:false, progress:0, logs:[], logTotal:0, error:null, startedAt:null, lastAttemptAt:0 };
let inFlight = null;

const delay = ms => new Promise(r => setTimeout(r, ms));
function num(...vals){ for (const v of vals){ const n=Number(v); if (v!==null&&v!==undefined&&v!==''&&Number.isFinite(n)) return n; } return 0; }
function log(msg){
  const ts = new Date().toLocaleTimeString('en-US',{hour12:false,timeZone:'Asia/Tehran'});
  const line = `[${ts}] ${msg}`; console.log(line);
  scanState.logs.push(line); scanState.logTotal++;
  if (scanState.logs.length > 500) scanState.logs.shift();
}

// Arabic → Persian letters (TSETMC returns ي ك)
const norm = s => String(s||'').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/ة/g,'ه').replace(/[\u200c]/g,' ').replace(/\s+/g,' ').trim();

// ── indicators ───────────────────────────────
function ema(p,n){ if(p.length<n) return null; const k=2/(n+1); let v=p.slice(0,n).reduce((a,b)=>a+b,0)/n; for(let i=n;i<p.length;i++) v=p[i]*k+v*(1-k); return v; }
function emaArray(p,n){ if(p.length<n) return []; const k=2/(n+1); const o=[]; let v=p.slice(0,n).reduce((a,b)=>a+b,0)/n; o.push(v); for(let i=n;i<p.length;i++){ v=p[i]*k+v*(1-k); o.push(v);} return o; }
function rsi(p,n=14){ if(p.length<=n) return 50; let g=0,l=0; for(let i=1;i<=n;i++){ const d=p[i]-p[i-1]; d>=0?g+=d:l-=d; } let ag=g/n, al=l/n; for(let i=n+1;i<p.length;i++){ const d=p[i]-p[i-1]; ag=(ag*(n-1)+(d>0?d:0))/n; al=(al*(n-1)+(d<0?-d:0))/n; } return al===0?100:100-100/(1+ag/al); }
function macd(p){ if(p.length<35) return {macd:0,signal:0,histogram:0}; const a=emaArray(p,12), b=emaArray(p,26), len=Math.min(a.length,b.length); const line=[]; for(let i=0;i<len;i++) line.push(a[a.length-len+i]-b[b.length-len+i]); const sig=emaArray(line,9); const m=line[line.length-1], s=sig[sig.length-1]||0; return {macd:m,signal:s,histogram:m-s}; }
function bollinger(p,n=20,mult=2){ if(p.length<n) return null; const s=p.slice(-n), mean=s.reduce((a,b)=>a+b,0)/n, sd=Math.sqrt(s.reduce((t,x)=>t+(x-mean)**2,0)/n); return {upper:mean+mult*sd,mid:mean,lower:mean-mult*sd}; }
function atr(h,l,c,n=14){ if(c.length<n+1) return c[c.length-1]*0.03; const t=[]; for(let i=1;i<c.length;i++){ const hi=h[i]||c[i], lo=l[i]||c[i]; t.push(Math.max(hi-lo,Math.abs(hi-c[i-1]),Math.abs(lo-c[i-1]))); } const s=t.slice(-n); return s.reduce((a,b)=>a+b,0)/s.length; }

// ── sectors ──────────────────────────────────
const SECTOR_MAP = {
  'شپنا':'پالایشگاهی / Refinery','شبندر':'پالایشگاهی / Refinery','شتران':'پالایشگاهی / Refinery','شبریز':'پالایشگاهی / Refinery','شراز':'پالایشگاهی / Refinery','شاوان':'پالایشگاهی / Refinery','شسپا':'پالایشگاهی / Refinery',
  'فارس':'پتروشیمی / Petrochem','تاپیکو':'پتروشیمی / Petrochem','شیراز':'پتروشیمی / Petrochem','شفن':'پتروشیمی / Petrochem','شپدیس':'پتروشیمی / Petrochem','جم':'پتروشیمی / Petrochem','مارون':'پتروشیمی / Petrochem','نوری':'پتروشیمی / Petrochem','شکیمیا':'پتروشیمی / Petrochem','شبصیر':'پتروشیمی / Petrochem','شهرن':'پتروشیمی / Petrochem','شبهرن':'پتروشیمی / Petrochem',
  'فملی':'فلزات / Metals','فولاد':'فلزات / Metals','فخوز':'فلزات / Metals','فباهنر':'فلزات / Metals','فکور':'فلزات / Metals','فزر':'فلزات / Metals','فنقره':'فلزات / Metals','فاذر':'فلزات / Metals','ذوب':'فلزات / Metals','کاما':'فلزات / Metals','تابان':'فلزات / Metals',
  'کگل':'معدن / Mining','کچاد':'معدن / Mining','کگهر':'معدن / Mining','ومعادن':'معدن / Mining','کخاک':'معدن / Mining',
  'وبملت':'بانک / Banking','وپاسار':'بانک / Banking','وتجارت':'بانک / Banking','وصادرات':'بانک / Banking','ونوین':'بانک / Banking','وبصادر':'بانک / Banking','وخاور':'بانک / Banking',
  'شستا':'سرمایه‌گذاری / Investment','وخارزم':'سرمایه‌گذاری / Investment','وامید':'سرمایه‌گذاری / Investment','ساحل':'سرمایه‌گذاری / Investment',
  'خودرو':'خودرو / Automotive','خساپا':'خودرو / Automotive','خگستر':'خودرو / Automotive','خزامیا':'خودرو / Automotive','خگلپا':'خودرو / Automotive',
  'دزاگرس':'دارو / Pharma','داروند':'دارو / Pharma','دسبحا':'دارو / Pharma','دسبحان':'دارو / Pharma','دیران':'دارو / Pharma',
};
const SECTOR_RULES=[
  [/بانک/,'بانک / Banking'],[/پالایش|فرآورده.{0,3}نفتی/,'پالایشگاهی / Refinery'],[/پتروشیمی|شیمیایی/,'پتروشیمی / Petrochem'],
  [/فولاد|آلومینیوم|نورد|ذوب|فلزات|(^|\s)(مس|روی)(\s|$)/,'فلزات / Metals'],
  [/معدن|سنگ آهن|معدنی|کانه|استخراج/,'معدن / Mining'],[/دارو|داروسازی|دارویی/,'دارو / Pharma'],[/سیمان/,'سیمان / Cement'],
  [/خودرو|زامیاد|سایپا/,'خودرو / Automotive'],[/بیمه/,'بیمه / Insurance'],
  [/مخابرات|ارتباطات|همراه|فناوری|نرم افزار|فن افزار|رایانه/,'مخابرات و IT / Telecom & IT'],
  [/حفاری|خدمات نفت|مهندسی نفت/,'خدمات نفت / Oil Services'],
  [/کشاورز|دامپرور|ماکیان|مرغ|لبنیات|قند|شکر|روغن|غذایی|گوشت|زراعت|آشامیدنی/,'غذایی و کشاورزی / Food & Agri'],
  [/ساختمان|عمران|مسکن|املاک|سازه/,'ساختمان / Construction'],
  [/سرمایه گذاری|هلدینگ/,'سرمایه‌گذاری / Investment'],
];
function sectorFromName(name){ for(const [re,n] of SECTOR_RULES) if(re.test(name)) return n; return name; }
function getSector(sym, company){
  if (SECTOR_MAP[sym]) return SECTOR_MAP[sym];
  const c=company||'';
  for(const [re,name] of SECTOR_RULES) if(re.test(c)) return name;
  return 'سایر / Other';
}

// ── scoring & levels ─────────────────────────
function scoreStock(closes, price, value, changePct){
  let score=0; const d=[];
  const e20=ema(closes,20), e50=ema(closes,50), e200=closes.length>=200?ema(closes,200):null;
  const r=rsi(closes,14), m=macd(closes), bb=bollinger(closes,20);
  if(e20&&price>e20){score+=10;d.push('P>EMA20 +10');}
  if(e50&&price>e50){score+=10;d.push('P>EMA50 +10');}
  if(e200&&price>e200){score+=8;d.push('P>EMA200 +8');}
  if(e20&&e50&&e20>e50){score+=7;d.push('GoldenX +7');}
  if(r>=50&&r<=65){score+=15;d.push(`RSI${r.toFixed(0)} +15`);} else if(r>65&&r<=70){score+=8;d.push(`RSI${r.toFixed(0)} +8`);} else if(r>40&&r<50){score+=5;d.push(`RSI${r.toFixed(0)} +5`);}
  if(m.macd>0&&m.histogram>0){score+=15;d.push('MACD bull +15');} else if(m.macd>0){score+=7;d.push('MACD+ +7');} else if(m.histogram>0){score+=5;d.push('MACDhist+ +5');}
  if(bb){ if(price>bb.upper){score+=5;d.push('BBBreakout +5');} else if(price>bb.mid&&price<=bb.upper){score+=10;d.push('BBMidUp +10');} else if(price>bb.lower&&price<=bb.mid){score+=3;d.push('BBLow +3');} }
  if(value>=30){score+=10;d.push('Liq>30B +10');} else if(value>=10){score+=6;d.push('Liq>10B +6');} else if(value>=3){score+=3;d.push('Liq>3B +3');}
  if(changePct>=1&&changePct<=4){score+=15;d.push('Mom1-4% +15');} else if(changePct>0&&changePct<1){score+=8;d.push('Mom+% +8');} else if(changePct>4&&changePct<6){score+=6;d.push('Mom4-6% +6');} else if(changePct>=-1&&changePct<0){score+=3;d.push('MomFlat +3');}
  if(e20&&price>e20*1.12){score-=10;d.push('Extended >12% above EMA20 -10');}
  if(r>75){score-=8;d.push(`RSI${r.toFixed(0)} overbought -8`);}
  return {score:Math.max(0,Math.min(100,score)),details:d};
}
function tradeLevels(closes,highs,lows,price){
  const a=atr(highs,lows,closes,14);
  let sl=Math.round(price-1.5*a); if(sl<=0||sl>=price) sl=Math.round(price*0.95);
  const risk=price-sl;
  const resistance=Math.max(...highs.slice(-60)), support=Math.min(...lows.slice(-20));
  const rr = resistance>price*1.005 ? `1:${((resistance-price)/risk).toFixed(1)}` : 'Breakout';
  return {stopLoss:sl,target1:Math.round(price+1.5*risk),target2:Math.round(price+2.5*risk),target3:Math.round(price+4*risk),riskReward:rr,resistance,support,atr:Math.round(a)};
}

// ── HTTP: timeout covers headers AND body ────
async function getJSON(url, agent=null, timeoutMs=CFG.REQ_TIMEOUT, extra={}){
  const ctrl=new AbortController(); const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const opts={ signal:ctrl.signal, headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':'application/json, text/plain, */*','Accept-Language':'fa-IR,fa;q=0.9,en;q=0.8',
      'Referer':'https://tsetmc.com/','Origin':'https://tsetmc.com','Cache-Control':'no-cache'}};
    if(agent) opts.agent=agent;
    Object.assign(opts.headers,extra);
    const res=await _fetch(url,opts);
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();                       // ← still inside the timer
  }catch(e){
    if(e.name==='AbortError'||/abort/i.test(e.message)) throw new Error('timeout');
    throw e;
  }finally{ clearTimeout(timer); }
}
async function getText(url, timeoutMs=8000){
  const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{ const r=await _fetch(url,{signal:ctrl.signal,headers:{'User-Agent':'Mozilla/5.0'}}); if(!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); }
  finally{ clearTimeout(t); }
}

async function loadProxyList(){
  const sources=[
    'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/IR/data.txt',
    'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=ir&ssl=all&anonymity=all',
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  ];
  const all=new Set(), iran=new Set();
  await Promise.allSettled(sources.map(async (src,idx)=>{
    try{ const t=await getText(src);
      for(const line of t.split('\n')){ const m=line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{2,5})/); if(m){ const p=`${m[1]}:${m[2]}`; all.add(p); if(idx<2) iran.add(p);} }
    }catch(_){}
  }));
  const shuffle=a=>a.sort(()=>Math.random()-0.5);
  const first=shuffle([...iran]); const rest=shuffle([...all].filter(p=>!iran.has(p)));
  return [...first,...rest];
}

// ── Proxy pool: probe, cap concurrency per proxy, rotate, bench failures ──
class ProxyPool {
  constructor(){ this.queue=null; this.healthy=[]; this.busy=null; this.url=null; this.validate=()=>true; this.exhaustedUntil=0; }
  configure(url,validate){ this.url=url; this.validate=validate; }
  alive(){ return this.healthy.filter(e=>e.fails<3); }
  addDirect(){ this.healthy.push({proxy:'Direct',agent:null,fails:0,inflight:0,used:0}); }
  async acquire(){
    const t0=Date.now();
    for(;;){
      const a=this.alive(); if(!a.length) return null;
      const free=a.filter(e=>e.inflight<CFG.PER_PROXY_MAX).sort((x,y)=>x.inflight-y.inflight||x.used-y.used)[0];
      if(free){ free.inflight++; free.used++; return free; }
      if(Date.now()-t0>30000) return null;
      await delay(100);
    }
  }
  release(e,ok){ e.inflight=Math.max(0,e.inflight-1); if(ok===true) e.fails=0; else if(ok===false) e.fails++; }
  async probe(proxy,keep){
    const agent=new HttpsProxyAgent(`http://${proxy}`);
    const json=await getJSON(this.url,agent,10000);
    if(!this.validate(json)) throw new Error('invalid');
    const e={proxy,agent,fails:0,inflight:0,used:0}; if(keep) e.data=json; return e;
  }
  async replenish(want=CFG.WANT_HEALTHY,{keep=false,maxBatches=8}={}){
    if(this.busy) return this.busy;
    if(Date.now()<this.exhaustedUntil) return;
    this.busy=(async()=>{
      if(!HttpsProxyAgent) throw new Error('https-proxy-agent not installed (npm i https-proxy-agent)');
      if(!this.queue){ log('Fetching proxy list...'); this.queue=await loadProxyList(); log(`Got ${this.queue.length} proxies`); }
      let b=0, added=0;
      while(this.alive().length<want && this.queue.length && b<maxBatches){
        const batch=this.queue.splice(0,CFG.PROBE_BATCH); b++;
        const res=await Promise.allSettled(batch.map(p=>this.probe(p,keep)));
        const ok=res.filter(r=>r.status==='fulfilled').map(r=>r.value);
        this.healthy.push(...ok); added+=ok.length;
        log(`Probe batch ${b}: ${ok.length}/${batch.length} OK (healthy ${this.alive().length}, ${this.queue.length} untested)`);
      }
      if(added===0){ this.exhaustedUntil=Date.now()+CFG.EXHAUST_COOLDOWN; log(`No working proxies found — pausing probes ${CFG.EXHAUST_COOLDOWN/1000}s`); }
    })().finally(()=>{ this.busy=null; });
    return this.busy;
  }
}

// ── market watch ─────────────────────────────
const MW_PARAMS=new URLSearchParams({market:'0','paperTypes[0]':'1','paperTypes[1]':'2','paperTypes[2]':'3','paperTypes[3]':'4','paperTypes[4]':'5','paperTypes[5]':'6','paperTypes[6]':'7','paperTypes[7]':'8','paperTypes[8]':'9',withBestLimits:'false',hEven:'0',RefID:'0'});
const MW_URL=`${BASE}/ClosingPrice/GetMarketWatch?${MW_PARAMS}`;
const mwRows = j => Array.isArray(j)?j:(Object.values(j||{}).find(v=>Array.isArray(v))||[]);

let mwCache={t:0,raw:null,proxy:null};
async function fetchMarketWatch(pool){
  if(mwCache.raw && Date.now()-mwCache.t<CFG.MW_TTL){
    log(`Reusing market-watch snapshot from ${Math.round((Date.now()-mwCache.t)/1000)}s ago`);
    if(mwCache.proxy==='Direct') pool.addDirect();
    return {raw:mwCache.raw,proxy:mwCache.proxy};
  }
  log('Trying direct connection to TSETMC...');
  try{
    const raw=mwRows(await getJSON(MW_URL,null,15000));
    if(raw.length>3000){ log(`✅ Direct OK — ${raw.length} instruments`); pool.addDirect(); mwCache={t:Date.now(),raw,proxy:'Direct'}; return {raw,proxy:'Direct'}; }
  }catch(e){ log(`Direct failed: ${e.message}`); }

  pool.configure(MW_URL, j=>mwRows(j).length>3000);
  await pool.replenish(1,{keep:true,maxBatches:80});
  const e=pool.alive().find(x=>x.data);
  if(!e) throw new Error('All connection methods failed. TSETMC is unreachable from this server.');
  const raw=mwRows(e.data); pool.healthy.forEach(x=>{delete x.data;});
  log(`✅ Proxy ${e.proxy} — ${raw.length} instruments`);
  mwCache={t:Date.now(),raw,proxy:e.proxy};
  return {raw,proxy:e.proxy};
}

// ── history (cached, pooled) ─────────────────
function loadHistCache(){
  const today=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tehran'});
  try{ const j=JSON.parse(fs.readFileSync(HIST_FILE,'utf8')); if(j.date===today) return j; }catch(_){}
  return {date:today,items:{}};
}
function saveHistCache(h){ try{ fs.writeFileSync(HIST_FILE,JSON.stringify(h)); }catch(_){} }

async function fetchHistoryOnce(insCode,agent){
  const j=await getJSON(`${BASE}/ClosingPrice/GetClosingPriceDailyList/${insCode}/0`,agent);
  const days=(j.closingPriceDaily||[]).slice().reverse().slice(-CFG.HIST_DAYS);   // oldest → newest
  const closes=[],highs=[],lows=[];
  for(const d of days){ const c=Math.round(num(d.pClosing,d.pcl)/10); if(c<=0) continue; closes.push(c); highs.push(Math.round(num(d.priceMax,d.pClosing)/10)||c); lows.push(Math.round(num(d.priceMin,d.pClosing)/10)||c); }
  if(closes.length<CFG.MIN_HIST){ const e=new Error(`only ${closes.length} days of history`); e.permanent=true; throw e; }
  return {closes,highs,lows};
}
async function withProxy(pool,fn,{attempts=CFG.ATTEMPTS,penalize=true}={}){
  let last;
  for(let a=0;a<attempts;a++){
    let e=await pool.acquire();
    if(!e){ await pool.replenish(CFG.WANT_HEALTHY,{maxBatches:3}); e=await pool.acquire(); if(!e) break; }
    try{ const r=await fn(e.agent); pool.release(e,true); return r; }
    catch(err){ last=err; if(err.permanent){ pool.release(e,true); throw err; } pool.release(e,penalize?false:null); }
  }
  throw last||new Error('no healthy proxy');
}
async function getHistory(stock,pool,hc){
  if(hc.items[stock.insCode]) return hc.items[stock.insCode];
  const r=await withProxy(pool,agent=>fetchHistoryOnce(stock.insCode,agent));
  hc.items[stock.insCode]=r; return r;
}
// Real (حقیقی) vs legal/institutional (حقوقی) buy/sell volumes for today.
async function fetchClientType(insCode,agent){
  const j=await getJSON(`${BASE}/ClientType/GetClientType/${insCode}/1/0`,agent);
  const c=j.clientType||j;
  const bi=num(c.buy_I_Volume),si=num(c.sell_I_Volume),bn=num(c.buy_N_Volume),sn=num(c.sell_N_Volume);
  const ci=num(c.buy_CountI),csi=num(c.sell_CountI);
  if(bi+si+bn+sn===0){ const e=new Error('no client-type data'); e.permanent=true; throw e; }
  const instNet=(bn+sn)>0?(bn-sn)/(bn+sn)*100:0;
  const realPower=(bi/Math.max(ci,1))/Math.max(si/Math.max(csi,1),1e-9);
  return {instNet:+instNet.toFixed(1),realPower:+Math.min(realPower,99).toFixed(2)};
}
function recFor(score){ return score>=85?'Strong Buy':score>=65?'Buy':score>=45?'Watchlist':'Avoid'; }
function applyMoneyFlow(s,mf){
  let adj=0; const d=[];
  if(mf.instNet>=10){adj+=5;d.push(`InstFlow ${mf.instNet}% +5`);} else if(mf.instNet<=-10){adj-=5;d.push(`InstFlow ${mf.instNet}% -5`);}
  if(mf.realPower>=1.5){adj+=5;d.push(`RealPower ${mf.realPower} +5`);} else if(mf.realPower<0.7){adj-=5;d.push(`RealPower ${mf.realPower} -5`);}
  s.score=Math.max(0,Math.min(100,s.score+adj)); s.recommendation=recFor(s.score);
  s.smartMoneyFlow=String(mf.instNet); s.realPower=mf.realPower;
  if(d.length) s.scoreDetails+=' | '+d.join(' | ');
}
async function runPool(items,n,fn){ const q=[...items]; await Promise.all(Array.from({length:n},async()=>{ while(q.length) await fn(q.shift()); })); }

// ── fundamentals: TSETMC EPS/P-E + Codal disclosures (cached 24h) ──
function loadFundCache(){ try{ return JSON.parse(fs.readFileSync(FUND_FILE,'utf8')); }catch(_){ return {items:{}}; } }
function saveFundCache(c){ try{ fs.writeFileSync(FUND_FILE,JSON.stringify(c)); }catch(_){} }
async function getFundamentals(st,pool,fc,codal){
  const now=Date.now(); let c=fc.items[st.symbol];
  if(!c||now-c.t>=CFG.FUND_TTL) c={t:now,info:null,letters:null};
  if(!c.info){
    try{ c.info=FD.parseInstrumentInfo(await withProxy(pool,agent=>getJSON(`${BASE}/Instrument/GetInstrumentInfo/${st.insCode}`,agent),{attempts:3})); }catch(_){}
  }
  if(!c.letters && !codal.disabled){
    try{
      const {from,to}=FD.codalRange(CFG.CODAL_DAYS);
      const j=await withProxy(pool,agent=>getJSON(FD.codalUrl(st.symbol,from,to,1),agent,CFG.REQ_TIMEOUT,{Referer:'https://codal.ir/',Origin:'https://codal.ir'}),{attempts:2,penalize:false});
      c.letters=FD.parseLetters(j).slice(0,60); codal.ok++; codal.fails=0;
    }catch(e){
      codal.fails++;
      if(codal.ok===0&&codal.fails>=4&&!codal.disabled){ codal.disabled=true; log('⚠ Codal unreachable from this connection — continuing with TSETMC EPS/P-E only'); }
    }
  }
  if(c.info||c.letters) fc.items[st.symbol]=c;
  if(!c.info&&!c.letters) return null;
  const summary=c.letters?FD.summarize(c.letters):null;
  const f=FD.scoreFundamentals({priceRial:st.price*10,info:c.info,summary});
  if(f){ f.codal=!!c.letters; f.letterCount=c.letters?c.letters.length:0; f.recent=summary?summary.recent:[]; }
  return f;
}
function applyFundamentals(s,f){
  const base=s.baseScore!=null?s.baseScore:s.score;
  Object.assign(s,{techScore:base,fundScore:f.fundScore,fundFlags:f.flags,pe:f.pe,fwdPE:f.fwdPE,sectorPE:f.sectorPE,epsGrowth:f.epsGrowth,
    codalLetters:f.letterCount,fundRecent:f.recent,fundDetails:f.details.join(' | ')});
  s.score=Math.max(0,Math.min(100,base+f.adj));
  let rec=recFor(s.score); if(f.veto&&(rec==='Strong Buy'||rec==='Buy')) rec='Watchlist';
  s.recommendation=rec;
  if(f.adj) s.scoreDetails+=` | Fundamentals ${f.adj>0?'+':''}${f.adj}`;
  if(f.sectorName) s.sector=sectorFromName(f.sectorName);
}

// ── candidate filter (equities only) ─────────
const BAD_WORDS=['اختیار','حق تقدم','مرابحه','اجاره','اسناد','گواهی','سلف','خزانه','اخزا','آتی','سکه','طلا','سپرده','اوراق','تسهیلات'];
const FUND_RE=/^ص\.|ص\.س|اهرم|صندوق|\bETF\b/;
function isValidCandidate(s){
  if(!s.symbol||s.price<=0||s.value<2) return false;
  if(/\d/.test(s.symbol)) return false;
  if(/^[ضطص]/.test(s.symbol)) return false;
  if(FUND_RE.test(s.company)||FUND_RE.test(s.symbol)) return false;
  if(Math.abs(s.changePct)>50) return false;
  if(BAD_WORDS.some(w=>s.company.includes(w))) return false;
  return true;
}

// ── persistence ──────────────────────────────
function saveResult(d){ try{ fs.writeFileSync(CACHE_FILE,JSON.stringify(d,null,2)); }catch(e){ console.error('cache write failed',e.message);} }
function loadResult(){ try{ if(fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); }catch(_){} return null; }
function isTodayTehran(iso){ if(!iso) return false; const f=d=>new Date(d).toLocaleDateString('en-CA',{timeZone:'Asia/Tehran'}); return f(iso)===f(Date.now()); }

// ── analysis of one stock ────────────────────
function analyze(stock,{closes,highs,lows}){
  const {score,details}=scoreStock(closes,stock.price,stock.value,stock.changePct);
  const lv=tradeLevels(closes,highs,lows,stock.price);
  const m=macd(closes), e20=ema(closes,20)||0, e50=ema(closes,50)||0, e200=closes.length>=200?ema(closes,200):null;
  return {...stock, rsi:Math.round(rsi(closes,14)), macdHist:+(m.histogram/stock.price*100).toFixed(2),
    ema20:Math.round(e20), ema50:Math.round(e50), ema200:e200?Math.round(e200):null,
    score, scoreDetails:details.join(' | '), entry:stock.price, ...lv,
    recommendation:recFor(score), smartMoneyFlow:'—', realPower:null};
}

// ── orchestrator ─────────────────────────────
async function executeScan(){
  if(scanState.isScanning) return;
  Object.assign(scanState,{isScanning:true,logs:[],logTotal:0,error:null,progress:0,startedAt:new Date().toISOString(),lastAttemptAt:Date.now()});
  const deadline=Date.now()+CFG.MAX_SCAN_MS;
  const pool=new ProxyPool();
  try{
    log('=== TSE Quant Engine v2.3 — Scan Starting ===');
    scanState.progress=3;
    const {raw,proxy}=await fetchMarketWatch(pool);
    scanState.progress=15;

    const candidates=raw.map(r=>{
      const sym=norm(r.lva||r.lVal18AFC), company=norm(r.lvc||r.lVal30||sym);
      const last=Math.round(num(r.pdv,r.pDrCotVal,r.pcl,r.pc)/10), prev=Math.round(num(r.py,r.priceYesterday)/10);
      return {symbol:sym,company,sector:getSector(sym,company),insCode:r.insCode,price:last,
        changePct:prev>0?(last-prev)/prev*100:0, value:Math.round(num(r.qtc,r.qTotCap)/1e10)};
    }).filter(isValidCandidate).sort((a,b)=>b.value-a.value);

    const seen=new Set(); const POOL=[];
    for(const c of candidates){ if(seen.has(c.symbol)) continue; seen.add(c.symbol); POOL.push(c); if(POOL.length>=CFG.POOL_SIZE) break; }
    log(`Equity filter: ${POOL.length} candidates kept from ${raw.length} instruments`);

    const hc=loadHistCache();
    const cached=POOL.filter(s=>hc.items[s.insCode]).length;
    if(cached) log(`History cache hit: ${cached}/${POOL.length}`);
    const histProbe=POOL.find(s=>!hc.items[s.insCode]);
    if(histProbe){
      pool.configure(`${BASE}/ClosingPrice/GetClosingPriceDailyList/${histProbe.insCode}/0`, j=>Array.isArray(j.closingPriceDaily)&&j.closingPriceDaily.length>0);
      const want = proxy==='Direct' ? 1 : CFG.WANT_HEALTHY;
      if(pool.alive().length<want) await pool.replenish(want);
      if(!pool.alive().length) throw new Error('No healthy connection for history requests.');
      log(`Pool ready: ${pool.alive().length} healthy connection(s)`);
    }
    scanState.progress=25;

    const scored=[], failed=[]; let done=0;
    const runQueue=async (queue)=>{
      const worker=async ()=>{
        while(queue.length && Date.now()<deadline){
          const stock=queue.shift();
          try{ scored.push(analyze(stock,await getHistory(stock,pool,hc))); }
          catch(e){ failed.push(stock); if(!e.permanent) log(`⚠ ${stock.symbol}: ${e.message}`); }
          done++; scanState.progress=Math.min(92,25+Math.round(done/(POOL.length*1.3)*67));
          if(done%10===0) saveHistCache(hc);
        }
      };
      await Promise.all(Array.from({length:CFG.CONCURRENCY},worker));
    };

    await runQueue([...POOL]);
    log(`Pass 1: ${scored.length}/${POOL.length} analyzed`);
    const retry=failed.splice(0).filter(s=>!hc.items[s.insCode]);
    if(retry.length && Date.now()<deadline){
      log(`Retrying ${retry.length} failed stock(s) on fresh connections...`);
      await pool.replenish(CFG.WANT_HEALTHY).catch(()=>{});
      await runQueue(retry);
      log(`Pass 2: ${scored.length}/${POOL.length} analyzed`);
    }
    saveHistCache(hc);

    scored.sort((a,b)=>b.score-a.score);
    const mfTargets=scored.slice(0,CFG.MF_TOP); let mfOk=0;
    if(mfTargets.length && Date.now()<deadline){
      if(!pool.url) pool.configure(`${BASE}/ClosingPrice/GetClosingPriceDailyList/${mfTargets[0].insCode}/0`, j=>Array.isArray(j.closingPriceDaily)&&j.closingPriceDaily.length>0);
      log(`Fetching real/institutional money flow for top ${mfTargets.length}...`);
      await runPool(mfTargets,CFG.CONCURRENCY,async st=>{
        try{ applyMoneyFlow(st,await withProxy(pool,agent=>fetchClientType(st.insCode,agent))); mfOk++; }catch(_){}
      });
      log(`Money-flow data: ${mfOk}/${mfTargets.length} stocks`);
    }

    const fundTargets=[...scored].sort((a,b)=>b.score-a.score).slice(0,CFG.FUND_TOP);
    let fundOk=0, codalOk=0; const codalState={ok:0,fails:0,disabled:false};
    if(fundTargets.length && Date.now()<deadline){
      if(!pool.url) pool.configure(`${BASE}/ClosingPrice/GetClosingPriceDailyList/${fundTargets[0].insCode}/0`, j=>Array.isArray(j.closingPriceDaily)&&j.closingPriceDaily.length>0);
      fundTargets.forEach(st=>{ st.baseScore=st.score; });
      log(`Fetching fundamentals (TSETMC EPS/P-E + Codal) for top ${fundTargets.length}...`);
      const fc=loadFundCache();
      await runPool(fundTargets,CFG.CONCURRENCY,async st=>{
        try{ const f=await getFundamentals(st,pool,fc,codalState); if(f){ applyFundamentals(st,f); fundOk++; if(f.codal) codalOk++; } }catch(_){}
      });
      saveFundCache(fc);
      log(`Fundamentals: ${fundOk}/${fundTargets.length} stocks | Codal disclosures: ${codalOk}/${fundTargets.length}${codalState.disabled?' (Codal unreachable)':''}`);
    }
    const codalStatus=codalState.disabled?'unreachable':codalOk>0?'ok':'none';

    if(!scored.length) throw new Error('No stocks returned valid history data.');
    scored.sort((a,b)=>b.score-a.score);
    const result={updatedAt:new Date().toISOString(),proxy,totalScanned:scored.length,poolSize:POOL.length,fundCoverage:`${fundOk}/${fundTargets.length}`,codalStatus,data:scored.slice(0,10)};
    saveResult(result);
    scanState.progress=100;
    log(`🎉 Scan complete — ${scored.length}/${POOL.length} stocks analyzed, top ${result.data.length} saved.`);
    return result;
  }catch(err){
    log(`❌ FATAL: ${err.message}`); scanState.error=err.message; throw err;
  }finally{ scanState.isScanning=false; inFlight=null; }
}

// ── scheduler: after 17:00 Tehran, retry until today's scan exists ──
function schedulerTick(){
  const h=+new Date().toLocaleString('en-US',{timeZone:'Asia/Tehran',hour12:false,hour:'numeric'})%24;
  const cached=loadResult();
  const sinceLast=(Date.now()-scanState.lastAttemptAt)/60000;
  if(h>=17 && !(cached&&isTodayTehran(cached.updatedAt)) && !scanState.isScanning && sinceLast>=CFG.RETRY_MIN){
    log('[Scheduler] Starting daily scan...'); inFlight=executeScan().catch(()=>{});
  }
}
setInterval(schedulerTick,60_000).unref();

// ── routes ───────────────────────────────────
function registerTseScanner(app){
  const start=(req,res)=>{ if(scanState.isScanning) return res.json({ok:true,message:'Already scanning'}); if(!inFlight) inFlight=executeScan().catch(()=>{}); res.json({ok:true,message:'Scan started'}); };
  app.post('/api/tse/scan/start',start); app.get('/api/tse/scan/start',start);

  app.get('/api/tse/scan/status',(req,res)=>res.json({isScanning:scanState.isScanning,progress:scanState.progress,logs:scanState.logs.slice(-30),error:scanState.error,startedAt:scanState.startedAt}));

  app.get('/api/tse/scan/progress',(req,res)=>{
    res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache'); res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders();
    let sent=Math.max(0,scanState.logTotal-scanState.logs.length);
    const iv=setInterval(()=>{
      const fresh=scanState.logTotal-sent;
      const logs=fresh>0?scanState.logs.slice(-Math.min(fresh,scanState.logs.length)):[]; sent=scanState.logTotal;
      if(!scanState.isScanning){ res.write(`data: ${JSON.stringify({logs,done:true,progress:scanState.error?scanState.progress:100,error:scanState.error})}\n\n`); clearInterval(iv); return res.end(); }
      res.write(`data: ${JSON.stringify({logs,progress:scanState.progress,isScanning:true})}\n\n`);
    },500);
    req.on('close',()=>clearInterval(iv));
  });

  app.get('/api/tse/signals',(req,res)=>{
    const s=loadResult(); if(!s) return res.json({ok:true,pending:true,count:0,data:[]});
    res.json({ok:true,updatedAt:s.updatedAt,proxy:s.proxy,totalScanned:s.totalScanned||s.data.length,poolSize:s.poolSize,fundCoverage:s.fundCoverage,codalStatus:s.codalStatus,stale:!isTodayTehran(s.updatedAt),count:s.data.length,data:s.data});
  });
  
  app.post('/api/tse/ingest',(req,res)=>{
    let key=process.env.TSE_INGEST_KEY;
    if(!key){ try{ key=fs.readFileSync(path.join(__dirname,'ingest.key'),'utf8').trim(); }catch(_){} }
    if(!key) return res.status(503).json({ok:false,error:'No ingest key on the server (set TSE_INGEST_KEY or create ingest.key)'});
    const given=String(req.get('x-ingest-key')||'');
    const a=Buffer.from(given), b=Buffer.from(key);
    if(a.length!==b.length||!require('crypto').timingSafeEqual(a,b)) return res.status(401).json({ok:false,error:'bad key'});
    const d=req.body;
    if(!d||!Array.isArray(d.data)||!d.data.length||!d.updatedAt) return res.status(400).json({ok:false,error:'invalid payload'});
    saveResult({updatedAt:d.updatedAt,proxy:'Agent · Iran IP',totalScanned:d.totalScanned,poolSize:d.poolSize,fundCoverage:d.fundCoverage,codalStatus:d.codalStatus,data:d.data.slice(0,50)});
    log(`[Ingest] Received ${d.data.length} signals from agent (${d.totalScanned}/${d.poolSize} analyzed)`);
    res.json({ok:true,count:d.data.length});
  });
  app.delete('/api/tse/signals',(req,res)=>{ try{ fs.existsSync(CACHE_FILE)&&fs.unlinkSync(CACHE_FILE); fs.existsSync(HIST_FILE)&&fs.unlinkSync(HIST_FILE);}catch(_){} res.json({ok:true}); });
}

module.exports={registerTseScanner,loadResult,saveResult,isTodayTehran,executeScan,scanState,getJSON,_test:{applyFundamentals,sectorFromName,scoreStock,applyMoneyFlow,norm,isValidCandidate,getSector,executeScan,setFetch:f=>{_fetch=f;},scanState}};