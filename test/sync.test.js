'use strict';
// Local-first integration test: REAL Hue bridge + MOCK free@home.
// Verifies discovery, registration, and BOTH sync directions.
const { HueClient } = require('../src/hue');
const { FreeAtHomeMock } = require('../src/freeathome_mock');
const { SyncEngine } = require('../src/sync');
const cfg = require('../src/config').load();

const log = {
  info: (...a) => console.log('  ', ...a),
  warn: (...a) => console.log('  WARN', ...a),
  error: (...a) => console.log('  ERR', ...a),
};

async function main() {
  const hue = new HueClient(cfg.hue);
  const fh = new FreeAtHomeMock();
  const engine = new SyncEngine({ hue, fh, config: { ...cfg, expose: 'dynamic', ttlSeconds: 120 }, log });

  console.log('1) start engine (real Hue discovery + mock f@h registration)...');
  await engine.start();
  const items = engine.items;
  console.log(`   registered ${Object.keys(fh.devices).length} virtual switches`);
  const sample = items.find((i) => i.name === 'Hallway Day Cycle') || items[0];
  console.log(`   sample: "${sample.name}" handle=${sample.serial} nativeSerial=${sample.nativeSerial}`);

  console.log(`2) f@h -> Hue ON: switch "${sample.name}" ON, expect scene active + group ON...`);
  fh.simulateSwitch(sample.nativeSerial, true);
  await new Promise((r) => setTimeout(r, 2500));
  let cur = (await hue.listSmartScenes()).find((s) => s.id === sample.hueId);
  let gl = (await hue.getGroupedLightStates())[sample.groupedLight];
  console.log(`   scene=${cur.state}, group light on=${gl}  ${cur.state === 'active' && gl ? 'PASS' : 'FAIL'}`);

  console.log('3) f@h -> Hue OFF: switch OFF, expect group light OFF (lights actually off)...');
  fh.simulateSwitch(sample.nativeSerial, false);
  await new Promise((r) => setTimeout(r, 2500));
  gl = (await hue.getGroupedLightStates())[sample.groupedLight];
  console.log(`   group light on=${gl}  ${gl === false ? 'PASS' : 'FAIL'}`);

  console.log('3b) Hue -> f@h state: group light OFF should have set mock odp0000 -> 0...');
  await new Promise((r) => setTimeout(r, 1500));
  const odp = fh.datapoints[`${sample.nativeSerial}.ch0000.odp0000`];
  console.log(`   mock odp0000 = ${odp}  ${odp === '0' ? 'PASS' : 'FAIL'}`);

  console.log('4) keepalive: manual refresh, expect re-registration count to rise...');
  const before = fh.registrations;
  await engine._refreshLeases();
  console.log(`   registrations ${before} -> ${fh.registrations}  ${fh.registrations > before ? 'PASS' : 'FAIL'}`);

  engine.stop();
  console.log('done.');
  process.exit(0);
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
