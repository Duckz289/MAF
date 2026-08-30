let counter = 0;

export function now() {
  counter += 1;
  return counter;
}

export function resetClock() {
  counter = 0;
}
