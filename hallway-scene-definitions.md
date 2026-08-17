# Hallway Scene Definitions (confirmed from bridge)

Bridge: `BRIDGE_IP` (Philips Hue BSB002, API 1.78.0)
Room: **Hallway** — id `48ea0d88-c4d7-453f-9355-e0a94b8d9096`
Captured: 2026-08-15

Sorted coolest → warmest.

| Scene | Mirek | ≈ Kelvin | Brightness | Character | Scene ID | Image ID (public_image) |
|---|---|---|---|---|---|---|
| Energize | 156 | ~6410 K | 100% | Cool blue-white daylight — most alert | db42635a-f217-49ca-9973-d3ce1c0ac8bf | 7fd2ccc5-5749-4142-b7a5-66405a676f03 |
| Concentrate | 233 | ~4290 K | 100% | Neutral cool white — focus | 44a32bc9-8f55-4b13-bdfe-565bf1d0ae87 | b90c8900-a6b7-422c-a5d3-e170187dbf8c |
| Read | 346 | ~2890 K | 100% | Warm-neutral white, full bright — reading | 5036cc01-6aa6-4775-b018-3fa2fef45c02 | e101a77f-9984-4f61-aac8-15741983c656 |
| Bright | 370 | ~2700 K | 100% | Warm white, full bright | 08167726-7f85-4db8-9938-59dea98767b2 | 732ff1d9-76a7-4630-aad0-c8acc499bb0b |
| Dimmed | 370 | ~2700 K | 30% | Warm white, medium-low | 2946a367-daae-477a-846c-fd0a42a107f7 | 8c74b9ba-6e89-4083-a2a7-b10a1e566fed |
| Relax | 447 | ~2240 K | 56% | Warm, half brightness — cozy | a3d229be-6a72-4002-bd46-b2a1e8e81db6 | a1f7da49-d181-4328-abea-68c9dc4b5416 |
| Rest | 500 | ~2000 K | 35% | Amber, low — winding down | 6e8b2151-41bd-4532-b081-9be671178844 | 11a09ad5-8d65-4e90-959b-f05981a9ab1b |
| Nightlight | 500 | ~2000 K | 10% | Amber, very dim — minimal glow | b2a1253c-e645-4597-b6f6-a09fc3b8e2dc | 28bbfeff-1a0c-444e-bb4b-0b74b88e0c95 |

Notes:
- Bright and Dimmed share color (2700K); differ only in brightness (100% vs 30%).
- Rest and Nightlight share color (2000K amber); differ in brightness (35% vs 10%).

## Dynamic scenes in Hallway
- **Hallway Day Cycle** (custom, id `5a5c35d1-760f-4014-8f2b-91024f1799f1`): 07:00 Concentrate → 12:00 Bright → sunset Read → 23:00 Dimmed
- **Natural light 2** (added via Hue app, id `19a4bb4b-930f-412f-965e-b08b3e7bf64b`): 07:00 Energize → 10:00 Concentrate → sunset Read → 20:00 Relax → 22:00 Rest → 00:00 Nightlight
