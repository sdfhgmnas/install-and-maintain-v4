let dbClient = null;
// Cache reference to the backend SDK lazily — the SDK is loaded via a script
// tag, but module evaluation order can vary. Read it at init() time.
let _backendSDK = null;

const BUILT_IN_API_URL = "https://jzclmcjurfehpfybxryh.supabase.co";
const BUILT_IN_API_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6Y2xtY2p1cmZlaHBmeWJ4cnloIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk2NDI2NDcsImV4cCI6MjA5NTIxODY0N30.pdB45v7uBRzsh6M_Vrb43-SV_kLMwjGHpi9-uBuqHmw";

function getApiSettings() {
  return {
    url: window.API_URL || BUILT_IN_API_URL,
    anonKey: window.API_KEY || BUILT_IN_API_KEY,
  };
}

function isApiConfigured() {
  const { url, anonKey } = getApiSettings();
  return Boolean(
    url &&
      anonKey &&
      !url.includes("YOUR_PROJECT") &&
      !anonKey.includes("YOUR_ANON")
  );
}

function initDb() {
  if (!isApiConfigured()) {
    throw new Error("Server is not configured. Please contact administrator.");
  }
  // Lazily capture backend SDK (loaded via global script tag).
  if (!_backendSDK) {
    _backendSDK = (typeof window !== "undefined" && window.supabase) ? window.supabase : null;
  }
  if (!_backendSDK || !_backendSDK.createClient) {
    throw new Error("Backend SDK failed to load. Please check your internet connection.");
  }
  const { url, anonKey } = getApiSettings();
  dbClient = _backendSDK.createClient(url, anonKey, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return dbClient;
}

function getDb() {
  if (!dbClient) initDb();
  return dbClient;
}

function rowToInstallation(row) {
  return {
    id: row.id,
    vehicleNo: row.vehicle_no,
    gpsModel: row.gps_model,
    macId: row.mac_id,
    sensorNo: row.sensor_no,
    secondarySim: row.secondary_sim || null,
    imeiHistory: row.imei_history || [],
    simHistory: row.sim_history || [],
    tasks: row.tasks && typeof row.tasks === "object" ? row.tasks : {},
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function installationToRow(inst) {
  return {
    id: inst.id,
    vehicle_no: inst.vehicleNo,
    gps_model: inst.gpsModel,
    mac_id: inst.macId,
    sensor_no: inst.sensorNo,
    secondary_sim: inst.secondarySim || null,
    imei_history: inst.imeiHistory,
    sim_history: inst.simHistory,
    tasks: inst.tasks && typeof inst.tasks === "object" ? inst.tasks : {},
    created_at: inst.createdAt,
    created_by: inst.createdBy,
  };
}

function rowToMaintenance(row) {
  return {
    id: row.id,
    installationId: row.installation_id,
    imei: row.imei,
    vehicleNo: row.vehicle_no,
    wiringConnection: row.wiring_connection,
    simChange: row.sim_change,
    newSimNo: row.new_sim_no,
    deviceChange: row.device_change,
    newImei: row.new_imei,
    sensorOutForRepair: row.sensor_out_for_repair || false,
    sensorChanged: row.sensor_changed || false,
    deviceOutForRepair: row.device_out_for_repair || false,
    otherWorkText: row.other_work_text || null,
    oldSimNo: row.old_sim_no,
    oldImei: row.old_imei,
    simDeactivationPending: row.sim_deactivation_pending,
    simDeactivated: row.sim_deactivated,
    simDeactivatedAt: row.sim_deactivated_at,
    tasks: row.tasks || [],
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function maintenanceToRow(record) {
  return {
    id: record.id,
    installation_id: record.installationId,
    imei: record.imei,
    vehicle_no: record.vehicleNo,
    wiring_connection: record.wiringConnection,
    sim_change: record.simChange,
    new_sim_no: record.newSimNo,
    device_change: record.deviceChange,
    new_imei: record.newImei,
    sensor_out_for_repair: record.sensorOutForRepair,
    sensor_changed: record.sensorChanged,
    device_out_for_repair: record.deviceOutForRepair,
    other_work_text: record.otherWorkText,
    old_sim_no: record.oldSimNo,
    old_imei: record.oldImei,
    sim_deactivation_pending: record.simDeactivationPending,
    sim_deactivated: record.simDeactivated,
    sim_deactivated_at: record.simDeactivatedAt,
    tasks: record.tasks || [],
    created_at: record.createdAt,
    created_by: record.createdBy,
  };
}

async function fetchInstallations() {
  const { data, error } = await getDb()
    .from("installations")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToInstallation);
}

async function fetchMaintenanceRecords() {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data || []).map(rowToMaintenance);
}

async function insertInstallation(inst) {
  const { data, error } = await getDb()
    .from("installations")
    .insert(installationToRow(inst))
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToInstallation(data);
}

// Updates all editable fields including the admin-managed secondary SIM.
async function updateInstallation(inst) {
  const { data, error } = await getDb()
    .from("installations")
    .update({
      vehicle_no: inst.vehicleNo,
      gps_model: inst.gpsModel,
      mac_id: inst.macId,
      sensor_no: inst.sensorNo,
      secondary_sim: inst.secondarySim || null,
      imei_history: inst.imeiHistory,
      sim_history: inst.simHistory,
      tasks: inst.tasks || {},  // ← CRITICAL: install-level task completions (Portal / Vehicle no)
    })
    .eq("id", inst.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToInstallation(data);
}

async function insertMaintenanceRecord(record) {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .insert(maintenanceToRow(record))
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToMaintenance(data);
}

async function updateMaintenanceRecord(record) {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .update({
      sim_deactivation_pending: record.simDeactivationPending,
      sim_deactivated: record.simDeactivated,
      sim_deactivated_at: record.simDeactivatedAt,
      tasks: record.tasks || [],
    })
    .eq("id", record.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToMaintenance(data);
}

/* ============================================================
   SIMS TABLE
   A SIM is one physical card with two numbers:
     primaryNumber   - typically 13-digit, the "phone number" of the SIM
     secondaryNumber - typically 19-20 digit ICCID printed on the card
   The secondary is the unique permanent identifier of the card.
   ============================================================ */

function rowToSim(row) {
  return {
    id: row.id,
    primaryNumber: row.primary_number || null,
    secondaryNumber: row.secondary_number,
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function simToRow(sim) {
  return {
    primary_number: sim.primaryNumber ? String(sim.primaryNumber).trim() || null : null,
    secondary_number: String(sim.secondaryNumber).trim(),
    notes: sim.notes || null,
  };
}

// Sentinel error so callers can detect "migration not yet run".
const SIMS_TABLE_MISSING = "SIMS_TABLE_MISSING";

function isMissingSimsTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    msg.includes('relation "public.sims" does not exist') ||
    msg.includes('relation "sims" does not exist') ||
    // PostgREST returns this when the table isn't in the schema cache yet
    // (typically because the migration hasn't been run):
    //   "Could not find the table 'public.sims' in the schema cache"
    (msg.includes("could not find") && msg.includes("sims") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("sims"))
  );
}

async function fetchSims() {
  const { data, error } = await getDb()
    .from("sims")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingSimsTableError(error)) {
      const e = new Error("sims table missing — database setup incomplete");
      e.code = SIMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToSim);
}

async function insertSim(sim) {
  const { data, error } = await getDb()
    .from("sims")
    .insert(simToRow(sim))
    .select()
    .single();

  if (error) {
    if (isMissingSimsTableError(error)) {
      const e = new Error("sims table missing — database setup incomplete");
      e.code = SIMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToSim(data);
}

async function updateSim(sim) {
  const { data, error } = await getDb()
    .from("sims")
    .update({
      primary_number: sim.primaryNumber ? String(sim.primaryNumber).trim() || null : null,
      secondary_number: String(sim.secondaryNumber).trim(),
      notes: sim.notes || null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sim.id)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return rowToSim(data);
}

async function deleteSim(simId) {
  const { data, error } = await getDb().from("sims").delete().eq("id", simId).select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Delete had no effect. Row may not exist or permission denied. Contact administrator.");
  return true;
}

// Upsert a SIM by secondary_number (the unique permanent identifier).
// If the SIM exists, primary_number is updated (and notes if provided).
// If not, a new row is inserted.
async function upsertSim({ primaryNumber, secondaryNumber, notes }) {
  const payload = {
    primary_number: primaryNumber ? String(primaryNumber).trim() || null : null,
    secondary_number: String(secondaryNumber).trim(),
  };
  if (notes !== undefined) payload.notes = notes || null;
  payload.updated_at = new Date().toISOString();

  const { data, error } = await getDb()
    .from("sims")
    .upsert(payload, { onConflict: "secondary_number" })
    .select()
    .single();

  if (error) {
    if (isMissingSimsTableError(error)) {
      const e = new Error("sims table missing — database setup incomplete");
      e.code = SIMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToSim(data);
}

/* ============================================================
   STOCK ITEMS TABLE
   Inventory: GPS devices, brackets, cables, sensors, antennas,
   batteries, tools, etc. Each item has quantity, unit, optional
   cost-per-unit, and optional low-stock threshold.
   ============================================================ */

function rowToStockItem(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category || null,
    quantity: Number(row.quantity || 0),
    unit: row.unit || "pcs",
    costPerUnit: row.cost_per_unit != null ? Number(row.cost_per_unit) : null,
    lowStockThreshold: row.low_stock_threshold != null ? Number(row.low_stock_threshold) : null,
    notes: row.notes || null,
    supplier: row.supplier || null,
    metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function stockItemToRow(item) {
  const num = (v) => (v === "" || v == null ? null : Number(v));
  return {
    name: String(item.name).trim(),
    category: item.category ? String(item.category).trim() || null : null,
    quantity: Number(item.quantity || 0),
    unit: (item.unit || "pcs").trim(),
    cost_per_unit: num(item.costPerUnit),
    low_stock_threshold: num(item.lowStockThreshold),
    notes: item.notes || null,
    supplier: item.supplier ? String(item.supplier).trim() || null : null,
    metadata: item.metadata && typeof item.metadata === "object" ? item.metadata : {},
  };
}

const STOCK_ITEMS_TABLE_MISSING = "STOCK_ITEMS_TABLE_MISSING";

function isMissingStockItemsTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("stock_items") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("stock_items") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("stock_items"))
  );
}

async function fetchStockItems() {
  const { data, error } = await getDb()
    .from("stock_items")
    .select("*")
    .order("name", { ascending: true });

  if (error) {
    if (isMissingStockItemsTableError(error)) {
      const e = new Error("stock_items table missing — database setup incomplete");
      e.code = STOCK_ITEMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToStockItem);
}

async function insertStockItem(item) {
  const { data, error } = await getDb()
    .from("stock_items")
    .insert(stockItemToRow(item))
    .select()
    .single();

  if (error) {
    if (isMissingStockItemsTableError(error)) {
      const e = new Error("stock_items table missing — database setup incomplete");
      e.code = STOCK_ITEMS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToStockItem(data);
}

async function updateStockItem(item) {
  const payload = stockItemToRow(item);
  payload.updated_at = new Date().toISOString();
  const { data, error } = await getDb()
    .from("stock_items")
    .update(payload)
    .eq("id", item.id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToStockItem(data);
}

async function deleteStockItem(itemId) {
  const { data, error } = await getDb().from("stock_items").delete().eq("id", itemId).select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Delete had no effect. Row may not exist or permission denied. Contact administrator.");
  return true;
}

/* ============================================================
   STOCK TRANSACTIONS TABLE
   Each stock adjustment is recorded here, optionally linked to
   an installation/vehicle so the Stock page can show "Used in
   VEHICLE-X" and a full per-item history.
   ============================================================ */

function rowToStockTx(row) {
  return {
    id: row.id,
    stockItemId: row.stock_item_id || null,
    installationId: row.installation_id || null,
    maintenanceRecordId: row.maintenance_record_id || null,
    vehicleNo: row.vehicle_no || null,
    delta: Number(row.delta || 0),
    resultingQuantity: row.resulting_quantity != null ? Number(row.resulting_quantity) : null,
    note: row.note || null,
    createdBy: row.created_by || null,
    itemNameSnapshot: row.item_name_snapshot || null,
    createdAt: row.created_at,
  };
}

const STOCK_TX_TABLE_MISSING = "STOCK_TX_TABLE_MISSING";

function isMissingStockTxTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("stock_transactions") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("stock_transactions") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("stock_transactions"))
  );
}

async function fetchStockTransactions() {
  const { data, error } = await getDb()
    .from("stock_transactions")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    if (isMissingStockTxTableError(error)) {
      const e = new Error("stock_transactions table missing — database setup incomplete");
      e.code = STOCK_TX_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToStockTx);
}

async function insertStockTransaction(tx) {
  const { data, error } = await getDb()
    .from("stock_transactions")
    .insert({
      stock_item_id: tx.stockItemId || null,
      installation_id: tx.installationId || null,
      maintenance_record_id: tx.maintenanceRecordId || null,
      vehicle_no: tx.vehicleNo || null,
      delta: Number(tx.delta),
      resulting_quantity: tx.resultingQuantity != null ? Number(tx.resultingQuantity) : null,
      note: tx.note || null,
      created_by: tx.createdBy || null,
      item_name_snapshot: tx.itemNameSnapshot || null,
    })
    .select()
    .single();

  if (error) {
    if (isMissingStockTxTableError(error)) {
      const e = new Error("stock_transactions table missing — database setup incomplete");
      e.code = STOCK_TX_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return rowToStockTx(data);
}

/* ============================================================
   DELETION AUDIT LOG
   Immutable record of every destructive action (with reason).
   ============================================================ */

function rowToDeletionLog(row) {
  return {
    id: row.id,
    entityType: row.entity_type,
    entityId: row.entity_id || null,
    entityLabel: row.entity_label || null,
    reason: row.reason || null,
    deletedBy: row.deleted_by || null,
    snapshot: row.snapshot || null,
    deletedAt: row.deleted_at,
  };
}

const DELETION_LOG_TABLE_MISSING = "DELETION_LOG_TABLE_MISSING";

function isMissingDeletionLogError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("deletion_log") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("deletion_log") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("deletion_log"))
  );
}

async function fetchDeletionLog(limit = 200) {
  const { data, error } = await getDb()
    .from("deletion_log")
    .select("*")
    .order("deleted_at", { ascending: false })
    .limit(limit);
  if (error) {
    if (isMissingDeletionLogError(error)) {
      const e = new Error("deletion_log table missing — database setup incomplete");
      e.code = DELETION_LOG_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToDeletionLog);
}

async function insertDeletionLog(entry) {
  const { error } = await getDb()
    .from("deletion_log")
    .insert({
      entity_type: entry.entityType,
      entity_id: entry.entityId || null,
      entity_label: entry.entityLabel || null,
      reason: entry.reason || null,
      deleted_by: entry.deletedBy || null,
      snapshot: entry.snapshot || null,
    });
  if (error) {
    if (isMissingDeletionLogError(error)) {
      // Don't throw — deletion still proceeds. Just warn.
      console.warn("deletion_log table missing — deletion was not audited.");
      return false;
    }
    console.warn("Deletion log write failed:", error.message);
    return false;
  }
  return true;
}

/* ============================================================
   SUPPLIERS TABLE
   Admin-managed list of suppliers used in the Stock page.
   ============================================================ */

function rowToSupplier(row) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

const SUPPLIERS_TABLE_MISSING = "SUPPLIERS_TABLE_MISSING";

function isMissingSuppliersTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("suppliers") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("suppliers") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("suppliers"))
  );
}

async function fetchSuppliers() {
  const { data, error } = await getDb()
    .from("suppliers")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    if (isMissingSuppliersTableError(error)) {
      const e = new Error("suppliers table missing — database setup incomplete");
      e.code = SUPPLIERS_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToSupplier);
}

async function insertSupplier(name) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error("Supplier name cannot be empty.");
  const { data, error } = await getDb()
    .from("suppliers")
    .insert({ name: trimmed })
    .select()
    .single();
  if (error) {
    if ((error.message || "").toLowerCase().includes("duplicate")) {
      throw new Error(`Supplier "${trimmed}" already exists.`);
    }
    throw new Error(error.message);
  }
  return rowToSupplier(data);
}

async function deleteSupplier(id) {
  const { data, error } = await getDb().from("suppliers").delete().eq("id", id).select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Delete had no effect. Row may not exist or permission denied. Contact administrator.");
  return true;
}

/* ============================================================
   INSTALLATION & MAINTENANCE DELETE
   Hard-delete an installation or repair entry. Auto-consume
   reversal is handled in app.js (consumeStockReverse).
   ============================================================ */

async function deleteInstallation(installationId) {
  const { data, error } = await getDb()
    .from("installations")
    .delete()
    .eq("id", installationId)
    .select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(
      "Delete had no effect. The row may not exist or your account does not have permission to delete from the installations table. Contact administrator to check database policies."
    );
  }
  return true;
}

async function deleteMaintenanceRecord(recordId) {
  const { data, error } = await getDb()
    .from("maintenance_records")
    .delete()
    .eq("id", recordId)
    .select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error(
      "Delete had no effect. Row may not exist or permission denied. Contact administrator."
    );
  }
  return true;
}

/* ============================================================
   STOCK CATEGORIES TABLE
   Admin-managed list of categories used in the Stock page.
   ============================================================ */

function rowToCategory(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
  };
}

const STOCK_CATEGORIES_TABLE_MISSING = "STOCK_CATEGORIES_TABLE_MISSING";

function isMissingCategoriesTableError(err) {
  if (!err) return false;
  const msg = (err.message || "").toLowerCase();
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    err.code === "PGRST116" ||
    (msg.includes("relation") && msg.includes("stock_categories") && msg.includes("does not exist")) ||
    (msg.includes("could not find") && msg.includes("stock_categories") && msg.includes("schema")) ||
    (msg.includes("schema cache") && msg.includes("stock_categories"))
  );
}

