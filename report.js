/*
 * Netlify Function: /api/report
 * Accepts a user-submitted error report (parsed result + optional description).
 * Sends email to the developer, then discards all data.
 */

const { sendEmail } = require('./lib/email');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const body        = JSON.parse(event.body || '{}');
    const rawText     = String(body.text || '').trim();
    const userMessage = String(body.message || '').trim();
    const parsedResult = body.result || null;

    await sendEmail({
      subject: '[Timecard App] User-submitted error report',
      body: [
        'A user submitted an error report from the timecard app.',
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
      ].join('\n')
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
