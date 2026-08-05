"use client";

import { useEffect, useState } from "react";

import Link from "next/link";

import {
  browserApiOrigin,
  browserCanonicalPageUrl,
} from "./browser-api-origin";

export function AuthCallback({ apiOrigin }: { readonly apiOrigin: string }) {
  const resolvedApiOrigin = browserApiOrigin(apiOrigin);
  const canonicalPageUrl = browserCanonicalPageUrl(apiOrigin);
  const [status, setStatus] = useState<"working" | "failed">("working");

  useEffect(() => {
    if (canonicalPageUrl !== null) {
      window.location.replace(canonicalPageUrl);
      return;
    }
    const token = new URLSearchParams(window.location.search).get("token");
    if (token === null) {
      const timer = window.setTimeout(() => setStatus("failed"), 0);
      return () => window.clearTimeout(timer);
    }
    void fetch(`${resolvedApiOrigin}/v1/auth/magic-link/redeem`, {
      body: JSON.stringify({ token }),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
    }).then(
      (response) => {
        if (!response.ok) {
          setStatus("failed");
          return;
        }
        window.location.replace("/");
      },
      () => setStatus("failed"),
    );
  }, [canonicalPageUrl, resolvedApiOrigin]);

  return (
    <div className="center-state">
      <p className="eyebrow">Secure sign-in</p>
      <h1>
        {status === "working"
          ? "Opening your library…"
          : "This link is no longer valid."}
      </h1>
      <p className="lede">
        {status === "working"
          ? "We’re verifying your one-time link."
          : "Request a fresh link from the sign-in screen."}
      </p>
      {status === "failed" ? (
        <Link className="button-link" href="/">
          Back to sign in
        </Link>
      ) : (
        <span className="loading-ring" />
      )}
    </div>
  );
}
