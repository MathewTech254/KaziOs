// The trading half of the demo organization: stock, customers, suppliers, staff and
// invoices covering every status a real shop moves through.
//
// Split out of the main script purely to keep each file readable. The HTTP helpers and
// the data tables are shared with the caller rather than duplicated here.

const STOCK_BY_BRANCH = {
  NGR: { full: 60, lean: 12, outOfStock: 0 },
  WST: { full: 45, lean: 8, outOfStock: 0 },
  MSB: { full: 30, lean: 3, outOfStock: 0 },
};

// The API takes these as upper case enums, not the lower case words a person would
// write: CustomerType.INDIVIDUAL. Sending "individual" is rejected outright.
const CUSTOMERS = [
  ["Achieng Otieno", "INDIVIDUAL", "achieng.otieno@example.co.ke", "+254711000001", "Buru Buru, Nairobi"],
  ["Achieng Achieng", "INDIVIDUAL", "a.achieng@example.co.ke", "+254711000002", "Mathare, Nairobi"],
  ["Brian Mutua", "INDIVIDUAL", "brian.mutua@example.co.ke", "+254711000003", "Karen, Nairobi"],
  ["Caroline Wanjiru", "INDIVIDUAL", "caroline.wanjiru@example.co.ke", "+254711000004", "Kilimani, Nairobi"],
  ["Daniel Kimani", "INDIVIDUAL", "daniel.kimani@example.co.ke", "+254711000005", "Parklands, Nairobi"],
  ["Esther Nyambura", "INDIVIDUAL", "esther.nyambura@example.co.ke", "+254711000006", "Embakasi, Nairobi"],
  ["Jamii Provisions Ltd", "BUSINESS", "accounts@jamiiprovisions.co.ke", "+254711000010", "Industrial Area, Nairobi", "PVT-2019-4482"],
  ["Riverside Cafeteria", "BUSINESS", "riverside.cafe@example.co.ke", "+254711000011", "Riverside Drive, Nairobi", "PVT-2020-7715"],
  ["Mwangaza Hotel", "BUSINESS", "accounts@mwangazahotel.co.ke", "+254711000012", "Mombasa Road, Nairobi", "PVT-2018-0093"],
  ["Tusker Mart", "BUSINESS", "finance@tuskermart.co.ke", "+254711000013", "Eastleigh, Nairobi", "PVT-2021-5560"],
];

const SUPPLIERS = [
  ["Nairobi Grain Traders", "sales@nairobigrain.co.ke", "+254720000001", "Warehouse 4, Industrial Area"],
  ["Coastal Wholesalers Ltd", "orders@coastalwholesale.co.ke", "+254720000002", "Mombasa Road"],
  ["Farm Fresh Produce", "supply@farmfresh.co.ke", "+254720000003", "Limuru"],
  ["HomeCare Distributors", "hello@homecaredist.co.ke", "+254720000004", "Buru Buru"],
  ["Highland Dairy Co.", "sales@highlanddairy.co.ke", "+254720000005", "Nyeri"],
];

const STAFF = [
  ["Faith Njeri", "faith.njeri@example.co.ke", "MANAGER", ["*"]],
  ["Joseph Kariuki", "joseph.kariuki@example.co.ke", "CASHIER", ["pos.sale", "invoices.view", "customers.view", "products.view"]],
  ["Mercy Achieng", "mercy.achieng@example.co.ke", "ACCOUNTANT", ["reports.view", "payments.view", "payments.create", "invoices.view", "invoices.create", "invoices.send"]],
  ["Samuel Kiptoo", "samuel.kiptoo@example.co.ke", "STOCK", ["inventory.view", "inventory.manage", "purchasing.view", "purchasing.manage", "products.view"]],
];

/**
 * Turns a list of permission keys into the shape the API stores.
 *
 * A role stores plain key strings, and "*" (every permission) is not one of them: it is
 * how the owner role is created at registration time, not something the role editor
 * will accept. So a wildcard is expanded to every real key instead, which means the
 * seeded manager genuinely holds the full set rather than an unrecognised token.
 *
 * Keys are checked against the server's own catalogue, so a permission that has been
 * renamed cannot leave a role quietly holding something that no longer exists.
 */
