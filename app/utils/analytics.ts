import { AnalyticsConfigV1, AnalyticsConfigV1Schema } from "./analytics-config";
import { getRuntimeConfig } from "./runtime-config";

export const ANALYTICS_CONFIG_KEY = "VITE_ANALYTICS_CONFIG";
export const ANALYTICS_LOADER_VERSION = "1.0.0";

const GA4_SCRIPT_ID = "orderly-analytics-ga4";
const FIREBASE_APP_NAME = "orderly-analytics-v1";
const PLAUSIBLE_ENDPOINT = "https://plausible.io/api/event";

type Gtag = (...args: unknown[]) => void;

export type AnalyticsInitializationResult = {
  status: "disabled" | "failed" | "initialized" | "invalid" | "unsupported";
  provider?: AnalyticsConfigV1["provider"];
};

type AnalyticsLoaderStatus =
  | AnalyticsInitializationResult["status"]
  | "loading";

type AnalyticsRuntimeState = {
  configFingerprint: string;
  loaderVersion: string;
  promise: Promise<AnalyticsInitializationResult>;
  provider: AnalyticsConfigV1["provider"];
};

declare global {
  interface Window {
    __ORDERLY_ANALYTICS_RUNTIME__?: AnalyticsRuntimeState;
    dataLayer?: unknown[];
    gtag?: Gtag;
  }
}

function markLoader(
  status: AnalyticsLoaderStatus,
  provider?: AnalyticsConfigV1["provider"],
) {
  document.documentElement.dataset.orderlyAnalyticsLoaderVersion =
    ANALYTICS_LOADER_VERSION;
  document.documentElement.dataset.orderlyAnalyticsStatus = status;

  if (provider) {
    document.documentElement.dataset.orderlyAnalyticsProvider = provider;
  } else {
    delete document.documentElement.dataset.orderlyAnalyticsProvider;
  }
}

function loadExternalScript(script: HTMLScriptElement): Promise<void> {
  return new Promise((resolve, reject) => {
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error(`Failed to load analytics script: ${script.src}`)),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

async function initializeGA4(
  config: Extract<AnalyticsConfigV1, { provider: "ga4" }>,
) {
  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    // gtag.js only processes dataLayer commands pushed as arguments objects;
    // pushing a plain array makes every command (js/config/event) silently ignored.
    window.dataLayer?.push(
      // eslint-disable-next-line prefer-rest-params -- gtag.js requires the arguments object
      arguments,
    );
  };

  const script = document.createElement("script");
  script.id = GA4_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(
    config.measurementId,
  )}`;
  script.dataset.orderlyAnalyticsLoaderVersion = ANALYTICS_LOADER_VERSION;
  script.dataset.orderlyAnalyticsProvider = config.provider;

  window.gtag("js", new Date());
  window.gtag("config", config.measurementId);

  await loadExternalScript(script);
}

async function initializeFirebase(
  config: Extract<AnalyticsConfigV1, { provider: "firebase" }>,
): Promise<"initialized" | "unsupported"> {
  const [{ getApp, getApps, initializeApp }, { getAnalytics, isSupported }] =
    await Promise.all([import("firebase/app"), import("firebase/analytics")]);

  if (!(await isSupported())) return "unsupported";

  const existingApp = getApps().find((app) => app.name === FIREBASE_APP_NAME);
  const app =
    existingApp ??
    initializeApp(
      {
        apiKey: config.apiKey,
        appId: config.appId,
        measurementId: config.measurementId,
        projectId: config.projectId,
      },
      FIREBASE_APP_NAME,
    );

  getAnalytics(existingApp ? getApp(FIREBASE_APP_NAME) : app);
  return "initialized";
}

async function initializePlausible(
  config: Extract<AnalyticsConfigV1, { provider: "plausible" }>,
) {
  const { init } = await import("@plausible-analytics/tracker/plausible.js");

  init({
    domain: config.domain,
    endpoint: PLAUSIBLE_ENDPOINT,
    autoCapturePageviews: true,
    captureOnLocalhost: false,
  });
}

async function initializeProvider(
  config: AnalyticsConfigV1,
): Promise<AnalyticsInitializationResult> {
  switch (config.provider) {
    case "ga4":
      await initializeGA4(config);
      return { status: "initialized", provider: config.provider };
    case "firebase": {
      const status = await initializeFirebase(config);
      return { status, provider: config.provider };
    }
    case "plausible":
      await initializePlausible(config);
      return { status: "initialized", provider: config.provider };
  }
}

export function initializeAnalytics(
  input: unknown,
): Promise<AnalyticsInitializationResult> {
  const parsed = AnalyticsConfigV1Schema.safeParse(input);
  if (!parsed.success) {
    console.warn("Analytics config validation failed", parsed.error.issues);
    markLoader("invalid");
    return Promise.resolve({ status: "invalid" });
  }

  const config = parsed.data;
  const configFingerprint = JSON.stringify(config);
  const existingState = window.__ORDERLY_ANALYTICS_RUNTIME__;

  if (existingState) {
    if (existingState.configFingerprint !== configFingerprint) {
      console.warn(
        "Analytics is already initialized; ignoring a different runtime config",
      );
    }
    return existingState.promise;
  }

  markLoader("loading", config.provider);

  const promise = initializeProvider(config).catch((error: unknown) => {
    console.warn("Analytics initialization failed", error);
    markLoader("failed", config.provider);
    return {
      status: "failed" as const,
      provider: config.provider,
    };
  });

  window.__ORDERLY_ANALYTICS_RUNTIME__ = {
    configFingerprint,
    loaderVersion: ANALYTICS_LOADER_VERSION,
    promise,
    provider: config.provider,
  };

  void promise.then((result) => markLoader(result.status, result.provider));
  return promise;
}

export function initializeAnalyticsFromRuntimeConfig(): Promise<AnalyticsInitializationResult> {
  markLoader("disabled");

  const runtimeConfig = window.__RUNTIME_CONFIG__;
  const rawConfig =
    runtimeConfig &&
    Object.prototype.hasOwnProperty.call(runtimeConfig, ANALYTICS_CONFIG_KEY)
      ? runtimeConfig[ANALYTICS_CONFIG_KEY]
      : getRuntimeConfig(ANALYTICS_CONFIG_KEY);
  if (!rawConfig) return Promise.resolve({ status: "disabled" });

  let parsedJSON: unknown;
  try {
    parsedJSON = JSON.parse(rawConfig);
  } catch (error) {
    console.warn("Analytics config is not valid JSON", error);
    markLoader("invalid");
    return Promise.resolve({ status: "invalid" });
  }

  if (parsedJSON === null) return Promise.resolve({ status: "disabled" });

  return initializeAnalytics(parsedJSON);
}
