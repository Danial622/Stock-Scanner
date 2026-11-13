'use strict';
// Diagnostic: prints what TSETMC and Codal really return for ONE symbol, so the parsers can be
// checked against real data.   Usage (on a PC with an Iranian IP):
//      node tse-codal-probe.js فولاد            (finds insCode via TSETMC search)
//      node tse-codal-probe.js فولاد 46348559193224090      (give insCode yourself)
// Output is also saved to probe_output.txt — send that file back for tuning.
const fs = require('fs');
const sc = require('./tse-scanner'); const FD = require('./tse-fundamentals');
const sym = FD.norm(process.argv[2] || 'فولاد'); let ins = process.argv[3];
const out = []; const P = (...a) => { const l = a.join(' '); console.log(l); out.push(l); };
const keys = o => o && typeof o === 'object' ? Object.keys(o).join(', ') : String(o);
(async () => {
  P(`=== PROBE ${sym} · ${new Date().toISOString()} ===`);
  if (!ins) {
    try { const j = await sc.getJSON(`https://cdn.tsetmc.com/api/Instrument/GetInstrumentSearch/${encodeURIComponent(sym)}`, null, 15000);
      const r = (j.instrumentSearch || []).find(x => FD.norm(x.lVal18AFC) === sym) || (j.instrumentSearch || [])[0];
      ins = r && r.insCode; P('TSETMC search →', JSON.stringify(r)); } catch (e) { P('TSETMC search FAILED:', e.message); }
  }
  if (ins) {
    try { const j = await sc.getJSON(`https://cdn.tsetmc.com/api/Instrument/GetInstrumentInfo/${ins}`, null, 15000);
      const i = j.instrumentInfo || j; P('\n[TSETMC InstrumentInfo] top-level keys:', keys(i)); P('  eps object:', JSON.stringify(i.eps)); P('  sector object:', JSON.stringify(i.sector));
      P('  parsed →', JSON.stringify(FD.parseInstrumentInfo(j))); } catch (e) { P('\nTSETMC InstrumentInfo FAILED:', e.message); }
  } else P('\n(no insCode — skipping InstrumentInfo)');
  try { const { from, to } = FD.codalRange(200); const url = FD.codalUrl(sym, from, to, 1); P(`\n[Codal] ${from} → ${to}\n  ${url}`);
    const j = await sc.getJSON(url, null, 20000, { Referer: 'https://codal.ir/', Origin: 'https://codal.ir' });
    P('  response keys:', keys(j), '| Total:', j.Total, '| letters:', (j.Letters || []).length);
    if ((j.Letters || [])[0]) P('  first letter keys:', keys(j.Letters[0]), '\n  first letter raw:', JSON.stringify(j.Letters[0]).slice(0, 700));
    const ls = FD.parseLetters(j); const sm = FD.summarize(ls);
    P('\n  recent letters (age days · tags · title):'); ls.slice(0, 15).forEach(l => { const d = FD.parseJalali(l.date); const age = d ? FD.nowIndex() - FD.jDayIndex(d.y, d.m, d.d) : '?'; P(`   ${String(age).padStart(4)}d  [${FD.classify(l.title, l.code).join(',')}]  ${l.code}  ${l.title}`); });
    P('\n  latest by tag:', JSON.stringify(Object.fromEntries(Object.entries(sm.latest).map(([k, v]) => [k, v.age]))));
  } catch (e) { P('\nCodal FAILED:', e.message, '\n  → if this is a timeout/403, Codal blocks this IP (try from your Iranian connection with VPN OFF).'); }
  fs.writeFileSync('probe_output.txt', out.join('\n')); console.log('\nSaved probe_output.txt'); process.exit(0);
})();
