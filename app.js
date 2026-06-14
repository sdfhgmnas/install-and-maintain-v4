const app = document.getElementById("app");
const modalOverlay = document.getElementById("modalOverlay");
const modal = document.getElementById("modal");
const toast = document.getElementById("toast");

// App version — bump on every meaningful edit so deployed copies are
// visibly identifiable.
const APP_VERSION = "3.2.3";

const USERS = {
  akash:   { password: "akash",     role: "akash" },
  admin:   { password: "password1", role: "admin" },
  abhinav: { password: "abhinav",   role: "stock-manager" },
};

// Default page permissions (used as fallback when DB doesn't have a row)
const DEFAULT_PERMISSIONS = {
  admin:   { displayName: "Admin",                   isAdmin: true,  allowedPages: ["dashboard","installations","repairs","pending","sim-db","stock","accounts","timeline","deletions","user-access"] },
  akash:   { displayName: "Akash (Field Worker)",    isAdmin: false, allowedPages: ["akash-home","install","repair"] },
  abhinav: { displayName: "Abhinav (Stock Manager)", isAdmin: false, allowedPages: ["stock"] },
};

// Loaded from DB on app init; falls back to DEFAULT_PERMISSIONS
let userPermissions = {};

function getUserPerms(username) {
  return userPermissions[username] || DEFAULT_PERMISSIONS[username] || null;
}

function userCanAccess(pageKey) {
  if (!currentUser) return false;
  const perms = getUserPerms(currentUser);
  if (!perms) return false;
  if (perms.isAdmin) return true; // admin gets everything
  return (perms.allowedPages || []).includes(pageKey);
}

function landingPageFor(username) {
  const perms = getUserPerms(username);
  if (!perms) return "login";
  if (username === "akash") return "akash-home";
  if (username === "admin") return "dashboard";
  // Other users: land on their first allowed page
  return (perms.allowedPages || [])[0] || "login";
}

function validateLogin(username, password) {
  const user = USERS[username.toLowerCase().trim()];
  if (!user || user.password !== password) return null;
  return user.role;
}

let currentUser = null;
let view = "login";
let searchQuery = "";
let pendingFilter = "all";
let showCompleted = false;
let timelineQuery = "";
let simDbQuery = "";
let stockQuery = "";
let stockCategoryFilter = "all";
let installations = [];
let maintenanceRecords = [];
let sims = [];
let stockItems = [];
let stockTransactions = [];
let stockCategories = [];
let suppliers = [];
let deletionLog = [];
let accountsProjects = [];
let accountsTransactions = [];
let simsTableReady = true;
let stockItemsTableReady = true;
let stockTxTableReady = true;
let stockCategoriesTableReady = true;
let suppliersTableReady = true;
let deletionLogTableReady = true;
let isLoadingData = false;
let lastSyncedAt = null;

// Realtime state
let realtimeChannel = null;
let realtimeStatus = "idle";
let refreshTimer = null;

/* ============================================================
   DELETION REASON PROMPT + AUDIT
   Every destructive action goes through promptForReason and is
   logged to deletion_log (visible to admin in the Deletions tab).
   ============================================================ */

function promptForReason({ title, message, confirmLabel = "Delete", placeholder = "Why are you deleting this?" }) {
  return new Promise((resolve) => {
    modal.innerHTML = `
      <h3>🗑️ ${escapeHtml(title)}</h3>
      ${message ? `<p class="modal-desc">${message}</p>` : ""}
      <div class="field">
        <label for="delReason">Reason for deletion <span class="required">*</span></label>
        <input type="text" id="delReason" autocomplete="off" placeholder="${escapeHtml(placeholder)}" />
        <p class="hint">This reason will be saved permanently in the audit log so admin can review what was deleted and why.</p>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-danger" data-act="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `;
    modalOverlay.classList.remove("hidden");
    const input = modal.querySelector("#delReason");
    input?.focus();
    const done = (val) => {
      closeModal();
      resolve(val);
    };
    modal.querySelector('[data-act="cancel"]').onclick = () => done(null);
    modal.querySelector('[data-act="confirm"]').onclick = () => {
      const v = (input.value || "").trim();
      if (!v) {
        showToast("Please enter a reason for deletion.", true);
        return;
      }
      done(v);
    };
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") done(null);
      if (e.key === "Enter") {
        e.preventDefault();
        modal.querySelector('[data-act="confirm"]').click();
      }
    });
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) done(null);
    };
  });
}

async function auditDeletion({ entityType, entityId, entityLabel, reason, snapshot }) {
  if (!deletionLogTableReady) return;
  try {
    await insertDeletionLog({
      entityType,
      entityId,
      entityLabel,
      reason,
      deletedBy: currentUser || "unknown",
      snapshot,
    });
  } catch (err) {
    console.warn("Audit log write failed:", err);
  }
}


/* ============================================================
   STOCK AUTO-CONSUME
   When an installation / repair uses an identifier (IMEI, SIM
   secondary, sensor number, MAC), decrement the matching
   stock_items row by 1 and log a transaction linked to the
   installation so the Stock page shows "Used in VEHICLE-X" with
   no manual ± Adjust needed.
   ============================================================ */

async function consumeStockFor(identifiers, link) {
  if (!stockItemsTableReady) return;
  const seen = new Set();
  const candidates = [];

  function matchBy(predicate) {
    for (const it of loadStockItems()) {
      if (seen.has(it.id)) continue;
      if (it.quantity <= 0) continue;
      if (predicate(it)) {
        candidates.push(it);
        seen.add(it.id);
      }
    }
  }

  if (identifiers.imei) {
    const v = String(identifiers.imei).trim().toLowerCase();
    matchBy((it) => (it.metadata?.imei || "").toLowerCase() === v);
  }
  if (identifiers.simSecondary) {
    const v = String(identifiers.simSecondary).trim().toLowerCase();
    matchBy(
      (it) =>
        (it.metadata?.secondary || "").toLowerCase() === v ||
        (it.metadata?.primary || "").toLowerCase() === v
    );
  }
  if (identifiers.sensorNo) {
    const v = String(identifiers.sensorNo).trim().toLowerCase();
    matchBy((it) => (it.metadata?.sensorNo || "").toLowerCase() === v);
  }
  if (identifiers.macId) {
    const v = String(identifiers.macId).trim().toLowerCase();
    matchBy((it) => (it.metadata?.macId || "").toLowerCase() === v);
  }

  for (const it of candidates) {
    const next = it.quantity - 1;
    try {
      await updateStockItem({ ...it, quantity: next });
      if (stockTxTableReady) {
        try {
          await insertStockTransaction({
            stockItemId: it.id,
            installationId: link.installationId || null,
            maintenanceRecordId: link.maintenanceRecordId || null,
            vehicleNo: link.vehicleNo || null,
            delta: -1,
            resultingQuantity: next,
            note: link.note || "Auto-consumed on installation",
            createdBy: currentUser || "akash",
            itemNameSnapshot: it.name + (it.category ? ` (${it.category})` : ""),
          });
        } catch (txErr) {
          console.warn("Auto-consume transaction record failed:", txErr);
        }
      }
    } catch (err) {
      console.warn("Auto-consume failed for stock item", it.name, err);
    }
  }
}

/**
 * Reverse all consumption recorded against an installation or maintenance
 * record. For each negative-delta transaction whose stock_item still exists,
 * increment that item's quantity back and log a positive "restored" tx.
 */
async function restoreStockFor({ installationId, maintenanceRecordId, reason }) {
  if (!stockItemsTableReady || !stockTxTableReady) return;
  const txs = loadStockTransactions().filter((t) => {
    if (maintenanceRecordId) return t.maintenanceRecordId === maintenanceRecordId && t.delta < 0;
    if (installationId) return t.installationId === installationId && t.delta < 0;
    return false;
  });
  for (const tx of txs) {
    if (!tx.stockItemId) continue; // item was deleted; no row to restore on
    const item = loadStockItems().find((i) => i.id === tx.stockItemId);
    if (!item) continue;
    const restoreQty = Math.abs(tx.delta);
    const next = item.quantity + restoreQty;
    try {
      await updateStockItem({ ...item, quantity: next });
      await insertStockTransaction({
        stockItemId: item.id,
        installationId: installationId || null,
        maintenanceRecordId: maintenanceRecordId || null,
        vehicleNo: tx.vehicleNo,
        delta: +restoreQty,
        resultingQuantity: next,
        note: reason || "Restored after deletion",
        createdBy: currentUser || "system",
        itemNameSnapshot: item.name + (item.category ? ` (${item.category})` : ""),
      });
    } catch (err) {
      console.warn("Stock restore failed for", item.name, err);
    }
  }
}

/* ============================================================
   TASK ENGINE
   Each repair entry generates one or more follow-up tasks based
   on what work was done. Each task is a simple to-do with a single
   Complete button (done / not done).
   ============================================================ */

const TASK_TYPES = {
  update_portal: { label: "Update on GPS Portal", icon: "🖥️", category: "Portal" },
  update_vehicle_number: { label: "Check and update vehicle number", icon: "🚛", category: "Portal" },
  update_sim_primary: { label: "Update primary number for SIM", icon: "📞", category: "Portal" },
  deactivate_sim: { label: "Deactivate the old SIM", icon: "📵", category: "SIM" },
  repair_device: { label: "Send device for repair", icon: "🔧", category: "Service" },
  repair_sensor: { label: "Send sensor for repair", icon: "🛰️", category: "Service" },
};

const TASK_ORDER = [
  "update_portal",
  "update_vehicle_number",
  "deactivate_sim",
  "update_sim_primary",
  "repair_device",
  "repair_sensor",
];

function taskFlow(type) {
  return TASK_TYPES[type];
}

function isTaskDone(task) {
  return Boolean(task.done);
}

function makeTask(type, meta = {}) {
  return {
    id: generateId(),
    type,
    done: false,
    completedAt: null,
    completedBy: null,
    ...meta,
  };
}

// Decide which follow-up tasks an entry generates.
function taskTypesForRepair({ simChange, deviceChange, deviceOutForRepair, sensorOutForRepair }) {
  const types = new Set();
  if (simChange) {
    types.add("update_portal");
    types.add("deactivate_sim");
  }
  if (deviceChange) {
    types.add("update_portal");
    types.add("repair_device");
  }
  if (deviceOutForRepair) types.add("repair_device");
  if (sensorOutForRepair) types.add("repair_sensor");
  return TASK_ORDER.filter((t) => types.has(t));
}

// Build tasks. If `unknownSimSecondary` is provided, also append an
// `update_sim_primary` task carrying the ICCID that needs a primary.
function buildTasksForRepair(opts) {
  const tasks = taskTypesForRepair(opts).map((type) => makeTask(type));
  if (opts.unknownSimSecondary) {
    tasks.push(
      makeTask("update_sim_primary", {
        simSecondary: String(opts.unknownSimSecondary).trim(),
      })
    );
  }
  return tasks;
}

// Old records (created before the task engine) derive their tasks from
// legacy boolean flags so they appear in Pending Actions correctly.
function getTasks(record) {
  if (Array.isArray(record.tasks) && record.tasks.length) return record.tasks;
  const types = taskTypesForRepair({
    simChange: record.simChange,
    deviceChange: record.deviceChange,
    deviceOutForRepair: record.deviceOutForRepair,
    sensorOutForRepair: record.sensorOutForRepair,
  });
  return types.map((type) => ({
    id: `legacy-${record.id}-${type}`,
    type,
    done: type === "deactivate_sim" ? Boolean(record.simDeactivated) : false,
    completedAt: type === "deactivate_sim" && record.simDeactivated ? record.simDeactivatedAt : null,
    completedBy: null,
  }));
}

// Install-level tasks: every new installation must be marked as
// "Updated on GPS Portal" and "Vehicle number checked & updated" by admin.
const INSTALL_TASK_TYPES = ["update_portal", "update_vehicle_number"];

function defaultInstallTasks() {
  const t = {};
  for (const type of INSTALL_TASK_TYPES) {
    t[type] = { completedAt: null, completedBy: null };
  }
  return t;
}

// Get a normalised tasks object for an installation. Legacy rows that
// predate the feature (tasks=null/{}) get default tasks generated lazily.
function getInstallTasks(inst) {
  if (inst.tasks && typeof inst.tasks === "object" && Object.keys(inst.tasks).length) {
    return inst.tasks;
  }
  return defaultInstallTasks();
}

function isInstallTaskDone(inst, type) {
  const t = getInstallTasks(inst)[type];
  return Boolean(t && t.completedAt);
}

function getPendingActionRows() {
  const rows = [];
  // Maintenance / repair tasks
  for (const record of loadMaintenance()) {
    for (const task of getTasks(record)) {
      if (!isTaskDone(task)) rows.push({ kind: "maintenance", record, task });
    }
  }
  // Install-level tasks (Update on Portal + Vehicle number check)
  for (const inst of loadInstallations()) {
    const tasks = getInstallTasks(inst);
    for (const type of INSTALL_TASK_TYPES) {
      const t = tasks[type];
      if (!t || !t.completedAt) {
        rows.push({
          kind: "installation",
          install: inst,
          task: { id: `inst-${inst.id}-${type}`, type, done: false, completedAt: null },
        });
      }
    }
  }
  rows.sort((a, b) => {
    const aDate = new Date(a.kind === "installation" ? a.install.createdAt : a.record.createdAt);
    const bDate = new Date(b.kind === "installation" ? b.install.createdAt : b.record.createdAt);
    return bDate - aDate;
  });
  return rows;
}

function taskDetail(record, task, kind) {
  const mono = (v) => `<span class="mono">${escapeHtml(v || "—")}</span>`;
  // Install-level tasks: the record IS the install (pseudo-record).
  if (kind === "installation") {
    const inst = loadInstallations().find((i) => i.id === record.id);
    switch (task.type) {
      case "update_portal":
        return `New install — IMEI ${mono(inst ? getCurrentImei(inst) : "")} · SIM ${mono(inst ? resolvePrimarySim(getCurrentSim(inst)) : "")}`;
      case "update_vehicle_number":
        return `Vehicle entered: ${mono(record.vehicleNo)} — confirm correctness with portal`;
      default:
        return "—";
    }
  }
  // Maintenance tasks
  const inst = loadInstallations().find((i) => i.id === record.installationId);
  switch (task.type) {
    case "update_portal": {
      const bits = [];
      if (record.simChange && record.newSimNo) bits.push(`SIM → ${mono(resolvePrimarySim(record.newSimNo))}`);
      if (record.deviceChange && record.newImei) bits.push(`IMEI → ${mono(record.newImei)}`);
      return bits.length ? bits.join(" · ") : "—";
    }
    case "deactivate_sim":
      return `Old SIM ${mono(resolvePrimarySim(record.oldSimNo))}`;
    case "repair_device":
      return `Device ${mono(record.oldImei || record.imei || (inst ? getCurrentImei(inst) : ""))}`;
    case "repair_sensor":
      return `Sensor ${mono(inst ? inst.sensorNo : "")}`;
    case "update_sim_primary":
      return `ICCID ${mono(task.simSecondary)} — primary not yet known`;
    default:
      return "—";
  }
}

// Look up the resolved PRIMARY number for a given value. If the value is
// a known secondary (ICCID), return the primary from the sims table;
// otherwise return the value as-is. Returns "" if nothing found.
function resolvePrimarySim(value) {
  if (!value) return "";
  const v = String(value).trim();
  if (!v) return "";
  // If value is already a primary (matches a sim's primaryNumber), return it.
  const byPri = sims.find((s) => (s.primaryNumber || "").toLowerCase() === v.toLowerCase());
  if (byPri) return byPri.primaryNumber;
  // If value is a secondary (ICCID), look up the primary.
  const bySec = sims.find((s) => (s.secondaryNumber || "").toLowerCase() === v.toLowerCase());
  if (bySec && bySec.primaryNumber) return bySec.primaryNumber;
  // Unknown — return original.
  return v;
}

function taskDetailText(record, task) {
  const inst = loadInstallations().find((i) => i.id === record.installationId);
  switch (task.type) {
    case "update_portal": {
      const bits = [];
      if (record.simChange && record.newSimNo) bits.push(`SIM -> ${record.newSimNo}`);
      if (record.deviceChange && record.newImei) bits.push(`IMEI -> ${record.newImei}`);
      return bits.join(" | ") || "-";
    }
    case "deactivate_sim":
      return `Old SIM ${record.oldSimNo || "-"}`;
    case "repair_device":
      return `Device ${record.oldImei || record.imei || (inst ? getCurrentImei(inst) : "") || "-"}`;
    case "repair_sensor":
      return `Sensor ${inst ? inst.sensorNo : "-"}`;
    case "update_sim_primary":
      return `ICCID ${task.simSecondary || "-"} | primary not yet known`;
    default:
      return "-";
  }
}

// Export the actions currently in view (respects category filter and the
// Show-completed toggle) to an Excel report.
function exportPendingActions() {
  const rows = [["Vehicle", "Task", "Detail", "Status", "Remark", "Remark By", "Entry Date", "Completed At", "Completed By"]];
  for (const record of loadMaintenance()) {
    for (const task of getTasks(record)) {
      const flow = taskFlow(task.type);
      if (!flow) continue;
      if (pendingFilter !== "all" && flow.category !== pendingFilter) continue;
      const done = isTaskDone(task);
      if (done && !showCompleted) continue;
      rows.push([
        record.vehicleNo,
        flow.label,
        taskDetailText(record, task),
        done ? "Completed" : "Pending",
        task.remark || "",
        task.remarkBy || "",
        formatDateTime(record.createdAt),
        task.completedAt ? formatDateTime(task.completedAt) : "",
        task.completedBy || "",
      ]);
    }
  }
  if (rows.length === 1) {
    showToast("Nothing to export for this filter.", true);
    return;
  }
  const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
  downloadXlsx(`pending-actions_${stamp}.xlsx`, rows, "Pending actions", ["Detail"]);
  showToast(`Exported ${rows.length - 1} action${rows.length - 1 === 1 ? "" : "s"}.`);
}

async function completeTask(recordId, taskId) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;

  // Materialize tasks onto the record (so legacy-derived records persist correctly).
  const tasks = getTasks(record).map((t) => ({ ...t }));
  const task = tasks.find((t) => t.id === taskId);
  if (!task || task.done) return;

  // Special path: update_sim_primary needs the admin to enter the primary
  // number before the task can be marked complete.
  if (task.type === "update_sim_primary") {
    await completeUpdateSimPrimary(record, task);
    return;
  }

  const flow = taskFlow(task.type);
  const now = new Date().toISOString();
  task.done = true;
  task.completedAt = now;
  task.completedBy = currentUser || "admin";
  record.tasks = tasks;

  // Side effect: completing "Deactivate the SIM" also closes the old SIM entry.
  const inst = loadInstallations().find((i) => i.id === record.installationId);
  let instTouched = false;
  if (task.type === "deactivate_sim") {
    record.simDeactivated = true;
    record.simDeactivatedAt = now;
    record.simDeactivationPending = false;
    if (inst && record.oldSimNo) {
      inst.simHistory.forEach((s) => {
        if (s.value === record.oldSimNo && s.pendingDeactivation) {
          s.active = false;
          s.pendingDeactivation = false;
          s.deactivatedAt = now;
        }
      });
      instTouched = true;
    }
  }

  // Optimistic: update the UI immediately so the row clears right away.
  render();

  try {
    await updateMaintenanceRecord(record);
    if (instTouched) await updateInstallation(inst);
    showToast(`Completed: ${flow.label}`);
    await refreshAllData();
    render();
  } catch (err) {
    // Roll back the optimistic change.
    task.done = false;
    task.completedAt = null;
    if (task.type === "deactivate_sim") {
      record.simDeactivated = false;
      record.simDeactivatedAt = null;
      record.simDeactivationPending = true;
    }
    render();
    const raw = err.message || "";
    const schemaIssue = /tasks|secondary_sim|column|schema cache|could not find/i.test(raw);
    showToast(
      schemaIssue
        ? "Save failed: run pending-actions-migration.sql in Supabase SQL Editor first (the 'tasks' column is missing)."
        : raw || "Failed to update task.",
      true
    );
  }
}

async function completeUpdateSimPrimary(record, task) {
  const secondary = task.simSecondary || "";

  // Open a small modal to capture the primary number from the admin.
  const primary = await promptForSimPrimary(secondary);
  if (primary == null) return; // cancelled

  const trimmedPrimary = String(primary).trim();
  if (!trimmedPrimary) {
    showToast("Primary number cannot be empty.", true);
    return;
  }

  renderLoading("Saving SIM primary number...");
  try {
    // 1. Update / insert the sim row.
    await upsertSim({ primaryNumber: trimmedPrimary, secondaryNumber: secondary });

    // 2. Patch any installation simHistory entries that were stored as the
    //    secondary placeholder — bump them to the now-known primary.
    const lowerSec = secondary.toLowerCase();
    const installsToFix = loadInstallations().filter((inst) =>
      inst.simHistory.some((s) => (s.value || "").toLowerCase() === lowerSec)
    );
    for (const inst of installsToFix) {
      const updated = {
        ...inst,
        simHistory: inst.simHistory.map((s) =>
          (s.value || "").toLowerCase() === lowerSec ? { ...s, value: trimmedPrimary } : s
        ),
      };
      try {
        await updateInstallation(updated);
      } catch (err) {
        console.warn("Failed to update simHistory for", inst.vehicleNo, err);
      }
    }

    // 3. Mark the task as done.
    const tasks = getTasks(record).map((t) => ({ ...t }));
    const me = tasks.find((t) => t.id === task.id);
    if (me) {
      me.done = true;
      me.completedAt = new Date().toISOString();
      me.completedBy = currentUser || "admin";
    }
    record.tasks = tasks;
    await updateMaintenanceRecord(record);

    await refreshAllData();
    render();
    showToast(`Primary number saved for SIM ${secondary}.`);
  } catch (err) {
    console.error(err);
    await refreshAllData();
    render();
    const msg = err.message || "";
    if (err.code === SIMS_TABLE_MISSING || /sims/i.test(msg)) {
      showToast("Run sims-table-migration.sql in Supabase first.", true);
    } else {
      showToast(msg || "Failed to save primary.", true);
    }
  }
}

function promptForSimPrimary(secondary) {
  return new Promise((resolve) => {
    modal.innerHTML = `
      <h3>📞 Update primary number</h3>
      <p class="modal-desc">Enter the 13-digit primary SIM number that pairs with this ICCID. The SIM database will be updated and the pending task closed.</p>
      <div class="field" style="margin-top:0.5rem;">
        <label>Secondary (ICCID)</label>
        <input type="text" value="${escapeHtml(secondary)}" readonly class="mono" />
      </div>
      <div class="field">
        <label for="simPrimaryInput">Primary number</label>
        <input type="text" id="simPrimaryInput" inputmode="numeric" autocomplete="off" placeholder="e.g. 5753200309565" class="mono" />
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
        <button type="button" class="btn btn-primary" data-act="save">Save</button>
      </div>
    `;
    modalOverlay.classList.remove("hidden");

    const input = modal.querySelector("#simPrimaryInput");
    input?.focus();

    const done = (value) => {
      closeModal();
      resolve(value);
    };

    modal.querySelector('[data-act="cancel"]').onclick = () => done(null);
    modal.querySelector('[data-act="save"]').onclick = () => done(input.value);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") done(input.value);
      if (e.key === "Escape") done(null);
    });
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) done(null);
    };
  });
}

async function undoTask(recordId, taskId) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;

  const tasks = getTasks(record).map((t) => ({ ...t }));
  const task = tasks.find((t) => t.id === taskId);
  if (!task || !task.done) return;

  const flow = taskFlow(task.type);
  task.done = false;
  task.completedAt = null;
  task.completedBy = null;
  record.tasks = tasks;

  const inst = loadInstallations().find((i) => i.id === record.installationId);
  let instTouched = false;
  if (task.type === "deactivate_sim") {
    record.simDeactivated = false;
    record.simDeactivatedAt = null;
    record.simDeactivationPending = true;
    if (inst && record.oldSimNo) {
      inst.simHistory.forEach((s) => {
        if (s.value === record.oldSimNo && !s.active && s.deactivatedAt) {
          s.active = true;
          s.pendingDeactivation = true;
          delete s.deactivatedAt;
        }
      });
      instTouched = true;
    }
  }

  render();

  try {
    await updateMaintenanceRecord(record);
    if (instTouched) await updateInstallation(inst);
    showToast(`Reopened: ${flow.label}`);
    await refreshAllData();
    render();
  } catch (err) {
    task.done = true;
    render();
    showToast(err.message || "Failed to undo task.", true);
  }
}

/* ============================================================
   INSTALL-LEVEL TASK HANDLERS
   For install tasks (Update on Portal, Check vehicle no), the
   completion state lives on installations.tasks[type].
   Task ID format: `inst-{installId}-{taskType}`.
   ============================================================ */

function parseInstallTaskId(taskId) {
  // "inst-{installId}-{taskType}" — installId is a UUID with hyphens,
  // so we identify the type by suffix.
  for (const type of INSTALL_TASK_TYPES) {
    const suffix = `-${type}`;
    if (taskId.endsWith(suffix) && taskId.startsWith("inst-")) {
      const installId = taskId.slice("inst-".length, -suffix.length);
      return { installId, type };
    }
  }
  return null;
}

async function completeInstallTask(installId, taskId) {
  const parsed = parseInstallTaskId(taskId);
  if (!parsed) return;
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  const now = new Date().toISOString();
  const tasks = { ...getInstallTasks(inst) };
  tasks[parsed.type] = {
    ...(tasks[parsed.type] || {}),
    completedAt: now,
    completedBy: currentUser || "admin",
  };
  inst.tasks = tasks;
  render();
  try {
    await updateInstallation(inst);
    showToast("Marked complete.");
    await refreshAllData();
    render();
  } catch (err) {
    showToast(err.message || "Failed to mark complete.", true);
    await refreshAllData();
    render();
  }
}

async function undoInstallTask(installId, taskId) {
  const parsed = parseInstallTaskId(taskId);
  if (!parsed) return;
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  const tasks = { ...getInstallTasks(inst) };
  tasks[parsed.type] = {
    ...(tasks[parsed.type] || {}),
    completedAt: null,
    completedBy: null,
  };
  inst.tasks = tasks;
  render();
  try {
    await updateInstallation(inst);
    showToast("Reopened.");
    await refreshAllData();
    render();
  } catch (err) {
    showToast(err.message || "Failed to undo.", true);
    await refreshAllData();
    render();
  }
}

function openInstallRemarkEditor(installId, taskId) {
  const parsed = parseInstallTaskId(taskId);
  if (!parsed) return;
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  const tasks = getInstallTasks(inst);
  const existing = tasks[parsed.type] || {};
  const flow = taskFlow(parsed.type);

  modal.innerHTML = `
    <h3>📝 Remark for "${escapeHtml(flow.label)}"</h3>
    <p class="modal-desc">Vehicle <strong class="mono">${escapeHtml(inst.vehicleNo)}</strong></p>
    <div class="field">
      <label for="remarkText">Remark</label>
      <input type="text" id="remarkText" autocomplete="off" value="${escapeHtml(existing.remark || "")}" placeholder="Add a note..." />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => { if (e.target === modalOverlay) closeModal(); };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const text = modal.querySelector("#remarkText").value.trim();
    closeModal();
    const newTasks = { ...tasks };
    newTasks[parsed.type] = {
      ...(tasks[parsed.type] || {}),
      remark: text || null,
      remarkBy: text ? (currentUser || "admin") : null,
      remarkAt: text ? new Date().toISOString() : null,
    };
    inst.tasks = newTasks;
    try {
      await updateInstallation(inst);
      await refreshAllData();
      render();
      showToast(text ? "Remark saved." : "Remark cleared.");
    } catch (err) {
      showToast(err.message || "Save failed.", true);
    }
  };
}

async function setTaskRemark(recordId, taskId, remarkText) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;

  const tasks = getTasks(record).map((t) => ({ ...t }));
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;

  const prev = { remark: task.remark || null, remarkBy: task.remarkBy || null, remarkAt: task.remarkAt || null };
  const trimmed = (remarkText || "").trim();
  const now = new Date().toISOString();
  task.remark = trimmed || null;
  task.remarkBy = trimmed ? currentUser || "admin" : null;
  task.remarkAt = trimmed ? now : null;
  record.tasks = tasks;

  render();

  try {
    await updateMaintenanceRecord(record);
    showToast(trimmed ? "Remark saved." : "Remark cleared.");
    await refreshAllData();
    render();
  } catch (err) {
    task.remark = prev.remark;
    task.remarkBy = prev.remarkBy;
    task.remarkAt = prev.remarkAt;
    render();
    const raw = err.message || "";
    const schemaIssue = /tasks|column|schema cache|could not find/i.test(raw);
    showToast(
      schemaIssue
        ? "Save failed: run pending-actions-migration.sql in Supabase SQL Editor first."
        : raw || "Failed to save remark.",
      true
    );
  }
}

function openRemarkEditor(recordId, taskId) {
  const record = loadMaintenance().find((m) => m.id === recordId);
  if (!record) return;
  const task = getTasks(record).find((t) => t.id === taskId);
  if (!task) return;
  const flow = taskFlow(task.type);
  const current = task.remark || "";

  showModal(
    `
    <h3>Remark</h3>
    <p class="modal-desc">
      <strong>${escapeHtml(flow.label)}</strong> · ${escapeHtml(record.vehicleNo)}
    </p>
    <div class="field full-width">
      <label for="remarkText">Note</label>
      <textarea id="remarkText" rows="3" placeholder="e.g. SIM not received yet, vendor pickup on 02 Jun, etc.">${escapeHtml(current)}</textarea>
    </div>
    <div class="modal-actions">
      ${current ? `<button type="button" class="btn btn-outline modal-clear">Clear remark</button>` : ""}
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-primary modal-confirm">Save</button>
    </div>
    `,
    async () => {
      const text = document.getElementById("remarkText").value;
      await setTaskRemark(recordId, taskId, text);
      return true;
    }
  );

  modal.querySelector(".modal-clear")?.addEventListener("click", async () => {
    closeModal();
    await setTaskRemark(recordId, taskId, "");
  });

  // Focus the textarea for quick entry.
  setTimeout(() => document.getElementById("remarkText")?.focus(), 30);
}

/* ============================================================ */

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label} timed out after ${Math.round(ms / 1000)}s — Supabase may be paused or unreachable.`
          )
        ),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function refreshAllData() {
  isLoadingData = true;
  updateLiveBadge();
  try {
    installations = await withTimeout(fetchInstallations(), 20000, "Fetch installations");
    maintenanceRecords = await withTimeout(fetchMaintenanceRecords(), 20000, "Fetch repair records");
    try {
      sims = await withTimeout(fetchSims(), 20000, "Fetch SIMs");
      simsTableReady = true;
    } catch (err) {
      if (err.code === SIMS_TABLE_MISSING) {
        console.warn("sims table missing — features that depend on it will be limited until migration runs.");
        sims = [];
        simsTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      stockItems = await withTimeout(fetchStockItems(), 20000, "Fetch stock items");
      stockItemsTableReady = true;
    } catch (err) {
      if (err.code === STOCK_ITEMS_TABLE_MISSING) {
        console.warn("stock_items table missing — Stock page will show migration prompt until migration runs.");
        stockItems = [];
        stockItemsTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      stockTransactions = await withTimeout(fetchStockTransactions(), 20000, "Fetch stock transactions");
      stockTxTableReady = true;
    } catch (err) {
      if (err.code === STOCK_TX_TABLE_MISSING) {
        console.warn("stock_transactions table missing — stock usage history features disabled until migration runs.");
        stockTransactions = [];
        stockTxTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      stockCategories = await withTimeout(fetchStockCategories(), 20000, "Fetch stock categories");
      stockCategoriesTableReady = true;
    } catch (err) {
      if (err.code === STOCK_CATEGORIES_TABLE_MISSING) {
        console.warn("stock_categories table missing — using preset list until migration runs.");
        stockCategories = [];
        stockCategoriesTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      suppliers = await withTimeout(fetchSuppliers(), 20000, "Fetch suppliers");
      suppliersTableReady = true;
    } catch (err) {
      if (err.code === SUPPLIERS_TABLE_MISSING) {
        console.warn("suppliers table missing — Supplier dropdown will be empty until migration runs.");
        suppliers = [];
        suppliersTableReady = false;
      } else {
        throw err;
      }
    }
    try {
      deletionLog = await withTimeout(fetchDeletionLog(200), 20000, "Fetch deletion log");
      deletionLogTableReady = true;
    } catch (err) {
      if (err.code === DELETION_LOG_TABLE_MISSING) {
        console.warn("deletion_log table missing — deletions will not be audited until migration runs.");
        deletionLog = [];
        deletionLogTableReady = false;
      } else {
        throw err;
      }
    }
    // Accounts module — soft-fail if migration hasn't been run yet
    try {
      accountsProjects = await withTimeout(fetchAccountsProjects(), 20000, "Fetch accounts projects");
    } catch (err) {
      console.warn("accounts_projects table missing or unreadable", err?.message || err);
      accountsProjects = [];
    }
    try {
      accountsTransactions = await withTimeout(fetchAccountsTransactions(), 20000, "Fetch accounts transactions");
    } catch (err) {
      console.warn("accounts_transactions table missing or unreadable", err?.message || err);
      accountsTransactions = [];
    }
    // User permissions — soft-fail to default if migration not run
    try {
      const perms = await withTimeout(fetchUserPermissions(), 20000, "Fetch user permissions");
      userPermissions = {};
      perms.forEach((p) => { userPermissions[p.username] = p; });
    } catch (err) {
      console.warn("user_permissions table missing — using DEFAULT_PERMISSIONS", err?.message || err);
      userPermissions = { ...DEFAULT_PERMISSIONS };
    }
    lastSyncedAt = new Date();
  } finally {
    isLoadingData = false;
    updateLiveBadge();
  }
}

function loadInstallations() {
  return installations;
}

function loadMaintenance() {
  return maintenanceRecords;
}

function loadSims() {
  return sims;
}

function loadStockItems() {
  return stockItems;
}

function loadStockTransactions() {
  return stockTransactions;
}

function loadSuppliers() {
  return suppliers;
}

function getSupplierOptions() {
  const fromDb = suppliers.map((s) => s.name);
  const fromItems = stockItems.map((i) => i.supplier).filter(Boolean);
  return Array.from(new Set([...fromDb, ...fromItems])).sort();
}

// Return recent transactions for one stock item, newest first.
function getStockItemTransactions(stockItemId) {
  return stockTransactions
    .filter((t) => t.stockItemId === stockItemId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Return up to N recent vehicles where this item was used (delta < 0),
// deduped, newest first.
function getRecentVehiclesForItem(stockItemId, n = 3) {
  const txs = getStockItemTransactions(stockItemId);
  const seen = new Set();
  const result = [];
  for (const t of txs) {
    if (t.delta >= 0) continue;
    if (!t.vehicleNo) continue;
    if (seen.has(t.vehicleNo)) continue;
    seen.add(t.vehicleNo);
    result.push({ vehicleNo: t.vehicleNo, delta: t.delta, at: t.createdAt });
    if (result.length >= n) break;
  }
  return result;
}

// Find installations currently using a stock item's identifier (live cross-ref).
// Useful so the Stock page shows "Used in VEHICLE-X" even if the item was
// added to stock AFTER the installation happened (no transaction record).
function getInstallationUsesForItem(item) {
  if (!item || !item.metadata) return [];
  const kind = categoryKind(item.category);
  const m = item.metadata;
  const out = [];

  for (const inst of loadInstallations()) {
    let matched = false;
    if (kind === "gps" && m.imei) {
      const v = String(m.imei).toLowerCase();
      const curImei = (getCurrentImei(inst) || "").toLowerCase();
      if (curImei === v) {
        matched = true;
      } else if (inst.imeiHistory.some((h) => (h.value || "").toLowerCase() === v)) {
        matched = true;
      }
    } else if (kind === "sim" && (m.secondary || m.primary)) {
      const sec = (m.secondary || "").toLowerCase();
      const pri = (m.primary || "").toLowerCase();
      for (const h of inst.simHistory) {
        const v = (h.value || "").toLowerCase();
        const sv = (h.secondaryValue || "").toLowerCase();
        if ((sec && (v === sec || sv === sec)) || (pri && v === pri)) {
          matched = true;
          break;
        }
      }
    } else if (kind === "sensor" && (m.sensorNo || m.macId)) {
      const sn = (m.sensorNo || "").toLowerCase();
      const mac = (m.macId || "").toLowerCase();
      if (
        (sn && (inst.sensorNo || "").toLowerCase() === sn) ||
        (mac && (inst.macId || "").toLowerCase() === mac)
      ) {
        matched = true;
      }
    }
    if (matched) out.push({ vehicleNo: inst.vehicleNo });
  }
  return out;
}

// Merge live installation uses + recent transaction uses, deduped.
function getStockUses(item, n = 3) {
  const seen = new Set();
  const result = [];
  for (const u of getInstallationUsesForItem(item)) {
    if (seen.has(u.vehicleNo)) continue;
    seen.add(u.vehicleNo);
    result.push({ vehicleNo: u.vehicleNo, source: "install" });
    if (result.length >= n) return result;
  }
  for (const u of getRecentVehiclesForItem(item.id, n)) {
    if (seen.has(u.vehicleNo)) continue;
    seen.add(u.vehicleNo);
    result.push({ vehicleNo: u.vehicleNo, source: "tx", delta: u.delta, at: u.at });
    if (result.length >= n) return result;
  }
  return result;
}

/* Find a SIM by either primary or secondary number. */
function findSimByValue(value) {
  if (!value) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  return (
    sims.find((s) => (s.secondaryNumber || "").toLowerCase() === v) ||
    sims.find((s) => (s.primaryNumber || "").toLowerCase() === v) ||
    null
  );
}

function findSimBySecondary(secondary) {
  if (!secondary) return null;
  const v = String(secondary).trim().toLowerCase();
  return sims.find((s) => (s.secondaryNumber || "").toLowerCase() === v) || null;
}

function findSimByPrimary(primary) {
  if (!primary) return null;
  const v = String(primary).trim().toLowerCase();
  return sims.find((s) => (s.primaryNumber || "").toLowerCase() === v) || null;
}

/* ============================================================
   SIM number validation & swap detection.
   - Primary number: typically 10–13 digits
   - Secondary / ICCID: 18–20 digits, usually starts with "89"
   Used to warn / auto-fix when the two fields look swapped.
   ============================================================ */

function digitsOnly(s) {
  return String(s || "").replace(/\D/g, "");
}

function isLikelyIccid(s) {
  const d = digitsOnly(s);
  return d.length >= 18 && d.length <= 22;
}

function isLikelyPrimary(s) {
  const d = digitsOnly(s);
  return d.length >= 10 && d.length <= 14;
}

/**
 * Returns true if (primary, secondary) appears to be entered in the
 * wrong order — a 20-digit ICCID in the primary slot, and a short
 * 10–13 digit number in the secondary slot.
 */
function pairLooksSwapped(primary, secondary) {
  return isLikelyIccid(primary) && isLikelyPrimary(secondary);
}

function simLooksSwapped(sim) {
  return pairLooksSwapped(sim.primaryNumber, sim.secondaryNumber);
}

function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/* ---------------- Realtime ---------------- */

function startRealtime() {
  if (realtimeChannel) return;
  realtimeStatus = "connecting";
  updateLiveBadge();
  realtimeChannel = subscribeRealtime((eventType, info) => {
    if (eventType === "status") {
      if (info.status === "SUBSCRIBED") realtimeStatus = "live";
      else if (info.status === "CHANNEL_ERROR" || info.status === "TIMED_OUT")
        realtimeStatus = "error";
      else realtimeStatus = "connecting";
      updateLiveBadge();
      return;
    }
    scheduleRefresh();
  });
}

async function stopRealtime() {
  if (!realtimeChannel) return;
  await unsubscribeRealtime(realtimeChannel);
  realtimeChannel = null;
  realtimeStatus = "idle";
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    try {
      await refreshAllData();
      render();
    } catch (err) {
      showToast(err.message || "Live sync failed.", true);
    }
  }, 450);
}

/* ---------------- Excel (xlsx) helpers ---------------- */
// Uses SheetJS (loaded via CDN as window.XLSX in index.html).

function downloadXlsx(filename, rows, sheetName = "Sheet1", textColumns = []) {
  if (typeof XLSX === "undefined") {
    showToast("Excel library not loaded. Refresh the page and try again.", true);
    return;
  }
  if (!rows.length) {
    showToast("Nothing to export.", true);
    return;
  }

  // Identify which column indexes need to be Text-formatted (so 18+ digit
  // numbers like SIM ICCIDs and IMEIs aren't truncated to scientific notation).
  const header = rows[0];
  const textColIdx = new Set();
  if (textColumns.length) {
    const lowerHeader = header.map((h) => String(h).toLowerCase().trim());
    textColumns.forEach((c) => {
      const idx = lowerHeader.indexOf(c.toLowerCase());
      if (idx >= 0) textColIdx.add(idx);
    });
  }

  // Force text-column values to strings (so SheetJS writes them as strings,
  // not numbers).
  const safeRows = rows.map((row, ri) =>
    row.map((cell, ci) => {
      if (ri === 0) return cell;
      if (textColIdx.has(ci)) return String(cell ?? "");
      return cell;
    })
  );

  // Pre-fill 200 blank rows so the user has plenty of pre-formatted cells to
  // paste into without Excel converting long numeric strings to scientific
  // notation.
  const BLANK_ROWS = 200;
  for (let i = 0; i < BLANK_ROWS; i += 1) {
    safeRows.push(header.map(() => ""));
  }

  const ws = XLSX.utils.aoa_to_sheet(safeRows);

  // Apply "@" (Text) number-format and string type to every cell in text
  // columns (data + blank rows).
  for (let r = 1; r < safeRows.length; r += 1) {
    for (const c of textColIdx) {
      const addr = XLSX.utils.encode_cell({ r, c });
      const existing = ws[addr];
      const value = existing && existing.v != null ? String(existing.v) : "";
      ws[addr] = { t: "s", v: value, w: value, z: "@" };
    }
  }

  // Ensure the sheet range covers the blank rows so Excel keeps the format on
  // them.
  ws["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: safeRows.length - 1, c: header.length - 1 },
  });

  // Auto-size columns for readability (based on data rows only).
  const dataRows = rows;
  const colWidths = header.map((_, colIdx) => {
    let max = 10;
    for (const r of dataRows) {
      const v = r[colIdx] == null ? "" : String(r[colIdx]);
      if (v.length > max) max = v.length;
    }
    return { wch: Math.min(max + 2, 60) };
  });
  ws["!cols"] = colWidths;

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, filename);
}

async function readXlsxFile(file) {
  if (!file) return [];
  if (typeof XLSX === "undefined") {
    throw new Error("Excel library not loaded. Refresh the page and try again.");
  }
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return [];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: false });
  // Normalize header keys to lowercase trimmed.
  return json.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) {
      out[String(key).toLowerCase().trim()] = String(row[key] ?? "").trim();
    }
    return out;
  });
}

