import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

/**
 * Runtime plugin host support (Option B for marketplace plugins).
 *
 * Plugins are published as self-contained ESM bundles that import `react`,
 * `react-dom` and `@orderly.network/*` by their bare names. This plugin emits
 * re-export entry chunks for exactly those specifiers and injects an import map
 * into index.html, so a dynamically imported plugin resolves to the *same*
 * module instances the app itself uses — one React, one SDK, no duplicate
 * contexts (which is why CDN-hosted plugins are not an option).
 *
 * The map is baked at build time and ships with the shared bundle, so every DEX
 * on the environment gets it without any per-DEX work.
 */

const FIXED_SPECIFIERS = [
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
] as const;

/**
 * SDK packages plugins may import. Deliberately curated instead of "every
 * @orderly.network dependency": a re-export entry pulls the package's whole
 * module graph into the build, so the host only advertises what plugins are
 * meant to share. Extend this list when a plugin needs another package.
 */
const SHARED_SDK_SPECIFIERS = [
  "@orderly.network/hooks",
  "@orderly.network/i18n",
  "@orderly.network/plugin-core",
  "@orderly.network/trading-next",
  "@orderly.network/types",
  "@orderly.network/ui",
  "@orderly.network/ui-transfer",
  "@orderly.network/utils",
] as const;

/** Entry points whose default export plugins import (`import React from ...`). */
const DEFAULT_EXPORTS = new Set(["react", "react-dom"]);

const VIRTUAL_PREFIX = "virtual:orderly-shared-runtime/";

export type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** Host-provided specifiers a plugin may import: React plus the shared SDK. */
export function collectSharedSpecifiers(manifest: PackageManifest): string[] {
  const specifiers = new Set<string>(FIXED_SPECIFIERS);
  for (const name of SHARED_SDK_SPECIFIERS) {
    if (manifest.dependencies?.[name]) specifiers.add(name);
  }
  return [...specifiers].sort();
}

/** Source of the re-export entry chunk for one specifier. */
export function sharedEntrySource(specifier: string): string {
  const quoted = JSON.stringify(specifier);
  const lines = [`export * from ${quoted};`];
  if (DEFAULT_EXPORTS.has(specifier)) {
    lines.push(`export { default } from ${quoted};`);
  }
  return `${lines.join("\n")}\n`;
}

/** Input/chunk name for a specifier (`@orderly.network/hooks` → safe path). */
export function entryNameFor(specifier: string): string {
  return `shared-runtime/${specifier.replace(/^@/, "").replace(/\//g, "-")}`;
}

/** Joins the app's build base with an emitted file name. */
export function resolveImportUrl(base: string, fileName: string): string {
  const prefix =
    base && base !== "/" && base !== "./" ? `${base.replace(/\/$/, "")}/` : "/";
  return `${prefix}${fileName.replace(/^\//, "")}`;
}

export function buildImportMap(
  entries: Array<{ specifier: string; fileName: string }>,
  base: string,
): { imports: Record<string, string> } {
  const imports: Record<string, string> = {};
  for (const { specifier, fileName } of [...entries].sort((a, b) =>
    a.specifier.localeCompare(b.specifier),
  )) {
    imports[specifier] = resolveImportUrl(base, fileName);
  }
  return { imports };
}

/** Serializes the map for a `<script type="importmap">` block. */
export function importMapScript(map: unknown): string {
  // `<` escaped so a specifier can never terminate the script element.
  const json = JSON.stringify(map, null, 2).replace(/</g, "\\u003c");
  return `<script type="importmap">\n${json}\n</script>\n`;
}

/** Inserts the import map before the first module script (or into `</head>`). */
export function injectImportMap(html: string, map: unknown): string {
  if (html.includes('type="importmap"')) return html;
  const script = importMapScript(map);
  const moduleIndex = html.search(/<script[^>]*type="module"/);
  if (moduleIndex >= 0) {
    return `${html.slice(0, moduleIndex)}${script}${html.slice(moduleIndex)}`;
  }
  return html.includes("</head>")
    ? html.replace("</head>", `${script}  </head>`)
    : `${script}${html}`;
}

/**
 * Vite plugin: adds the shared entries to the build and bakes the import map
 * into every emitted HTML file (the DEX shell is a copy of it, so all DEXes on
 * the environment share one map).
 */
export function sharedRuntimePlugin(options: { root?: string } = {}): Plugin {
  const root = options.root ?? process.cwd();
  let manifest: PackageManifest = {};
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    ) as PackageManifest;
  } catch (error) {
    console.warn("[shared-runtime] package.json could not be read:", error);
  }

  const specifiers = collectSharedSpecifiers(manifest);
  const specifierByVirtualId = new Map(
    specifiers.map((specifier) => [`${VIRTUAL_PREFIX}${specifier}`, specifier]),
  );
  const specifierByEntryName = new Map(
    specifiers.map((specifier) => [entryNameFor(specifier), specifier]),
  );
  let base = "/";

  return {
    name: "orderly-shared-runtime",
    apply: "build",
    enforce: "post",

    configResolved(config) {
      base = config.base;
    },

    resolveId(id) {
      return specifierByVirtualId.has(id) ? `\0${id}` : null;
    },

    load(id) {
      if (!id.startsWith("\0")) return null;
      const specifier = specifierByVirtualId.get(id.slice(1));
      return specifier ? sharedEntrySource(specifier) : null;
    },

    options(rollupOptions) {
      const existing = rollupOptions.input;
      const input: Record<string, string> = {};
      if (typeof existing === "string") {
        input.index = existing;
      } else if (Array.isArray(existing)) {
        existing.forEach((entry, index) => {
          input[index === 0 ? "index" : `entry-${index}`] = String(entry);
        });
      } else if (existing) {
        Object.assign(input, existing as Record<string, string>);
      }
      for (const specifier of specifiers) {
        input[entryNameFor(specifier)] = `${VIRTUAL_PREFIX}${specifier}`;
      }
      return { ...rollupOptions, input };
    },

    generateBundle(_outputOptions, bundle) {
      const entries: Array<{ specifier: string; fileName: string }> = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk" || !item.name) continue;
        const specifier = specifierByEntryName.get(item.name);
        if (specifier) entries.push({ specifier, fileName: item.fileName });
      }
      const missing = specifiers.filter(
        (specifier) => !entries.some((entry) => entry.specifier === specifier),
      );
      if (missing.length > 0) {
        this.warn(
          `[shared-runtime] no chunk emitted for: ${missing.join(", ")}`,
        );
      }

      const map = buildImportMap(entries, base);
      this.emitFile({
        type: "asset",
        fileName: "import-map.json",
        source: `${JSON.stringify(map, null, 2)}\n`,
      });
      for (const item of Object.values(bundle)) {
        if (
          item.type === "asset" &&
          item.fileName.endsWith(".html") &&
          typeof item.source === "string"
        ) {
          item.source = injectImportMap(item.source, map);
        }
      }
    },
  };
}
