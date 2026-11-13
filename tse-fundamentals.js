'use strict';
// ─────────────────────────────────────────────────────────────────────────────
//  Fundamentals for the TSE Quant Engine  (pure functions — no network here)
//   • TSETMC instrument info  → EPS, forecast EPS, sector P/E, official sector
//   • Codal disclosures       → event flags from letter titles (dividend, capital
//                               increase, halt, clarification, audit opinion…)
//  Score: 50 = neutral. Final-score adjustment = (fundScore-50)*0.4  → ±20 max.
//  Missing data NEVER penalises a stock (adjustment 0).
// ─────────────────────────────────────────────────────────────────────────────

const CODAL_SEARCH = 'https://search.codal.ir/api/search/v2/q';
const CODAL_SITE   = 'https://codal.ir';

// ── text helpers ─────────────────────────────
const fa2en = s => String(s == null ? '' : s)
  .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
  .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const norm = s => fa2en(s).replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/ة/g, 'ه')
  .replace(/[\u200c\u200e\u200f]/g, ' ').replace(/\s+/g, ' ').trim();

// ── Jalali date helpers (day index is accurate to ±1 day — enough for "age") ──
function jDayIndex(y, m, d) { const doy = m <= 6 ? (m - 1) * 31 + d : 186 + (m - 7) * 30 + d; return Math.round(y * 365.2422) + doy; }
function parseJalali(str) { const m = fa2en(str).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/); return m ? { y: +m[1], m: +m[2], d: +m[3] } : null; }
function jalaliNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date);
  const g = t => +parts.find(p => p.type === t).value;
  return { y: g('year'), m: g('month'), d: g('day') };
}
const fmtJ = o => `${o.y}/${String(o.m).padStart(2, '0')}/${String(o.d).padStart(2, '0')}`;
function nowIndex() { const n = jalaliNow(); return jDayIndex(n.y, n.m, n.d); }
function codalRange(daysBack = 200) { return { from: fmtJ(jalaliNow(new Date(Date.now() - daysBack * 864e5))), to: fmtJ(jalaliNow()) }; }

// ── Codal ────────────────────────────────────
function codalUrl(symbol, from, to, page = 1) {
  const p = new URLSearchParams({
    Audited: 'true', AuditorRef: '-1', Category: '-1', Childs: 'true', CompanyState: '-1', CompanyType: '-1',
    Consolidatable: 'true', IsNotAudited: 'false', Length: '-1', LetterType: '-1', Mains: 'true',
    NotAudited: 'true', NotConsolidatable: 'true', PageNumber: String(page), Publisher: 'false',
    TracingNo: '-1', search: 'true', Symbol: symbol, FromDate: from, ToDate: to,
  });
  return `${CODAL_SEARCH}?${p}`;
}
function parseLetters(json) {
  const arr = (json && (json.Letters || json.letters)) || [];
  return arr.map(l => {
    const url = l.Url || l.url || '';
    return {
      title: norm(l.Title || l.title), code: norm(l.LetterCode || l.letterCode || ''),
      date: fa2en(l.PublishDateTime || l.SentDateTime || l.publishDateTime || ''),
      url: url ? (/^https?:/.test(url) ? url : CODAL_SITE + url) : '',
    };
  }).filter(x => x.title);
}

const RX = {
  MONTHLY : /گزارش فعالیت ماهانه/,
  EPS_F   : /پیش ?بینی.*(درآمد|سود).*سهم|پیش ?بینی.*EPS|پیش ?بینی عملکرد/,
  DIV     : /تقسیم سود|سود نقدی|پرداخت سود|سود سهام/,
  CAP     : /افزایش سرمایه/,
  CAP_FREE: /سود انباشته|اندوخته|تجدید ارزیابی/,
  CAP_CASH: /آورده نقدی|مطالبات|آورده/,
  HALT    : /توقف نماد/,
  CLARIFY : /(توضیحات|شفاف ?سازی)( در ?خصوص| راجع)|افشای اطلاعات با ?اهمیت|اطلاعات با ?اهمیت|شفاف ?سازی/,
  AUDIT_BAD: /اظهار ?نظر (مشروط|مردود)|عدم اظهار ?نظر/,
  BOARD   : /ترکیب هیئت ?مدیره|تغییر.*هیئت ?مدیره|تغییر.*هیات ?مدیره/,
  AGM     : /خلاصه تصمیمات|تصمیمات مجمع/,
  FS      : /صورت ?های مالی/,
};
function classify(title, code) {
  const tags = [];
  if (RX.MONTHLY.test(title)) tags.push('MONTHLY');
  if (RX.EPS_F.test(title)) tags.push('EPS_F');
  if (RX.DIV.test(title)) tags.push('DIV');
  if (RX.CAP.test(title)) tags.push(RX.CAP_FREE.test(title) ? 'CAP_FREE' : RX.CAP_CASH.test(title) ? 'CAP_CASH' : 'CAP');
  if (RX.HALT.test(title)) tags.push('HALT');
  if (RX.CLARIFY.test(title)) tags.push('CLARIFY');
  if (RX.AUDIT_BAD.test(title)) tags.push('AUDIT_BAD');
  if (RX.BOARD.test(title) || code === 'ن-45') tags.push('BOARD');
  if (RX.AGM.test(title)) tags.push('AGM');
  if (RX.FS.test(title)) tags.push('FS');
  return tags;
}
// latest occurrence (min age in days) per tag + 6 most recent letters for the tooltip
function summarize(letters, nowIdx = nowIndex()) {
  const latest = {}, dated = [];
  for (const l of letters || []) {
    const d = parseJalali(l.date); if (!d) continue;
    const age = Math.max(0, nowIdx - jDayIndex(d.y, d.m, d.d));
    dated.push({ age, title: l.title, url: l.url });
    for (const t of classify(l.title, l.code)) if (!latest[t] || age < latest[t].age) latest[t] = { age, title: l.title, url: l.url };
  }
  dated.sort((a, b) => a.age - b.age);
  return { latest, recent: dated.slice(0, 6), n: (letters || []).length };
}

