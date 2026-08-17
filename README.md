# abb-hue-plus

A **free@home add-on** that exposes Philips Hue scenes and dynamic scenes as virtual
switches/dimmers in ABB-free@home, plus the tooling used to organise a Hue bridge into
per-room "Day Cycle" dynamic scenes.

> Status: experimental / personal project. Built and validated against a real Hue Bridge
> (BSB002, API 1.78.0) and an ABB-free@home System Access Point (firmware 3.5.4).

## What's here

| Path | What it is |
|---|---|
| `addon-ts/` | **The shippable add-on** — TypeScript, uses `@busch-jaeger/free-at-home`. Registers one virtual switch/dimmer per Hue room, short-press activates a scene, hold dims. |
| `src/`, `test/` | Earlier hand-rolled Node client (Hue CLIP v2 + free@home local API over REST/WebSocket) used to reverse-engineer and validate the integration. Kept for reference. |
| `build_day_cycles.py` | Script that creates a 4-phase "Day Cycle" `smart_scene` (Concentrate → Bright → Relax → Rest) in every eligible room. |
| `hallway-scene-definitions.md` | Reference table of scene colour-temperature / brightness values. |

## The add-on (addon-ts)

Built on the official ABB Add-on Development Kit (`@busch-jaeger/free-at-home`), runs as a
Node.js `app` add-on on the System Access Point.

- **One virtual device per Hue room/zone** (configurable: `room` / `dynamic` / `static` / `both`)
- **Short press** → activate that room's scene (e.g. its Day Cycle)
- **Hold** → dim the room (forwarded to the Hue `grouped_light`)
- **Two-way state sync** via the Hue v2 event stream
- **Auto re-sync** on an interval + a force-sync button in the add-on settings
- Configurable name prefix (default `Hue: `)

### Build & deploy

```bash
cd addon-ts
npm install
npm run build          # tsc -> build/
npm run pack           # free-at-home-cli buildscriptarchive -> <id>-<version>.tar
```

Then upload the tar to the System Access Point (via the free@home app, or the add-on
container API under `/api/addon/v1`) and set the Hue bridge IP + application key in the
add-on's settings.

### Configuration (add-on parameters / env vars for local dev)

| Env var | Purpose |
|---|---|
| `HUE_IP` | Hue bridge IP address |
| `HUE_APP_KEY` | Hue application key (press the bridge link button, then `POST /api`) |
| `FH_HOST` / `FREEATHOME_BASE_URL` | SysAP address (local dev only; on-device uses the unix socket) |
| `FREEATHOME_API_USERNAME` / `FREEATHOME_API_PASSWORD` | SysAP local-API credentials (local dev) |
| `EXPOSE` | `room` \| `dynamic` \| `static` \| `both` |
| `NAME_PREFIX` | Display-name prefix (default `Hue: `) |

## Notes / known limitations

- Smooth **live group dimming** is bounded by the Hue/Zigbee group command rate — it works
  but isn't perfectly buttery.
- free@home's dimmer keeps its own brightness setpoint, so the first hold after switching a
  scene may ramp from a stale value.
- The free@home built-in Hue integration mirrors device **names** from the bridge; f@h-side
  renames for imported Hue *lights* get overwritten on sync (groups hold).

## Credentials

No secrets are committed. Provide your own `.hue-credentials.json` (git-ignored):

```json
{ "bridge_ip": "…", "application_key": "…", "client_key": "…" }
```

## License

MIT
