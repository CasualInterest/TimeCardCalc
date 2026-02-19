/*
 * Delta Timecard Parser - Core Logic
 * Ported from Google Apps Script. No data is stored or logged.
 */

function _toMinutes_(s) {
  if (!s || typeof s !== 'string') return 0;
  const m = s.trim().match(/^(\d{1,3}):([0-5]\d)$/);
  return m ? (parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) : 0;
}

function _fromMinutes_(mins) {
  mins = Math.max(0, mins | 0);
  const h = Math.floor(mins / 60), m = mins % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function _nbps_(t) {
  return String(t || '').replace(/\u00A0/g, ' ');
}

function _detectCardType_(text) {
  text = _nbps_(text).toUpperCase();
  const sawRES = /\b\d{2}[A-Z]{3}\s+RES\b/.test(text);
  const sawREG = /\b\d{2}[A-Z]{3}\s+REG\b/.test(text);
  if (sawRES && !sawREG) return 'RESERVE';
  if (sawREG && !sawRES) return 'LINEHOLDER';
  if (sawRES && sawREG)  return 'RESERVE';
  return null; // unrecognized
}

function _grabTtlCredit_(raw) {
  const text = _nbps_(raw);
  const eqTimes = [...text.matchAll(/=\s*(\d{1,3}:[0-5]\d)/g)];
  if (eqTimes.length) {
    const last = eqTimes[eqTimes.length - 1][1];
    return _toMinutes_(last);
  }
  return 0;
}

function _grabLabeledTimeFlex_(text, variants) {
  text = _nbps_(text);
  for (const v of variants) {
    let re = new RegExp(
      v.replace(/\s+/g, '\\s+').replace(/[-/]/g, m => '\\' + m) +
      '\\s*:\\s*(\\d{1,3}:[0-5]\\d)', 'i'
    );
    let m = text.match(re);
    if (m) return _toMinutes_(m[1]);

    re = new RegExp(
      v.replace(/\s+/g, '\\s+').replace(/[-/]/g, m => '\\' + m) +
      '\\s+(\\d{1,3}:[0-5]\\d)', 'i'
    );
    m = text.match(re);
    if (m) return _toMinutes_(m[1]);
  }
  return 0;
}

function _grabTrainingPay_(text) {
  text = _nbps_(text);
  let total = 0;
  const re = /DISTRIBUTED\s+TRNG\s+PAY:\s+(\d{1,3}:[0-5]\d)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    total += _toMinutes_(m[1]);
  }
  return total;
}

function _grabALV_(text) {
  text = _nbps_(text);
  const alvIndex = text.toUpperCase().indexOf('ALV');
  if (alvIndex === -1) return 0;
  const afterALV = text.substring(alvIndex, alvIndex + 100);
  const times = afterALV.match(/\d{1,3}:[0-5]\d/g);
  if (!times || times.length === 0) return 0;
  return _toMinutes_(times[times.length - 1]);
}

function _parseRows_(text, prefix) {
  text = _nbps_(text);
  const segRe = new RegExp(
    '(\\d{2}[A-Z]{3})\\s+' + prefix + '\\s+([A-Z0-9/-]+)' +
    '(.*?)(?=' +
      '\\d{2}[A-Z]{3}\\s+' + prefix + '\\b|' +
      'RES\\s+OTHER\\s+SUB\\s+TTL|' +
      'CREDIT\\s+APPLICABLE|' +
      'END OF DISPLAY|$)',
    'gis'
  );
  const rows = [];
  let m;
  while ((m = segRe.exec(text)) !== null) {
    const fullRow = (m[0] || '');
    const times = fullRow.match(/\b\d{1,3}:[0-5]\d\b/g) || [];
    rows.push({ date: (m[1] || '').toUpperCase(), nbr: (m[2] || '').toUpperCase(), times, raw: fullRow.trim() });
  }
  return rows;
}

function _calcLineholderPayTimeOnly_(rows) {
  let total = 0;
  for (const r of rows) {
    if (r.times.length === 1) total += _toMinutes_(r.times[0]);
  }
  return total;
}

function _calcLineholderAddtlOnly_(rows) {
  let total = 0;
  for (const r of rows) {
    if (r.times.length >= 2) {
      const prevLast = _toMinutes_(r.times[r.times.length - 2]);
      const last = _toMinutes_(r.times[r.times.length - 1]);
      if (last < prevLast) total += last;
    }
  }
  return total;
}

