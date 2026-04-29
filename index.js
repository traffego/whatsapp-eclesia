// WhatsApp Multi-Instance server (Baileys)
import express from "express";
import baileys from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import NodeCache from "node-cache";
import fs from "fs";
import path from "path";

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  proto,
} = baileys;

const app = express();
app.use(express.json({ limit: "5mb" }));

const API_SECRET = process.env.API_SECRET || "";
const BASE_AUTH_DIR = process.env.AUTH_DIR || "./auth_info_baileys";
const BASE_STORE_DIR = process.env.STORE_DIR || "./message_store";

// Map of active sessions: instanceId -> { sock, qr, state, meJid, meName }
const sessions = new Map();

const logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  fatal: (...args) => console.error(...args),
  child: () => logger,
};

function getFolders(instanceId) {
  const safeId = instanceId.replace(/[^A-Za-z0-9._:-]/g, "_");
  const authDir = path.join(BASE_AUTH_DIR, safeId);
  const storeDir = path.join(BASE_STORE_DIR, safeId);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
  if (!fs.existsSync(storeDir)) fs.mkdirSync(storeDir, { recursive: true });
  return { authDir, storeDir };
}

function storePathFor(storeDir, id) {
  const safe = id.replace(/[^A-Za-z0-9._:-]/g, "_");
  return path.join(storeDir, `${safe}.json`);
}

async function startSock(instanceId) {
  if (sessions.has(instanceId)) {
    const s = sessions.get(instanceId);
    if (s.state === "open") return s.sock;
    // If it's closed but in map, we'll recreate
  }

  const { authDir, storeDir } = getFolders(instanceId);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 10, useClones: false });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    getMessage: async (key) => {
      const id = `${key.remoteJid}:${key.id}`;
      try {
        const file = storePathFor(storeDir, id);
        if (fs.existsSync(file)) {
          const data = JSON.parse(fs.readFileSync(file, "utf-8"));
          return proto.Message.fromObject(data);
        }
      } catch (e) {}
      return proto.Message.fromObject({});
    },
    msgRetryCounterCache,
    maxMsgRetryCount: 15,
    browser: ["Chrome (Linux)", "Chrome", "120.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  const session = {
    sock,
    qr: null,
    state: "connecting",
    meJid: null,
    meName: null,
  };
  sessions.set(instanceId, session);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages || []) {
      const id = `${msg.key?.remoteJid}:${msg.key?.id}`;
      if (id && msg.message) {
        try {
          fs.writeFileSync(storePathFor(storeDir, id), JSON.stringify(msg.message));
        } catch (e) {}
      }
    }
  });

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      session.qr = await qrcode.toDataURL(qr);
    }
    if (connection) session.state = connection;
    if (connection === "open") {
      session.qr = null;
      session.meJid = sock.user?.id || null;
      session.meName = sock.user?.name || sock.user?.verifiedName || null;
      console.log(`✅ [${instanceId}] Conectado como ${session.meJid}`);
      try {
        if (typeof sock.uploadPreKeys === "function") await sock.uploadPreKeys();
      } catch (e) {}
    }
    if (connection === "close") {
      session.meJid = null;
      session.meName = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`❌ [${instanceId}] Conexão fechada. Reconectar? ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startSock(instanceId), 5000);
      } else {
        sessions.delete(instanceId);
      }
    }
  });

  return sock;
}

// Middleware: auth + instance handling
async function instanceHandler(req, res, next) {
  if (API_SECRET && req.headers["x-api-key"] !== API_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const instanceId = req.headers["x-instance-id"] || req.query.instanceId || req.body.instanceId;
  if (!instanceId) {
    return res.status(400).json({ error: "x-instance-id is required" });
  }

  req.instanceId = instanceId;
  let session = sessions.get(instanceId);
  
  if (!session) {
    await startSock(instanceId);
    session = sessions.get(instanceId);
  }

  req.session = session;
  next();
}

app.get("/", (_req, res) => res.send("WhatsApp Multi-Instance server ON"));

app.get("/status", instanceHandler, (req, res) => {
  const { session } = req;
  const number = session.meJid ? session.meJid.split("@")[0].split(":")[0] : null;
  res.json({
    connected: session.state === "open",
    state: session.state,
    number,
    name: session.meName,
  });
});

app.get("/qr", instanceHandler, (req, res) => {
  res.json({ qr: req.session.qr });
});

app.post("/send-message", instanceHandler, async (req, res) => {
  try {
    const { number, message } = req.body || {};
    if (!number || !message) return res.status(400).json({ error: "number e message obrigatórios" });
    if (req.session.state !== "open") return res.status(503).json({ error: "WhatsApp não conectado" });
    
    let jid = String(number).replace(/\D/g, "");
    if (jid.length <= 11) jid = "55" + jid;
    jid += "@s.whatsapp.net";

    await req.session.sock.sendMessage(jid, { text: message });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/send-bulk", instanceHandler, async (req, res) => {
  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) return res.status(400).json({ error: "messages[] obrigatório" });
    if (req.session.state !== "open") return res.status(503).json({ error: "WhatsApp não conectado" });

    const results = [];
    for (const item of messages) {
      try {
        let jid = String(item.number).replace(/\D/g, "");
        if (jid.length <= 11) jid = "55" + jid;
        jid += "@s.whatsapp.net";
        
        await req.session.sock.sendMessage(jid, { text: item.message });
        results.push({ n: item.number, ok: true });
      } catch (e) {
        results.push({ n: item.number, ok: false, error: e.message });
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/disconnect", instanceHandler, async (req, res) => {
  try {
    await req.session.sock?.logout();
    sessions.delete(req.instanceId);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Auto-restart active sessions on boot (optional but good)
if (fs.existsSync(BASE_AUTH_DIR)) {
  const instances = fs.readdirSync(BASE_AUTH_DIR);
  for (const inst of instances) {
    if (fs.statSync(path.join(BASE_AUTH_DIR, inst)).isDirectory()) {
      console.log(`Restoring session for ${inst}...`);
      startSock(inst).catch(() => {});
    }
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Multi-Instance Server na porta", PORT));
