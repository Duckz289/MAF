export function computeArea(shape) {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "square":
      return shape.side * shape.side;
    case "rectangle":
      return shape.width * shape.height;
    case "triangle":
      return 0.5 * shape.base * shape.height;
    default:
      throw new Error(`Unknown shape kind: ${shape.kind}`);
  }
}
