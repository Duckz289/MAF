export function computeArea(shape) {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "square":
      return shape.side * shape.side;
    case "rectangle":
      return shape.width * shape.height;
    default:
      throw new RangeError(`Unknown shape kind: ${shape.kind}`);
  }
}
