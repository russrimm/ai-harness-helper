import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function runPnpm(args) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', shell: true });

  if (result.error) {
    console.error(`[bootstrap] Failed to run \`pnpm ${args.join(' ')}\`: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(resolve(root, 'node_modules'))) {
  const install = existsSync(resolve(root, 'pnpm-lock.yaml')) ? '--frozen-lockfile' : undefined;
  console.log(`[bootstrap] node_modules is missing, running \`pnpm install\`.`);
  runPnpm(install ? ['install', install] : ['install']);
}

// The CLI serves the web bundle from packages/cli/public, so both outputs must exist.
const buildOutputs = [
  resolve(root, 'packages', 'cli', 'dist', 'bin.js'),
  resolve(root, 'packages', 'cli', 'public', 'index.html'),
];

if (buildOutputs.some((output) => !existsSync(output))) {
  console.log('[bootstrap] Build output is missing, running `pnpm run build`.');
  runPnpm(['run', 'build']);
}
