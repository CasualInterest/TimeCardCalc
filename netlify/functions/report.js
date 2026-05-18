/*
 * Netlify Function: /api/report — fully self-contained, no imports.
 * No input data is stored after this function returns.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

async function sendReport({ apiKey, to, subject, body, screenshot }) {
  // Try with attachment first; fall back to text-only if attachment fails
  const base = {
    from: 'Timecard App <onboarding@resend.dev>',
    to:   [to],
    subject,
    text: body
  };

  if (screenshot && screenshot.data && screenshot.name) {
    const withAttachment = { ...base, attachments: [{ filename: screenshot.name, content: screenshot.data }] };
    const r1 = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(withAttachment)
    });
    if (r1.ok) return;
    // Attachment failed — retry without it
    base.text = body + '\n\n(Screenshot attachment failed to send)';
  }

  const r2 = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(base)
  });
  if (!r2.ok) {
    const detail = await r2.text().catch(() => '');
    throw new Error(`Resend error ${r2.status}: ${detail}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers: CORS, body: 'Method Not Allowed' };

  try {
    const apiKey = process.env.RESEND_API_KEY;
    const to     = process.env.NOTIFY_EMAIL;
    if (!apiKey || !to) throw new Error('Missing env vars');

    const body         = JSON.parse(event.body || '{}');
    const rawText      = String(body.text       || '').trim();
    const userMessage  = String(body.message    || '').trim();
    const userEmail    = String(body.userEmail  || '').trim();
    const parsedResult = body.result     || null;
    const screenshot   = body.screenshot || null;

    const emailBody = [
      'A user submitted an error report from the timecard app.',
      screenshot ? '(Screenshot attached)' : '(No screenshot provided)',
      userEmail  ? `User email: ${userEmail}` : '(No email provided)',
      '',
      userMessage ? `User description:\n"${userMessage}"` : '(User did not provide a description)',
      '',
      parsedResult ? [
        '--- RESULT SHOWN TO USER ---',
        `Card Type:       ${parsedResult.cardType    || 'N/A'}`,
        `Total (H:MM):    ${parsedResult.totalHMM    || 'N/A'}`,
        `Total (Decimal): ${parsedResult.totalDecimal || 'N/A'}`,
        `ALV:             ${parsedResult.alv          || 'N/A'}`,
        'Breakdown:',
        ...(parsedResult.breakdown || []).map(r => `  ${r.label}: ${r.value}`),
        '--- END RESULT ---',
      ].join('\n') : '',
      '',
      rawText ? [
        '--- RAW INPUT (auto-deleted after this email) ---',
        rawText,
        '--- END OF INPUT ---',
      ].join('\n') : '(No raw input provided)'
    ].join('\n');

    await sendReport({
      apiKey,
      to,
      subject: '[Timecard App] User-submitted error report',
      body: emailBody,
      screenshot
    });

    return { statusCode: 200, headers: CORS, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    console.error('report.js error:', err.message);
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'Failed to send report.' }) };
  }
};
