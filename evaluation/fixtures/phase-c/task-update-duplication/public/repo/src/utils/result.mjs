export function ok(value) {
  return { ok: true, value };
}

export function err(message) {
  return { ok: false, message };
}
