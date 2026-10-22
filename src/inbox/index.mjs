/**
 * Disposable-inbox readers.
 *
 * Token Harbor sends a click-to-verify email (a link, not a numeric code), so a
 * reader's job is to produce a fresh address and hand back the verification URL
 * found in the newest message.
 *
 * Two backends ship:
 *
 *   - `temp-email-dev` (default): drives the temp-email.dev web UI in a browser.
 *     The site is a Next.js server-action app (`generateTempEmail`,
 *     `getTempEmail`), so the page runtime — not a documented REST API — is the
 *     contract. We open the site, click **New Email** until we have an address,
 *     then expand the newest message and scrape the `tokenharbor.ai/verify-email`
 *     link. The address is generated on demand by the provider, so the caller
 *     cannot choose the local-part; we discover it from the page instead.
 *
 *   - `custom`: any provider exposing the classic temp-mail JSON REST shape
 *     (`GET {base}/domains`, `POST {base}/accounts`, `GET {base}/messages`),
 *     e.g. an instance of mail.tm / mail.gw. Selected with `--inbox-provider custom`
 *     and `--mail-base-url`.
 *
 * Both return the same shape: `{ address, provider }` from `createInbox`, and a
 * URL string from `waitForVerificationLink`.
 *
 * @module inbox
 */

import { randomBytes } from "node:crypto";
import { log } from "../utils/logger.mjs";
import { randomEmailLocal, randomPassword } from "../utils/random.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Regex for the Token Harbor verification link. */
export const VERIFY_LINK_RE =
  /https?:\/\/tokenharbor\.ai\/verify-email\?token=[A-Za-z0-9._~-]+/i;

