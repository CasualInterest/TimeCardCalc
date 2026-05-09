/*

- Netlify Function: /api/parse — fully self-contained, no imports.
- No input data is stored after this function returns.
  */

// ── HELPERS ──────────────────────────────────────────────
function *toMinutes*(s) {
if (!s || typeof s !== ‘string’) return 0;
const m = s.trim().match(/^(\d{1,3}):([0-5]\d)$/);
return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
}
function *fromMinutes*(mins) {
mins = Math.max(0, mins | 0);
return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
}
function *nbps*(t) { return String(t || ‘’).replace(/\u00A0/g, ’ ‘); }
function *detectCardType*(text) {
text = *nbps*(text).toUpperCase();
const sawRES = /\b\d{2}[A-Z]{3}\s+RES\b/.test(text);
const sawREG = /\b\d{2}[A-Z]{3}\s+REG\b/.test(text);
if (sawRES && !sawREG) return ‘RESERVE’;
if (sawREG && !sawRES) return ‘LINEHOLDER’;
if (sawRES && sawREG)  return ‘RESERVE’;
return null;
}
function *grabTtlCredit*(raw) {
const eqTimes = […*nbps*(raw).matchAll(/=\s*(\d{1,3}:[0-5]\d)/g)];
return eqTimes.length ? *toMinutes*(eqTimes[eqTimes.length - 1][1]) : 0;
}
function *grabLabeledTimeFlex*(text, variants) {
text = *nbps*(text);
for (const v of variants) {
let re = new RegExp(v.replace(/\s+/g,’\s+’).replace(/[-/]/g,m=>’\’+m)+’\s*:\s*(\d{1,3}:[0-5]\d)’,‘i’);
let m = text.match(re); if (m) return *toMinutes*(m[1]);
re = new RegExp(v.replace(/\s+/g,’\s+’).replace(/[-/]/g,m=>’\’+m)+’\s+(\d{1,3}:[0-5]\d)’,‘i’);
m = text.match(re); if (m) return *toMinutes*(m[1]);
}
return 0;
}
function *grabTrainingPay*(text) {
let total = 0, m;
const re = /DISTRIBUTED\s+TRNG\s+PAY:\s+(\d{1,3}:[0-5]\d)/gi;
while ((m = re.exec(*nbps*(text))) !== null) total += *toMinutes*(m[1]);
return total;
}
function *grabALV*(text) {
text = *nbps*(text);
const idx = text.toUpperCase().indexOf(‘ALV’);
if (idx === -1) return 0;
const times = text.substring(idx, idx + 100).match(/\d{1,3}:[0-5]\d/g);
return times ? *toMinutes*(times[times.length - 1]) : 0;
}
function *parseRows*(text, prefix) {
text = *nbps*(text);
const segRe = new RegExp(
‘(\d{2}[A-Z]{3})\s+’ + prefix + ‘\s+([A-Z0-9/-]+)(.*?)(?=’ +
‘\d{2}[A-Z]{3}\s+’ + prefix + ‘\b|’ +
‘RES\s+OTHER\s+SUB\s+TTL|’ +
‘CREDIT\s+APPLICABLE|’ +
’\d{1,3}:[0-5]\d\s*\+\s*\d{1,3}:[0-5]\d|’ +  // guarantee math line
‘END OF DISPLAY|$)’,
‘gis’
);
const rows = []; let m;
while ((m = segRe.exec(text)) !== null)
rows.push({ nbr: (m[2]||’’).toUpperCase(), times: (m[0]||’’).match(/\b\d{1,3}:[0-5]\d\b/g)||[] });
return rows;
}
// Parse CREDIT, RES GUAR, and PAYBACK from the guarantee math line
function *grabReserveGuarLine*(text) {
text = *nbps*(text);
const m = text.match(/(\d{1,3}:[0-5]\d)\s*+\s*(\d{1,3}:[0-5]\d)\s*+\s*(\d{1,3}:[0-5]\d)\s*=\s*(\d{1,3}:[0-5]\d)\s*-\s*(\d{1,3}:[0-5]\d)/);
if (m) return { credit: *toMinutes*(m[1]), resGuar: *toMinutes*(m[2]), payback: *toMinutes*(m[5]) };
return { credit: 0, resGuar: 0, payback: 0 };
}
// Lineholder pay-only: skip single-time rows (block-only) and any row with consecutive
// equal times (those rows have credit already in TTL CREDIT — don’t double-count).
// Only rows with no consecutive equal times are genuine pay-only additions.
function *calcLineholderPayTimeOnly*(rows) {
let total = 0;
for (const r of rows) {
const t = r.times;
if (t.length < 2) continue; // single time = block-only row, ignore
let hasConsecEqual = false;
for (let i = 1; i < t.length; i++) { if (t[i] === t[i-1]) { hasConsecEqual = true; break; } }
if (hasConsecEqual) continue; // has credit, already in TTL CREDIT
total += *toMinutes*(t[t.length-1]); // genuine pay-only
}
return total;
}
function *calcLineholderAddtlOnly*(rows) {
let total=0;
for (const r of rows) if (r.times.length>=2) { const p=*toMinutes*(r.times[r.times.length-2]),l=*toMinutes*(r.times[r.times.length-1]); if(l<p)total+=l; }
return total;
}
// Known no-credit non-trip codes. Non-trip rows NOT in this list default to “has credit”
// (e.g. ALPP, SICK, IOEP, ALPE, HOL) — this prevents OCR-corrupted triplets from being double-counted.
function *isKnownNoCredit*(nbr) {
const n = nbr.toUpperCase();
if (/^ADJ/.test(n)) return true; // ADJ-RRPY and all ADJ- variants
return [‘LOSA’,‘LOFB’,‘VAC’,‘4F1C’].includes(n);
}

