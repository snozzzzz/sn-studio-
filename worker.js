// SN Studio — formulaire de contact
// POST /api/contact        : enregistre une demande et prévient par email
// GET  /api/contacts.csv?key=… : télécharge toutes les demandes (clé ADMIN_KEY)
// Tout le reste : fichiers du site (index.html, images, démos…)

import { EmailMessage } from "cloudflare:email";

const NOTIFY_TO = "snstudiocontact54@gmail.com";
const NOTIFY_FROM = "site@snstudio.fr";
const JSON_H = { "content-type": "application/json; charset=utf-8" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/contact") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleContact(request, env);
    }
    if (url.pathname === "/api/contacts.csv") return handleExport(url, env);
    return env.ASSETS.fetch(request);
  },
};

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT,
      business TEXT,
      message TEXT NOT NULL,
      marketing_ok INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
}

function clean(v, max) {
  return String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
}
function oneLine(v) {
  return v.replace(/[\r\n]+/g, " ");
}

async function handleContact(request, env) {
  let data;
  try {
    const type = request.headers.get("content-type") || "";
    data = type.includes("application/json")
      ? await request.json()
      : Object.fromEntries(await request.formData());
  } catch {
    return json({ ok: false, error: "format" }, 400);
  }

  // Champ piège invisible : rempli = robot
  if (clean(data.website, 200)) return json({ ok: true });

  const name = oneLine(clean(data.name, 120));
  const email = oneLine(clean(data.email, 200)).toLowerCase();
  const phone = oneLine(clean(data.phone, 40));
  const business = oneLine(clean(data.biz, 80));
  const message = clean(data.msg, 4000);
  const marketing = data.marketing === true || data.marketing === "on" || data.marketing === "1" ? 1 : 0;

  if (!name || !message) return json({ ok: false, error: "missing" }, 400);
  if (!/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(email)) return json({ ok: false, error: "email" }, 400);

  const createdAt = new Date().toISOString();
  await ensureTable(env);
  await env.DB.prepare(
    "INSERT INTO contacts (created_at, name, email, phone, business, message, marketing_ok) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(createdAt, name, email, phone, business, message, marketing).run();

  // Email de notification (si l'envoi échoue, la demande reste enregistrée)
  try {
    if (env.MAILER) {
      const body = [
        "Nouvelle demande depuis snstudio.fr",
        "",
        `Nom : ${name}`,
        `Email : ${email}`,
        `Téléphone : ${phone || "—"}`,
        `Activité : ${business || "—"}`,
        `Accepte les emails d'offres : ${marketing ? "oui" : "non"}`,
        "",
        "Message :",
        message,
        "",
        "Répondez directement à cet email pour lui écrire.",
      ].join("\r\n");
      const subject = `Nouvelle demande de devis — ${name}`;
      const raw = [
        `From: "Site SN Studio" <${NOTIFY_FROM}>`,
        `To: <${NOTIFY_TO}>`,
        `Reply-To: <${email}>`,
        `Subject: ${mimeWord(subject)}`,
        `Date: ${new Date().toUTCString()}`,
        `Message-ID: <${crypto.randomUUID()}@snstudio.fr>`,
        "MIME-Version: 1.0",
        "Content-Type: text/plain; charset=UTF-8",
        "Content-Transfer-Encoding: base64",
        "",
        b64(body).replace(/(.{76})/g, "$1\r\n"),
      ].join("\r\n");
      await env.MAILER.send(new EmailMessage(NOTIFY_FROM, NOTIFY_TO, raw));
    }
  } catch (e) {
    console.log("notification email failed", e && e.message);
  }

  return json({ ok: true });
}

async function handleExport(url, env) {
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Accès refusé", { status: 403 });
  await ensureTable(env);
  const { results } = await env.DB.prepare("SELECT * FROM contacts ORDER BY id DESC").all();
  const cols = ["id", "created_at", "name", "email", "phone", "business", "message", "marketing_ok"];
  const head = ["N°", "Date (UTC)", "Nom", "Email", "Téléphone", "Activité", "Message", "Accepte les offres"];
  const esc = (v) => {
    let s = String(v ?? "");
    if (/^[=+\-@]/.test(s)) s = "'" + s; // évite les formules dans Excel
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const lines = [head.map(esc).join(";")].concat(
    results.map((r) => cols.map((c) => (c === "marketing_ok" ? (r[c] ? "oui" : "non") : r[c])).map(esc).join(";"))
  );
  return new Response("﻿" + lines.join("\r\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="demandes-sn-studio.csv"',
      "cache-control": "no-store",
    },
  });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_H });
}
function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function mimeWord(str) {
  return "=?UTF-8?B?" + b64(str) + "?=";
}
