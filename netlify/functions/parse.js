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
‘(\d{2}[A-Z]{3})\s+’ + prefix + ‘\s+([A-Z0-9/-]+)(.*?)(?=\d{2}[A-Z]{3}\s+’ + prefix + ‘\b|RES\s+OTHER\s+SUB\s+TTL|CREDIT\s+APPLICABLE|END OF DISPLAY|$)’,
‘gis’
);
const rows = []; let m;
while ((m = segRe.exec(text)) !== null) {
rows.push({ nbr: (m[2]||’’).toUpperCase(), times: (m[0] || ‘’).match(/\b\d{1,3}:[0-5]\d\b/g) || [] });
}
return rows;
}
function *calcLineholderPayTimeOnly*(rows) {
return rows.reduce((t,r) => r.times.length===1 ? t+*toMinutes*(r.times[0]) : t, 0);
}
function *calcLineholderAddtlOnly*(rows) {
let total=0;
for (const r of rows) if (r.times.length>=2) { const p=*toMinutes*(r.times[r.times.length-2]),l=*toMinutes*(r.times[r.times.length-1]); if(l<p)total+=l; }
return total;
}
// Reserve: pay-no-credit rows WITHOUT block hours (LOSA, ADJ-RRPY, etc.)
// Rows WITH block hours that have no credit are captured by the RES ASSIGN labeled line — don’t double count.
function *calcReservePayNoCreditNoBlock*(rows) {
let total=0;
for (const r of rows) {
const t=r.times; if (!t.length) continue;
const mins=t.map(*toMinutes*);
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
function *calcReserveAddtlOnly*(rows) {
let total=0;
for (const r of rows) if (r.times.length>=2) { const p=*toMinutes*(r.times[r.times.length-2]),l=*toMinutes*(r.times[r.times.length-1]); if(l>0&&l<p)total+=l; }
return total;
}
function computeTotals(text) {
const cardType=*detectCardType*(text);
if (!cardType) return {error:‘unrecognized’,cardType:null,breakdown:[],totalMins:0,totalHMM:‘0:00’,totalDecimal:0,alv:0,suspicious:true};
const ttlCredit=*grabTtlCredit*(text);
const reroutePay=*grabLabeledTimeFlex*(text,[‘REROUTE PAY’]);
const gSlipPay=*grabLabeledTimeFlex*(text,[‘G/SLIP PAY’,‘G - SLIP PAY’,‘G SLIP PAY’]);
const assignPay=*grabLabeledTimeFlex*(text,[‘ASSIGN PAY’]);
const trainingPay=*grabTrainingPay*(text);
const alv=Math.round((*grabALV*(text)/60)*100)/100;
let totalMins, breakdown;
if (cardType===‘LINEHOLDER’) {
const rows=*parseRows*(text,‘REG’);
const payTimeOnly=*calcLineholderPayTimeOnly*(rows);
const addtlOnly=*calcLineholderAddtlOnly*(rows);
const gSlip_x2=gSlipPay*2, assign_x2=assignPay*2;
totalMins=ttlCredit+payTimeOnly+addtlOnly+gSlip_x2+assign_x2;
breakdown=[{label:‘Card Type’,value:cardType},{label:‘TTL CREDIT’,value:*fromMinutes*(ttlCredit)},{label:‘PAY TIME ONLY’,value:*fromMinutes*(payTimeOnly)},{label:‘ADDTL PAY ONLY’,value:*fromMinutes*(addtlOnly)},{label:‘G/SLIP PAY ×2’,value:*fromMinutes*(gSlip_x2)},{label:‘ASSIGN PAY ×2’,value:*fromMinutes*(assign_x2)}];
} else {
const rows=*parseRows*(text,‘RES’);
const resAssignGSlip=*grabLabeledTimeFlex*(text,[‘RES ASSIGN-G/Q SLIP PAY’,‘RES ASSIGN-G/Q-SLIP PAY’,‘RES ASSIGN-G/SLIP PAY’,‘RES ASSIGN G/SLIP PAY’]);
const payNoCredit=*calcReservePayNoCreditNoBlock*(rows);
const addtlOnly=*calcReserveAddtlOnly*(rows);
totalMins=ttlCredit+payNoCredit+addtlOnly+reroutePay+resAssignGSlip+trainingPay;
breakdown=[
{label:‘Card Type’,            value:cardType},
{label:‘TTL CREDIT’,           value:*fromMinutes*(ttlCredit)},
{label:‘PAY NO CREDIT (LOSA, RRPY, etc.)’, value:*fromMinutes*(payNoCredit)},
{label:‘ADDTL PAY ONLY’,       value:*fromMinutes*(addtlOnly)},
{label:‘RES ASSIGN / G·Q·S PAY’, value:*fromMinutes*(resAssignGSlip)},
{label:‘REROUTE PAY’,          value:*fromMinutes*(reroutePay)},
{label:‘DISTRIBUTED TRNG PAY’, value:*fromMinutes*(trainingPay)},
];
}
return {cardType,breakdown,totalMins,totalHMM:*fromMinutes*(totalMins),totalDecimal:Math.round((totalMins/60)*100)/100,alv,suspicious:totalMins===0||ttlCredit===0,error:null};
}
async function sendEmail(subject, body) {
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
