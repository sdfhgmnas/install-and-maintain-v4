// renewal-notify.mjs
// Fetches all renewals from Supabase, computes which ones are in
// Soon / Urgent / Overdue state, and sends ONE digest email via Resend.
// Skips email entirely if nothing needs attention — zero noise.
//
// Mirrors computeRenewalStatus() from the PWA so results match the UI exactly.

const SUPABASE_URL      = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL      = process.env.NOTIFY_EMAIL;
const APP_URL           = process.env.APP_URL || "";

const CYCLE_DAYS = 365;
const MS_PER_DAY = 86400000;

/* ----------------------------- helpers ----------------------------- */
function addDays(d, days) {
  const r = new Date(d);
  r.setDate(r.getDate() + days);
  return r;
}

function fmtDate(d) {
  const dt = new Date(d);
  const mon = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][dt.getMonth()];
  return `${String(dt.getDate()).padStart(2, "0")} ${mon} ${dt.getFullYear()}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

/* ----------------- status logic (mirrors app.js) ----------------- */
function computeStatus(renewal, today) {
  const created = new Date(renewal.created_date);
  if (isNaN(created.getTime())) return null;
  created.setHours(0, 0, 0, 0);

  const freeTrialDays = Number(renewal.free_trial_days) || 0;
  const effectiveStart = freeTrialDays > 0 ? addDays(created, freeTrialDays) : new Date(created);

  const paymentsByYear = {};
  (renewal.payments || []).forEach(p => { if (p.year) paymentsByYear[p.year] = p; });

  let cycleStart = new Date(effectiveStart);
  let year = 1;

  for (let i = 0; i < 50; i++) {
    const payment = paymentsByYear[year];
    let cycleEnd;

    if (payment) {
      cycleEnd = payment.cycleEndDate
        ? new Date(payment.cycleEndDate)
        : addDays(cycleStart, CYCLE_DAYS);
      cycleEnd.setHours(0, 0, 0, 0);
      cycleStart = new Date(cycleEnd);
      year += 1;
      continue;
    }

    // Unpaid year
    cycleEnd = addDays(cycleStart, CYCLE_DAYS);
    cycleEnd.setHours(0, 0, 0, 0);
    const daysUntilExpiry = Math.ceil((cycleEnd - today) / MS_PER_DAY);

    let status;
    if (daysUntilExpiry < 0) {
      const nextElapsed = Math.floor((today - cycleEnd) / MS_PER_DAY);
      status = nextElapsed > 0 ? "overdue" : "expired";
    } else if (daysUntilExpiry <= 7) status = "urgent";
    else if (daysUntilExpiry <= 15) status = "soon";
    else if (daysUntilExpiry <= 30) status = "upcoming";
    else status = "active";

    return { year, status, cycleEnd, daysUntilExpiry };
  }
  return null;
}

/* ------------------------- email template ------------------------- */
function section(title, color, icon, vehicles) {
  if (vehicles.length === 0) return "";
  const rows = vehicles.map(v => {
    const daysText = v._s.daysUntilExpiry < 0
      ? `<strong style="color:${color};">${Math.abs(v._s.daysUntilExpiry)}d overdue</strong>`
      : `<strong style="color:${color};">in ${v._s.daysUntilExpiry}d</strong>`;
    return `
      <tr>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;font-weight:700;font-family:'Courier New',monospace;">${esc(v.plate_number)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;color:#475569;font-size:12px;">${esc(v.vehicle_name || "—")}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">${fmtDate(v._s.cycleEnd)}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;">${daysText}</td>
        <td style="padding:8px 10px;border-bottom:1px solid #f1f5f9;text-align:center;color:#64748b;">Y${v._s.year}</td>
      </tr>`;
  }).join("");

  return `
    <h2 style="color:${color};margin:28px 0 12px;font-size:17px;border-bottom:2px solid ${color};padding-bottom:6px;">
      ${icon} ${title} <span style="font-weight:400;color:#64748b;">(${vehicles.length})</span>
    </h2>
    <table style="width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:6px;overflow:hidden;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.03em;">Plate</th>
          <th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.03em;">Vehicle</th>
          <th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.03em;">Expiry Date</th>
          <th style="text-align:left;padding:10px;border-bottom:2px solid #e2e8f0;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.03em;">Due</th>
          <th style="text-align:center;padding:10px;border-bottom:2px solid #e2e8f0;font-size:11px;text-transform:uppercase;color:#64748b;letter-spacing:0.03em;">Yr</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function buildEmail(alerts, totalAlerts, today) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>Renewal Alerts</title></head>
