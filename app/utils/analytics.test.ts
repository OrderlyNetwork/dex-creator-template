import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYTICS_LOADER_VERSION,
  initializeAnalytics,
  initializeAnalyticsFromRuntimeConfig,
} from "./analytics";

const providerMocks = vi.hoisted(() => ({
  firebaseGetAnalytics: vi.fn(),
  firebaseGetApp: vi.fn(),
  firebaseGetApps: vi.fn(() => []),
  firebaseInitializeApp: vi.fn(() => ({ name: "orderly-analytics-v1" })),
  firebaseIsSupported: vi.fn(async () => true),
  plausibleInit: vi.fn(),
}));

vi.mock("firebase/app", () => ({
  getApp: providerMocks.firebaseGetApp,
  getApps: providerMocks.firebaseGetApps,
  initializeApp: providerMocks.firebaseInitializeApp,
}));

vi.mock("firebase/analytics", () => ({
  getAnalytics: providerMocks.firebaseGetAnalytics,
  isSupported: providerMocks.firebaseIsSupported,
}));

vi.mock("@plausible-analytics/tracker/plausible.js", () => ({
  init: providerMocks.plausibleInit,
}));

const ga4Config = {
  version: 1 as const,
  provider: "ga4" as const,
  measurementId: "G-QJTR675252",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  providerMocks.firebaseGetApps.mockReturnValue([]);
  providerMocks.firebaseIsSupported.mockResolvedValue(true);

  delete window.__ORDERLY_ANALYTICS_RUNTIME__;
  delete window.__RUNTIME_CONFIG__;
  delete window.dataLayer;
  delete window.gtag;
  document.head
    .querySelectorAll("[data-orderly-analytics-provider]")
    .forEach((element) => element.remove());
  delete document.documentElement.dataset.orderlyAnalyticsLoaderVersion;
  delete document.documentElement.dataset.orderlyAnalyticsProvider;
  delete document.documentElement.dataset.orderlyAnalyticsStatus;
});

