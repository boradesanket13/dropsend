# DropSend
 
Send files straight from one browser to another. Files are encrypted in your browser and travel directly between devices over WebRTC. 
 
## How it works
 
1. sender picks files and gets a link or QR code.
2. receiver opens it, and the two browsers connect through a small signaling server (a Cloudflare Worker with a Durable Object).
3. files are encrypted and sent directly peer to peer. The signaling server only passes connection details and never sees the files.
4. receiver checks a SHA-256 hash to confirm the file arrived intact
```
Browser A ──(WebSocket)──► Cloudflare Worker + Durable Object ◄──(WebSocket)── Browser B
    │                         (signaling only: SDP / ICE)                          │
    └═════════════════ encrypted WebRTC DataChannel ═══════════════════════════════┘
```
 
## Features
 
- direct browser-to-browser transfer
- AES-GCM encryption with a per-chunk nonce
- SHA-256 integrity check
- multiple files, drag and drop, QR-code links
- backpressure handling for large files
- No accounts, no file storage

  
## Tech stack
 
- **Web:** Next.js, React, TypeScript, Web Crypto API, WebRTC
- **Signaling:** Cloudflare Workers, Durable Objects, WebSockets
- **Deploy:** OpenNext, Wrangler, GitHub Actions
- 
## Project structure
 
```
web/          Next.js app (UI, crypto and WebRTC logic in lib/)
signaling/    Cloudflare Worker + Durable Object
.github/      CI and deploy workflows
```
 
## Run it locally
 
You need Node.js 24 and a modern browser.
 
```bash
git clone https://github.com/boradesanket13/dropsend.git
cd dropsend
 
# terminal 1: signaling server
cd signaling
npm ci
npm run dev
 
# terminal 2: web app
cd web
npm ci
npm run dev
```
 
In web/, set the signaling URL for local development:
 
```env
NEXT_PUBLIC_SIGNALING_URL=ws://localhost:8787
```
 
## Deployment
 
Pushes to main deploy automatically through GitHub Actions. Changes in web/ deploy the app, and changes in signaling/ deploy the signaling Worker. Add these repository secrets:
 
```
CLOUDFLARE_API_TOKEN
CLOUDFLARE_ACCOUNT_ID
```
 
NEXT_PUBLIC_SIGNALING_URL is public, so never put secrets in NEXT_PUBLIC_* variables.
 
## Limitations
 
DropSend uses direct WebRTC without a TURN relay. If either person is behind a strict NAT, firewall, VPN or corporate network, the connection can fail..
 
## License
 
MIT
 