function normalizeBool(value) {
  return ["yes", "y", "true", "1"].includes(String(value).trim().toLowerCase());
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function activeImeiMatches(inst, imei) {
  return inst.imeiHistory.some((item) => item.value.toLowerCase() === imei.toLowerCase());
}

function escapeHtml(text) {
  const el = document.createElement("div");
  el.textContent = text ?? "";
  return el.innerHTML;
}

/* ============================================================
   SVG CHART HELPERS — lightweight inline charts, no library.
   ============================================================ */

// Donut chart with center text. segments = [{value, color, label}].
function donutChart({ size = 200, hole = 62, segments, centerLabel, centerSub }) {
  const total = segments.reduce((s, x) => s + Number(x.value || 0), 0);
  const cx = size / 2;
  const cy = size / 2;
  const r = (size - 14) / 2;

  if (total === 0) {
    return `
      <svg viewBox="0 0 ${size} ${size}" class="donut-svg" preserveAspectRatio="xMidYMid meet">
        <circle cx="${cx}" cy="${cy}" r="${(r + hole) / 2}" fill="none" stroke="#e5e7eb" stroke-width="${r - hole}"/>
        <text x="${cx}" y="${cy + 6}" text-anchor="middle" font-size="14" fill="#9ca3af" font-family="Manrope, sans-serif">No data</text>
      </svg>`;
  }

  let acc = 0;
  const paths = segments
    .map((seg) => {
      const v = Number(seg.value || 0);
      if (v === 0) return "";
      const startAngle = (acc / total) * 2 * Math.PI;
      acc += v;
      const endAngle = (acc / total) * 2 * Math.PI;
      if (v === total) {
        // Full circle as a single segment — draw a stroked ring.
        return `<circle cx="${cx}" cy="${cy}" r="${(r + hole) / 2}" fill="none" stroke="${seg.color}" stroke-width="${r - hole}"/>`;
      }
      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.sin(startAngle);
      const y1 = cy - r * Math.cos(startAngle);
      const x2 = cx + r * Math.sin(endAngle);
      const y2 = cy - r * Math.cos(endAngle);
      const ix1 = cx + hole * Math.sin(startAngle);
      const iy1 = cy - hole * Math.cos(startAngle);
      const ix2 = cx + hole * Math.sin(endAngle);
      const iy2 = cy - hole * Math.cos(endAngle);
      return `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${hole} ${hole} 0 ${largeArc} 0 ${ix1} ${iy1} Z" fill="${seg.color}"/>`;
    })
    .join("");

  return `
    <svg viewBox="0 0 ${size} ${size}" class="donut-svg" preserveAspectRatio="xMidYMid meet">
      ${paths}
      ${centerLabel != null ? `<text x="${cx}" y="${centerSub ? cy - 2 : cy + 10}" text-anchor="middle" font-size="34" font-weight="800" fill="#0f172a" font-family="Manrope, sans-serif" letter-spacing="-0.02em">${escapeHtml(String(centerLabel))}</text>` : ""}
      ${centerSub ? `<text x="${cx}" y="${cy + 22}" text-anchor="middle" font-size="11" font-weight="700" fill="#64748b" font-family="Manrope, sans-serif" letter-spacing="0.06em">${escapeHtml(String(centerSub).toUpperCase())}</text>` : ""}
    </svg>`;
}

// Donut chart with a legend.
function donutWithLegend({ segments, centerLabel, centerSub, size = 200 }) {
  const total = segments.reduce((s, x) => s + Number(x.value || 0), 0);
  const legendHtml = segments
    .map((seg) => {
      const v = Number(seg.value || 0);
      const pct = total ? Math.round((v / total) * 100) : 0;
      return `
        <div class="donut-legend-row">
          <div class="donut-legend-main">
            <span class="donut-legend-num">${v}</span>
            <span class="donut-legend-pct">(${pct}%)</span>
          </div>
          <div class="donut-legend-label">
            <span class="donut-legend-dot" style="background: ${seg.color}"></span>
            ${escapeHtml(seg.label)}
          </div>
        </div>`;
    })
    .join("");
  return `
    <div class="donut-card-body">
      <div class="donut-wrap">
        ${donutChart({ size, segments, centerLabel, centerSub })}
      </div>
      <div class="donut-legend">${legendHtml}</div>
    </div>`;
}

// Horizontal bar chart. items = [{label, value, color?}].
function horizontalBarChart(items, opts = {}) {
  const { showValue = true } = opts;
  if (!items.length) return `<div class="empty-record">No Record Found</div>`;
  const max = Math.max(1, ...items.map((i) => Number(i.value || 0)));
  return `
    <div class="hbar-chart">
      ${items
        .map((it) => {
          const v = Number(it.value || 0);
          const pct = Math.max(2, Math.round((v / max) * 100));
          return `
            <div class="hbar-row">
              <div class="hbar-label" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>
              <div class="hbar-track-row">
                <div class="hbar-track">
                  <div class="hbar-fill" style="width: ${pct}%; background: ${it.color || "#a78bfa"};"></div>
                </div>
                ${showValue ? `<span class="hbar-value">${v}</span>` : ""}
              </div>
            </div>`;
        })
        .join("")}
    </div>`;
}

/* ============================================================
   BARCODE / QR SCANNER — camera-based input for IMEI and ICCID.
   Uses html5-qrcode (loaded via CDN in index.html). On detection
   the callback is invoked with the raw decoded text.
   ============================================================ */

let _activeScanner = null;

async function openBarcodeScannerModal({ title = "📷 Scan Barcode", hint = "Point camera at the barcode or QR code.", onScan }) {
  // Use the low-level Html5Qrcode API directly so we can force the BACK
  // camera (facingMode: "environment") instead of the front selfie cam.
  const HQR = window.Html5Qrcode;
  const libraryReady = typeof HQR !== "undefined";
  const cameraReady = libraryReady && window.isSecureContext;

  let currentFacing = "environment"; // start with back camera

  const cameraSection = cameraReady
    ? `
      <div class="qr-reader-wrap">
        <div id="qrReader"></div>
        <div class="qr-controls">
          <button type="button" class="qr-icon-btn" id="qrTorchBtn" aria-label="Toggle torch / flashlight" style="display: none;">🔦</button>
          <button type="button" class="qr-icon-btn" id="qrFlipBtn" aria-label="Flip camera">🔄</button>
        </div>
        <div class="qr-status" id="qrStatus">Starting back camera…</div>
      </div>
      <div class="scan-divider"><span>OR</span></div>
    `
    : `
      <div class="hint hint-warn" style="margin-bottom: 0.7rem;">
        ${!libraryReady ? "📷 Camera scanner unavailable — type manually below." : "Camera needs HTTPS — type manually below."}
      </div>
    `;

  modal.innerHTML = `
    <h3>${escapeHtml(title)}</h3>
    <p class="modal-desc">${escapeHtml(hint)}</p>
    ${cameraSection}
    <div class="manual-entry-block">
      <label for="manualScanInput">Type the number manually:</label>
      <div class="input-with-scan" style="margin-top: 0.4rem;">
        <input type="text" id="manualScanInput" autocomplete="off" inputmode="numeric" placeholder="Paste or type the number" />
        <button type="button" class="btn btn-primary btn-sm" id="manualScanOk">OK</button>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary btn-block" data-act="cancel">Close</button>
    </div>
  `;
  modal.classList.add("modal-wide");
  modalOverlay.classList.remove("hidden");

  const setStatus = (text) => {
    const s = document.getElementById("qrStatus");
    if (s) s.textContent = text;
  };

  const cleanup = async () => {
    try {
      if (_activeScanner) {
        await _activeScanner.stop().catch(() => {});
        await _activeScanner.clear().catch(() => {});
      }
    } catch {}
    _activeScanner = null;
    modal.classList.remove("modal-wide");
    closeModal();
  };

  // Manual entry — always available
  document.getElementById("manualScanOk")?.addEventListener("click", async () => {
    const val = document.getElementById("manualScanInput")?.value.trim();
    if (!val) return;
    await cleanup();
    try { onScan(val); } catch {}
  });
  document.getElementById("manualScanInput")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      document.getElementById("manualScanOk")?.click();
    }
  });

  modal.querySelector('[data-act="cancel"]').onclick = cleanup;
  modalOverlay.onclick = (e) => { if (e.target === modalOverlay) cleanup(); };

  if (!cameraReady) {
    setTimeout(() => document.getElementById("manualScanInput")?.focus(), 100);
    return;
  }

  // ----- Camera start logic with forced back-camera -----
  // Wide qrbox optimised for Code 128 barcodes (IMEI / ICCID).
  // These barcodes are long horizontal strips, so qrbox needs width.
  const HQRFormats = window.Html5QrcodeSupportedFormats;
  const allFormats = HQRFormats
    ? [
        HQRFormats.CODE_128,    // most common for IMEI / ICCID
        HQRFormats.CODE_39,
        HQRFormats.CODE_93,
        HQRFormats.EAN_13,
        HQRFormats.EAN_8,
        HQRFormats.UPC_A,
        HQRFormats.UPC_E,
        HQRFormats.ITF,
        HQRFormats.QR_CODE,
        HQRFormats.DATA_MATRIX,
        HQRFormats.PDF_417,
      ]
    : undefined;

  const config = {
    fps: 15,                                // higher framerate for snappier detection
    qrbox: (vw, vh) => {
      // For long Code 128 barcodes, we want a WIDE / SHORT scan box
      const w = Math.min(vw * 0.92, 360);
      const h = Math.min(vh * 0.45, 140);
      return { width: Math.floor(w), height: Math.floor(h) };
    },
    aspectRatio: 1.5,
    disableFlip: false,
    rememberLastUsedCamera: false,
    formatsToSupport: allFormats,
    experimentalFeatures: {
      // Use the native BarcodeDetector API on supported devices for much
      // better detection performance and accuracy.
      useBarCodeDetectorIfSupported: true,
    },
    videoConstraints: {
      // Request higher resolution for clearer barcode lines
      facingMode: "environment",
      width: { ideal: 1920, min: 640 },
      height: { ideal: 1080, min: 480 },
      focusMode: "continuous",
      advanced: [{ focusMode: "continuous" }],
    },
  };

  const startCamera = async (facing) => {
    setStatus(`Starting ${facing === "environment" ? "back" : "front"} camera…`);
    try {
      if (_activeScanner) {
        try { await _activeScanner.stop(); } catch {}
        try { await _activeScanner.clear(); } catch {}
        _activeScanner = null;
      }
      _activeScanner = new HQR("qrReader", { verbose: false, formatsToSupport: allFormats });
      await _activeScanner.start(
        { facingMode: facing },
        config,
        async (decodedText) => {
          await cleanup();
          try { onScan(String(decodedText).trim()); } catch {}
        },
        () => {} // per-frame decode misses
      );
      currentFacing = facing;
      setStatus("📷 Hold steady, fill the bar in the frame");

      // Show torch button if device supports it
      try {
        const settings = _activeScanner.getRunningTrackCameraCapabilities?.();
        const torchBtn = document.getElementById("qrTorchBtn");
        if (settings?.torchFeature?.()?.isSupported?.() && torchBtn) {
          torchBtn.style.display = "flex";
        }
      } catch {}
    } catch (err) {
      console.warn("Camera start failed for", facing, err);
      if (facing === "environment") {
        try {
          const cams = await HQR.getCameras();
          const back = cams.find((c) => /back|rear|environment|world|wide(?!.*front)/i.test(c.label || ""));
          const fallbackId = back?.id || cams[cams.length - 1]?.id;
          if (fallbackId) {
            _activeScanner = new HQR("qrReader", { verbose: false, formatsToSupport: allFormats });
            await _activeScanner.start(
              fallbackId,
              config,
              async (decodedText) => {
                await cleanup();
                try { onScan(String(decodedText).trim()); } catch {}
              },
              () => {}
            );
            setStatus("📷 Hold steady, fill the bar in the frame");
            return;
          }
        } catch (innerErr) {
          console.error("Camera enumeration fallback failed:", innerErr);
        }
      }
      setStatus("Camera unavailable — please type manually below.");
    }
  };

  // Defer slightly so the qrReader div is laid out before camera init
  setTimeout(() => startCamera("environment"), 100);

  document.getElementById("qrFlipBtn")?.addEventListener("click", () => {
    const newFacing = currentFacing === "environment" ? "user" : "environment";
    startCamera(newFacing);
  });

  // Torch / flashlight toggle (back camera with LED)
  let torchOn = false;
  document.getElementById("qrTorchBtn")?.addEventListener("click", async () => {
    if (!_activeScanner) return;
    try {
      torchOn = !torchOn;
      const cap = _activeScanner.getRunningTrackCameraCapabilities?.();
      if (cap?.torchFeature) {
        await cap.torchFeature().apply(torchOn);
        const btn = document.getElementById("qrTorchBtn");
        if (btn) btn.classList.toggle("active", torchOn);
      }
    } catch (err) {
      console.warn("Torch toggle failed:", err);
    }
  });
}

/* ============================================================
   EXCEL EXPORT — uses SheetJS (XLSX) loaded via CDN.
   Generates a downloadable .xlsx file for the chosen data.
   ============================================================ */

function todayFileStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function downloadAsExcel(sheets, baseName) {
  // sheets = [{ name, rows: array-of-objects }]
  if (typeof XLSX === "undefined") {
    showToast("Excel library not loaded. Refresh and try again.", true);
    return;
  }
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const rows = s.rows && s.rows.length ? s.rows : [{ "(empty)": "No data" }];
    const ws = XLSX.utils.json_to_sheet(rows);
    // Auto-size columns roughly based on header length + content
    const cols = Object.keys(rows[0]).map((k) => {
      const maxLen = Math.max(
        k.length,
        ...rows.map((r) => String(r[k] ?? "").length)
      );
      return { wch: Math.min(40, Math.max(10, maxLen + 2)) };
    });
    ws["!cols"] = cols;
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 30));
  }
  XLSX.writeFile(wb, `${baseName}-${todayFileStamp()}.xlsx`);
}

function exportInstallationsToExcel() {
  const installs = loadInstallations();
  const rows = installs.map((i) => ({
    "Vehicle No": i.vehicleNo || "",
    "GPS Model": i.gpsModel || "",
    "Current IMEI": getCurrentImei(i),
    "Current SIM (Primary)": resolvePrimarySim(getCurrentSim(i)) || "",
    "SIM ICCID (Secondary)": i.secondarySim || (i.simHistory[0]?.secondaryValue) || "",
    "MAC ID": i.macId || "",
    "Sensor No": i.sensorNo || "",
    "IMEI History": (i.imeiHistory || []).map((h) => h.value).join(" → "),
    "SIM History": (i.simHistory || []).map((h) => h.value).join(" → "),
    "Created By": i.createdBy || "",
    "Created At": formatDateTime(i.createdAt),
    "Tasks Complete": Object.values(i.tasks || {}).filter((t) => t?.completedAt).length,
    "Tasks Pending": INSTALL_TASK_TYPES.filter((t) => !(i.tasks?.[t]?.completedAt)).length,
  }));
  downloadAsExcel([{ name: "Installations", rows }], "installations");
  showToast(`Exported ${rows.length} installations.`);
}

function exportSimsToExcel() {
  const allSims = loadSims();
  const allInstalls = loadInstallations();
  const inUseMap = new Map();
  for (const inst of allInstalls) {
    for (const h of inst.simHistory) {
      if (h.active && h.value) inUseMap.set(h.value.toLowerCase(), inst.vehicleNo);
    }
  }
  const rows = allSims.map((s) => {
    const pri = (s.primaryNumber || "").toLowerCase();
    const sec = (s.secondaryNumber || "").toLowerCase();
    const linkedVehicle = inUseMap.get(pri) || inUseMap.get(sec) || "";
    let status = "Available";
    if (!s.primaryNumber) status = "Pending Primary";
    else if (linkedVehicle) status = "In Use";
    return {
      "Primary Number": s.primaryNumber || "",
      "Secondary Number (ICCID)": s.secondaryNumber || "",
      "Status": status,
      "Linked Vehicle": linkedVehicle,
      "Notes": s.notes || "",
      "Added At": s.createdAt ? formatDateTime(s.createdAt) : "",
    };
  });
  downloadAsExcel([{ name: "SIM Database", rows }], "sim-database");
  showToast(`Exported ${rows.length} SIMs.`);
}

function exportStockToExcel() {
  const items = loadStockItems();
  const tx = loadStockTransactions();
  const itemRows = items.map((it) => ({
    "Item Name": it.name || "",
    "Category": it.category || "",
    "Quantity": it.quantity ?? 0,
    "Unit": it.unit || "pcs",
    "IMEI": it.metadata?.imei || "",
    "MAC": it.metadata?.mac || "",
    "SIM Primary": it.metadata?.primary || "",
    "SIM Secondary (ICCID)": it.metadata?.secondary || "",
    "Sensor No": it.metadata?.sensorNo || "",
    "Supplier": it.supplier || "",
    "Low-stock Threshold": it.lowStockThreshold ?? "",
    "Notes": it.notes || "",
    "Added": it.createdAt ? formatDateTime(it.createdAt) : "",
  }));
  const txRows = tx.slice(0, 1000).map((t) => ({
    "Date": formatDateTime(t.createdAt),
    "Item": t.itemName || "",
    "Type": t.type || "",
    "Change": t.delta ?? 0,
    "Vehicle": t.vehicleNo || "",
    "Note": t.note || "",
    "By": t.createdBy || "",
  }));
  downloadAsExcel(
    [
      { name: "Stock Items", rows: itemRows },
      { name: "Recent Transactions", rows: txRows },
    ],
    "stock"
  );
  showToast(`Exported ${itemRows.length} stock items.`);
}

function exportRepairsToExcel() {
  const records = loadMaintenance();
  const rows = records.map((r) => ({
    "Vehicle No": r.vehicleNo || "",
    "Old IMEI": r.oldImei || "",
    "Old SIM": r.oldSimNo || "",
    "SIM Changed": r.simChange ? "Yes" : "",
    "New SIM (ICCID)": r.newSimNo || "",
    "Device Changed": r.deviceChange ? "Yes" : "",
    "New IMEI": r.newImei || "",
    "Device Out for Repair": r.deviceOutForRepair ? "Yes" : "",
    "Sensor Out for Repair": r.sensorOutForRepair ? "Yes" : "",
    "Other Work": r.otherWorkText || "",
    "Remarks": r.remarks || "",
    "Created By": r.createdBy || "",
    "Created At": formatDateTime(r.createdAt),
    "Tasks Complete": getTasks(r).filter(isTaskDone).length,
    "Tasks Pending": getTasks(r).filter((t) => !isTaskDone(t)).length,
  }));
  downloadAsExcel([{ name: "Repair Records", rows }], "repair-records");
  showToast(`Exported ${rows.length} repair records.`);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => toast.classList.add("hidden"), 3000);
}

/* ---------------- Modal helpers ---------------- */

function closeModal() {
  modalOverlay.classList.add("hidden");
  modal.innerHTML = "";
  modalOverlay.onclick = null;
}

function showModal(html, onConfirm) {
  modal.innerHTML = html;
  modalOverlay.classList.remove("hidden");

  modal.querySelector(".modal-close")?.addEventListener("click", closeModal);
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };

  modal.querySelector(".modal-confirm")?.addEventListener("click", async () => {
    try {
      const result = await onConfirm?.();
      if (result !== false) closeModal();
    } catch (err) {
      showToast(err.message || "Something went wrong.", true);
    }
  });

  return { modalEl: modal, close: closeModal };
}

function showConfirm({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = false }) {
  return new Promise((resolve) => {
    modal.innerHTML = `
      <div class="modal-icon ${danger ? "danger" : ""}">${danger ? "⚠️" : "❓"}</div>
      <h3>${escapeHtml(title)}</h3>
      <p class="modal-desc">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" data-action="cancel">${escapeHtml(cancelLabel)}</button>
        <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-action="confirm">${escapeHtml(confirmLabel)}</button>
      </div>
    `;
    modalOverlay.classList.remove("hidden");

    const done = (value) => {
      closeModal();
      resolve(value);
    };

    modal.querySelector('[data-action="cancel"]').onclick = () => done(false);
    modal.querySelector('[data-action="confirm"]').onclick = () => done(true);
    modalOverlay.onclick = (e) => {
      if (e.target === modalOverlay) done(false);
    };
  });
}

/* ---------------- Domain helpers ---------------- */

function getCurrentImei(inst) {
  const active = [...inst.imeiHistory].reverse().find((i) => i.active);
  return active?.value || inst.imeiHistory.at(-1)?.value || "";
}

function getCurrentSim(inst) {
  const active = [...inst.simHistory].reverse().find((s) => s.active);
  return active?.value || inst.simHistory.at(-1)?.value || "";
}

function findInstallationByImei(imei) {
  const q = imei.trim().toLowerCase();
  if (!q) return null;
  return loadInstallations().find((inst) =>
    inst.imeiHistory.some((i) => i.value.toLowerCase() === q)
  );
}

function findInstallationByVehicle(vehicleNo) {
  const q = vehicleNo.trim().toLowerCase();
  if (!q) return null;
  return loadInstallations().find((inst) => inst.vehicleNo.toLowerCase() === q);
}

function historyList(items) {
  if (!items.length) return '<span class="muted">—</span>';
  return items
    .map((item) => {
      let badge = '<span class="badge badge-muted">Inactive</span>';
      if (item.active && item.pendingDeactivation) {
        badge = '<span class="badge badge-warn">Active · deactivate pending</span>';
      } else if (item.active) {
        badge = '<span class="badge badge-ok">Active</span>';
      }
      return '<div class="history-item"><span class="mono">' + escapeHtml(item.value) + "</span> " + badge + "</div>";
    })
    .join("");
}

function simHistoryCell(inst) {
  let html = historyList(inst.simHistory);
  if (inst.secondarySim) {
    html += `<div class="history-item secondary-sim"><span class="badge badge-secondary">Secondary No</span> <span class="mono">${escapeHtml(inst.secondarySim)}</span></div>`;
  }
  return html;
}

function workLabels(record) {
  const parts = [];
  if (record.wiringConnection) parts.push("Wiring connection");
  if (record.simChange) parts.push(`SIM change → ${record.newSimNo}`);
  if (record.deviceChange) parts.push(`Device change → ${record.newImei}`);
  if (record.sensorOutForRepair) parts.push("Sensor out for repair");
  if (record.sensorChanged) parts.push("Sensor changed");
  if (record.deviceOutForRepair) parts.push("Device out for repair");
  if (record.otherWorkText) parts.push(`Other → ${record.otherWorkText}`);
  return parts.join(", ") || "—";
}

function getMaintenanceStatus(record) {
  const tasks = getTasks(record);
  if (!tasks.length) return '<span class="badge badge-ok">Done</span>';
  const pending = tasks.filter((t) => !isTaskDone(t));
  if (!pending.length) return '<span class="badge badge-ok">All actions done</span>';
  return `<span class="badge badge-warn">${pending.length} action${pending.length === 1 ? "" : "s"} pending</span>`;
}

function setView(next) {
  view = next;
  render();
}

async function logout() {
  await stopRealtime();
  currentUser = null;
  view = "login";
  searchQuery = "";
  lastSyncedAt = null;
  render();
}

/* ---------------- Live badge ---------------- */

