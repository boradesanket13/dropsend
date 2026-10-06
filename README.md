# DropSend 

Privacy-first browser-to-browser file transfer.

## Architecture

- Next.js frontend
- Cloudflare Worker + Durable Object for ephemeral WebSocket signaling
- WebRTC DataChannel for file bytes
- Web Crypto AES-GCM for application-layer encryption
- SHA-256 integrity verification

## Local setup

### Signaling (Backend)

```bash
cd signaling
npm install
npm run dev
```

### Web (Frontend)

```bash
cd web
cp .env.example .env.local
npm install
npm run dev
```

Default local signaling URL: `ws://localhost:8787`.

