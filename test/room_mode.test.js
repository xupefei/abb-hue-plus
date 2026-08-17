'use strict';
// Test expose=room: one switch per room, onScene from scenes.json (default Day Cycle).
// Real Hue + mock f@h. Also writes scenes.json to a temp path.
const os = require('os');
const path = require('path');
process.env.SCENES_CONFIG = path.join(os.tmpdir(), 'scenes.test.json');
try { require('fs').unlinkSync(process.env.SCENES_CONFIG); } catch (_) {}

const { HueClient } = require('../src/hue');
const { FreeAtHomeMock } = require('../src/freeathome_mock');
const { SyncEngine } = require('../src/sync');
const cfg = require('../src/config').load();

const log = { info: (...a) => console.log('  ', ...a), warn: (...a) => console.log('  WARN', ...a), error: (...a) => console.log('  ERR', ...a) };

async function main() {
  const hue = new HueClient(cfg.hue);
  const fh = new FreeAtHomeMock();
  const engine = new SyncEngine({ hue, fh, config: { ...cfg, expose: 'room', ttlSeconds: 180 }, log });

  console.log('1) start in room mode...');
  await engine.start();
  console.log(`   ${engine.items.length} room switches created`);
  for (const it of engine.items.slice(0, 5)) console.log(`     ${it.name} -> onScene kind=${it.kind} hueId=${it.hueId.slice(0,8)}`);

  console.log('2) verify generated scenes.json...');
  const gen = JSON.parse(require('fs').readFileSync(process.env.SCENES_CONFIG, 'utf8'));
  const sample = 'Hallway';
  console.log(`   ${sample}:`, JSON.stringify(gen[sample]), gen[sample] && /day cycle/i.test(gen[sample].onScene) ? 'PASS (defaults to Day Cycle)' : 'CHECK');

  console.log('3) toggle Hallway room switch ON -> its Day Cycle activates + lights on...');
  const hallway = engine.items.find((i) => i.name === 'Hallway');
  fh.simulateSwitch(hallway.nativeSerial, true);
  await new Promise((r) => setTimeout(r, 2500));
  const gl = (await hue.getGroupedLightStates())[hallway.groupedLight];
  console.log(`   Hallway group light on=${gl}  ${gl ? 'PASS' : 'FAIL'}`);

  console.log('4) toggle OFF -> lights off...');
  fh.simulateSwitch(hallway.nativeSerial, false);
  await new Promise((r) => setTimeout(r, 2500));
  const gl2 = (await hue.getGroupedLightStates())[hallway.groupedLight];
  console.log(`   Hallway group light on=${gl2}  ${gl2 === false ? 'PASS' : 'FAIL'}`);

  engine.stop();
  console.log('done.');
  process.exit(0);
}
main().catch((e) => { console.error('TEST FAILED:', e); process.exit(1); });
