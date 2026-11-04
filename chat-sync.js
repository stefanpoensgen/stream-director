// Messages between the main page and the chat popup. Both are pages of the app origin in one
// WebView2 profile, so a BroadcastChannel connects them without the host in between.

export const CHAT_SYNC_CHANNEL = 'stream-director-chat';

export const CHAT_SYNC_TYPES = {
  // main → chat: { focus, channels: [{ login, displayName }], loggedIn }
  state: 'state',
  // chat → main: sent once the chat page is loaded, answered with the current state
  hello: 'hello',
};