describe("analytics runtime", () => {
  it("loads GA4 from the fixed Google endpoint and is idempotent", async () => {
    const first = initializeAnalytics(ga4Config);
    const second = initializeAnalytics(ga4Config);
    const script = document.querySelector<HTMLScriptElement>(
      "#orderly-analytics-ga4",
    );

    expect(script?.src).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-QJTR675252",
    );
    expect(script?.dataset.orderlyAnalyticsLoaderVersion).toBe(
      ANALYTICS_LOADER_VERSION,
    );
    expect(document.querySelectorAll("#orderly-analytics-ga4")).toHaveLength(1);
    expect(window.dataLayer).toHaveLength(2);
    expect(document.documentElement.dataset.orderlyAnalyticsStatus).toBe(
      "loading",
    );

    script?.dispatchEvent(new Event("load"));

    await expect(first).resolves.toEqual({
      status: "initialized",
      provider: "ga4",
    });
    await expect(second).resolves.toEqual({
      status: "initialized",
      provider: "ga4",
    });
    expect(document.documentElement.dataset.orderlyAnalyticsStatus).toBe(
      "initialized",
    );
  });

  it("pushes gtag commands as arguments objects that gtag.js can process", () => {
    initializeAnalytics(ga4Config);

    expect(window.dataLayer).toHaveLength(2);
    for (const entry of window.dataLayer ?? []) {
      // gtag.js silently ignores commands pushed as plain arrays
      expect(Array.isArray(entry)).toBe(false);
      expect(Object.prototype.toString.call(entry)).toBe("[object Arguments]");
    }

    window.gtag?.("event", "test_event");
    expect(window.dataLayer).toHaveLength(3);
    expect(Array.isArray(window.dataLayer?.[2])).toBe(false);
  });

  it("initializes supported Firebase Analytics with a named app", async () => {
    const result = await initializeAnalytics({
      version: 1,
      provider: "firebase",
      apiKey: "AIzaSyCe7LfodulsiuiHMnJIEGZbMjywgplmS04",
      projectId: "kongo-d7ffa",
      appId: "1:468973965344:web:245eeab3e660123ea02c45",
      measurementId: "G-6LKNEJCNW7",
    });

    expect(result).toEqual({ status: "initialized", provider: "firebase" });
    expect(providerMocks.firebaseIsSupported).toHaveBeenCalledOnce();
    expect(providerMocks.firebaseInitializeApp).toHaveBeenCalledWith(
      {
        apiKey: "AIzaSyCe7LfodulsiuiHMnJIEGZbMjywgplmS04",
        appId: "1:468973965344:web:245eeab3e660123ea02c45",
        measurementId: "G-6LKNEJCNW7",
        projectId: "kongo-d7ffa",
      },
      "orderly-analytics-v1",
    );
    expect(providerMocks.firebaseGetAnalytics).toHaveBeenCalledOnce();
  });

  it("skips Firebase Analytics when the browser is unsupported", async () => {
    providerMocks.firebaseIsSupported.mockResolvedValue(false);

    const result = await initializeAnalytics({
      version: 1,
      provider: "firebase",
      apiKey: "AIzaSyCe7LfodulsiuiHMnJIEGZbMjywgplmS04",
      projectId: "kongo-d7ffa",
      appId: "1:468973965344:web:245eeab3e660123ea02c45",
      measurementId: "G-6LKNEJCNW7",
    });

    expect(result).toEqual({ status: "unsupported", provider: "firebase" });
    expect(providerMocks.firebaseInitializeApp).not.toHaveBeenCalled();
    expect(providerMocks.firebaseGetAnalytics).not.toHaveBeenCalled();
  });

  it("uses the official Plausible tracker with automatic pageviews", async () => {
    await expect(
      initializeAnalytics({
        version: 1,
        provider: "plausible",
        domain: "trade.example.com",
      }),
    ).resolves.toEqual({ status: "initialized", provider: "plausible" });

    expect(providerMocks.plausibleInit).toHaveBeenCalledWith({
      domain: "trade.example.com",
      endpoint: "https://plausible.io/api/event",
      autoCapturePageviews: true,
      captureOnLocalhost: false,
    });
  });

  it("ignores the legacy raw script key and rejects invalid JSON", async () => {
    window.__RUNTIME_CONFIG__ = {
      VITE_ANALYTICS_SCRIPT:
        '<script src="https://evil.example/x.js"></script>',
      VITE_ANALYTICS_CONFIG: "not-json",
    };

    await expect(initializeAnalyticsFromRuntimeConfig()).resolves.toEqual({
      status: "invalid",
    });
    expect(document.querySelector("script[src*='evil.example']")).toBeNull();
    expect(document.documentElement.dataset.orderlyAnalyticsStatus).toBe(
      "invalid",
    );
  });

  it("treats an explicit empty runtime value as disabled", async () => {
    vi.stubEnv("VITE_ANALYTICS_CONFIG", JSON.stringify(ga4Config));
    window.__RUNTIME_CONFIG__ = { VITE_ANALYTICS_CONFIG: "" };

    await expect(initializeAnalyticsFromRuntimeConfig()).resolves.toEqual({
      status: "disabled",
    });
    expect(document.querySelector("#orderly-analytics-ga4")).toBeNull();
  });

  it("treats a JSON null runtime value as disabled", async () => {
    window.__RUNTIME_CONFIG__ = { VITE_ANALYTICS_CONFIG: "null" };

    await expect(initializeAnalyticsFromRuntimeConfig()).resolves.toEqual({
      status: "disabled",
    });
    expect(document.querySelector("#orderly-analytics-ga4")).toBeNull();
  });

  it("contains provider failures without rejecting startup", async () => {
    providerMocks.plausibleInit.mockImplementation(() => {
      throw new Error("blocked");
    });

    await expect(
      initializeAnalytics({
        version: 1,
        provider: "plausible",
        domain: "trade.example.com",
      }),
    ).resolves.toEqual({ status: "failed", provider: "plausible" });
    expect(document.documentElement.dataset.orderlyAnalyticsStatus).toBe(
      "failed",
    );
  });
});
