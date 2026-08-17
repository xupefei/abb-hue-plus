'use strict';
// Room-mode scene mapping. Loads (and auto-generates) scenes.json which maps each
// room/zone -> { include, onScene }. onScene is a scene/smart_scene NAME within that room.
//
// scenes.json shape:
// {
//   "Hallway":     { "include": true,  "onScene": "Hallway Day Cycle" },
//   "Living Room": { "include": true,  "onScene": "Bright" },
//   "Storage":     { "include": false }
// }

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.SCENES_CONFIG || path.join(__dirname, '..', 'scenes.json');

/**
 * Build the default mapping from discovered groups + their scenes.
 * @param {Array<{group:string, kind:string, name:string, sceneName:string}>} sceneCatalog
 *   flat list of scenes with their group (room/zone) name and bare scene name.
 * @returns {Object} room -> {include, onScene}
 */
function buildDefault(catalog) {
  const byRoom = {};
  for (const s of catalog) {
    if (!byRoom[s.group]) byRoom[s.group] = [];
    byRoom[s.group].push(s);
  }
  const out = {};
  for (const [room, scenes] of Object.entries(byRoom)) {
    if (!room) continue;
    // prefer a Day Cycle smart_scene, else 'Bright', else first scene
    const dayCycle = scenes.find((s) => s.kind === 'smart' && /day cycle/i.test(s.sceneName));
    const anySmart = scenes.find((s) => s.kind === 'smart');
    const bright = scenes.find((s) => /^bright$/i.test(s.sceneName));
    const chosen = dayCycle || anySmart || bright || scenes[0];
    out[room] = { include: scenes.length > 0, onScene: chosen ? chosen.sceneName : null };
  }
  return out;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    return null; // not present yet
  }
}

function save(mapping) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(mapping, null, 2) + '\n');
}

/** Load existing config, or generate+persist defaults from the catalog. Returns merged mapping. */
function loadOrInit(catalog, { persist = true, log = console } = {}) {
  const defaults = buildDefault(catalog);
  const existing = load();
  if (!existing) {
    if (persist) { try { save(defaults); log.info?.(`wrote default scenes config -> ${CONFIG_PATH}`); } catch (e) { log.warn?.(`could not write scenes.json: ${e.message}`); } }
    return defaults;
  }
  // merge: keep user's choices, add any new rooms with defaults
  const merged = { ...defaults, ...existing };
  return merged;
}

module.exports = { loadOrInit, buildDefault, load, save, CONFIG_PATH };
