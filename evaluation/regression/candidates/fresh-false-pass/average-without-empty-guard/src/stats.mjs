export function sumArray(values) {
  if (values.length === 0) {
    throw new RangeError("values must not be empty");
  }
  return values.reduce((total, v) => total + v, 0);
}

export function averageArray(values) {
  return values.reduce((total, v) => total + v, 0) / values.length;
}