/** Fallback shapes (Supabase `token_hash=…&type=signup`, alternate hosts). */
export const VERIFY_LINK_FALLBACK_RES = [
  /https?:\/\/tokenharbor\.ai\/verify-email\?[^\s"'<>]*token_hash=[A-Za-z0-9._~-]+[^\s"'<>]*/i,
  /https?:\/\/(?:auth\.)?tokenharbor\.ai\/auth\/[^\s"'<>]+/i,
];

/** Sender fragments that identify Token Harbor mail. */
export const SENDER_HINTS = ["tokenharbor", "token harbor", "verify@tokenharbor.ai"];

/** Pull the verification URL out of an arbitrary blob of text/markup. */
export function extractVerificationLink(blob) {
  if (!blob) return null;
  const s = String(blob);
  const m = s.match(VERIFY_LINK_RE);
  if (m) return m[0].replace(/&amp;$/i, "");
  for (const re of VERIFY_LINK_FALLBACK_RES) {
    const f = s.match(re);
    if (f) return f[0].replace(/&amp;$/i, "");
  }
  return null;
}

/**
 * Decode a quoted-printable MIME body to UTF-8 text (soft line breaks + `=XX`).
 * Worker inboxes hand back the raw RFC822 message, which is QP-encoded.
 */
export function decodeQuotedPrintable(input) {
  if (!input) return "";
  const joined = String(input).replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < joined.length; i++) {
    const c = joined[i];
    if (c === "=" && /[0-9A-Fa-f]{2}/.test(joined.slice(i + 1, i + 3))) {
      bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(joined.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/** Random lowercase-alphanumeric local-part tail. */
function randomLocal(len = 12) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const raw = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[raw[i] % alphabet.length];
  return out;
}

// ---------------------------------------------------------------------------
// Cloudflare Worker catch-all inbox (default)
// ---------------------------------------------------------------------------

/**
 * Generic reader for a catch-all inbox served by a Cloudflare Email Worker.
 *
 * The worker keeps every message it receives; the domain accepts ANY local-part,
 * so the caller invents its own address and filters the shared list by
 * recipient. Two calls are all it needs:
 *
 *   GET {apiBase}/emails      -> [{ id, from, to, receivedAt }]
 *   GET {apiBase}/emails/:id  -> { id, from, to, headers, raw, receivedAt }
 *
 * `raw` is the full MIME message (quoted-printable), which we decode before
 * scraping the verification link. Response shapes vary between worker builds,
 * so arrays under `list` / `emails` / `data` / `messages` are all accepted, and
 * a detail endpoint that is missing falls back to whatever the list row carries.
 *
 * Config (all optional, env overrides config.json):
 *   workerApiBase / TH_WORKER_API_BASE   base URL incl. `/api`
 *   workerDomain  / TH_WORKER_DOMAIN     catch-all domain for generated addresses
 *   workerToken   / TH_WORKER_TOKEN      bearer token, only if the worker asks
 *   mailBaseUrl   / mailboxDomain        aliases, so `--mail-base-url` works too
 *
 * @param {{workerApiBase?:string, workerDomain?:string, workerToken?:string,
 *          mailBaseUrl?:string, mailboxDomain?:string, fetchImpl?:typeof fetch}} [cfg]
 */
export function createWorkerReader(cfg = {}) {
  const env = process.env;
  const apiBase = String(
    cfg.workerApiBase || cfg.mailBaseUrl || env.TH_WORKER_API_BASE || DEFAULT_WORKER_API,
  ).replace(/\/+$/, "");
  const domain = String(
    cfg.workerDomain || cfg.mailboxDomain || env.TH_WORKER_DOMAIN || DEFAULT_WORKER_DOMAIN,
  ).replace(/^@/, "");
  const bearer = cfg.workerToken || env.TH_WORKER_TOKEN || "";
  const doFetch = cfg.fetchImpl || fetch;

  let address = null;
  let listPath = null; // resolved on first poll (probed once)

  async function api(path) {
    const headers = { accept: "application/json" };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const res = await doFetch(`${apiBase}${path}`, { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = new Error(
        `worker ${res.status} ${path}: ${typeof data === "string" ? data.slice(0, 160) : JSON.stringify(data).slice(0, 160)}`,
      );
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function rowsOf(data) {
    if (Array.isArray(data)) return data;
    for (const key of ["list", "emails", "messages", "items", "data", "results"]) {
      const v = data?.[key];
      if (Array.isArray(v)) return v;
      if (Array.isArray(v?.emails)) return v.emails;
    }
    return [];
  }

  /** Probe the list endpoint once — different worker builds mount it differently. */
  async function listEmails() {
    if (listPath) return rowsOf(await api(listPath));
    const candidates = ["/emails", "/messages", "/inbox", ""];
    let lastErr = null;
    for (const p of candidates) {
      try {
        const data = await api(p);
        const rows = rowsOf(data);
        if (rows.length || Array.isArray(data)) {
          listPath = p;
          return rows;
        }
        listPath = p;
        return rows;
      } catch (err) {
        lastErr = err;
        if (err.status !== 404) throw err;
      }
    }
    throw lastErr || new Error("worker inbox: no list endpoint found");
  }

  return {
    provider: `worker:${domain}`,

    async createInbox() {
      address = `farm${randomLocal(12)}@${domain}`;
      log.info(`inbox ready: ${address} (worker ${apiBase})`);
      return { address, provider: `worker:${domain}` };
    },

    /**
     * Poll the worker for a Token Harbor verification link addressed to us.
     * @param {string} _address
     * @param {{timeout?:number}} [opts]
     * @returns {Promise<string>}
     */
    async waitForVerificationLink(_address, opts = {}) {
      const timeout = opts.timeout ?? 180000;
      const deadline = Date.now() + timeout;
      const needle = String(address || _address || "").toLowerCase();
      const seen = new Set();

      while (Date.now() < deadline) {
        let rows;
        try {
          rows = await listEmails();
        } catch (err) {
          log.warn(`worker poll failed (${err.message}); retrying`);
          await sleep(4000);
          continue;
        }

        for (const m of rows) {
          const id = m?.id ?? m?.mail_id ?? m?.messageId;
          const to = String(m?.to ?? m?.recipient ?? m?.address ?? "").toLowerCase();
          if (needle && to && !to.includes(needle)) continue;

          const inline = `${m?.raw || ""} ${m?.body || ""} ${m?.text || ""} ${m?.html || ""}`;
          const inlineLink = extractVerificationLink(decodeQuotedPrintable(inline));
          if (inlineLink) return inlineLink;

          if (!id) continue;
          const key = String(id);
          if (seen.has(key)) continue;

          let full = null;
          try {
            full = await api(`${listPath || "/emails"}/${encodeURIComponent(key)}`);
          } catch {
            seen.add(key); // detail endpoint absent — nothing more to learn from this row
            continue;
          }
          seen.add(key);

          const blob = [
            decodeQuotedPrintable(full?.raw || ""),
            full?.text || "",
            full?.html || "",
            full?.body || "",
            JSON.stringify(full?.headers || {}),
            String(full?.subject || ""),
            String(full?.from || ""),
          ].join(" ");

          const link = extractVerificationLink(blob);
          if (link) {
            log.ok(`verification link found for ${needle}`);
            return link;
          }
        }
        await sleep(4000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },

    async close() {
      /* nothing to tear down: the worker keeps mail server-side */
    },
  };
}

/** Cloudflare Worker inbox defaults (override in config.json / env). */
export const DEFAULT_WORKER_API =
  process.env.TH_WORKER_API_BASE || "https://simpamail.nmayanti3727572.workers.dev/api";
export const DEFAULT_WORKER_DOMAIN = process.env.TH_WORKER_DOMAIN || "mimokota.site";

// ---------------------------------------------------------------------------
// temp-email.dev (browser-driven)
// ---------------------------------------------------------------------------

/**
 * Reader that drives the temp-email.dev UI. The inbox page must stay open for
 * the lifetime of the account so polling keeps working.
 *
 * @param {import('playwright').Page} page
 */
export function createTempEmailDevReader(page) {
  const ORIGIN = "https://www.temp-email.dev";

  async function currentAddress() {
    return page
      .evaluate(() => {
        const input = document.querySelector('input[type="text"]');
        const v = input ? input.value : "";
        return /@/.test(v) && v.includes(".") ? v.trim() : null;
      })
      .catch(() => null);
  }

  async function clickNewEmail() {
    const btn = page.getByRole("button", { name: /new email/i }).first();
    if (await btn.count()) {
      await btn.click({ timeout: 10000 }).catch(() => {});
      return true;
    }
    return false;
  }

  return {
    provider: "temp-email.dev",

    /**
     * Open the inbox and return the address the provider generated.
     * @returns {Promise<{address:string, provider:string}>}
     */
    async createInbox() {
      await page.goto(`${ORIGIN}/en`, { waitUntil: "domcontentloaded", timeout: 60000 });

      // The site auto-generates an address on first load; wait for it.
      let address = null;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        address = await currentAddress();
        if (address) break;
        await sleep(750);
      }

      // If auto-generation stalled, force one explicitly.
      if (!address) {
        await clickNewEmail();
        const retryDeadline = Date.now() + 20000;
        while (Date.now() < retryDeadline) {
          address = await currentAddress();
          if (address) break;
          await sleep(750);
        }
      }
      if (!address) throw new Error("temp-email.dev did not generate an address");
      log.info(`inbox ready: ${address}`);
      return { address, provider: "temp-email.dev" };
    },

    /**
     * Poll the inbox until a Token Harbor verification link appears.
     *
     * @param {string} _address
     * @param {{timeout?:number}} [opts]
     * @returns {Promise<string>} the verification URL
     */
    async waitForVerificationLink(_address, opts = {}) {
      const timeout = opts.timeout ?? 180000;
      const deadline = Date.now() + timeout;
      let expanded = false;
      let lastReload = Date.now();

      // temp-email.dev's own inbox poller can stall silently; nudge it with a
      // reload every 20s so newly delivered mail is actually rendered.
      while (Date.now() < deadline) {
        if (Date.now() - lastReload > 20000) {
          await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
          await sleep(4000);
          expanded = false;
          lastReload = Date.now();
        }

        const body = await page.evaluate(() => document.body.innerText).catch(() => "");

        const hasMail = SENDER_HINTS.some((h) => body.toLowerCase().includes(h));

        if (hasMail && !expanded) {
          // Expand the newest message row (the chevron / row itself).
          await page
            .evaluate(() => {
              const chev = [...document.querySelectorAll("svg")].find((s) =>
                (s.getAttribute("class") || "").includes("chevron"),
              );
              if (chev) (chev.closest("button") || chev).dispatchEvent(
                new MouseEvent("click", { bubbles: true }),
              );
            })
            .catch(() => {});
          await sleep(1500);
          expanded = true;
        }

        const link =
          extractVerificationLink(await page.evaluate(() => document.body.innerText).catch(() => "")) ||
          extractVerificationLink(await page.content().catch(() => ""));
        if (link) return link;

        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },

    async close() {
      /* page is owned by the caller */
    },
  };
}

// ---------------------------------------------------------------------------
// Classic temp-mail REST (mail.tm / mail.gw style)
// ---------------------------------------------------------------------------

/**
 * Reader for a classic temp-mail REST backend. No browser needed; uses global
 * `fetch` (Node 18+).
 *
 * @param {{baseUrl:string, domain?:string, fetchImpl?:typeof fetch}} cfg
 */
export function createRestReader(cfg) {
  const base = cfg.baseUrl.replace(/\/$/, "");
  const doFetch = cfg.fetchImpl || fetch;
  let token = null;
  let accountId = null;
  let address = null;

  async function api(path, init = {}) {
    const res = await doFetch(`${base}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(init.headers || {}),
      },
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      throw new Error(`mail api ${res.status} ${path}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }
    return data;
  }

  return {
    provider: "rest",

    async createInbox() {
      let domain = cfg.domain;
      if (!domain) {
        const domains = await api("/domains");
        const list = Array.isArray(domains) ? domains : domains?.["hydra:member"] || [];
        if (!list.length) throw new Error("mail api returned no domains");
        domain = list[0].domain;
      }
      const local = `${Math.random().toString(36).slice(2, 12)}`;
      address = `${local}@${domain}`;
      const password = Math.random().toString(36).slice(2, 14);

      await api("/accounts", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      const auth = await api("/token", {
        method: "POST",
        body: JSON.stringify({ address, password }),
      });
      token = auth.token || auth.access_token;
      accountId = auth.id;
      log.info(`inbox ready: ${address}`);
      return { address, provider: base };
    },

    async waitForVerificationLink(_address, opts = {}) {
      const timeout = opts.timeout ?? 180000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const data = await api("/messages");
        const list = Array.isArray(data) ? data : data?.["hydra:member"] || [];
        for (const msg of list) {
          const from = JSON.stringify(msg.from || msg.sender || "").toLowerCase();
          const subject = String(msg.subject || "").toLowerCase();
          const looksRight =
            from.includes("tokenharbor") || subject.includes("verify") || subject.includes("token harbor");
          const body = `${msg.intro || ""} ${msg.text || ""} ${JSON.stringify(msg.html || "")}`;
          const link = extractVerificationLink(body);
          if (link && looksRight) return link;
        }
        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },

    async close() {
      if (accountId) await api(`/accounts/${accountId}`, { method: "DELETE" }).catch(() => {});
    },
  };
}

/**
 * Reader for the tempmail.lol HTTP API — no browser needed.
 *   GET https://api.tempmail.lol/v2/inbox/create  -> { address, token }
 *   GET https://api.tempmail.lol/v2/inbox?token=T -> { emails: [{ subject, from, body, html_body }] }
 */
export function createTempMailLolReader(opts = {}) {
  const BASE = "https://api.tempmail.lol/v2";
  let address = null;
  let token = null;

  async function pollMessages() {
    const r = await fetch(`${BASE}/inbox?token=${token}`, { signal: AbortSignal.timeout(15000) });
    const j = await r.json();
    return Array.isArray(j?.emails) ? j.emails : [];
  }

  return {
    provider: "tempmail-lol",
    async createInbox() {
      const r = await fetch(`${BASE}/inbox/create`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      if (!j?.address) throw new Error(`tempmail.lol did not return an address: ${JSON.stringify(j).slice(0, 120)}`);
      address = j.address;
      token = j.token;
      log.info(`inbox ready: ${address} (tempmail.lol)`);
      return { address, provider: "tempmail-lol" };
    },
    async waitForVerificationLink(a, optsIn = {}) {
      const timeout = optsIn.timeout ?? 240000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const msgs = await pollMessages();
          for (const m of msgs) {
            const body = `${m.subject || ""} ${m.body || ""} ${m.html_body || ""} ${JSON.stringify(m)}`;
            const link = extractVerificationLink(body);
            if (link) return link;
          }
        } catch { /* transient — retry */ }
        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },
    async close() { /* nothing to clean up */ },
  };
}

/**
 * Reader for the mail.tm REST API (classic temp-mail, Hydra JSON).
 *   GET  {base}/domains -> hydra:member[{ domain }]
 *   POST {base}/accounts -> creates { @id, address }
 *   POST {base}/token   -> { token, id }
 *   GET  {base}/messages -> hydra:member[{ from:{address}, subject, text, intro, html }]
 */
export function createMailTmReader(opts = {}) {
  const base = (opts.baseUrl || "https://api.mail.tm").replace(/\/$/, "");
  let token = null;
  let accountId = null;
  let address = null;

  async function api(path, init = {}) {
    const headers = { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers || {}) };
    if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    let j;
    try { j = text ? JSON.parse(text) : null; } catch { j = text; }
    if (!r.ok && r.status !== 404) throw new Error(`mail.tm ${r.status} ${path}: ${typeof j === "string" ? j.slice(0, 120) : JSON.stringify(j).slice(0, 120)}`);
    return j;
  }

  return {
    provider: "mail-tm",
    async createInbox() {
      const domains = await api("/domains");
      const list = Array.isArray(domains) ? domains : domains?.["hydra:member"] || [];
      if (!list.length) throw new Error("mail.tm returned no domains");
      const domain = list[0].domain || list[0].name;
      const local = `${randomEmailLocal() || `u${Math.random().toString(36).slice(2, 10)}`}`;
      address = `${local}@${domain}`;
      const password = randomPassword(16);
      await api("/accounts", { method: "POST", body: JSON.stringify({ address, password }) });
      const auth = await api("/token", { method: "POST", body: JSON.stringify({ address, password }) });
      token = auth.token || auth.access_token;
      accountId = auth.id || auth["@id"] || null;
      log.info(`inbox ready: ${address} (mail.tm)`);
      return { address, provider: "mail-tm" };
    },
    async waitForVerificationLink(a, optsIn = {}) {
      const timeout = optsIn.timeout ?? 240000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const data = await api("/messages");
          const list = Array.isArray(data) ? data : data?.["hydra:member"] || [];
          for (const m of list) {
            const from = JSON.stringify(m.from || m.sender || "").toLowerCase();
            const subject = String(m.subject || "").toLowerCase();
            if (!(from.includes("tokenharbor") || subject.includes("verify") || subject.includes("token harbor"))) continue;
            const body = `${m.intro || ""} ${m.text || ""} ${JSON.stringify(m.html || "")}`;
            const link = extractVerificationLink(body);
            if (link) return link;
          }
        } catch { /* transient */ }
        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },
    async close() {
      if (accountId) await api(String(accountId).replace(/^\//, ""), { method: "DELETE" }).catch(() => {});
    },
  };
}

/**
 * Reader for the Guerrilla Mail HTTP API — no browser needed.
 *   GET /ajax.php?f=get_email_address            -> { email_addr, sid_token, ... }
 *   GET /ajax.php?f=get_email_list&seq=0&sid=..  -> { list: [{ mail_id, mail_from, subject, ... }] }
 *   GET /ajax.php?f=fetch_email&email_id=..&sid= -> { mail_body } (plain text body)
 */
export function createGuerrillaMailReader(opts = {}) {
  const BASE = "https://api.guerrillamail.com/ajax.php";
  let address = null;
  let sid = null;

  async function api(params) {
    const qs = new URLSearchParams(params);
    const r = await fetch(`${BASE}?${qs}`, { signal: AbortSignal.timeout(15000) });
    return r.json();
  }

  return {
    provider: "guerrillamail",
    async createInbox() {
      const j = await api({ f: "get_email_address" });
      if (!j?.email_addr) throw new Error(`guerrillamail did not return an address: ${JSON.stringify(j).slice(0, 120)}`);
      address = j.email_addr;
      sid = j.sid_token;
      log.info(`inbox ready: ${address} (guerrillamail)`);
      return { address, provider: "guerrillamail" };
    },
    async waitForVerificationLink(a, optsIn = {}) {
      const timeout = optsIn.timeout ?? 240000;
      const deadline = Date.now() + timeout;
      let seq = 0;
      while (Date.now() < deadline) {
        try {
          const j = await api({ f: "get_email_list", seq, sid_token: sid });
          const list = Array.isArray(j?.list) ? j.list : [];
          for (const m of list) {
            const detail = await api({ f: "fetch_email", email_id: m.mail_id, sid_token: sid }).catch(() => null);
            const body = `${detail?.mail_body || ""} ${detail?.mail_1body || ""} ${m.subject || ""} ${JSON.stringify(m)}`;
            const link = extractVerificationLink(body);
            if (link) return link;
          }
          seq = list.length;
        } catch { /* transient — retry */ }
        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },
    async close() { /* nothing to clean up */ },
  };
}

/**
 * Reader for SuperMail — HTTP API, no browser needed.
 *   GET  {base}/api/session                       -> { sessionId }
 *   POST {base}/api/inboxes  (x-session-id)       -> { address }
 *   GET  {base}/api/inboxes/{email}/messages      -> [ { subject, body, text, html } ]
 */
export function createSuperMailReader(opts = {}) {
  const BASE = opts.mailBaseUrl || "https://supermail.indevs.in";
  let sid = null;
  let address = null;

  async function jfetch(path, init = {}) {
    const headers = {
      "content-type": "application/json",
      ...(sid ? { "x-session-id": sid } : {}),
      ...(init.headers || {}),
    };
    const r = await fetch(`${BASE}${path}`, { ...init, headers, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    let j;
    try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    if (!r.ok) throw new Error(`supermail api ${r.status} ${path}: ${typeof j === "string" ? j : JSON.stringify(j).slice(0, 120)}`);
    return j;
  }

  return {
    provider: "supermail",
    async createInbox() {
      const s = await jfetch("/api/session");
      sid = String(s.sessionId || "");
      if (!sid) throw new Error(`supermail did not return a sessionId: ${JSON.stringify(s).slice(0, 120)}`);
      const created = await jfetch("/api/inboxes", {
        method: "POST",
        body: JSON.stringify({ domain: "supermail.indevs.in" }),
      });
      address = created.address;
      if (!address) throw new Error(`supermail did not return an address: ${JSON.stringify(created).slice(0, 120)}`);
      log.info(`inbox ready: ${address} (supermail)`);
      return { address, provider: "supermail" };
    },
    async waitForVerificationLink(a, optsIn = {}) {
      const timeout = optsIn.timeout ?? 240000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const msgs = await jfetch(`/api/inboxes/${encodeURIComponent(a)}/messages`);
          if (Array.isArray(msgs)) {
            for (const m of msgs) {
              const body = `${m.subject || ""} ${m.body || ""} ${m.text || ""} ${m.html || ""} ${JSON.stringify(m)}`;
              const link = extractVerificationLink(body);
              if (link) return link;
            }
          }
        } catch { /* transient — retry */ }
        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },
    async close() { /* nothing to clean up */ },
  };
}

/**
 * Reader for TempMailC private API (Kopeechka-2.0 style) — HTTP, no browser.
 * Trial/free key = 100 requests total (hemat: create 1 request + poll).
 *   GET {base}/api/v1/domains?code=X          -> {ok, domains:[...]}
 *   GET {base}/api/v1/inbox?email=A&code=X    -> {status:"empty"} | messages
 * Auth via header `Authorization: Bearer <code>`.
 * Address is manually constructed `<random>@<domain>` (no create endpoint).
 */
export function createTempMailCReader(opts = {}) {
  const BASE = opts.mailBaseUrl || "https://private.tempmailc.com";
  const CODE = opts.inboxToken || "";
  let address = null;
  let domain = "";

  if (!CODE) throw new Error("tempmailc requires inboxToken (trial code) — set worker.inboxToken di config.json");

  async function jfetch(path) {
    const r = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${CODE}` },
      signal: AbortSignal.timeout(15000),
    });
    const t = await r.text();
    let j;
    try { j = t ? JSON.parse(t) : null; } catch { j = t; }
    if (!r.ok) throw new Error(`tempmailc api ${r.status} ${path}: ${typeof j === "string" ? j : JSON.stringify(j).slice(0, 120)}`);
    return j;
  }

  return {
    provider: "tempmailc",
    async createInbox() {
      const dj = await jfetch(`/api/v1/domains?code=${CODE}`);
      const list = Array.isArray(dj?.domains) ? dj.domains : [];
      if (!list.length) throw new Error(`tempmailc returned no domains: ${JSON.stringify(dj).slice(0, 120)}`);
      domain = list[Math.floor(Math.random() * list.length)];
      const local = `${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36).slice(-4)}`;
      address = `${local}@${domain}`;
      log.info(`inbox ready: ${address} (tempmailc)`);
      return { address, provider: "tempmailc" };
    },
    async waitForVerificationLink(_a, optsIn = {}) {
      const timeout = optsIn.timeout ?? 240000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          const j = await jfetch(`/api/v1/inbox?email=${encodeURIComponent(address)}&code=${CODE}`);
          if (j && j.status && j.status !== "empty") {
            const body = `${JSON.stringify(j)}`;   // ambil semua field (html/text/subject/data)
            const link = extractVerificationLink(body);
            if (link) return link;
          }
        } catch { /* transient — retry */ }
        await sleep(3000);
      }
      throw new Error("timed out waiting for the Token Harbor verification email");
    },
    async close() { /* nothing to clean up */ },
  };
}

/**
 * Factory used by the orchestrator.
 *
 * @param {string} name  "worker" | "temp-email-dev" | "custom" | "tempmail-lol" | "mail-tm" | "guerrillamail" | "supermail" | "tempmailc" | "auto"
 * @param {import('playwright').Page|null} page
 * @param {object} [opts]
 */
export function createInbox(name, page, opts = {}) {
  if (name === "worker" || name === "cf-worker" || name === "simpamail" || name === "cloudflare") {
    return createWorkerReader(opts);
  }
  if (name === "custom" || name === "rest") {
    if (!opts.mailBaseUrl) throw new Error("--inbox-provider custom requires --mail-base-url");
    return createRestReader({ baseUrl: opts.mailBaseUrl, domain: opts.mailboxDomain });
  }
  if (name === "tempmail-lol") return createTempMailLolReader(opts);
  if (name === "mail-tm") return createMailTmReader(opts);
  if (name === "guerrillamail") return createGuerrillaMailReader(opts);
  if (name === "supermail") return createSuperMailReader(opts);
  if (name === "tempmailc") return createTempMailCReader(opts);
  if (name === "auto") {
    // Worker catch-all dulu (domain sendiri, paling andal); fallback rotasi HTTP
    // kalau domain worker belum di-set di config.
    const hasWorker = Boolean(opts.workerDomain || opts.mailboxDomain || process.env.TH_WORKER_DOMAIN);
    if (hasWorker) {
      log.info("inbox auto -> worker");
      return createWorkerReader(opts);
    }
    const r = Math.random();
    let pick;
    if (r < 0.35) pick = "tempmail-lol";
    else if (r < 0.6) pick = "mail-tm";
    else if (r < 0.8) pick = "guerrillamail";
    else pick = "supermail";
    log.info(`inbox auto -> ${pick}`);
    if (pick === "tempmail-lol") return createTempMailLolReader(opts);
    if (pick === "mail-tm") return createMailTmReader(opts);
    if (pick === "supermail") return createSuperMailReader(opts);
    return createGuerrillaMailReader(opts);
  }
  if (!page) throw new Error("temp-email.dev reader requires a browser page");
  return createTempEmailDevReader(page);
}
