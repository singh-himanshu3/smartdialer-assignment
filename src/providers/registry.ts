import type { TelecomProvider } from "./provider.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, TelecomProvider>();

  constructor(providers: readonly TelecomProvider[]) {
    for (const provider of providers) {
      if (this.providers.has(provider.name)) {
        throw new Error(`Duplicate provider registration: ${provider.name}`);
      }
      this.providers.set(provider.name, provider);
    }
  }

  get(name: string): TelecomProvider {
    const provider = this.providers.get(name);
    if (provider === undefined) {
      throw new Error(`Unknown telecom provider: ${name}`);
    }
    return provider;
  }

  all(): readonly TelecomProvider[] {
    return [...this.providers.values()];
  }
}
