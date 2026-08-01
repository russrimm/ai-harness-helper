import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '..', '..', 'web', 'dist');
const target = resolve(here, '..', 'public');

if (!existsSync(source)) {
  console.error(
    `[copy-web-assets] Missing build output at ${source}.\n` +
      'Run `npm run build --workspace @ai-harness-helper/web` first.',
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`[copy-web-assets] Copied web bundle to ${target}`);
