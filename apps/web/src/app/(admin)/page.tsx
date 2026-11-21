import { redirect } from "next/navigation";
import { requireAdmin } from "../../server/session.ts";

export default async function Home() {
  await requireAdmin();
  redirect("/incidents");
}
