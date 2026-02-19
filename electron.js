'use strict';

const { app, BrowserWindow, shell } = require('electron');

if (process.env.NODE_ENV === 'development') {
  try {
    require('electron-reloader')(module);
  } catch {}
}

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9321;
const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const pathname = decodeURIComponent(url.pathname);
      const filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

      // Block path traversal
      if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end();
        return;
      }

      const ext = path.extname(filePath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(data);
      });
    });
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Is another instance running?`);
        app.quit();
      }
    });
    server.listen(PORT, '127.0.0.1', () => resolve());
  });
}

async function createWindow() {
  await startServer();

  const win = new BrowserWindow({
    width: 1920,
    height: 1080,
    useContentSize: true,
    frame: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0a0f',
    webPreferences: {
      webSecurity: false, // allow cross-origin fetches (twitch.tv live check)
    },
  });

  // Allow Twitch login popups (same session → cookies shared with embeds)
  win.webContents.setWindowOpenHandler(({ url }) => {
    const hostname = new URL(url).hostname;
    if (hostname === 'twitch.tv' || hostname.endsWith('.twitch.tv')) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480,
          height: 720,
          autoHideMenuBar: true,
          backgroundColor: '#0a0a0f',
        },
      };
    }
    // Open known external links in the default browser
    if (url.startsWith('https://github.com/')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Open DevTools in dev mode (pass --dev flag)
  if (process.argv.includes('--dev')) {
    win.webContents.openDevTools();
  }

  win.loadURL(`http://localhost:${PORT}`);

  // Inject app version from package.json into the renderer
  win.webContents.on('did-finish-load', () => {
    const v = app.getVersion();
    win.webContents.executeJavaScript(
      `document.querySelector('.version')?.replaceChildren('v${v}')`,
    );
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
