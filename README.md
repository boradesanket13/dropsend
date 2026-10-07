# DropSend

DropSend is a privacy-first browser-to-browser file transfer application.

Files are encrypted in the browser and transferred directly between devices using WebRTC. A Cloudflare Worker and Durable Object are used for signaling only. DropSend does not require user accounts and does not store transferred files in the cloud.

## Features

- Browser-to-browser file transfer
- AES-GCM authenticated encryption
- WebRTC DataChannel transfers
- No accounts
- No cloud file storage
- Multiple file selection
- Drag-and-drop uploads
- QR-code transfer links
- SHA-256 integrity verification
- Browser-native file saving when supported
- WebRTC backpressure handling
- Cloudflare Durable Object signaling
- Responsive premium UI
- Hover and scroll interactions with reduced-motion support

## Architecture

```text
Browser A
   |
   | WebSocket signaling
   v
Cloudflare Worker
   |
   v
Durable Object
   |
   | SDP / ICE
   v
Browser B

Browser A <====== WebRTC DataChannel ======> Browser B
                         |
                    AES-GCM encryption
                         |
                        FILE
```

The signaling service coordinates WebRTC negotiation. File contents are transferred through the WebRTC DataChannel rather than through the signaling Worker.

## Technology Stack

### Web

- Next.js
- React
- TypeScript
- WebRTC
- Web Crypto API
- qrcode.react
- OpenNext
- Cloudflare Workers

### Signaling

- Cloudflare Workers
- Cloudflare Durable Objects
- WebSockets
- Wrangler
- TypeScript

### Security

- AES-GCM authenticated encryption
- Per-chunk nonces
- SHA-256 file integrity verification
- Browser-generated transfer secret
- Client-side transfer key

## Project Structure

```text
dropsend/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       ├── deploy-web.yml
│       └── deploy-signaling.yml
├── signaling/
│   ├── package.json
│   ├── package-lock.json
│   └── src/
├── web/
│   ├── app/
│   │   ├── globals.css
│   │   ├── layout.tsx
│   │   ├── page.css
│   │   └── page.tsx
│   ├── lib/
│   │   ├── crypto.ts
│   │   ├── format.ts
│   │   └── webrtc.ts
│   ├── public/
│   ├── next.config.ts
│   ├── open-next.config.ts
│   ├── wrangler.jsonc
│   ├── package.json
│   └── package-lock.json
├── .gitignore
├── CONTRIBUTING.md
└── README.md
```

## Local Development

### Prerequisites

- Node.js 24
- npm
- Git
- A modern browser with WebRTC and Web Crypto support

### Clone

```bash
git clone https://github.com/boradesanket13/dropsend.git
cd dropsend
```

### Start signaling

```bash
cd signaling
npm ci
npm run dev
```

### Start the web application

In another terminal:

```bash
cd web
npm ci
npm run dev
```

For local signaling:

```env
NEXT_PUBLIC_SIGNALING_URL=ws://localhost:8787
```

## Environment Variables

Production:

```env
NEXT_PUBLIC_SIGNALING_URL=wss://dropsend-signaling.dropsend.workers.dev
```

Local development:

```env
NEXT_PUBLIC_SIGNALING_URL=ws://localhost:8787
```

`NEXT_PUBLIC_SIGNALING_URL` is public browser configuration. Do not put secrets in `NEXT_PUBLIC_*` variables.

Never commit API tokens, private keys, or local secret files.

## Commands

### Web

```bash
cd web

npm run dev
npm run typecheck
npm run build
npm run preview
npm run deploy
npm run upload
npm run cf-typegen
```

### Signaling

```bash
cd signaling

npm run dev
npm run typecheck
npm run deploy
```

## Production Deployment

GitHub Actions deploys the application from `main`.

Changes under `web/` trigger the web deployment workflow.

Changes under `signaling/` trigger the signaling deployment workflow.

Required GitHub Actions secrets:

```text
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```

The production frontend connects to:

```text
wss://dropsend-signaling.dropsend.workers.dev
```

## Security Model

The browser generates the encryption secret. File chunks are encrypted before being sent through the WebRTC DataChannel.

The signaling service handles connection negotiation data such as:

- SDP offers and answers
- ICE candidates
- Room membership
- Peer connection state

The signaling service does not receive the file contents.

DropSend also calculates a SHA-256 digest and verifies the received file before completing the transfer.

## Connectivity

DropSend currently relies on direct WebRTC connectivity without a TURN relay.

Connectivity therefore depends on the network environments of both peers. Restrictive NATs, firewalls, VPNs, corporate networks, or client-isolation settings can prevent a direct connection.

A failed connection does not necessarily indicate an encryption failure.

## Browser Support

DropSend targets modern browsers supporting:

- WebRTC
- Web Crypto
- WebSocket
- File APIs

Native file-saving APIs vary by browser. Where browser capabilities differ, DropSend uses an appropriate fallback.

## Design Principles

1. Privacy first
2. No unnecessary accounts
3. No cloud file storage
4. Direct peer-to-peer transfer whenever possible
5. Encryption before transfer
6. Integrity verification after transfer
7. Minimal dependencies
8. Progressive enhancement
9. Accessible responsive UI
10. Clear technical behavior without misleading security claims

## Development Principles

- Keep the transfer engine stable when changing the UI.
- Prefer platform APIs over unnecessary dependencies.
- Keep TypeScript strictly typed.
- Avoid `any`.
- Keep components focused.
- Keep security-sensitive code small and explicit.
- Validate data received from signaling and peers.
- Preserve transfer integrity checks.
- Test sender and receiver flows.
- Respect reduced-motion preferences.
- Never commit secrets or credentials.

## License

This repository does not currently declare an open-source license.

Until a license is added, the source code should not be assumed to be available for unrestricted reuse, modification, or redistribution.