export async function resolvePermissions(state, keys) {
  const catalogue = state.permissionCatalogue || [];
  const wanted = keys.includes("*") ? catalogue.map((p) => p.key) : keys;

  return wanted.map((key) => {
    if (key === "*") {
      throw new Error('"*" is not a storable permission; expand it against the catalogue first.');
    }
    const found = catalogue.find((p) => p.key === key);
    if (!found) {
      throw new Error(
        `Unknown permission "${key}". Read GET /roles/permissions for the current catalogue.`
      );
    }
    return found.key;
  });
}

// Pinned prices so a rerun produces the same figures and a test can assert on them.
const PRICE = {
  "FLR-002-KG": 189, "SGR-001-KG": 175, "RCE-001-KG": 195, "OIL-001-L": 265,
  "FLR-002-WH": 215, "SLT-001-KG": 65, "SLT-400-RY": 130, "CHK-001-KG": 620,
  "BEF-500-G": 675, "FSH-001-KG": 560, "EGG-030-TR": 470, "MLK-001-L": 135,
  "RCE-005-PB": 1150, "OIL-500-OL": 950, "SOP-100-BX": 85, "TOL-004-PC": 250,
  "DSH-500-DL": 155, "LDY-001-KG": 265, "DLV-NGR": 150, "DLV-WST": 150, "BAG-LRG": 25,
};

// Invoices covering every status the application can hold. `send`/`pay` are the
// follow up calls that move an invoice on; `null` means leave it where it is.
const INVOICE_PLAN = [
  // draft invoices, for testing edit and send
  { customer: 0, branch: "NGR", days: 1, items: [["FLR-002-KG", 10], ["SGR-001-KG", 6]], send: false, pay: null, terms: 14 },
  { customer: 3, branch: "WST", days: 2, items: [["MLK-001-L", 12]], send: false, pay: null, terms: 14 },

  // sent and unpaid, within terms
  { customer: 1, branch: "WST", days: 5, terms: 14, items: [["OIL-001-L", 8], ["RCE-001-KG", 10]], send: true, pay: null },
  { customer: 6, branch: "NGR", days: 6, terms: 30, items: [["FLR-002-WH", 40], ["SLT-001-KG", 25]], send: true, pay: null },
  { customer: 7, branch: "WST", days: 4, terms: 7, items: [["SOP-100-BX", 40], ["TOL-004-PC", 20]], send: true, pay: null },

  // part paid, the awkward middle state
  { customer: 8, branch: "MSB", days: 9, terms: 30, items: [["CHK-001-KG", 30], ["MLK-001-L", 60]], send: true, pay: "part" },
  { customer: 9, branch: "MSB", days: 11, terms: 14, items: [["LDY-001-KG", 24], ["DSH-500-DL", 30]], send: true, pay: "part" },

  // fully paid
  { customer: 2, branch: "NGR", days: 3, terms: 14, items: [["BEF-500-G", 6], ["EGG-030-TR", 8]], send: true, pay: "full" },
  { customer: 4, branch: "WST", days: 7, terms: 14, items: [["FSH-001-KG", 15]], send: true, pay: "full" },
  { customer: 5, branch: "NGR", days: 12, terms: 7, items: [["RCE-001-KG", 20], ["FLR-002-KG", 15]], send: true, pay: "full" },

  // overdue: past the due date and unpaid, which is what the worker sweep looks for
  { customer: 6, branch: "NGR", days: 45, terms: 14, items: [["OIL-001-L", 30]], send: true, pay: null, overdue: true },
  { customer: 8, branch: "MSB", days: 60, terms: 14, items: [["SLT-400-RY", 40]], send: true, pay: null, overdue: true },
  { customer: 2, branch: "WST", days: 38, terms: 7, items: [["TOL-004-PC", 50]], send: true, pay: null, overdue: true },

  // voided, so the report totals have something to exclude
  { customer: 3, branch: "WST", days: 8, terms: 14, items: [["DSH-500-DL", 12]], send: true, pay: null, void: true },
];

function daysAgo(days, hour = 10) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

export { STOCK_BY_BRANCH, CUSTOMERS, SUPPLIERS, STAFF, PRICE, INVOICE_PLAN, daysAgo };