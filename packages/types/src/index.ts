export const QUEUE_NAMES = {
  NOTIFICATIONS: "kazios_notifications",
  AUTOMATIONS: "kazios_automations",
  REPORTS: "kazios_reports",
  INVOICE_OVERDUE: "kazios_invoice_overdue",
  STOCK_CHECK: "kazios_stock_check",
} as const;

/** Storage object categories used by the file/integration layer. */
export enum FileType {
  IMAGE = "IMAGE",
  PDF = "PDF",
  SPREADSHEET = "SPREADSHEET",
  PRESENTATION = "PRESENTATION",
  DOCUMENT = "DOCUMENT",
  ARCHIVE = "ARCHIVE",
  OTHER = "OTHER",
}