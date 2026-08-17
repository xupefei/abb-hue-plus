// abb-hue-plus free@home add-on entry point.
// Exposes Philips Hue scenes / dynamic scenes as free@home virtual switches.
//
// Semantics (validated): each switch is anchored on a Hue Room/Zone.
//   ON  -> activate the chosen scene (smart_scene) or recall (static scene)
//   OFF -> turn the room's grouped_light off (lights actually off)
//   state (tile) -> reflects the room's grouped_light on/off (from any source)
//
// Features: auto re-sync on an interval + a "Force sync" button in the add-on
// settings, plus runtime stats pushed via setApplicationState().

import { FreeAtHome, AddOn } from '@busch-jaeger/free-at-home';
import { HueClient } from './hue';
import * as crypto from 'crypto';

type ExposeMode = 'room' | 'dynamic' | 'static' | 'both';

interface Item {
  hueId: string;
  kind: 'smart' | 'scene';
  name: string;              // logical name (room name, or scene name)
  group: string;
  groupedLight: string | null;
  nativeId: string;
  state: boolean;
  channel?: any;             // free@home SwitchingActuatorChannel (once registered)
  registered: boolean;
  onGuardUntil?: number;  // ignore dim events until this time (f@h sends cached brightness right after ON)
  dimInFlight?: boolean;  // a brightness PUT is currently in flight
  dimPending?: number;    // newest brightness awaiting send (coalesced; stale values dropped)
  dimLastSent?: number;   // last brightness actually PUT (skip redundant repeats at the extremes)
}

interface Config {
  hueIp: string; hueAppKey: string;
  expose: ExposeMode; namePrefix: string; syncIntervalMinutes: number;
}

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// DEVICE_SALT is bumped when the virtual device TYPE changes (e.g. Switch -> Dim).
// A running SysAP reuses an existing native id AS-IS (can't change device type in
// place), so a new salt forces fresh registration as the new type. Old devices then
// orphan (dismiss once in the app).
const DEVICE_SALT = 'dim1';
function makeNativeId(key: string): string {
  const h = crypto.createHash('sha1').update(`${DEVICE_SALT}|${key}`).digest('hex').slice(0, 12);
  return `hue${h}`.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
}

// ---- Hue discovery -> desired item list ----
async function discover(hue: HueClient, cfg: Config): Promise<Item[]> {
  const [scenes, smarts, rooms, zones] = await Promise.all([
    hue.listScenes(), hue.listSmartScenes(), hue.listRooms(), hue.listZones(),
  ]);
  const gname: Record<string, string> = {};
  const gLight: Record<string, string> = {};
  for (const g of [...rooms, ...zones]) {
    gname[g.id] = g.metadata.name;
    const gl = (g.services || []).find((s: any) => s.rtype === 'grouped_light');
    if (gl) gLight[g.id] = gl.rid;
  }
  const catalog = [
    ...smarts.map((s: any) => ({ hueId: s.id, kind: 'smart' as const, group: gname[s.group.rid] || '', groupRid: s.group.rid, sceneName: s.metadata.name })),
    ...scenes.map((s: any) => ({ hueId: s.id, kind: 'scene' as const, group: gname[s.group.rid] || '', groupRid: s.group.rid, sceneName: s.metadata.name })),
  ];

  const items: Item[] = [];
  // stableKey determines the nativeId (device identity). It must NOT change when the
  // switch's *target* scene changes, or free@home would get a duplicate device.
  //   room mode  -> key on the room/zone (stable even if its chosen scene changes)
  //   scene modes-> key on the scene's hueId (one switch per scene)
  const mk = (stableKey: string, hueId: string, kind: 'smart' | 'scene', name: string, group: string, groupRid: string): Item => ({
    hueId, kind, name, group, groupedLight: gLight[groupRid] || null,
    nativeId: makeNativeId(stableKey), state: false, registered: false,
  });

  if (cfg.expose === 'room') {
    const byRoom: Record<string, typeof catalog> = {};
    for (const c of catalog) { if (!c.group) continue; (byRoom[c.group] ||= []).push(c); }
    for (const [room, list] of Object.entries(byRoom)) {
      const chosen = list.find((c) => c.kind === 'smart' && /day cycle/i.test(c.sceneName))
        || list.find((c) => c.kind === 'smart')
        || list.find((c) => /^bright$/i.test(c.sceneName))
        || list[0];
      if (chosen) items.push(mk(`room|${chosen.groupRid}`, chosen.hueId, chosen.kind, room, room, chosen.groupRid));
    }
  } else {
    const wantStatic = cfg.expose === 'static' || cfg.expose === 'both';
    const wantDyn = cfg.expose === 'dynamic' || cfg.expose === 'both';
    for (const c of catalog) {
      if (c.kind === 'smart' && !wantDyn) continue;
      if (c.kind === 'scene' && !wantStatic) continue;
      const name = c.kind === 'smart' ? c.sceneName : `${c.group} ${c.sceneName}`.trim();
      items.push(mk(`scene|${c.hueId}`, c.hueId, c.kind, name, c.group, c.groupRid));
    }
  }
  return items;
}

