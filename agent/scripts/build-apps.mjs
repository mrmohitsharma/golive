// Builds the Go Live agent apps: one file per platform, no Node.js needed on the laptop.
//   node scripts/build-apps.mjs                    -> build/GoLiveAgent-Windows.exe, -Mac-AppleSilicon, -Mac-Intel
//   node scripts/build-apps.mjs --targets win      -> only Windows
// GOLIVE_DEFAULT_SERVER sets the server the app talks to (default https://gogetslive.com).
// Mac binaries must then be signed (ad hoc is enough): codesign --sign - <file>. The GitHub
// workflow .github/workflows/agent-apps.yml does that on a Mac and zips them.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'build');
const server = process.env.GOLIVE_DEFAULT_SERVER || 'https://gogetslive.com';
const want = (process.argv.find((a, i) => process.argv[i - 1] === '--targets') ?? 'win,mac-arm,mac-intel').split(',');
const TARGETS = {
  win: ['node22-win-x64', 'GoLiveAgent-Windows.exe'],
  'mac-arm': ['node22-macos-arm64', 'GoLiveAgent-Mac-AppleSilicon'],
  'mac-intel': ['node22-macos-x64', 'GoLiveAgent-Mac-Intel'],
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: path.join(out, 'agent.cjs'),
  // ws works without these native speed-ups.
  external: ['bufferutil', 'utf-8-validate'],
  define: { 'process.env.GOLIVE_DEFAULT_SERVER': JSON.stringify(server) },
  logLevel: 'warning',
});
console.log(`bundled build/agent.cjs (server ${server})`);
for (const key of want) {
  const [target, name] = TARGETS[key] ?? [];
  if (!target) throw new Error(`unknown target ${key}`);
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['pkg', path.join(out, 'agent.cjs'), '--targets', target, '--output', path.join(out, name), '--no-bytecode', '--public', '--public-packages', '*', '--no-native-build'],
    { stdio: 'inherit', cwd: root },
  );
  console.log(`built build/${name}`);
}
