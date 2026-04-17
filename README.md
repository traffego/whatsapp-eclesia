# WhatsApp Server – EclesiaSaaS

Servidor Node.js (Baileys) para envio de mensagens livres via WhatsApp.
Pronto para deploy no Render.com com disco persistente (mantém a sessão entre deploys).

## Endpoints

| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET  | `/`              | não | Health check |
| GET  | `/status`        | não | Status da conexão |
| GET  | `/qr`            | não | Página com QR Code |
| POST | `/send-message`  | sim | Envia 1 mensagem livre `{phone, message}` |
| POST | `/send-bulk`     | sim | Envia para vários `{recipients:[...], message}` |
| POST | `/send`          | sim | Compat. OTP `{phone, code}` |

Header de autenticação: `x-api-key: <API_SECRET>`

## Deploy no Render

1. Suba esses arquivos num repo no GitHub.
2. Render → New → Web Service → conecte o repo.
3. O `render.yaml` é detectado e cria tudo (disco + env vars).
4. Após o deploy, abra `https://SEU-APP.onrender.com/qr` e escaneie.
5. Copie o `API_SECRET` (Render → Environment) e a URL — vamos usar no app.

## Telefone
Aceita formatos: `5511999999999`, `11999999999`, `(11) 99999-9999`. O servidor normaliza e adiciona DDI 55 quando faltar.
