// WhatsApp server (Baileys) — para deploy no Render
// Retorna no /status: { connected, state, number, name }
import express from "express";
import baileys from "@whiskeysockets/baileys";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} = baileys;
import qrcode from "qrcode";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";

// Dependências esperadas no package.json do servidor:
//   "@whiskeysockets/baileys": "latest"  (ou ^6.7.x mais recente)
//   "node-cache": "^5.1.2"
// Após pull: `npm install` e reinicie o serviço no Render.

const app = express();
app.use(express.json({ limit: "1mb" }));

const API_SECRET = process.env.API_SECRET || "";
const AUTH_DIR = process.env.AUTH_DIR || "./auth_info_baileys";
const STORE_DIR = process.env.STORE_DIR || "./message_store";

let sock = null;
let currentQR = null;
let connState = "close";
let meJid = null;
let meName = null;

// Cache de retries (recomendado pelo exemplo oficial do Baileys)
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 10, useClones: false });

// Store persistente em disco para getMessage. Sem isso, ao reiniciar o
// servidor o iOS pede retry da mensagem original e nunca a recebe
// (fica em "Aguardando esta mensagem...").
if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });

function storePathFor(id) {
  // sanitiza p/ filesystem
  const safe = id.replace(/[^A-Za-z0-9._:-]/g, "_");
  return path.join(STORE_DIR, `${safe}.json`);
}

const logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  fatal: (...args) => console.error(...args),
  child: () => logger,
};

function messageKeyId(key) {
  if (!key?.remoteJid || !key?.id) return null;
  return `${key.remoteJid}:${key.id}`;
}

function rememberMessage(msg) {
  const id = messageKeyId(msg?.key);
  if (!id || !msg?.message) return;
  try {
    fs.writeFileSync(storePathFor(id), JSON.stringify(msg.message));
  } catch (e) {
    console.warn("rememberMessage write failed:", e.message);
  }
}

async function getMessage(key) {
  const id = messageKeyId(key);
  if (!id) return proto.Message.fromObject({});
  try {
    const file = storePathFor(id);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, "utf-8"));
      return proto.Message.fromObject(data);
    }
  } catch (e) {
    console.warn("getMessage read failed:", e.message);
  }
  return proto.Message.fromObject({});
}

function auth(req, res, next) {
  if (!API_SECRET) return next();
  if (req.headers["x-api-key"] !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function jidToNumber(jid) {
  if (!jid) return null;
  // ex: 5511999999999:12@s.whatsapp.net -> 5511999999999
  const raw = jid.split("@")[0].split(":")[0];
  return raw;
}

function formatBR(num) {
  if (!num) return null;
  // 55 11 99999-9999
  const m = num.match(/^(\d{2})(\d{2})(\d{4,5})(\d{4})$/);
  if (!m) return num;
  return `+${m[1]} ${m[2]} ${m[3]}-${m[4]}`;
}

function normalizeNumber(n) {
  let only = String(n).replace(/\D/g, "");
  if (only.length <= 11) only = "55" + only;
  return only + "@s.whatsapp.net";
}

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    getMessage,
    msgRetryCounterCache,
    maxMsgRetryCount: 15,
    // Identifica o cliente como WhatsApp Web "real" — ajuda a evitar
    // bloqueio de criptografia em iPhones recentes.
    browser: ["Chrome (Linux)", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages || []) rememberMessage(msg);
  });

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
    }
    if (connection) connState = connection;
    if (connection === "open") {
      currentQR = null;
      meJid = sock.user?.id || null;
      meName = sock.user?.name || sock.user?.verifiedName || null;
      console.log("✅ Conectado como", meJid, meName);
      // Re-publica pre-keys ao conectar — mitiga falhas de descriptografia
      // recorrentes em destinatários iPhone.
      try {
        if (typeof sock.uploadPreKeys === "function") {
          await sock.uploadPreKeys();
          console.log("🔑 Pre-keys republicadas");
        }
      } catch (e) {
        console.warn("uploadPreKeys falhou:", e.message);
      }
    }
    if (connection === "close") {
      meJid = null;
      meName = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("❌ Conexão fechada. Reconectar?", shouldReconnect);
      if (shouldReconnect) setTimeout(startSock, 2000);
    }
  });
}

app.get("/", (_req, res) => res.send("WhatsApp server ON"));

app.get("/status", auth, (_req, res) => {
  const number = jidToNumber(meJid);
  res.json({
    connected: connState === "open",
    state: connState,
    number,
    formatted: formatBR(number),
    name: meName,
  });
});

app.get("/qr", auth, (_req, res) => {
  res.json({ qr: currentQR });
});

app.post("/send-message", auth, async (req, res) => {
  try {
    const { number, message } = req.body || {};
    if (!number || !message) return res.status(400).json({ error: "number e message obrigatórios" });
    if (connState !== "open") return res.status(503).json({ error: "WhatsApp não conectado" });
    const jid = normalizeNumber(number);
    await sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-bulk", auth, async (req, res) => {
  try {
    const { recipients, message, messages } = req.body || {};
    // Preferir messages[] (uma mensagem personalizada por destinatário, com variáveis já renderizadas).
    // Fallback para recipients[] + message única (compatibilidade).
    let queue = [];
    if (Array.isArray(messages) && messages.length) {
      queue = messages
        .filter((m) => m && m.number && m.message)
        .map((m) => ({ number: m.number, message: m.message }));
    } else if (Array.isArray(recipients) && message) {
      queue = recipients.map((n) => ({ number: n, message }));
    } else {
      return res.status(400).json({ error: "Envie messages[{number,message}] ou recipients[] + message" });
    }
    if (connState !== "open") return res.status(503).json({ error: "WhatsApp não conectado" });

    const results = [];
    for (const item of queue) {
      try {
        await sock.sendMessage(normalizeNumber(item.number), { text: item.message });
        results.push({ n: item.number, ok: true });
      } catch (e) {
        results.push({ n: item.number, ok: false, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/disconnect", auth, async (_req, res) => {
  try {
    await sock?.logout();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Servidor na porta", PORT));

startSock().catch((e) => console.error("Erro ao iniciar:", e));
