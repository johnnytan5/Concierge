// Copies what the browser robot needs into public/, so the web demo loads the
// SAME scene files the Python sim does (sim/*.xml) and the official MuJoCo
// WASM build. Runs before `dev` and `build` (package.json), including on
// Vercel. If ../sim is not there (unusual checkout), the committed copies in
// public/sim are used as they are.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const copy = (from, to) => {
  if (!existsSync(from)) return console.warn(`[sync-sim-assets] missing ${from}, keeping existing ${to}`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};
for (const f of ['scene_corridor.xml', 'delivery_bot_v2.xml']) {
  copy(join(root, '..', 'sim', f), join(root, 'public', 'sim', f));
}
for (const f of ['mujoco.js', 'mujoco.wasm']) {
  copy(join(root, 'node_modules', '@mujoco', 'mujoco', f), join(root, 'public', 'mujoco', f));
}
console.log('[sync-sim-assets] scene + MuJoCo WASM copied to public/');
