/*
 * Netlify Function: /api/parse
 * Accepts raw timecard text, runs the parser, returns results.
 * No input data is stored. On parse failure or suspicious result,
 * sends an auto-error email then discards the data.
 */

const { computeTotals } = require('./lib/parser');
const { sendEmail }     = require('./lib/email');

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
