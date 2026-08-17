'use strict';
// Configuration for the add-on. On the SysAP these values come from the add-on
// `parameters` (rendered in the free@home UI). Locally they come from env vars
// and .hue-credentials.json. This module normalizes both.

const fs = require('fs');
const path = require('path');

function loadLocalCreds() {
  try {
    const p = path.join(__dirname, '..', '.hue-credentials.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) { return {}; }
}

/**
 * expose:
 *   'dynamic' - only smart_scenes (Day Cycles etc.)   [default]
 *   'static'  - only regular scenes
 *   'both'    - every scene and smart_scene
 */
function load() {
  const creds = loadLocalCreds();
  const env = process.env;
  return {
    hue: {
      ip: env.HUE_IP || creds.bridge_ip,
      appKey: env.HUE_APP_KEY || creds.application_key,
    },
    fh: {
      host: env.FH_HOST || 'SYSAP_IP',
      user: env.FH_USER || 'YOUR_LOCAL_API_USERNAME',
      password: env.FH_PASSWORD || 'YOUR_LOCAL_API_PASSWORD',
      tls: env.FH_TLS ? env.FH_TLS !== 'false' : true,
      // Inside the add-on container the local API is reachable on localhost:
      // set FH_HOST=127.0.0.1 and FH_TLS=false via manifest parameters if needed.
    },
    expose: (env.EXPOSE || 'dynamic').toLowerCase(), // dynamic | static | both | room
    ttlSeconds: Number(env.TTL_SECONDS || 300),
    serialPrefix: env.SERIAL_PREFIX || 'HUE',
    // Prefix prepended to every virtual switch display name in free@home.
    // Set to '' to disable. Default 'Hue: ' so they are easy to spot.
    namePrefix: env.NAME_PREFIX != null ? env.NAME_PREFIX : 'Hue: ',
    dryRun: env.DRY_RUN === 'true', // if true, don't register/write to f@h
  };
}

module.exports = { load };
