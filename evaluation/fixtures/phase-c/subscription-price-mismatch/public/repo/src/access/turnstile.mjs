let count = 0;

export function admit() {
  count += 1;
  return count;
}

export function turnstileCount() {
  return count;
}
