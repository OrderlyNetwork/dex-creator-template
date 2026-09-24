import { getRuntimeConfigJSON } from "@/utils/runtime-config";
import { dexPlugins } from "./generated";

type PluginConfig = Record<string, string | number | boolean>;

type DexPluginConfigEntry = {
  pluginId: string;
  config: PluginConfig;
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
 */
export function getDexPlugins(): Array<(sdk: unknown) => void> {
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
