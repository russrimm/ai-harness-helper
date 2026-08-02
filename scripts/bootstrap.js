import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;

function runNpm(args) {
  const result = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: root, stdio: 'inherit' })
    : spawnSync('npm', args, { cwd: root, stdio: 'inherit', shell: true });

  if (result.error) {
    console.error(`[bootstrap] Failed to run \`npm ${args.join(' ')}\`: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!existsSync(resolve(root, 'node_modules'))) {
  const install = existsSync(resolve(root, 'package-lock.json')) ? 'ci' : 'install';
  console.log(`[bootstrap] node_modules is missing, running \`npm ${install}\`.`);
  runNpm([install]);
}

// The CLI serves the web bundle from packages/cli/public, so both outputs must exist.
const buildOutputs = [
  resolve(root, 'packages', 'cli', 'dist', 'bin.js'),
  resolve(root, 'packages', 'cli', 'public', 'index.html'),
];

if (buildOutputs.some((output) => !existsSync(output))) {
  console.log('[bootstrap] Build output is missing, running `npm run build`.');
  runNpm(['run', 'build']);
}