function liveBadgeMarkup() {
  let cls = "synced";
  let label = "Live";
  let dotPulse = true;

  if (isLoadingData) {
    cls = "syncing";
    label = "Syncing";
  } else if (realtimeStatus === "live") {
    cls = "synced";
    label = lastSyncedAt
      ? `Live · ${lastSyncedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : "Live";
  } else if (realtimeStatus === "connecting") {
    cls = "syncing";
    label = "Connecting";
  } else if (realtimeStatus === "error") {
    cls = "offline";
    label = "Reconnecting";
  } else {
    cls = "offline";
    label = "Offline";
    dotPulse = false;
  }

  return `<span class="live-badge ${cls}" id="liveBadge">
      <span class="live-dot ${dotPulse ? "" : "static"}"></span>
      ${escapeHtml(label)}
    </span>`;
}

function updateLiveBadge() {
  const existing = document.getElementById("liveBadge");
  if (!existing) return;
  const wrap = document.createElement("div");
  wrap.innerHTML = liveBadgeMarkup();
  existing.replaceWith(wrap.firstElementChild);
}

function renderHeader(title, subtitle) {
  return `
    <header class="header">
      <div class="header-content">
        <div class="logo">
          <span class="logo-icon">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"/>
              <circle cx="12" cy="11" r="2.4"/>
            </svg>
          </span>
          <div>
            <h1>${escapeHtml(title)} <span class="app-version" title="App version">v${APP_VERSION}</span></h1>
            <p>${escapeHtml(subtitle)}</p>
          </div>
        </div>
        ${
          currentUser
            ? `<div class="header-actions">
                ${liveBadgeMarkup()}
                <span class="user-badge">${(() => {
                  if (currentUser === "akash") return "👷 Akash";
                  if (currentUser === "admin") return "🛡️ Admin";
                  if (currentUser === "abhinav") return "📦 Abhinav";
                  return `👤 ${escapeHtml(currentUser || "User")}`;
                })()}</span>
                <button type="button" class="btn btn-outline btn-sm" id="logoutBtn">Logout</button>
              </div>`
            : ""
        }
      </div>
    </header>
  `;
}

function renderConfigMissing() {
  app.innerHTML = `
    ${renderHeader("GPS Maintenance Tracker", "Setup required")}
    <main class="main centered">
      <section class="card login-card">
        <h2>Supabase not configured</h2>
        <p class="login-desc">Copy <code>config_example.js</code> to <code>config.js</code>, add your Supabase URL and anon key, then include it in <code>index.html</code>.</p>
      </section>
    </main>
  `;
}

function renderLoading(message = "Loading data...") {
  app.innerHTML = `
    ${renderHeader("GPS Maintenance Tracker", message)}
    <main class="main centered">
      <section class="card login-card loading-card">
        <div class="spinner"></div>
        <p class="login-desc">${escapeHtml(message)}</p>
      </section>
    </main>
  `;
}

function bindLogout() {
  document.getElementById("logoutBtn")?.addEventListener("click", logout);
}

function renderLogin() {
  app.innerHTML = `
    <div class="login-screen">
      <div class="login-card">
        <div class="login-logo">📍</div>
        <h1>GPS Tracker</h1>
        <p class="login-subtitle">TASR Fleet · Sign in to continue</p>
        <form id="loginForm">
          <div class="field">
            <label for="loginUser">Username</label>
            <input type="text" id="loginUser" required placeholder="akash or admin" autocomplete="username" />
          </div>
          <div class="field">
            <label for="loginPass">Password</label>
            <input type="password" id="loginPass" required placeholder="Password" autocomplete="current-password" />
          </div>
          <button type="submit" class="btn btn-primary login-submit">Sign in</button>
        </form>
        <p class="login-footer">v${APP_VERSION} · TASR BharatNext</p>
      </div>
    </div>
  `;

  document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("loginUser").value.toLowerCase().trim();
    const password = document.getElementById("loginPass").value;
    const role = validateLogin(username, password);

    if (!role) {
      showToast("Invalid username or password.", true);
      document.getElementById("loginPass").classList.add("invalid");
      return;
    }

    currentUser = username; // Store actual username not role (so multiple users with same role still differ)
    view = landingPageFor(username);
    renderLoading("Loading data from Supabase...");
    try {
      await refreshAllData();
      startRealtime();
      render();
    } catch (err) {
      console.error("Supabase load failed:", err);
      renderConnectionError(err.message || "Failed to load data.");
    }
  });
}

function renderConnectionError(message) {
  app.innerHTML = `
    ${renderHeader("Connection error", "Could not reach Supabase")}
    <main class="main centered">
      <section class="card login-card">
        <h2>⚠️ Could not load data</h2>
        <p class="login-desc"><strong>${escapeHtml(message)}</strong></p>
        <p class="login-desc">Most common cause: the Supabase project is paused (free tier auto-pauses after a week of inactivity).</p>
        <ol class="setup-steps">
          <li>Open <a href="https://supabase.com/dashboard/project/jzclmcjurfehpfybxryh" target="_blank" rel="noopener">your Supabase dashboard</a></li>
          <li>If you see a "Restore project" or "Project paused" banner, click <strong>Restore</strong></li>
          <li>Wait 1–2 minutes for it to wake up, then retry</li>
        </ol>
        <div class="form-actions" style="margin-top: 1.25rem;">
          <button type="button" class="btn btn-primary" id="retryConnect">↻ Retry connection</button>
          <button type="button" class="btn btn-secondary" id="backToLogin">Back to login</button>
        </div>
      </section>
    </main>
  `;
  document.getElementById("retryConnect")?.addEventListener("click", async () => {
    renderLoading("Retrying connection...");
    try {
      await refreshAllData();
      startRealtime();
      render();
    } catch (err) {
      console.error("Retry failed:", err);
      renderConnectionError(err.message || "Still cannot reach Supabase.");
    }
  });
  document.getElementById("backToLogin")?.addEventListener("click", () => {
    currentUser = null;
    view = "login";
    render();
  });
}

function renderAkashHome() {
  const myInstallations = loadInstallations().filter((inst) => inst.createdBy === "akash");
  const myMaintenance = loadMaintenance().filter((record) => record.createdBy === "akash");
  app.innerHTML = `
    ${renderHeader("Akash Portal", "Field work — installations & repairs")}
    <main class="main">
      <section class="card">
        <h2>What work are you doing?</h2>
        <div class="choice-grid">
          <button type="button" class="choice-card" id="goInstall">
            <span class="choice-icon">🆕</span>
            <span class="choice-title">Installing New GPS</span>
            <span class="choice-desc">Register a new device installation</span>
          </button>
          <button type="button" class="choice-card" id="goRepair">
            <span class="choice-icon">🔧</span>
            <span class="choice-title">Repair Work</span>
            <span class="choice-desc">Maintenance on existing installation</span>
          </button>
        </div>
      </section>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>My Entries</h2>
            <p class="section-subtitle">Entries saved from Akash login.</p>
          </div>
          <button type="button" class="btn btn-secondary btn-sm" id="refreshMine">↻ Refresh</button>
        </div>
        <div class="summary-grid">
          <div class="summary-box summary-info">
            <strong>${myInstallations.length}</strong>
            <span>Installations</span>
          </div>
          <div class="summary-box summary-purple">
            <strong>${myMaintenance.length}</strong>
            <span>Repair work</span>
          </div>
          <div class="summary-box summary-ok">
            <strong>${(() => {
              const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
              const i = myInstallations.filter((x) => new Date(x.createdAt).getTime() >= weekAgo).length;
              const r = myMaintenance.filter((x) => new Date(x.createdAt).getTime() >= weekAgo).length;
              return i + r;
            })()}</strong>
            <span>This week</span>
          </div>
          <div class="summary-box summary-warn">
            <strong>${(() => {
              const today = new Date();
              const month = today.getMonth();
              const year = today.getFullYear();
              const i = myInstallations.filter((x) => {
                const d = new Date(x.createdAt);
                return d.getMonth() === month && d.getFullYear() === year;
              }).length;
              const r = myMaintenance.filter((x) => {
                const d = new Date(x.createdAt);
                return d.getMonth() === month && d.getFullYear() === year;
              }).length;
              return i + r;
            })()}</strong>
            <span>This month</span>
          </div>
        </div>
        <div class="entry-list">
          ${(() => {
            const myDeletions = deletionLog.filter(
              (d) =>
                d.deletedBy === "akash" &&
                (d.entityType === "installation" || d.entityType === "maintenance")
            );
            const entries = [
              ...myInstallations.map((inst) => ({
                id: inst.id,
                kind: "install",
                deleted: false,
                date: inst.createdAt,
                vehicle: inst.vehicleNo,
                imei: getCurrentImei(inst),
                model: inst.gpsModel,
                sim: inst.simIccid || (inst.iccidHistory?.find?.((h) => h.active)?.value || ""),
                mac: inst.macId,
                sensor: inst.sensorNo,
              })),
              ...myMaintenance.map((record) => ({
                id: record.id,
                kind: "repair",
                deleted: false,
                date: record.createdAt,
                vehicle: record.vehicleNo,
                imei: record.imeiNo || "",
                work: workLabels(record),
                simChange: record.simChange,
                deviceChange: record.deviceChange,
                deviceOutForRepair: record.deviceOutForRepair,
                sensorOutForRepair: record.sensorOutForRepair,
                otherWorkText: record.otherWorkText || "",
              })),
              ...myDeletions.map((d) => {
                const snap = d.snapshot || {};
                const isInstall = d.entityType === "installation";
                return {
                  id: d.id,
                  kind: isInstall ? "install" : "repair",
                  deleted: true,
                  date: d.deletedAt,
                  vehicle: snap.vehicleNo || (d.entityLabel || "").split(" ")[0] || "—",
                  imei: isInstall
                    ? (snap.imeiHistory?.find?.((h) => h.active)?.value || snap.imeiHistory?.[0]?.value || "")
                    : (snap.imeiNo || ""),
                  model: snap.gpsModel || "",
                  sim: snap.simIccid || (snap.iccidHistory?.find?.((h) => h.active)?.value || ""),
                  mac: snap.macId || "",
                  sensor: snap.sensorNo || "",
                  work: isInstall ? "" : [
                    snap.simChange ? "SIM" : null,
                    snap.deviceChange ? "Device" : null,
                    snap.deviceOutForRepair ? "Device→Service" : null,
                    snap.sensorOutForRepair ? "Sensor→Service" : null,
                  ].filter(Boolean).join(" · ") || snap.otherWorkText || "Repair",
                  reason: d.reason || "",
                  originalDate: snap.createdAt || null,
                };
              }),
            ];
            entries.sort((a, b) => new Date(b.date) - new Date(a.date));
            const sliced = entries.slice(0, 15);
            if (!sliced.length) return `
              <div class="entry-empty">
                <div class="entry-empty-icon">📋</div>
                <h3>No entries yet</h3>
                <p>Tap "New Installation" to start.</p>
              </div>
            `;

            // Helper: last 6 digits for compact display
            const tail = (s, n = 6) => {
              const v = String(s || "");
              return v.length > n ? "…" + v.slice(-n) : v || "—";
            };

            return sliced
              .map((entry) => {
                const dateDisp = formatDateTime(entry.originalDate || entry.date);
                if (entry.deleted) {
                  return `
                    <article class="tk-card tk-deleted">
                      <div class="tk-card-head">
                        <span class="tk-pill tk-pill-deleted">${escapeHtml(entry.vehicle)}</span>
                        <span class="tk-chip tk-chip-deleted">🗑 DELETED · ${entry.kind === "install" ? "INSTALL" : "REPAIR"}</span>
                      </div>
                      ${entry.kind === "install" ? `
                        <div class="tk-flow">
                          <div class="tk-flow-box">
                            <div class="tk-flow-value">${escapeHtml(tail(entry.imei))}</div>
                            <div class="tk-flow-label">IMEI</div>
                          </div>
                          <div class="tk-flow-connector">
                            <div class="tk-flow-icon">📡</div>
                            <div class="tk-flow-icon-label">${escapeHtml(entry.model || "—")}</div>
                          </div>
                          <div class="tk-flow-box tk-flow-end">
                            <div class="tk-flow-value">${escapeHtml(tail(entry.sim))}</div>
                            <div class="tk-flow-label">SIM</div>
                          </div>
                        </div>
                      ` : `
                        <div class="tk-stats" style="margin-bottom: 0.4rem;">
                          <div class="tk-stat tk-stat-full">
                            <span class="tk-stat-icon">🛠️</span>
                            <span class="tk-stat-label">Work:</span>
                            <span class="tk-stat-value" style="white-space:normal;">${escapeHtml(entry.work)}</span>
                          </div>
                        </div>
                      `}
                      <div class="tk-footer">
                        <div class="tk-footer-row">
                          <span class="tk-footer-icon">📅</span>
                          <span class="tk-footer-label">Created on:</span>
                          <span class="tk-footer-value">${escapeHtml(dateDisp)}</span>
                        </div>
                        <div class="tk-footer-row">
                          <span class="tk-footer-icon">🗑️</span>
                          <span class="tk-footer-label">Deleted on:</span>
                          <span class="tk-footer-value">${escapeHtml(formatDateTime(entry.date))}</span>
                        </div>
                      </div>
                      ${entry.reason ? `<div class="tk-reason">⚠️ Reason: ${escapeHtml(entry.reason)}</div>` : ""}
                    </article>
                  `;
                }
                if (entry.kind === "install") {
                  const showMacSensor = (entry.mac || entry.sensor) && entry.model !== "Normal";
                  return `
                    <article class="tk-card">
                      <div class="tk-card-head">
                        <span class="tk-pill tk-pill-install">${escapeHtml(entry.vehicle)}</span>
                        <span class="tk-chip tk-chip-install">🆕 Install</span>
                      </div>
                      <div class="tk-flow">
                        <div class="tk-flow-box">
                          <div class="tk-flow-value">${escapeHtml(tail(entry.imei))}</div>
                          <div class="tk-flow-label">IMEI</div>
                        </div>
                        <div class="tk-flow-connector">
                          <div class="tk-flow-icon">📡</div>
                          <div class="tk-flow-icon-label">${escapeHtml(entry.model || "—")}</div>
                        </div>
                        <div class="tk-flow-box tk-flow-end">
                          <div class="tk-flow-value">${escapeHtml(tail(entry.sim))}</div>
                          <div class="tk-flow-label">SIM</div>
                        </div>
                      </div>
                      ${showMacSensor ? `
                        <div class="tk-divider"></div>
                        <div class="tk-stats">
                          ${entry.mac ? `
                            <div class="tk-stat">
                              <span class="tk-stat-icon">📱</span>
                              <span class="tk-stat-label">MAC:</span>
                              <span class="tk-stat-value">${escapeHtml(tail(entry.mac, 8))}</span>
                            </div>
                          ` : ""}
                          ${entry.sensor ? `
                            <div class="tk-stat">
                              <span class="tk-stat-icon">📊</span>
                              <span class="tk-stat-label">Sensor:</span>
                              <span class="tk-stat-value">${escapeHtml(entry.sensor)}</span>
                            </div>
                          ` : ""}
                        </div>
                      ` : ""}
                      <div class="tk-footer">
                        <div class="tk-footer-row">
                          <span class="tk-footer-icon">📅</span>
                          <span class="tk-footer-label">Created on:</span>
                          <span class="tk-footer-value">${escapeHtml(dateDisp)}</span>
                        </div>
                      </div>
                      <div class="tk-actions">
                        <button type="button" class="btn btn-outline btn-sm akash-edit" data-kind="install" data-id="${escapeHtml(entry.id)}">✎ Edit</button>
                        <button type="button" class="btn btn-danger btn-sm akash-delete" data-kind="install" data-id="${escapeHtml(entry.id)}">🗑 Delete</button>
                      </div>
                    </article>
                  `;
                }
                // repair
                return `
                  <article class="tk-card">
                    <div class="tk-card-head">
                      <span class="tk-pill tk-pill-repair">${escapeHtml(entry.vehicle)}</span>
                      <span class="tk-chip tk-chip-repair">🛠 Repair</span>
                    </div>
                    <div class="tk-stats">
                      <div class="tk-stat tk-stat-full">
                        <span class="tk-stat-icon">🔧</span>
                        <span class="tk-stat-label">Work:</span>
                        <span class="tk-stat-value" style="white-space: normal; line-height: 1.4;">${escapeHtml(entry.work)}</span>
                      </div>
                      ${entry.imei ? `
                        <div class="tk-stat tk-stat-full">
                          <span class="tk-stat-icon">📡</span>
                          <span class="tk-stat-label">IMEI:</span>
                          <span class="tk-stat-value">${escapeHtml(tail(entry.imei))}</span>
                        </div>
                      ` : ""}
                    </div>
                    <div class="tk-footer">
                      <div class="tk-footer-row">
                        <span class="tk-footer-icon">📅</span>
                        <span class="tk-footer-label">Reported on:</span>
                        <span class="tk-footer-value">${escapeHtml(dateDisp)}</span>
                      </div>
                    </div>
                    <div class="tk-actions">
                      <button type="button" class="btn btn-outline btn-sm akash-edit" data-kind="repair" data-id="${escapeHtml(entry.id)}">✎ Edit</button>
                      <button type="button" class="btn btn-danger btn-sm akash-delete" data-kind="repair" data-id="${escapeHtml(entry.id)}">🗑 Delete</button>
                    </div>
                  </article>
                `;
              })
              .join("");
          })()}
        </div>
      </section>
    </main>

    <!-- Floating action button — quick access to New Installation from anywhere -->
    <div class="fab-container">
      <button type="button" class="fab fab-mini" id="fabRepair" aria-label="Report Repair">
        <span class="fab-icon">🛠️</span>
      </button>
      <button type="button" class="fab fab-main" id="fabInstall" aria-label="New Installation">
        <span class="fab-icon">+</span>
      </button>
    </div>
  `;

  bindLogout();
  document.getElementById("goInstall")?.addEventListener("click", () => setView("install"));
  document.getElementById("goRepair")?.addEventListener("click", () => setView("repair"));
  document.getElementById("fabInstall")?.addEventListener("click", () => setView("install"));
  document.getElementById("fabRepair")?.addEventListener("click", () => setView("repair"));
  document.getElementById("refreshMine")?.addEventListener("click", async () => {
    renderLoading("Refreshing data from Supabase...");
    await refreshAllData();
    setView("akash-home");
  });
  app.querySelectorAll(".akash-edit").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "install") openAkashEditInstallation(btn.dataset.id);
      else openAkashEditRepair(btn.dataset.id);
    });
  });
  app.querySelectorAll(".akash-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "install") deleteAkashInstallation(btn.dataset.id);
      else deleteAkashMaintenance(btn.dataset.id);
    });
  });
}

/* ---------------- Akash: edit + delete handlers ---------------- */

function openAkashEditInstallation(installId) {
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  modal.innerHTML = `
    <h3>✎ Edit installation</h3>
    <p class="modal-desc">You can fix typos in vehicle no, GPS model, MAC ID and sensor number. <strong>IMEI and SIM cannot be edited here</strong> — if you typed the wrong device or SIM, delete this entry and create a new one so stock is corrected automatically.</p>
    <div class="field">
      <label for="aiVehicle">Vehicle number</label>
      <input type="text" id="aiVehicle" value="${escapeHtml(inst.vehicleNo)}" autocomplete="off" />
    </div>
    <div class="field">
      <label for="aiModel">GPS model</label>
      <input type="text" id="aiModel" value="${escapeHtml(inst.gpsModel)}" autocomplete="off" />
    </div>
    <div class="field-row">
      <div class="field">
        <label for="aiMac">MAC ID</label>
        <input type="text" id="aiMac" value="${escapeHtml(inst.macId || "")}" autocomplete="off" class="mono" />
      </div>
      <div class="field">
        <label for="aiSensor">Sensor number</label>
        <input type="text" id="aiSensor" value="${escapeHtml(inst.sensorNo || "")}" autocomplete="off" class="mono" />
      </div>
    </div>
    <div class="field">
      <label>IMEI (read-only)</label>
      <input type="text" value="${escapeHtml(getCurrentImei(inst) || "")}" readonly class="mono" />
    </div>
    <div class="field">
      <label>SIM (read-only)</label>
      <input type="text" value="${escapeHtml(getCurrentSim(inst) || "")}" readonly class="mono" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save changes</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const vehicleNo = modal.querySelector("#aiVehicle").value.trim();
    const gpsModel = modal.querySelector("#aiModel").value.trim();
    const macId = modal.querySelector("#aiMac").value.trim();
    const sensorNo = modal.querySelector("#aiSensor").value.trim();
    if (!vehicleNo) {
      showToast("Vehicle number cannot be empty.", true);
      return;
    }
    closeModal();
    renderLoading("Saving changes...");
    try {
      await updateInstallation({ ...inst, vehicleNo, gpsModel, macId, sensorNo });
      await refreshAllData();
      render();
      showToast("Installation updated.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

function openAkashEditRepair(recordId) {
  const record = loadMaintenance().find((r) => r.id === recordId);
  if (!record) return;
  modal.innerHTML = `
    <h3>✎ Edit repair entry</h3>
    <p class="modal-desc">You can update the "other work" comment only. Identifier changes (SIM / IMEI) require deleting this entry and creating a new repair so stock is corrected.</p>
    <div class="field">
      <label>Vehicle (read-only)</label>
      <input type="text" value="${escapeHtml(record.vehicleNo)}" readonly />
    </div>
    <div class="field">
      <label>Work done (read-only)</label>
      <input type="text" value="${escapeHtml(workLabels(record))}" readonly />
    </div>
    <div class="field">
      <label for="arOther">Other work / comment</label>
      <input type="text" id="arOther" value="${escapeHtml(record.otherWorkText || "")}" placeholder="e.g. bracket changed, wiring re-done..." />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save changes</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const otherWorkText = modal.querySelector("#arOther").value.trim() || null;
    closeModal();
    renderLoading("Saving changes...");
    try {
      await updateMaintenanceRecord({ ...record, otherWorkText });
      await refreshAllData();
      render();
      showToast("Repair entry updated.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

async function deleteAkashInstallation(installId) {
  const inst = loadInstallations().find((i) => i.id === installId);
  if (!inst) return;
  const linkedRepairs = loadMaintenance().filter((r) => r.installationId === installId);
  const reason = await promptForReason({
    title: "Delete this installation?",
    message: `Removing installation for <strong>${escapeHtml(inst.vehicleNo)}</strong>. ${linkedRepairs.length ? `This will also remove <strong>${linkedRepairs.length}</strong> repair record${linkedRepairs.length === 1 ? "" : "s"} linked to it. ` : ""}Stock consumed (IMEI / SIM / sensor) will be automatically restored.`,
    confirmLabel: "Delete installation",
    placeholder: "e.g. wrong vehicle number, duplicate entry, install cancelled",
  });
  if (!reason) return;
  renderLoading("Deleting installation & restoring stock...");
  try {
    // Audit linked repairs first
    for (const r of linkedRepairs) {
      await auditDeletion({
        entityType: "maintenance",
        entityId: r.id,
        entityLabel: `${r.vehicleNo} · ${workLabels(r)}`,
        reason: `Cascade-deleted with parent installation. Parent reason: ${reason}`,
        snapshot: r,
      });
      await restoreStockFor({
        maintenanceRecordId: r.id,
        reason: `Restored — installation for ${inst.vehicleNo} deleted`,
      });
      await deleteMaintenanceRecord(r.id);
    }
    // Audit + delete the installation itself
    await auditDeletion({
      entityType: "installation",
      entityId: installId,
      entityLabel: `${inst.vehicleNo} · IMEI ${getCurrentImei(inst) || "?"}`,
      reason,
      snapshot: inst,
    });
    await restoreStockFor({
      installationId: installId,
      reason: `Restored — installation for ${inst.vehicleNo} deleted`,
    });
    await deleteInstallation(installId);
    await refreshAllData();
    render();
    showToast("Installation deleted, stock restored.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

async function deleteAkashMaintenance(recordId) {
  const record = loadMaintenance().find((r) => r.id === recordId);
  if (!record) return;
  const reason = await promptForReason({
    title: "Delete this repair entry?",
    message: `Removing repair on <strong>${escapeHtml(record.vehicleNo)}</strong> (${escapeHtml(workLabels(record))}). Stock consumed will be restored, and any SIM/device history added by this repair will be reverted.`,
    confirmLabel: "Delete repair",
    placeholder: "e.g. wrong vehicle, accidental save, repair cancelled",
  });
  if (!reason) return;
  renderLoading("Deleting repair & restoring state...");
  try {
    // 1) Audit
    await auditDeletion({
      entityType: "maintenance",
      entityId: recordId,
      entityLabel: `${record.vehicleNo} · ${workLabels(record)}`,
      reason,
      snapshot: record,
    });
    // 2) Reverse stock consumption for this repair.
    await restoreStockFor({
      maintenanceRecordId: recordId,
      reason: `Restored — repair on ${record.vehicleNo} deleted`,
    });
    // 3) Revert simHistory / imeiHistory on the linked installation.
    const inst = loadInstallations().find((i) => i.id === record.installationId);
    if (inst) {
      let touched = false;
      if (record.simChange && record.newSimNo) {
        const idx = inst.simHistory.findIndex(
          (h) => h.value === record.newSimNo && h.active
        );
        if (idx >= 0) {
          inst.simHistory.splice(idx, 1);
          for (let i = inst.simHistory.length - 1; i >= 0; i -= 1) {
            if (inst.simHistory[i].pendingDeactivation) {
              inst.simHistory[i].pendingDeactivation = false;
              inst.simHistory[i].active = true;
              break;
            }
            if (inst.simHistory[i].value === record.oldSimNo) {
              inst.simHistory[i].active = true;
              inst.simHistory[i].pendingDeactivation = false;
              break;
            }
          }
          touched = true;
        }
      }
      if (record.deviceChange && record.newImei) {
        const idx = inst.imeiHistory.findIndex(
          (h) => h.value === record.newImei && h.active
        );
        if (idx >= 0) {
          inst.imeiHistory.splice(idx, 1);
          for (let i = inst.imeiHistory.length - 1; i >= 0; i -= 1) {
            inst.imeiHistory[i].active = true;
            break;
          }
          touched = true;
        }
      }
      if (touched) {
        await updateInstallation(inst);
      }
    }
    // 4) Delete the maintenance record.
    await deleteMaintenanceRecord(recordId);
    await refreshAllData();
    render();
    showToast("Repair deleted, state restored.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

function renderInstallForm() {
  app.innerHTML = `
    ${renderHeader("Installing New GPS", "Fill the fields below to register a new install")}
    <main class="main">
      <section class="card accent-cyan">
        <div class="form-nav">
          <button type="button" class="btn btn-secondary btn-sm" id="backBtn">← Back</button>
        </div>
        <h2>New GPS Installation</h2>

        <form id="installForm" class="form-grid">

          <!-- GPS Model — also controls whether MAC + Sensor are required -->
          <div class="field full-width">
            <label>GPS Model <span class="required">*</span></label>
            <div class="seg-control" id="gpsTypeSeg">
              <button type="button" class="seg-btn" data-type="Normal">📱 Normal</button>
              <button type="button" class="seg-btn active" data-type="FMB">📡 FMB</button>
              <button type="button" class="seg-btn" data-type="FMC">📡 FMC</button>
            </div>
            <p class="hint" id="gpsTypeHint">FMB / FMC devices ko MAC ID aur Sensor No bharna zaroori hai. Normal devices ko nahi.</p>
          </div>

          <div class="field">
            <label for="instImei">IMEI No <span class="required">*</span></label>
            <div class="input-with-scan">
              <input type="text" id="instImei" required placeholder="e.g. 867530012345678" autocomplete="off" inputmode="numeric" />
              <button type="button" class="scan-btn" id="scanImei" aria-label="Scan IMEI barcode">📷</button>
            </div>
          </div>
          <div class="field">
            <label for="instVehicle">Vehicle No <span class="required">*</span></label>
            <input type="text" id="instVehicle" required placeholder="e.g. MH12AB1234" autocomplete="off" />
          </div>
          <div class="field full-width">
            <label for="instSim">SIM ICCID (20-digit, printed on the SIM card) <span class="required">*</span></label>
            <div class="input-with-scan">
              <input type="text" id="instSim" required placeholder="e.g. 89918720507069156677" autocomplete="off" inputmode="numeric" />
              <button type="button" class="scan-btn" id="scanSim" aria-label="Scan SIM ICCID barcode">📷</button>
            </div>
            <p class="hint" id="instSimHint">Wahi number daalo jo SIM card pe printed hai (long 20-digit number). Primary number admin ke SIM database se automatic link ho jaayega.</p>
          </div>
          <div class="field field-mac" id="fieldMac">
            <label for="instMac">MAC ID <span class="required">*</span></label>
            <input type="text" id="instMac" required placeholder="e.g. AA:BB:CC:DD:EE:FF" autocomplete="off" />
          </div>
          <div class="field field-sensor" id="fieldSensor">
            <label for="instSensor">Sensor No <span class="required">*</span></label>
            <input type="text" id="instSensor" required placeholder="e.g. SN-12345" autocomplete="off" />
          </div>
          <div class="form-actions full-width">
            <button type="submit" class="btn btn-primary">Continue to Confirm</button>
          </div>
        </form>
      </section>
    </main>
  `;

  bindLogout();
  document.getElementById("backBtn")?.addEventListener("click", () => setView("akash-home"));

  // GPS Model segmented control — toggle MAC + Sensor visibility
  let _gpsType = "FMB";
  const seg = document.getElementById("gpsTypeSeg");
  const fieldMac = document.getElementById("fieldMac");
  const fieldSensor = document.getElementById("fieldSensor");
  const macInput = document.getElementById("instMac");
  const sensorInput = document.getElementById("instSensor");
  const typeHint = document.getElementById("gpsTypeHint");

  function applyGpsType(type) {
    _gpsType = type;
    seg?.querySelectorAll(".seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.type === type);
    });
    if (type === "Normal") {
      fieldMac.style.display = "none";
      fieldSensor.style.display = "none";
      macInput.required = false;
      sensorInput.required = false;
      macInput.value = "";
      sensorInput.value = "";
      if (typeHint) typeHint.textContent = "Normal GPS — MAC ID aur Sensor No ki zaroorat nahi.";
    } else {
      fieldMac.style.display = "";
      fieldSensor.style.display = "";
      macInput.required = true;
      sensorInput.required = true;
      if (typeHint) typeHint.textContent = `${type} GPS — MAC ID aur Sensor No bharna zaroori hai.`;
    }
  }

  seg?.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyGpsType(btn.dataset.type));
  });
  applyGpsType("FMB"); // default

  document.getElementById("installForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    handleInstallSubmit(_gpsType);
  });

  // Barcode scan handlers — fill IMEI/SIM by scanning the device/card.
  document.getElementById("scanImei")?.addEventListener("click", () => {
    openBarcodeScannerModal({
      title: "📷 Scan IMEI",
      hint: "GPS device pe printed barcode ya QR code pe camera point karo.",
      onScan: (val) => {
        const cleaned = val.replace(/\D/g, "") || val.trim();
        document.getElementById("instImei").value = cleaned;
        showToast(`IMEI scanned: ${cleaned}`);
      },
    });
  });
  document.getElementById("scanSim")?.addEventListener("click", () => {
    openBarcodeScannerModal({
      title: "📷 Scan SIM ICCID",
      hint: "SIM card pe printed long number ya barcode pe camera point karo.",
      onScan: (val) => {
        const cleaned = val.replace(/\D/g, "") || val.trim();
        const input = document.getElementById("instSim");
        input.value = cleaned;
        input.dispatchEvent(new Event("input")); // trigger live lookup
        showToast(`ICCID scanned: ${cleaned}`);
      },
    });
  });

  // Live SIM lookup as Akash types the ICCID — shows whether the primary
  // is already known so he doesn't worry about the long number.
  document.getElementById("instSim")?.addEventListener("input", (e) => {
    const v = e.target.value.trim();
    const h = document.getElementById("instSimHint");
    if (!h) return;
    if (!v) {
      h.textContent = "Wahi number daalo jo SIM card pe printed hai (long 20-digit number). Primary number admin ke SIM database se automatic link ho jaayega.";
      h.className = "hint";
      return;
    }
    const sim = findSimBySecondary(v);
    if (sim && sim.primaryNumber) {
      h.textContent = `✓ SIM matched in database — ready to use.`;
      h.className = "hint hint-ok";
    } else if (sim && !sim.primaryNumber) {
      h.textContent = "⚠️ ICCID is in SIM database but primary not yet known — admin will fill it in Repair Progress.";
      h.className = "hint hint-warn";
    } else {
      h.textContent = "ℹ️ New ICCID — will be auto-added to SIM database. Admin can fill the primary number later.";
      h.className = "hint hint-info";
    }
  });
}

function handleInstallSubmit(gpsType = "FMB") {
  const isNormal = gpsType === "Normal";
  // gpsType IS the GPS Model — no separate model input field anymore
  const fields = {
    imei: document.getElementById("instImei"),
    vehicle: document.getElementById("instVehicle"),
    sim: document.getElementById("instSim"),
  };
  // MAC + Sensor only required for FMB / FMC
  if (!isNormal) {
    fields.mac = document.getElementById("instMac");
    fields.sensor = document.getElementById("instSensor");
  }

  let valid = true;
  Object.values(fields).forEach((el) => {
    el.classList.toggle("invalid", !el.value.trim());
    if (!el.value.trim()) valid = false;
  });
  if (!valid) {
    showToast(`Please fill all ${Object.keys(fields).length} fields.`, true);
    return;
  }

  const data = Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value.trim()]));
  data.model = gpsType; // Normal / FMB / FMC
  if (isNormal) {
    data.mac = "";
    data.sensor = "";
  }
  data.gpsType = gpsType;

  const macQuestion = isNormal
    ? "" // Normal GPS — no MAC question
    : `
      <div class="confirm-q">
        <span>MAC ID daal diya?</span>
        <div class="yes-no-group">
          <label class="yn-option"><input type="radio" name="macEntered" value="yes" /><span>Yes</span></label>
          <label class="yn-option"><input type="radio" name="macEntered" value="no" /><span>No</span></label>
        </div>
      </div>`;

  showModal(
    `
    <h3>Confirm Before Submit</h3>
    <p class="modal-desc">${isNormal ? "Confirm vehicle is live before submitting." : "Both answers must be <strong>Yes</strong> to submit."}</p>
    <div class="confirm-questions">
      <div class="confirm-q">
        <span>Vehicle live hai?</span>
        <div class="yes-no-group">
          <label class="yn-option"><input type="radio" name="vehicleLive" value="yes" /><span>Yes</span></label>
          <label class="yn-option"><input type="radio" name="vehicleLive" value="no" /><span>No</span></label>
        </div>
      </div>
      ${macQuestion}
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-primary modal-confirm">Submit</button>
    </div>
    `,
    async () => {
      const vehicleLive = modal.querySelector('input[name="vehicleLive"]:checked')?.value;
      const macEntered = isNormal ? "yes" : modal.querySelector('input[name="macEntered"]:checked')?.value;

      if (vehicleLive !== "yes" || macEntered !== "yes") {
        showToast("Both answers must be Yes to submit.", true);
        return false;
      }

      // Refresh data first so we never block on stale state (e.g., a row
      // that was deleted moments ago but still in local cache).
      try { await refreshAllData(); } catch {}

      const allInstalls = loadInstallations();
      const dupVehicle = allInstalls.find(
        (i) => i.vehicleNo.toLowerCase() === data.vehicle.toLowerCase()
      );
      const dupImei = allInstalls.find((i) =>
        i.imeiHistory.some((h) => h.value.toLowerCase() === data.imei.toLowerCase())
      );

      if (dupVehicle) {
        const proceed = await showConfirm({
          title: "Vehicle already has an install",
          message: `<strong>${escapeHtml(dupVehicle.vehicleNo)}</strong> already has an active installation:<br><br>
            • IMEI: <strong class="mono">${escapeHtml(getCurrentImei(dupVehicle) || "—")}</strong><br>
            • Created: ${escapeHtml(formatDateTime(dupVehicle.createdAt))} by ${escapeHtml(dupVehicle.createdBy || "—")}<br><br>
            Add another install for the same vehicle?`,
          confirmLabel: "Yes, add anyway",
          cancelLabel: "Cancel",
          danger: true,
        });
        if (!proceed) return false;
      }
      if (dupImei && (!dupVehicle || dupImei.id !== dupVehicle.id)) {
        const proceed = await showConfirm({
          title: "IMEI already in use",
          message: `IMEI <strong class="mono">${escapeHtml(data.imei)}</strong> is already in use on vehicle <strong>${escapeHtml(dupImei.vehicleNo)}</strong>.<br><br>
            Same device on multiple vehicles can confuse stock + portal reconciliation. Sure?`,
          confirmLabel: "Yes, add anyway",
          cancelLabel: "Cancel",
          danger: true,
        });
        if (!proceed) return false;
      }

      const now = new Date().toISOString();

      // The SIM input is now the SECONDARY (ICCID). Look up the primary from
      // the sims DB. If found, store the primary as simHistory.value (so
      // existing display code stays consistent). If unknown, store the ICCID
      // as a placeholder + secondaryValue, and queue an update_sim_primary
      // task for admin so they can fill the primary later.
      const enteredIccid = String(data.sim).trim();
      const knownSim = sims.find(
        (s) => (s.secondaryNumber || "").toLowerCase() === enteredIccid.toLowerCase()
      );
      const primaryValue = knownSim?.primaryNumber || null;
      const simHistEntry = {
        value: primaryValue || enteredIccid,
        secondaryValue: enteredIccid,
        addedAt: now,
        active: true,
        pendingDeactivation: false,
      };

      const installTasks = defaultInstallTasks();
      // If the SIM was unknown OR known but missing primary, also queue
      // an update_sim_primary install-task so admin sets it from the portal.
      if (!primaryValue) {
        installTasks.update_sim_primary = {
          completedAt: null,
          completedBy: null,
          simSecondary: enteredIccid,
        };
      }

      const newInstall = {
        id: generateId(),
        vehicleNo: data.vehicle,
        gpsModel: data.model,
        macId: data.mac,
        sensorNo: data.sensor,
        secondarySim: enteredIccid,
        imeiHistory: [{ value: data.imei, addedAt: now, active: true }],
        simHistory: [simHistEntry],
        tasks: installTasks,
        createdAt: now,
        createdBy: "akash",
      };

      // Auto-register the SIM in the sims DB if it wasn't there (primary may
      // be null — admin fills later via the pending task).
      if (!knownSim) {
        try {
          await upsertSim({
            primaryNumber: null,
            secondaryNumber: enteredIccid,
            notes: `Auto-added from install — ${data.vehicle}`,
          });
        } catch (simErr) {
          console.warn("Auto-register SIM failed:", simErr);
        }
      }

      const saved = await insertInstallation(newInstall);
      // Auto-consume matching stock entries.
      await consumeStockFor(
        {
          imei: data.imei,
          simSecondary: enteredIccid,
          sensorNo: data.sensor,
          macId: data.mac,
        },
        {
          installationId: saved?.id || newInstall.id,
          vehicleNo: data.vehicle,
          note: "Used on new installation",
        }
      );
      await refreshAllData();
      showToast("Installation saved successfully!");
      setView("akash-home");
      return true;
    }
  );
}

function renderRepairForm() {
  app.innerHTML = `
    ${renderHeader("Repair Work", "Maintenance on existing GPS installation")}
    <main class="main">
      <section class="card">
        <div class="form-nav">
          <button type="button" class="btn btn-secondary btn-sm" id="backBtn">← Back</button>
        </div>
        <h2>Repair / Maintenance</h2>
        <form id="repairForm">
          <div class="form-grid">
            <div class="field">
              <label for="repairImei">IMEI No</label>
              <input type="text" id="repairImei" placeholder="Enter IMEI to lookup" autocomplete="off" inputmode="numeric" />
              <p class="field-hint" id="imeiHint">Enter IMEI or select vehicle from database</p>
            </div>
            <div class="field">
              <label for="repairVehicle">Vehicle No / Name</label>
              <input type="text" id="repairVehicle" list="installedVehicles" placeholder="Search installed vehicle" autocomplete="off" />
              <datalist id="installedVehicles">
                ${loadInstallations()
                  .map((inst) => `<option value="${escapeHtml(inst.vehicleNo)}">${escapeHtml(getCurrentImei(inst))}</option>`)
                  .join("")}
              </datalist>
            </div>
          </div>

          <div class="work-section">
            <h3>What work is required?</h3>
            <label class="check-option"><input type="checkbox" id="workWiring" /><span>Wiring connection</span></label>
            <label class="check-option"><input type="checkbox" id="workSimChange" /><span>SIM change</span></label>
            <div class="conditional-field hidden" id="newSimBox">
              <label for="newSimNo">New SIM ICCID (Secondary number — 20-digit printed on card) <span class="required">*</span></label>
              <input type="text" id="newSimNo" placeholder="e.g. 89918720507069156677" autocomplete="off" inputmode="numeric" />
              <p class="hint" id="newSimHint">Enter the 20-digit ICCID. The system will look up the primary number from the SIM database automatically.</p>
            </div>
            <label class="check-option"><input type="checkbox" id="workDeviceChange" /><span>Device change</span></label>
            <div class="conditional-field hidden" id="newImeiBox">
              <label for="newImeiNo">New IMEI No <span class="required">*</span></label>
              <input type="text" id="newImeiNo" placeholder="Enter new IMEI number" autocomplete="off" inputmode="numeric" />
            </div>
            <label class="check-option"><input type="checkbox" id="workSensorOut" /><span>Sensor out for repair in office</span></label>
            <label class="check-option"><input type="checkbox" id="workSensorChanged" /><span>Sensor changed</span></label>
            <label class="check-option"><input type="checkbox" id="workDeviceOut" /><span>Device out for repair in office</span></label>
            <label class="check-option"><input type="checkbox" id="workOther" /><span>Other</span></label>
            <div class="conditional-field hidden" id="otherWorkBox">
              <label for="otherWorkText">Other repair detail <span class="required">*</span></label>
              <input type="text" id="otherWorkText" placeholder="Enter repair detail" autocomplete="off" />
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Submit Repair Work</button>
          </div>
        </form>
      </section>
    </main>
  `;

  bindLogout();
  document.getElementById("backBtn")?.addEventListener("click", () => setView("akash-home"));

  const imeiInput = document.getElementById("repairImei");
  const vehicleInput = document.getElementById("repairVehicle");
  const hint = document.getElementById("imeiHint");
  const simCheck = document.getElementById("workSimChange");
  const deviceCheck = document.getElementById("workDeviceChange");
  const otherCheck = document.getElementById("workOther");
  const newSimBox = document.getElementById("newSimBox");
  const newImeiBox = document.getElementById("newImeiBox");
  const otherWorkBox = document.getElementById("otherWorkBox");

  const applyInstallation = (inst) => {
    if (inst) {
      imeiInput.value = getCurrentImei(inst);
      vehicleInput.value = inst.vehicleNo;
      hint.textContent = `Found: ${inst.gpsModel} | Current SIM: ${getCurrentSim(inst)}`;
      hint.classList.add("hint-ok");
      imeiInput.classList.remove("invalid");
      vehicleInput.classList.remove("invalid");
    } else {
      hint.classList.remove("hint-ok");
    }
  };

  imeiInput.addEventListener("input", () => {
    const inst = findInstallationByImei(imeiInput.value);
    if (inst) {
      applyInstallation(inst);
    } else if (imeiInput.value.trim()) {
      vehicleInput.value = "";
      hint.textContent = "IMEI not found in installation database";
      hint.classList.remove("hint-ok");
    } else {
      vehicleInput.value = "";
      hint.textContent = "Enter IMEI from installation database";
      hint.classList.remove("hint-ok");
    }
  });

  vehicleInput.addEventListener("input", () => {
    const inst = findInstallationByVehicle(vehicleInput.value);
    if (inst) {
      applyInstallation(inst);
    } else if (vehicleInput.value.trim()) {
      imeiInput.value = "";
      hint.textContent = "Vehicle not found in installation database";
      hint.classList.remove("hint-ok");
    } else {
      imeiInput.value = "";
      hint.textContent = "Enter IMEI or select vehicle from database";
      hint.classList.remove("hint-ok");
    }
  });

  simCheck.addEventListener("change", () => {
    newSimBox.classList.toggle("hidden", !simCheck.checked);
    if (!simCheck.checked) {
      document.getElementById("newSimNo").value = "";
      const h = document.getElementById("newSimHint");
      if (h) {
        h.textContent = "Enter the 20-digit ICCID. The system will look up the primary number from the SIM database automatically.";
        h.className = "hint";
      }
    }
  });

  // Live SIM lookup as Akash types the ICCID.
  document.getElementById("newSimNo")?.addEventListener("input", (e) => {
    const v = e.target.value.trim();
    const h = document.getElementById("newSimHint");
    if (!h) return;
    if (!v) {
      h.textContent = "Enter the 20-digit ICCID. The system will look up the primary number from the SIM database automatically.";
      h.className = "hint";
      return;
    }
    const sim = findSimBySecondary(v);
    if (sim && sim.primaryNumber) {
      h.textContent = `✓ SIM matched in database — ready to use.`;
      h.className = "hint hint-ok";
    } else if (sim && !sim.primaryNumber) {
      h.textContent = "⚠️ ICCID known to the SIM database but primary number is still pending. Admin will be asked to update it.";
      h.className = "hint hint-warn";
    } else {
      h.textContent = "⚠️ ICCID not in SIM database yet. Admin will be asked to add the primary number after submission.";
      h.className = "hint hint-warn";
    }
  });
  deviceCheck.addEventListener("change", () => {
    newImeiBox.classList.toggle("hidden", !deviceCheck.checked);
    if (!deviceCheck.checked) document.getElementById("newImeiNo").value = "";
  });
  otherCheck.addEventListener("change", () => {
    otherWorkBox.classList.toggle("hidden", !otherCheck.checked);
    if (!otherCheck.checked) document.getElementById("otherWorkText").value = "";
  });

  document.getElementById("repairForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const imei = imeiInput.value.trim();
    const inst = findInstallationByImei(imei) || findInstallationByVehicle(vehicleInput.value);
    const wiring = document.getElementById("workWiring").checked;
    const simChange = simCheck.checked;
    const deviceChange = deviceCheck.checked;
    const sensorOutForRepair = document.getElementById("workSensorOut").checked;
    const sensorChanged = document.getElementById("workSensorChanged").checked;
    const deviceOutForRepair = document.getElementById("workDeviceOut").checked;
    const otherWork = otherCheck.checked;
    const newSim = document.getElementById("newSimNo").value.trim();
    const newImei = document.getElementById("newImeiNo").value.trim();
    const otherWorkText = document.getElementById("otherWorkText").value.trim();

    if (!inst) {
      imeiInput.classList.add("invalid");
      vehicleInput.classList.add("invalid");
      showToast("IMEI or vehicle not found in installation database.", true);
      return;
    }
    if (!wiring && !simChange && !deviceChange && !sensorOutForRepair && !sensorChanged && !deviceOutForRepair && !otherWork) {
      showToast("Select at least one work type.", true);
      return;
    }
    if (simChange && !newSim) {
      document.getElementById("newSimNo").classList.add("invalid");
      showToast("Enter new SIM number for SIM change.", true);
      return;
    }
    if (deviceChange && !newImei) {
      document.getElementById("newImeiNo").classList.add("invalid");
      showToast("Enter new IMEI for device change.", true);
      return;
    }
    if (otherWork && !otherWorkText) {
      document.getElementById("otherWorkText").classList.add("invalid");
      showToast("Enter details for Other repair work.", true);
      return;
    }

    const updatedInst = {
      ...inst,
      imeiHistory: inst.imeiHistory.map((item) => ({ ...item })),
      simHistory: inst.simHistory.map((item) => ({ ...item })),
    };
    const now = new Date().toISOString();
    const currentSim = getCurrentSim(updatedInst);
    const currentImei = getCurrentImei(updatedInst);
    let simDeactivationPending = false;
    let oldSimNo = null;
    let oldImei = null;
    let unknownSimSecondary = null;
    let newSimStored = newSim; // What we actually store in simHistory.value

    if (simChange) {
      oldSimNo = currentSim;
      // Akash entered the secondary (ICCID). Look up the primary from the SIM
      // database. If found, store the primary as the active SIM value. If
      // not, store the secondary as a placeholder and queue a pending task
      // for the admin to update the primary number.
      const sim = findSimBySecondary(newSim);
      if (sim && sim.primaryNumber) {
        newSimStored = sim.primaryNumber;
      } else {
        newSimStored = newSim; // placeholder = secondary
        unknownSimSecondary = newSim;
        // Pre-register the SIM in the inventory so admin can find it later.
        try {
          await upsertSim({ primaryNumber: null, secondaryNumber: newSim });
        } catch (err) {
          // Non-fatal: continue even if the sims table isn't ready.
          console.warn("Could not pre-register SIM in sims table:", err);
        }
      }
      updatedInst.simHistory.forEach((s) => {
        if (s.active) s.pendingDeactivation = true;
      });
      updatedInst.simHistory.push({
        value: newSimStored,
        secondaryValue: newSim,
        addedAt: now,
        active: true,
        pendingDeactivation: false,
      });
      simDeactivationPending = true;
    }
    if (deviceChange) {
      oldImei = currentImei;
      updatedInst.imeiHistory.forEach((i) => {
        i.active = false;
      });
      updatedInst.imeiHistory.push({ value: newImei, addedAt: now, active: true });
    }

    const newRecord = {
      id: generateId(),
      installationId: inst.id,
      imei: currentImei,
      vehicleNo: inst.vehicleNo,
      wiringConnection: wiring,
      simChange,
      newSimNo: simChange ? newSimStored : null,
      deviceChange,
      newImei: deviceChange ? newImei : null,
      sensorOutForRepair,
      sensorChanged,
      deviceOutForRepair,
      otherWorkText: otherWork ? otherWorkText : null,
      oldSimNo,
      oldImei,
      simDeactivationPending,
      simDeactivated: false,
      simDeactivatedAt: null,
      tasks: buildTasksForRepair({
        simChange,
        deviceChange,
        deviceOutForRepair,
        sensorOutForRepair,
        unknownSimSecondary,
      }),
      createdAt: now,
      createdBy: "akash",
    };

    try {
      await updateInstallation(updatedInst);
      const savedRecord = await insertMaintenanceRecord(newRecord);
      // Auto-consume newly-used stock entries.
      await consumeStockFor(
        {
          imei: deviceChange ? newImei : null,
          simSecondary: simChange ? newSim : null,
        },
        {
          installationId: inst.id,
          maintenanceRecordId: savedRecord?.id || newRecord.id,
          vehicleNo: inst.vehicleNo,
          note: "Used during repair",
        }
      );
      await refreshAllData();
      showToast("Repair work saved successfully!");
      setView("akash-home");
    } catch (err) {
      showToast(err.message || "Failed to save repair work.", true);
    }
  });
}

function downloadInstallationSample() {
  downloadXlsx(
    "installation-upload-sample.xlsx",
    [
      ["imei", "vehicle_no", "gps_model", "sim_no", "mac_id", "sensor_no", "created_at", "created_by"],
      ["867530012345678", "MH12AB1234", "GT06N", "9876543210", "AA:BB:CC:DD:EE:FF", "SN-12345", "2026-05-25 10:30", "akash"],
    ],
    "Sheet1",
    ["imei", "sim_no", "mac_id", "sensor_no"]
  );
}

function downloadRepairSample() {
  downloadXlsx(
    "repair-upload-sample.xlsx",
    [
      ["imei", "wiring_connection", "sim_change", "new_sim_no", "device_change", "new_imei", "sensor_out_for_repair", "sensor_changed", "device_out_for_repair", "other_work_text", "created_at", "created_by"],
      ["867530012345678", "yes", "yes", "9876500000", "no", "", "no", "no", "no", "", "2026-05-25 11:00", "akash"],
      ["867530012345678", "no", "no", "", "yes", "867530012345679", "yes", "no", "yes", "Bracket broken", "2026-05-25 12:00", "akash"],
    ],
    "Sheet1",
    ["imei", "new_sim_no", "new_imei"]
  );
}

function downloadSimSample() {
  downloadXlsx(
    "sim-database-sample.xlsx",
    [
      ["primary_number", "secondary_number", "notes"],
      ["5753200309565", "89918720507069157022", ""],
      ["5753200309623", "89918720507069156917", ""],
      ["", "89918720507069158640", "Primary not yet known"],
    ],
    "Sheet1",
    ["primary_number", "secondary_number"]
  );
}

async function importSimsFromExcel(file) {
  const rows = await readXlsxFile(file);
  if (!rows.length) {
    showToast("Upload file is empty.", true);
    return;
  }
  // Pre-scan to detect swap candidates so we can ask the admin once
  // upfront rather than row-by-row.
  let swapCandidates = 0;
  const parsed = rows.map((row) => {
    const secondary = String(
      row.secondary_number || row.secondary || row.iccid || row.secondary_sim || ""
    ).trim();
    const primary = String(
      row.primary_number || row.primary || row.primary_sim || ""
    ).trim();
    if (pairLooksSwapped(primary, secondary)) swapCandidates += 1;
    return { primary, secondary, notes: String(row.notes || "").trim() || null };
  });
  let autoSwap = false;
  if (swapCandidates > 0) {
    autoSwap = await showConfirm({
      title: "Some rows look swapped",
      message: `${swapCandidates} of ${rows.length} Excel rows have a 20-digit ICCID in the <strong>primary_number</strong> column and a short number in the <strong>secondary_number</strong> column. Auto-swap them before saving?`,
      confirmLabel: "Yes, swap & save",
    });
  }
  let saved = 0;
  const errors = [];
  for (const [index, row] of parsed.entries()) {
    const rowNo = index + 2;
    let { primary, secondary, notes } = row;
    if (autoSwap && pairLooksSwapped(primary, secondary)) {
      const tmp = primary;
      primary = secondary;
      secondary = tmp;
    }
    if (!secondary) {
      errors.push(`Row ${rowNo}: secondary_number is required`);
      continue;
    }
    try {
      await upsertSim({
        primaryNumber: primary || null,
        secondaryNumber: secondary,
        notes,
      });
      saved += 1;
    } catch (err) {
      if (err.code === SIMS_TABLE_MISSING) {
        errors.push(`Row ${rowNo}: sims table missing — run sims-table-migration.sql first`);
      } else {
        errors.push(`Row ${rowNo}: ${err.message}`);
      }
    }
  }
  await refreshAllData();
  render();
  showToast(
    `${saved} SIM${saved === 1 ? "" : "s"} saved.${errors.length ? ` ${errors.length} skipped.` : ""}`,
    saved === 0
  );
  if (errors.length) showImportReport(errors);
}

async function importInstallations(file) {
  const rows = await readXlsxFile(file);
  if (!rows.length) {
    showToast("Upload file is empty.", true);
    return;
  }

  let imported = 0;
  const errors = [];
  const allInstalls = [...loadInstallations()];

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const imei = row.imei;
    const vehicleNo = row.vehicle_no || row.vehicle;
    const gpsModel = row.gps_model || row.model;
    const simNo = row.sim_no || row.sim;
    const macId = row.mac_id || row.mac;
    const sensorNo = row.sensor_no || row.sensor;

    if (!imei || !vehicleNo || !gpsModel || !simNo || !macId || !sensorNo) {
      errors.push(`Row ${rowNo}: missing required installation fields`);
      continue;
    }
    if (allInstalls.some((inst) => inst.vehicleNo.toLowerCase() === vehicleNo.toLowerCase())) {
      errors.push(`Row ${rowNo}: duplicate vehicle ${vehicleNo}`);
      continue;
    }
    if (allInstalls.some((inst) => activeImeiMatches(inst, imei))) {
      errors.push(`Row ${rowNo}: duplicate IMEI ${imei}`);
      continue;
    }

    const createdAt = normalizeDate(row.created_at);
    const newInstall = {
      id: generateId(),
      vehicleNo,
      gpsModel,
      macId,
      sensorNo,
      secondarySim: row.secondary_sim || null,
      imeiHistory: [{ value: imei, addedAt: createdAt, active: true }],
      simHistory: [{ value: simNo, addedAt: createdAt, active: true, pendingDeactivation: false }],
      tasks: defaultInstallTasks(),
      createdAt,
      createdBy: row.created_by || "admin",
    };

    try {
      const saved = await insertInstallation(newInstall);
      allInstalls.push(saved);
      imported += 1;
    } catch (err) {
      errors.push(`Row ${rowNo}: ${err.message}`);
    }
  }

  await refreshAllData();
  render();
  showToast(`${imported} installation${imported === 1 ? "" : "s"} uploaded.${errors.length ? ` ${errors.length} skipped.` : ""}`, imported === 0);
  if (errors.length) showImportReport(errors);
}

async function importRepairs(file) {
  const rows = await readXlsxFile(file);
  if (!rows.length) {
    showToast("Upload file is empty.", true);
    return;
  }

  let imported = 0;
  const errors = [];
  const localInstalls = loadInstallations().map((inst) => ({
    ...inst,
    imeiHistory: inst.imeiHistory.map((item) => ({ ...item })),
    simHistory: inst.simHistory.map((item) => ({ ...item })),
  }));
  const findLocalByImei = (imei) => {
    const q = imei.trim().toLowerCase();
    return localInstalls.find((inst) => inst.imeiHistory.some((i) => i.value.toLowerCase() === q));
  };

  for (const [index, row] of rows.entries()) {
    const rowNo = index + 2;
    const imei = row.imei;
    const wiringConnection = normalizeBool(row.wiring_connection || row.wiring);
    const simChange = normalizeBool(row.sim_change);
    const deviceChange = normalizeBool(row.device_change);
    const sensorOutForRepair = normalizeBool(row.sensor_out_for_repair);
    const sensorChanged = normalizeBool(row.sensor_changed);
    const deviceOutForRepair = normalizeBool(row.device_out_for_repair);
    const otherWorkText = row.other_work_text || row.other || "";
    const newSimNo = row.new_sim_no || row.new_sim || "";
    const newImei = row.new_imei || "";

    if (!imei) {
      errors.push(`Row ${rowNo}: IMEI is required`);
      continue;
    }
    if (!wiringConnection && !simChange && !deviceChange && !sensorOutForRepair && !sensorChanged && !deviceOutForRepair && !otherWorkText) {
      errors.push(`Row ${rowNo}: select at least one repair work type`);
      continue;
    }
    if (simChange && !newSimNo) {
      errors.push(`Row ${rowNo}: new_sim_no is required for SIM change`);
      continue;
    }
    if (deviceChange && !newImei) {
      errors.push(`Row ${rowNo}: new_imei is required for device change`);
      continue;
    }

    const inst = findLocalByImei(imei);
    if (!inst) {
      errors.push(`Row ${rowNo}: IMEI ${imei} not found in installations`);
      continue;
    }

    const createdAt = normalizeDate(row.created_at);
    const currentSim = getCurrentSim(inst);
    const currentImei = getCurrentImei(inst);
    let oldSimNo = null;
    let oldImei = null;
    let simDeactivationPending = false;

    if (simChange) {
      oldSimNo = currentSim;
      inst.simHistory.forEach((item) => {
        if (item.active) item.pendingDeactivation = true;
      });
      inst.simHistory.push({ value: newSimNo, addedAt: createdAt, active: true, pendingDeactivation: false });
      simDeactivationPending = true;
    }
    if (deviceChange) {
      oldImei = currentImei;
      inst.imeiHistory.forEach((item) => {
        item.active = false;
      });
      inst.imeiHistory.push({ value: newImei, addedAt: createdAt, active: true });
    }

    const newRecord = {
      id: generateId(),
      installationId: inst.id,
      imei: currentImei,
      vehicleNo: inst.vehicleNo,
      wiringConnection,
      simChange,
      newSimNo: simChange ? newSimNo : null,
      deviceChange,
      newImei: deviceChange ? newImei : null,
      sensorOutForRepair,
      sensorChanged,
      deviceOutForRepair,
      otherWorkText: otherWorkText || null,
      oldSimNo,
      oldImei,
      simDeactivationPending,
      simDeactivated: false,
      simDeactivatedAt: null,
      tasks: buildTasksForRepair({ simChange, deviceChange, deviceOutForRepair, sensorOutForRepair }),
      createdAt,
      createdBy: row.created_by || "admin",
    };

    try {
      await updateInstallation(inst);
      await insertMaintenanceRecord(newRecord);
      imported += 1;
    } catch (err) {
      errors.push(`Row ${rowNo}: ${err.message}`);
    }
  }

  await refreshAllData();
  render();
  showToast(`${imported} repair record${imported === 1 ? "" : "s"} uploaded.${errors.length ? ` ${errors.length} skipped.` : ""}`, imported === 0);
  if (errors.length) showImportReport(errors);
}

function showImportReport(errors) {
  showModal(`
    <h3>Upload report</h3>
    <p class="modal-desc">Some rows were skipped. Please fix these rows and upload again.</p>
    <div class="import-errors">${errors.map((error) => `<div>${escapeHtml(error)}</div>`).join("")}</div>
    <div class="modal-actions"><button type="button" class="btn btn-primary modal-close">OK</button></div>
  `);
}

/* ---------------- Installation editing (admin) ---------------- */

function openEditInstallation(id) {
  const inst = loadInstallations().find((i) => i.id === id);
  if (!inst) return;

  showModal(
    `
    <h3>Edit Installation</h3>
    <p class="modal-desc">Fix details for <strong>${escapeHtml(inst.vehicleNo)}</strong>. IMEI / primary SIM history are managed through repair work.</p>
    <div class="edit-grid">
      <div class="field"><label for="editVehicle">Vehicle No</label><input type="text" id="editVehicle" value="${escapeHtml(inst.vehicleNo)}" autocomplete="off" /></div>
      <div class="field"><label for="editModel">GPS Model</label><input type="text" id="editModel" value="${escapeHtml(inst.gpsModel)}" autocomplete="off" /></div>
      <div class="field"><label for="editMac">MAC ID</label><input type="text" id="editMac" value="${escapeHtml(inst.macId)}" autocomplete="off" /></div>
      <div class="field"><label for="editSensor">Sensor No</label><input type="text" id="editSensor" value="${escapeHtml(inst.sensorNo)}" autocomplete="off" /></div>
      <div class="field full-width"><label for="editSecondarySim">Secondary No <span class="field-tag">admin only</span></label><input type="text" id="editSecondarySim" value="${escapeHtml(inst.secondarySim || "")}" placeholder="Optional backup / Secondary No" autocomplete="off" inputmode="numeric" /></div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-primary modal-confirm">Save changes</button>
    </div>
    `,
    async () => {
      const vehicleNo = document.getElementById("editVehicle").value.trim();
      const gpsModel = document.getElementById("editModel").value.trim();
      const macId = document.getElementById("editMac").value.trim();
      const sensorNo = document.getElementById("editSensor").value.trim();
      const secondarySim = document.getElementById("editSecondarySim").value.trim();

      if (!vehicleNo || !gpsModel || !macId || !sensorNo) {
        showToast("Vehicle, model, MAC and sensor are required.", true);
        return false;
      }
      const clash = loadInstallations().some((i) => i.id !== inst.id && i.vehicleNo.toLowerCase() === vehicleNo.toLowerCase());
      if (clash) {
        showToast("Another installation already uses that vehicle number.", true);
        return false;
      }

      const updated = { ...inst, vehicleNo, gpsModel, macId, sensorNo, secondarySim: secondarySim || null };
      try {
        await updateInstallation(updated);
        await refreshAllData();
        showToast("Installation updated.");
        render();
        return true;
      } catch (err) {
        showToast(err.message || "Failed to update installation.", true);
        return false;
      }
    }
  );
}

/* ---------------- Pending actions card ---------------- */

function renderPendingActions() {
  const totalPending = getPendingActionRows().length;

  // Every task (pending + completed), grouped by vehicle.
  const groupsMap = new Map();
  let anyTask = false;

  // Include install-level tasks (Update on Portal + Vehicle number check)
  for (const inst of loadInstallations()) {
    const tasks = getInstallTasks(inst);
    for (const type of INSTALL_TASK_TYPES) {
      anyTask = true;
      const tState = tasks[type] || { completedAt: null };
      const task = {
        id: `inst-${inst.id}-${type}`,
        type,
        done: Boolean(tState.completedAt),
        completedAt: tState.completedAt || null,
        completedBy: tState.completedBy || null,
        remark: tState.remark || null,
        remarkBy: tState.remarkBy || null,
      };
      const key = inst.id;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          vehicleNo: inst.vehicleNo,
          installationId: inst.id,
          latest: inst.createdAt,
          items: [],
        });
      }
      const g = groupsMap.get(key);
      // Pseudo-record for the install task, carrying the install info.
      const pseudoRecord = {
        id: inst.id,
        vehicleNo: inst.vehicleNo,
        installationId: inst.id,
        createdAt: inst.createdAt,
      };
      g.items.push({ kind: "installation", record: pseudoRecord, task });
      if (new Date(inst.createdAt) > new Date(g.latest)) g.latest = inst.createdAt;
    }
  }

  // Maintenance / repair tasks
  for (const record of loadMaintenance()) {
    for (const task of getTasks(record)) {
      anyTask = true;
      const key = record.installationId || `veh:${record.vehicleNo}`;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          vehicleNo: record.vehicleNo,
          installationId: record.installationId,
          latest: record.createdAt,
          items: [],
        });
      }
      const g = groupsMap.get(key);
      g.items.push({ kind: "maintenance", record, task });
      if (new Date(record.createdAt) > new Date(g.latest)) g.latest = record.createdAt;
    }
  }
  if (!anyTask) return "";

  const counts = { Portal: 0, SIM: 0, Service: 0 };
  getPendingActionRows().forEach((r) => {
    const cat = taskFlow(r.task.type)?.category;
    if (cat in counts) counts[cat] += 1;
  });

  const chip = (key, label) =>
    `<button type="button" class="filter-chip ${pendingFilter === key ? "active" : ""}" data-filter="${key}">${label}</button>`;

  let groups = [...groupsMap.values()];

  // Category filter applies to which tasks are shown.
  if (pendingFilter !== "all") {
    groups = groups
      .map((g) => ({ ...g, items: g.items.filter((it) => taskFlow(it.task.type)?.category === pendingFilter) }))
      .filter((g) => g.items.length);
  }

  // A group is "active" if it still has a pending task. By default only
  // active groups show (so completed tasks stay visible alongside their
  // still-pending siblings, but fully-done vehicles drop off). The toggle
  // reveals fully-completed vehicles too.
  let visibleGroups = groups.filter((g) => showCompleted || g.items.some((it) => !isTaskDone(it.task)));
  visibleGroups.sort((a, b) => new Date(b.latest) - new Date(a.latest));

  const taskRow = (record, task, kind) => {
    const flow = taskFlow(task.type);
    const done = isTaskDone(task);
    const dataKind = ` data-kind="${kind}"`;
    const action = done
      ? `<div class="vg-task-done">
           <span class="badge badge-ok">✓ Completed${task.completedAt ? " · " + escapeHtml(formatDateTime(task.completedAt)) : ""}</span>
           <button type="button" class="btn btn-outline btn-sm task-undo" data-record="${record.id}" data-task="${escapeHtml(task.id)}"${dataKind}>↩ Undo</button>
         </div>`
      : `<div class="vg-task-pending">
           <span class="badge badge-warn">Pending</span>
           <button type="button" class="btn btn-primary btn-sm task-complete" data-record="${record.id}" data-task="${escapeHtml(task.id)}"${dataKind}>✓ Complete</button>
         </div>`;
    const remarkLine = task.remark
      ? `<div class="vg-task-remark has-remark">
           <span class="remark-icon">📝</span>
           <span class="remark-text">${escapeHtml(task.remark)}</span>
           ${task.remarkBy ? `<span class="remark-meta">— ${escapeHtml(task.remarkBy)}</span>` : ""}
           <button type="button" class="remark-btn task-remark" data-record="${record.id}" data-task="${escapeHtml(task.id)}"${dataKind}>Edit</button>
         </div>`
      : `<div class="vg-task-remark">
           <button type="button" class="remark-btn task-remark" data-record="${record.id}" data-task="${escapeHtml(task.id)}"${dataKind}>+ Add remark</button>
         </div>`;
    return `
      <div class="vg-task ${done ? "is-done" : ""}">
        <div class="vg-task-body">
          <div class="vg-task-main">
            <span class="action-icon">${flow.icon}</span>
            <span class="vg-task-label">${escapeHtml(flow.label)}</span>
            <span class="vg-task-detail">${taskDetail(record, task, kind)}</span>
            <span class="vg-task-date">${escapeHtml(formatDateTime(record.createdAt))}</span>
          </div>
          ${remarkLine}
        </div>
        ${action}
      </div>`;
  };

  const groupsHtml = visibleGroups
    .map((g) => {
      const inst =
        loadInstallations().find((i) => i.id === g.installationId) ||
        loadInstallations().find((i) => i.vehicleNo.toLowerCase() === (g.vehicleNo || "").toLowerCase());
      const editBtn = inst
        ? `<button type="button" class="btn btn-outline btn-sm vg-edit" data-inst="${inst.id}">✎ Edit installation</button>`
        : "";
      const pendingItems = g.items.filter((it) => !isTaskDone(it.task));
      const doneItems = g.items.filter((it) => isTaskDone(it.task));
      const ordered = [...pendingItems, ...doneItems];
      const tasksHtml = ordered.map(({ kind, record, task }) => taskRow(record, task, kind)).join("");
      const doneBadge = doneItems.length ? `<span class="vg-count done">${doneItems.length} done</span>` : "";
      const pendBadge = pendingItems.length
        ? `<span class="vg-count">${pendingItems.length} pending</span>`
        : `<span class="vg-count all-done">All done</span>`;
      return `
        <div class="vehicle-group">
          <div class="vehicle-group-head">
            <div class="vg-head-left">
              <span class="vg-name">${escapeHtml(g.vehicleNo)}</span>
              ${pendBadge}
              ${doneBadge}
            </div>
            ${editBtn}
          </div>
          <div class="vg-tasks">${tasksHtml}</div>
        </div>`;
    })
    .join("");

  const emptyMsg = showCompleted
    ? "No actions match this filter."
    : totalPending === 0
    ? "🎉 All actions completed. Toggle “Show completed” to review history."
    : `No pending ${pendingFilter === "all" ? "" : pendingFilter + " "}actions.`;

  return `
    <section class="card alert-card">
      <div class="section-heading">
        <div>
          <h2>⚠️ Pending Actions (${totalPending})</h2>
          <p class="alert-desc">Grouped by vehicle. Tap <strong>Complete</strong> when a task is done — it stays here marked completed (use Undo to reopen).</p>
        </div>
        <button type="button" class="btn btn-secondary btn-sm" id="exportPending">⬇ Export</button>
      </div>
      <div class="pending-filter">
        ${chip("all", `All ${totalPending}`)}
        ${chip("Portal", `🖥️ Portal ${counts.Portal}`)}
        ${chip("SIM", `📵 SIM Deactivate ${counts.SIM}`)}
        ${chip("Service", `🔧 Service ${counts.Service}`)}
        <button type="button" class="filter-chip toggle-chip ${showCompleted ? "active" : ""}" id="toggleCompleted">
          ${showCompleted ? "✓ " : ""}Show completed
        </button>
      </div>
      ${visibleGroups.length ? groupsHtml : `<p class="muted">${emptyMsg}</p>`}
    </section>
  `;
}

/* ---------------- Vehicle timeline page ---------------- */

function buildVehicleTimeline(inst) {
  const events = [{ type: "install", date: inst.createdAt, by: inst.createdBy, inst }];
  loadMaintenance()
    .filter(
      (m) =>
        m.installationId === inst.id ||
        m.vehicleNo.toLowerCase() === inst.vehicleNo.toLowerCase()
    )
    .forEach((m) => events.push({ type: "repair", date: m.createdAt, by: m.createdBy, record: m }));
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  return events;
}

/* ---------------- Page: Deletion audit log ---------------- */

function renderDeletionsPage() {
  const log = deletionLog;

  // Counts by entity type
  const counts = {
    installation: 0,
    maintenance: 0,
    stock_item: 0,
    other: 0,
  };
  for (const d of log) {
    if (counts[d.entityType] != null) counts[d.entityType] += 1;
    else counts.other += 1;
  }

  const typeIcon = {
    installation: "🆕",
    maintenance: "🔧",
    stock_item: "📦",
    sim: "📶",
    category: "🏷️",
    supplier: "🏪",
  };
  const typeLabel = {
    installation: "Installation",
    maintenance: "Repair",
    stock_item: "Stock item",
    sim: "SIM",
    category: "Category",
    supplier: "Supplier",
  };

  app.innerHTML = `
    ${renderHeader("Deletion Audit Log", "Every delete action across the app, with reason")}
    <main class="main">
      ${renderAdminNav("deletions")}
      <div class="summary-grid">
        <div class="summary-box"><strong>${log.length}</strong><span>Total deletions</span></div>
        <div class="summary-box summary-warn"><strong>${counts.installation}</strong><span>Installations</span></div>
        <div class="summary-box summary-warn"><strong>${counts.maintenance}</strong><span>Repairs</span></div>
        <div class="summary-box"><strong>${counts.stock_item}</strong><span>Stock items</span></div>
      </div>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All deletions (${log.length})</h2>
            <p class="section-subtitle">Newest first. This log is immutable — even if the row is deleted from its main table, the deletion record stays here for accountability.</p>
          </div>
          ${!deletionLogTableReady ? `<span class="badge badge-warn">deletion_log table missing — run migration</span>` : ""}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Type</th>
                <th>What was deleted</th>
                <th>Reason</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              ${log.length
                ? log
                    .map(
                      (d) => `
                        <tr>
                          <td class="date-cell">${escapeHtml(formatDateTime(d.deletedAt))}</td>
                          <td>
                            <span class="cat-pill" title="${escapeHtml(d.entityType)}">
                              ${typeIcon[d.entityType] || "🗑️"} ${escapeHtml(typeLabel[d.entityType] || d.entityType)}
                            </span>
                          </td>
                          <td class="mono">${escapeHtml(d.entityLabel || d.entityId || "—")}</td>
                          <td><span class="reason-text">${escapeHtml(d.reason || "—")}</span></td>
                          <td>${escapeHtml(d.deletedBy || "—")}</td>
                        </tr>`
                    )
                    .join("")
                : `<tr class="empty-row"><td colspan="5">No deletions recorded yet.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;
  bindAdminNav();
  bindLogout();
}

function openVehicleTimelineModal(installationId) {
  const inst = loadInstallations().find((i) => i.id === installationId);
  if (!inst) return;
  const events = buildVehicleTimeline(inst);
  const eventsHtml = events
    .map((ev) => {
      if (ev.type === "install") {
        const i = ev.inst;
        const primary = resolvePrimarySim(getCurrentSim(i));
        const detail = `IMEI ${i.imeiHistory[0]?.value || "—"} · SIM ${primary || i.simHistory[0]?.value || "—"} · ${escapeHtml(i.gpsModel)} · MAC ${escapeHtml(i.macId)} · Sensor ${escapeHtml(i.sensorNo)}`;
        return `
          <li class="tl-event tl-install">
            <span class="tl-dot"></span>
            <div class="tl-body">
              <div class="tl-title"><span class="badge badge-ok">Installed</span></div>
              <div class="tl-detail">${detail}</div>
              <div class="tl-date">${escapeHtml(formatDateTime(ev.date))}${ev.by ? " · by " + escapeHtml(ev.by) : ""}</div>
            </div>
          </li>`;
      }
      const m = ev.record;
      return `
        <li class="tl-event tl-repair">
          <span class="tl-dot"></span>
          <div class="tl-body">
            <div class="tl-title"><span class="badge badge-repair">Repair</span></div>
            <div class="tl-detail">${escapeHtml(workLabels(m))}${m.otherWorkText ? " · " + escapeHtml(m.otherWorkText) : ""}</div>
            <div class="tl-date">${escapeHtml(formatDateTime(ev.date))}${m.createdBy ? " · by " + escapeHtml(m.createdBy) : ""}</div>
          </div>
        </li>`;
    })
    .join("");

  modal.innerHTML = `
    <h3>📅 Timeline · <span class="mono">${escapeHtml(inst.vehicleNo)}</span></h3>
    <p class="modal-desc">${events.length} event${events.length === 1 ? "" : "s"} — newest at the bottom.</p>
    <div class="tl-modal-body">
      <ul class="tl-events">${eventsHtml || `<li class="muted">No events recorded.</li>`}</ul>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="close">Close</button>
    </div>
  `;
  modal.classList.add("modal-wide");
  modalOverlay.classList.remove("hidden");
  const onClose = () => {
    modal.classList.remove("modal-wide");
    closeModal();
  };
  modal.querySelector('[data-act="close"]').onclick = onClose;
  modalOverlay.onclick = (e) => { if (e.target === modalOverlay) onClose(); };
}

function renderTimeline() {
  const q = timelineQuery.toLowerCase().trim();
  const allInstalls = loadInstallations();

  let matches = allInstalls.filter((inst) => {
    if (!q) return true;
    const hay = [
      inst.vehicleNo,
      inst.gpsModel,
      inst.secondarySim || "",
      ...inst.imeiHistory.map((h) => h.value),
      ...inst.simHistory.map((s) => s.value),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });

  // Most recently active vehicles first.
  const lastActivity = (inst) => {
    const ev = buildVehicleTimeline(inst);
    return ev.length ? ev[ev.length - 1].date : inst.createdAt;
  };
  matches.sort((a, b) => new Date(lastActivity(b)) - new Date(lastActivity(a)));

  const CAP = 40;
  const shown = matches.slice(0, CAP);
  const more = matches.length - shown.length;

  const cardsHtml = shown
    .map((inst) => {
      const events = buildVehicleTimeline(inst);
      const eventsHtml = events
        .map((ev) => {
          if (ev.type === "install") {
            const i = ev.inst;
            const detail = `IMEI ${i.imeiHistory[0]?.value || "—"} · SIM ${i.simHistory[0]?.value || "—"} · ${escapeHtml(i.gpsModel)} · MAC ${escapeHtml(i.macId)} · Sensor ${escapeHtml(i.sensorNo)}`;
            return `
              <li class="tl-event tl-install">
                <span class="tl-dot"></span>
                <div class="tl-body">
                  <div class="tl-title"><span class="badge badge-ok">Installed</span></div>
                  <div class="tl-detail">${detail}</div>
                  <div class="tl-date">${escapeHtml(formatDateTime(ev.date))}${ev.by ? " · by " + escapeHtml(ev.by) : ""}</div>
                </div>
              </li>`;
          }
          const m = ev.record;
          return `
            <li class="tl-event tl-repair">
              <span class="tl-dot"></span>
              <div class="tl-body">
                <div class="tl-title"><span class="badge badge-repair">Repair</span></div>
                <div class="tl-detail">${escapeHtml(workLabels(m))}</div>
                <div class="tl-date">${escapeHtml(formatDateTime(ev.date))}${m.createdBy ? " · by " + escapeHtml(m.createdBy) : ""}</div>
              </div>
            </li>`;
        })
        .join("");

      const curImei = getCurrentImei(inst);
      const curSim = getCurrentSim(inst);
      return `
        <div class="timeline-card">
          <div class="timeline-head">
            <div class="vg-head-left">
              <span class="vg-name">${escapeHtml(inst.vehicleNo)}</span>
              <span class="tl-count">${events.length} event${events.length === 1 ? "" : "s"}</span>
            </div>
            <div class="tl-meta">
              <span class="mono">${escapeHtml(curImei)}</span> · SIM <span class="mono">${escapeHtml(curSim)}</span>
            </div>
          </div>
          <ol class="timeline">${eventsHtml}</ol>
        </div>`;
    })
    .join("");

  app.innerHTML = `
    ${renderHeader("Vehicle Timeline", "Installation & repair history per vehicle")}
    <main class="main">
      ${renderAdminNav("timeline")}
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>Vehicle Timeline</h2>
            <p class="section-subtitle">Search or pick a vehicle to see when it was installed and every repair since.</p>
          </div>
        </div>
        <div class="timeline-search">
          <input type="search" id="timelineSearch" list="tlVehicles" placeholder="Search or select vehicle (name, IMEI, SIM)..." value="${escapeHtml(timelineQuery)}" autocomplete="off" />
          <datalist id="tlVehicles">
            ${allInstalls.map((i) => `<option value="${escapeHtml(i.vehicleNo)}">${escapeHtml(getCurrentImei(i))}</option>`).join("")}
          </datalist>
          ${timelineQuery ? `<button type="button" class="btn btn-secondary btn-sm" id="timelineClear">Clear</button>` : ""}
        </div>
        <p class="section-subtitle tl-resultcount">${matches.length} vehicle${matches.length === 1 ? "" : "s"}${more > 0 ? ` · showing first ${CAP}, narrow your search to see the rest` : ""}</p>
        ${shown.length ? cardsHtml : `<p class="muted">No vehicles match "${escapeHtml(timelineQuery)}".</p>`}
      </section>
    </main>
  `;

  bindLogout();
  bindAdminNav();

  const searchEl = document.getElementById("timelineSearch");
  searchEl?.addEventListener("input", (e) => {
    timelineQuery = e.target.value;
    // Re-render but keep focus + caret on the search box.
    render();
    const el = document.getElementById("timelineSearch");
    if (el) {
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    }
  });
  document.getElementById("timelineClear")?.addEventListener("click", () => {
    timelineQuery = "";
    setView("timeline");
  });
}

/* ============================================================
   ADMIN PAGE FRAMEWORK
   ============================================================ */

const ADMIN_NAV = [
  { key: "dashboard",     view: "dashboard",     icon: "⌂", label: "Home",      labelLong: "Home" },
  { key: "installations", view: "installations", icon: "⊞", label: "Installs",  labelLong: "Installations" },
  { key: "repairs",       view: "repairs",       icon: "⚒", label: "Repairs",   labelLong: "Repair Work" },
  { key: "pending",       view: "pending",       icon: "◷", label: "Progress",  labelLong: "Repair Progress" },
  { key: "sim-db",        view: "sim-db",        icon: "≣", label: "SIMs",      labelLong: "SIM Database" },
  { key: "stock",         view: "stock",         icon: "▦", label: "Stock",     labelLong: "Stock" },
  { key: "accounts",      view: "accounts",      icon: "₹", label: "Accounts",  labelLong: "Accounts" },
];

// Returns nav items the current user can access
function navForCurrentUser() {
  const perms = getUserPerms(currentUser);
  if (!perms) return [];
  if (perms.isAdmin) return ADMIN_NAV;
  return ADMIN_NAV.filter((n) => (perms.allowedPages || []).includes(n.key));
}

function renderAdminNav(activeKey) {
  const navItems = navForCurrentUser();
  const perms = getUserPerms(currentUser);
  return `
    <div class="admin-nav">${navItems.map(
      (n) =>
        `<button type="button" class="nav-pill ${n.key === activeKey ? "active" : ""}" data-nav="${n.view}">
          <span class="nav-icon">${n.icon}</span>
          <span class="nav-label-short">${escapeHtml(n.label)}</span>
          <span class="nav-label-long">${escapeHtml(n.labelLong)}</span>
        </button>`
    ).join("")}</div>
    ${perms?.isAdmin ? `
      <div class="admin-footer-nav">
        <button type="button" class="nav-link-sm ${activeKey === "timeline" ? "active" : ""}" data-nav="timeline">📅 Vehicle Timeline</button>
        <span class="nav-sep">·</span>
        <button type="button" class="nav-link-sm ${activeKey === "deletions" ? "active" : ""}" data-nav="deletions">🗑️ Deletion Audit Log${deletionLog.length ? ` (${deletionLog.length})` : ""}</button>
        <span class="nav-sep">·</span>
        <button type="button" class="nav-link-sm ${activeKey === "user-access" ? "active" : ""}" data-nav="user-access">👥 User Access</button>
      </div>
    ` : ""}
    ${renderMobileBottomBar(activeKey)}
  `;
}

// Bottom tab bar for mobile only (hidden on desktop via CSS).
// 5 most-used tabs: Home, Installs, Repairs, Progress, Stock.
// Additional tabs (SIM DB, Timeline, Deletions) accessible via "More" sheet.
function renderMobileBottomBar(activeKey) {
  const PRIMARY = [
    { key: "dashboard", view: "dashboard", icon: "🏠", label: "Home" },
    { key: "installations", view: "installations", icon: "🚛", label: "Installs" },
    { key: "repairs", view: "repairs", icon: "🛠️", label: "Repairs" },
    { key: "pending", view: "pending", icon: "⚙️", label: "Progress" },
    { key: "sim-db", view: "sim-db", icon: "📶", label: "SIMs" },
  ];
  // Show pending count badge on the Progress tab if non-zero.
  const pendingCount = (() => {
    try {
      return getPendingActionRows().length;
    } catch {
      return 0;
    }
  })();
  return `
    <nav class="bottom-tab-bar" aria-label="Primary mobile navigation">
      ${PRIMARY.map(
        (t) => `
          <button type="button" class="bt-tab ${t.key === activeKey ? "active" : ""}" data-nav="${t.view}">
            <span class="bt-icon">${t.icon}</span>
            <span class="bt-label">${t.label}</span>
            ${t.key === "pending" && pendingCount ? `<span class="bt-badge">${pendingCount}</span>` : ""}
          </button>
        `
      ).join("")}
      <button type="button" class="bt-tab" data-act="more-sheet">
        <span class="bt-icon">⋯</span>
        <span class="bt-label">More</span>
      </button>
    </nav>
  `;
}

// Bottom sheet ("More" menu on mobile) — Stock, Timeline, Audit, Logout.
function openMoreSheet() {
  modal.innerHTML = `
    <h3 class="sheet-title">⋯ More</h3>
    <div class="sheet-grid">
      <button type="button" class="sheet-item" data-nav="stock">
        <span class="sheet-icon">📦</span>
        <span class="sheet-label">Stock</span>
      </button>
      <button type="button" class="sheet-item" data-nav="timeline">
        <span class="sheet-icon">📅</span>
        <span class="sheet-label">Vehicle Timeline</span>
      </button>
      <button type="button" class="sheet-item" data-nav="deletions">
        <span class="sheet-icon">🗑️</span>
        <span class="sheet-label">Audit Log${deletionLog.length ? ` (${deletionLog.length})` : ""}</span>
      </button>
      <button type="button" class="sheet-item sheet-danger" data-act="logout">
        <span class="sheet-icon">↩️</span>
        <span class="sheet-label">Logout</span>
      </button>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary btn-block" data-act="close">Close</button>
    </div>
  `;
  modal.classList.add("modal-sheet");
  modalOverlay.classList.remove("hidden");
  const close = () => {
    modal.classList.remove("modal-sheet");
    closeModal();
  };
  modal.querySelector('[data-act="close"]').onclick = close;
  modalOverlay.onclick = (e) => { if (e.target === modalOverlay) close(); };
  modal.querySelectorAll("[data-nav]").forEach((b) =>
    b.addEventListener("click", () => {
      close();
      setView(b.dataset.nav);
    })
  );
  modal.querySelector('[data-act="logout"]').onclick = () => {
    close();
    currentUser = null;
    setView("login");
  };
}

function bindAdminNav() {
  app.querySelectorAll("[data-nav]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.nav));
  });
  app.querySelectorAll('[data-act="more-sheet"]').forEach((btn) => {
    btn.addEventListener("click", openMoreSheet);
  });
}

/* ---------------- Page 1: Dashboard ---------------- */

function renderDashboard() {
  const allInstalls = loadInstallations();
  const allMaint = loadMaintenance();
  const pendingCount = getPendingActionRows().length;
  const allSims = loadSims();
  const pendingPrimary = allSims.filter((s) => !s.primaryNumber).length;
  const inUseSims = allSims.filter((s) => {
    const v = (s.primaryNumber || s.secondaryNumber || "").toLowerCase();
    if (!v) return false;
    return allInstalls.some((inst) =>
      inst.simHistory.some(
        (h) => h.active && (h.value || "").toLowerCase() === v
      )
    );
  }).length;
  const allStock = loadStockItems();
  const lowStock = allStock.filter(
    (i) =>
      !isTrackableCategory(i.category) &&
      i.lowStockThreshold != null &&
      i.quantity <= i.lowStockThreshold
  ).length;
  const totalUnits = allStock.reduce((s, i) => s + (i.quantity || 0), 0);
  const allDeletions = deletionLog;

  // Pending tasks breakdown — by consolidated category.
  const pendingRows = getPendingActionRows();
  const pendingByCategory = { Portal: 0, SIM: 0, Service: 0 };
  for (const row of pendingRows) {
    const cat = taskFlow(row.task?.type)?.category;
    if (cat && pendingByCategory[cat] != null) pendingByCategory[cat] += 1;
  }

  // ===== Donut chart segments =====

  // 1) Fleet status — Installations grouped by GPS model (top 5)
  // Normalize known model strings so "fmb"/"FMB"/"Fmb" all count as "FMB"
  function normalizeModel(raw) {
    let m = String(raw || "").trim();
    if (!m) return "Unknown";
    const lower = m.toLowerCase();
    if (lower === "fmb") return "FMB";
    if (lower === "fmc") return "FMC";
    if (lower === "normal") return "Normal";
    return m;
  }
  const modelCounts = {};
  for (const inst of allInstalls) {
    const m = normalizeModel(inst.gpsModel);
    modelCounts[m] = (modelCounts[m] || 0) + 1;
  }
  const MODEL_COLORS = ["#f97316", "#facc15", "#3b82f6", "#10b981", "#a855f7", "#ef4444", "#0891b2", "#64748b"];
  const modelEntries = Object.entries(modelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);
  const installSegments = modelEntries.map(([label, value], i) => ({
    label,
    value,
    color: MODEL_COLORS[i % MODEL_COLORS.length],
  }));

  // 2) SIM status — categorize SIMs
  const simStatus = {
    "In Use": 0,
    "Available": 0,
    "Pending Primary": 0,
    "Looks Swapped": 0,
  };
  const inUseSet = new Set();
  for (const inst of allInstalls) {
    for (const h of inst.simHistory) {
      if (h.active && h.value) inUseSet.add(h.value.toLowerCase());
    }
  }
  for (const s of allSims) {
    const pri = (s.primaryNumber || "").toLowerCase();
    const sec = (s.secondaryNumber || "").toLowerCase();
    const isInUse = (pri && inUseSet.has(pri)) || (sec && inUseSet.has(sec));
    if (!s.primaryNumber) simStatus["Pending Primary"] += 1;
    else if (digitsOnly(s.primaryNumber).length >= 18 && digitsOnly(s.secondaryNumber || "").length <= 14) simStatus["Looks Swapped"] += 1;
    else if (isInUse) simStatus["In Use"] += 1;
    else simStatus["Available"] += 1;
  }
  const simSegments = [
    { label: "Available", value: simStatus["Available"], color: "#10b981" },
    { label: "In Use", value: simStatus["In Use"], color: "#3b82f6" },
    { label: "Pending Primary", value: simStatus["Pending Primary"], color: "#f59e0b" },
    { label: "Looks Swapped", value: simStatus["Looks Swapped"], color: "#ef4444" },
  ];

  // 3) Repair Progress — by category
  const repairSegments = [
    { label: "Portal updates", value: pendingByCategory.Portal, color: "#0891b2" },
    { label: "SIM Deactivations", value: pendingByCategory.SIM, color: "#a855f7" },
    { label: "Service items", value: pendingByCategory.Service, color: "#f97316" },
  ];

  // 4) Top vehicles by repair count (for horizontal bar chart)
  const vehicleRepairCounts = {};
  for (const m of allMaint) {
    const v = m.vehicleNo;
    if (!v) continue;
    vehicleRepairCounts[v] = (vehicleRepairCounts[v] || 0) + 1;
  }
  const topVehicles = Object.entries(vehicleRepairCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value], i) => ({
      label,
      value,
      color: ["#0891b2", "#06b6d4", "#22d3ee", "#67e8f9", "#a5f3fc", "#cffafe"][i],
    }));

  // 5) Devices currently out for service (Trakzee-style "Faulty Devices" card)
  // A maintenance entry with deviceOutForRepair / sensorOutForRepair flag
  // and NO subsequent install/repair on the same vehicle indicating return.
  const devicesOut = [];
  for (const m of allMaint) {
    if (!m.deviceOutForRepair && !m.sensorOutForRepair) continue;
    // Check if any later record on the same vehicle indicates a return
    // (a new device install or sensor return). Simple heuristic: any later
    // repair / install with newImei or new sensor.
    const laterReturn = allMaint
      .concat(allInstalls.map((i) => ({ vehicleNo: i.vehicleNo, createdAt: i.createdAt, newImei: getCurrentImei(i) })))
      .find((r) =>
        r.vehicleNo === m.vehicleNo &&
        new Date(r.createdAt) > new Date(m.createdAt) &&
        (r.newImei || r.deviceChange)
      );
    if (laterReturn) continue;
    devicesOut.push({
      vehicleNo: m.vehicleNo,
      itemType: m.deviceOutForRepair ? "Device" : "Sensor",
      identifier: m.deviceOutForRepair ? (m.oldImei || "—") : "—",
      sentDate: m.createdAt,
    });
  }
  devicesOut.sort((a, b) => new Date(b.sentDate) - new Date(a.sentDate));

  // 6) Vehicles by repair age — when was the last repair done on each vehicle.
  // Buckets: > 90 days, > 60, > 30, > 15, > 7 (and "active" = within last 7).
  const now = Date.now();
  const lastRepairByVehicle = {};
  for (const m of allMaint) {
    const t = new Date(m.createdAt).getTime();
    if (!lastRepairByVehicle[m.vehicleNo] || t > lastRepairByVehicle[m.vehicleNo]) {
      lastRepairByVehicle[m.vehicleNo] = t;
    }
  }
  // For vehicles without any repair, use install date.
  for (const inst of allInstalls) {
    if (!(inst.vehicleNo in lastRepairByVehicle)) {
      lastRepairByVehicle[inst.vehicleNo] = new Date(inst.createdAt).getTime();
    }
  }
  const ageBuckets = { ">90": 0, ">60": 0, ">30": 0, ">15": 0, ">7": 0 };
  for (const v of Object.values(lastRepairByVehicle)) {
    const days = Math.floor((now - v) / (24 * 60 * 60 * 1000));
    if (days > 90) ageBuckets[">90"] += 1;
    else if (days > 60) ageBuckets[">60"] += 1;
    else if (days > 30) ageBuckets[">30"] += 1;
    else if (days > 15) ageBuckets[">15"] += 1;
    else if (days > 7) ageBuckets[">7"] += 1;
  }
  const ageBars = [
    { label: "> 90 days", value: ageBuckets[">90"], color: "#0ea5e9" },
    { label: "> 60 days", value: ageBuckets[">60"], color: "#0ea5e9" },
    { label: "> 30 days", value: ageBuckets[">30"], color: "#0ea5e9" },
    { label: "> 15 days", value: ageBuckets[">15"], color: "#0ea5e9" },
    { label: "> 7 days", value: ageBuckets[">7"], color: "#0ea5e9" },
  ];

  // Recent activity feed (top 12 events across installs, repairs, deletions)
  const events = [
    ...allInstalls.map((i) => ({
      kind: "install",
      at: i.createdAt,
      title: i.vehicleNo,
      detail: `IMEI ${getCurrentImei(i)}`,
      by: i.createdBy || "akash",
    })),
    ...allMaint.map((m) => ({
      kind: "repair",
      at: m.createdAt,
      title: m.vehicleNo,
      detail: workLabels(m),
      by: m.createdBy || "akash",
    })),
    ...allDeletions.map((d) => ({
      kind: "delete",
      at: d.deletedAt,
      title: d.entityLabel || "—",
      detail: d.reason || "",
      by: d.deletedBy || "—",
      entityType: d.entityType,
    })),
  ]
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 12);

  // Stock breakdown by category (top 6, others bucketed)
  const byCategory = {};
  for (const item of allStock) {
    const k = item.category || "Uncategorized";
    byCategory[k] = (byCategory[k] || 0) + (item.quantity || 0);
  }
  const catEntries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const totalCatUnits = catEntries.reduce((s, e) => s + e[1], 0) || 1;
  // Color palette for category bars
  const catColors = ["#0891b2", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#a855f7", "#ec4899", "#64748b"];

  // Akash's contribution this week (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const installsThisWeek = allInstalls.filter((i) => new Date(i.createdAt) >= weekAgo).length;
  const repairsThisWeek = allMaint.filter((m) => new Date(m.createdAt) >= weekAgo).length;

  function eventIcon(kind, entityType) {
    if (kind === "install") return "🆕";
    if (kind === "repair") return "🔧";
    if (kind === "delete") {
      if (entityType === "installation") return "🗑️🆕";
      if (entityType === "maintenance") return "🗑️🔧";
      if (entityType === "stock_item") return "🗑️📦";
      return "🗑️";
    }
    return "•";
  }
  function eventClass(kind) {
    if (kind === "install") return "ev-install";
    if (kind === "repair") return "ev-repair";
    if (kind === "delete") return "ev-delete";
    return "";
  }

  app.innerHTML = `
    ${renderHeader("Home", "Fleet operations at a glance")}
    <main class="main">
      ${renderAdminNav("dashboard")}

      <!-- ROW 1: Big donut charts (Fleet / SIM / Repair Progress) — all clickable -->
      <div class="donut-row">
        <button type="button" class="card donut-card accent-blue clickable-card" data-go="installations" aria-label="View all installations">
          <div class="section-heading">
            <div>
              <h2>🚛 Fleet by GPS Model</h2>
            </div>
            <span class="card-chevron">›</span>
          </div>
          ${donutWithLegend({
            segments: installSegments,
            centerLabel: allInstalls.length,
            centerSub: "Installs",
          })}
        </button>
        <button type="button" class="card donut-card accent-purple clickable-card" data-go="sim-db" aria-label="View SIM database">
          <div class="section-heading">
            <div>
              <h2>📶 SIM Status</h2>
            </div>
            <span class="card-chevron">›</span>
          </div>
          ${donutWithLegend({
            segments: simSegments,
            centerLabel: allSims.length,
            centerSub: "SIMs",
          })}
        </button>
        <button type="button" class="card donut-card accent-orange clickable-card" data-go="pending" aria-label="View repair progress">
          <div class="section-heading">
            <div>
              <h2>⚙️ Repair Progress</h2>
            </div>
            <span class="card-chevron">›</span>
          </div>
          ${donutWithLegend({
            segments: repairSegments,
            centerLabel: pendingCount,
            centerSub: "Pending",
          })}
          ${pendingCount ? `<div class="donut-cta">⚠️ ${pendingCount} pending — tap to resolve</div>` : ""}
        </button>
      </div>

      <!-- ROW 2: Colorful primary stats -->
      <div class="dash-grid">
        <button type="button" class="dash-card dash-cyan" data-go="installations">
          <div class="dash-card-top">
            <span class="dash-icon">🆕</span>
            ${installsThisWeek ? `<span class="dash-trend">+${installsThisWeek} this week</span>` : ""}
          </div>
          <span class="dash-num">${allInstalls.length}</span>
          <span class="dash-label">Installations</span>
          <span class="dash-go">View all →</span>
        </button>
        <button type="button" class="dash-card dash-blue" data-go="repairs">
          <div class="dash-card-top">
            <span class="dash-icon">🔧</span>
            ${repairsThisWeek ? `<span class="dash-trend">+${repairsThisWeek} this week</span>` : ""}
          </div>
          <span class="dash-num">${allMaint.length}</span>
          <span class="dash-label">Repair Records</span>
          <span class="dash-go">View all →</span>
        </button>
        <button type="button" class="dash-card ${pendingCount ? "dash-amber" : "dash-green"}" data-go="pending">
          <div class="dash-card-top">
            <span class="dash-icon">${pendingCount ? "⚠️" : "✓"}</span>
            ${pendingCount ? `<span class="dash-trend warn-trend">needs action</span>` : `<span class="dash-trend ok-trend">all clear</span>`}
          </div>
          <span class="dash-num">${pendingCount}</span>
          <span class="dash-label">Repair Progress</span>
          <span class="dash-go">${pendingCount ? "Resolve →" : "All clear ✓"}</span>
        </button>
        <button type="button" class="dash-card dash-purple" data-go="sim-db">
          <div class="dash-card-top">
            <span class="dash-icon">📶</span>
            ${inUseSims ? `<span class="dash-trend">${inUseSims} in use</span>` : ""}
          </div>
          <span class="dash-num">${allSims.length}</span>
          <span class="dash-label">SIMs in database${pendingPrimary ? ` · ${pendingPrimary} pending primary` : ""}</span>
          <span class="dash-go">View SIM database →</span>
        </button>
        <button type="button" class="dash-card ${lowStock ? "dash-red" : "dash-teal"}" data-go="stock">
          <div class="dash-card-top">
            <span class="dash-icon">📦</span>
            ${lowStock ? `<span class="dash-trend warn-trend">${lowStock} low</span>` : `<span class="dash-trend ok-trend">${totalUnits} units</span>`}
          </div>
          <span class="dash-num">${allStock.length}</span>
          <span class="dash-label">Stock items${lowStock ? ` · ${lowStock} low` : ""}</span>
          <span class="dash-go">View stock →</span>
        </button>
        <button type="button" class="dash-card dash-slate" data-go="deletions">
          <div class="dash-card-top">
            <span class="dash-icon">🗑️</span>
            <span class="dash-trend">audit log</span>
          </div>
          <span class="dash-num">${allDeletions.length}</span>
          <span class="dash-label">Deletions logged</span>
          <span class="dash-go">View audit →</span>
        </button>
      </div>

      <!-- Two-column: Activity feed + Stock by category -->
      <div class="dash-row">
        <section class="card dash-half accent-blue">
          <div class="section-heading">
            <div>
              <h2>📋 Recent Activity</h2>
            </div>
          </div>
          ${events.length ? `
            <ul class="activity-feed">
              ${events.map((e) => `
                <li class="activity-row ${eventClass(e.kind)}">
                  <span class="activity-icon">${eventIcon(e.kind, e.entityType)}</span>
                  <div class="activity-body">
                    <div class="activity-title">
                      <strong>${escapeHtml(e.title)}</strong>
                      <span class="activity-detail">${escapeHtml(e.detail)}</span>
                    </div>
                    <div class="activity-meta">
                      ${escapeHtml(formatDateTime(e.at))} · by ${escapeHtml(e.by)}
                    </div>
                  </div>
                </li>
              `).join("")}
            </ul>
          ` : `<p class="muted" style="padding: 1rem 0;">No activity yet.</p>`}
        </section>

        <section class="card dash-half accent-green">
          <div class="section-heading">
            <div>
              <h2>📦 Stock by Category</h2>
            </div>
          </div>
          ${catEntries.length ? `
            <div class="cat-bars">
              ${catEntries.map(([name, qty], i) => {
                const pct = Math.max(2, Math.round((qty / totalCatUnits) * 100));
                const color = catColors[i % catColors.length];
                return `
                  <div class="cat-bar-row">
                    <div class="cat-bar-label">
                      <span class="cat-bar-name">${escapeHtml(name)}</span>
                      <span class="cat-bar-qty mono">${qty}</span>
                    </div>
                    <div class="cat-bar-track">
                      <div class="cat-bar-fill" style="width: ${pct}%; background: ${color};"></div>
                    </div>
                  </div>
                `;
              }).join("")}
            </div>
          ` : `<p class="muted" style="padding: 1rem 0;">No stock items yet.</p>`}
        </section>
      </div>

      <!-- ROW: Devices Out for Repair + Inactive Vehicles (Trakzee-style) -->
      <div class="dash-row">
        <section class="card accent-brown">
          <div class="section-heading">
            <div><h2>🔧 Devices Out for Repair</h2></div>
          </div>
          ${devicesOut.length ? `
            <ul class="devices-out-list">
              ${devicesOut.slice(0, 6).map((d) => `
                <li>
                  <div class="dol-main">
                    <strong>${escapeHtml(d.vehicleNo)}</strong>
                    <span class="dol-type">${escapeHtml(d.itemType)}</span>
                  </div>
                  <div class="dol-meta">
                    ${d.identifier !== "—" ? `<span class="mono">${escapeHtml(d.identifier)}</span> · ` : ""}
                    sent ${escapeHtml(formatDateTime(d.sentDate))}
                  </div>
                </li>
              `).join("")}
            </ul>
          ` : `<div class="empty-record">No Record Found</div>`}
        </section>
        <section class="card accent-cyan">
          <div class="section-heading">
            <div><h2>⏱️ Vehicles by Last Activity</h2></div>
          </div>
          ${horizontalBarChart(ageBars)}
        </section>
      </div>

      <!-- BOTTOM ROW: Top vehicles by repair count -->
      ${topVehicles.length ? `
        <section class="card accent-purple">
          <div class="section-heading">
            <div>
              <h2>🚛 Top Vehicles by Repair Count</h2>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-go="repairs">View all →</button>
          </div>
          ${horizontalBarChart(topVehicles.map((v) => ({ ...v, color: "#a78bfa" })))}
        </section>
      ` : ""}
    </main>
  `;
  bindLogout();
  bindAdminNav();
  app.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.go));
  });
}

/* ---------------- Page 2: Installations ---------------- */

function renderInstallationsPage() {
  const allInstalls = loadInstallations();
  const q = searchQuery.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const filtered = allInstalls.filter((i) => {
    if (!q) return true;
    const hay = [
      i.vehicleNo,
      i.gpsModel,
      i.macId,
      i.sensorNo,
      i.secondarySim || "",
      ...i.imeiHistory.map((h) => h.value),
      ...i.simHistory.map((s) => s.value),
      ...i.simHistory.map((s) => s.secondaryValue || ""),
    ]
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });

  // Stats for the colorful strip
  const withSecSim = allInstalls.filter((i) => i.secondarySim).length;
  const recentInstalls = allInstalls.filter(
    (i) => new Date(i.createdAt) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  ).length;

  app.innerHTML = `
    ${renderHeader("Installations", `${allInstalls.length} vehicles registered`)}
    <main class="main">
      ${renderAdminNav("installations")}
      <div class="summary-grid">
        <div class="summary-box summary-info"><strong>${allInstalls.length}</strong><span>Total installs</span></div>
        <div class="summary-box summary-ok"><strong>${recentInstalls}</strong><span>This week</span></div>
        <div class="summary-box summary-purple"><strong>${withSecSim}</strong><span>With Secondary No</span></div>
      </div>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All Installations (${allInstalls.length})</h2>
            <p class="section-subtitle">Every GPS device installed on the fleet. Use Edit to fix typos in vehicle / model / MAC / sensor.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-outline btn-sm" id="exportInstallsBtn">↓ Export Excel</button>
          </div>
        </div>
        <div class="list-tools admin-search">
          <input type="search" id="adminSearch" placeholder="Search vehicle, IMEI, SIM, MAC..." value="${escapeHtml(searchQuery)}" />
        </div>
        <div class="bulk-panel">
          <div>
            <h3>Bulk Installation Upload</h3>
            <p>Download the installation sample, fill old records, then upload the Excel file.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="downloadSample">↓ Download sample file</button>
            <label class="btn btn-primary btn-sm upload-label" for="bulkUpload">↑ Upload filled file</label>
            <input class="hidden" type="file" id="bulkUpload" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          </div>
        </div>
        <div class="table-wrap installs-table-desktop">
          <table>
            <thead><tr><th>Date</th><th>Vehicle</th><th>GPS Model</th><th>Primary SIM</th><th>MAC ID</th><th>Sensor</th><th>IMEI History</th><th>SIM History</th><th></th></tr></thead>
            <tbody>
              ${
                filtered.length
                  ? filtered
                      .map((i) => {
                        const currentSim = getCurrentSim(i);
                        const resolved = resolvePrimarySim(currentSim);
                        const isPending = currentSim && resolved === currentSim && !sims.find((s) => (s.primaryNumber || "").toLowerCase() === currentSim.toLowerCase());
                        // Pending primary if simHistory value is a 20-digit ICCID
                        // and we couldn't find a matching primary in the sims table.
                        const looksIccid = currentSim && digitsOnly(currentSim).length >= 18;
                        const pendingPill = looksIccid ? `<span class="badge badge-warn" title="Primary not yet known — admin needs to fill it via Pending Work">pending primary</span>` : "";
                        return `
                <tr>
                  <td class="date-cell">${escapeHtml(formatDateTime(i.createdAt))}</td>
                  <td>${escapeHtml(i.vehicleNo)}</td>
                  <td>${escapeHtml(i.gpsModel)}</td>
                  <td class="mono">${escapeHtml(resolved || "—")} ${pendingPill}</td>
                  <td class="mono">${escapeHtml(i.macId)}</td>
                  <td class="mono">${escapeHtml(i.sensorNo)}</td>
                  <td class="history-cell">${historyList(i.imeiHistory)}</td>
                  <td class="history-cell">${simHistoryCell(i)}</td>
                  <td class="row-actions">
                    <button type="button" class="btn btn-outline btn-sm view-tl-btn" data-id="${i.id}" title="View vehicle timeline">📅 Timeline</button>
                    <button type="button" class="btn btn-outline btn-sm edit-btn" data-id="${i.id}">Edit</button>
                  </td>
                </tr>`;
                      })
                      .join("")
                  : `<tr class="empty-row"><td colspan="9">No installations found.</td></tr>`
              }
            </tbody>
          </table>
        </div>

        <!-- Mobile card grid — Trakzee-style, hidden on desktop -->
        <div class="installs-card-grid">
          ${
            filtered.length
              ? filtered.map((i) => {
                  const currentSim = getCurrentSim(i);
                  const resolved = resolvePrimarySim(currentSim);
                  const looksIccid = currentSim && digitsOnly(currentSim).length >= 18;
                  const currentImei = getCurrentImei(i);
                  const isNormal = (i.gpsModel || "").toLowerCase() === "normal";
                  const tail = (s, n = 6) => {
                    const v = String(s || "");
                    return v.length > n ? "…" + v.slice(-n) : v || "—";
                  };
                  return `
                    <article class="tk-card">
                      <div class="tk-card-head">
                        <span class="tk-pill">${escapeHtml(i.vehicleNo)}</span>
                        <button type="button" class="tk-arrow view-tl-btn" data-id="${i.id}" title="View timeline">›</button>
                      </div>
                      <div class="tk-flow">
                        <div class="tk-flow-box">
                          <div class="tk-flow-value">${escapeHtml(tail(currentImei))}</div>
                          <div class="tk-flow-label">IMEI</div>
                        </div>
                        <div class="tk-flow-connector">
                          <div class="tk-flow-icon">📡</div>
                          <div class="tk-flow-icon-label">${escapeHtml(i.gpsModel || "—")}</div>
                        </div>
                        <div class="tk-flow-box tk-flow-end">
                          <div class="tk-flow-value">${escapeHtml(resolved ? resolved : tail(currentSim))}</div>
                          <div class="tk-flow-label">${resolved && !looksIccid ? "PRIMARY" : "SIM"}</div>
                        </div>
                      </div>
                      ${!isNormal && (i.macId || i.sensorNo) ? `
                        <div class="tk-divider"></div>
                        <div class="tk-stats">
                          ${i.macId ? `
                            <div class="tk-stat">
                              <span class="tk-stat-icon">📱</span>
                              <span class="tk-stat-label">MAC:</span>
                              <span class="tk-stat-value">${escapeHtml(tail(i.macId, 8))}</span>
                            </div>
                          ` : ""}
                          ${i.sensorNo ? `
                            <div class="tk-stat">
                              <span class="tk-stat-icon">📊</span>
                              <span class="tk-stat-label">Sensor:</span>
                              <span class="tk-stat-value">${escapeHtml(i.sensorNo)}</span>
                            </div>
                          ` : ""}
                          ${i.secondarySim ? `
                            <div class="tk-stat tk-stat-full">
                              <span class="tk-stat-icon">📡</span>
                              <span class="tk-stat-label">Secondary No:</span>
                              <span class="tk-stat-value">${escapeHtml(i.secondarySim)}</span>
                            </div>
                          ` : ""}
                        </div>
                      ` : ""}
                      ${looksIccid ? `<div class="tk-reason" style="background: #fef3c7; color: #92400e; border-color: #f59e0b;">⏳ Primary number pending — set via Repair Progress</div>` : ""}
                      <div class="tk-footer">
                        <div class="tk-footer-row">
                          <span class="tk-footer-icon">📅</span>
                          <span class="tk-footer-label">Installed:</span>
                          <span class="tk-footer-value">${escapeHtml(formatDateTime(i.createdAt))}</span>
                        </div>
                        ${i.createdBy ? `
                          <div class="tk-footer-row">
                            <span class="tk-footer-icon">👤</span>
                            <span class="tk-footer-label">By:</span>
                            <span class="tk-footer-value">${escapeHtml(i.createdBy)}</span>
                          </div>
                        ` : ""}
                      </div>
                      <div class="tk-actions">
                        <button type="button" class="btn btn-outline btn-sm view-tl-btn" data-id="${i.id}">📅 Timeline</button>
                        <button type="button" class="btn btn-primary btn-sm edit-btn" data-id="${i.id}">✎ Edit</button>
                      </div>
                    </article>
                  `;
                }).join("")
              : `<div class="entry-empty"><div class="entry-empty-icon">📋</div><h3>No installations found</h3><p>Try a different search.</p></div>`
          }
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();
  document.getElementById("adminSearch")?.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });
  document.getElementById("downloadSample")?.addEventListener("click", downloadInstallationSample);
  document.getElementById("exportInstallsBtn")?.addEventListener("click", exportInstallationsToExcel);
  document.getElementById("bulkUpload")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = await showConfirm({
      title: "Confirm upload",
      message: "Upload installation records from this Excel file?",
      confirmLabel: "Upload",
    });
    if (!ok) return;
    renderLoading("Uploading data to Supabase...");
    try {
      await importInstallations(file);
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Upload failed.", true);
    }
  });
  app.querySelectorAll(".edit-btn").forEach((btn) => {
    btn.addEventListener("click", () => openEditInstallation(btn.dataset.id));
  });
  app.querySelectorAll(".view-tl-btn").forEach((btn) => {
    btn.addEventListener("click", () => openVehicleTimelineModal(btn.dataset.id));
  });
}

/* ---------------- Page 3: Repair Work ---------------- */

function renderRepairsPage() {
  const allMaint = loadMaintenance();
  const q = searchQuery.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const filtered = allMaint.filter((m) => {
    if (!q) return true;
    const hay = [
      m.imei,
      m.vehicleNo,
      m.oldImei || "",
      m.newImei || "",
      m.oldSimNo || "",
      m.newSimNo || "",
      m.otherWorkText || "",
      workLabels(m),
    ]
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });

  // Stats: total / sim changes / device changes / this week
  const simChangeCount = allMaint.filter((m) => m.simChange).length;
  const deviceChangeCount = allMaint.filter((m) => m.deviceChange).length;
  const recentRepairs = allMaint.filter(
    (m) => new Date(m.createdAt) >= new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  ).length;

  app.innerHTML = `
    ${renderHeader("Repair Work", `${allMaint.length} repair records`)}
    <main class="main">
      ${renderAdminNav("repairs")}
      <div class="summary-grid">
        <div class="summary-box summary-info"><strong>${allMaint.length}</strong><span>Total repairs</span></div>
        <div class="summary-box summary-ok"><strong>${recentRepairs}</strong><span>This week</span></div>
        <div class="summary-box summary-purple"><strong>${simChangeCount}</strong><span>SIM changes</span></div>
        <div class="summary-box summary-warn"><strong>${deviceChangeCount}</strong><span>Device changes</span></div>
      </div>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All Repair Work (${allMaint.length})</h2>
            <p class="section-subtitle">Every repair / maintenance entry from the field, with pending follow-up status.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-outline btn-sm" id="exportRepairsBtn">↓ Export Excel</button>
          </div>
        </div>
        <div class="list-tools admin-search">
          <input type="search" id="adminSearch" placeholder="Search vehicle, IMEI, SIM, work..." value="${escapeHtml(searchQuery)}" />
        </div>
        <div class="bulk-panel">
          <div>
            <h3>Bulk Repair Upload</h3>
            <p>Download the repair sample, fill old repair work records, then upload the Excel file.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="downloadSample">↓ Download sample file</button>
            <label class="btn btn-primary btn-sm upload-label" for="bulkUpload">↑ Upload filled file</label>
            <input class="hidden" type="file" id="bulkUpload" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          </div>
        </div>
        <div class="table-wrap repairs-table-desktop">
          <table>
            <thead><tr><th>Date</th><th>Vehicle</th><th>IMEI</th><th>Work Done</th><th>Status</th></tr></thead>
            <tbody>
              ${
                filtered.length
                  ? filtered
                      .map(
                        (m) => `
                <tr>
                  <td class="date-cell">${escapeHtml(formatDateTime(m.createdAt))}</td>
                  <td>${escapeHtml(m.vehicleNo)}</td>
                  <td class="mono">${escapeHtml(m.imei)}</td>
                  <td>${escapeHtml(workLabels(m))}</td>
                  <td class="status-cell">${getMaintenanceStatus(m)}</td>
                </tr>`
                      )
                      .join("")
                  : `<tr class="empty-row"><td colspan="5">No repair records found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <!-- Mobile card grid -->
        <div class="repairs-card-grid">
          ${filtered.length
            ? filtered.map((m) => {
                const tail = (s, n = 6) => {
                  const v = String(s || "");
                  return v.length > n ? "…" + v.slice(-n) : v || "—";
                };
                return `
                  <article class="tk-card">
                    <div class="tk-card-head">
                      <span class="tk-pill tk-pill-repair">${escapeHtml(m.vehicleNo)}</span>
                      <span class="tk-chip tk-chip-repair">🛠 Repair</span>
                    </div>
                    <div class="tk-stats">
                      <div class="tk-stat tk-stat-full">
                        <span class="tk-stat-icon">🔧</span>
                        <span class="tk-stat-label">Work:</span>
                        <span class="tk-stat-value" style="white-space:normal;">${escapeHtml(workLabels(m))}</span>
                      </div>
                      ${m.imei ? `
                        <div class="tk-stat tk-stat-full">
                          <span class="tk-stat-icon">📡</span>
                          <span class="tk-stat-label">IMEI:</span>
                          <span class="tk-stat-value">${escapeHtml(tail(m.imei))}</span>
                        </div>
                      ` : ""}
                    </div>
                    <div class="tk-footer">
                      <div class="tk-footer-row">
                        <span class="tk-footer-icon">📅</span>
                        <span class="tk-footer-label">Reported:</span>
                        <span class="tk-footer-value">${escapeHtml(formatDateTime(m.createdAt))}</span>
                      </div>
                      <div class="tk-footer-row">
                        <span class="tk-footer-icon">📊</span>
                        <span class="tk-footer-label">Status:</span>
                        <span class="tk-footer-value">${getMaintenanceStatus(m)}</span>
                      </div>
                    </div>
                  </article>
                `;
              }).join("")
            : `<div class="entry-empty"><div class="entry-empty-icon">🛠️</div><h3>No repairs found</h3><p>Try a different search.</p></div>`
          }
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();
  document.getElementById("adminSearch")?.addEventListener("input", (e) => {
    searchQuery = e.target.value;
    render();
  });
  document.getElementById("downloadSample")?.addEventListener("click", downloadRepairSample);
  document.getElementById("exportRepairsBtn")?.addEventListener("click", exportRepairsToExcel);
  document.getElementById("bulkUpload")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = await showConfirm({
      title: "Confirm upload",
      message: "Upload repair work records from this Excel file?",
      confirmLabel: "Upload",
    });
    if (!ok) return;
    renderLoading("Uploading data to Supabase...");
    try {
      await importRepairs(file);
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Upload failed.", true);
    }
  });
}

