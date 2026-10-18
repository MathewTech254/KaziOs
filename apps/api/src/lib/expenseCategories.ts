/**
 * The categories a new business starts with.
 *
 * Seeded on first read of the category list and by the demo seed, so an organization
 * that already exists picks them up without a migration, and one created tomorrow gets
 * them without this list having to be edited in two places.
 *
 * The account codes follow the conventional numbering an accountant would expect in
 * Kenya: 6xxx is operating expense, so a chart of accounts built up from these sorts
 * itself and the trial balance reads sensibly. M-PESA and airtime are listed as their
 * own categories because for a small trading business the cost of moving money and the
 * cost of talking to customers are recurring, visible costs that would otherwise vanish
 * into an "other" bucket nobody can budget against.
 */
export const DEFAULT_EXPENSE_CATEGORIES = [
  { name: "Rent", description: "Shop, office or warehouse rent", accountCode: "6000" },
  {
    name: "Utilities",
    description: "Electricity, water and refuse collection",
    accountCode: "6100",
  },
  {
    name: "Salaries & Wages",
    description: "Staff pay and statutory contributions",
    accountCode: "6200",
  },
  { name: "Transport & Fuel", description: "Delivery, matatu and fuel costs", accountCode: "6300" },
  { name: "Marketing", description: "Advertising, signage and promotions", accountCode: "6400" },
  {
    name: "Office & Stationery",
    description: "Printing, consumables and equipment",
    accountCode: "6500",
  },
  {
    name: "Repairs & Maintenance",
    description: "Building and equipment upkeep",
    accountCode: "6600",
  },
  {
    name: "Internet & Software",
    description: "Data bundles, hosting and subscriptions",
    accountCode: "6700",
  },
  {
    name: "Bank & Mobile Money Fees",
    description: "Bank charges and M-PESA commission",
    accountCode: "6800",
  },
  { name: "Airtime & Data", description: "Airtime and data for staff phones", accountCode: "6900" },
  {
    name: "Security",
    description: "Guards, alarms and insurance on premises",
    accountCode: "7000",
  },
  {
    name: "Licences & Permits",
    description: "Business licence, KRA and county permits",
    accountCode: "7100",
  },
  {
    name: "Cleaning & Sanitation",
    description: "Cleaning supplies and sanitation",
    accountCode: "7200",
  },
  {
    name: "Other",
    description: "Anything that does not fit another category",
    accountCode: "7900",
  },
] as const;
