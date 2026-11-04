// Twitch chat over IRC WebSockets (https://dev.twitch.tv/docs/chat/irc/).
//
// The chat uses two connections: an anonymous one reads every joined channel, an authenticated one
// only sends. Twitch never echoes a message back to the connection that sent it, but the reading
// connection receives it like any other — with emotes, badges and color filled in by Twitch.

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const CAPABILITIES = 'twitch.tv/tags twitch.tv/commands';
const ANONYMOUS_PASSWORD = 'SCHMOOPIIE'; // any password works for the read-only justinfan logins
const ANONYMOUS_NICK_RANGE = 100_000;
const WELCOME_COMMAND = '001';
const AUTH_FAILED_NOTICES = ['Login authentication failed', 'Improperly formatted auth'];
const RECONNECT_BASE_DELAY_MS = 1000;
const RECONNECT_MAX_DELAY_MS = 30_000;

// Twitch pings about every 5 minutes; our own ping notices a dead connection much earlier
const KEEPALIVE_INTERVAL_MS = 60_000;
const KEEPALIVE_TIMEOUT_MS = 10_000;

const TAG_ESCAPES = { ':': ';', s: ' ', '\\': '\\', r: '\r', n: '\n' };

/** Parses one IRC line: tags (unescaped), sender login, command and parameters (the trailing one last). */
export function parseIrcLine(line) {
  let rest = line;
  const tags = {};

  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    for (const pair of rest.slice(1, end).split(';')) {
      const separator = pair.indexOf('=');
      if (separator === -1) tags[pair] = '';
      else tags[pair.slice(0, separator)] = unescapeTagValue(pair.slice(separator + 1));
    }
    rest = rest.slice(end + 1);
  }

  let prefix = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }

  const trailingStart = rest.indexOf(' :');
  const middle = trailingStart === -1 ? rest : rest.slice(0, trailingStart);
  const [command, ...params] = middle.split(' ').filter(Boolean);
  if (trailingStart !== -1) params.push(rest.slice(trailingStart + 2));

  return { tags, login: prefix.split('!')[0], command, params };
}

function unescapeTagValue(value) {
  // An unknown escape keeps its character, a lone trailing backslash is dropped
  return value.replace(/\\(.?)/g, (_, character) => TAG_ESCAPES[character] ?? character);
}

/**
 * One self-healing IRC connection: reconnects with backoff and joins its channels again.
 * Without credentials it reads anonymously.
 */
export class IrcConnection {
  #credentials;
  #onMessage;
  #onStatus;
  #socket = null;
  #channels = new Set();
  #isReady = false;
  #isClosed = false;
  #reconnectAttempt = 0;
  #reconnectTimer = null;
  #keepaliveTimer = null;
  #lastActivityAt = 0;

  /**
   * @param {{ credentials?: { login: string, token: string } | null,
   *           onMessage: (message: object) => void,
   *           onStatus?: (status: 'connecting' | 'connected' | 'disconnected' | 'auth-failed') => void }} options
   */
  constructor({ credentials = null, onMessage, onStatus = () => {} }) {
    this.#credentials = credentials;
    this.#onMessage = onMessage;
    this.#onStatus = onStatus;
  }

  get isReady() {
    return this.#isReady;
  }

  connect() {
    this.#onStatus('connecting');

    const socket = new WebSocket(IRC_URL);
    this.#socket = socket;
    socket.addEventListener('open', () => this.#logIn());
    socket.addEventListener('message', (event) => this.#receive(event.data));
    socket.addEventListener('close', () => this.#handleClose(socket));
  }

  /** Closes for good — no reconnect. */
  close() {
    this.#isClosed = true;
    clearTimeout(this.#reconnectTimer);
    clearInterval(this.#keepaliveTimer);
    this.#socket?.close();
  }

  join(channel) {
    if (this.#channels.has(channel)) return;

    this.#channels.add(channel);
    if (this.#isReady) this.#send(`JOIN #${channel}`);
  }

  part(channel) {
    if (!this.#channels.delete(channel)) return;

    if (this.#isReady) this.#send(`PART #${channel}`);
  }

  hasJoined(channel) {
    return this.#channels.has(channel);
  }

  /** Sends a raw line; false while the connection is down. */
  send(line) {
    if (!this.#isReady) return false;

    this.#send(line);
    return true;
  }

  #send(line) {
    this.#socket.send(line);
  }

  #logIn() {
    const { login, token } = this.#credentials ?? {};

    this.#send(`CAP REQ :${CAPABILITIES}`);
    this.#send(`PASS ${token ? `oauth:${token}` : ANONYMOUS_PASSWORD}`);
    this.#send(`NICK ${login ?? `justinfan${Math.floor(Math.random() * ANONYMOUS_NICK_RANGE)}`}`);
  }

  #receive(data) {
    this.#lastActivityAt = Date.now();

    for (const line of data.split('\r\n')) {
      if (!line) continue;

      const message = parseIrcLine(line);
      this.#handleProtocol(message);
      this.#onMessage(message);
    }
  }

  #handleProtocol(message) {
    switch (message.command) {
      case 'PING':
        this.#send(`PONG :${message.params[0] ?? 'tmi.twitch.tv'}`);
        break;
      case WELCOME_COMMAND:
        this.#isReady = true;
        this.#reconnectAttempt = 0;
        this.#startKeepalive();
        if (this.#channels.size > 0) {
          this.#send(`JOIN ${[...this.#channels].map((channel) => `#${channel}`).join(',')}`);
        }
        this.#onStatus('connected');
        break;
      case 'RECONNECT':
        // Twitch is about to restart this server — reconnect right away
        this.#socket.close();
        break;
      case 'NOTICE':
        if (AUTH_FAILED_NOTICES.some((text) => message.params.at(-1)?.startsWith(text))) {
          this.close();
          this.#onStatus('auth-failed');
        }
        break;
    }
  }

  #startKeepalive() {
    clearInterval(this.#keepaliveTimer);
    this.#keepaliveTimer = setInterval(() => {
      if (Date.now() - this.#lastActivityAt > KEEPALIVE_INTERVAL_MS + KEEPALIVE_TIMEOUT_MS) {
        this.#abandonSocket();
        return;
      }

      this.#send('PING :keepalive');
    }, KEEPALIVE_INTERVAL_MS);
  }

  /** Reconnects right away: closing a dead connection may take long to report back. */
  #abandonSocket() {
    const socket = this.#socket;
    this.#handleClose(socket);
    this.#socket = null;
    socket.close();
  }

  #handleClose(socket) {
    // A replaced socket closing late must not tear down its successor
    if (socket !== this.#socket) return;

    this.#isReady = false;
    clearInterval(this.#keepaliveTimer);
    if (this.#isClosed) return;

    this.#onStatus('disconnected');
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.#reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => this.connect(), delay * (1 + Math.random() / 2));
  }
}
