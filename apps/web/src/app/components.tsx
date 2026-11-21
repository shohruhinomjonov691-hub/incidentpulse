"use client";

import type { StoredEvent } from "@incidentpulse/orchestrator/journal";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";

function ThemeButton() {
  const [theme, setTheme] = useState("");
  useEffect(() => {
    const saved = localStorage.getItem("incidentpulse-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
      setTheme(saved);
    }
  }, []);
  return (
    <button
      type="button"
      className="quiet"
      aria-label="Toggle color theme"
      onClick={() => {
        const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        localStorage.setItem("incidentpulse-theme", next);
        setTheme(next);
      }}
    >
      ◐
    </button>
  );
}

export function HeaderControls() {
  const [error, setError] = useState(false);
  return (
    <div className="controls">
      <ThemeButton />
      <button
        type="button"
        className="quiet"
        onClick={async () => {
          try {
            if (!(await fetch("/api/session", { method: "DELETE" })).ok) throw new Error();
            window.location.replace("/login");
          } catch {
            setError(true);
          }
        }}
      >
        Sign out
      </button>
      {error && <span role="alert">Sign-out failed.</span>}
    </div>
  );
}

export function LoginForm() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const password = new FormData(event.currentTarget).get("password");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (response.ok) window.location.replace("/incidents");
      else
        setError(
          response.status === 429
            ? "Too many attempts. Try again in 15 minutes."
            : response.status === 401
              ? "Incorrect password."
              : "Sign-in is unavailable.",
        );
    } catch {
      setError("Sign-in is unavailable.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="form" onSubmit={submit}>
      <label htmlFor="password">Admin password</label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
      />
      <button disabled={busy} type="submit">
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function eventTitle(event: StoredEvent) {
  const data = event.data as {
    node?: string;
    specialist?: string;
    tool?: string;
    ok?: boolean;
    status?: string;
  } | null;
  const human = (text: string) => text.replaceAll("_", " ");
  if (data?.node && (event.type === "node_start" || event.type === "node_end"))
    return `${human(data.node)}${data.specialist ? ` / ${data.specialist}` : ""} · ${event.type === "node_start" ? "started" : "finished"}`;
  if (event.type === "tool_call") return `Tool call${data?.tool ? ` · ${data.tool}` : ""}`;
  if (event.type === "recovery") return data?.ok ? "Recovery verified" : "Recovery check failed";
  if (event.type === "approval") return `Approval · ${data?.status ?? "updated"}`;
  if (event.type === "postmortem_ready") return "Postmortem ready";
  return human(event.type);
}

const refreshTypes = new Set([
  "approval",
  "execution",
  "recovery",
  "escalated",
  "postmortem_ready",
  "chat_cost",
]);

export function Timeline({ id }: { id: string }) {
  const router = useRouter();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const source = new EventSource(`/api/incidents/${encodeURIComponent(id)}/events`);
    let cursor = 0n;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (message) => {
      const entry = JSON.parse(message.data) as StoredEvent;
      const next = BigInt(entry.id);
      if (next <= cursor) return;
      cursor = next;
      setEvents((previous) => [...previous, entry]);
      const data = entry.data as { node?: string } | null;
      if (refreshTypes.has(entry.type) || (entry.type === "node_end" && data?.node === "close")) {
        clearTimeout(refresh);
        refresh = setTimeout(() => router.refresh(), 300);
      }
    };
    return () => {
      clearTimeout(refresh);
      source.close();
    };
  }, [id, router]);
  return (
    <section className="panel timeline">
      <div className="panel-title">
        <h2>Incident timeline</h2>
        <span role="status" className={live ? "live" : "muted"}>
          {live ? "● Live" : "Connecting…"}
        </span>
      </div>
      {events.length ? (
        <ol className="events">
          {[...events].reverse().map((event) => (
            <li key={event.id}>
              <time dateTime={event.at}>{event.at.slice(11, 19)} UTC</time>
              <strong>{eventTitle(event)}</strong>
              {!event.type.startsWith("node_") && (
                <details>
                  <summary>Event details</summary>
                  <pre>{JSON.stringify(event.data, null, 2)}</pre>
                </details>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty">Waiting for timeline events.</p>
      )}
    </section>
  );
}

export function ApprovalButtons({
  id,
  approve,
  reject,
}: {
  id: string;
  approve: string;
  reject: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const decide = async (token: string) => {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(id)}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (response.ok || response.status === 409) {
        setMessage(response.ok ? "Decision recorded." : "This approval is no longer pending.");
        router.refresh();
        return;
      }
      setMessage("Could not record the decision.");
    } catch {
      setMessage("Could not record the decision.");
    }
    setBusy(false);
  };
  return (
    <>
      <div className="actions">
        <button type="button" disabled={busy} onClick={() => void decide(approve)}>
          Approve
        </button>
        <button type="button" className="quiet" disabled={busy} onClick={() => void decide(reject)}>
          Reject
        </button>
      </div>
      {message && <p role="status">{message}</p>}
    </>
  );
}

export function IncidentChat({ id }: { id: string }) {
  const [messages, setMessages] = useState<{ key: number; question: string; answer: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/incidents/${encodeURIComponent(id)}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!response.ok || !response.body) {
        setError((await response.text()) || "Incident chat is unavailable.");
        return;
      }
      setMessages((previous) => [...previous, { key: previous.length, question, answer: "" }]);
      setQuestion("");
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let answer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          answer += value;
          const snapshot = answer;
          setMessages((previous) =>
            previous.map((item, index) =>
              index === previous.length - 1 ? { ...item, answer: snapshot } : item,
            ),
          );
        }
      } finally {
        reader.releaseLock();
      }
      if (!answer) setError("No answer was returned.");
    } catch {
      setError("Incident chat is unavailable.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="panel side-card">
      <p className="eyebrow">EVIDENCE ONLY</p>
      <h2>Ask this incident</h2>
      <p className="muted">
        Answers use this incident’s evidence. Up to 10 questions per incident.
      </p>
      {messages.map(({ key, question: asked, answer }) => (
        <div className="answer" key={key}>
          <strong>{asked}</strong>
          <p>{answer || "…"}</p>
        </div>
      ))}
      <form className="form" onSubmit={submit}>
        <label htmlFor="incident-question">Question</label>
        <textarea
          id="incident-question"
          placeholder="Which evidence supports the verdict?"
          maxLength={500}
          required
          value={question}
          onChange={(change) => setQuestion(change.target.value)}
        />
        <button type="submit" disabled={busy || !question.trim()}>
          {busy ? "Answering…" : "Ask question"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
    </section>
  );
}
