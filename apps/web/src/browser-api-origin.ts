const SUPPORTED_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

export function browserApiOrigin(configuredOrigin: string): string {
  return configuredOrigin;
}

export function browserCanonicalPageUrl(
  configuredOrigin: string,
): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return canonicalPageUrl(configuredOrigin, window.location.href);
}

export function canonicalPageUrl(
  configuredOrigin: string,
  pageUrl: string,
): string | null {
  try {
    const api = new URL(configuredOrigin);
    const page = new URL(pageUrl);
    if (
      api.protocol !== "http:" ||
      page.protocol !== "http:" ||
      !SUPPORTED_LOOPBACK_HOSTS.has(api.hostname) ||
      !SUPPORTED_LOOPBACK_HOSTS.has(page.hostname)
    ) {
      return null;
    }
    if (api.hostname === page.hostname) {
      return null;
    }
    page.hostname = api.hostname;
    return page.href;
  } catch {
    return null;
  }
}
