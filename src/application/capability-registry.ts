import type { CapabilityId } from "../domain/assurance-obligation";
import type { CapabilityProbe, CapabilityProvider } from "../domain/capability/provider";

export interface CapabilityResolution {
  provider: CapabilityProvider;
  /** Consumer-owned identity captured once when the provider was registered. */
  selectedCapabilityId: CapabilityId;
  selectedProviderName: string;
  probe: CapabilityProbe;
}

interface RegisteredCapabilityProvider {
  provider: CapabilityProvider;
  capabilityId: CapabilityId;
  providerName: string;
}

const safeProviderName = /^[a-z][a-z0-9.-]{0,63}$/u;
const safeProviderVersion = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/u;

export class CapabilityRegistry {
  private readonly byCapability = new Map<CapabilityId, RegisteredCapabilityProvider[]>();
  private readonly probeCache = new WeakMap<CapabilityProvider, Promise<CapabilityProbe>>();

  register(provider: CapabilityProvider): void {
    const capabilityId = provider.capabilityId;
    const providerName = provider.name;
    if (typeof capabilityId !== "string" || capabilityId.trim().length === 0) {
      throw new Error("Capability provider registration requires a non-empty capability ID");
    }
    if (typeof providerName !== "string" || !safeProviderName.test(providerName)) {
      throw new Error("Capability provider registration requires a bounded identifier name");
    }
    const providers = this.byCapability.get(capabilityId) ?? [];
    providers.push({ provider, capabilityId, providerName });
    this.byCapability.set(capabilityId, providers);
  }

  /** Resolves available providers in registration order. Probe failures are cached as unavailable. */
  async resolve(id: CapabilityId): Promise<CapabilityProvider[]> {
    const resolutions = await this.resolveWithStatus(id);
    return resolutions
      .filter((resolution) => resolution.probe.available)
      .map((resolution) => resolution.provider);
  }

  /**
   * Resolves every registered provider with its cached safe probe. Unlike resolve(), this retains
   * explicit unavailable evidence so an execution pipeline cannot confuse absence with zero
   * findings, and it preserves the probed version needed for active invocation binding.
   */
  async resolveWithStatus(
    id: CapabilityId,
    options: { freshProbe?: boolean } = {},
  ): Promise<CapabilityResolution[]> {
    const registrations = this.byCapability.get(id) ?? [];
    const probes = await Promise.all(
      registrations.map((registration) =>
        this.probe(registration.provider, options.freshProbe === true),
      ),
    );
    return registrations.map((registration, index) => ({
      provider: registration.provider,
      selectedCapabilityId: registration.capabilityId,
      selectedProviderName: registration.providerName,
      probe: probes[index] ?? {
        available: false,
        version: null,
        detail: "provider probe produced no result",
      },
    }));
  }

  capabilityIds(): CapabilityId[] {
    return [...this.byCapability.keys()].toSorted();
  }

  private probe(provider: CapabilityProvider, fresh: boolean): Promise<CapabilityProbe> {
    const cached = fresh ? undefined : this.probeCache.get(provider);
    if (cached) return cached;

    const probing = Promise.resolve()
      .then(() => provider.probe(fresh ? { fresh: true } : undefined))
      .then((result): CapabilityProbe => {
        if (result === null || typeof result !== "object") {
          return { available: false, version: null, detail: "provider probe was malformed" };
        }
        return {
          available: result.available === true,
          version:
            typeof result.version === "string" && safeProviderVersion.test(result.version)
              ? result.version
              : null,
          detail:
            typeof result.detail === "string" && result.detail.trim().length > 0
              ? result.detail
              : "provider probe returned no detail",
        };
      })
      .catch(
        (): CapabilityProbe => ({
          available: false,
          version: null,
          detail: "provider probe threw",
        }),
      );
    this.probeCache.set(provider, probing);
    return probing;
  }
}
