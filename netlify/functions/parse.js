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
    '(\\d{2}[A-Z]{3})\\s+' + prefix + '\\s+([A-Z0-9/-]+)(.*?)(?=\\d{2}[A-Z]{3}\\s+' + prefix + '\\b|RES\\s+OTHER\\s+SUB\\s+TTL|CREDIT\\s+APPLICABLE|END OF DISPLAY|$)',
    'gis'
  );
  const rows = []; let m;
  while ((m = segRe.exec(text)) !== null) {
    rows.push({ times: (m[0] || '').match(/\b\d{1,3}:[0-5]\d\b/g) || [] });
  }
  return rows;
}
function _calcLineholderPayTimeOnly_(rows) {
  return rows.reduce((t,r) => r.times.length===1 ? t+_toMinutes_(r.times[0]) : t, 0);
}
function _calcLineholderAddtlOnly_(rows) {
  let total=0;
  for (const r of rows) if (r.times.length>=2) { const p=_toMinutes_(r.times[r.times.length-2]),l=_toMinutes_(r.times[r.times.length-1]); if(l<p)total+=l; }
  return total;
}
function _calcReservePayTimeOnlyStructural_(rows) {
  let total=0;
  for (const r of rows) {
    if (!r.times.length) continue;
    const mins=r.times.map(_toMinutes_);
    const hasBlock=mins.length>=2&&mins[0]<mins[1];
    const hasTriplet=r.times.length>=3&&r.times[r.times.length-1]===r.times[r.times.length-2]&&r.times[r.times.length-2]===r.times[r.times.length-3];
    if (!hasBlock&&!hasTriplet) total+=mins[mins.length-1];
  }
  return total;
}
function _calcReserveAddtlOnly_(rows) {
  let total=0;
  for (const r of rows) if (r.times.length>=2) { const p=_toMinutes_(r.times[r.times.length-2]),l=_toMinutes_(r.times[r.times.length-1]); if(l<p)total+=l; }
  return total;
}
function computeTotals(text) {
  const cardType=_detectCardType_(text);
  if (!cardType) return {error:'unrecognized',cardType:null,breakdown:[],totalMins:0,totalHMM:'0:00',totalDecimal:0,alv:0,suspicious:true};
  const ttlCredit=_grabTtlCredit_(text);
  const resAssignGSlip=_grabLabeledTimeFlex_(text,['RES ASSIGN-G/SLIP PAY','RES ASSIGN G/SLIP PAY']);
  const assignPay=_grabLabeledTimeFlex_(text,['ASSIGN PAY']);
  const reroutePay=_grabLabeledTimeFlex_(text,['REROUTE PAY']);
  const gSlipPay=_grabLabeledTimeFlex_(text,['G/SLIP PAY','G - SLIP PAY','G SLIP PAY']);
  const ttlBankOpts=_grabLabeledTimeFlex_(text,['TTL BANK OPTS AWARD','TTL BANK OPT 1']);
  const trainingPay=_grabTrainingPay_(text);
  const alv=Math.round((_grabALV_(text)/60)*100)/100;
  let totalMins, breakdown;
  if (cardType==='LINEHOLDER') {
    const rows=_parseRows_(text,'REG');
    const payTimeOnly=_calcLineholderPayTimeOnly_(rows);
    const addtlOnly=_calcLineholderAddtlOnly_(rows);
    const gSlip_x2=gSlipPay*2, assign_x2=assignPay*2;
    totalMins=ttlCredit+payTimeOnly+addtlOnly+gSlip_x2+assign_x2;
    breakdown=[{label:'Card Type',value:cardType},{label:'TTL CREDIT',value:_fromMinutes_(ttlCredit)},{label:'PAY TIME ONLY',value:_fromMinutes_(payTimeOnly)},{label:'ADDTL PAY ONLY',value:_fromMinutes_(addtlOnly)},{label:'G/SLIP PAY ×2',value:_fromMinutes_(gSlip_x2)},{label:'ASSIGN PAY ×2',value:_fromMinutes_(assign_x2)}];
  } else {
    const rows=_parseRows_(text,'RES');
    const payTimeOnlyStruct=_calcReservePayTimeOnlyStructural_(rows);
    const addtlOnly=_calcReserveAddtlOnly_(rows);
    totalMins=ttlCredit+payTimeOnlyStruct+addtlOnly+resAssignGSlip+assignPay+reroutePay+trainingPay+ttlBankOpts;
    breakdown=[{label:'Card Type',value:cardType},{label:'TTL CREDIT',value:_fromMinutes_(ttlCredit)},{label:'PAY TIME ONLY',value:_fromMinutes_(payTimeOnlyStruct)},{label:'ADDTL PAY ONLY',value:_fromMinutes_(addtlOnly)},{label:'RES ASSIGN-G/SLIP PAY',value:_fromMinutes_(resAssignGSlip)},{label:'ASSIGN PAY',value:_fromMinutes_(assignPay)},{label:'REROUTE PAY',value:_fromMinutes_(reroutePay)},{label:'DISTRIBUTED TRNG PAY',value:_fromMinutes_(trainingPay)},{label:'TTL BANK OPTS AWARD',value:_fromMinutes_(ttlBankOpts)}];
  }
  return {cardType,breakdown,totalMins,totalHMM:_fromMinutes_(totalMins),totalDecimal:Math.round((totalMins/60)*100)/100,alv,suspicious:totalMins===0||ttlCredit===0,error:null};
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
