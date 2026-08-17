'use strict';
// Core sync engine: bridges Hue scenes/smart_scenes <-> free@home virtual switches.
//
//  - Enumerate Hue scenes (+smart_scenes) filtered by config.expose.
//  - Register one virtual SwitchingActuator per scene (stable serial).
//  - f@h switch ON/OFF  -> Hue recall (activate/deactivate or scene recall).
//  - Hue event stream   -> update f@h switch state (two-way sync).
//  - Keepalive: periodically re-register to refresh the TTL lease.

const crypto = require('crypto');

// free@home SwitchingActuator: idp0000 (pairingID 1) = switch command in,
// odp0000 (pairingID 256) = switch state out.
const IDP_SWITCH = 'ch0000.idp0000';
const ODP_SWITCH = 'ch0000.odp0000';

// Registration response shape: {"<sysap>":{"devices":{"<nativeSerial>":{"serial":"<ourHandle>"}}}}
function extractNativeSerial(resp) {
  if (!resp || typeof resp !== 'object') return null;
  for (const sysap of Object.values(resp)) {
    const devs = sysap && sysap.devices;
    if (devs && typeof devs === 'object') {
      const keys = Object.keys(devs);
      if (keys.length) return keys[0];
    }
  }
  return null;
}

function stableSerial(prefix, hueId) {
  // 12-char hex serial derived from the Hue resource id (stable across restarts).
  const h = crypto.createHash('sha1').update(hueId).digest('hex').slice(0, 9).toUpperCase();
  return `${prefix}${h}`.slice(0, 12);
}

class SyncEngine {
  constructor({ hue, fh, config, log = console }) {
    this.hue = hue;
    this.fh = fh;
    this.config = config;
    this.log = log;
    this.items = [];          // [{hueId, kind:'scene'|'smart', name, group, serial}]
    this.bySerial = new Map(); // native serial -> item
    this.byHueId = new Map();  // hueId (scene/smart) -> item
    this.byGroupedLight = new Map(); // grouped_light id -> [items] (state source of truth)
    this._stopHue = null;
    this._stopFh = null;
    this._keepalive = null;
  }

  async _discover() {
    const [scenes, smarts, rooms, zones] = await Promise.all([
      this.hue.listScenes(), this.hue.listSmartScenes(), this.hue.listRooms(), this.hue.listZones(),
    ]);
    const gname = {};
    const gLight = {}; // group id -> grouped_light id (to switch the whole group off)
    for (const g of [...rooms, ...zones]) {
      gname[g.id] = g.metadata.name;
      const gl = (g.services || []).find((s) => s.rtype === 'grouped_light');
      if (gl) gLight[g.id] = gl.rid;
    }

    // flat catalog of every scene with its group name + bare scene name
    const catalog = [];
    for (const s of smarts) catalog.push({ hueId: s.id, kind: 'smart', group: gname[s.group.rid] || '',
      groupRid: s.group.rid, sceneName: s.metadata.name, state: s.state === 'active' });
    for (const s of scenes) catalog.push({ hueId: s.id, kind: 'scene', group: gname[s.group.rid] || '',
      groupRid: s.group.rid, sceneName: s.metadata.name,
      state: (s.status && s.status.active && s.status.active !== 'inactive') || false });

    const items = [];

    if (this.config.expose === 'room') {
      // ONE switch per room/zone; onScene chosen via scenes.json (default: Day Cycle).
      const sc = require('./scenes_config');
      const mapping = sc.loadOrInit(catalog, { persist: !this.config.dryRun, log: this.log });
      for (const [room, cfg] of Object.entries(mapping)) {
        if (!cfg || cfg.include === false) continue;
        const chosen = catalog.find((c) => c.group === room && c.sceneName === cfg.onScene)
          || catalog.find((c) => c.group === room);
        if (!chosen) continue;
        items.push({
          hueId: chosen.hueId, kind: chosen.kind, name: room, group: room,
          groupedLight: gLight[chosen.groupRid] || null, state: false,
          roomMode: true,
        });
      }
    } else {
      const wantStatic = this.config.expose === 'static' || this.config.expose === 'both';
      const wantDyn = this.config.expose === 'dynamic' || this.config.expose === 'both';
      for (const c of catalog) {
        if (c.kind === 'smart' && !wantDyn) continue;
        if (c.kind === 'scene' && !wantStatic) continue;
        const name = c.kind === 'smart' ? c.sceneName : `${c.group} ${c.sceneName}`.trim();
        items.push({ hueId: c.hueId, kind: c.kind, name, group: c.group,
          groupedLight: gLight[c.groupRid] || null, state: c.state });
      }
    }
    for (const it of items) it.serial = stableSerial(this.config.serialPrefix, it.hueId + '|' + it.name);
    return items;
  }

