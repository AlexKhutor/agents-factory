# Accepted backend delivery

Files that come from the backend, byte for byte. They are a trusted part of
the application - not settings, not renderer data - and are not edited here:
a new backend delivery replaces them together with the pins in
`src/host/kit.mjs`.

| File | What it is | SHA-256 |
| --- | --- | --- |
| `contracts/accepted-delivery-claude-port-20261003.v1.json` | lock of the active delivery (Frontend Kit v0.21.0) | `8db06673b053049d13725697ef4c34111e661f5336bd72af7d61708aff69da35` |
| `contracts/accepted-delivery-claude-port-20261002.v1.json` | lock of the retained delivery (Frontend Kit v0.20.0) | `321c91c31ae090004f168b7a090380da350cfd6865a632b7f2f711daacd1a494` |
| `scripts/verify-accepted-delivery.mjs` | the backend's delivery verifier | `adc66a1e276e74024bb075e3c893977699b8af1901ecb1375da4ea3673371c70` |

Active: release `claude-port-backend-20261003` (the agent chat: steer and
queue, the model picker, the trace), Application Frontend Kit v0.21.0 in
`vendor/frontend-kit/v0.21.0`, manifest SHA-256
`7af45f5786001616cd4e1eddb3f107d8da9ee2fc81684bfae55948c0582c817a`, contracts
application v0.1.0, gateway descriptor v0.2.0, capabilities v0.2.0.

Retained for rollback: release `claude-port-backend-20261002`, Application
Frontend Kit v0.20.0 in `vendor/frontend-kit/v0.20.0`, manifest SHA-256
`c4c852201e9a3fc1a171145c1e0fd930ce3c5ce663778a81ee28b6e8bed2f0e1`. The v0.21.0
backend still serves it. The delivery tests verify it; the application never
loads it.

How it is checked: `npm run verify:kit` (and every start of Atlas) reads the
lock pinned in `src/host/kit.mjs`, checks the verifier's hash, then checks
every kit file against the manifest the lock names. Any other bytes and Atlas
refuses to start, with the reason in the readiness panel.