/* ---------------- Page 4: Pending Work ---------------- */

function renderPendingPage() {
  const pendingCount = getPendingActionRows().length;
  const pendingHtml = renderPendingActions();

  app.innerHTML = `
    ${renderHeader("Repair Progress", `${pendingCount} follow-up actions pending`)}
    <main class="main">
      ${renderAdminNav("pending")}
      ${pendingHtml || `<section class="card"><h2>🎉 All caught up</h2><p class="alert-desc">No pending actions right now. New repair entries will show up here automatically.</p></section>`}
    </main>
  `;
  bindLogout();
  bindAdminNav();

  // Wire all the existing pending-action handlers.
  app.querySelectorAll(".filter-chip[data-filter]").forEach((chip) => {
    chip.addEventListener("click", () => {
      pendingFilter = chip.dataset.filter;
      render();
    });
  });
  app.querySelectorAll(".task-complete").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "installation") {
        completeInstallTask(btn.dataset.record, btn.dataset.task);
      } else {
        completeTask(btn.dataset.record, btn.dataset.task);
      }
    });
  });
  app.querySelectorAll(".task-undo").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "installation") {
        undoInstallTask(btn.dataset.record, btn.dataset.task);
      } else {
        undoTask(btn.dataset.record, btn.dataset.task);
      }
    });
  });
  app.querySelectorAll(".task-remark").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.kind === "installation") {
        openInstallRemarkEditor(btn.dataset.record, btn.dataset.task);
      } else {
        openRemarkEditor(btn.dataset.record, btn.dataset.task);
      }
    });
  });
  document.getElementById("toggleCompleted")?.addEventListener("click", () => {
    showCompleted = !showCompleted;
    render();
  });
  document.getElementById("exportPending")?.addEventListener("click", exportPendingActions);
  app.querySelectorAll(".vg-edit").forEach((btn) => {
    btn.addEventListener("click", () => openEditInstallation(btn.dataset.inst));
  });
}