<body style="font-family:Arial,Helvetica,sans-serif;margin:0;padding:20px;background:#f1f5f9;color:#0f172a;">
<div style="max-width:720px;margin:0 auto;background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 10px rgba(0,0,0,0.06);">
  <h1 style="margin:0 0 6px;font-size:22px;color:#0f172a;letter-spacing:-0.01em;">🚨 Renewal Tracker Alert</h1>
  <p style="margin:0 0 20px;color:#475569;font-size:14px;">
    <strong>${totalAlerts}</strong> vehicle${totalAlerts !== 1 ? "s" : ""} need${totalAlerts === 1 ? "s" : ""} your attention · ${fmtDate(today)}
  </p>

  <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
    <div style="flex:1;min-width:140px;background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;">
      <div style="font-size:11px;color:#991b1b;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">🚨 Overdue</div>
      <div style="font-size:24px;font-weight:800;color:#dc2626;margin-top:3px;">${alerts.overdue.length}</div>
    </div>
    <div style="flex:1;min-width:140px;background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:10px 12px;">
      <div style="font-size:11px;color:#9a3412;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">⚠️ Urgent</div>
      <div style="font-size:24px;font-weight:800;color:#ea580c;margin-top:3px;">${alerts.urgent.length}</div>
    </div>
    <div style="flex:1;min-width:140px;background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:10px 12px;">
      <div style="font-size:11px;color:#854d0e;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;">🔔 Soon</div>
      <div style="font-size:24px;font-weight:800;color:#ca8a04;margin-top:3px;">${alerts.soon.length}</div>
    </div>
  </div>

  ${section("OVERDUE",           "#dc2626", "🚨", alerts.overdue)}
  ${section("URGENT (≤7 days)",  "#ea580c", "⚠️", alerts.urgent)}
  ${section("SOON (≤15 days)",   "#ca8a04", "🔔", alerts.soon)}

  ${APP_URL ? `
  <p style="margin-top:32px;text-align:center;">
    <a href="${APP_URL}" style="display:inline-block;background:#0891b2;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:0.02em;">
      🔗 Open Renewal Tracker
    </a>
  </p>` : ""}

  <p style="margin-top:34px;font-size:11px;color:#94a3b8;text-align:center;border-top:1px solid #e2e8f0;padding-top:14px;line-height:1.6;">
    Automated daily digest · TASR BharatNext · Generated ${today.toISOString()}<br>
    This email is skipped on days when no vehicle needs attention.
  </p>
</div>
</body></html>`;
}

/* ---------------------------- main ---------------------------- */
async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  console.log("Fetching renewals from Supabase...");
  const res = await fetch(`${SUPABASE_URL}/rest/v1/renewals?select=*&limit=5000`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase fetch failed: ${res.status} ${body}`);
  }
  const renewals = await res.json();
  console.log(`Loaded ${renewals.length} renewals`);

  const alerts = { overdue: [], urgent: [], soon: [] };
  for (const r of renewals) {
    const s = computeStatus(r, today);
    if (!s) continue;
    const row = { ...r, _s: s };
    if (s.status === "overdue" || s.status === "expired") alerts.overdue.push(row);
    else if (s.status === "urgent") alerts.urgent.push(row);
    else if (s.status === "soon")   alerts.soon.push(row);
  }

  // Sort — most urgent first within each bucket
  alerts.overdue.sort((a, b) => a._s.daysUntilExpiry - b._s.daysUntilExpiry);
  alerts.urgent.sort((a, b) => a._s.daysUntilExpiry - b._s.daysUntilExpiry);
  alerts.soon.sort((a, b) => a._s.daysUntilExpiry - b._s.daysUntilExpiry);

  const total = alerts.overdue.length + alerts.urgent.length + alerts.soon.length;
  console.log(`Overdue: ${alerts.overdue.length} · Urgent: ${alerts.urgent.length} · Soon: ${alerts.soon.length}`);

  if (total === 0) {
    console.log("✓ No vehicles need attention today. Email skipped.");
    return;
  }

  const html = buildEmail(alerts, total, today);
  const recipients = NOTIFY_EMAIL.split(",").map(e => e.trim()).filter(Boolean);

  console.log(`Sending digest to ${recipients.join(", ")}...`);
  const emailRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Renewal Tracker <onboarding@resend.dev>",
      to: recipients,
      subject: `🚨 Renewal Alert — ${total} vehicle${total !== 1 ? "s" : ""} need${total === 1 ? "s" : ""} attention`,
      html,
    }),
  });

  if (!emailRes.ok) {
    const body = await emailRes.text();
    throw new Error(`Resend API error: ${emailRes.status} ${body}`);
  }

  const sent = await emailRes.json();
  console.log(`✅ Email sent — Resend ID: ${sent.id}`);
}

main().catch((err) => {
  console.error("❌ Notification run failed:", err.message);
  process.exit(1);
});
