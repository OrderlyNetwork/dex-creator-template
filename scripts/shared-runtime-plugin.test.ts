import { describe, expect, it } from "vitest";
import {
  buildImportMap,
  collectSharedSpecifiers,
  entryNameFor,
  importMapScript,
  injectImportMap,
  resolveImportUrl,
  sharedEntrySource,
  sharedRuntimePlugin,
} from "./shared-runtime-plugin";

describe("collectSharedSpecifiers", () => {
  it("includes React entry points and the shared SDK packages the app ships", () => {
    const specifiers = collectSharedSpecifiers({
      dependencies: {
        "@orderly.network/hooks": "3.2.1",
        "@orderly.network/ui": "3.2.1",
        "@orderly.network/storybook": "1.0.0",
        "react-router-dom": "7.0.0",
        lodash: "4.17.21",
      },
    });
    expect(specifiers).toEqual([
      "@orderly.network/hooks",
      "@orderly.network/ui",
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
    ]);
  });

  it("only advertises SDK packages present in dependencies", () => {
    const specifiers = collectSharedSpecifiers({
      dependencies: { lodash: "4.17.21" },
      devDependencies: { "@orderly.network/ts-config": "1.0.0" },
    });
    expect(specifiers).toEqual([
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
    ]);
  });
});

describe("sharedEntrySource", () => {
  it("re-exports every named export", () => {
    expect(sharedEntrySource("@orderly.network/hooks")).toBe(
      'export * from "@orderly.network/hooks";\n',
    );
  });

  it("adds the default re-export for React entry points", () => {
    expect(sharedEntrySource("react")).toBe(
      'export * from "react";\nexport { default } from "react";\n',
    );
    expect(sharedEntrySource("react-dom")).toContain(
      'export { default } from "react-dom";',
    );
    expect(sharedEntrySource("react-dom/client")).not.toContain("default");
  });
});

describe("entryNameFor", () => {
  it("builds a safe chunk path for scoped packages", () => {
    expect(entryNameFor("@orderly.network/ui-transfer")).toBe(
      "shared-runtime/orderly.network-ui-transfer",
    );
    expect(entryNameFor("react/jsx-runtime")).toBe(
      "shared-runtime/react-jsx-runtime",
    );
  });
});

describe("resolveImportUrl", () => {
  it("keeps root-relative and prefixed bases correct", () => {
    expect(resolveImportUrl("/", "assets/react-abc.js")).toBe(
      "/assets/react-abc.js",
    );
    expect(resolveImportUrl("/_app/v1/", "assets/react-abc.js")).toBe(
      "/_app/v1/assets/react-abc.js",
    );
    expect(resolveImportUrl("./", "assets/react-abc.js")).toBe(
      "/assets/react-abc.js",
    );
  });
});

describe("buildImportMap", () => {
  it("maps every specifier to its built chunk, sorted", () => {
    const map = buildImportMap(
      [
        { specifier: "react", fileName: "assets/shared-runtime/react-1.js" },
        {
          specifier: "@orderly.network/hooks",
          fileName: "assets/shared-runtime/hooks-2.js",
        },
      ],
      "/_app/v3/",
    );
    expect(Object.keys(map.imports)).toEqual([
      "@orderly.network/hooks",
      "react",
    ]);
    expect(map.imports["@orderly.network/hooks"]).toBe(
      "/_app/v3/assets/shared-runtime/hooks-2.js",
    );
  });
});

describe("injectImportMap", () => {
  const html = [
    "<!DOCTYPE html>",
    "<html>",
    "  <head>",
    '    <script type="module" src="/_app/v1/assets/index-abc.js"></script>',
    "  </head>",
    "<body></body>",
    "</html>",
  ].join("\n");

  it("inserts the map before the first module script", () => {
    const result = injectImportMap(html, { imports: { react: "/react.js" } });
    expect(result.indexOf('type="importmap"')).toBeGreaterThan(-1);
    expect(result.indexOf('type="importmap"')).toBeLessThan(
      result.indexOf('type="module"'),
    );
  });

  it("escapes '<' so the JSON cannot close the script element", () => {
    const script = importMapScript({ imports: { evil: "</script>" } });
    expect(script).not.toContain("</script><");
    expect(script).toContain("\\u003c/script>");
  });

  it("is idempotent and falls back to </head>", () => {
    const once = injectImportMap(html, { imports: {} });
    expect(injectImportMap(once, { imports: {} })).toBe(once);

    const headOnly = "<html><head></head><body></body></html>";
    expect(injectImportMap(headOnly, { imports: {} })).toContain(
      'type="importmap"',
    );
  });
});

describe("sharedRuntimePlugin build hooks", () => {
  type Hook = (this: unknown, ...args: unknown[]) => unknown;
  const plugin = sharedRuntimePlugin({ root: process.cwd() });
  const call = <T>(hook: unknown, thisArg: unknown, ...args: unknown[]) =>
    (hook as Hook).call(thisArg, ...args) as T;

  it("adds a re-export entry for every shared specifier", () => {
    const options = call<{ input: Record<string, string> }>(
      plugin.options,
      {},
      { input: { index: "app/main.tsx" } },
    );
    expect(options.input.index).toBe("app/main.tsx");
    expect(options.input["shared-runtime/react"]).toBe(
      "virtual:orderly-shared-runtime/react",
    );
  });

  it("resolves and loads the virtual shared entries", () => {
    const id = "virtual:orderly-shared-runtime/react";
    const resolved = call<string>(plugin.resolveId, {}, id);
    expect(resolved).toBe(`\0${id}`);
    expect(call<string>(plugin.load, {}, resolved)).toContain(
      'export * from "react";',
    );
    expect(call(plugin.load, {}, "app/main.tsx")).toBe(null);
  });

  it("emits the import map and injects it into the emitted HTML", () => {
    const emitted: Array<{ fileName: string; source: string }> = [];
    const warnings: string[] = [];
    const bundle: Record<string, unknown> = {
      "assets/shared-runtime/react-abc123.js": {
        type: "chunk",
        name: "shared-runtime/react",
        fileName: "assets/shared-runtime/react-abc123.js",
      },
      "assets/shared-runtime/react-dom-abc123.js": {
        type: "chunk",
        name: "shared-runtime/react-dom",
        fileName: "assets/shared-runtime/react-dom-abc123.js",
      },
      "index.html": {
        type: "asset",
        fileName: "index.html",
        source: [
          "<html><head></head><body>",
          '<script type="module" src="/_app/v1/assets/index-xyz.js"></script>',
          "</body></html>",
        ].join("\n"),
      },
    };

    call(
      plugin.generateBundle,
      {
        emitFile: (asset: { fileName: string; source: string }) =>
          emitted.push(asset),
        warn: (message: string) => warnings.push(message),
      },
      {},
      bundle,
    );

    const mapAsset = emitted.find(
      (asset) => asset.fileName === "import-map.json",
    );
    expect(mapAsset).toBeDefined();
    const map = JSON.parse(mapAsset?.source ?? "{}") as {
      imports: Record<string, string>;
    };
    expect(map.imports.react).toBe("/assets/shared-runtime/react-abc123.js");
    expect(map.imports["react-dom"]).toBe(
      "/assets/shared-runtime/react-dom-abc123.js",
    );

    const html = (bundle["index.html"] as { source: string }).source;
    expect(html).toContain('type="importmap"');
    expect(html.indexOf('type="importmap"')).toBeLessThan(
      html.indexOf('type="module"'),
    );
    // Specifiers without an emitted chunk are reported, not silently missing.
    expect(warnings.join(" ")).toContain("@orderly.network/");
  });
});