/* ---------------- Page 5: SIM Upload ---------------- */

function renderSimUpload() {
  const allInstalls = loadInstallations();
  const missingSec = allInstalls.filter((i) => !i.secondarySim).length;

  app.innerHTML = `
    ${renderHeader("SIM Upload", "Add secondary No numbers")}
    <main class="main">
      ${renderAdminNav("sim-upload")}
      <div class="summary-grid">
        <div class="summary-box"><strong>${allInstalls.length}</strong><span>Installations</span></div>
        <div class="summary-box ${missingSec ? "summary-warn" : ""}"><strong>${missingSec}</strong><span>Missing secondary</span></div>
      </div>

      <section class="card">
        <div class="section-heading">
          <div>
            <h2>📋 Quick Paste — Secondary Nos</h2>
            <p class="section-subtitle">Excel skip karo. Primary SIMs ek box me paste karo, secondary Nos doosre me — line-by-line pair ho jaayenge. 20-digit ICCIDs poore digits ke saath bachenge.</p>
          </div>
        </div>
        <div class="paste-grid">
          <div class="field">
            <label for="pastePrimary">Primary SIM numbers <span class="paste-count" id="primaryCount">0 lines</span></label>
            <textarea id="pastePrimary" rows="10" placeholder="5753200309565&#10;5753200309623&#10;5753200322950&#10;..." spellcheck="false"></textarea>
          </div>
          <div class="field">
            <label for="pasteSecondary">Secondary Nos (ICCIDs) <span class="paste-count" id="secondaryCount">0 lines</span></label>
            <textarea id="pasteSecondary" rows="10" placeholder="89918720507069157022&#10;89918720507069156917&#10;89918720507069153161&#10;..." spellcheck="false"></textarea>
          </div>
        </div>
        <div class="paste-preview" id="pastePreview">Paste data to preview pairs.</div>
        <div class="form-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="pasteClear">Clear</button>
          <button type="button" class="btn btn-primary" id="pasteUpload">↑ Upload pairs</button>
        </div>
      </section>

      <section class="card">
        <div class="section-heading">
          <div>
            <h2>📁 Excel Upload (alternative)</h2>
            <p class="section-subtitle">Prefer Excel? Download the sample (SIM columns pre-formatted as Text), fill <code>primary_sim, secondary_sim</code> columns, then upload.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="simSampleDl">↓ Sample file</button>
            <label class="btn btn-primary btn-sm upload-label" for="simBulkUpload">↑ Bulk upload</label>
            <input class="hidden" type="file" id="simBulkUpload" accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" />
          </div>
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();

  // Quick paste wiring (same logic as the SIM database page used to have).
  const primaryEl = document.getElementById("pastePrimary");
  const secondaryEl = document.getElementById("pasteSecondary");
  const primaryCntEl = document.getElementById("primaryCount");
  const secondaryCntEl = document.getElementById("secondaryCount");
  const previewEl = document.getElementById("pastePreview");

  function splitPasteLines(text) {
    const lines = (text || "").split(/\r?\n/).map((s) => s.trim());
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  function refreshPastePreview() {
    if (!primaryEl || !secondaryEl) return;
    const primaries = splitPasteLines(primaryEl.value);
    const secondaries = splitPasteLines(secondaryEl.value);
    primaryCntEl.textContent = `${primaries.length} line${primaries.length === 1 ? "" : "s"}`;
    secondaryCntEl.textContent = `${secondaries.length} line${secondaries.length === 1 ? "" : "s"}`;
    if (!primaries.length && !secondaries.length) {
      previewEl.textContent = "Paste data to preview pairs.";
      previewEl.className = "paste-preview";
      return;
    }
    if (primaries.length !== secondaries.length) {
      previewEl.textContent = `⚠️ Line count mismatch — ${primaries.length} primary vs ${secondaries.length} secondary. Each row must align.`;
      previewEl.className = "paste-preview warn";
      return;
    }
    const first = primaries
      .slice(0, 3)
      .map((p, i) => `${p} → ${secondaries[i] || "(clear)"}`)
      .join("  ·  ");
    previewEl.textContent = `✓ ${primaries.length} pairs ready. Preview: ${first}${primaries.length > 3 ? "  ..." : ""}`;
    previewEl.className = "paste-preview ok";
  }
  primaryEl?.addEventListener("input", refreshPastePreview);
  secondaryEl?.addEventListener("input", refreshPastePreview);
  document.getElementById("pasteClear")?.addEventListener("click", () => {
    if (primaryEl) primaryEl.value = "";
    if (secondaryEl) secondaryEl.value = "";
    refreshPastePreview();
  });
  document.getElementById("pasteUpload")?.addEventListener("click", async () => {
    const primaries = splitPasteLines(primaryEl?.value || "");
    const secondaries = splitPasteLines(secondaryEl?.value || "");
    if (!primaries.length || !secondaries.length) {
      showToast("Paste data in both boxes first.", true);
      return;
    }
    if (primaries.length !== secondaries.length) {
      showToast(
        `Line count mismatch: ${primaries.length} primary vs ${secondaries.length} secondary.`,
        true
      );
      return;
    }
    const ok = await showConfirm({
      title: "Upload pairs?",
      message: `Save ${primaries.length} SIM pair${primaries.length === 1 ? "" : "s"} to the SIM database?`,
      confirmLabel: "Upload",
    });
    if (!ok) return;

    const total = primaries.length;
    // Detect rows that look swapped (ICCID in primary box, short number in secondary box).
    const swapCandidates = primaries.reduce(
      (acc, p, i) => acc + (pairLooksSwapped(p, secondaries[i] || "") ? 1 : 0),
      0
    );
    let autoSwap = false;
    if (swapCandidates > 0) {
      autoSwap = await showConfirm({
        title: "Some rows look swapped",
        message: `${swapCandidates} of ${total} rows have a 20-digit ICCID in the <strong>primary</strong> box and a short number in the <strong>secondary</strong> box. Auto-swap them before saving?`,
        confirmLabel: "Yes, swap & save",
      });
    }
    renderLoading(`Saving SIMs to database... 0/${total}`);
    let saved = 0;
    const errors = [];

    // Helper to update the loading message in place without re-rendering.
    function updateProgress(done) {
      const el = document.querySelector(".loading-card p");
      if (el) el.textContent = `Saving SIMs to database... ${done}/${total}`;
      const sub = document.querySelector(".app-title-sub, .header-sub");
      if (sub) sub.textContent = `Saving SIMs to database... ${done}/${total}`;
    }

    try {
      for (let i = 0; i < total; i += 1) {
        let primary = primaries[i];
        let secondary = secondaries[i];
        if (autoSwap && pairLooksSwapped(primary, secondary)) {
          const tmp = primary;
          primary = secondary;
          secondary = tmp;
        }
        const rowNo = i + 1;
        if (!secondary) {
          errors.push(`Row ${rowNo}: secondary (ICCID) blank — skipped`);
          updateProgress(i + 1);
          continue;
        }
        try {
          await withTimeout(
            upsertSim({
              primaryNumber: primary || null,
              secondaryNumber: secondary,
            }),
            10000,
            `Row ${rowNo} upsert`
          );
          saved += 1;
        } catch (err) {
          if (err.code === SIMS_TABLE_MISSING) {
            errors.push(`Row ${rowNo}: sims table missing — run sims-table-migration.sql in Supabase first`);
          } else {
            errors.push(`Row ${rowNo}: ${err.message}`);
          }
        }
        updateProgress(i + 1);
      }

      // Navigate first so the user sees the new SIM Database, then refresh
      // in the background. This avoids a long extra wait on the spinner.
      setView("sim-db");
      try {
        await refreshAllData();
        render();
      } catch (err) {
        console.warn("Post-upload refresh failed (will catch up on next realtime tick):", err);
      }
      showToast(
        `${saved} SIM${saved === 1 ? "" : "s"} saved.${errors.length ? ` ${errors.length} skipped.` : ""}`,
        saved === 0
      );
      if (errors.length) showImportReport(errors);
    } catch (err) {
      // Catch-all so the loading screen never sticks.
      console.error("SIM upload failed:", err);
      try {
        await refreshAllData();
      } catch (_) {
        /* ignore — we just need to exit the spinner */
      }
      setView("sim-db");
      showToast(err.message || "Upload failed — check console.", true);
    }
  });

  // Excel alternative wiring.
  document.getElementById("simSampleDl")?.addEventListener("click", downloadSimSample);
  document.getElementById("simBulkUpload")?.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const ok = await showConfirm({
      title: "Bulk upload SIMs?",
      message: "Save SIM pairs from this Excel file to the SIM database?",
      confirmLabel: "Upload",
    });
    if (!ok) return;
    renderLoading("Uploading SIMs to database...");
    try {
      await importSimsFromExcel(file);
      setView("sim-db");
    } catch (err) {
      await refreshAllData();
      render();
      const msg = err.message || "Upload failed.";
      showToast(err.code === SIMS_TABLE_MISSING ? "Run sims-table-migration.sql in Supabase first." : msg, true);
    }
  });

  refreshPastePreview();
}

/* ---------------- Page 6: SIM Database (read-only view) ---------------- */

function renderSimDb() {
  if (!simsTableReady) {
    app.innerHTML = `
      ${renderHeader("SIM Database", "Standalone SIM inventory")}
      <main class="main">
        ${renderAdminNav("sim-db")}
        <section class="card">
          <h2>⚙️ Migration needed</h2>
          <p>The new SIM database needs a one-time setup. Open Supabase SQL Editor and run <code>sims-table-migration.sql</code>, then come back here.</p>
          <div class="form-actions" style="margin-top: 1rem;">
            <a class="btn btn-primary" href="https://supabase.com/dashboard/project/jzclmcjurfehpfybxryh/sql/new" target="_blank" rel="noopener">Open SQL Editor →</a>
            <button type="button" class="btn btn-secondary" id="retrySimDb">↻ Reload</button>
          </div>
        </section>
      </main>
    `;
    bindLogout();
    bindAdminNav();
    document.getElementById("retrySimDb")?.addEventListener("click", async () => {
      renderLoading("Checking SIM table...");
      try {
        await refreshAllData();
        render();
      } catch (err) {
        renderConnectionError(err.message);
      }
    });
    return;
  }

  const allSims = loadSims();
  const allInstalls = loadInstallations();

  // Pre-compute which installation is currently using a given SIM (by either
  // primary or secondary value).
  function findUsingInstallation(sim) {
    const primary = (sim.primaryNumber || "").toLowerCase();
    const secondary = (sim.secondaryNumber || "").toLowerCase();
    return allInstalls.find((inst) => {
      return inst.simHistory.some((s) => {
        const v = (s.value || "").toLowerCase();
        const sv = (s.secondaryValue || "").toLowerCase();
        const active = s.active && !s.pendingDeactivation;
        return (
          active &&
          ((v && (v === primary || v === secondary)) ||
            (sv && (sv === primary || sv === secondary)))
        );
      });
    });
  }

  function simStatus(sim) {
    if (!sim.primaryNumber) return { label: "Pending primary", className: "status-warn" };
    const inst = findUsingInstallation(sim);
    if (inst) return { label: `In use · ${inst.vehicleNo}`, className: "status-ok" };
    return { label: "Available", className: "status-muted" };
  }

  const q = simDbQuery.toLowerCase().trim();
  const tokens = q.split(/\s+/).filter(Boolean);
  const matches = allSims.filter((s) => {
    if (!q) return true;
    const hay = [s.primaryNumber || "", s.secondaryNumber || "", s.notes || ""]
      .join(" ")
      .toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
  matches.sort((a, b) => {
    // Pending-primary rows first, then alphabetical by secondary.
    const ap = !a.primaryNumber ? 0 : 1;
    const bp = !b.primaryNumber ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return (a.secondaryNumber || "").localeCompare(b.secondaryNumber || "");
  });

  const totalSims = allSims.length;
  const pendingPrimary = allSims.filter((s) => !s.primaryNumber).length;
  const inUseCount = allSims.filter((s) => findUsingInstallation(s)).length;
  const availableCount = totalSims - inUseCount - pendingPrimary;

  const swappedCount = allSims.filter(simLooksSwapped).length;

  const tableHtml = matches.length
    ? matches
        .map((sim) => {
          const status = simStatus(sim);
          const isSwapped = simLooksSwapped(sim);
          // If the row's data looks swapped, display it in the CORRECT order
          // visually so the table is immediately readable while the user
          // decides whether to persist the swap via the Fix button.
          const displayPrimary = isSwapped ? sim.secondaryNumber : sim.primaryNumber;
          const displaySecondary = isSwapped ? sim.primaryNumber : sim.secondaryNumber;
          const primaryCell = displayPrimary || `<span class="muted">Not set</span>`;
          return `
            <tr class="${isSwapped ? "row-swap-warn" : ""}">
              <td class="mono">
                ${typeof primaryCell === "string" && primaryCell.startsWith("<") ? primaryCell : escapeHtml(primaryCell)}
                ${isSwapped ? `<span class="swap-tag" title="Stored swapped in the database — showing the corrected order here. Click ↔ Fix to make it permanent.">auto-corrected display</span>` : ""}
              </td>
              <td class="mono">${escapeHtml(displaySecondary || "")}</td>
              <td><span class="sim-status ${status.className}">${escapeHtml(status.label)}</span></td>
              <td>${escapeHtml(sim.notes || "")}</td>
              <td class="date-cell">${escapeHtml(formatDateTime(sim.createdAt))}</td>
              <td class="row-actions">
                ${isSwapped ? `<button type="button" class="btn btn-warn btn-sm sim-row-fix" data-id="${sim.id}" title="Persist the swap in the database">↔ Fix in DB</button>` : ""}
                <button type="button" class="btn btn-outline btn-sm sim-row-edit" data-id="${sim.id}">✎ Edit</button>
                <button type="button" class="btn btn-danger btn-sm sim-row-delete" data-id="${sim.id}">Delete</button>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr class="empty-row"><td colspan="6">${q ? `No SIMs match "${escapeHtml(simDbQuery)}".` : "No SIMs in the database yet. Use SIM Upload to add some."}</td></tr>`;

  app.innerHTML = `
    ${renderHeader("SIM Database", "Independent inventory of SIM cards (primary + secondary)")}
    <main class="main">
      ${renderAdminNav("sim-db")}
      <div class="summary-grid">
        <div class="summary-box summary-info"><strong>${totalSims}</strong><span>Total SIMs</span></div>
        <div class="summary-box summary-purple"><strong>${inUseCount}</strong><span>In use</span></div>
        <div class="summary-box summary-ok"><strong>${availableCount}</strong><span>Available</span></div>
        <div class="summary-box ${pendingPrimary ? "summary-warn" : ""}"><strong>${pendingPrimary}</strong><span>Pending primary</span></div>
        ${swappedCount ? `<div class="summary-box summary-danger"><strong>${swappedCount}</strong><span>Looks swapped</span></div>` : ""}
      </div>
      ${swappedCount ? `
        <div class="swap-banner">
          <span>⚠️ <strong>${swappedCount}</strong> SIM${swappedCount === 1 ? " is" : "s are"} stored with primary &amp; secondary swapped in the database. The table below is showing them auto-corrected for readability, but the database still has them backwards. Click below to fix them permanently.</span>
          <button type="button" class="btn btn-warn btn-sm" id="fixAllSwap">↔ Fix all in DB</button>
        </div>
      ` : ""}
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All SIMs (${totalSims})</h2>
            <p class="section-subtitle">Each SIM card has a primary number (13-digit, given by telecom) and a secondary number (20-digit ICCID, printed on the card). Akash sees only the ICCID — the system looks up the primary from this database when he saves an entry.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="addSimBtn">+ Add SIM</button>
            <button type="button" class="btn btn-primary btn-sm" data-nav="sim-upload">↑ Bulk upload</button>
            <button type="button" class="btn btn-outline btn-sm" id="exportSimsBtn">↓ Export Excel</button>
          </div>
        </div>
        <div class="list-tools admin-search sticky-search">
          <input type="search" id="simSearch" placeholder="Search primary, secondary, notes..." value="${escapeHtml(simDbQuery)}" />
        </div>
        <div class="table-wrap sims-table-desktop">
          <table>
            <thead>
              <tr><th>Primary</th><th>Secondary (ICCID)</th><th>Status</th><th>Notes</th><th>Added</th><th></th></tr>
            </thead>
            <tbody>${tableHtml}</tbody>
          </table>
        </div>
        <!-- Mobile card grid -->
        <div class="sims-card-grid">
          ${matches.length
            ? matches.map((sim) => {
                const status = simStatus(sim);
                const isSwapped = simLooksSwapped(sim);
                const displayPrimary = isSwapped ? sim.secondaryNumber : sim.primaryNumber;
                const displaySecondary = isSwapped ? sim.primaryNumber : sim.secondaryNumber;
                const tail = (s, n = 8) => {
                  const v = String(s || "");
                  return v.length > n ? "…" + v.slice(-n) : v || "—";
                };
                return `
                  <article class="tk-card ${isSwapped ? "tk-card-warn" : ""}">
                    <div class="tk-card-head">
                      <span class="tk-pill">${escapeHtml(displayPrimary || "Pending primary")}</span>
                      <span class="tk-chip sim-status-${status.className}">${escapeHtml(status.label)}</span>
                    </div>
                    <div class="tk-stats">
                      <div class="tk-stat tk-stat-full">
                        <span class="tk-stat-icon">📶</span>
                        <span class="tk-stat-label">Secondary No:</span>
                        <span class="tk-stat-value">${escapeHtml(tail(displaySecondary, 10))}</span>
                      </div>
                      ${sim.notes ? `
                        <div class="tk-stat tk-stat-full">
                          <span class="tk-stat-icon">📝</span>
                          <span class="tk-stat-label">Notes:</span>
                          <span class="tk-stat-value" style="white-space:normal;">${escapeHtml(sim.notes)}</span>
                        </div>
                      ` : ""}
                    </div>
                    ${isSwapped ? `<div class="tk-reason" style="background:#fef3c7;color:#92400e;border-color:#f59e0b;">⚠️ Stored swapped — auto-corrected display</div>` : ""}
                    <div class="tk-footer">
                      <div class="tk-footer-row">
                        <span class="tk-footer-icon">📅</span>
                        <span class="tk-footer-label">Added:</span>
                        <span class="tk-footer-value">${escapeHtml(formatDateTime(sim.createdAt))}</span>
                      </div>
                    </div>
                    <div class="tk-actions">
                      ${isSwapped ? `<button type="button" class="btn btn-warn btn-sm sim-row-fix" data-id="${sim.id}">↔ Fix</button>` : ""}
                      <button type="button" class="btn btn-outline btn-sm sim-row-edit" data-id="${sim.id}">✎ Edit</button>
                      <button type="button" class="btn btn-danger btn-sm sim-row-delete" data-id="${sim.id}">🗑</button>
                    </div>
                  </article>
                `;
              }).join("")
            : `<div class="entry-empty"><div class="entry-empty-icon">📶</div><h3>No SIMs found</h3><p>${q ? `Try a different search.` : `Use SIM Upload to bulk-add.`}</p></div>`
          }
        </div>
      </section>
    </main>
  `;
  bindLogout();
  bindAdminNav();

  const searchEl = document.getElementById("simSearch");
  searchEl?.addEventListener("input", (e) => {
    simDbQuery = e.target.value;
    render();
    const el = document.getElementById("simSearch");
    if (el) {
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    }
  });

  document.getElementById("addSimBtn")?.addEventListener("click", () => openSimEditor(null));
  document.getElementById("exportSimsBtn")?.addEventListener("click", exportSimsToExcel);
  app.querySelectorAll(".sim-row-edit").forEach((btn) => {
    btn.addEventListener("click", () => openSimEditor(btn.dataset.id));
  });
  app.querySelectorAll(".sim-row-delete").forEach((btn) => {
    btn.addEventListener("click", () => onDeleteSim(btn.dataset.id));
  });
  app.querySelectorAll(".sim-row-fix").forEach((btn) => {
    btn.addEventListener("click", () => onFixSwappedSim(btn.dataset.id));
  });
  document.getElementById("fixAllSwap")?.addEventListener("click", onFixAllSwappedSims);
}

async function onFixSwappedSim(simId) {
  const sim = loadSims().find((s) => s.id === simId);
  if (!sim) return;
  const ok = await showConfirm({
    title: "Swap primary ↔ secondary?",
    message: `Move <strong>${escapeHtml(sim.primaryNumber || "")}</strong> to the secondary slot and <strong>${escapeHtml(sim.secondaryNumber || "")}</strong> to the primary slot?`,
    confirmLabel: "Swap",
  });
  if (!ok) return;
  renderLoading("Swapping numbers...");
  try {
    // We can't just swap because secondary_number is the unique key. Easiest
    // safe path: delete the row, then re-insert with the swapped values.
    await deleteSim(simId);
    await upsertSim({
      primaryNumber: sim.secondaryNumber || null,
      secondaryNumber: sim.primaryNumber || "",
      notes: sim.notes,
    });
    await refreshAllData();
    render();
    showToast("Swapped.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Swap failed.", true);
  }
}

async function onFixAllSwappedSims() {
  const targets = loadSims().filter(simLooksSwapped);
  if (!targets.length) {
    showToast("Nothing to fix.");
    return;
  }
  const ok = await showConfirm({
    title: `Auto-fix ${targets.length} SIM${targets.length === 1 ? "" : "s"}?`,
    message: `Swap primary ↔ secondary for all SIMs where the primary slot looks like a 20-digit ICCID. This cannot be undone in one click — but each row can be edited manually afterwards.`,
    confirmLabel: "Fix all",
  });
  if (!ok) return;
  renderLoading(`Fixing ${targets.length} SIMs...`);
  let fixed = 0;
  for (const sim of targets) {
    try {
      await deleteSim(sim.id);
      await upsertSim({
        primaryNumber: sim.secondaryNumber || null,
        secondaryNumber: sim.primaryNumber || "",
        notes: sim.notes,
      });
      fixed += 1;
    } catch (err) {
      console.warn("Auto-fix swap failed for SIM", sim.id, err);
    }
  }
  await refreshAllData();
  render();
  showToast(`${fixed} of ${targets.length} SIMs fixed.`, fixed < targets.length);
}

function openSimEditor(simId) {
  const sim = simId ? loadSims().find((s) => s.id === simId) : null;
  modal.innerHTML = `
    <h3>${sim ? "✎ Edit SIM" : "+ Add SIM"}</h3>
    <div class="field">
      <label for="simPrimary">Primary number (13-digit)</label>
      <input type="text" id="simPrimary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 5753200309565" value="${escapeHtml(sim?.primaryNumber || "")}" />
    </div>
    <div class="field">
      <label for="simSecondary">Secondary number / ICCID (20-digit) <span class="required">*</span></label>
      <input type="text" id="simSecondary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 89918720507069156677" value="${escapeHtml(sim?.secondaryNumber || "")}" />
    </div>
    <div class="field">
      <label for="simNotes">Notes (optional)</label>
      <input type="text" id="simNotes" autocomplete="off" placeholder="e.g. Spare batch March 2026" value="${escapeHtml(sim?.notes || "")}" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">${sim ? "Save changes" : "Add SIM"}</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");

  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  modal.querySelector('[data-act="save"]').onclick = async () => {
    let primary = modal.querySelector("#simPrimary").value.trim();
    let secondary = modal.querySelector("#simSecondary").value.trim();
    const notes = modal.querySelector("#simNotes").value.trim() || null;
    if (!secondary) {
      showToast("Secondary number (ICCID) is required.", true);
      return;
    }
    // Auto-detect swap and offer to fix before saving.
    if (pairLooksSwapped(primary, secondary)) {
      const swap = await showConfirm({
        title: "Numbers look swapped",
        message: `<strong>${escapeHtml(primary)}</strong> looks like a 20-digit ICCID (should be the secondary), and <strong>${escapeHtml(secondary)}</strong> looks like a 13-digit primary number. Swap them automatically before saving?`,
        confirmLabel: "Swap & save",
      });
      if (swap) {
        const tmp = primary;
        primary = secondary;
        secondary = tmp;
      }
    }
    closeModal();
    renderLoading(sim ? "Saving changes..." : "Adding SIM...");
    try {
      if (sim) {
        await updateSim({ id: sim.id, primaryNumber: primary || null, secondaryNumber: secondary, notes });
      } else {
        await upsertSim({ primaryNumber: primary || null, secondaryNumber: secondary, notes });
      }
      await refreshAllData();
      render();
      showToast(sim ? "SIM updated." : "SIM added.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

async function onDeleteSim(simId) {
  const sim = loadSims().find((s) => s.id === simId);
  if (!sim) return;
  const ok = await showConfirm({
    title: "Delete this SIM?",
    message: `Remove SIM (primary: ${sim.primaryNumber || "—"}, secondary: ${sim.secondaryNumber}) from the database? This does not affect existing installation history.`,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  renderLoading("Deleting SIM...");
  try {
    await deleteSim(simId);
    await refreshAllData();
    render();
    showToast("SIM deleted.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

/* ---------------- Page 7: Timeline (preserved) ---------------- */

/* ---------------- Page 8: Stock Inventory ---------------- */

// Default category list used to seed the DB (also used as fallback if the
// stock_categories migration hasn't been run yet).
const STOCK_CATEGORIES_DEFAULT = [
  "GPS",
  "SIM-AIRTEL",
  "SIM-JIO",
  "Sensor",
  "Roll",
  "Tape",
  "Drill",
  "Drill beat",
];

// Live category options used in dropdowns: admin-managed list from the DB,
// merged with any categories already used by existing items (so categories
// added before the table migration don't disappear).
function getCategoryOptions() {
  const fromDb = stockCategories.map((c) => c.name);
  const fromItems = stockItems.map((i) => i.category).filter(Boolean);
  const merged = stockCategoriesTableReady
    ? Array.from(new Set([...fromDb, ...fromItems]))
    : Array.from(new Set([...STOCK_CATEGORIES_DEFAULT, ...fromItems]));
  return merged.sort();
}

const STOCK_UNITS = ["pcs", "set", "box", "meters", "kg", "liters", "pack"];

// Detect what kind of identifiers this category needs.
function categoryKind(category) {
  if (!category) return "generic";
  const c = String(category).toUpperCase();
  if (c.includes("GPS")) return "gps";
  if (c.includes("SIM")) return "sim";
  if (c.includes("SENSOR")) return "sensor";
  return "generic";
}

// "Trackable" items each represent ONE specific device (unique IMEI, ICCID,
// sensor No / MAC). For these, qty is always 1 (in stock) or 0 (installed),
// so the "low stock" concept is meaningless and shouldn't be applied.
// Low-stock alerts only make sense for bulk consumables (Roll, Tape, Drill...).
function isTrackableCategory(category) {
  const k = categoryKind(category);
  return k === "gps" || k === "sim" || k === "sensor";
}

// --- Name normalization & fuzzy matching for duplicate prevention ---

// Strip all non-alphanumeric, lowercase. "FMB-02" / "fmb 02" -> "fmb02"
function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// Lowercase + sort tokens. "02 FMB" / "FMB-02" both -> "02 fmb"
function tokenSorted(s) {
  return String(s || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Classic Levenshtein distance — bounded so we exit early for cheap.
function levenshtein(a, b, max = 3) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Find the closest existing item to a typed name. Returns { item, reason } or null.
//   reason = "exact"   -> normalized strings identical
//   reason = "tokens"  -> same words, different order/separator
//   reason = "typo"    -> Levenshtein <= 2 (after normalization)
function findClosestItem(query, excludeId = null) {
  const items = loadStockItems().filter((i) => i.id !== excludeId);
  if (!items.length) return null;
  const qNorm = normalizeName(query);
  if (qNorm.length < 2) return null;
  const qSort = tokenSorted(query);

  for (const it of items) {
    if (normalizeName(it.name) === qNorm) return { item: it, reason: "exact" };
  }
  if (qSort) {
    for (const it of items) {
      if (tokenSorted(it.name) === qSort) return { item: it, reason: "tokens" };
    }
  }
  if (qNorm.length >= 3) {
    let best = null;
    let bestDist = Infinity;
    for (const it of items) {
      const d = levenshtein(qNorm, normalizeName(it.name), 2);
      if (d <= 2 && d < bestDist) {
        bestDist = d;
        best = it;
      }
    }
    if (best) return { item: best, reason: "typo" };
  }
  return null;
}

// Rank items for the suggestion dropdown given a query.
function rankItemSuggestions(query, excludeId = null) {
  const items = loadStockItems().filter((i) => i.id !== excludeId);
  if (!items.length) return [];

  // Sort by createdAt desc so recent items naturally come first.
  const byRecent = [...items].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  );

  const q = (query || "").trim();
  if (!q) {
    return byRecent.slice(0, 8).map((it) => ({ item: it, reason: "recent" }));
  }

  const qNorm = normalizeName(q);
  const qSort = tokenSorted(q);

  const scored = byRecent
    .map((it) => {
      const nNorm = normalizeName(it.name);
      const nSort = tokenSorted(it.name);
      let score = 0;
      let reason = "";
      if (nNorm === qNorm) {
        score = 100;
        reason = "exact";
      } else if (nSort === qSort && qSort) {
        score = 90;
        reason = "tokens";
      } else if (nNorm.startsWith(qNorm)) {
        score = 70;
        reason = "starts";
      } else if (nNorm.includes(qNorm)) {
        score = 60;
        reason = "contains";
      } else if (qNorm.length >= 3 && levenshtein(qNorm, nNorm, 2) <= 2) {
        score = 40;
        reason = "typo";
      }
      return { item: it, score, reason };
    })
    .filter((s) => s.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

// Render a short summary line for an item's metadata (for the table row).
function stockMetadataSummary(item) {
  const kind = categoryKind(item.category);
  const m = item.metadata || {};
  if (kind === "gps" && m.imei) return `IMEI: ${m.imei}`;
  if (kind === "sim") {
    const p = m.primary || "";
    const s = m.secondary || "";
    if (p && s) return `${p} · ${s}`;
    if (s) return `ICCID: ${s}`;
    if (p) return `Primary: ${p}`;
  }
  if (kind === "sensor") {
    const sn = m.sensorNo || "";
    const mac = m.macId || "";
    if (sn && mac) return `${sn} · ${mac}`;
    if (sn) return `Sensor: ${sn}`;
    if (mac) return `MAC: ${mac}`;
  }
  return "";
}

function renderStockPage() {
  if (!stockItemsTableReady) {
    app.innerHTML = `
      ${renderHeader("Stock Inventory", "Equipment & spares")}
      <main class="main">
        ${renderAdminNav("stock")}
        <section class="card">
          <h2>⚙️ Migration needed</h2>
          <p>The Stock page needs a one-time setup. Open Supabase SQL Editor and run <code>stock-items-migration.sql</code>, then come back here.</p>
          <div class="form-actions" style="margin-top: 1rem;">
            <a class="btn btn-primary" href="https://supabase.com/dashboard/project/jzclmcjurfehpfybxryh/sql/new" target="_blank" rel="noopener">Open SQL Editor →</a>
            <button type="button" class="btn btn-secondary" id="retryStock">↻ Reload</button>
          </div>
        </section>
      </main>
    `;
    bindLogout();
    bindAdminNav();
    document.getElementById("retryStock")?.addEventListener("click", async () => {
      renderLoading("Checking stock table...");
      try {
        await refreshAllData();
        render();
      } catch (err) {
        renderConnectionError(err.message);
      }
    });
    return;
  }

  const items = loadStockItems();
  const q = stockQuery.toLowerCase().trim();

  // Build category list from existing items + presets (deduped, sorted).
  const liveCategories = Array.from(
    new Set(items.map((i) => i.category).filter(Boolean))
  );
  const allCategoryOptions = getCategoryOptions();

  let filtered = items;
  if (stockCategoryFilter !== "all") {
    filtered = filtered.filter((i) => (i.category || "Uncategorized") === stockCategoryFilter);
  }
  if (q) {
    // Tokenise the query so "fmb 920" matches "FMB-920" and a long IMEI
    // can be searched by any contiguous substring (like Ctrl+F).
    const tokens = q.split(/\s+/).filter(Boolean);
    filtered = filtered.filter((i) => {
      const m = i.metadata || {};
      const hay = [
        i.name,
        i.category || "",
        i.unit || "",
        i.notes || "",
        i.supplier || "",
        m.imei || "",
        m.primary || "",
        m.secondary || "",
        m.sensorNo || "",
        m.macId || "",
      ]
        .join(" ")
        .toLowerCase();
      // ALL tokens must match (AND search)
      return tokens.every((t) => hay.includes(t));
    });
  }

  // Stats
  const totalItems = items.length;
  const totalUnits = items.reduce((sum, i) => sum + (i.quantity || 0), 0);
  const totalValue = items.reduce(
    (sum, i) => sum + (i.costPerUnit != null ? i.quantity * i.costPerUnit : 0),
    0
  );
  // Low-stock only applies to BULK items (Roll, Tape, Drill...). For
  // trackable items (GPS, SIM, Sensor) each row IS one specific unit, so
  // the concept of "low stock" doesn't apply.
  function isLow(item) {
    if (isTrackableCategory(item.category)) return false;
    return item.lowStockThreshold != null && item.quantity <= item.lowStockThreshold;
  }
  const lowStockItems = items.filter(isLow);

  // Category filter chips — color-coded by kind so GPS/SIM/SENSOR are
  // visually distinguishable from generic bulk categories.
  function chipKindClass(category) {
    const k = categoryKind(category);
    if (k === "gps") return "chip-kind-gps";
    if (k === "sim") return "chip-kind-sim";
    if (k === "sensor") return "chip-kind-sensor";
    return "chip-kind-bulk";
  }
  const chipsHtml = `
    <div class="filter-chips" style="margin-bottom: 0.85rem;">
      <button type="button" class="filter-chip ${stockCategoryFilter === "all" ? "active" : ""}" data-cat="all">All (${items.length})</button>
      ${liveCategories
        .sort()
        .map((c) => {
          const count = items.filter((i) => i.category === c).length;
          return `<button type="button" class="filter-chip ${chipKindClass(c)} ${stockCategoryFilter === c ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)} (${count})</button>`;
        })
        .join("")}
    </div>
  `;

  // Per-name stat chips inside the current filter — lets you see
  // "FMB-920: 8" / "FMB-100: 4" at a glance instead of scrolling rows.
  // Aggregates total qty per distinct item name (preserves the trackable
  // grain — each FMB-920 stock row contributes its quantity).
  const nameStats = {};
  for (const it of filtered) {
    const k = it.name;
    if (!nameStats[k]) nameStats[k] = { qty: 0, rows: 0 };
    nameStats[k].qty += it.quantity || 0;
    nameStats[k].rows += 1;
  }
  const nameEntries = Object.entries(nameStats).sort((a, b) => b[1].qty - a[1].qty);
  const STAT_CHIP_COLORS = ["chip-cyan", "chip-blue", "chip-green", "chip-amber", "chip-purple", "chip-teal", "chip-pink", "chip-slate"];
  const nameStripHtml = nameEntries.length > 1 ? `
    <div class="name-stat-strip">
      ${nameEntries
        .map(([name, info], i) => `
          <div class="stat-chip ${STAT_CHIP_COLORS[i % STAT_CHIP_COLORS.length]}">
            <span class="stat-chip-num">${info.qty}</span>
            <span class="stat-chip-name">${escapeHtml(name)}</span>
            ${info.rows !== info.qty ? `<span class="stat-chip-sub">${info.rows} rows</span>` : ""}
          </div>
        `).join("")}
    </div>
  ` : "";

  // Sort: low-stock first, then by name
  filtered.sort((a, b) => {
    const la = isLow(a) ? 0 : 1;
    const lb = isLow(b) ? 0 : 1;
    if (la !== lb) return la - lb;
    return a.name.localeCompare(b.name);
  });

  const fmtMoney = (n) =>
    n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  const fmtQty = (n) => Number(n).toLocaleString("en-IN", { maximumFractionDigits: 3 });

  const tableHtml = filtered.length
    ? filtered
        .map((item) => {
          const low = isLow(item);
          const value = item.costPerUnit != null ? item.quantity * item.costPerUnit : null;
          const uses = getStockUses(item, 3);
          const recentHtml = uses.length
            ? uses
                .map((u) => {
                  if (u.source === "install") {
                    return `<span class="use-pill" title="Currently in installation">${escapeHtml(u.vehicleNo)}<span class="use-qty in-use">in use</span></span>`;
                  }
                  return `<span class="use-pill" title="${escapeHtml(String(-u.delta) + " " + item.unit + " on " + formatDateTime(u.at))}">${escapeHtml(u.vehicleNo)}<span class="use-qty">${u.delta}</span></span>`;
                })
                .join(" ")
            : `<span class="muted">—</span>`;
          const metaSummary = stockMetadataSummary(item);
          return `
            <tr class="${low ? "stock-row-low" : ""}">
              <td>
                <div class="stock-name">${escapeHtml(item.name)}${low ? ` <span class="low-pill">Low stock</span>` : ""}</div>
                ${metaSummary ? `<div class="stock-meta mono">${escapeHtml(metaSummary)}</div>` : ""}
                ${item.notes ? `<div class="stock-notes">${escapeHtml(item.notes.split("\n")[0])}</div>` : ""}
              </td>
              <td>${item.category ? `<span class="cat-pill">${escapeHtml(item.category)}</span>` : `<span class="muted">—</span>`}</td>
              <td>${item.supplier ? `<span class="supplier-pill">${escapeHtml(item.supplier)}</span>` : `<span class="muted">—</span>`}</td>
              <td class="mono qty-cell">${fmtQty(item.quantity)}</td>
              <td class="mono">${escapeHtml(item.unit)}</td>
              <td class="recent-use">${recentHtml}</td>
              <td class="date-cell">${escapeHtml(formatDateTime(item.updatedAt))}</td>
              <td class="row-actions">
                <button type="button" class="btn btn-outline btn-sm stock-edit" data-id="${item.id}">✎ Edit</button>
                <button type="button" class="btn btn-danger btn-sm stock-delete" data-id="${item.id}">Delete</button>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr class="empty-row"><td colspan="8">${q || stockCategoryFilter !== "all" ? "No items match the filters." : "No items in stock yet. Click + Add Item to start."}</td></tr>`;

  app.innerHTML = `
    ${renderHeader("Stock Inventory", "Equipment, spares, and consumables")}
    <main class="main">
      ${renderAdminNav("stock")}
      <div class="summary-grid">
        <div class="summary-box summary-info"><strong>${totalItems}</strong><span>Items</span></div>
        <div class="summary-box summary-ok"><strong>${fmtQty(totalUnits)}</strong><span>Total units</span></div>
        <div class="summary-box ${lowStockItems.length ? "summary-warn" : "summary-ok"}"><strong>${lowStockItems.length}</strong><span>Low stock</span></div>
      </div>
      <section class="card">
        <div class="section-heading">
          <div>
            <h2>All Items (${items.length})</h2>
            <p class="section-subtitle">Track equipment, spares, and consumables. Stock is auto-consumed when Akash uses an item in an installation or repair.</p>
          </div>
          <div class="bulk-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="manageCatsBtn">⚙️ Manage categories</button>
            <button type="button" class="btn btn-secondary btn-sm" id="manageSuppliersBtn">🏷️ Manage suppliers</button>
            <button type="button" class="btn btn-outline btn-sm" id="exportStockBtn">↓ Export Excel</button>
            <button type="button" class="btn btn-primary btn-sm" id="addStockBtn">+ Add Item</button>
          </div>
        </div>
        <div class="list-tools admin-search sticky-search">
          <input type="search" id="stockSearch" placeholder="Search anything — name, IMEI, SIM number, MAC, supplier..." value="${escapeHtml(stockQuery)}" />
        </div>
        ${liveCategories.length ? chipsHtml : ""}
        ${nameStripHtml}
        <div class="table-wrap stock-table-desktop">
          <table>
            <thead>
              <tr>
                <th>Item</th>
                <th>Category</th>
                <th>Supplier</th>
                <th class="num-th">Qty</th>
                <th>Unit</th>
                <th>Recent use</th>
                <th>Last updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>${tableHtml}</tbody>
          </table>
        </div>
        <!-- Mobile card grid -->
        <div class="stock-card-grid">
          ${filtered.length
            ? filtered.map((item) => {
                const low = isLow(item);
                const metaSummary = stockMetadataSummary(item);
                const tail = (s, n = 8) => {
                  const v = String(s || "");
                  return v.length > n ? "…" + v.slice(-n) : v || "—";
                };
                const imei = item.metadata?.imei || "";
                return `
                  <article class="tk-card ${low ? "tk-card-warn" : ""}">
                    <div class="tk-card-head">
                      <span class="tk-pill">${escapeHtml(item.name)}</span>
                      <span class="tk-chip ${low ? "tk-chip-deleted" : "tk-chip-install"}" style="text-decoration:none;">
                        ${fmtQty(item.quantity)} ${escapeHtml(item.unit)}${low ? " · LOW" : ""}
                      </span>
                    </div>
                    <div class="tk-stats">
                      ${item.category ? `
                        <div class="tk-stat">
                          <span class="tk-stat-icon">🏷️</span>
                          <span class="tk-stat-label">Category:</span>
                          <span class="tk-stat-value">${escapeHtml(item.category)}</span>
                        </div>
                      ` : ""}
                      ${item.supplier ? `
                        <div class="tk-stat">
                          <span class="tk-stat-icon">🏭</span>
                          <span class="tk-stat-label">Supplier:</span>
                          <span class="tk-stat-value">${escapeHtml(item.supplier)}</span>
                        </div>
                      ` : ""}
                      ${imei ? `
                        <div class="tk-stat tk-stat-full">
                          <span class="tk-stat-icon">📡</span>
                          <span class="tk-stat-label">IMEI:</span>
                          <span class="tk-stat-value">${escapeHtml(tail(imei, 10))}</span>
                        </div>
                      ` : ""}
                      ${metaSummary && !imei ? `
                        <div class="tk-stat tk-stat-full">
                          <span class="tk-stat-icon">ℹ️</span>
                          <span class="tk-stat-label">Meta:</span>
                          <span class="tk-stat-value" style="white-space:normal;">${escapeHtml(metaSummary)}</span>
                        </div>
                      ` : ""}
                    </div>
                    <div class="tk-footer">
                      <div class="tk-footer-row">
                        <span class="tk-footer-icon">📅</span>
                        <span class="tk-footer-label">Updated:</span>
                        <span class="tk-footer-value">${escapeHtml(formatDateTime(item.updatedAt))}</span>
                      </div>
                    </div>
                    <div class="tk-actions">
                      <button type="button" class="btn btn-outline btn-sm stock-edit" data-id="${item.id}">✎ Edit</button>
                      <button type="button" class="btn btn-danger btn-sm stock-delete" data-id="${item.id}">🗑</button>
                    </div>
                  </article>
                `;
              }).join("")
            : `<div class="entry-empty"><div class="entry-empty-icon">📦</div><h3>No items found</h3><p>${q || stockCategoryFilter !== "all" ? "Try different filters." : "Tap + Add Item to start."}</p></div>`
          }
        </div>
      </section>
    </main>
  `;

  bindLogout();
  bindAdminNav();

  document.getElementById("stockSearch")?.addEventListener("input", (e) => {
    stockQuery = e.target.value;
    render();
    const el = document.getElementById("stockSearch");
    if (el) {
      el.focus();
      const v = el.value;
      el.setSelectionRange(v.length, v.length);
    }
  });

  app.querySelectorAll(".filter-chip[data-cat]").forEach((chip) => {
    chip.addEventListener("click", () => {
      stockCategoryFilter = chip.dataset.cat;
      render();
    });
  });

  // Old single-item editor still available, but NEW default: bulk scan flow
  document.getElementById("addStockBtn")?.addEventListener("click", () => {
    // Show choice modal — Quick scan (bulk) vs Detailed entry
    showModal(`
      <h3>Add to Stock</h3>
      <p class="modal-desc">How do you want to add items?</p>
      <div style="display:flex; flex-direction:column; gap:0.6rem; margin: 1rem 0;">
        <button type="button" class="btn btn-primary" id="chooseBulk" style="padding: 0.85rem;">
          📷 Bulk Scan (multiple items, same type)
        </button>
        <button type="button" class="btn btn-outline" id="chooseSingle" style="padding: 0.85rem;">
          ✏️ Detailed Entry (one item, full fields)
        </button>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      </div>
    `, null);
    setTimeout(() => {
      document.getElementById("chooseBulk")?.addEventListener("click", () => {
        closeModal();
        openBulkStockAdd();
      });
      document.getElementById("chooseSingle")?.addEventListener("click", () => {
        closeModal();
        openStockEditor(null, allCategoryOptions);
      });
    }, 50);
  });
  document.getElementById("manageCatsBtn")?.addEventListener("click", openCategoryManager);
  document.getElementById("manageSuppliersBtn")?.addEventListener("click", openSupplierManager);
  document.getElementById("exportStockBtn")?.addEventListener("click", exportStockToExcel);
  app.querySelectorAll(".stock-edit").forEach((btn) => {
    btn.addEventListener("click", () => openStockEditor(btn.dataset.id, allCategoryOptions));
  });
  app.querySelectorAll(".stock-delete").forEach((btn) => {
    btn.addEventListener("click", () => onDeleteStockItem(btn.dataset.id));
  });
}

function openStockEditor(itemId, categoryOptions) {
  const item = itemId ? loadStockItems().find((i) => i.id === itemId) : null;
  const allItems = loadStockItems();

  // Build a name → most-recent-category map so picking a known name can
  // auto-fill the category.
  const nameToCategory = new Map();
  // Sort by createdAt desc so older items don't overwrite the latest mapping.
  const sortedItems = [...allItems].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  for (const i of sortedItems) {
    if (i.name && !nameToCategory.has(i.name.toLowerCase())) {
      nameToCategory.set(i.name.toLowerCase(), i.category || "");
    }
  }
  const knownNames = Array.from(new Set(sortedItems.map((i) => i.name).filter(Boolean))).sort();

  // Stash on window so the listener can look up without closure capture issues.
  window.__stockNameCategoryMap = nameToCategory;

  modal.innerHTML = `
    <h3>${item ? "✎ Edit item" : "+ Add item"}</h3>
    <div class="field smart-name-field">
      <label for="stkName">Item name <span class="required">*</span></label>
      <div class="combobox">
        <input type="text" id="stkName" autocomplete="off" placeholder="Click to see existing items, or type a new name..." value="${escapeHtml(item?.name || "")}" />
        <div class="combobox-panel hidden" id="namePanel"></div>
      </div>
      <p class="hint" id="nameHint">Pick an existing item from the list to avoid duplicate entries.</p>
      <div class="dup-warn hidden" id="dupWarn"></div>
    </div>
    <div class="field-row">
      <div class="field">
        <label for="stkCategory">Category <span class="required">*</span></label>
        <input type="text" id="stkCategory" autocomplete="off" list="stockCatList" placeholder="GPS, SIM-AIRTEL, SENSOR..." value="${escapeHtml(item?.category || "")}" />
        <datalist id="stockCatList">
          ${categoryOptions.map((c) => `<option value="${escapeHtml(c)}">`).join("")}
        </datalist>
      </div>
      <div class="field">
        <label for="stkQty">Quantity <span class="required">*</span></label>
        <input type="number" id="stkQty" inputmode="decimal" min="0" step="any" autocomplete="off" placeholder="1" value="${item ? item.quantity : 1}" class="mono" />
      </div>
    </div>
    <!-- Hidden unit field (always pcs unless edited) -->
    <input type="hidden" id="stkUnit" value="${escapeHtml(item?.unit || "pcs")}" />

    <!-- Conditional fields based on category -->
    <div id="metaGps" class="meta-block hidden">
      <div class="meta-title">📡 GPS device identifier</div>
      <div class="field">
        <label for="metaImei">IMEI number <span class="required">*</span></label>
        <input type="text" id="metaImei" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 867530012345678" value="${escapeHtml(item?.metadata?.imei || "")}" />
      </div>
    </div>

    <div id="metaSim" class="meta-block hidden">
      <div class="meta-title">📶 SIM card numbers</div>
      <div class="field-row">
        <div class="field">
          <label for="metaSimPrimary">Primary number (13-digit)</label>
          <input type="text" id="metaSimPrimary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 5753200309565" value="${escapeHtml(item?.metadata?.primary || "")}" />
        </div>
        <div class="field">
          <label for="metaSimSecondary">Secondary / ICCID (20-digit) <span class="required">*</span></label>
          <input type="text" id="metaSimSecondary" class="mono" inputmode="numeric" autocomplete="off" placeholder="e.g. 89918720507069156677" value="${escapeHtml(item?.metadata?.secondary || "")}" />
        </div>
      </div>
      <p class="hint">This SIM will also be added to the <strong>SIM Database</strong> automatically so Akash can use it during repair.</p>
    </div>

    <div id="metaSensor" class="meta-block hidden">
      <div class="meta-title">🛰️ Sensor identifiers</div>
      <div class="field-row">
        <div class="field">
          <label for="metaSensorNo">Sensor number <span class="required">*</span></label>
          <input type="text" id="metaSensorNo" class="mono" autocomplete="off" placeholder="e.g. SN-12345" value="${escapeHtml(item?.metadata?.sensorNo || "")}" />
        </div>
        <div class="field">
          <label for="metaMacId">MAC ID <span class="required">*</span></label>
          <input type="text" id="metaMacId" class="mono" autocomplete="off" placeholder="e.g. AA:BB:CC:DD:EE:FF" value="${escapeHtml(item?.metadata?.macId || "")}" />
        </div>
      </div>
    </div>

    <div class="field low-stock-field" id="lowStockField">
      <label for="stkLow">Low-stock alert at</label>
      <input type="number" id="stkLow" inputmode="decimal" min="0" step="any" autocomplete="off" placeholder="5" value="${item?.lowStockThreshold ?? 5}" class="mono" />
      <p class="hint">Only used for bulk consumables (rolls, tape, drill bits).</p>
    </div>
    <div class="field">
      <label for="stkSupplier">Supplier</label>
      <input type="text" id="stkSupplier" autocomplete="off" list="stockSupplierList" placeholder="Pick from list or type a new supplier..." value="${escapeHtml(item?.supplier || "")}" />
      <datalist id="stockSupplierList">
        ${getSupplierOptions().map((s) => `<option value="${escapeHtml(s)}">`).join("")}
      </datalist>
    </div>
    <div class="field">
      <label for="stkNotes">Notes (optional)</label>
      <input type="text" id="stkNotes" autocomplete="off" placeholder="e.g. batch, storage location, condition" value="${escapeHtml(item?.notes || "")}" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">${item ? "Save changes" : "Add item"}</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector("#stkName")?.focus();

  const nameEl = modal.querySelector("#stkName");
  const categoryEl = modal.querySelector("#stkCategory");
  const hintEl = modal.querySelector("#nameHint");

  // Toggle the meta blocks based on category.
  function refreshMetaVisibility() {
    const kind = categoryKind(categoryEl.value);
    modal.querySelector("#metaGps").classList.toggle("hidden", kind !== "gps");
    modal.querySelector("#metaSim").classList.toggle("hidden", kind !== "sim");
    modal.querySelector("#metaSensor").classList.toggle("hidden", kind !== "sensor");
    // Low-stock alert only makes sense for bulk items (Roll, Tape, etc.)
    const trackable = kind === "gps" || kind === "sim" || kind === "sensor";
    modal.querySelector("#lowStockField")?.classList.toggle("hidden", trackable);
  }
  refreshMetaVisibility();
  categoryEl.addEventListener("input", refreshMetaVisibility);
  categoryEl.addEventListener("change", refreshMetaVisibility);

  // When the name matches an existing item, auto-fill its category.
  function autofillCategoryIfKnown() {
    const typed = nameEl.value.trim();
    if (!typed) {
      if (hintEl) {
        hintEl.textContent = "Pick an existing item from the list to avoid duplicate entries.";
        hintEl.className = "hint";
      }
      return;
    }
    const cat = nameToCategory.get(typed.toLowerCase());
    if (cat && !categoryEl.value.trim()) {
      categoryEl.value = cat;
      refreshMetaVisibility();
      if (hintEl) {
        hintEl.textContent = `✓ Recognised — auto-filled category "${cat}".`;
        hintEl.className = "hint hint-ok";
      }
    } else if (cat) {
      if (hintEl) {
        hintEl.textContent = `Existing item. Category for this product is usually "${cat}".`;
        hintEl.className = "hint";
      }
    } else {
      if (hintEl) {
        hintEl.textContent = "New item — pick or type a category below.";
        hintEl.className = "hint";
      }
    }
  }
  nameEl.addEventListener("input", autofillCategoryIfKnown);
  nameEl.addEventListener("change", autofillCategoryIfKnown);
  nameEl.addEventListener("blur", autofillCategoryIfKnown);

  // ----- Smart combobox: suggestions dropdown + duplicate warning -----
  const panelEl = modal.querySelector("#namePanel");
  const dupWarnEl = modal.querySelector("#dupWarn");

  function pickExistingItem(existingItem) {
    nameEl.value = existingItem.name;
    if (existingItem.category) {
      categoryEl.value = existingItem.category;
      refreshMetaVisibility();
    }
    panelEl.classList.add("hidden");
    autofillCategoryIfKnown();
    refreshDupWarn();
  }

  function reasonBadge(reason) {
    switch (reason) {
      case "recent":
        return `<span class="cbi-tag tag-recent">recent</span>`;
      case "exact":
        return `<span class="cbi-tag tag-exact">exact match</span>`;
      case "tokens":
        return `<span class="cbi-tag tag-warn">same words</span>`;
      case "starts":
      case "contains":
        return `<span class="cbi-tag tag-match">match</span>`;
      case "typo":
        return `<span class="cbi-tag tag-warn">possible typo</span>`;
      default:
        return "";
    }
  }

  function renderSuggestions(query) {
    const ranked = rankItemSuggestions(query, item?.id);
    if (!ranked.length) {
      panelEl.classList.add("hidden");
      panelEl.innerHTML = "";
      return;
    }
    // Group: "Recently added" header if showing recent items (no query)
    const headerHtml = !query.trim() ? `<div class="cb-header">Recently added — click to reuse</div>` : "";
    const itemsHtml = ranked
      .map((s) => {
        const it = s.item;
        const metaSummary = stockMetadataSummary(it);
        return `
          <button type="button" class="combobox-item" data-id="${escapeHtml(it.id)}">
            <div class="cbi-main">
              <span class="cbi-name">${escapeHtml(it.name)}</span>
              ${reasonBadge(s.reason)}
            </div>
            <div class="cbi-sub">
              ${it.category ? `<span class="cat-pill">${escapeHtml(it.category)}</span>` : `<span class="muted">no category</span>`}
              <span class="muted">·</span>
              <span class="mono">${it.quantity} ${escapeHtml(it.unit)}</span>
              ${metaSummary ? `<span class="muted"> · </span><span class="mono cbi-meta">${escapeHtml(metaSummary)}</span>` : ""}
            </div>
          </button>`;
      })
      .join("");
    panelEl.innerHTML = headerHtml + itemsHtml;
    panelEl.classList.remove("hidden");

    panelEl.querySelectorAll(".combobox-item").forEach((btn) => {
      // mousedown fires BEFORE blur, so the click is registered even if
      // input loses focus on click.
      btn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const id = btn.dataset.id;
        const found = loadStockItems().find((i) => i.id === id);
        if (found) pickExistingItem(found);
      });
    });
  }

  function refreshDupWarn() {
    const typed = nameEl.value.trim();
    if (!typed) {
      dupWarnEl.classList.add("hidden");
      dupWarnEl.innerHTML = "";
      return;
    }
    const match = findClosestItem(typed, item?.id);
    if (!match) {
      dupWarnEl.classList.add("hidden");
      dupWarnEl.innerHTML = "";
      return;
    }
    let icon = "⚠️";
    let label = "";
    let cls = "dup-warn dup-typo";
    if (match.reason === "exact") {
      icon = "ℹ️";
      label = `Already in stock as <strong>${escapeHtml(match.item.name)}</strong>${match.item.category ? ` (${escapeHtml(match.item.category)})` : ""}. Pick it instead of creating a new entry.`;
      cls = "dup-warn dup-exact";
    } else if (match.reason === "tokens") {
      label = `Looks like the same product, different order/spacing: <strong>${escapeHtml(match.item.name)}</strong>${match.item.category ? ` (${escapeHtml(match.item.category)})` : ""}. Reuse it to avoid duplicates.`;
      cls = "dup-warn dup-tokens";
    } else if (match.reason === "typo") {
      label = `Did you mean <strong>${escapeHtml(match.item.name)}</strong>${match.item.category ? ` (${escapeHtml(match.item.category)})` : ""}?`;
      cls = "dup-warn dup-typo";
    }
    dupWarnEl.className = cls;
    dupWarnEl.innerHTML = `${icon} ${label} <button type="button" class="dup-pick" data-id="${escapeHtml(match.item.id)}">Use existing →</button>`;
    dupWarnEl.classList.remove("hidden");
    dupWarnEl.querySelector(".dup-pick")?.addEventListener("click", () => {
      pickExistingItem(match.item);
    });
  }

  nameEl.addEventListener("focus", () => renderSuggestions(nameEl.value));
  nameEl.addEventListener("input", () => {
    renderSuggestions(nameEl.value);
    refreshDupWarn();
  });
  // Delay hide so the mousedown handler can fire on suggestion clicks.
  nameEl.addEventListener("blur", () => {
    setTimeout(() => panelEl.classList.add("hidden"), 120);
  });
  // Initial duplicate check if editing
  if (item) refreshDupWarn();

  modal.querySelector('[data-act="save"]').onclick = async () => {
    const name = nameEl.value.trim();
    const category = categoryEl.value.trim() || null;
    const unit = modal.querySelector("#stkUnit").value.trim() || "pcs";
    const qtyRaw = modal.querySelector("#stkQty").value;
    const lowRaw = modal.querySelector("#stkLow").value;
    const notes = modal.querySelector("#stkNotes").value.trim() || null;
    const supplier = modal.querySelector("#stkSupplier")?.value.trim() || null;

    if (!name) {
      showToast("Item name is required.", true);
      return;
    }
    if (!category) {
      showToast("Category is required.", true);
      return;
    }
    const quantity = qtyRaw === "" ? 0 : Number(qtyRaw);
    if (Number.isNaN(quantity) || quantity < 0) {
      showToast("Quantity must be a non-negative number.", true);
      return;
    }

    // Collect category-specific metadata.
    const kind = categoryKind(category);
    const metadata = {};
    let simPrimary = null;
    let simSecondary = null;
    if (kind === "gps") {
      const imei = modal.querySelector("#metaImei").value.trim();
      if (!imei) {
        showToast("IMEI number is required for GPS items.", true);
        return;
      }
      // Duplicate check
      const dup = loadStockItems().find(
        (i) => i.id !== item?.id && (i.metadata?.imei || "").toLowerCase() === imei.toLowerCase()
      );
      if (dup) {
        showToast(`IMEI ${imei} already exists in stock (${dup.name}). Edit that item instead.`, true);
        return;
      }
      metadata.imei = imei;
    } else if (kind === "sim") {
      simPrimary = modal.querySelector("#metaSimPrimary").value.trim();
      simSecondary = modal.querySelector("#metaSimSecondary").value.trim();
      if (!simSecondary) {
        showToast("Secondary / ICCID is required for SIM items.", true);
        return;
      }
      // Duplicate check by secondary (the unique permanent ID)
      const dupSec = loadStockItems().find(
        (i) =>
          i.id !== item?.id &&
          (i.metadata?.secondary || "").toLowerCase() === simSecondary.toLowerCase()
      );
      if (dupSec) {
        showToast(
          `ICCID ${simSecondary} already exists in stock (${dupSec.name}). Edit that item instead.`,
          true
        );
        return;
      }
      // Also reject if the entered primary number is already used by another stock SIM
      if (simPrimary) {
        const dupPri = loadStockItems().find(
          (i) =>
            i.id !== item?.id &&
            (i.metadata?.primary || "").toLowerCase() === simPrimary.toLowerCase()
        );
        if (dupPri) {
          showToast(
            `Primary number ${simPrimary} already exists in stock (${dupPri.name}). Each primary must be unique.`,
            true
          );
          return;
        }
      }
      // Auto-detect swap and offer to fix before saving.
      if (pairLooksSwapped(simPrimary, simSecondary)) {
        const swap = await showConfirm({
          title: "Numbers look swapped",
          message: `<strong>${escapeHtml(simPrimary)}</strong> looks like a 20-digit ICCID (should be the secondary), and <strong>${escapeHtml(simSecondary)}</strong> looks like a 13-digit primary number. Swap them before saving?`,
          confirmLabel: "Swap & save",
        });
        if (swap) {
          const tmp = simPrimary;
          simPrimary = simSecondary;
          simSecondary = tmp;
        }
      }
      metadata.primary = simPrimary || null;
      metadata.secondary = simSecondary;
    } else if (kind === "sensor") {
      const sensorNo = modal.querySelector("#metaSensorNo").value.trim();
      const macId = modal.querySelector("#metaMacId").value.trim();
      if (!sensorNo) {
        showToast("Sensor number is required.", true);
        return;
      }
      if (!macId) {
        showToast("MAC ID is required.", true);
        return;
      }
      // Duplicate check (sensor no OR mac id matches another item)
      const dup = loadStockItems().find(
        (i) =>
          i.id !== item?.id &&
          ((sensorNo && (i.metadata?.sensorNo || "").toLowerCase() === sensorNo.toLowerCase()) ||
            (macId && (i.metadata?.macId || "").toLowerCase() === macId.toLowerCase()))
      );
      if (dup) {
        showToast(`Sensor with this number/MAC already exists in stock (${dup.name}).`, true);
        return;
      }
      metadata.sensorNo = sensorNo;
      metadata.macId = macId;
    }

    closeModal();
    renderLoading(item ? "Saving changes..." : "Adding item...");
    try {
      const payload = {
        id: item?.id,
        name,
        category,
        unit,
        quantity,
        costPerUnit: null,
        // Trackable categories don't use the low-stock concept; force null.
        lowStockThreshold: isTrackableCategory(category)
          ? null
          : lowRaw === ""
          ? null
          : Number(lowRaw),
        notes,
        supplier,
        metadata,
      };
      if (item) {
        await updateStockItem(payload);
      } else {
        await insertStockItem(payload);
      }
      // SIM integration: also upsert into the sims table so it shows up in
      // the SIM Database and is auto-found during Akash's repair flow.
      if (kind === "sim" && simSecondary && simsTableReady) {
        try {
          await upsertSim({
            primaryNumber: simPrimary || null,
            secondaryNumber: simSecondary,
            notes: `Stock: ${name}`,
          });
        } catch (simErr) {
          console.warn("Stock SIM also-write to sims table failed:", simErr);
        }
      }
      await refreshAllData();
      render();
      showToast(item ? "Item updated." : "Item added.");
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Save failed.", true);
    }
  };
}

function openStockAdjust(itemId) {
  const item = loadStockItems().find((i) => i.id === itemId);
  if (!item) return;

  const installs = loadInstallations();
  // Sort vehicles alphabetically for the dropdown.
  const sortedInstalls = [...installs].sort((a, b) => a.vehicleNo.localeCompare(b.vehicleNo));

  modal.innerHTML = `
    <h3>± Adjust stock — ${escapeHtml(item.name)}</h3>
    <p class="modal-desc">Current quantity: <strong>${item.quantity} ${escapeHtml(item.unit)}</strong>${item.category ? ` · ${escapeHtml(item.category)}` : ""}</p>
    <div class="field">
      <label for="adjAmount">Adjustment amount</label>
      <input type="number" id="adjAmount" inputmode="decimal" step="any" autocomplete="off" placeholder="e.g. 5 or -2" class="mono" />
      <p class="hint">Use a positive number to <strong>add</strong> stock (received) or a negative number to <strong>remove</strong> (used).</p>
    </div>
    <div class="adj-preview" id="adjPreview">New total: <strong>${item.quantity} ${escapeHtml(item.unit)}</strong></div>
    <div class="field hidden" id="vehicleField">
      <label for="adjVehicle">Used on vehicle (optional)</label>
      <select id="adjVehicle">
        <option value="">— not linked to a vehicle —</option>
        ${sortedInstalls
          .map(
            (i) =>
              `<option value="${escapeHtml(i.id)}" data-vno="${escapeHtml(i.vehicleNo)}">${escapeHtml(i.vehicleNo)}</option>`
          )
          .join("")}
      </select>
      <p class="hint">Picking a vehicle lets the Stock page show "Used in VEHICLE-X" and keep a per-vehicle usage history.</p>
    </div>
    <div class="field">
      <label for="adjNote">Note (optional)</label>
      <input type="text" id="adjNote" autocomplete="off" placeholder="e.g. supplier batch, reason for use" />
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Apply</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  const input = modal.querySelector("#adjAmount");
  const preview = modal.querySelector("#adjPreview");
  const vehicleField = modal.querySelector("#vehicleField");
  input.focus();

  function refreshPreview() {
    const raw = input.value;
    const delta = raw === "" ? 0 : Number(raw);
    // Show vehicle dropdown only when removing stock.
    if (delta < 0) {
      vehicleField.classList.remove("hidden");
    } else {
      vehicleField.classList.add("hidden");
    }
    if (Number.isNaN(delta)) {
      preview.innerHTML = `<span class="warn">Enter a number.</span>`;
      preview.className = "adj-preview warn";
      return;
    }
    const next = item.quantity + delta;
    if (next < 0) {
      preview.innerHTML = `Would go below zero (${next}). Adjust must not exceed current stock.`;
      preview.className = "adj-preview warn";
    } else {
      preview.innerHTML = `New total: <strong>${next} ${escapeHtml(item.unit)}</strong> ${delta > 0 ? `<span class="ok">(+${delta})</span>` : delta < 0 ? `<span class="warn">(${delta})</span>` : ""}`;
      preview.className = "adj-preview ok";
    }
  }
  input.addEventListener("input", refreshPreview);

  modal.querySelector('[data-act="save"]').onclick = async () => {
    const raw = input.value;
    if (raw === "" || raw === "-" || raw === "+") {
      showToast("Enter an adjustment amount.", true);
      return;
    }
    const delta = Number(raw);
    if (Number.isNaN(delta) || delta === 0) {
      showToast("Adjustment must be a non-zero number.", true);
      return;
    }
    const next = item.quantity + delta;
    if (next < 0) {
      showToast(`Cannot go below 0 (current ${item.quantity}, delta ${delta}).`, true);
      return;
    }
    const note = modal.querySelector("#adjNote").value.trim();
    const vehicleSelect = modal.querySelector("#adjVehicle");
    const installationId = delta < 0 ? vehicleSelect?.value || null : null;
    const vehicleNo =
      installationId && vehicleSelect
        ? vehicleSelect.options[vehicleSelect.selectedIndex]?.dataset.vno || null
        : null;

    closeModal();
    renderLoading("Adjusting stock...");
    try {
      // 1) Update the stock_items quantity.
      await updateStockItem({
        ...item,
        quantity: next,
      });
      // 2) Record the transaction (if the migration has been run).
      if (stockTxTableReady) {
        try {
          await insertStockTransaction({
            stockItemId: item.id,
            installationId,
            vehicleNo,
            delta,
            resultingQuantity: next,
            note: note || null,
            createdBy: currentUser || "admin",
          });
        } catch (txErr) {
          // Stock quantity was updated; transaction record failed. Surface a
          // soft warning but don't roll back the quantity change.
          console.warn("Stock transaction record failed:", txErr);
          showToast("Quantity updated but transaction log failed. Run stock-transactions-migration.sql.", true);
        }
      }
      await refreshAllData();
      render();
      const vehicleSuffix = vehicleNo ? ` (linked to ${vehicleNo})` : "";
      showToast(`Stock adjusted to ${next} ${item.unit}${vehicleSuffix}.`);
    } catch (err) {
      await refreshAllData();
      render();
      showToast(err.message || "Adjustment failed.", true);
    }
  };
}

function openStockHistory(itemId) {
  const item = loadStockItems().find((i) => i.id === itemId);
  if (!item) return;
  const txs = getStockItemTransactions(itemId);

  const fmtMoney = (n) =>
    n == null ? "—" : "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  const rowsHtml = txs.length
    ? txs
        .map((t) => {
          const isPositive = t.delta > 0;
          return `
            <tr>
              <td class="date-cell">${escapeHtml(formatDateTime(t.createdAt))}</td>
              <td class="mono"><span class="${isPositive ? "tx-plus" : "tx-minus"}">${isPositive ? "+" : ""}${t.delta}</span></td>
              <td class="mono">${t.resultingQuantity != null ? t.resultingQuantity : "—"}</td>
              <td>${t.vehicleNo ? `<span class="use-pill">${escapeHtml(t.vehicleNo)}</span>` : `<span class="muted">—</span>`}</td>
              <td>${escapeHtml(t.note || "")}</td>
              <td class="mono muted">${escapeHtml(t.createdBy || "—")}</td>
            </tr>
          `;
        })
        .join("")
    : `<tr class="empty-row"><td colspan="6">No transactions recorded for this item yet.</td></tr>`;

  // Summary: total received, total used, # of vehicles served
  const received = txs.filter((t) => t.delta > 0).reduce((s, t) => s + t.delta, 0);
  const used = txs.filter((t) => t.delta < 0).reduce((s, t) => s + Math.abs(t.delta), 0);
  const vehicleSet = new Set(txs.filter((t) => t.vehicleNo).map((t) => t.vehicleNo));

  modal.innerHTML = `
    <h3>🕐 History — ${escapeHtml(item.name)}</h3>
    <p class="modal-desc">Current stock: <strong>${item.quantity} ${escapeHtml(item.unit)}</strong>${item.costPerUnit != null ? ` · ${fmtMoney(item.costPerUnit)}/unit` : ""}</p>
    <div class="history-summary">
      <div class="hs-box"><strong class="tx-plus">+${received}</strong><span>Received</span></div>
      <div class="hs-box"><strong class="tx-minus">−${used}</strong><span>Used</span></div>
      <div class="hs-box"><strong>${vehicleSet.size}</strong><span>Vehicles served</span></div>
      <div class="hs-box"><strong>${txs.length}</strong><span>Total entries</span></div>
    </div>
    <div class="table-wrap history-table-wrap">
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Δ</th>
            <th>After</th>
            <th>Vehicle</th>
            <th>Note</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Close</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
}

async function onDeleteStockItem(itemId) {
  const item = loadStockItems().find((i) => i.id === itemId);
  if (!item) return;

  const reason = await promptForReason({
    title: "Delete this stock item?",
    message: `You're about to remove <strong>${escapeHtml(item.name)}</strong>${item.category ? ` (${escapeHtml(item.category)})` : ""} — current stock <strong>${item.quantity} ${escapeHtml(item.unit)}</strong>. This cannot be undone.`,
    confirmLabel: "Delete item",
    placeholder: "e.g. wrong entry, damaged, returned to supplier",
  });
  if (!reason) return;

  renderLoading("Deleting item...");
  try {
    // 1) Audit log
    await auditDeletion({
      entityType: "stock_item",
      entityId: item.id,
      entityLabel: `${item.name}${item.category ? ` (${item.category})` : ""} · ${item.quantity} ${item.unit}`,
      reason,
      snapshot: item,
    });
    // 2) Record a final transaction so stock history still shows the reason.
    if (stockTxTableReady) {
      try {
        await insertStockTransaction({
          stockItemId: item.id, // FK will be set to NULL after delete
          installationId: null,
          vehicleNo: null,
          delta: -item.quantity,
          resultingQuantity: 0,
          note: `DELETED — reason: ${reason}`,
          createdBy: currentUser || "admin",
          itemNameSnapshot: item.name + (item.category ? ` (${item.category})` : ""),
        });
      } catch (txErr) {
        console.warn("Deletion transaction record failed:", txErr);
      }
    }
    // 3) Delete the row.
    await deleteStockItem(itemId);
    await refreshAllData();
    render();
    showToast("Item deleted.");
  } catch (err) {
    await refreshAllData();
    render();
    showToast(err.message || "Delete failed.", true);
  }
}

function openCategoryManager() {
  const cats = loadStockCategories ? loadStockCategories() : stockCategories;
  const itemsByCat = new Map();
  for (const it of loadStockItems()) {
    if (!it.category) continue;
    itemsByCat.set(it.category, (itemsByCat.get(it.category) || 0) + 1);
  }

  function rowHtml(cat) {
    const inUse = itemsByCat.get(cat.name) || 0;
    return `
      <div class="cat-row">
        <span class="cat-pill">${escapeHtml(cat.name)}</span>
        <span class="cat-usage">${inUse > 0 ? `${inUse} item${inUse === 1 ? "" : "s"} use this` : "not in use"}</span>
        <button type="button" class="btn btn-danger btn-sm cat-delete" data-id="${escapeHtml(cat.id)}" ${inUse > 0 ? "disabled" : ""} title="${inUse > 0 ? "Cannot delete — items use this category" : "Delete this category"}">Delete</button>
      </div>
    `;
  }

  modal.innerHTML = `
    <h3>⚙️ Manage categories</h3>
    <p class="modal-desc">Add new categories or remove ones you don't need. Categories that have items can't be deleted until those items are moved or removed.</p>

    <div class="cat-add-row">
      <input type="text" id="newCatName" autocomplete="off" placeholder="New category name (e.g. SIM-VI)" />
      <button type="button" class="btn btn-primary btn-sm" id="addCatBtn">+ Add</button>
    </div>

    <div class="cat-list" id="catList">
      ${cats.length ? cats.map(rowHtml).join("") : `<p class="muted">No categories yet. Add one above.</p>`}
    </div>

    <div class="modal-actions" style="margin-top: 1rem;">
      <button type="button" class="btn btn-secondary" data-act="cancel">Close</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  function wireListButtons() {
    modal.querySelectorAll(".cat-delete").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", async () => {
        const id = btn.dataset.id;
        const cat = stockCategories.find((c) => c.id === id);
        if (!cat) return;
        const ok = await showConfirm({
          title: "Delete category?",
          message: `Remove "${cat.name}" from the category list? This cannot be undone.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        try {
          await deleteStockCategory(id);
          await refreshAllData();
          // Re-render the modal to reflect the updated list
          closeModal();
          openCategoryManager();
        } catch (err) {
          showToast(err.message || "Delete failed.", true);
        }
      });
    });
  }
  wireListButtons();

  async function addNewCategory() {
    const name = modal.querySelector("#newCatName").value.trim();
    if (!name) {
      showToast("Type a category name first.", true);
      return;
    }
    try {
      await insertStockCategory(name);
      await refreshAllData();
      closeModal();
      openCategoryManager();
    } catch (err) {
      showToast(err.message || "Add failed.", true);
    }
  }
  modal.querySelector("#addCatBtn").onclick = addNewCategory;
  modal.querySelector("#newCatName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNewCategory();
    }
  });
}

