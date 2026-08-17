'use strict';
// Add-on entry point (manifest entryPoint). Wires real Hue + real free@home clients
// into the sync engine. Config comes from env/parameters (see config.js).

const { HueClient } = require('./hue');
const { FreeAtHomeClient } = require('./freeathome');
const { SyncEngine } = require('./sync');
const config = require('./config').load();

const log = {
  info: (...a) => console.log(new Date().toISOString(), 'INFO', ...a),
  warn: (...a) => console.warn(new Date().toISOString(), 'WARN', ...a),
  error: (...a) => console.error(new Date().toISOString(), 'ERROR', ...a),
};

async function main() {
  if (!config.hue.ip || !config.hue.appKey) {
    log.error('Missing Hue config (HUE_IP / HUE_APP_KEY). Exiting.');
    process.exit(1);
  }
  log.info(`abb-hue-plus starting: expose=${config.expose} ttl=${config.ttlSeconds}s hue=${config.hue.ip} fh=${config.fh.host}`);

  const hue = new HueClient(config.hue);
  const fh = new FreeAtHomeClient(config.fh);

  // sanity checks
  const bridge = await hue.getConfig();
  log.info(`connected to Hue bridge "${bridge.name}" (api ${bridge.apiversion})`);
  const fhcfg = await fh.getConfiguration();
  const sysapName = Object.values(fhcfg)[0]?.sysapName || '(sysap)';
  log.info(`connected to free@home "${sysapName}"`);

  const engine = new SyncEngine({ hue, fh, config, log });
  await engine.start();

  const shutdown = () => { log.info('shutting down...'); engine.stop(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => { log.error('fatal:', e.stack || e.message); process.exit(1); });
