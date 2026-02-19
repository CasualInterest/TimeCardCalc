/*
 * Email utility using Resend API.
 * API key and recipient are read from Netlify environment variables only.
 * No data is logged or stored.
 */

async function sendEmail({ subject, body }) {
  const apiKey = process.env.RESEND_API_KEY;
  const to     = process.env.NOTIFY_EMAIL;

  if (!apiKey || !to) {
    console.error('Missing RESEND_API_KEY or NOTIFY_EMAIL env vars');
    return false;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Timecard App <onboarding@resend.dev>',
      to: [to],
      subject,
      text: body
    })
  });

  return res.ok;
}

module.exports = { sendEmail };
