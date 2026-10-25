// wrapper: run the i18n drift lint against THIS tree's dictionaries (verify.mjs passes no args)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(process.execPath,
  [path.join(root, 'tools/claude11/verify/i18n-lint.mjs'), path.join(root, 'src/i18n')],
  { stdio: 'inherit' });
process.exit(result.status ?? 1);
