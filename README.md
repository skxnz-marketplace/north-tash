# North Tash

Mobile-first Aflatoon game prototype built with Next.js, TypeScript, and Tailwind CSS.

## Getting Started

Run the local development server:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Checks

```bash
pnpm test
pnpm lint
pnpm typecheck
```

## Current Scope

- Landing, private 3-digit local room, buy-in, lobby, one test bot, and host controls.
- Mobile oval table with SVG playing cards, staggered dealing, poker chips, pot, centre history, mode, jokers, and live 15-second timer.
- Automatic chaal/centre flip, back show, private accept/decline prompt, decline costs, forced acceptance, hand reset, and rotating dealer.
- Rebuys, host approvals, player transfers, public shorts, session end, and downloadable CSV tally.
- Tested Aflatoon rules engine for normal rankings, Mufflis, sequential jokers, and special show ties.

## Local MVP Boundary

Room state currently uses browser storage, so it is suitable for local UI and rules testing only. Real phones, secure hidden cards, reconnection, and server-owned timers/decks require the planned realtime backend.
