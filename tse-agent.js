'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  TSE Agent — run this on a PC/laptop with an IRANIAN IP (home ADSL / mobile).
//  It scans TSETMC directly (no flaky free proxies), then pushes the result to
//  your Botkeep dashboard.
//
//  Windows (PowerShell):
//     $env:TSE_INGEST_KEY="your-long-secret"; node tse-agent.js
//  Linux/macOS:
//     TSE_INGEST_KEY=your-long-secret node tse-agent.js
//
//  Optional: TSE_SERVER=http://node12.botkeep.cloud:30368   (default shown)
//
//  Tip: if reaching Botkeep needs your VPN but TSETMC needs it OFF, just start
//  the agent with the VPN off. It saves the result and keeps retrying the upload
//  for ~10 minutes, so you can switch the VPN on while it waits.
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const path = require('path');

const SERVER = (process.env.TSE_SERVER || 'http://node12.botkeep.cloud:30368').replace(/\/$/, '');
const KEY = process.env.TSE_INGEST_KEY;
const OUT = path.join(__dirname, 'agent_result.json');
if (!KEY) { console.error('✗ Set TSE_INGEST_KEY (same value as on the server).'); process.exit(1); }

const post = global.fetch || require('node-fetch');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sc = require('./tse-scanner');

async function upload(result) {
  for (let i = 1; i <= 30; i++) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
      const res = await post(`${SERVER}/api/tse/ingest`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-ingest-key': KEY },
        body: JSON.stringify(result),
      });
      clearTimeout(t);
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) { console.log(`✅ Uploaded ${j.count} signals to ${SERVER}`); return true; }
      if (res.status === 401 || res.status === 503) { console.error(`✗ Server refused: ${j.error}`); return false; }
      console.log(`Upload attempt ${i}: HTTP ${res.status}`);
    } catch (e) { console.log(`Upload attempt ${i}/30 failed (${e.message}) — retrying in 20s…`); }
    await sleep(20000);
  }
  return false;
}

(async () => {
  let result;
  try { result = await sc.executeScan(); fs.writeFileSync(OUT, JSON.stringify(result)); }
  catch (e) {
    console.error('Scan failed:', e.message);
    if (!fs.existsSync(OUT)) process.exit(1);
    console.log('Uploading the last saved result instead…'); result = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  }
  process.exit((await upload(result)) ? 0 : 2);
})();
