import { registerAllHandlers } from "./events/register-handlers.mjs";

export function initApp() {
  registerAllHandlers();
}