function _calcReservePayTimeOnlyStructural_(rows) {
  let total = 0;
  for (const r of rows) {
    const times = r.times;
    if (!times.length) continue;
    const minsList = times.map(_toMinutes_);
    const has_block_hrs = minsList.length >= 2 && minsList[0] < minsList[1];
    const has_credit_triplet = times.length >= 3 &&
      times[times.length - 1] === times[times.length - 2] &&
      times[times.length - 2] === times[times.length - 3];
    if (has_block_hrs || has_credit_triplet) continue;
    total += minsList[minsList.length - 1];
  }
  return total;
}

function _calcReserveAddtlOnly_(rows) {
  let total = 0;
  for (const r of rows) {
    if (r.times.length >= 2) {
      const prevLast = _toMinutes_(r.times[r.times.length - 2]);
      const last = _toMinutes_(r.times[r.times.length - 1]);
      if (last < prevLast) total += last;
    }
  }
  return total;
}

function computeTotals(text) {
  const cardType = _detectCardType_(text);
  if (!cardType) {
    return { error: 'unrecognized', cardType: null, breakdown: [], totalMins: 0, totalHMM: '0:00', totalDecimal: 0, alv: 0 };
  }

  const ttlCredit      = _grabTtlCredit_(text);
  const resAssignGSlip = _grabLabeledTimeFlex_(text, ['RES ASSIGN-G/SLIP PAY', 'RES ASSIGN G/SLIP PAY']);
  const assignPay      = _grabLabeledTimeFlex_(text, ['ASSIGN PAY']);
  const reroutePay     = _grabLabeledTimeFlex_(text, ['REROUTE PAY']);
  const gSlipPay       = _grabLabeledTimeFlex_(text, ['G/SLIP PAY', 'G - SLIP PAY', 'G SLIP PAY']);
  const ttlBankOpts    = _grabLabeledTimeFlex_(text, ['TTL BANK OPTS AWARD', 'TTL BANK OPT 1', 'BANK OPT 1\\s+AWD', 'BANK OPT 1\\s+AWARD']);
  const trainingPay    = _grabTrainingPay_(text);
  const alvMins        = _grabALV_(text);
  const alv            = Math.round((alvMins / 60) * 100) / 100;

  let totalMins, breakdown;

  if (cardType === 'LINEHOLDER') {
    const rows        = _parseRows_(text, 'REG');
    const payTimeOnly = _calcLineholderPayTimeOnly_(rows);
    const addtlOnly   = _calcLineholderAddtlOnly_(rows);
    const gSlip_x2    = gSlipPay * 2;
    const assign_x2   = assignPay * 2;

    totalMins = ttlCredit + payTimeOnly + addtlOnly + gSlip_x2 + assign_x2;
    breakdown = [
      { label: 'Card Type',                value: cardType },
      { label: 'TTL CREDIT',               value: _fromMinutes_(ttlCredit) },
      { label: 'PAY TIME ONLY',            value: _fromMinutes_(payTimeOnly) },
      { label: 'ADDTL PAY ONLY',           value: _fromMinutes_(addtlOnly) },
      { label: 'G/SLIP PAY ×2',            value: _fromMinutes_(gSlip_x2) },
      { label: 'ASSIGN PAY ×2',            value: _fromMinutes_(assign_x2) },
    ];
  } else {
    const rows               = _parseRows_(text, 'RES');
    const payTimeOnlyStruct  = _calcReservePayTimeOnlyStructural_(rows);
    const addtlOnly          = _calcReserveAddtlOnly_(rows);

    totalMins = ttlCredit + payTimeOnlyStruct + addtlOnly + resAssignGSlip + assignPay + reroutePay + trainingPay + ttlBankOpts;
    breakdown = [
      { label: 'Card Type',                value: cardType },
      { label: 'TTL CREDIT',               value: _fromMinutes_(ttlCredit) },
      { label: 'PAY TIME ONLY',            value: _fromMinutes_(payTimeOnlyStruct) },
      { label: 'ADDTL PAY ONLY',           value: _fromMinutes_(addtlOnly) },
      { label: 'RES ASSIGN-G/SLIP PAY',    value: _fromMinutes_(resAssignGSlip) },
      { label: 'ASSIGN PAY',               value: _fromMinutes_(assignPay) },
      { label: 'REROUTE PAY',              value: _fromMinutes_(reroutePay) },
      { label: 'DISTRIBUTED TRNG PAY',     value: _fromMinutes_(trainingPay) },
      { label: 'TTL BANK OPTS AWARD',      value: _fromMinutes_(ttlBankOpts) },
    ];
  }

  const totalDecimal = Math.round((totalMins / 60) * 100) / 100;
  const suspicious   = totalMins === 0 || ttlCredit === 0;

  return {
    cardType,
    breakdown,
    totalMins,
    totalHMM: _fromMinutes_(totalMins),
    totalDecimal,
    alv,
    suspicious,
    error: null
  };
}

module.exports = { computeTotals };