// ── TSETMC instrument info ───────────────────
function parseInstrumentInfo(json) {
  const i = (json && (json.instrumentInfo || json)) || {};
  const e = i.eps || {}, sec = i.sector || {};
  const n = v => { const x = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(x) ? x : null; };
  const out = { eps: n(e.epsValue), estEps: n(e.estimatedEPS), sectorPE: n(e.sectorPE), psr: n(e.psr), sectorName: norm(sec.lSecVal || sec.lSecValue || '') };
  return (out.eps === null && out.estEps === null && out.sectorPE === null && !out.sectorName) ? null : out;
}

// ── scoring ──────────────────────────────────
function scoreFundamentals({ priceRial, info, summary }) {
  if (!info && !summary) return null;
  let sc = 50; const det = [], flags = []; let veto = false;
  let pe = null, fwdPE = null, sectorPE = null, epsGrowth = null;
  const add = (pts, label) => { sc += pts; det.push(`${label} ${pts > 0 ? '+' : ''}${pts}`); };

  if (info) {
    const { eps, estEps } = info;
    sectorPE = info.sectorPE > 0 ? info.sectorPE : null;
    if (eps > 0 && priceRial > 0) pe = +(priceRial / eps).toFixed(1);
    if (estEps > 0 && priceRial > 0) fwdPE = +(priceRial / estEps).toFixed(1);

    if (eps !== null && eps <= 0) { add(-25, 'Loss-making (EPS≤0)'); veto = true; flags.push('LOSS'); }
    else if (estEps !== null && estEps <= 0) { add(-15, 'Forecast EPS≤0'); flags.push('FWD-LOSS'); }

    if (eps > 0 && estEps > 0) {
      epsGrowth = Math.max(-999, Math.min(999, Math.round((estEps / eps - 1) * 100)));
      if (epsGrowth >= 50) add(20, `EPS growth ${epsGrowth}%`); else if (epsGrowth >= 20) add(12, `EPS growth ${epsGrowth}%`);
      else if (epsGrowth >= 5) add(6, `EPS growth ${epsGrowth}%`); else if (epsGrowth <= -20) add(-12, `EPS growth ${epsGrowth}%`);
      else if (epsGrowth <= -5) add(-6, `EPS growth ${epsGrowth}%`);
    }
    const v = fwdPE || pe;
    if (v) {
      if (sectorPE) { const r = v / sectorPE;
        if (r <= 0.6) add(15, `P/E ${v} vs sector ${sectorPE}`); else if (r <= 0.9) add(8, `P/E ${v} vs sector ${sectorPE}`);
        else if (r >= 1.5) add(-10, `P/E ${v} vs sector ${sectorPE}`); else if (r >= 1.2) add(-5, `P/E ${v} vs sector ${sectorPE}`);
      } else { if (v <= 5) add(8, `P/E ${v}`); else if (v >= 12) add(-8, `P/E ${v}`); }
    }
  }

  if (summary && summary.latest) {
    const L = summary.latest, within = (t, days) => L[t] && L[t].age <= days;
    if (within('AUDIT_BAD', 400)) { add(-20, 'Adverse/qualified audit opinion'); veto = true; flags.push('AUDIT!'); }
    if (within('HALT', 30)) { add(-10, 'Trading halt notice ≤30d'); flags.push('HALT'); }
    if (within('CLARIFY', 14)) { add(-5, 'Clarification/material-info notice ≤14d'); flags.push('CLARIFY'); }
    if (within('CAP_FREE', 120)) { add(4, 'Capital increase from reserves'); flags.push('CAP+'); }
    else if (within('CAP_CASH', 120)) { add(-4, 'Cash/claims capital increase (dilutive)'); flags.push('CAP$'); }
    else if (within('CAP', 120)) { flags.push('CAP?'); }
    if (within('DIV', 150)) { add(4, 'Dividend decision'); flags.push('DIV'); }
    if (within('EPS_F', 45)) flags.push('EPS-F');
    if (within('MONTHLY', 45)) { add(3, 'Fresh monthly activity report'); flags.push('MON'); }
    if (within('BOARD', 30)) { add(-2, 'Board change ≤30d'); flags.push('BOARD'); }
    if (within('AGM', 60)) flags.push('AGM');
  }

  sc = Math.max(0, Math.min(100, sc));
  return { fundScore: sc, adj: Math.round((sc - 50) * 0.4), flags, veto, pe, fwdPE, sectorPE, epsGrowth, details: det, sectorName: info ? info.sectorName : '' };
}

module.exports = { norm, fa2en, jDayIndex, parseJalali, jalaliNow, nowIndex, codalRange, codalUrl, parseLetters, classify, summarize, parseInstrumentInfo, scoreFundamentals };
