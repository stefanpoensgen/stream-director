// ═══════════════════════════════════════════════════════════════════
// Local HTTP server (main process)
// Serves the renderer (Twitch needs a real hostname) and proxies the
// Twitch calls the renderer cannot make itself because of CORS.
// ═══════════════════════════════════════════════════════════════════

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fetchLiveChannels, fetchMasterPlaylist, isValidChannelName } from './twitch.js';

/** Renderer files — the only files the server hands out. */
export const STATIC_FILES = new Set([
  'index.html',
  'app.js',
  'player.js',
  'styles.css',
  'vendor/hls.light.mjs',
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};
const JSON_CONTENT_TYPE = 'application/json';
const PLAYLIST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

const LIVE_ROUTE = '/api/live';
const PLAYLIST_ROUTE = /^\/api\/playlist\/([a-z0-9_]+)\.m3u8$/;

function send(response, status, body = '', contentType = 'text/plain') {
  response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
  response.end(body);
}

async function handleLive(url, response) {
  const names = (url.searchParams.get('channels') ?? '').split(',').filter(Boolean);
  if (!names.every(isValidChannelName)) {
    send(response, 400, 'Invalid channel name');
    return;
  }

  send(response, 200, JSON.stringify(await fetchLiveChannels(names)), JSON_CONTENT_TYPE);
}

async function handlePlaylist(channel, response, getAuthToken) {
  if (!isValidChannelName(channel)) {
    send(response, 400, 'Invalid channel name');
    return;
  }

  const playlist = await fetchMasterPlaylist(channel, await getAuthToken());
  if (playlist === null) {
    send(response, 404, 'Channel offline');
    return;
  }

  send(response, 200, playlist, PLAYLIST_CONTENT_TYPE);
}

async function handleStatic(pathname, response, appDir) {
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!STATIC_FILES.has(file)) {
    send(response, 404);
    return;
  }

  const content = await readFile(path.join(appDir, file));
  send(response, 200, content, CONTENT_TYPES[path.extname(file)]);
}

async function route(request, response, { origin, appDir, getAuthToken }) {
  const url = new URL(request.url, origin);

  if (url.pathname === LIVE_ROUTE) {
    await handleLive(url, response);
    return;
  }

  const playlistMatch = url.pathname.match(PLAYLIST_ROUTE);
  if (playlistMatch) {
    await handlePlaylist(playlistMatch[1], response, getAuthToken);
    return;
  }

  await handleStatic(url.pathname, response, appDir);
}

/**
 * Starts the server on 127.0.0.1. Resolves once listening, rejects when the
 * port is taken (e.g. a second instance is running).
 */
export function startServer({ port, appDir, getAuthToken }) {
  const origin = `http://localhost:${port}`;

  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, { origin, appDir, getAuthToken });
    } catch (error) {
      console.error(`${request.url}: ${error.message}`);
      send(response, 502, 'Upstream error');
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}
