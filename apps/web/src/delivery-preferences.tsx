"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";

import {
  deliveryProviderLabel,
  parseDeliveryPreference,
  type DeliveryPreferenceView,
  type DeliveryProvider,
} from "./delivery-preferences-view";

type PreferenceScreen = "error" | "loading" | "ready" | "saved" | "saving";

export function DeliveryPreferences({
  apiOrigin,
}: {
  readonly apiOrigin: string;
}) {
  const [preference, setPreference] = useState<DeliveryPreferenceView | null>(
    null,
  );
  const [screen, setScreen] = useState<PreferenceScreen>("loading");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setScreen("loading");
    setMessage("");
    try {
      const response = await fetch(`${apiOrigin}/v1/delivery-preference`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error("Review reminder settings could not be loaded.");
      }
      const body = (await response.json()) as { readonly preference?: unknown };
      const parsed = parseDeliveryPreference(body.preference);
      if (parsed === null) {
        throw new Error("Review reminder settings are not available.");
      }
      setPreference(parsed);
      setScreen("ready");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Review reminder settings could not be loaded.",
      );
      setScreen("error");
    }
  }, [apiOrigin]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preference === null) {
      return;
    }
    setScreen("saving");
    setMessage("");
    try {
      const csrfResponse = await fetch(`${apiOrigin}/v1/csrf-token`, {
        credentials: "include",
      });
      if (!csrfResponse.ok) {
        throw new Error("Your session expired. Sign in again to save changes.");
      }
      const csrf = (await csrfResponse.json()) as {
        readonly csrfToken: string;
      };
      const response = await fetch(`${apiOrigin}/v1/delivery-preference`, {
        body: JSON.stringify({
          chosenLocalTime: preference.chosenLocalTime,
          provider: preference.provider,
          timeZone: preference.timeZone,
        }),
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-reflo-csrf": csrf.csrfToken,
        },
        method: "POST",
      });
      if (!response.ok) {
        throw new Error("Your reminder schedule could not be saved.");
      }
      const body = (await response.json().catch(() => null)) as {
        readonly preference?: unknown;
      } | null;
      const updated = parseDeliveryPreference(body?.preference);
      if (updated !== null) {
        setPreference(updated);
      }
      setMessage("Saved. Future review reminders will follow this schedule.");
      setScreen("saved");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Your reminder schedule could not be saved.",
      );
      setScreen("error");
    }
  }

  if (screen === "loading") {
    return <p role="status">Loading your reminder schedule…</p>;
  }
  if (preference === null) {
    return (
      <div className="preference-message" role="alert">
        <p>{message}</p>
        <button
          className="secondary-button"
          onClick={() => void load()}
          type="button"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <form className="preference-form" onSubmit={save}>
      <label htmlFor="delivery-provider">Send reviews by</label>
      <select
        disabled={screen === "saving"}
        id="delivery-provider"
        onChange={(event) =>
          setPreference({
            ...preference,
            provider: event.target.value as DeliveryProvider,
          })
        }
        value={preference.provider}
      >
        {preference.availableProviders.map((provider) => (
          <option key={provider} value={provider}>
            {deliveryProviderLabel(provider)}
          </option>
        ))}
      </select>
      <label htmlFor="delivery-time">Preferred time</label>
      <input
        disabled={screen === "saving"}
        id="delivery-time"
        onChange={(event) =>
          setPreference({ ...preference, chosenLocalTime: event.target.value })
        }
        required
        type="time"
        value={preference.chosenLocalTime}
      />
      <label htmlFor="delivery-time-zone">Time zone</label>
      <input
        autoComplete="off"
        disabled={screen === "saving"}
        id="delivery-time-zone"
        onChange={(event) =>
          setPreference({ ...preference, timeZone: event.target.value })
        }
        placeholder="America/Los_Angeles"
        required
        value={preference.timeZone}
      />
      <button disabled={screen === "saving"} type="submit">
        {screen === "saving" ? "Saving…" : "Save schedule"}
      </button>
      {message !== "" ? (
        <p
          className={
            screen === "error" ? "preference-error" : "preference-success"
          }
          role={screen === "error" ? "alert" : "status"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
