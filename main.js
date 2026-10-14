// ═══════════════════════════════════════════════════════════════════
// StreamDirector — Electron main process
// ═══════════════════════════════════════════════════════════════════

import { app, BrowserWindow, session, shell } from 'electron';
import { watch } from 'node:fs';
import { startServer, STATIC_FILES } from './server.js';

const PORT = 9321;
const APP_URL = `http://localhost:${PORT}`;
const IS_DEV = process.argv.includes('--dev');
const BACKGROUND_COLOR = '#0a0a0f';
const TWITCH_URL = 'https://www.twitch.tv';
const TWITCH_AUTH_COOKIE = 'auth-token';
const RELOAD_DEBOUNCE_MS = 100;

/** Auth token of the Twitch login (shared session cookie), null when logged out. */
async function getTwitchAuthToken() {
  const [cookie] = await session.defaultSession.cookies.get({
    url: TWITCH_URL,
    name: TWITCH_AUTH_COOKIE,
  });

  return cookie?.value ?? null;
}

function isTwitchUrl(url) {
  const { hostname } = new URL(url);

  return hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv');
}

/** Dev mode: reload the window whenever a renderer file changes. */
function reloadOnRendererChanges(win) {
  let reloadTimer = null;

  watch(app.getAppPath(), { recursive: true }, (_event, filename) => {
    if (!filename || !STATIC_FILES.has(filename.replaceAll('\\', '/'))) return;

    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => win.webContents.reloadIgnoringCache(), RELOAD_DEBOUNCE_MS);
  });
}

async function createWindow() {
  try {
    await startServer({ port: PORT, appDir: app.getAppPath(), getAuthToken: getTwitchAuthToken });
  } catch (error) {
    console.error(`Cannot start server on port ${PORT} (another instance running?):`, error);
    app.quit();
    return;
  }

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: BACKGROUND_COLOR,
  });

  // Twitch popups (login, chat) share the session → login cookie reaches the server
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTwitchUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: BACKGROUND_COLOR,
        },
      };
    }

    if (url.startsWith('https://github.com/')) shell.openExternal(url);

    return { action: 'deny' };
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });

  // Inject app version from package.json into the renderer
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(
      `document.querySelector('.version')?.replaceChildren('v${app.getVersion()}')`,
    );
  });

  if (IS_DEV) {
    win.webContents.openDevTools();
    reloadOnRendererChanges(win);
  }

  win.loadURL(IS_DEV ? `${APP_URL}?dev` : APP_URL);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