async function fetchStockCategories() {
  const { data, error } = await getDb()
    .from("stock_categories")
    .select("*")
    .order("name", { ascending: true });
  if (error) {
    if (isMissingCategoriesTableError(error)) {
      const e = new Error("stock_categories table missing — database setup incomplete");
      e.code = STOCK_CATEGORIES_TABLE_MISSING;
      throw e;
    }
    throw new Error(error.message);
  }
  return (data || []).map(rowToCategory);
}

async function insertStockCategory(name) {
  const trimmed = String(name).trim();
  if (!trimmed) throw new Error("Category name cannot be empty.");
  const { data, error } = await getDb()
    .from("stock_categories")
    .insert({ name: trimmed })
    .select()
    .single();
  if (error) {
    // Unique violation -> friendlier message
    if ((error.message || "").toLowerCase().includes("duplicate")) {
      throw new Error(`Category "${trimmed}" already exists.`);
    }
    throw new Error(error.message);
  }
  return rowToCategory(data);
}

async function deleteStockCategory(id) {
  const { data, error } = await getDb().from("stock_categories").delete().eq("id", id).select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error("Delete had no effect. Row may not exist or permission denied. Contact administrator.");
  return true;
}

// Realtime subscription. onChange(eventType, payload):
//   eventType = 'status' : connection status changes
//   eventType = 'data'   : a row changed in any subscribed table
function subscribeRealtime(onChange) {
  const client = getDb();
  const channel = client
    .channel("gps-tracker-stream")
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "installations" },
      (payload) => onChange("data", { table: "installations", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "maintenance_records" },
      (payload) => onChange("data", { table: "maintenance_records", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "sims" },
      (payload) => onChange("data", { table: "sims", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "stock_items" },
      (payload) => onChange("data", { table: "stock_items", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "stock_transactions" },
      (payload) => onChange("data", { table: "stock_transactions", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "stock_categories" },
      (payload) => onChange("data", { table: "stock_categories", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "suppliers" },
      (payload) => onChange("data", { table: "suppliers", payload })
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "deletion_log" },
      (payload) => onChange("data", { table: "deletion_log", payload })
    )
    .subscribe((status) => onChange("status", { status }));
  return channel;
}

async function unsubscribeRealtime(channel) {
  if (!channel) return;
  try {
    await getDb().removeChannel(channel);
  } catch (_) {
    // ignore
  }
}

// ============================================================
// ACCOUNTS MODULE (v3.0)
// ============================================================

// ----- Projects -----
async function fetchAccountsProjects() {
  const { data, error } = await getDb()
    .from("accounts_projects")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

async function insertAccountsProject(project) {
  const row = {
    id: project.id,
    name: project.name,
    created_by: project.createdBy || null,
  };
  const { data, error } = await getDb()
    .from("accounts_projects")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    name: data.name,
    createdAt: data.created_at,
    createdBy: data.created_by,
  };
}

async function deleteAccountsProject(id) {
  const { data, error } = await getDb().from("accounts_projects").delete().eq("id", id).select();
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("Delete had no effect. Permission denied or row missing.");
}

// ----- Transactions -----
async function fetchAccountsTransactions() {
  const { data, error } = await getDb()
    .from("accounts_transactions")
    .select("*")
    .order("transaction_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data || []).map((row) => ({
    id: row.id,
    type: row.type,
    amount: Number(row.amount) || 0,
    projectId: row.project_id,
    projectName: row.project_name || "",
    description: row.description || "",
    transactionDate: row.transaction_date,
    isPlanned: !!row.is_planned,
    createdAt: row.created_at,
    createdBy: row.created_by,
  }));
}

async function insertAccountsTransaction(tx) {
  const row = {
    id: tx.id,
    type: tx.type,
    amount: Number(tx.amount) || 0,
    project_id: tx.projectId || null,
    project_name: tx.projectName || null,
    description: tx.description || null,
    transaction_date: tx.transactionDate || new Date().toISOString().slice(0, 10),
    is_planned: !!tx.isPlanned,
    created_by: tx.createdBy || null,
  };
  const { data, error } = await getDb()
    .from("accounts_transactions")
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return {
    id: data.id,
    type: data.type,
    amount: Number(data.amount) || 0,
    projectId: data.project_id,
    projectName: data.project_name || "",
    description: data.description || "",
    transactionDate: data.transaction_date,
    isPlanned: !!data.is_planned,
    createdAt: data.created_at,
    createdBy: data.created_by,
  };
}

async function updateAccountsTransaction(id, patch) {
  const row = {};
  if ("type" in patch) row.type = patch.type;
  if ("amount" in patch) row.amount = Number(patch.amount);
  if ("projectId" in patch) row.project_id = patch.projectId || null;
  if ("projectName" in patch) row.project_name = patch.projectName || null;
  if ("description" in patch) row.description = patch.description;
  if ("transactionDate" in patch) row.transaction_date = patch.transactionDate;
  if ("isPlanned" in patch) row.is_planned = !!patch.isPlanned;
  const { data, error } = await getDb()
    .from("accounts_transactions")
    .update(row)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function deleteAccountsTransaction(id) {
  const { data, error } = await getDb().from("accounts_transactions").delete().eq("id", id).select();
  if (error) throw error;
  if (!data || data.length === 0) throw new Error("Delete had no effect. Permission denied or row missing.");
}

// ============================================================
// USER PERMISSIONS (v3.1)
// ============================================================

async function fetchUserPermissions() {
  const { data, error } = await getDb()
    .from("user_permissions")
    .select("*");
  if (error) throw error;
  return (data || []).map((row) => ({
    username: row.username,
    displayName: row.display_name,
    isAdmin: !!row.is_admin,
    allowedPages: row.allowed_pages || [],
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  }));
}

async function upsertUserPermission(p) {
  const row = {
    username: p.username,
    display_name: p.displayName || null,
    is_admin: !!p.isAdmin,
    allowed_pages: p.allowedPages || [],
    updated_at: new Date().toISOString(),
    updated_by: p.updatedBy || null,
  };
  const { error } = await getDb()
    .from("user_permissions")
    .upsert(row, { onConflict: "username" });
  if (error) throw error;
}

/* ============================================================
   RENEWALS TABLE (v3.8.0)
   SIM subscription renewal tracking — 365-day cycle
   ============================================================ */

function rowToRenewal(row) {
  return {
    id: row.id,
    plateNumber: row.plate_number || "",
    vehicleName: row.vehicle_name || "",
    company: row.company || "",
    branch: row.branch || "",
    reseller: row.reseller || "",
    imei: row.imei || "",
    simNumber: row.sim_number || "",
    simProvider: row.sim_provider || "",
    secondarySim: row.secondary_sim || "",
    secondarySimProvider: row.secondary_sim_provider || "",
    gpsDeviceType: row.gps_device_type || "",
    createdDate: row.created_date,
    payments: row.payments || [],
    lastUploadedAt: row.last_uploaded_at,
    lastUploadedBy: row.last_uploaded_by,
    notes: row.notes || "",
    accountId: row.account_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function renewalToRow(r) {
  return {
    plate_number: r.plateNumber || "",
    vehicle_name: r.vehicleName || null,
    company: r.company || null,
    branch: r.branch || null,
    reseller: r.reseller || null,
    imei: r.imei || "",
    sim_number: r.simNumber || null,
    sim_provider: r.simProvider || null,
    secondary_sim: r.secondarySim || null,
    secondary_sim_provider: r.secondarySimProvider || null,
    gps_device_type: r.gpsDeviceType || null,
    created_date: r.createdDate,
    payments: r.payments || [],
    last_uploaded_at: r.lastUploadedAt || null,
    last_uploaded_by: r.lastUploadedBy || null,
    notes: r.notes || null,
  };
}

async function fetchRenewals() {
  const { data, error } = await getDb()
    .from("renewals")
    .select("*")
    .order("created_date", { ascending: false })
    .limit(5000);
  if (error) throw new Error(error.message);
  return (data || []).map(rowToRenewal);
}

async function upsertRenewal(renewal) {
  const row = renewalToRow(renewal);
  if (renewal.id) row.id = renewal.id;
  const { data, error } = await getDb()
    .from("renewals")
    .upsert(row, { onConflict: "imei" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToRenewal(data);
}

/**
 * Bulk upsert — merge by IMEI.
 * - If IMEI exists: update plate/vehicle/company/sim data, KEEP payments & notes.
 * - If IMEI new: insert fresh row.
 * - Rows in DB but not in file: untouched.
 */
async function bulkUpsertRenewals(renewals) {
  if (!renewals || renewals.length === 0) return { inserted: 0, updated: 0, errors: [] };
  const rows = renewals.map(renewalToRow);
  // Supabase upsert supports arrays. Returning only inserted/updated via .select().
  const { data, error } = await getDb()
    .from("renewals")
    .upsert(rows, { onConflict: "imei" })
    .select();
  if (error) throw new Error(error.message);
  return { count: (data || []).length, data: (data || []).map(rowToRenewal) };
}

async function updateRenewalPayments(id, payments) {
  const { data, error } = await getDb()
    .from("renewals")
    .update({ payments: payments })
    .eq("id", id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToRenewal(data);
}

async function deleteRenewal(id) {
  const { data, error } = await getDb()
    .from("renewals")
    .delete()
    .eq("id", id)
    .select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("Delete had no effect. Permission denied or row missing.");
  }
  return true;
}

/* ============================================================
   v3.9.0 — RENEWAL ACCOUNTS, SELLER PROFILE, DOCUMENTS
   ============================================================ */

/* ---- Accounts ---- */
function rowToRenewalAccount(row) {
  return {
    id: row.id,
    name: row.name || "",
    isGstRegistered: !!row.is_gst_registered,
    gstin: row.gstin || "",
    pan: row.pan || "",
    address: row.address || "",
    city: row.city || "",
    state: row.state || "",
    stateCode: row.state_code || "",
    pincode: row.pincode || "",
    contactPerson: row.contact_person || "",
    phone: row.phone || "",
    email: row.email || "",
    defaultRatePerYear: Number(row.default_rate_per_year) || 0,
    hsnCode: row.hsn_code || "998412",
    gstRate: Number(row.gst_rate) || 18,
    notes: row.notes || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function renewalAccountToRow(a) {
  return {
    name: a.name || "",
    is_gst_registered: !!a.isGstRegistered,
    gstin: a.gstin || null,
    pan: a.pan || null,
    address: a.address || null,
    city: a.city || null,
    state: a.state || null,
    state_code: a.stateCode || null,
    pincode: a.pincode || null,
    contact_person: a.contactPerson || null,
    phone: a.phone || null,
    email: a.email || null,
    default_rate_per_year: Number(a.defaultRatePerYear) || 0,
    hsn_code: a.hsnCode || "998412",
    gst_rate: Number(a.gstRate) || 18,
    notes: a.notes || null,
  };
}

async function fetchRenewalAccounts() {
  const { data, error } = await getDb()
    .from("renewal_accounts")
    .select("*")
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map(rowToRenewalAccount);
}

async function upsertRenewalAccount(account) {
  const row = renewalAccountToRow(account);
  if (account.id) row.id = account.id;
  const { data, error } = await getDb()
    .from("renewal_accounts")
    .upsert(row, { onConflict: "name" })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToRenewalAccount(data);
}

async function deleteRenewalAccount(id) {
  const { data, error } = await getDb()
    .from("renewal_accounts")
    .delete()
    .eq("id", id)
    .select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("Delete had no effect. Permission denied or row missing.");
  }
  return true;
}

/* ---- Seller profile ---- */
function rowToSellerProfile(row) {
  return {
    id: row.id,
    businessName: row.business_name || "",
    gstin: row.gstin || "",
    pan: row.pan || "",
    address: row.address || "",
    city: row.city || "",
    state: row.state || "",
    stateCode: row.state_code || "",
    pincode: row.pincode || "",
    contactPhone: row.contact_phone || "",
    contactEmail: row.contact_email || "",
    website: row.website || "",
    bankName: row.bank_name || "",
    bankAccountNo: row.bank_account_no || "",
    bankIfsc: row.bank_ifsc || "",
    bankBranch: row.bank_branch || "",
    bankAccountHolder: row.bank_account_holder || "",
    logoUrl: row.logo_url || "",
    signatureName: row.signature_name || "",
    signatureDesignation: row.signature_designation || "",
    termsText: row.terms_text || "",
    themeColor: row.theme_color || "classic",
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

function sellerProfileToRow(p) {
  return {
    business_name: p.businessName || "",
    gstin: p.gstin || null,
    pan: p.pan || null,
    address: p.address || null,
    city: p.city || null,
    state: p.state || null,
    state_code: p.stateCode || null,
    pincode: p.pincode || null,
    contact_phone: p.contactPhone || null,
    contact_email: p.contactEmail || null,
    website: p.website || null,
    bank_name: p.bankName || null,
    bank_account_no: p.bankAccountNo || null,
    bank_ifsc: p.bankIfsc || null,
    bank_branch: p.bankBranch || null,
    bank_account_holder: p.bankAccountHolder || null,
    logo_url: p.logoUrl || null,
    signature_name: p.signatureName || null,
    signature_designation: p.signatureDesignation || null,
    terms_text: p.termsText || null,
    theme_color: p.themeColor || "classic",
    updated_by: p.updatedBy || null,
  };
}

async function fetchSellerProfile() {
  const { data, error } = await getDb()
    .from("renewal_seller_profile")
    .select("*")
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return null;
  return rowToSellerProfile(data[0]);
}

async function upsertSellerProfile(profile) {
  const row = sellerProfileToRow(profile);
  if (profile.id) {
    row.id = profile.id;
    const { data, error } = await getDb()
      .from("renewal_seller_profile")
      .update(row)
      .eq("id", profile.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return rowToSellerProfile(data);
  } else {
    const { data, error } = await getDb()
      .from("renewal_seller_profile")
      .insert(row)
      .select()
      .single();
    if (error) throw new Error(error.message);
    return rowToSellerProfile(data);
  }
}

/* ---- Documents ---- */
function rowToDocument(row) {
  return {
    id: row.id,
    docType: row.doc_type,
    docNumber: row.doc_number,
    docDate: row.doc_date,
    accountId: row.account_id,
    accountName: row.account_name || "",
    accountGstin: row.account_gstin || "",
    vehicles: row.vehicles || [],
    subtotal: Number(row.subtotal) || 0,
    cgst: Number(row.cgst) || 0,
    sgst: Number(row.sgst) || 0,
    igst: Number(row.igst) || 0,
    total: Number(row.total) || 0,
    hsnCode: row.hsn_code || "",
    gstRate: Number(row.gst_rate) || 0,
    paymentMode: row.payment_mode || "",
    linkedPayments: row.linked_payments || [],
    notes: row.notes || "",
    shipToAddress: row.ship_to_address || "",
    htmlSnapshot: row.html_snapshot || "",
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

async function fetchRenewalDocuments(limit = 500) {
  const { data, error } = await getDb()
    .from("renewal_documents")
    .select("*")
    .order("doc_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return (data || []).map(rowToDocument);
}

async function getNextDocNumber(docType, period) {
  // Get the highest existing number for this doc_type + period
  const { data, error } = await getDb()
    .from("renewal_documents")
    .select("doc_number")
    .eq("doc_type", docType)
    .like("doc_number", `${docType}/${period}/%`)
    .order("doc_number", { ascending: false })
    .limit(1);
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) return 1;
  const last = data[0].doc_number;
  const parts = last.split("/");
  const n = parseInt(parts[parts.length - 1], 10);
  return isNaN(n) ? 1 : n + 1;
}

async function createRenewalDocument(doc) {
  const row = {
    doc_type: doc.docType,
    doc_number: doc.docNumber,
    doc_date: doc.docDate,
    account_id: doc.accountId || null,
    account_name: doc.accountName || null,
    account_gstin: doc.accountGstin || null,
    vehicles: doc.vehicles || [],
    subtotal: Number(doc.subtotal) || 0,
    cgst: Number(doc.cgst) || 0,
    sgst: Number(doc.sgst) || 0,
    igst: Number(doc.igst) || 0,
    total: Number(doc.total) || 0,
    hsn_code: doc.hsnCode || null,
    gst_rate: Number(doc.gstRate) || null,
    payment_mode: doc.paymentMode || null,
    linked_payments: doc.linkedPayments || [],
    notes: doc.notes || null,
    ship_to_address: doc.shipToAddress || null,
    html_snapshot: doc.htmlSnapshot || null,
    created_by: doc.createdBy || null,
  };
  const { data, error } = await getDb()
    .from("renewal_documents")
    .insert(row)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToDocument(data);
}

async function deleteRenewalDocument(id) {
  const { data, error } = await getDb()
    .from("renewal_documents")
    .delete()
    .eq("id", id)
    .select();
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) {
    throw new Error("Delete had no effect. Permission denied.");
  }
  return true;
}

/* ---- Update renewal with account link ---- */
async function updateRenewalAccountLink(renewalId, accountId) {
  const { data, error } = await getDb()
    .from("renewals")
    .update({ account_id: accountId || null })
    .eq("id", renewalId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return rowToRenewal(data);
}

async function bulkUpdateRenewalAccountLinks(renewalIds, accountId) {
  const { data, error } = await getDb()
    .from("renewals")
    .update({ account_id: accountId || null })
    .in("id", renewalIds)
    .select();
  if (error) throw new Error(error.message);
  return (data || []).map(rowToRenewal);
}