class SyncManager {
  private byNative = new Map<string, Item>();
  private byGroupedLight = new Map<string, Item[]>();
  private timer?: NodeJS.Timeout;
  // errors = errors during the LAST sync (reset each run); errorsTotal = lifetime.
  stats = { switches: 0, added: 0, removed: 0, errors: 0, errorsTotal: 0, lastSync: '', bridge: '' };

  constructor(private hue: HueClient, private fah: FreeAtHome, private cfg: Config,
              private addon?: any) {}

  private displayName(it: Item) { return `${this.cfg.namePrefix}${it.name}`; }

  private recordError() { this.stats.errors++; this.stats.errorsTotal++; }

  // f@h -> Hue
  private async onFhSwitch(it: Item, on: boolean) {
    log(`[f@h->hue] ${it.name} ${on ? 'ON' : 'OFF'}`);
    // f@h sends the dimmer's cached brightness right after an ON. Guard so that
    // stray dim event doesn't override the scene's brightness. A real hold-dim
    // comes later and passes the guard window.
    if (on) { it.onGuardUntil = Date.now() + 1500; it.dimLastSent = undefined; } // scene changes brightness; forget last-sent
    try {
      if (it.kind === 'smart') {
        await this.hue.setSmartScene(it.hueId, on);
        if (!on && it.groupedLight) await this.hue.setGroupedLight(it.groupedLight, false);
      } else if (on) {
        await this.hue.recallScene(it.hueId);
      } else if (it.groupedLight) {
        await this.hue.setGroupedLight(it.groupedLight, false);
      }
      // On ON: proactively sync the room's actual brightness back to the f@h dimmer so
      // its slider isn't stale (otherwise a hold-up ramps from the old cached value and
      // the light dips before rising). Read the group and push it via setValue.
      if (on && it.groupedLight) {
        setTimeout(async () => {
          try {
            const full = await this.hue.getGroupedLightFull();
            const b = full[it.groupedLight!]?.brightness;
            if (b != null) { it.channel?.setValue(b); log(`[hue->f@h] ${it.name} brightness synced -> ${Math.round(b)}%`); }
          } catch { /* ignore */ }
        }, 400);
      }
    } catch (e) { this.recordError(); log(`[f@h->hue] error for ${it.name}:`, (e as Error).message); }
  }

  // f@h hold-to-dim. free@home streams brightness VALUES ~every 500ms while held. We
  // forward the LATEST as an absolute brightness, single-in-flight (never queue more
  // than one PUT to the rate-limited Zigbee group), dropping stale intermediate values.
  // This is the most responsive option that doesn't pile up in the bridge.
  private static DIM_TRANSITION = 400; // ms fade per step (~matches the ~500ms cadence)
  private onFhDim(it: Item, value: number) {
    if (!it.groupedLight) return;
    if (it.onGuardUntil && Date.now() < it.onGuardUntil) return;
    it.dimPending = value;
    if (it.dimInFlight) return;
    this.dimSendLoop(it);
  }

  private async dimSendLoop(it: Item) {
    if (it.dimPending == null || !it.groupedLight) return;
    it.dimInFlight = true;
    while (it.dimPending != null) {
      const target = it.dimPending; it.dimPending = undefined;
      // Skip redundant repeats (f@h keeps firing 1%/100% while you hold at an extreme).
      if (target === it.dimLastSent) continue;
      it.dimLastSent = target;
      log(`[f@h->hue] ${it.name} dim -> ${target}%`);
      try { await this.hue.setGroupedLightBrightness(it.groupedLight, target, SyncManager.DIM_TRANSITION); }
      catch (e) { this.recordError(); log(`[f@h->hue] dim error for ${it.name}:`, (e as Error).message); }
    }
    it.dimInFlight = false;
  }