  async start() {
    this.items = await this._discover();
    this.log.info?.(`discovered ${this.items.length} scene(s) to expose (mode=${this.config.expose})`);

    for (const it of this.items) {
      this.byHueId.set(it.hueId, it);
      if (it.groupedLight) {
        if (!this.byGroupedLight.has(it.groupedLight)) this.byGroupedLight.set(it.groupedLight, []);
        this.byGroupedLight.get(it.groupedLight).push(it);
      }
    }

    // Initial state = whether each room's grouped_light is currently ON (the source of truth).
    try {
      const glStates = await this.hue.getGroupedLightStates();
      for (const it of this.items) {
        if (it.groupedLight && glStates[it.groupedLight] != null) it.state = glStates[it.groupedLight];
      }
    } catch (e) { this.log.warn?.(`could not read grouped_light states: ${e.message}`); }

    // Register virtual switches + push initial state.
    // The SysAP assigns its OWN native serial; datapoint ops must use it, not our handle.
    if (!this.config.dryRun) {
      for (const it of this.items) {
        const resp = await this.fh.registerSwitch(it.serial, this._displayName(it), this.config.ttlSeconds);
        it.nativeSerial = extractNativeSerial(resp) || it.serial;
        this.bySerial.set(it.nativeSerial, it);
      }
      // give the SysAP a moment to materialize the new devices before writing state
      await new Promise((r) => setTimeout(r, 1500));
      for (const it of this.items) {
        try {
          await this.fh.setDatapoint(`${it.nativeSerial}.${ODP_SWITCH}`, it.state ? '1' : '0');
        } catch (e) {
          this.log.warn?.(`initial state write failed for ${it.name} (${it.nativeSerial}): ${e.message}`);
        }
      }
    } else {
      for (const it of this.items) { it.nativeSerial = it.serial; this.bySerial.set(it.serial, it); }
    }

    // f@h -> Hue
    this._stopFh = this.fh.connectWebSocket();
    this.fh.on('datapoint', ({ address, value }) => this._onFhDatapoint(address, value));

    // Hue -> f@h
    this._stopHue = this.hue.subscribeEvents();
    this.hue.on('update', (ev) => this._onHueUpdate(ev));

    // keepalive to refresh TTL lease (well under ttl)
    if (!this.config.dryRun) {
      const interval = Math.max(30, Math.floor(this.config.ttlSeconds / 2)) * 1000;
      this._keepalive = setInterval(() => this._refreshLeases().catch((e) => this.log.warn?.('keepalive', e.message)), interval);
    }
    this.log.info?.('sync engine started');
  }

  _displayName(it) {
    // Prefix (default "Hue: ") makes the virtual switches easy to spot in free@home.
    const prefix = this.config.namePrefix != null ? this.config.namePrefix : '';
    return `${prefix}${it.name}`;
  }

  async _refreshLeases() {
    for (const it of this.items) {
      await this.fh.registerSwitch(it.serial, this._displayName(it), this.config.ttlSeconds);
    }
  }

  // free@home wrote a datapoint. If it's one of our switch inputs, act on Hue.
  async _onFhDatapoint(address, value) {
    // address may use '.' or '/' as separator
    const norm = address.replace(/\//g, '.');
    const m = norm.match(/^([^.]+)\.ch0000\.idp0000$/);
    if (!m) return;
    const serial = m[1];
    const it = this.bySerial.get(serial);
    if (!it) return;
    const on = value === '1' || value === 1 || value === true;
    this.log.info?.(`[f@h->hue] ${it.name} switch ${on ? 'ON' : 'OFF'}`);
    try {
      if (it.kind === 'smart') {
        await this.hue.setSmartScene(it.hueId, on);
        // Deactivating a smart_scene only stops cycling; the lights stay on.
        // To make OFF mean "lights off", also switch the group off.
        if (!on && it.groupedLight) await this.hue.setGroupedLight(it.groupedLight, false);
      } else if (on) {
        await this.hue.recallScene(it.hueId); // static scenes: recall on ON
      } else if (it.groupedLight) {
        await this.hue.setGroupedLight(it.groupedLight, false); // static scene OFF -> lights off
      }
      // echo state to output datapoint
      if (!this.config.dryRun) await this.fh.setDatapoint(`${it.nativeSerial}.${ODP_SWITCH}`, on ? '1' : '0');
    } catch (e) {
      this.log.error?.(`[f@h->hue] failed for ${it.name}: ${e.message}`);
    }
  }

  // Hue reported a change. State source of truth = the room's grouped_light on/off,
  // so a switch shows ON whenever its room's lights are on (consistent with OFF=group off).
  async _onHueUpdate(ev) {
    if (ev.type !== 'update' || !Array.isArray(ev.data)) return;
    for (const d of ev.data) {
      if (d.type !== 'grouped_light' || !d.on || d.on.on == null) continue;
      const items = this.byGroupedLight.get(d.id);
      if (!items) continue;
      const active = !!d.on.on;
      for (const it of items) {
        if (it.state === active) continue;
        it.state = active;
        this.log.info?.(`[hue->f@h] ${it.name} -> ${active ? 'ON' : 'OFF'} (room light)`);
        if (!this.config.dryRun) {
          this.fh.setDatapoint(`${it.nativeSerial}.${ODP_SWITCH}`, active ? '1' : '0')
            .catch((e) => this.log.warn?.(`echo state failed: ${e.message}`));
        }
      }
    }
  }

  stop() {
    if (this._stopHue) this._stopHue();
    if (this._stopFh) this._stopFh();
    if (this._keepalive) clearInterval(this._keepalive);
  }
}

module.exports = { SyncEngine, stableSerial };
