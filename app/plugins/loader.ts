import { getRuntimeConfigJSON } from "@/utils/runtime-config";
import { dexPlugins } from "./generated";

type PluginConfig = Record<string, string | number | boolean>;

type DexPluginConfigEntry = {
  pluginId: string;
  config: PluginConfig;
  /**
   * Runtime ESM bundle (Option B): URL of the plugin's entry module plus its
   * optional stylesheet, both published by the API to the environment bucket.
   * Entries without `entry` are build-time plugins (see `generated.ts`).
   */
  entry?: string;
  style?: string;
  npmName?: string;
  version?: string;
};

/** Public per-DEX plugin options from `public/config.js` (`VITE_DEX_PLUGINS`). */
export function getDexPluginConfigs(): DexPluginConfigEntry[] {
  const raw = getRuntimeConfigJSON<DexPluginConfigEntry[]>("VITE_DEX_PLUGINS");
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry) => entry && typeof entry.pluginId === "string" && entry.pluginId,
  );
}

function resolveRegisterFn(
  pluginId: string,
  mod: Record<string, unknown>,
): ((config: PluginConfig) => (sdk: unknown) => void) | null {
  const asFn = (value: unknown) =>
    typeof value === "function"
      ? (value as (config: PluginConfig) => (sdk: unknown) => void)
      : null;
  // Preferred: the documented `registerPlugin` convention.
  const conventional =
    asFn(mod["registerPlugin"]) ?? asFn((mod as { default?: unknown }).default);
  if (conventional) return conventional;
  // Fallback: legacy `register*Plugin` exports — only when unambiguous, so a
  // package never silently wires the wrong entry point.
  const candidates = Object.keys(mod).filter(
    (key) => /^register.*plugin$/i.test(key) && asFn(mod[key]),
  );
  if (candidates.length === 1) return asFn(mod[candidates[0]]);
  if (candidates.length > 1) {
    console.error(
      `[plugins] ambiguous register exports for ${pluginId}: ${candidates.join(", ")}`,
    );
    return null;
  }
  console.error(`[plugins] no register export found for ${pluginId}`);
  return null;
}

/**
 * Builds the `plugins` array for `OrderlyAppProvider`. One broken plugin
 * never blocks the DEX — it is skipped with an error log.
 *
 * Returns the initialized list once `initializeDexPlugins()` has run (static +
 * runtime plugins); before that it only knows the build-time plugins.
 */
export function getDexPlugins(): Array<(sdk: unknown) => void> {
  return initializedPlugins ?? buildStaticPlugins();
}

/** Build-time plugins baked into the bundle (`app/plugins/generated.ts`). */
function buildStaticPlugins(): Array<(sdk: unknown) => void> {
  const configs = new Map(
    getDexPluginConfigs().map((entry) => [entry.pluginId, entry.config ?? {}]),
  );
  const out: Array<(sdk: unknown) => void> = [];
  for (const entry of dexPlugins as ReadonlyArray<{
    pluginId: string;
    module: Record<string, unknown>;
  }>) {
    try {
      const register = resolveRegisterFn(entry.pluginId, entry.module);
      if (!register) continue;
      out.push(
        register(configs.get(entry.pluginId) ?? {}) as (sdk: unknown) => void,
      );
    } catch (error) {
      console.error(`[plugins] failed to init ${entry.pluginId}:`, error);
    }
  }
  return out;
}

/** Specifiers the host import map (baked into index.html) can satisfy. */
function sharedImportMapSpecifiers(): string[] {
  if (typeof document === "undefined") return [];
  const script = document.querySelector('script[type="importmap"]');
  const source = script?.textContent;
  if (!source) return [];
  try {
    const map = JSON.parse(source) as { imports?: Record<string, string> };
    return Object.keys(map.imports ?? {}).sort();
  } catch {
    return [];
  }
}

function injectStylesheet(url: string): void {
  if (typeof document === "undefined") return;
  // No CSS.escape dependency (jsdom lacks it): compare the data attribute.
  const alreadyLinked = Array.from(
    document.querySelectorAll("link[data-orderly-plugin-style]"),
  ).some((link) => link.getAttribute("data-orderly-plugin-style") === url);
  if (alreadyLinked) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = url;
  link.dataset.orderlyPluginStyle = url;
  document.head.appendChild(link);
}

/**
 * Loads runtime plugins: each `VITE_DEX_PLUGINS` entry that carries an `entry`
 * URL is dynamically imported from the environment bucket, so installing a
 * plugin needs no per-DEX build. Plugins are built to import `react` /
 * `@orderly.network/*` by their bare names, which the host import map resolves
 * to the app's own module instances (single React/SDK — no duplicate context).
 *
 * The importer is injectable for tests; production uses the native dynamic
 * import with `@vite-ignore` so the URL is resolved by the browser at runtime.
 */
export async function loadRuntimePlugins(
  importer: (url: string) => Promise<unknown> = (url) =>
    import(/* @vite-ignore */ url),
): Promise<Array<(sdk: unknown) => void>> {
  const entries = getDexPluginConfigs().filter(
    (entry) => typeof entry.entry === "string" && entry.entry,
  );
  const out: Array<(sdk: unknown) => void> = [];
  for (const entry of entries) {
    try {
      if (entry.style) injectStylesheet(entry.style);
      const mod = (await importer(entry.entry as string)) as Record<
        string,
        unknown
      >;
      const register = resolveRegisterFn(entry.pluginId, mod ?? {});
      if (!register) continue;
      out.push(register(entry.config ?? {}) as (sdk: unknown) => void);
    } catch (error) {
      const provided = sharedImportMapSpecifiers();
      console.error(
        `[plugins] failed to load ${entry.pluginId} (${entry.entry}) — a bare import may be missing from the host import map` +
          (provided.length > 0
            ? ` (host provides: ${provided.join(", ")})`
            : ""),
        error,
      );
    }
  }
  return out;
}

let initializedPlugins: Array<(sdk: unknown) => void> | null = null;

/**
 * Registers every plugin — build-time ones from `generated.ts` plus runtime
 * bundles — before the app renders, so `OrderlyAppProvider` receives a stable
 * list. Safe to call once; later calls are no-ops.
 */
export async function initializeDexPlugins(
  importer?: (url: string) => Promise<unknown>,
): Promise<Array<(sdk: unknown) => void>> {
  if (initializedPlugins) return initializedPlugins;
  const runtime = await loadRuntimePlugins(importer);
  initializedPlugins = [...buildStaticPlugins(), ...runtime];
  return initializedPlugins;
}

/** Test seam: forget the initialized plugin list. */
export function resetDexPluginsForTests(): void {
  initializedPlugins = null;
}