  // Hue grouped_light event -> reflect on/off + brightness on the f@h dimmer
  private onHueUpdate = (ev: any) => {
    if (ev.type !== 'update' || !Array.isArray(ev.data)) return;
    for (const d of ev.data) {
      if (d.type !== 'grouped_light') continue;
      const list = this.byGroupedLight.get(d.id);
      if (!list) continue;
      for (const it of list) {
        if (d.on && d.on.on != null) {
          const active = !!d.on.on;
          if (it.state !== active) {
            it.state = active;
            log(`[hue->f@h] ${it.name} -> ${active ? 'ON' : 'OFF'}`);
            try { it.channel?.setOnOff(active); } catch (e) { log('setOnOff err', (e as Error).message); }
          }
        }
        if (d.dimming && d.dimming.brightness != null) {
          try { it.channel?.setValue(d.dimming.brightness); } catch { /* ignore */ }
        }
      }
    }
  };

  async start() {
    const bridge = await this.hue.getConfig();
    this.stats.bridge = `${bridge.name} (api ${bridge.apiversion})`;
    log(`connected to Hue bridge "${bridge.name}" (api ${bridge.apiversion})`);
    this.hue.on('update', this.onHueUpdate);
    this.hue.subscribeEvents();
    await this.sync();
    this.scheduleTimer();
  }

  scheduleTimer() {
    if (this.timer) clearInterval(this.timer);
    const mins = this.cfg.syncIntervalMinutes;
    if (mins && mins > 0) {
      this.timer = setInterval(() => this.sync().catch((e) => log('auto-sync error', e.message)), mins * 60_000);
      log(`auto-sync every ${mins} min`);
    }
  }

  /** Reconcile: discover desired items, add new switches, drop removed, refresh state. */
  async sync() {
    let added = 0, removed = 0;
    this.stats.errors = 0; // per-sync counter; errorsTotal keeps the lifetime tally
    const desired = await discover(this.hue, this.cfg);
    const desiredByNative = new Map(desired.map((it) => [it.nativeId, it]));
    const glStates = await this.hue.getGroupedLightStates().catch(() => ({} as Record<string, boolean>));

    // add / update
    for (const it of desired) {
      if (it.groupedLight && glStates[it.groupedLight] != null) it.state = glStates[it.groupedLight];
      const existing = this.byNative.get(it.nativeId);
      if (existing) {
        // keep existing channel; update mutable fields (incl. kind + hueId, so a
        // room's switch correctly re-points if its chosen scene changes type)
        existing.name = it.name; existing.group = it.group;
        existing.groupedLight = it.groupedLight; existing.hueId = it.hueId;
        existing.kind = it.kind;
        existing.state = it.state;
        try { existing.channel?.setOnOff(existing.state); } catch { /* ignore */ }
      } else {
        this.byNative.set(it.nativeId, it);
        added++;
        try {
          // DimActuator: short press -> isOnChanged (Day Cycle / off);
          // hold up/down -> absoluteValueChanged (set room brightness live).
          const ch = await this.fah.createDimActuatorDevice(it.nativeId, this.displayName(it));
          ch.setAutoKeepAlive(true);
          (ch as any).setAutoConfirm ? (ch as any).setAutoConfirm(true) : ((ch as any).isAutoConfirm = true);
          ch.setOnOff(it.state);
          it.channel = ch;
          it.registered = true;
          ch.on('isOnChanged', (on: boolean) => { this.onFhSwitch(it, on).catch((e) => log('onFhSwitch err', e.message)); });
          ch.on('absoluteValueChanged', (v: number) => { this.onFhDim(it, v); });
          log(`  + registered "${this.displayName(it)}" (${it.kind}) native=${it.nativeId}`);
        } catch (e) { this.recordError(); log(`  ! register failed ${it.name}:`, (e as Error).message); }
      }
    }
    // remove items no longer desired (stop keepalive -> lease lapses -> app prompts removal)
    for (const [native, it] of [...this.byNative]) {
      if (!desiredByNative.has(native)) {
        try { (it.channel as any)?.setAutoKeepAlive(false); } catch { /* ignore */ }
        this.byNative.delete(native);
        removed++;
        log(`  - dropped "${it.name}" (no longer in Hue); its f@h device will expire`);
      }
    }

    // rebuild grouped_light index
    this.byGroupedLight.clear();
    for (const it of this.byNative.values()) {
      if (!it.groupedLight) continue;
      if (!this.byGroupedLight.has(it.groupedLight)) this.byGroupedLight.set(it.groupedLight, []);
      this.byGroupedLight.get(it.groupedLight)!.push(it);
    }

    this.stats.switches = this.byNative.size;
    this.stats.added += added; this.stats.removed += removed;
    this.stats.lastSync = new Date().toISOString();
    log(`sync done: ${this.stats.switches} switch(es) (+${added} -${removed}), errors=${this.stats.errors} (lifetime ${this.stats.errorsTotal})`);
    this.publishStats();
  }