function openSupplierManager() {
  const sups = loadSuppliers();
  const itemsBySupplier = new Map();
  for (const it of loadStockItems()) {
    if (!it.supplier) continue;
    itemsBySupplier.set(it.supplier, (itemsBySupplier.get(it.supplier) || 0) + 1);
  }
  function rowHtml(sup) {
    const inUse = itemsBySupplier.get(sup.name) || 0;
    return `
      <div class="cat-row">
        <span class="supplier-pill">${escapeHtml(sup.name)}</span>
        <span class="cat-usage">${inUse > 0 ? `${inUse} item${inUse === 1 ? "" : "s"}` : "not in use"}</span>
        <button type="button" class="btn btn-danger btn-sm sup-delete" data-id="${escapeHtml(sup.id)}" ${inUse > 0 ? "disabled" : ""} title="${inUse > 0 ? "Items use this supplier — clear them first" : "Delete this supplier"}">Delete</button>
      </div>`;
  }
  modal.innerHTML = `
    <h3>🏷️ Manage suppliers</h3>
    <p class="modal-desc">Add suppliers or remove ones you don't use. Suppliers that have items can't be deleted until those items are reassigned.</p>
    <div class="cat-add-row">
      <input type="text" id="newSupName" autocomplete="off" placeholder="Supplier name (e.g. ABC Telecom)" />
      <button type="button" class="btn btn-primary btn-sm" id="addSupBtn">+ Add</button>
    </div>
    <div class="cat-list">
      ${sups.length ? sups.map(rowHtml).join("") : `<p class="muted">No suppliers yet. Add one above.</p>`}
    </div>
    <div class="modal-actions" style="margin-top: 1rem;">
      <button type="button" class="btn btn-secondary" data-act="cancel">Close</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");
  modalOverlay.onclick = (e) => {
    if (e.target === modalOverlay) closeModal();
  };
  modal.querySelector('[data-act="cancel"]').onclick = closeModal;

  modal.querySelectorAll(".sup-delete").forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const sup = suppliers.find((s) => s.id === id);
      if (!sup) return;
      const ok = await showConfirm({
        title: "Delete supplier?",
        message: `Remove "${sup.name}" from the supplier list?`,
        confirmLabel: "Delete",
        danger: true,
      });
      if (!ok) return;
      try {
        await deleteSupplier(id);
        await refreshAllData();
        closeModal();
        openSupplierManager();
      } catch (err) {
        showToast(err.message || "Delete failed.", true);
      }
    });
  });

  async function addNewSupplier() {
    const name = modal.querySelector("#newSupName").value.trim();
    if (!name) {
      showToast("Type a supplier name first.", true);
      return;
    }
    try {
      await insertSupplier(name);
      await refreshAllData();
      closeModal();
      openSupplierManager();
    } catch (err) {
      showToast(err.message || "Add failed.", true);
    }
  }
  modal.querySelector("#addSupBtn").onclick = addNewSupplier;
  modal.querySelector("#newSupName").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addNewSupplier();
    }
  });
}

function render() {
  switch (view) {
    case "login":
      renderLogin();
      break;
    case "akash-home":
      renderAkashHome();
      break;
    case "install":
      renderInstallForm();
      break;
    case "repair":
      renderRepairForm();
      break;
    case "dashboard":
      renderDashboard();
      break;
    case "installations":
      renderInstallationsPage();
      break;
    case "repairs":
      renderRepairsPage();
      break;
    case "pending":
      renderPendingPage();
      break;
    case "sim-upload":
      renderSimUpload();
      break;
    case "sim-db":
      renderSimDb();
      break;
    case "stock":
      renderStockPage();
      break;
    case "accounts":
      renderAccountsPage();
      break;
    case "user-access":
      renderUserAccessPage();
      break;
    case "deletions":
      renderDeletionsPage();
      break;
    case "timeline":
      renderTimeline();
      break;
    // Legacy aliases
    case "admin":
      renderDashboard();
      break;
    default:
      renderLogin();
  }
}

// ============================================================
// ACCOUNTS MODULE (v3.0)
// Balance tracking with project-wise credit / expense / salary
// ============================================================

function formatINR(n) {
  const num = Number(n) || 0;
  return "₹" + num.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function calculateAccountsBalance(transactions) {
  let bal = 0;
  for (const tx of transactions) {
    if (tx.isPlanned) continue; // planned items don't affect current balance
    if (tx.type === "opening" || tx.type === "credit") bal += tx.amount;
    else if (tx.type === "expense" || tx.type === "salary") bal -= tx.amount;
  }
  return bal;
}

function calculateUpcomingTotal(transactions) {
  // Sum of all PLANNED expenses + salaries (these are future outflows)
  let total = 0;
  for (const tx of transactions) {
    if (!tx.isPlanned) continue;
    if (tx.type === "expense" || tx.type === "salary") total += tx.amount;
  }
  return total;
}

function accountsProjectSummary(transactions) {
  const summary = {};
  for (const tx of transactions) {
    if (tx.isPlanned) continue; // planned not yet realized
    const proj = tx.projectName || "Uncategorized";
    if (!summary[proj]) summary[proj] = { credit: 0, expense: 0, salary: 0, net: 0 };
    if (tx.type === "credit") summary[proj].credit += tx.amount;
    else if (tx.type === "expense") summary[proj].expense += tx.amount;
    else if (tx.type === "salary") summary[proj].salary += tx.amount;
  }
  for (const proj in summary) {
    summary[proj].net = summary[proj].credit - summary[proj].expense - summary[proj].salary;
  }
  return summary;
}

function renderAccountsPage() {
  const balance = calculateAccountsBalance(accountsTransactions);
  const upcomingTotal = calculateUpcomingTotal(accountsTransactions);
  const projectedBalance = balance - upcomingTotal;
  const summary = accountsProjectSummary(accountsTransactions);
  const projectKeys = Object.keys(summary).sort((a, b) => Math.abs(summary[b].net) - Math.abs(summary[a].net));

  // Split transactions: actual vs upcoming
  const actualTxs = accountsTransactions.filter((t) => !t.isPlanned);
  const upcomingTxs = accountsTransactions.filter((t) => t.isPlanned).sort((a, b) => {
    return new Date(a.transactionDate || a.createdAt) - new Date(b.transactionDate || b.createdAt);
  });
  const recent = actualTxs.slice(0, 30);

  const totalCredit = actualTxs.filter((t) => t.type === "credit" || t.type === "opening").reduce((s, t) => s + t.amount, 0);
  const totalExpense = actualTxs.filter((t) => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const totalSalary = actualTxs.filter((t) => t.type === "salary").reduce((s, t) => s + t.amount, 0);

  app.innerHTML = `
    ${renderHeader("Accounts", "Money in, money out, project-wise")}
    <main class="main">
      ${renderAdminNav("accounts")}

      <!-- Balance hero: two-column current vs projected -->
      <section class="card acc-hero ${balance < 0 ? "acc-hero-neg" : ""}">
        <div class="acc-hero-split">
          <div class="acc-hero-side acc-hero-current">
            <div class="acc-hero-label">Current Balance</div>
            <div class="acc-hero-amount">${escapeHtml(formatINR(balance))}</div>
            <div class="acc-hero-sub">As of today</div>
          </div>
          <div class="acc-hero-side acc-hero-projected ${projectedBalance < 0 ? "acc-projected-neg" : ""}">
            <div class="acc-hero-label">After Upcoming</div>
            <div class="acc-hero-amount">${escapeHtml(formatINR(projectedBalance))}</div>
            <div class="acc-hero-sub">
              ${upcomingTotal > 0 ? `− ${escapeHtml(formatINR(upcomingTotal))} planned` : "No planned expenses"}
            </div>
          </div>
        </div>
        <div class="acc-hero-stats">
          <div class="acc-hero-stat">
            <span class="acc-hero-stat-dot" style="background:#10b981;"></span>
            <span class="acc-hero-stat-label">Credits</span>
            <span class="acc-hero-stat-value">${escapeHtml(formatINR(totalCredit))}</span>
          </div>
          <div class="acc-hero-stat">
            <span class="acc-hero-stat-dot" style="background:#f97316;"></span>
            <span class="acc-hero-stat-label">Expenses</span>
            <span class="acc-hero-stat-value">${escapeHtml(formatINR(totalExpense))}</span>
          </div>
          <div class="acc-hero-stat">
            <span class="acc-hero-stat-dot" style="background:#8b5cf6;"></span>
            <span class="acc-hero-stat-label">Salaries</span>
            <span class="acc-hero-stat-value">${escapeHtml(formatINR(totalSalary))}</span>
          </div>
        </div>
        <div class="acc-actions">
          <button type="button" class="btn btn-primary" id="addCreditBtn">＋ Credit</button>
          <button type="button" class="btn btn-outline" id="addExpenseBtn">－ Expense</button>
          <button type="button" class="btn btn-outline" id="addSalaryBtn">👤 Salary</button>
          <button type="button" class="btn btn-warn" id="addUpcomingBtn">⏳ Upcoming</button>
          ${accountsTransactions.length === 0 ? `<button type="button" class="btn btn-secondary btn-sm" id="setOpeningBtn">Set Opening</button>` : ""}
        </div>
      </section>

      <!-- Upcoming expenses section (only shown if there are any) -->
      ${upcomingTxs.length > 0 ? `
        <section class="card acc-upcoming-card">
          <div class="section-heading">
            <div>
              <h2>⏳ Upcoming Expenses (${upcomingTxs.length})</h2>
              <p class="section-subtitle">Planned outflows. Mark Paid when payment done → moves to actual expenses.</p>
            </div>
            <div class="acc-upcoming-total">
              <span class="acc-upcoming-total-label">Total upcoming</span>
              <strong>${escapeHtml(formatINR(upcomingTotal))}</strong>
            </div>
          </div>
          <div class="acc-upcoming-list">
            ${upcomingTxs.map((tx) => {
              const dueDate = tx.transactionDate || tx.createdAt;
              const dueDateObj = new Date(dueDate);
              const today = new Date();
              today.setHours(0,0,0,0);
              const isDue = dueDateObj <= today;
              const isSoon = !isDue && (dueDateObj - today) < 7 * 86400000;
              const typeLabel = tx.type === "salary" ? "👤 Salary" : "－ Expense";
              return `
                <article class="acc-upcoming-item ${isDue ? "acc-upcoming-due" : isSoon ? "acc-upcoming-soon" : ""}">
                  <div class="acc-upcoming-head">
                    <span class="acc-upcoming-type">${typeLabel}</span>
                    ${isDue ? `<span class="acc-upcoming-badge acc-badge-due">⚠️ Due</span>` : isSoon ? `<span class="acc-upcoming-badge acc-badge-soon">Soon</span>` : ""}
                  </div>
                  <div class="acc-upcoming-main">
                    <div class="acc-upcoming-desc">
                      <strong>${escapeHtml(tx.projectName || "Uncategorized")}</strong>
                      ${tx.description ? `<span>${escapeHtml(tx.description)}</span>` : ""}
                    </div>
                    <div class="acc-upcoming-amount">${escapeHtml(formatINR(tx.amount))}</div>
                  </div>
                  <div class="acc-upcoming-foot">
                    <span class="acc-upcoming-date">📅 ${escapeHtml(formatDateTime(dueDate))}</span>
                    <div class="acc-upcoming-actions">
                      <button type="button" class="btn btn-primary btn-sm acc-mark-paid" data-id="${tx.id}">✓ Mark Paid</button>
                      <button type="button" class="btn btn-danger btn-sm acc-delete-tx" data-id="${tx.id}">🗑</button>
                    </div>
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        </section>
      ` : ""}

      <!-- Project-wise summary -->
      <section class="card">
        <div class="section-heading">
          <h2>📊 Project-wise Summary</h2>
        </div>
        ${projectKeys.length === 0 ? `
          <div class="entry-empty">
            <div class="entry-empty-icon">📂</div>
            <h3>No transactions yet</h3>
            <p>Add a credit or expense to see project-wise summary.</p>
          </div>
        ` : `
          <div class="table-wrap acc-summary-desktop">
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th class="num">Credit</th>
                  <th class="num">Expense</th>
                  <th class="num">Salary</th>
                  <th class="num">Net</th>
                </tr>
              </thead>
              <tbody>
                ${projectKeys.map((p) => `
                  <tr>
                    <td>${escapeHtml(p)}</td>
                    <td class="num mono">${escapeHtml(formatINR(summary[p].credit))}</td>
                    <td class="num mono">${escapeHtml(formatINR(summary[p].expense))}</td>
                    <td class="num mono">${escapeHtml(formatINR(summary[p].salary))}</td>
                    <td class="num mono" style="font-weight:800; color:${summary[p].net >= 0 ? "#047857" : "#b91c1c"};">${escapeHtml(formatINR(summary[p].net))}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
          <!-- Mobile card view -->
          <div class="acc-summary-cards">
            ${projectKeys.map((p) => `
              <article class="tk-card">
                <div class="tk-card-head">
                  <span class="tk-pill">${escapeHtml(p)}</span>
                  <span class="tk-chip ${summary[p].net >= 0 ? "tk-chip-install" : "tk-chip-deleted"}" style="text-decoration:none;">${escapeHtml(formatINR(summary[p].net))}</span>
                </div>
                <div class="tk-stats">
                  <div class="tk-stat">
                    <span class="tk-stat-icon" style="color:#10b981;">●</span>
                    <span class="tk-stat-label">Credit:</span>
                    <span class="tk-stat-value">${escapeHtml(formatINR(summary[p].credit))}</span>
                  </div>
                  <div class="tk-stat">
                    <span class="tk-stat-icon" style="color:#f97316;">●</span>
                    <span class="tk-stat-label">Expense:</span>
                    <span class="tk-stat-value">${escapeHtml(formatINR(summary[p].expense))}</span>
                  </div>
                  <div class="tk-stat tk-stat-full">
                    <span class="tk-stat-icon" style="color:#8b5cf6;">●</span>
                    <span class="tk-stat-label">Salary:</span>
                    <span class="tk-stat-value">${escapeHtml(formatINR(summary[p].salary))}</span>
                  </div>
                </div>
              </article>
            `).join("")}
          </div>
        `}
      </section>

      <!-- Recent transactions -->
      <section class="card">
        <div class="section-heading">
          <h2>🕒 Recent Transactions</h2>
        </div>
        ${recent.length === 0 ? `
          <p style="color:#94a3b8; text-align:center; padding: 1rem 0;">No transactions yet.</p>
        ` : `
          <div class="table-wrap acc-tx-desktop">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Project</th>
                  <th>Description</th>
                  <th class="num">Amount</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${recent.map((tx) => {
                  const isOut = tx.type === "expense" || tx.type === "salary";
                  const typeClass = tx.type === "credit" ? "badge-ok" : tx.type === "expense" ? "badge-warn" : tx.type === "salary" ? "badge-info" : "badge";
                  const typeLabel = tx.type === "opening" ? "Opening" : tx.type === "credit" ? "Credit" : tx.type === "salary" ? "Salary" : "Expense";
                  return `
                    <tr>
                      <td class="date-cell">${escapeHtml(formatDateTime(tx.transactionDate || tx.createdAt))}</td>
                      <td><span class="badge ${typeClass}">${escapeHtml(typeLabel)}</span></td>
                      <td>${escapeHtml(tx.projectName || "—")}</td>
                      <td>${escapeHtml(tx.description || "")}</td>
                      <td class="num mono" style="font-weight:800; color:${isOut ? "#b91c1c" : "#047857"};">${isOut ? "−" : "+"} ${escapeHtml(formatINR(tx.amount))}</td>
                      <td class="row-actions"><button type="button" class="btn btn-danger btn-sm acc-delete-tx" data-id="${tx.id}">🗑</button></td>
                    </tr>
                  `;
                }).join("")}
              </tbody>
            </table>
          </div>
          <div class="acc-tx-cards">
            ${recent.map((tx) => {
              const isOut = tx.type === "expense" || tx.type === "salary";
              const typeLabel = tx.type === "opening" ? "Opening" : tx.type === "credit" ? "Credit" : tx.type === "salary" ? "Salary" : "Expense";
              const chipClass = tx.type === "credit" || tx.type === "opening" ? "tk-chip-install" : tx.type === "salary" ? "tk-chip-repair" : "tk-chip-deleted";
              return `
                <article class="tk-card" style="margin-bottom: 0.6rem;">
                  <div class="tk-card-head">
                    <span class="tk-pill">${escapeHtml(tx.projectName || "Uncategorized")}</span>
                    <span class="tk-chip ${chipClass}" style="text-decoration:none;">${escapeHtml(typeLabel)}</span>
                  </div>
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem;">
                    <div style="font-family: var(--font-mono); font-size: 1.1rem; font-weight: 800; color: ${isOut ? "#b91c1c" : "#047857"};">
                      ${isOut ? "−" : "+"} ${escapeHtml(formatINR(tx.amount))}
                    </div>
                    <div style="font-size: 0.72rem; color: #64748b;">${escapeHtml(formatDateTime(tx.transactionDate || tx.createdAt))}</div>
                  </div>
                  ${tx.description ? `<div style="font-size: 0.78rem; color: #475569; margin-bottom: 0.3rem;">${escapeHtml(tx.description)}</div>` : ""}
                  <div class="tk-actions" style="padding-top: 0.5rem;">
                    <button type="button" class="btn btn-danger btn-sm acc-delete-tx" data-id="${tx.id}">🗑 Delete</button>
                  </div>
                </article>
              `;
            }).join("")}
          </div>
        `}
      </section>
    </main>
  `;

  bindLogout();
  bindAdminNav();
  document.getElementById("addCreditBtn")?.addEventListener("click", () => openAccountsTxModal("credit"));
  document.getElementById("addExpenseBtn")?.addEventListener("click", () => openAccountsTxModal("expense"));
  document.getElementById("addSalaryBtn")?.addEventListener("click", () => openAccountsTxModal("salary"));
  document.getElementById("addUpcomingBtn")?.addEventListener("click", () => openAccountsUpcomingModal());
  document.getElementById("setOpeningBtn")?.addEventListener("click", () => openAccountsTxModal("opening"));
  document.querySelectorAll(".acc-delete-tx").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.id;
      handleAccountsDeleteTx(id);
    });
  });
  document.querySelectorAll(".acc-mark-paid").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.id;
      handleMarkUpcomingPaid(id);
    });
  });
}

async function handleMarkUpcomingPaid(id) {
  const tx = accountsTransactions.find((t) => t.id === id);
  if (!tx) return;
  const ok = await showConfirm({
    title: "Mark as Paid?",
    message: `<strong>${escapeHtml(formatINR(tx.amount))}</strong> — ${escapeHtml(tx.projectName || "Uncategorized")}<br><br>This will move it from upcoming to actual expenses with today's date.`,
    confirmLabel: "✓ Yes, Mark Paid",
  });
  if (!ok) return;
  const todayISO = new Date().toISOString().slice(0, 10);
  try {
    await updateAccountsTransaction(id, {
      isPlanned: false,
      transactionDate: todayISO,
    });
    // Update local state too
    tx.isPlanned = false;
    tx.transactionDate = todayISO;
    render();
    showToast("Marked as paid — added to expenses.");
  } catch (err) {
    showToast(err.message || "Failed to mark paid.", true);
    await refreshAllData();
    render();
  }
}

