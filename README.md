# Timecard Calculator

A privacy-first web app for calculating airline timecard pay hours.

## Features

- Paste timecard text to calculate total billable hours with a full breakdown
- Screenshot upload (Beta) — OCR runs entirely in the browser, no image data is transmitted
- Automatic error notification to the developer if parsing fails
- Manual "Report an Error" option for users with an optional description field
- No data is stored after the session ends

## Setup

### 1. Deploy to Netlify

Fork or clone this repo, then connect it to Netlify. All files in the root are served as the site.

### 2. Set Environment Variables in Netlify Dashboard

Go to **Site Settings → Environment Variables** and add:

| Variable | Value |
|---|---|
| `RESEND_API_KEY` | Your Resend API key (get one free at resend.com) |
| `NOTIFY_EMAIL` | The email address to receive error reports |

**Never put these values in code or commit them to the repo.**

### 3. Resend Setup

1. Sign up at [resend.com](https://resend.com) — free tier covers 100 emails/day
2. Create an API key
3. Add your sending domain or use the default `onboarding@resend.dev` for testing

## Privacy

- Timecard text is sent to a Netlify serverless function only for calculation — it is processed in memory and immediately discarded
- Screenshots never leave the browser — Tesseract.js runs OCR client-side
- Error reports include the raw input only at the time the email is sent — nothing is written to a database or log
- No analytics, no cookies, no tracking

## Project Structure

```
index.html                        # Full UI
netlify.toml                      # Build + security headers config
netlify/functions/
  parse.js                        # Timecard parse endpoint + auto-error email
  report.js                       # Manual user error report endpoint
  lib/
    parser.js                     # Core parsing logic (ported from Google Apps Script)
    email.js                      # Resend API email utility
```