  publishStats() {
    if (!this.addon) return;
    try {
      this.addon.setApplicationState({
        status: { items: {
          bridge: this.stats.bridge,
          switches: String(this.stats.switches),
          lastSync: this.stats.lastSync,
          added: String(this.stats.added),
          removed: String(this.stats.removed),
          errors: String(this.stats.errors),
          errorsTotal: String(this.stats.errorsTotal),
        } },
      });
    } catch (e) { log('publishStats err', (e as Error).message); }
  }

  applyConfig(next: Config) {
    const intervalChanged = next.syncIntervalMinutes !== this.cfg.syncIntervalMinutes;
    this.cfg = next;
    if (intervalChanged) this.scheduleTimer();
  }
}

// ---- config wiring ----
function baseConfigFromEnv(): Config {
  const env = process.env;
  return {
    hueIp: env.HUE_IP || '',
    hueAppKey: env.HUE_APP_KEY || '',
    expose: (env.EXPOSE as ExposeMode) || 'room',
    namePrefix: env.NAME_PREFIX != null ? env.NAME_PREFIX : 'Hue: ',
    syncIntervalMinutes: Number(env.SYNC_INTERVAL_MINUTES || 15),
  };
}

function mergeConfig(cur: Config, configuration: any): Config {
  const conn = configuration?.connection?.items || {};
  const opts = configuration?.options?.items || {};
  return {
    hueIp: conn.hueIp || cur.hueIp,
    hueAppKey: conn.hueAppKey || cur.hueAppKey,
    expose: (opts.expose ? String(opts.expose).toLowerCase() : cur.expose) as ExposeMode,
    namePrefix: opts.namePrefix != null ? String(opts.namePrefix) : cur.namePrefix,
    syncIntervalMinutes: opts.syncIntervalMinutes != null ? Number(opts.syncIntervalMinutes) : cur.syncIntervalMinutes,
  };
}

async function main() {
  let cfg = baseConfigFromEnv();
  let manager: SyncManager | undefined;
  let addon: any;

  try {
    const md = AddOn.readMetaData();
    addon = new AddOn.AddOn(md.id);
    addon.on('configurationChanged', (configuration: any) => {
      cfg = mergeConfig(cfg, configuration);
      log('configuration updated:', { expose: cfg.expose, hueIp: cfg.hueIp, interval: cfg.syncIntervalMinutes });
      manager?.applyConfig(cfg);
    });
    addon.on('event', (ev: any) => {
      if (ev?.eventType === 'buttonPressed' && ev?.parameter === 'sync') {
        log('force-sync button pressed');
        manager?.sync().catch((e) => log('force-sync error', e.message));
      }
    });
    addon.connectToConfiguration();
    addon.connectToApplicationState();
    addon.connectToEvents();
  } catch (e) {
    log('AddOn API not available (dev mode?):', (e as Error).message);
  }

  // allow configurationChanged to populate
  await new Promise((r) => setTimeout(r, 1500));
  if (!cfg.hueIp || !cfg.hueAppKey) {
    log('ERROR: Hue bridge IP and application key are required (set them in add-on settings).');
    process.exit(1);
  }
  log(`starting: expose=${cfg.expose} hue=${cfg.hueIp} interval=${cfg.syncIntervalMinutes}min`);

  const hue = new HueClient({ ip: cfg.hueIp, appKey: cfg.hueAppKey });
  const fah = new FreeAtHome();
  fah.activateSignalHandling();

  manager = new SyncManager(hue, fah, cfg, addon);
  await manager.start();
  log('add-on running.');
}

// Long-run guards: log unexpected errors instead of crashing. systemd would
// restart us anyway, but staying up avoids brief outages from transient errors.
process.on('unhandledRejection', (reason: any) => {
  log('unhandledRejection (continuing):', reason?.stack || reason?.message || reason);
});
process.on('uncaughtException', (err: Error) => {
  log('uncaughtException (continuing):', err?.stack || err?.message || err);
});

main().catch((e) => { log('fatal:', e.stack || e.message); process.exit(1); });
