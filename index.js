const express = require('express');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const API_SECRET = process.env.API_SECRET || 'changeme';

let sock = null;
let qrCodeData = null;
let isConnected = false;

const logger = pino({ level: 'silent' });

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    browser: ['EclesiaSaaS', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await QRCode.toDataURL(qr);
      isConnected = false;
      console.log('[WA] QR gerado. Acesse /qr para escanear.');
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('[WA] Conexão fechada. Reconectar?', shouldReconnect);
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
    }

    if (connection === 'open') {
      isConnected = true;
      qrCodeData = null;
      console.log('[WA] ✅ Conectado!');
    }
  });
}

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Normaliza telefone BR para JID do WhatsApp
function toJid(phone) {
  let p = String(phone).replace(/\D/g, '');
  if (!p.startsWith('55') && p.length <= 11) p = '55' + p;
  return `${p}@s.whatsapp.net`;
}

// ─── Rotas públicas ───────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, connected: isConnected, service: 'whatsapp-server' });
});

app.get('/status', (req, res) => {
  res.json({ connected: isConnected, hasQR: !!qrCodeData });
});

app.get('/qr', (req, res) => {
  if (isConnected) return res.send('<h2>✅ WhatsApp já conectado!</h2>');
  if (!qrCodeData) return res.send('<h2>Aguardando QR Code... recarregue em alguns segundos.</h2>');
  res.send(`
    <html><body style="text-align:center;font-family:sans-serif;padding:40px">
      <h2>Escaneie com o WhatsApp</h2>
      <p>WhatsApp → Aparelhos conectados → Conectar aparelho</p>
      <img src="${qrCodeData}" style="max-width:400px"/>
      <p><small>A página atualiza sozinha</small></p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>
  `);
});

// ─── Rotas autenticadas ───────────────────

// Envia mensagem livre (para lembretes, campanhas, etc.)
app.post('/send-message', auth, async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) return res.status(400).json({ error: 'phone e message são obrigatórios' });
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp não conectado' });

    const jid = toJid(phone);
    await sock.sendMessage(jid, { text: String(message) });
    res.json({ success: true, to: phone });
  } catch (err) {
    console.error('[send-message] erro:', err);
    res.status(500).json({ error: err.message || 'Erro ao enviar' });
  }
});

// Envio em lote (1 chamada para vários destinatários)
app.post('/send-bulk', auth, async (req, res) => {
  try {
    const { recipients, message } = req.body || {};
    if (!Array.isArray(recipients) || !message) {
      return res.status(400).json({ error: 'recipients (array) e message são obrigatórios' });
    }
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp não conectado' });

    const results = [];
    for (const r of recipients) {
      // r pode ser string (telefone) ou {phone, message?} para personalizar
      const phone = typeof r === 'string' ? r : r.phone;
      const text = typeof r === 'object' && r.message ? r.message : message;
      try {
        await sock.sendMessage(toJid(phone), { text: String(text) });
        results.push({ phone, success: true });
      } catch (e) {
        results.push({ phone, success: false, error: e.message });
      }
      // Delay para evitar bloqueio do WhatsApp
      await new Promise((r) => setTimeout(r, 1500));
    }
    res.json({ success: true, total: results.length, results });
  } catch (err) {
    console.error('[send-bulk] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

// Compatibilidade com /send (OTP) do servidor antigo
app.post('/send', auth, async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    if (!phone || !code) return res.status(400).json({ error: 'phone e code obrigatórios' });
    if (!isConnected) return res.status(503).json({ error: 'WhatsApp não conectado' });
    await sock.sendMessage(toJid(phone), { text: `Seu código de verificação é: *${code}*` });
    res.json({ success: true, to: phone });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`[server] rodando na porta ${PORT}`);
  connectToWhatsApp();
});
