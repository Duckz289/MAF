// Old plaintext notification formatter, superseded by notifications/channel-notifiers.mjs.
// Unused by any live command.
export function formatLegacyNotification(message) {
  return `[NOTICE] ${message}`;
}
