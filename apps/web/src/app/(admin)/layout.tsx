import Link from "next/link";
import type { ReactNode } from "react";
import { requireAdmin } from "../../server/session.ts";
import { HeaderControls } from "../components.tsx";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return (
    <>
      <header className="top">
        <div className="top-inner">
          <Link className="brand" href="/incidents">
            <span className="mark" aria-hidden="true">
              ⌁
            </span>{" "}
            IncidentPulse
          </Link>
          <nav aria-label="Primary">
            <Link href="/incidents">Incidents</Link>
            <Link href="/evals">Evaluations</Link>
          </nav>
          <HeaderControls />
        </div>
      </header>
      <main className="shell">{children}</main>
    </>
  );
}
