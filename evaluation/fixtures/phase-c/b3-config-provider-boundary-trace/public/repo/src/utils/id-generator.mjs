let seq = 0;

export function nextId(prefix = "id") {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function resetIds() {
  seq = 0;
}
