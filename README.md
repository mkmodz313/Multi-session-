# KnightBot Vercel Session Generator

This version is designed specifically for Vercel.

## Deploy

1. Upload this folder to GitHub, or import it directly into Vercel.
2. Vercel should detect the project automatically.
3. No build command is required.
4. Deploy.

The site will be served from `public/index.html` and the pairing API is under `/api/pair`.

## Important

The pairing request is intentionally kept open as a streamed response while the WhatsApp connection is being established. This lets the same Vercel Function own the temporary Baileys socket and return the `KnightBot!` session when WhatsApp connects.

`vercel.json` sets the function to 300 seconds. That is suitable for Vercel Hobby's current maximum. Pro/Enterprise can use longer durations if needed.

This is a session GENERATOR only. It does not replace the existing KnightBot Mini server. After the user receives the `KnightBot!` session ID, they use it with their existing bot instance.

## Security

A Session ID is WhatsApp authentication material. Never publish it, log it, or put it in screenshots. This project deletes the temporary auth directory after the session is generated or the pairing ends.

## Architecture

Vercel:
  Browser + pairing function
        ↓
  WhatsApp pairing
        ↓
  KnightBot! session ID
        ↓
Existing KnightBot Mini deployment

For large-scale, always-on WhatsApp connections, use a persistent Node.js service instead of Vercel for the WhatsApp worker. Vercel is being used here for the short-lived session-generation workflow.
