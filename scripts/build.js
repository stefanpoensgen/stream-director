// ═══════════════════════════════════════════════════════════════════
// Windows build without electron-builder
//
// Electron's prebuilt binary (downloaded and checksum-verified by the
// electron package on first use) + the app files → dist/StreamDirector/
// rcedit sets icon and file metadata of the renamed executable.
// ═══════════════════════════════════════════════════════════════════

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import electronExecutable from 'electron';
import { STATIC_FILES } from '../server.js';

const PRODUCT_NAME = 'StreamDirector';
const ROOT = path.resolve(import.meta.dirname, '..');
const ELECTRON_DIST = path.dirname(electronExecutable);
const DIST_DIR = path.join(ROOT, 'dist');
const OUTPUT_DIR = path.join(DIST_DIR, PRODUCT_NAME);
const APP_DIR = path.join(OUTPUT_DIR, 'resources', 'app');
const EXECUTABLE = path.join(OUTPUT_DIR, `${PRODUCT_NAME}.exe`);
const ICON = path.join(ROOT, 'icon.ico');

const MAIN_PROCESS_FILES = ['main.js', 'server.js', 'twitch.js'];
const LICENSE_FILES = ['LICENSE', 'vendor/hls.js.LICENSE'];
const APP_FILES = [...MAIN_PROCESS_FILES, ...STATIC_FILES, ...LICENSE_FILES];

const RCEDIT_URL = 'https://github.com/electron/rcedit/releases/download/v2.0.0/rcedit-x64.exe';
const RCEDIT_SHA256 = '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a';
const RCEDIT_PATH = path.join(DIST_DIR, 'rcedit-x64.exe');

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Downloads rcedit once and refuses to run a binary with an unexpected checksum. */
async function ensureRcedit() {
  if (existsSync(RCEDIT_PATH) && sha256(readFileSync(RCEDIT_PATH)) === RCEDIT_SHA256) return;

  const response = await fetch(RCEDIT_URL);
  if (!response.ok) throw new Error(`rcedit download failed: HTTP ${response.status}`);

  const binary = Buffer.from(await response.arrayBuffer());
  if (sha256(binary) !== RCEDIT_SHA256) throw new Error('rcedit checksum mismatch — aborting');

  await writeFile(RCEDIT_PATH, binary);
}

function copyElectron() {
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  cpSync(ELECTRON_DIST, OUTPUT_DIR, { recursive: true });
  rmSync(path.join(OUTPUT_DIR, 'resources', 'default_app.asar'), { force: true });
  renameSync(path.join(OUTPUT_DIR, 'electron.exe'), EXECUTABLE);
}

async function copyApp({ name, version }) {
  for (const file of APP_FILES) {
    const target = path.join(APP_DIR, file);
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(path.join(ROOT, file), target);
  }

  // productName decides the userData folder — keep it stable across releases
  const manifest = { name, productName: PRODUCT_NAME, version, type: 'module', main: 'main.js' };
  await writeFile(path.join(APP_DIR, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Without this, Explorer and Task Manager show Electron's icon and name. */
function brandExecutable(version) {
  const versionStrings = {
    ProductName: PRODUCT_NAME,
    FileDescription: PRODUCT_NAME,
    InternalName: PRODUCT_NAME,
    OriginalFilename: `${PRODUCT_NAME}.exe`,
    CompanyName: PRODUCT_NAME,
  };

  execFileSync(RCEDIT_PATH, [
    EXECUTABLE,
    '--set-icon',
    ICON,
    '--set-file-version',
    version,
    '--set-product-version',
    version,
    ...Object.entries(versionStrings).flatMap(([key, value]) => [
      '--set-version-string',
      key,
      value,
    ]),
  ]);
}

async function build() {
  if (process.platform !== 'win32') {
    throw new Error(
      'The build targets Windows and needs the Windows Electron binary — run it on Windows.',
    );
  }

  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  mkdirSync(DIST_DIR, { recursive: true });

  await ensureRcedit();
  copyElectron();
  await copyApp(packageJson);
  brandExecutable(packageJson.version);

  console.log(`Built ${PRODUCT_NAME} ${packageJson.version} → ${path.relative(ROOT, OUTPUT_DIR)}`);
}

build().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
