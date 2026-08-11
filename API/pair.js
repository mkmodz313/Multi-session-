
import zlib from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const MAX_MS = 4.8 * 60 * 1000; // keep below the 5-minute Hobby limit
const logger = pino({ level: 'silent' });

function safeNumber(input) {
  let n = String(input || '').replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  return n;
}

function makeSessionId(creds) {
  const raw = Buffer.from(JSON.stringify(creds), 'utf8');
  const gz = zlib.gzipSync(raw, { level: 9 });
  return 'KnightBot!' + gz.toString('base64');
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok:false, error:'POST only' }));
  }

  let phone = safeNumber(req.body?.phone);
  if (!phone || phone.length < 8 || phone.length > 15) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({
      ok:false,
      error:'Enter a valid WhatsApp number with country code, e.g. 923001234567.'
    }));
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  let closed = false;
  const folder = path.join(os.tmpdir(), 'knightbot-' + crypto.randomUUID());
  let sock;

  const send = (event, data) => {
    if (!closed) {
      try { res.write(sse(event, data)); } catch { closed = true; }
    }
  };

  const cleanup = async () => {
    try { sock?.end?.(undefined); } catch {}
    try { fs.rmSync(folder, { recursive:true, force:true }); } catch {}
  };

  const timer = setTimeout(async () => {
    send('error', { error:'Pairing timed out. Please generate a new code.' });
    await cleanup();
    if (!closed) {
      try { res.end(); } catch {}
    }
  }, MAX_MS);

  try {
    fs.mkdirSync(folder, { recursive:true });

    const { state, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal:false,
      browser:['Chrome','Windows','10.0'],
      auth:state,
      syncFullHistory:false,
      markOnlineOnConnect:false
    });

    sock.ev.on('creds.update', saveCreds);

    let code = null;
    let codeTries = 0;
    while (!code && codeTries++ < 20) {
      try {
        code = await sock.requestPairingCode(phone);
      } catch {
        await new Promise(r => setTimeout(r, 750));
      }
    }

    if (!code) {
      clearTimeout(timer);
      await cleanup();
      send('error', { error:'Could not generate pairing code. Please try again.' });
      return res.end();
    }

    send('code', { code, expiresIn: 300 });

    sock.ev.on('connection.update', async (update) => {
      if (closed) return;

      if (update.connection === 'open') {
        try {
          // state.creds is kept up-to-date by Baileys via creds.update/saveCreds.
          const sessionId = makeSessionId(state.creds);
          send('connected', { sessionId });
          clearTimeout(timer);
          await cleanup();
          try { res.end(); } catch {}
          closed = true;
        } catch (e) {
          clearTimeout(timer);
          send('error', { error:'Connected, but Session ID could not be created.' });
          await cleanup();
          try { res.end(); } catch {}
          closed = true;
        }
        return;
      }

      if (update.connection === 'close') {
        const status = update.lastDisconnect?.error?.output?.statusCode;
        if (status === DisconnectReason.loggedOut) {
          send('error', { error:'WhatsApp logged out before the session was generated.' });
        } else {
          send('error', { error:'WhatsApp connection closed. Please generate a new pairing code.' });
        }
        clearTimeout(timer);
        await cleanup();
        try { res.end(); } catch {}
        closed = true;
      }
    });

    req.on?.('close', async () => {
      // If the browser leaves the page, stop the WhatsApp pairing socket.
      if (!closed) {
        closed = true;
        clearTimeout(timer);
        await cleanup();
      }
    });
  } catch (e) {
    clearTimeout(timer);
    await cleanup();
    send('error', { error: e.message || 'Server error.' });
    try { res.end(); } catch {}
    closed = true;
  }
};
