// Lead form + hello@ inbound forwarding API for bathroomremodelingchicago.com
// Deployed as a Render web service. Keeps the Resend API key server-side.
import express from "express";
import { Resend } from "resend";

const {
  RESEND_API_KEY,
  RESEND_WEBHOOK_SECRET,
  LEAD_TO,
  FROM_EMAIL = "Bathroom Remodeling Chicago <hello@bathroomremodelingchicago.com>",
  ALLOWED_ORIGINS = "https://bathroomremodelingchicago.com,https://www.bathroomremodelingchicago.com",
  SITE_DOMAIN = "bathroomremodelingchicago.com",
  PORT = 10000,
} = process.env;

if (!RESEND_API_KEY) console.warn("WARN: RESEND_API_KEY is not set.");
if (!LEAD_TO) console.warn("WARN: LEAD_TO is not set — leads have nowhere to go.");

const resend = new Resend(RESEND_API_KEY);
const allowed = ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);

const app = express();
app.set("trust proxy", true);

// --- CORS (only for the browser-facing lead endpoint) ---
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const esc = (s = "") =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// --- Health check ---
app.get("/", (_req, res) => res.json({ ok: true, service: "brc-lead-api" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Lead form submissions (from the website) ---
app.post("/api/lead", express.json(), async (req, res) => {
  try {
    const { name, phone, email, project, message } = req.body || {};
    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: "Name and phone are required." });
    }

    const html = `
      <h2>New Quote Request — Bathroom Remodeling Chicago</h2>
      <table cellpadding="6" style="font-family:Arial,sans-serif;font-size:14px;border-collapse:collapse">
        <tr><td><strong>Name</strong></td><td>${esc(name)}</td></tr>
        <tr><td><strong>Phone</strong></td><td><a href="tel:${esc(phone)}">${esc(phone)}</a></td></tr>
        <tr><td><strong>Email</strong></td><td>${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : "—"}</td></tr>
        <tr><td><strong>Project</strong></td><td>${esc(project) || "—"}</td></tr>
        <tr><td valign="top"><strong>Message</strong></td><td>${esc(message) || "—"}</td></tr>
      </table>
      <p style="color:#888;font-size:12px">Submitted ${new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })} (Chicago)</p>
    `;

    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to: LEAD_TO,
      replyTo: email || undefined,
      subject: `New Quote Request: ${name}${project ? ` — ${project}` : ""}`,
      html,
    });

    if (error) {
      console.error("Resend send error:", error);
      return res.status(502).json({ ok: false, error: "Email delivery failed." });
    }
    console.log("Lead emailed:", data?.id);
    return res.json({ ok: true });
  } catch (err) {
    console.error("Lead handler error:", err);
    return res.status(500).json({ ok: false, error: "Server error." });
  }
});

// --- Inbound email: forward hello@bathroomremodelingchicago.com to LEAD_TO ---
app.post("/api/inbound", express.raw({ type: "*/*" }), async (req, res) => {
  try {
    const payload = req.body.toString("utf8");

    let event;
    if (RESEND_WEBHOOK_SECRET) {
      event = resend.webhooks.verify({
        payload,
        headers: {
          "svix-id": req.headers["svix-id"],
          "svix-timestamp": req.headers["svix-timestamp"],
          "svix-signature": req.headers["svix-signature"],
        },
        secret: RESEND_WEBHOOK_SECRET,
      });
    } else {
      event = JSON.parse(payload); // no secret configured yet
    }

    if (event.type !== "email.received") return res.status(200).send("ignored");

    // Only forward mail addressed to our domain (webhooks are account-wide)
    const recipients = [].concat(event.data?.to || []).join(",").toLowerCase();
    if (!recipients.includes(`@${SITE_DOMAIN}`)) return res.status(200).send("not our domain");

    // Webhook payload has metadata only — fetch the full message
    const { data: full, error } = await resend.emails.receiving.get(event.data.email_id);
    if (error) {
      console.error("receiving.get error:", error);
      return res.status(200).send("fetch failed"); // 200 so Resend doesn't hammer retries
    }

    const origFrom = full.from || event.data.from || "unknown sender";
    await resend.emails.send({
      from: FROM_EMAIL,
      to: LEAD_TO,
      replyTo: origFrom,
      subject: `[hello@] ${full.subject || "(no subject)"}`,
      html:
        (full.html || `<pre>${esc(full.text || "")}</pre>`) +
        `<hr><p style="color:#888;font-size:12px">Forwarded from ${esc(origFrom)} → ${esc(recipients)}</p>`,
      text: full.text || undefined,
    });

    console.log("Forwarded inbound from", origFrom);
    return res.status(200).send("forwarded");
  } catch (err) {
    console.error("Inbound handler error:", err);
    return res.status(200).send("error"); // avoid webhook retry storms
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`brc-lead-api listening on ${PORT}`));
