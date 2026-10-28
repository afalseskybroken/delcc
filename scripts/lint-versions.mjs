// delcc version-consistency gate (pass #75): the three machine fields must carry the
// same strict-semver version, and README's "What works (v…)" line must carry the same
// version in the human release-name spelling. Exists because README drifted for
// twenty-one bumps (0.2.2a → 0.2.22a) while the manifests moved — checks don't drift.
// v[BREAKING].[NON_BREAKING].[TWEAK][MATURITY] + channel tag → machine `X.Y.Z-tag`;
// name carries the scheme verbatim: `v0.2.23a-alpha` (README §Versioning).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = (msg) => { console.error(`lint-versions: ${msg}`); process.exit(1); };

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const conf = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const cargo = fs.readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');

const machine = pkg.version;
const m = /^(\d+)\.(\d+)\.(\d+)-([a-z]+)$/.exec(machine);
if (!m) fail(`package.json version "${machine}" is not strict semver with a channel tag (X.Y.Z-tag)`);
const [, breaking, wave, tweak, maturity] = m;

const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
if (cargoVersion !== machine) fail(`Cargo.toml version ${JSON.stringify(cargoVersion)} != package.json ${JSON.stringify(machine)}`);
if (conf.version !== machine) fail(`tauri.conf.json version ${JSON.stringify(conf.version)} != package.json ${JSON.stringify(machine)}`);

// human release-name spelling: v0.2.23a-alpha (maturity letter, tag verbatim)
const name = `v${breaking}.${wave}.${tweak}${maturity[0]}-${maturity}`;
const readmeEn = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const readmeVi = fs.readFileSync(path.join(root, 'README.vi.md'), 'utf8');
const headingEn = /^## What works \(v([^)]+)\)/m.exec(readmeEn)?.[1];
const headingVi = /^## [^\n]*\(v([^)]+)\)/m.exec(readmeVi)?.[1];
if (headingEn !== name) fail(`README.md "What works (…)" says ${JSON.stringify(headingEn)}, expected ${JSON.stringify(name)} — update the heading when bumping`);
if (headingVi !== name) fail(`README.vi.md features heading says ${JSON.stringify(headingVi)}, expected ${JSON.stringify(name)} — update the heading when bumping`);

console.log(`lint-versions: OK — machine ${machine}, release name ${name} in README ×2, SPDX ${pkg.license}`);