function openAccountsUpcomingModal() {
  // Default to ~30 days in future
  const future = new Date();
  future.setDate(future.getDate() + 30);
  const futureISO = future.toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  const allProjects = [...new Set(accountsTransactions.map((t) => t.projectName).filter(Boolean))];
  const projectOptions = allProjects.map((p) => `<option value="${escapeHtml(p)}"></option>`).join("");

  modal.innerHTML = `
    <h3>⏳ Add Upcoming Expense</h3>
    <p class="modal-desc">Planned future outflow. Won't affect current balance until you mark it paid.</p>

    <div class="form-grid">
      <div class="field full-width">
        <label>Type</label>
        <div class="seg-control" id="upcomingTypeSeg">
          <button type="button" class="seg-btn active" data-type="expense">－ Expense</button>
          <button type="button" class="seg-btn" data-type="salary">👤 Salary</button>
        </div>
      </div>
      <div class="field">
        <label for="upcAmount">Amount (₹) <span class="required">*</span></label>
        <input type="number" id="upcAmount" min="0" step="0.01" placeholder="0.00" inputmode="decimal" autocomplete="off" autofocus />
      </div>
      <div class="field">
        <label for="upcDueDate">Expected Date <span class="required">*</span></label>
        <input type="date" id="upcDueDate" value="${futureISO}" min="${today}" />
      </div>
      <div class="field full-width">
        <label for="upcProject">Project / Description</label>
        <input type="text" id="upcProject" list="upcProjectList" placeholder="e.g. Q3 Office rent, Salary - Ramesh" autocomplete="off" />
        <datalist id="upcProjectList">${projectOptions}</datalist>
      </div>
      <div class="field full-width">
        <label for="upcDesc">Notes (optional)</label>
        <textarea id="upcDesc" rows="2" placeholder="Any additional context..."></textarea>
      </div>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-warn" data-act="save">⏳ Add to Upcoming</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");

  // Type toggle
  let _upcType = "expense";
  document.querySelectorAll("#upcomingTypeSeg .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _upcType = btn.dataset.type;
      document.querySelectorAll("#upcomingTypeSeg .seg-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.type === _upcType);
      });
    });
  });

  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const amount = parseFloat(document.getElementById("upcAmount").value);
    const dueDate = document.getElementById("upcDueDate").value;
    const projectName = document.getElementById("upcProject").value.trim();
    const description = document.getElementById("upcDesc").value.trim();
    if (!amount || amount <= 0) {
      showToast("Please enter a valid amount.", true);
      return;
    }
    if (!dueDate) {
      showToast("Please pick an expected date.", true);
      return;
    }
    try {
      const tx = {
        id: crypto.randomUUID(),
        type: _upcType,
        amount,
        projectName: projectName || "Uncategorized",
        description,
        transactionDate: dueDate,
        isPlanned: true,
        createdBy: currentUser || "admin",
      };
      const saved = await insertAccountsTransaction(tx);
      accountsTransactions.unshift({
        ...tx,
        ...saved,
        isPlanned: true,
      });
      closeModal();
      render();
      showToast("Upcoming expense added.");
    } catch (err) {
      showToast(err.message || "Failed to add.", true);
    }
  };
}

function openAccountsTxModal(type) {
  const today = new Date().toISOString().slice(0, 10);
  const projOptions = accountsProjects
    .map((p) => `<option value="${escapeHtml(p.name)}"></option>`)
    .join("");

  const titles = {
    opening: "🏁 Set Opening Balance",
    credit: "＋ Add Credit",
    expense: "－ Add Expense",
    salary: "👤 Add Salary",
  };
  const hints = {
    opening: "Aapke paas abhi kitna paisa hai? Iske baad credit/expense add karke balance maintain hoga.",
    credit: "Kis project se paise mile? Project ka naam type karo, naya bhi add ho jaayega.",
    expense: "Kis project pe kharch hua? Project select karo aur amount enter karo.",
    salary: "Kis project ka salary paid? Person ka naam description me likho.",
  };

  modal.innerHTML = `
    <h3>${escapeHtml(titles[type])}</h3>
    <p class="modal-desc">${escapeHtml(hints[type])}</p>
    <div class="form-grid">
      <div class="field">
        <label for="accTxAmount">Amount (₹) <span class="required">*</span></label>
        <input type="number" id="accTxAmount" required min="0" step="0.01" placeholder="e.g. 5000" inputmode="decimal" autofocus />
      </div>
      ${type !== "opening" ? `
        <div class="field">
          <label for="accTxProject">Project <span class="required">*</span></label>
          <input type="text" id="accTxProject" required placeholder="Type project name (or pick from list)" autocomplete="off" list="accProjectsList" />
          <datalist id="accProjectsList">${projOptions}</datalist>
          <p class="hint">Naya project name daal sakte ho — automatic add ho jaayega.</p>
        </div>
      ` : ""}
      <div class="field full-width">
        <label for="accTxDesc">Description / Notes</label>
        <input type="text" id="accTxDesc" placeholder="e.g. Salary for May / Office supplies / Client payment" autocomplete="off" />
      </div>
      <div class="field">
        <label for="accTxDate">Date</label>
        <input type="date" id="accTxDate" value="${today}" />
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="save">Save</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");

  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="save"]').onclick = async () => {
    const amount = parseFloat(document.getElementById("accTxAmount").value);
    const projInput = document.getElementById("accTxProject");
    const projectName = projInput ? projInput.value.trim() : "";
    const description = document.getElementById("accTxDesc").value.trim();
    const date = document.getElementById("accTxDate").value || today;

    if (!amount || amount <= 0) {
      showToast("Please enter a valid amount.", true);
      return;
    }
    if (type !== "opening" && !projectName) {
      showToast("Please enter a project name.", true);
      return;
    }

    try {
      // If new project — create it
      let projectId = null;
      if (projectName) {
        const existing = accountsProjects.find((p) => p.name.toLowerCase() === projectName.toLowerCase());
        if (existing) {
          projectId = existing.id;
        } else {
          const newProj = await insertAccountsProject({
            id: "proj-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
            name: projectName,
            createdBy: currentUser,
          });
          accountsProjects.push(newProj);
          projectId = newProj.id;
        }
      }
      const tx = await insertAccountsTransaction({
        id: "tx-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        type,
        amount,
        projectId,
        projectName: projectName || null,
        description,
        transactionDate: date,
        createdBy: currentUser,
      });
      accountsTransactions = [tx, ...accountsTransactions];
      closeModal();
      const labels = { opening: "Opening balance set", credit: "Credit added", expense: "Expense added", salary: "Salary added" };
      showToast(`✓ ${labels[type]} (${formatINR(amount)})`);
      render();
    } catch (err) {
      console.error("Save transaction failed", err);
      showToast(err.message || "Failed to save. Run accounts-migration.sql in Supabase first.", true);
    }
  };
}

