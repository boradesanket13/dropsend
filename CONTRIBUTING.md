# Contributing to DropSend

Thank you for contributing to DropSend.

DropSend is a privacy-first peer-to-peer file transfer project. Contributions should preserve its security model, reliability, simplicity, and product quality.

## Before You Start

Read `README.md` first and understand the separation between:

- Next.js web application
- WebRTC transfer layer
- Cloudflare signaling Worker
- Durable Object room
- Browser-side encryption
- File integrity verification

Do not change security-sensitive behavior without understanding the complete transfer flow.

## Development Setup

Requirements:

- Node.js 24
- npm
- Git
- Modern WebRTC-capable browser

Clone the repository:

```bash
git clone https://github.com/boradesanket13/dropsend.git
cd dropsend
```

Install frontend dependencies:

```bash
cd web
npm ci
```

Install signaling dependencies:

```bash
cd ../signaling
npm ci
```

## Running Locally

Start signaling:

```bash
cd signaling
npm run dev
```

Start the web application in another terminal:

```bash
cd web
npm run dev
```

For local signaling:

```env
NEXT_PUBLIC_SIGNALING_URL=ws://localhost:8787
```

## Branches

Create a focused branch from `main`:

```bash
git checkout main
git pull origin main
git checkout -b feature/your-change
```

Use descriptive names:

```text
feature/improved-transfer-ui
fix/ice-candidate-handling
fix/file-integrity-validation
refactor/signaling-room
docs/update-deployment-guide
```

## Coding Standards

### TypeScript

- Use strict TypeScript.
- Avoid `any`.
- Prefer explicit types for protocol messages and public interfaces.
- Keep functions focused.
- Prefer immutable state updates.
- Use descriptive names.
- Avoid unnecessary abstraction.
- Do not duplicate security-sensitive logic.

### React

- Keep components focused.
- Clean up event listeners, timers, WebSockets, and WebRTC connections.
- Preserve keyboard and screen-reader accessibility.
- Keep browser-only APIs in client-safe execution paths.
- Respect `prefers-reduced-motion`.

### CSS

- Keep component-specific styling in `page.css`.
- Keep global CSS limited to reset/base behavior.
- Preserve responsive behavior.
- Prefer restrained borders, spacing, typography, and motion over excessive effects.
- Keep hover and scroll animations purposeful.
- Preserve the DropSend blue visual identity.
- Avoid introducing an unrelated visual language.

## Security-Sensitive Code

Changes involving any of the following require extra care:

- AES-GCM
- Encryption keys
- Nonces
- WebRTC signaling
- SDP
- ICE candidates
- DataChannels
- File chunking
- SHA-256 verification
- Transfer protocol messages
- Durable Object room validation

Do not remove validation merely to make a transfer succeed.

Never log encryption keys, transfer secrets, file contents, or sensitive signaling data.

## Transfer Protocol Changes

If changing the transfer protocol:

1. Document the protocol change.
2. Update sender and receiver behavior.
3. Preserve compatibility where practical.
4. Validate malformed messages.
5. Test multiple files.
6. Test interrupted connections.
7. Test integrity verification.
8. Test representative larger files.
9. Test sender and receiver independently.
10. Do not consider a UI-only test sufficient.

## UI Contributions

DropSend uses a premium, restrained product-design language.

When changing the UI:

- Keep the interface light and editorial.
- Use the established DropSend blue accent.
- Preserve the DropSend logo and identity.
- Prefer typography, spacing, borders, and purposeful motion.
- Avoid generic AI/SaaS visual patterns.
- Avoid excessive cards and decorative gradients.
- Make interactive states obvious.
- Check keyboard accessibility.
- Check mobile layouts.
- Check reduced-motion behavior.

## Testing

Before submitting a change:

```bash
cd web
npm run typecheck
npm run build
```

For signaling changes:

```bash
cd signaling
npm run typecheck
```

For runtime changes, manually test in at least two browser contexts.

Test transfer flows including:

- Sender to receiver
- Receiver joining from a transfer link
- One file
- Multiple files
- Drag-and-drop
- File selection
- Transfer progress
- SHA-256 verification
- Completion state
- Reset/new transfer
- Connection failure handling

## Git Checks

Review changes before committing:

```bash
git status
git diff
git diff --cached
```

Never commit:

- `.env.local`
- API tokens
- Cloudflare credentials
- Private keys
- Personal data
- Build output
- Dependency caches
- Local editor files

## Commit Messages

Use concise imperative messages.

Good:

```text
Add transfer progress state
Fix WebRTC candidate handling
Improve mobile transfer layout
Add signaling validation
Update deployment documentation
```

Avoid:

```text
changes
fix
update stuff
final final
UI
```

Keep unrelated changes out of the same commit.

## Pull Requests

A pull request should explain:

1. What changed
2. Why it changed
3. How it was tested
4. Whether the transfer protocol changed
5. Whether security-sensitive behavior changed
6. Whether deployment configuration changed

Example:

```text
## Summary

- Improved transfer progress UI
- Added responsive mobile states
- Preserved existing WebRTC transfer protocol

## Testing

- npm run typecheck
- npm run build
- Tested sender and receiver
- Tested multiple files
- Tested mobile layout

## Security

No encryption or signaling protocol changes.
```

## Security Issues

Do not publicly disclose a suspected security vulnerability before it has been reviewed.

Security-sensitive issues include:

- Exposure of encryption keys
- File data being sent to an unexpected server
- Signaling room takeover
- Malformed signaling causing unintended behavior
- Cryptographic misuse
- Integrity verification bypass
- Sensitive data appearing in logs

Report security concerns privately to the project maintainer whenever possible.

## Design Review

A polished contribution should be evaluated at:

- Desktop
- Tablet
- Mobile
- Light mode
- Keyboard navigation
- Reduced-motion mode
- Slow network conditions
- Empty states
- Loading states
- Error states
- Completed transfer states

Do not optimize only for the happy path.

## Documentation

Update documentation when changing:

- Environment variables
- Deployment steps
- Architecture
- Security behavior
- Transfer protocol
- Development commands
- Cloudflare configuration
- Browser requirements

Documentation must describe the actual implementation and should not make stronger security claims than the implementation supports.

## Pull Request Checklist

- [ ] The change has a focused scope.
- [ ] TypeScript type checking passes.
- [ ] The production build passes.
- [ ] No secrets are committed.
- [ ] Existing transfer behavior still works.
- [ ] Sender and receiver paths were considered.
- [ ] Error states were considered.
- [ ] Mobile behavior was checked.
- [ ] Accessibility was considered.
- [ ] Reduced-motion behavior was checked.
- [ ] Documentation was updated when necessary.
- [ ] The diff contains no unrelated changes.

## Principle

The goal is not simply to make DropSend work.

The goal is to make DropSend **private, reliable, understandable, maintainable, and excellent to use**.
