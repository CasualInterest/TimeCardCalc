/*
 * Netlify Function: /api/report — fully self-contained, no imports.
 * No input data is stored after this function returns.
 */

// Email is sent inline in handler to support attachments
const CORS={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Content-Type':'application/json'};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const apiKey = process.env.RESEND_API_KEY;
    const to     = process.env.NOTIFY_EMAIL;
    const body        = JSON.parse(event.body || '{}');
    const rawText     = String(body.text || '').trim();
    const userMessage = String(body.message || '').trim();
    const parsedResult = body.result || null;

    const screenshot = body.screenshot || null;

    const emailBody = [
      'A user submitted an error report from the timecard app.',
      screenshot ? '(Screenshot attached)' : '(No screenshot provided)',
      '',
      userMessage
        ? `User description:\n"${userMessage}"`
        : '(User did not provide a description)',
      '',
      parsedResult ? [
        '--- RESULT SHOWN TO USER ---',
        `Card Type:     ${parsedResult.cardType || 'N/A'}`,
        `Total (H:MM):  ${parsedResult.totalHMM || 'N/A'}`,
        `Total (Decimal): ${parsedResult.totalDecimal || 'N/A'}`,
        `ALV:           ${parsedResult.alv || 'N/A'}`,
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

    const emailPayload = {
      from: 'Timecard App <onboarding@resend.dev>',
      to: [to],
      subject: '[Timecard App] User-submitted error report',
      text: emailBody
    };

    if (screenshot && screenshot.data && screenshot.name) {
      emailPayload.attachments = [{
        filename: screenshot.name,
        content: screenshot.data
      }];
    }

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(emailPayload)
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Failed to send report.' })
    };
  }
  // All data goes out of scope here — nothing is persisted
};
