import { describe, expect, it } from "vitest";
import {
  checkOutcomeLabel,
  checkOutcomeTone,
  formatMonetaryDisplay,
  isPassingCheck,
  presentCostBreakdown,
} from "../src/domain/control-center";
import { isNavigationSelected } from "../src/web/presentation";

describe("control-center presentation", () => {
  it("keeps Control Center navigation scoped", () => {
    expect(isNavigationSelected("/", "/")).toBe(true);
    expect(isNavigationSelected("/projects/abc/map", "/projects")).toBe(true);
    expect(isNavigationSelected("/runs/new", "/projects")).toBe(false);
    expect(isNavigationSelected("/providers", "/connections")).toBe(false);
  });

  it("does not present UNKNOWN or NOT_EXECUTED as PASS", () => {
    expect(isPassingCheck("UNKNOWN")).toBe(false);
    expect(checkOutcomeTone("UNKNOWN")).not.toBe(checkOutcomeTone("PASS"));
    expect(checkOutcomeLabel("NOT_EXECUTED")).not.toBe(checkOutcomeLabel("PASS"));
  });

  it("does not render UNKNOWN cost as $0", () => {
    expect(formatMonetaryDisplay("UNKNOWN", 0)).toBe("unknown");
    expect(
      presentCostBreakdown({
        model: 0,
        sandbox: 0,
        verification: 0,
        retry: 0,
        recovery: 0,
        total: 0,
      }).total.display,
    ).not.toContain("$0");
  });

  it("keeps a known subtotal while leaving unmetered components and the total unknown", () => {
    const cost = presentCostBreakdown({
      model: 2,
      sandbox: 0,
      verification: 0,
      retry: 0,
      recovery: 0,
      total: 2,
    });
    expect(cost.knownSubtotalUsd).toBe(2);
    expect(cost.total.status).toBe("UNKNOWN");
    expect(cost.unknownComponentCount).toBeGreaterThan(0);
    expect(cost.components.find((item) => item.id === "model")?.monetary.status).toBe("ESTIMATED");
    expect(cost.components.find((item) => item.id === "context")?.monetary.status).toBe("UNKNOWN");
  });
});