// Reserve: pay-no-credit rows WITHOUT block hours (LOSA, ADJ-RRPY, etc.)
// Trip rows (pure digit NBR) use block-hours detection.
// Non-trip rows (letters in NBR) must be in *isKnownNoCredit* to be counted —
// this guards against OCR dropping a credit-triplet’s first value (e.g. ALPP → doublet).
function *calcReservePayNoCreditNoBlock*(rows) {
let total=0;
for (const r of rows) {
const t=r.times; if (!t.length) continue;
const mins=t.map(*toMinutes*);
const hasTriplet=t.length>=3&&t[t.length-1]===t[t.length-2]&&t[t.length-2]===t[t.length-3];
if (hasTriplet) continue;
const hasMidTriplet=t.length>=4&&t[t.length-2]===t[t.length-3]&&t[t.length-3]===t[t.length-4];
if (hasMidTriplet) continue;
const isTrip=/^\d+$/.test(r.nbr); // pure digits = trip number (0558, 0719, etc.)
if (isTrip) {
// Trip rows: skip if they have block hours (flow into RES ASSIGN labeled line)
const hasBlockHrs=mins.length>=2&&mins[0]<mins[1];
if (hasBlockHrs) continue;
} else {
// Non-trip rows (LOSA, SICK, ALPP, ADJ-RRPY, etc.):
// only add if explicitly in the known no-credit list — guards against OCR-corrupted triplets
if (!*isKnownNoCredit*(r.nbr)) continue;
}
if (t.length>=2&&t[t.length-1]===t[t.length-2]) total+=mins[mins.length-1];
else if (t.length===1) total+=mins[0];
}
return total;
}
// ADDTL column: last time < second-to-last.
// Guard: for rows with a middle doublet (sked=pay) + block hours, if trailing > block hours
// it’s partial credit in the credit column, not addtl — skip it to avoid double-counting.
function *calcReserveAddtlOnly*(rows) {
let total=0;
for (const r of rows) {
if (r.times.length < 2) continue;
const t=r.times, mins=t.map(*toMinutes*);
const p=mins[mins.length-2], l=mins[mins.length-1];
if (l<=0||l>=p) continue;
const hasTriplet=t.length>=3&&t[t.length-1]===t[t.length-2]&&t[t.length-2]===t[t.length-3];
if (!hasTriplet&&t.length>=4) {
const hasMiddleDoublet=mins[mins.length-2]===mins[mins.length-3];
if (hasMiddleDoublet&&l>mins[0]) continue; // trailing > block hrs = partial credit, not addtl
}
total+=l;
}
return total;
}
function computeTotals(text) {
// Strip common OCR noise artifacts before any parsing
text = *nbps*(text).replace(/~~\s*/g, ‘’).replace(/\s{2,}/g, ’ ‘);
const cardType=*detectCardType*(text);
if (!cardType) return {error:‘unrecognized’,cardType:null,breakdown:[],totalMins:0,totalHMM:‘0:00’,totalDecimal:0,alv:0,suspicious:true};
const reroutePay=*grabLabeledTimeFlex*(text,[‘REROUTE PAY’]);
const gSlipPay=*grabLabeledTimeFlex*(text,[‘G/SLIP PAY’,‘G - SLIP PAY’,‘G SLIP PAY’]);
const assignPay=*grabLabeledTimeFlex*(text,[‘ASSIGN PAY’]);
const trainingPay=*grabTrainingPay*(text);
const alv=Math.round((*grabALV*(text)/60)*100)/100;
let totalMins, breakdown, suspicious;
if (cardType===‘LINEHOLDER’) {
const ttlCredit=*grabTtlCredit*(text);
const rows=*parseRows*(text,‘REG’);
const payTimeOnly=*calcLineholderPayTimeOnly*(rows);
const addtlOnly=*calcLineholderAddtlOnly*(rows);
const gSlip_x2=gSlipPay*2, assign_x2=assignPay*2;
totalMins=ttlCredit+payTimeOnly+addtlOnly+gSlip_x2+assign_x2+trainingPay;
suspicious=totalMins===0||ttlCredit===0;
breakdown=[
{label:‘Card Type’,      value:cardType},
{label:‘TTL CREDIT’,     value:*fromMinutes*(ttlCredit)},
{label:‘PAY TIME ONLY’,  value:*fromMinutes*(payTimeOnly)},
{label:‘ADDTL PAY ONLY’, value:*fromMinutes*(addtlOnly)},
{label:‘G/SLIP PAY ×2’,  value:*fromMinutes*(gSlip_x2)},
{label:‘ASSIGN PAY ×2’,  value:*fromMinutes*(assign_x2)},
{label:‘DISTRIBUTED TRNG PAY’, value:*fromMinutes*(trainingPay)},
];
} else {
// Use *grabTtlCredit* as the base — grabs last ‘= H:MM’ in guarantee block,
// which is post-payback and far more resilient to OCR corruption than parsing
// the individual credit/resGuar/payback values from the math line.
const ttlCredit=*grabTtlCredit*(text);
// Try to get credit/resGuar breakdown for display — fall back gracefully
const guarLine=*grabReserveGuarLine*(text);
const guarFailed=guarLine.credit===0&&guarLine.resGuar===0&&ttlCredit>0;
const rows=*parseRows*(text,‘RES’);
const resAssignGSlip=*grabLabeledTimeFlex*(text,[‘RES ASSIGN-G/Q SLIP PAY’,‘RES ASSIGN-G/Q-SLIP PAY’,‘RES ASSIGN-G/SLIP PAY’,‘RES ASSIGN G/SLIP PAY’]);
const payNoCredit=*calcReservePayNoCreditNoBlock*(rows);
const addtlOnly=*calcReserveAddtlOnly*(rows);
totalMins=ttlCredit+payNoCredit+addtlOnly+reroutePay+resAssignGSlip+trainingPay;
suspicious=totalMins===0||ttlCredit===0||guarFailed;
// Show detailed credit/resGuar breakdown when available, combined TTL CREDIT when not
if (!guarFailed) {
breakdown=[
{label:‘Card Type’,                       value:cardType},
{label:‘Credit (trips w/ credit)’,         value:*fromMinutes*(guarLine.credit)},
{label:‘RES Guarantee’,                    value:*fromMinutes*(guarLine.resGuar)},
{label:‘Pay No Credit (LOSA, RRPY, etc)’,  value:*fromMinutes*(payNoCredit)},
{label:‘ADDTL Pay Only’,                   value:*fromMinutes*(addtlOnly)},
{label:‘Reroute Pay’,                      value:*fromMinutes*(reroutePay)},
{label:‘RES GS/QS/IA Pay’,                value:*fromMinutes*(resAssignGSlip)},
{label:‘Distributed Trng Pay’,             value:*fromMinutes*(trainingPay)},
{label:‘Payback (Neg Bank)’,               value:guarLine.payback>0?’-’+*fromMinutes*(guarLine.payback):‘0:00’},
];
} else {
breakdown=[
{label:‘Card Type’,                       value:cardType},
{label:‘TTL CREDIT (post-payback)’,        value:*fromMinutes*(ttlCredit)},
{label:‘Pay No Credit (LOSA, RRPY, etc)’,  value:*fromMinutes*(payNoCredit)},
{label:‘ADDTL Pay Only’,                   value:*fromMinutes*(addtlOnly)},
{label:‘Reroute Pay’,                      value:*fromMinutes*(reroutePay)},
{label:‘RES GS/QS/IA Pay’,                value:*fromMinutes*(resAssignGSlip)},
{label:‘Distributed Trng Pay’,             value:*fromMinutes*(trainingPay)},
{label:‘NOTE’,                             value:‘Guarantee math garbled by OCR’},
];
}
}
return {cardType,breakdown,totalMins,totalHMM:*fromMinutes*(totalMins),totalDecimal:Math.round((totalMins/60)*100)/100,alv,suspicious,error:null};
}
async function sendEmail({ subject, body }) {
const apiKey=process.env.RESEND_API_KEY, to=process.env.NOTIFY_EMAIL;
if (!apiKey||!to) return;
await fetch(‘https://api.resend.com/emails’,{method:‘POST’,headers:{‘Authorization’:`Bearer ${apiKey}`,‘Content-Type’:‘application/json’},body:JSON.stringify({from:‘Timecard App [onboarding@resend.dev](mailto:onboarding@resend.dev)’,to:[to],subject,text:body})});
}
const CORS={‘Access-Control-Allow-Origin’:’*’,‘Access-Control-Allow-Methods’:‘POST, OPTIONS’,‘Access-Control-Allow-Headers’:‘Content-Type’,‘Content-Type’:‘application/json’};

exports.handler = async (event) => {
if (event.httpMethod !== ‘POST’) {
return { statusCode: 405, body: ‘Method Not Allowed’ };
}

let rawText = ‘’;

try {
const body = JSON.parse(event.body || ‘{}’);
rawText = String(body.text || ‘’).trim();

```
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
```

} catch (err) {
// Unexpected exception — email the raw input if we have it
try {
await sendEmail({
subject: ‘[Timecard App] Parse exception’,
body: [
‘An unexpected error occurred during parsing.’,
‘’,
`Error: ${err.message}`,
‘’,
‘— RAW INPUT (auto-deleted after this email) —’,
rawText || ‘(could not extract input)’,
‘— END OF INPUT —’
].join(’\n’)
});
} catch (_) { /* email failure shouldn’t surface to user */ }

```
return {
  statusCode: 500,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ error: 'An unexpected error occurred. The developer has been notified.' })
};
```

}
// rawText goes out of scope here — nothing is persisted
};
