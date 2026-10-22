// Smoke test for the worker inbox provider (no browser, no signup).
import { createInbox, extractVerificationLink, decodeQuotedPrintable } from "../src/inbox/index.mjs";

const base = process.env.TH_WORKER_API_BASE || "https://simpamail.nmayanti3727572.workers.dev/api";
const domain = process.env.TH_WORKER_DOMAIN || "mimokota.site";

let fail = 0;
const ok = (cond, label, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fail++;
};

// 1. synthetic quoted-printable MIME -> verification link
const qp =
  "Content-Type: text/html; charset=utf-8\r\n" +
  "Content-Transfer-Encoding: quoted-printable\r\n\r\n" +
  "<a href=3D\"https://tokenharbor.ai/verify-email?token=3Dabc123DEF456\">Verify</a>";
const decoded = decodeQuotedPrintable(qp);
const link = extractVerificationLink(decoded);
ok(!!link && link.includes("verify-email?token="), "decode QP + extract link", link || "(null)");

// 2. provider factory resolution
const inbox = createInbox("worker", null, { workerApiBase: base, workerDomain: domain });
ok(inbox.provider === `worker:${domain}`, "factory -> worker reader", inbox.provider);

// 3. address generation on the catch-all domain
const created = await inbox.createInbox();
ok(/^farm[a-z0-9]{12}@/.test(created.address), "address generated", created.address);
ok(created.address.endsWith("@" + domain), "address on configured domain", created.address);

// 4. live list endpoint reachable + parseable
const res = await fetch(`${base}/emails`, { headers: { accept: "application/json" } });
const body = await res.json();
const rows = Array.isArray(body) ? body : body?.list || body?.emails || [];
ok(res.status === 200 && Array.isArray(rows), "live worker list endpoint", `HTTP ${res.status}, ${rows.length} rows`);

// 5. detail endpoint shape (id/raw present) when a row exists
if (rows.length) {
  const d = await fetch(`${base}/emails/${encodeURIComponent(rows[0].id)}`, { headers: { accept: "application/json" } });
  const j = await d.json();
  ok(d.status === 200 && typeof j.raw === "string", "detail endpoint returns raw MIME", `HTTP ${d.status}, raw ${(j.raw || "").length}B`);
  ok(Object.keys(j).includes("to"), "detail exposes recipient", String(j.to));
} else {
  console.log("SKIP  detail endpoint (store empty)");
}

// 6. timeout path throws instead of hanging
let threw = false;
const t0 = Date.now();
try {
  await inbox.waitForVerificationLink(created.address, { timeout: 6000 });
} catch {
  threw = true;
}
ok(threw && Date.now() - t0 < 20000, "timeout path throws cleanly", `${Date.now() - t0}ms`);

console.log(fail === 0 ? "\nALL PASS" : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
