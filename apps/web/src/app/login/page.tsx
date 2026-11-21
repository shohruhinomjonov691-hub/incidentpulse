import { redirect } from "next/navigation";
import { isAdmin } from "../../server/session.ts";
import { LoginForm } from "../components.tsx";

export default async function LoginPage() {
  if (await isAdmin()) redirect("/incidents");
  return (
    <main className="login">
      <div className="panel login-card">
        <div className="brand">
          <span className="mark" aria-hidden="true">
            ⌁
          </span>{" "}
          IncidentPulse
        </div>
        <p className="eyebrow">PRIVATE WORKSPACE</p>
        <h1>Sign in</h1>
        <p className="muted">Enter your admin password to open the incident dashboard.</p>
        <LoginForm />
      </div>
    </main>
  );
}
