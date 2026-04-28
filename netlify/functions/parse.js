/*
 * Netlify Function: /api/parse — fully self-contained, no imports.
 * No input data is stored after this function returns.
 */

// ── HELPERS ──────────────────────────────────────────────
function _toMinutes_(s) {
  if (!s || typeof s !== 'string') return 0;
  const m = s.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
}
function _fromMinutes_(mins) {
  mins = Math.max(0, mins | 0);
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}
function _nbps_(t) { return String(t || '').replace(/\u00A0/g, ' '); }
function _detectCardType_(text) {
  text = _nbps_(text).toUpperCase();
  const sawRES = /\b\d{2}[A-Z]{3}\s+RES\b/.test(text);
  const sawREG = /\b\d{2}[A-Z]{3}\s+REG\b/.test(text);
  if (sawRES && !sawREG) return 'RESERVE';
  if (sawREG && !sawRES) return 'LINEHOLDER';
  if (sawRES && sawREG)  return 'RESERVE';
  return null;
}
function _grabTtlCredit_(raw) {
  const eqTimes = [..._nbps_(raw).matchAll(/=\s*(\d{1,3}:[0-5]\d)/g)];
  return eqTimes.length ? _toMinutes_(eqTimes[eqTimes.length - 1][1]) : 0;
}
function _grabLabeledTimeFlex_(text, variants) {
  text = _nbps_(text);
  for (const v of variants) {
    let re = new RegExp(v.replace(/\s+/g,'\\s+').replace(/[-/]/g,m=>'\\'+m)+'\\s*:\\s*(\\d{1,3}:[0-5]\\d)','i');
    let m = text.match(re); if (m) return _toMinutes_(m[1]);
    re = new RegExp(v.replace(/\s+/g,'\\s+').replace(/[-/]/g,m=>'\\'+m)+'\\s+(\\d{1,3}:[0-5]\\d)','i');
    m = text.match(re); if (m) return _toMinutes_(m[1]);
  }
  return 0;
}
function _grabTrainingPay_(text) {
  let total = 0, m;
  const re = /DISTRIBUTED\s+TRNG\s+PAY:\s+(\d{1,3}:[0-5]\d)/gi;
  while ((m = re.exec(_nbps_(text))) !== null) total += _toMinutes_(m[1]);
  return total;
}
function _grabALV_(text) {
  text = _nbps_(text);
  const idx = text.toUpperCase().indexOf('ALV');
  if (idx === -1) return 0;
  const times = text.substring(idx, idx + 100).match(/\d{1,3}:[0-5]\d/g);
  return times ? _toMinutes_(times[times.length - 1]) : 0;
}
function _parseRows_(text, prefix) {
  text = _nbps_(text);
  const segRe = new RegExp(
    '(\\d{2}[A-Z]{3})\\s+' + prefix + '\\s+([A-Z0-9/-]+)(.*?)(?=' +
      '\\d{2}[A-Z]{3}\\s+' + prefix + '\\b|' +
      'RES\\s+OTHER\\s+SUB\\s+TTL|' +
      'CREDIT\\s+APPLICABLE|' +
      '\\d{1,3}:[0-5]\\d\\s*\\+\\s*\\d{1,3}:[0-5]\\d|' +  // guarantee math line
      'END OF DISPLAY|$)',
    'gis'
  );
  const rows = []; let m;
  while ((m = segRe.exec(text)) !== null)
    rows.push({ nbr: (m[2]||'').toUpperCase(), times: (m[0]||'').match(/\b\d{1,3}:[0-5]\d\b/g)||[] });
  return rows;
}
// Parse CREDIT, RES GUAR, and PAYBACK from the guarantee math line
function _grabReserveGuarLine_(text) {
  text = _nbps_(text);
  const m = text.match(/(\d{1,3}:[0-5]\d)\s*\+\s*(\d{1,3}:[0-5]\d)\s*\+\s*(\d{1,3}:[0-5]\d)\s*=\s*(\d{1,3}:[0-5]\d)\s*-\s*(\d{1,3}:[0-5]\d)/);
  if (m) return { credit: _toMinutes_(m[1]), resGuar: _toMinutes_(m[2]), payback: _toMinutes_(m[5]) };
  return { credit: 0, resGuar: 0, payback: 0 };
}
// Lineholder pay-only: skip single-time rows (block-only) and any row with consecutive
// equal times (those rows have credit already in TTL CREDIT — don't double-count).
// Only rows with no consecutive equal times are genuine pay-only additions.
function _calcLineholderPayTimeOnly_(rows) {
  let total = 0;
  for (const r of rows) {
    const t = r.times;
    if (t.length < 2) continue; // single time = block-only row, ignore
    let hasConsecEqual = false;
    for (let i = 1; i < t.length; i++) { if (t[i] === t[i-1]) { hasConsecEqual = true; break; } }
    if (hasConsecEqual) continue; // has credit, already in TTL CREDIT
    total += _toMinutes_(t[t.length-1]); // genuine pay-only
  }
  return total;
}
function _calcLineholderAddtlOnly_(rows) {
  let total=0;
  for (const r of rows) if (r.times.length>=2) { const p=_toMinutes_(r.times[r.times.length-2]),l=_toMinutes_(r.times[r.times.length-1]); if(l<p)total+=l; }
  return total;
}
// Reserve: pay-no-credit rows WITHOUT block hours (LOSA, ADJ-RRPY, etc.)
// Rows WITH block hours that have no credit are captured by the RES ASSIGN labeled line — don't double count.
function _calcReservePayNoCreditNoBlock_(rows) {
  let total=0;
  for (const r of rows) {
    const t=r.times; if (!t.length) continue;
    const mins=t.map(_toMinutes_);
    const hasTriplet=t.length>=3&&t[t.length-1]===t[t.length-2]&&t[t.length-2]===t[t.length-3];
    if (hasTriplet) continue;
    const hasMidTriplet=t.length>=4&&t[t.length-2]===t[t.length-3]&&t[t.length-3]===t[t.length-4];
    if (hasMidTriplet) continue;
    const hasBlockHrs=mins.length>=2&&mins[0]<mins[1];
    if (hasBlockHrs) continue; // flows into RES ASSIGN labeled line
    if (t.length>=2&&t[t.length-1]===t[t.length-2]) total+=mins[mins.length-1];
    else if (t.length===1) total+=mins[0];
  }
  return total;
}
// ADDTL column: last time < second-to-last
function _calcReserveAddtlOnly_(rows) {
  let total=0;
  for (const r of rows) if (r.times.length>=2) { const p=_toMinutes_(r.times[r.times.length-2]),l=_toMinutes_(r.times[r.times.length-1]); if(l>0&&l<p)total+=l; }
  return total;
}
function computeTotals(text) {
  // Strip common OCR noise artifacts before any parsing
  text = _nbps_(text).replace(/~~\s*/g, '').replace(/\s{2,}/g, ' ');
  const cardType=_detectCardType_(text);
  if (!cardType) return {error:'unrecognized',cardType:null,breakdown:[],totalMins:0,totalHMM:'0:00',totalDecimal:0,alv:0,suspicious:true};
  const reroutePay=_grabLabeledTimeFlex_(text,['REROUTE PAY']);
  const gSlipPay=_grabLabeledTimeFlex_(text,['G/SLIP PAY','G - SLIP PAY','G SLIP PAY']);
  const assignPay=_grabLabeledTimeFlex_(text,['ASSIGN PAY']);
  const trainingPay=_grabTrainingPay_(text);
  const alv=Math.round((_grabALV_(text)/60)*100)/100;
  let totalMins, breakdown, suspicious;
  if (cardType==='LINEHOLDER') {
    const ttlCredit=_grabTtlCredit_(text);
    const rows=_parseRows_(text,'REG');
    const payTimeOnly=_calcLineholderPayTimeOnly_(rows);
    const addtlOnly=_calcLineholderAddtlOnly_(rows);
    const gSlip_x2=gSlipPay*2, assign_x2=assignPay*2;
    totalMins=ttlCredit+payTimeOnly+addtlOnly+gSlip_x2+assign_x2+trainingPay;
    suspicious=totalMins===0||ttlCredit===0;
    breakdown=[
      {label:'Card Type',      value:cardType},
      {label:'TTL CREDIT',     value:_fromMinutes_(ttlCredit)},
      {label:'PAY TIME ONLY',  value:_fromMinutes_(payTimeOnly)},
      {label:'ADDTL PAY ONLY', value:_fromMinutes_(addtlOnly)},
      {label:'G/SLIP PAY ×2',  value:_fromMinutes_(gSlip_x2)},
      {label:'ASSIGN PAY ×2',  value:_fromMinutes_(assign_x2)},
      {label:'DISTRIBUTED TRNG PAY', value:_fromMinutes_(trainingPay)},
    ];
  } else {
    const {credit,resGuar,payback}=_grabReserveGuarLine_(text);
    const rows=_parseRows_(text,'RES');
    const resAssignGSlip=_grabLabeledTimeFlex_(text,['RES ASSIGN-G/Q SLIP PAY','RES ASSIGN-G/Q-SLIP PAY','RES ASSIGN-G/SLIP PAY','RES ASSIGN G/SLIP PAY']);
    const payNoCredit=_calcReservePayNoCreditNoBlock_(rows);
    const addtlOnly=_calcReserveAddtlOnly_(rows);
    totalMins=credit+resGuar+payNoCredit+addtlOnly+reroutePay+resAssignGSlip+trainingPay-payback;
    suspicious=totalMins===0||(credit===0&&resGuar===0);
    breakdown=[
      {label:'Card Type',                       value:cardType},
      {label:'Credit (trips w/ credit)',         value:_fromMinutes_(credit)},
      {label:'RES Guarantee',                    value:_fromMinutes_(resGuar)},
      {label:'Pay No Credit (LOSA, RRPY, etc)',  value:_fromMinutes_(payNoCredit)},
      {label:'ADDTL Pay Only',                   value:_fromMinutes_(addtlOnly)},
      {label:'Reroute Pay',                      value:_fromMinutes_(reroutePay)},
      {label:'RES GS/QS/IA Pay',                value:_fromMinutes_(resAssignGSlip)},
      {label:'Distributed Trng Pay',             value:_fromMinutes_(trainingPay)},
      {label:'Payback (Neg Bank)',               value:payback>0?'-'+_fromMinutes_(payback):'0:00'},
    ];
  }
  return {cardType,breakdown,totalMins,totalHMM:_fromMinutes_(totalMins),totalDecimal:Math.round((totalMins/60)*100)/100,alv,suspicious,error:null};
}
async function sendEmail({ subject, body }) {
  const apiKey=process.env.RESEND_API_KEY, to=process.env.NOTIFY_EMAIL;
  if (!apiKey||!to) return;
  await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${apiKey}`,'Content-Type':'application/json'},body:JSON.stringify({from:'Timecard App <onboarding@resend.dev>',to:[to],subject,text:body})});
}
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json'};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let rawText = '';

  try {
    const body = JSON.parse(event.body || '{}');
    rawText = String(body.text || '').trim();

    if (!rawText) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'No text provided.' })
      };
    }

    const result = computeTotals(rawText);

    // Auto-email on unrecognized or suspicious data
    if (result.error === 'unrecognized' || result.suspicious) {
      const reason = result.error === 'unrecognized'
        ? 'Parser could not detect card type (no RES/REG rows found).'
        : 'Parser returned suspicious result (zero total or missing credit block).';

      await sendEmail({
        subject: '[Timecard App] Auto-detected parse issue',
        body: [
          'The timecard parser encountered a potential issue.',
          '',
          `Reason: ${reason}`,
          `Card Type Detected: ${result.cardType || 'NONE'}`,
          `Total Computed: ${result.totalHMM} (${result.totalDecimal} hrs)`,
          '',
          '--- RAW INPUT (auto-deleted after this email) ---',
          rawText,
          '--- END OF INPUT ---'
        ].join('\n')
      });
    }

    // Return result — rawText is never stored beyond this function call
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cardType:      result.cardType,
        breakdown:     result.breakdown,
        totalHMM:      result.totalHMM,
        totalDecimal:  result.totalDecimal,
        alv:           result.alv,
        suspicious:    result.suspicious || false,
        error:         result.error || null
      })
    };

  } catch (err) {
    // Unexpected exception — email the raw input if we have it
    try {
      await sendEmail({
        subject: '[Timecard App] Parse exception',
        body: [
          'An unexpected error occurred during parsing.',
          '',
          `Error: ${err.message}`,
          '',
          '--- RAW INPUT (auto-deleted after this email) ---',
          rawText || '(could not extract input)',
          '--- END OF INPUT ---'
        ].join('\n')
      });
    } catch (_) { /* email failure shouldn't surface to user */ }

    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'An unexpected error occurred. The developer has been notified.' })
    };
  }
  // rawText goes out of scope here — nothing is persisted
};