async function handleAccountsDeleteTx(id) {
  const tx = accountsTransactions.find((t) => t.id === id);
  if (!tx) return;
  showModal(
    `
    <h3>Delete Transaction?</h3>
    <p class="modal-desc">${escapeHtml(formatINR(tx.amount))} · ${escapeHtml(tx.projectName || "—")} · ${escapeHtml(tx.description || "")}</p>
    <p class="modal-desc" style="color:#b91c1c;">This will affect your balance. Continue?</p>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary modal-close">Cancel</button>
      <button type="button" class="btn btn-danger modal-confirm">Delete</button>
    </div>
    `,
    async () => {
      try {
        await deleteAccountsTransaction(id);
        accountsTransactions = accountsTransactions.filter((t) => t.id !== id);
        closeModal();
        showToast("✓ Transaction deleted");
        render();
      } catch (err) {
        showToast(err.message || "Delete failed", true);
      }
    }
  );
}

// ============================================================
// USER ACCESS PAGE (v3.1) — Admin manages page permissions
// ============================================================

function renderUserAccessPage() {
  const allPages = [
    { key: "dashboard",     label: "🏠 Home (Admin Dashboard)" },
    { key: "installations", label: "🚛 Installations" },
    { key: "repairs",       label: "🛠️ Repair Work" },
    { key: "pending",       label: "⚙️ Repair Progress" },
    { key: "sim-db",        label: "📶 SIM Database" },
    { key: "stock",         label: "📦 Stock" },
    { key: "accounts",      label: "₹ Accounts" },
    { key: "timeline",      label: "📅 Vehicle Timeline" },
    { key: "deletions",     label: "🗑️ Deletion Audit Log" },
    { key: "user-access",   label: "👥 User Access (admin only)" },
    { key: "akash-home",    label: "📋 Akash Home (field worker)" },
    { key: "install",       label: "🆕 New Install (form)" },
    { key: "repair",        label: "🔧 Report Repair (form)" },
  ];

  const allUsers = Object.keys(USERS);

  app.innerHTML = `
    ${renderHeader("User Access", "Manage who can see which pages")}
    <main class="main">
      ${renderAdminNav("user-access")}
      <section class="card">
        <div class="section-heading">
          <h2>👥 User Access Control</h2>
        </div>
        <p class="hint" style="margin-bottom: 1rem;">Check the pages each user should be able to access. Changes save instantly.</p>

        ${allUsers.map((username) => {
          const perms = getUserPerms(username) || { displayName: username, isAdmin: false, allowedPages: [] };
          const isAdminUser = perms.isAdmin || username === "admin";
          return `
            <div class="user-access-card">
              <div class="user-access-head">
                <div>
                  <h3 class="user-access-name">${escapeHtml(perms.displayName || username)}</h3>
                  <code class="user-access-username">@${escapeHtml(username)}</code>
                </div>
                ${isAdminUser ? `<span class="badge badge-ok">🛡️ Admin (full access)</span>` : ""}
              </div>
              ${isAdminUser ? "" : `
                <div class="user-access-pages">
                  ${allPages.map((p) => `
                    <label class="user-access-page-check">
                      <input type="checkbox" data-user="${escapeHtml(username)}" data-page="${escapeHtml(p.key)}" ${(perms.allowedPages || []).includes(p.key) ? "checked" : ""} />
                      <span>${escapeHtml(p.label)}</span>
                    </label>
                  `).join("")}
                </div>
              `}
            </div>
          `;
        }).join("")}
      </section>
    </main>
  `;

  bindLogout();
  bindAdminNav();

  document.querySelectorAll(".user-access-page-check input").forEach((cb) => {
    cb.addEventListener("change", async (e) => {
      const username = e.target.dataset.user;
      const page = e.target.dataset.page;
      const perms = getUserPerms(username) || { ...DEFAULT_PERMISSIONS[username] } || { displayName: username, isAdmin: false, allowedPages: [] };
      const allowed = new Set(perms.allowedPages || []);
      if (e.target.checked) allowed.add(page);
      else allowed.delete(page);
      const newPerms = {
        username,
        displayName: perms.displayName,
        isAdmin: !!perms.isAdmin,
        allowedPages: Array.from(allowed),
        updatedBy: currentUser,
      };
      try {
        await upsertUserPermission(newPerms);
        userPermissions[username] = newPerms;
        showToast(`✓ ${username} access updated`);
      } catch (err) {
        showToast(err.message || "Failed to save. Run user-permissions-migration.sql first.", true);
        e.target.checked = !e.target.checked; // revert
      }
    });
  });
}

// ============================================================
// BULK STOCK SCAN FLOW (v3.1)
// Click Add → enter metadata → scan multiple IMEIs → save all
// ============================================================

let _bulkScanState = {
  active: false,
  meta: null,
  scanned: [], // array of IMEI strings
  scanner: null,
};

function openBulkStockAdd() {
  const categories = [...new Set(stockItems.map((s) => s.category).filter(Boolean))];
  const supplierOptions = suppliers.map((s) => `<option value="${escapeHtml(s.name)}"></option>`).join("");
  const categoryOptions = [...new Set([
    ...stockCategories.map((c) => c.name),
    ...categories,
  ])].map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");

  modal.innerHTML = `
    <h3>📦 Add Stock Items — Step 1 of 2</h3>
    <p class="modal-desc">Enter item details + what kind of code each unit has.</p>
    <div class="form-grid">
      <div class="field full-width">
        <label for="bulkItemName">Item Name <span class="required">*</span></label>
        <input type="text" id="bulkItemName" required placeholder="e.g. GPS Device - Normal" autocomplete="off" autofocus />
      </div>
      <div class="field">
        <label for="bulkItemCategory">Category</label>
        <input type="text" id="bulkItemCategory" list="bulkCatList" placeholder="e.g. GPS, SIM-JIO, Sensor" autocomplete="off" />
        <datalist id="bulkCatList">${categoryOptions}</datalist>
      </div>
      <div class="field">
        <label for="bulkItemSupplier">Supplier</label>
        <input type="text" id="bulkItemSupplier" list="bulkSupList" placeholder="Supplier name" autocomplete="off" />
        <datalist id="bulkSupList">${supplierOptions}</datalist>
      </div>
      <div class="field full-width">
        <label>What code will you scan?</label>
        <div class="seg-control" id="bulkCodeType">
          <button type="button" class="seg-btn active" data-type="any">🌀 Any code</button>
          <button type="button" class="seg-btn" data-type="imei">📡 IMEI only</button>
          <button type="button" class="seg-btn" data-type="iccid">📶 SIM NO only</button>
        </div>
        <p class="hint" id="codeTypeHint">Any mode: koi bhi barcode/QR accept hoga. Filter chahiye to specific mode pick karo.</p>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary" data-act="continue">Continue to Scan →</button>
    </div>
  `;
  modalOverlay.classList.remove("hidden");

  // Code-type segmented control wiring
  let _codeType = "any";
  const seg = document.getElementById("bulkCodeType");
  const hint = document.getElementById("codeTypeHint");
  const hints = {
    any: "Any mode: koi bhi barcode/QR accept hoga. Filter chahiye to specific mode pick karo.",
    imei: "IMEI mode: scanner sirf 14-17 digit numbers accept karega. IMSI / SIM NO / QR ignore honge.",
    iccid: "SIM NO mode: scanner sirf 89... se start hone wale 18-22 digit ICCIDs accept karega. IMSI / QR ignore.",
  };
  seg?.querySelectorAll(".seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _codeType = btn.dataset.type;
      seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === _codeType));
      if (hint) hint.textContent = hints[_codeType];
    });
  });

  // Auto-detect from category typing
  document.getElementById("bulkItemCategory")?.addEventListener("input", (e) => {
    const v = (e.target.value || "").toLowerCase();
    let detected = null;
    if (/sim|iccid/.test(v)) detected = "iccid";
    else if (/gps|imei|device|tracker/.test(v)) detected = "imei";
    if (detected && detected !== _codeType) {
      _codeType = detected;
      seg?.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.type === detected));
      if (hint) hint.textContent = hints[detected];
    }
  });

  modal.querySelector('[data-act="cancel"]').onclick = closeModal;
  modal.querySelector('[data-act="continue"]').onclick = () => {
    const name = document.getElementById("bulkItemName").value.trim();
    const category = document.getElementById("bulkItemCategory").value.trim() || "Uncategorized";
    const supplier = document.getElementById("bulkItemSupplier").value.trim() || "";
    if (!name) {
      showToast("Please enter item name.", true);
      return;
    }
    _bulkScanState = {
      active: true,
      meta: { name, category, supplier, codeType: _codeType },
      scanned: [],
      scanner: null,
    };
    openBulkScanModal();
  };
}

// ----- Audio + visual feedback helpers (v3.1.1) -----
let _audioCtx = null;
function playBeep(frequency = 880, duration = 0.08) {
  try {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = frequency;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.25, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + duration);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + duration);
  } catch (e) {}
}

function flashScanSuccess() {
  const v = document.querySelector(".bulk-scan-viewfinder");
  if (v) {
    v.classList.add("scan-flash-success");
    setTimeout(() => v.classList.remove("scan-flash-success"), 280);
  }
}

function flashScanReject() {
  const v = document.querySelector(".bulk-scan-viewfinder");
  if (v) {
    v.classList.add("scan-flash-reject");
    setTimeout(() => v.classList.remove("scan-flash-reject"), 280);
  }
}

function openBulkScanModal() {
  const hasNativeDetector =
    typeof window.BarcodeDetector !== "undefined" &&
    window.isSecureContext;

  const codeType = _bulkScanState.meta?.codeType || "any";
  const typeLabels = {
    imei:  { label: "IMEI", desc: "14-17 digit device serial", icon: "📡" },
    iccid: { label: "SIM NO", desc: "89… 20-digit ICCID", icon: "📶" },
    any:   { label: "Any", desc: "any code", icon: "🌀" },
  };
  const typeInfo = typeLabels[codeType] || typeLabels.any;

  modal.innerHTML = `
    <h3>📷 Scan Items — ${escapeHtml(_bulkScanState.meta.name)}</h3>
    <p class="modal-desc">
      Looking for: <strong id="scanModeBadge">${typeInfo.icon} ${escapeHtml(typeInfo.label)}</strong>
      <span style="color:#94a3b8;">(${escapeHtml(typeInfo.desc)})</span>
    </p>

    <div class="seg-control" id="scanModeSwitcher" style="margin-bottom: 0.7rem;">
      <button type="button" class="seg-btn ${codeType === 'any' ? 'active' : ''}" data-type="any">🌀 Any</button>
      <button type="button" class="seg-btn ${codeType === 'imei' ? 'active' : ''}" data-type="imei">📡 IMEI</button>
      <button type="button" class="seg-btn ${codeType === 'iccid' ? 'active' : ''}" data-type="iccid">📶 SIM NO</button>
    </div>

    <div class="bulk-scan-stats">
      <span class="bulk-stat-label">Scanned</span>
      <span class="bulk-stat-num" id="bulkScanCount">0</span>
    </div>

    <div class="qr-reader-wrap bulk-scan-viewfinder">
      <video id="bulkScanVideo" autoplay playsinline muted></video>
      <div class="qr-scan-line"></div>
      <div class="qr-controls">
        <button type="button" class="qr-icon-btn" id="bulkTorchBtn" style="display:none;" aria-label="Torch">🔦</button>
      </div>
      <div class="qr-status" id="qrStatus">Initialising camera…</div>
    </div>

    <div class="manual-entry-block" style="margin-top: 0.7rem;">
      <div class="input-with-scan">
        <input type="text" id="bulkManualImei" placeholder="Or type ${escapeHtml(typeInfo.label)} manually" inputmode="numeric" autocomplete="off" />
        <button type="button" class="btn btn-primary btn-sm" id="bulkManualAdd">+ Add</button>
      </div>
    </div>

    <div class="bulk-scanned-list">
      <h4>Scanned Items <span class="bulk-list-count" id="bulkListCount">(0)</span></h4>
      <ol id="bulkScannedList" class="bulk-list">
        <li class="bulk-list-empty">No items scanned yet</li>
      </ol>
    </div>

    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
      <button type="button" class="btn btn-primary btn-block" id="bulkSaveAll" disabled>Save All (0)</button>
    </div>
  `;
  modal.classList.add("modal-wide");
  modalOverlay.classList.remove("hidden");

  const setStatus = (t) => {
    const s = document.getElementById("qrStatus");
    if (s) s.textContent = t;
  };

  const updateUI = () => {
    const list = document.getElementById("bulkScannedList");
    const count = _bulkScanState.scanned.length;
    const countEl = document.getElementById("bulkScanCount");
    if (countEl) countEl.textContent = count;
    const lc = document.getElementById("bulkListCount");
    if (lc) lc.textContent = `(${count})`;
    const saveBtn = document.getElementById("bulkSaveAll");
    if (saveBtn) {
      saveBtn.disabled = count === 0;
      saveBtn.textContent = `Save All (${count})`;
    }
    if (!list) return;
    if (!count) {
      list.innerHTML = `<li class="bulk-list-empty">No items scanned yet</li>`;
      return;
    }
    list.innerHTML = _bulkScanState.scanned
      .map((imei, idx) => `
        <li class="bulk-list-item">
          <span class="bulk-list-num">${idx + 1}.</span>
          <span class="bulk-list-imei mono">${escapeHtml(imei)}</span>
          <button type="button" class="bulk-list-remove" data-idx="${idx}" aria-label="Remove">×</button>
        </li>
      `).join("");
    list.querySelectorAll(".bulk-list-remove").forEach((b) => {
      b.addEventListener("click", () => {
        const idx = parseInt(b.dataset.idx, 10);
        _bulkScanState.scanned.splice(idx, 1);
        updateUI();
      });
    });
    // Auto-scroll list to bottom to show newest
    list.scrollTop = list.scrollHeight;
  };

  let lastScannedCode = null;
  let lastScanTime = 0;
  let lastRejectedCode = null;
  let lastRejectedTime = 0;

  // Validates the scanned string against the chosen code type
  const validateCode = (raw) => {
    const v = String(raw || "").trim();
    if (!v) return { ok: false, reason: "" };
    const digits = v.replace(/\D/g, "");
    const type = (_bulkScanState.meta && _bulkScanState.meta.codeType) || "any";

    if (type === "iccid") {
      // SIM NO / ICCID: 18-22 digits starting with 89
      if (!/^89\d{16,20}$/.test(digits)) {
        if (/^4\d{13,14}$/.test(digits)) return { ok: false, reason: "IMSI detected — looking for SIM NO (89…)" };
        return { ok: false, reason: "Not a SIM NO (need 89… 20 digits)" };
      }
      return { ok: true, value: digits };
    }

    if (type === "imei") {
      // IMEI: 14-17 digits, NOT starting with 89 (that would be ICCID)
      if (/^89\d/.test(digits)) return { ok: false, reason: "Looks like SIM NO — looking for IMEI" };
      if (!/^\d{14,17}$/.test(digits)) return { ok: false, reason: "Not an IMEI (need 14-17 digits)" };
      return { ok: true, value: digits };
    }

    // 'any' mode — accept as-is
    return { ok: true, value: v };
  };

  const addImei = (raw) => {
    const v = String(raw || "").trim();
    if (!v) return;
    const now = Date.now();

    // Format validation — reject wrong-type codes (e.g. IMSI when looking for ICCID)
    const validation = validateCode(v);
    if (!validation.ok) {
      // Throttle rejection feedback (max 1 per 1.5s for same code)
      if (v === lastRejectedCode && (now - lastRejectedTime) < 1500) return;
      lastRejectedCode = v;
      lastRejectedTime = now;
      playBeep(280, 0.18); // low buzz = rejected
      try { navigator.vibrate && navigator.vibrate([60, 80, 60]); } catch {}
      const shortV = v.length > 12 ? v.slice(0, 6) + "…" + v.slice(-6) : v;
      setStatus(`✗ Detected "${shortV}" — ${validation.reason}. Tap "Any code" mode if needed.`);
      flashScanReject();
      return;
    }

    const value = validation.value;

    // Same code within 1s = ignore (prevents accidental double-scan)
    if (value === lastScannedCode && (now - lastScanTime) < 1000) return;
    lastScannedCode = value;
    lastScanTime = now;
    if (_bulkScanState.scanned.includes(value)) {
      playBeep(400, 0.12);
      setStatus(`⚠️ ${value.slice(-6)} already scanned`);
      try { navigator.vibrate && navigator.vibrate([30, 50, 30]); } catch {}
      return;
    }
    _bulkScanState.scanned.push(value);
    updateUI();
    playBeep(880, 0.08); // high beep = success
    flashScanSuccess();
    try { navigator.vibrate && navigator.vibrate(60); } catch {}
    setStatus(`✓ Added (${_bulkScanState.scanned.length}). Next item…`);
    const countEl = document.getElementById("bulkScanCount");
    if (countEl) {
      countEl.style.transform = "scale(1.4)";
      setTimeout(() => { countEl.style.transform = ""; }, 200);
    }
  };

  const cleanup = async () => {
    _bulkScanState.active = false;
    try {
      // Stop native video stream
      const video = document.getElementById("bulkScanVideo");
      if (video && video.srcObject) {
        video.srcObject.getTracks().forEach((t) => t.stop());
        video.srcObject = null;
      }
    } catch {}
    try {
      if (_bulkScanState.scanner) {
        await _bulkScanState.scanner.stop().catch(() => {});
        await _bulkScanState.scanner.clear().catch(() => {});
      }
    } catch {}
    _bulkScanState = { active: false, meta: null, scanned: [], scanner: null };
    modal.classList.remove("modal-wide");
    closeModal();
  };

  // Manual entry
  const manualBtn = document.getElementById("bulkManualAdd");
  const manualInput = document.getElementById("bulkManualImei");
  manualBtn?.addEventListener("click", () => {
    const v = manualInput.value.trim();
    if (v) {
      addImei(v);
      manualInput.value = "";
      manualInput.focus();
    }
  });
  manualInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      manualBtn?.click();
    }
  });

  modal.querySelector('[data-act="cancel"]').onclick = () => {
    if (_bulkScanState.scanned.length > 0) {
      if (!confirm(`Discard ${_bulkScanState.scanned.length} scanned items?`)) return;
    }
    cleanup();
  };

  document.getElementById("bulkSaveAll")?.addEventListener("click", async () => {
    await saveBulkStockItems();
  });

  modalOverlay.onclick = null; // disable click-outside-to-close during bulk scan

  _bulkScanState.active = true;

  // In-scanner mode switcher — user can change filter on the fly
  document.querySelectorAll("#scanModeSwitcher .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const newType = btn.dataset.type;
      _bulkScanState.meta.codeType = newType;
      document.querySelectorAll("#scanModeSwitcher .seg-btn").forEach((b) => {
        b.classList.toggle("active", b.dataset.type === newType);
      });
      const labels = {
        imei:  { label: "IMEI", desc: "14-17 digit", icon: "📡" },
        iccid: { label: "SIM NO", desc: "89… 20-digit", icon: "📶" },
        any:   { label: "Any", desc: "any code", icon: "🌀" },
      };
      const info = labels[newType];
      const badge = document.getElementById("scanModeBadge");
      if (badge) badge.textContent = `${info.icon} ${info.label}`;
      setStatus(`Mode: ${info.icon} ${info.label} — ${info.desc}`);
    });
  });

  // ----- Initialise scanner -----
  if (hasNativeDetector) {
    initNativeBulkScanner(addImei, setStatus, cleanup);
  } else {
    initFallbackBulkScanner(addImei, setStatus);
  }
}

// ===== NATIVE BarcodeDetector — fast + fail-safe =====
async function initNativeBulkScanner(addImei, setStatus, cleanup) {
  try {
    // Get all supported formats — no restriction, max compatibility
    let formats = [];
    try {
      formats = await window.BarcodeDetector.getSupportedFormats();
    } catch (e) {
      console.warn("getSupportedFormats failed:", e);
    }
    // Create detector with no format restriction (defaults to all)
    const detector = formats.length
      ? new window.BarcodeDetector({ formats })
      : new window.BarcodeDetector();

    const video = document.getElementById("bulkScanVideo");
    if (!video) {
      setStatus("Video element not found");
      return;
    }

    setStatus("Requesting camera permission…");

    // SIMPLE constraints — just back camera, nothing fancy
    // Complex constraints fail on many phones; we add advanced settings AFTER
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
    } catch (err) {
      console.error("getUserMedia failed with environment:", err);
      // Fallback: try with no facing constraint at all
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: false,
        });
      } catch (err2) {
        console.error("getUserMedia failed completely:", err2);
        setStatus("❌ Camera permission denied or unavailable");
        return;
      }
    }

    video.srcObject = stream;
    video.muted = true;
    video.setAttribute("playsinline", "");
    try { await video.play(); } catch (e) { console.warn("video.play failed:", e); }

    setStatus("📷 Scanner ready — point at barcode");

    // Try to apply zoom + focus AFTER stream is working (safe, optional)
    const track = stream.getVideoTracks()[0];
    if (track) {
      try {
        const capabilities = track.getCapabilities?.() || {};
        const advanced = [];
        if (capabilities.focusMode && capabilities.focusMode.includes("continuous")) {
          advanced.push({ focusMode: "continuous" });
        }
        if (capabilities.zoom) {
          const z = Math.min(Math.max(1.5, capabilities.zoom.min || 1), capabilities.zoom.max || 1);
          advanced.push({ zoom: z });
        }
        if (advanced.length) await track.applyConstraints({ advanced }).catch(() => {});

        // Torch button if supported
        if (capabilities.torch) {
          const torchBtn = document.getElementById("bulkTorchBtn");
          if (torchBtn) {
            torchBtn.style.display = "flex";
            let torchOn = false;
            torchBtn.addEventListener("click", async () => {
              torchOn = !torchOn;
              try {
                await track.applyConstraints({ advanced: [{ torch: torchOn }] });
                torchBtn.classList.toggle("active", torchOn);
              } catch (e) {}
            });
          }
        }
      } catch (e) {
        console.warn("Advanced camera settings failed (non-fatal):", e);
      }
    }

    // ----- Scan loop -----
    let scanErrCount = 0;
    const scanLoop = async () => {
      if (!_bulkScanState.active) return;
      try {
        if (video.readyState >= 2 && video.videoWidth > 0) {
          const barcodes = await detector.detect(video);
          if (barcodes && barcodes.length > 0) {
            for (const bc of barcodes) {
              const value = (bc.rawValue || "").trim();
              if (value) addImei(value);
            }
          }
        }
        scanErrCount = 0;
      } catch (e) {
        scanErrCount++;
        if (scanErrCount === 1) console.warn("Detector error (will retry):", e);
        if (scanErrCount > 30) {
          setStatus("Scanner having trouble — try manual entry below");
          return; // stop the loop
        }
      }
      requestAnimationFrame(scanLoop);
    };
    scanLoop();
  } catch (err) {
    console.error("Native scanner setup failed:", err);
    setStatus("❌ Camera unavailable — type manually below");
  }
}

// ===== Fallback: html5-qrcode if BarcodeDetector unavailable =====
async function initFallbackBulkScanner(addImei, setStatus) {
  const HQR = window.Html5Qrcode;
  if (!HQR) {
    setStatus("Scanner unavailable — type manually below.");
    return;
  }
  const HQRFormats = window.Html5QrcodeSupportedFormats;
  const allFormats = HQRFormats ? [
    HQRFormats.CODE_128, HQRFormats.CODE_39, HQRFormats.CODE_93,
    HQRFormats.EAN_13, HQRFormats.QR_CODE, HQRFormats.DATA_MATRIX,
  ] : undefined;

  setTimeout(async () => {
    try {
      // Use the video element directly for html5-qrcode... actually it needs its own div
      // Replace video with a div for html5-qrcode
      const wrap = document.querySelector(".bulk-scan-viewfinder");
      if (wrap) {
        const video = document.getElementById("bulkScanVideo");
        if (video) video.style.display = "none";
        const div = document.createElement("div");
        div.id = "qrReader";
        div.style.width = "100%";
        div.style.height = "100%";
        wrap.insertBefore(div, wrap.firstChild);
      }
      _bulkScanState.scanner = new HQR("qrReader", { verbose: false });
      await _bulkScanState.scanner.start(
        { facingMode: "environment" },
        {
          fps: 20,
          qrbox: (vw, vh) => ({ width: Math.min(vw * 0.9, 320), height: Math.min(vh * 0.45, 140) }),
          formatsToSupport: allFormats,
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
          videoConstraints: {
            facingMode: "environment",
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 },
            focusMode: "continuous",
          },
        },
        (decodedText) => addImei(decodedText),
        () => {}
      );
      setStatus("📷 Ready — point camera at barcode");
    } catch (err) {
      console.warn("Fallback scanner failed:", err);
      setStatus("Camera unavailable — type manually below.");
    }
  }, 100);
}

async function saveBulkStockItems() {
  const meta = _bulkScanState.meta;
  const imeis = [..._bulkScanState.scanned];
  if (!imeis.length) {
    showToast("Nothing to save.", true);
    return;
  }
  const saveBtn = document.getElementById("bulkSaveAll");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = `Saving ${imeis.length}…`;
  }
  try {
    const newItems = [];
    for (const imei of imeis) {
      const item = {
        id: "stock-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
        name: meta.name,
        category: meta.category || "Uncategorized",
        supplier: meta.supplier || "",
        quantity: 1,
        unit: "unit",
        lowStockThreshold: 1,
        metadata: { imei },
        createdAt: new Date().toISOString(),
        createdBy: currentUser,
        notes: `Bulk-added with ${imeis.length - 1} other unit${imeis.length > 2 ? "s" : ""}`,
      };
      const saved = await insertStockItem(item);
      newItems.push(saved);
    }
    stockItems = [...newItems, ...stockItems];
    // Cleanup state
    _bulkScanState = { active: false, meta: null, scanned: [], scanner: null };
    modal.classList.remove("modal-wide");
    closeModal();
    showToast(`✓ Added ${imeis.length} stock items`);
    render();
  } catch (err) {
    console.error("Bulk save failed:", err);
    showToast(err.message || "Save failed", true);
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = `Save All (${imeis.length})`;
    }
  }
}


async function initApp() {
  if (!isSupabaseConfigured()) {
    renderConfigMissing();
    return;
  }
  try {
    initDb();
    render();
    // Pre-warm BarcodeDetector + enumerate cameras silently on first user gesture
    // This makes the FIRST scan instant instead of having to wait for camera init
    const prewarmHandler = () => {
      try {
        if (typeof window.BarcodeDetector !== "undefined" && window.BarcodeDetector.getSupportedFormats) {
          window.BarcodeDetector.getSupportedFormats().catch(() => {});
        }
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          navigator.mediaDevices.enumerateDevices().catch(() => {});
        }
      } catch {}
      document.removeEventListener("click", prewarmHandler);
    };
    document.addEventListener("click", prewarmHandler, { once: true, passive: true });
  } catch (err) {
    app.innerHTML = `
      ${renderHeader("GPS Maintenance Tracker", "Error")}
      <main class="main centered">
        <section class="card login-card"><h2>Could not start app</h2><p class="login-desc">${escapeHtml(err.message)}</p></section>
      </main>
    `;
  }
}

initApp();
