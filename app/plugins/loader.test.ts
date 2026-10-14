import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getDexPluginConfigs,
  getDexPlugins,
  initializeDexPlugins,
  loadRuntimePlugins,
  resetDexPluginsForTests,
} from "./loader";

type Config = Record<string, string | number | boolean>;

function setPluginConfig(entries: unknown) {
  window.__RUNTIME_CONFIG__ = {
    VITE_DEX_PLUGINS: JSON.stringify(entries),
  } as unknown as Record<string, string>;
}

const runtimeEntry = (overrides: Record<string, unknown> = {}) => ({
  pluginId: "near-intents-deposit",
  npmName: "@tarnadas/near-intents-deposit",
  version: "1.0.3",
  config: { slippageTolerance: 100 },
  entry: "/_plugins/@tarnadas/near-intents-deposit@1.0.3/dist/index.mjs",
  style: "/_plugins/@tarnadas/near-intents-deposit@1.0.3/dist/styles.css",
  ...overrides,
});

/** Import-map element the loader inspects for diagnostics. */
function installImportMap(specifiers: string[]) {
  const script = document.createElement("script");
  script.type = "importmap";
  script.textContent = JSON.stringify({
    imports: Object.fromEntries(specifiers.map((s) => [s, `/x/${s}.js`])),
  });
  document.head.appendChild(script);
}

beforeEach(() => {
  resetDexPluginsForTests();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  setPluginConfig([]);
  vi.restoreAllMocks();
});

afterEach(() => {
  delete window.__RUNTIME_CONFIG__;
});

describe("getDexPluginConfigs", () => {
  it("keeps runtime bundle URLs and drops malformed entries", () => {
    setPluginConfig([runtimeEntry(), { config: {} }, null]);
    const entries = getDexPluginConfigs();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      pluginId: "near-intents-deposit",
      entry: "/_plugins/@tarnadas/near-intents-deposit@1.0.3/dist/index.mjs",
      style: "/_plugins/@tarnadas/near-intents-deposit@1.0.3/dist/styles.css",
    });
  });
});

describe("loadRuntimePlugins", () => {
  it("imports each bundle, calls its register export with the DEX config", async () => {
    const registered: Array<{ pluginId: string; config: Config }> = [];
    const importer = vi.fn(async (url: string) => {
      if (url.includes("near-intents")) {
        return {
          registerNearIntentsDepositPlugin: (config: Config) => {
            registered.push({ pluginId: "near-intents-deposit", config });
            return () => undefined;
          },
        };
      }
      return { registerPlugin: () => () => undefined };
    });
    setPluginConfig([
      runtimeEntry(),
      runtimeEntry({
        pluginId: "starchild",
        entry: "/_plugins/starchild-orderly-plugin@1.4.0/dist/index.js",
        style: undefined,
      }),
    ]);

    const plugins = await loadRuntimePlugins(importer);
    expect(plugins).toHaveLength(2);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(registered).toEqual([
      {
        pluginId: "near-intents-deposit",
        config: { slippageTolerance: 100 },
      },
    ]);
  });

  it("prefers the documented registerPlugin export", async () => {
    setPluginConfig([runtimeEntry()]);
    const registerPlugin = vi.fn(() => () => undefined);
    await loadRuntimePlugins(async () => ({
      registerPlugin,
      registerNearIntentsDepositPlugin: () => () => undefined,
    }));
    expect(registerPlugin).toHaveBeenCalledWith({ slippageTolerance: 100 });
  });

  it("injects each stylesheet once, even for repeated URLs", async () => {
    setPluginConfig([
      runtimeEntry(),
      runtimeEntry({ pluginId: "other", entry: "/_plugins/other/index.js" }),
    ]);
    await loadRuntimePlugins(async () => ({
      registerPlugin: () => () => undefined,
    }));

    const links = document.querySelectorAll("link[rel=stylesheet]");
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute("href")).toBe(
      "/_plugins/@tarnadas/near-intents-deposit@1.0.3/dist/styles.css",
    );
  });

  it("skips plugins without a register export and keeps loading the rest", async () => {
    installImportMap(["react", "@orderly.network/hooks"]);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const importer = vi.fn(async (url: string) => {
      if (url.includes("broken")) throw new Error("Failed to resolve module");
      if (url.includes("no-register")) return { somethingElse: 1 };
      return { registerPlugin: () => () => undefined };
    });
    setPluginConfig([
      runtimeEntry({
        pluginId: "broken",
        entry: "/_plugins/broken@1.0.0/dist/index.js",
        style: undefined,
      }),
      runtimeEntry({
        pluginId: "no-register",
        entry: "/_plugins/no-register@1.0.0/dist/index.js",
        style: undefined,
      }),
      runtimeEntry({ pluginId: "fine" }),
    ]);

    const plugins = await loadRuntimePlugins(importer);
    expect(plugins).toHaveLength(1);
    const logged = errorLog.mock.calls
      .map((call) => String(call[0]))
      .join("\n");
    expect(logged).toContain("broken");
    expect(logged).toContain("host provides: @orderly.network/hooks, react");
    expect(logged).toContain("no register export found for no-register");
  });

  it("ignores build-time entries that carry no bundle URL", async () => {
    setPluginConfig([{ pluginId: "legacy", config: {} }]);
    const importer = vi.fn(async () => ({}));
    await expect(loadRuntimePlugins(importer)).resolves.toEqual([]);
    expect(importer).not.toHaveBeenCalled();
  });
});

describe("initializeDexPlugins", () => {
  it("returns the combined plugin list and caches it", async () => {
    setPluginConfig([runtimeEntry()]);
    const runtime = () => () => undefined;
    const first = await initializeDexPlugins(async () => ({
      registerPlugin: runtime,
    }));
    expect(first).toHaveLength(1);
    // Provider reads the cached list synchronously through getDexPlugins().
    expect(getDexPlugins()).toBe(first);
    // Second call is a no-op: no further imports.
    const importer = vi.fn(async () => ({ registerPlugin: runtime }));
    expect(await initializeDexPlugins(importer)).toBe(first);
    expect(importer).not.toHaveBeenCalled();
  });
});
