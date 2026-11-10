/**
 * Template slots in Bitext answers ({{Order Number}}, {{Customer Support Phone Number}}…).
 *
 * The model keeps placeholders verbatim and the gateway fills them in deterministically,
 * after generation, while streaming. The LLM never types a phone number, URL or order id,
 * so it can't invent one. Values come from, in priority order:
 *   1. the customer's own message     ("cancel order 12345" → Order Number = 12345)
 *   2. the tenant's company profile    (support phone, hours, website, …; stored per tenant)
 *   3. default UI labels               ({{Online Order Interaction}} → "Orders"), overridable per tenant
 *   4. a natural fallback phrase       ({{Order Number}} → "your order number")
 * Placeholders never reach the customer as raw {{…}}.
 */

export type SlotSource = "message" | "profile" | "ui_label" | "fallback";
export interface SlotValue {
  value: string;
  source: SlotSource;
}

/** product UI names used by Bitext answers; a tenant profile can override any of them */
export const DEFAULT_UI_LABELS: Record<string, string> = {
  "Online Order Interaction": "Orders",
  "Order Status": "Order Status",
  "Order Tracking": "Track Order",
  "Track Order": "Track Order",
  "Tracking Information": "Tracking",
  "My Purchases": "My Purchases",
  "Purchase History": "Purchase History",
  "Cancel Purchase": "Cancel Order",
  Settings: "Settings",
  Profile: "Profile",
  "Profile Settings": "Profile Settings",
  "User Profile": "Profile",
  "Profile Type": "profile type",
  "Regular Profile": "Standard profile",
  "Account Change": "Change Plan",
  "Upgrade Account": "Upgrade",
  Security: "Security",
  Privacy: "Privacy",
  Save: "Save",
  Confirm: "Confirm",
  "Forgot Password": "Forgot password?",
  "Account Recovery": "Account Recovery",
  "Account Recovery Page": "Account Recovery",
  "Reset PIN": "Reset PIN",
  "PIN Recovery": "Reset PIN",
  "Forgot PIN": "Reset PIN",
  "PIN Code Reset": "Reset PIN",
  "Manage PIN": "Manage PIN",
  "Pin Code Settings": "PIN Settings",
  "Forgot Access Key": "Forgot key?",
  "Forgot Key": "Forgot key?",
  "Forgot Profile Key": "Forgot key?",
  "Forgot Account Key": "Forgot key?",
  "Retrieve Key": "Retrieve key",
  "Order/Refund/Transaction": "order, refund or transaction",
};

/** used only when nothing better is known; chosen to read naturally in Bitext's sentence shapes */
const FALLBACK: Record<string, string> = {
  "Order Number": "your order number",
  "Invoice Number": "your invoice number",
  "Tracking Number": "your tracking number",
  "Rebate Tracking Number": "your rebate tracking number",
  "Account Number": "your account number",
  "Refund Amount": "the refund amount",
  "Money Amount": "the amount",
  "Currency Symbol": "",
  "Account Type": "chosen",
  "Account Category": "chosen",
  "Delivery City": "your city",
  "Delivery Country": "your country",
  "Date Range": "the selected period",
  "Person Name": "the person you mentioned",
  "Client Name": "",
  "Client First Name": "",
  "Client Last Name": "",
  "Client Full Name": "",
  Salutation: "",
  "Customer Support Phone Number": "our support phone line",
  "Toll-Free Number": "our toll-free line",
  "Customer Support Hours": "our support hours",
  "Customer Support Email": "our support email",
  "Customer Service Email": "our support email",
  "Website URL": "our website",
  "Online Company Portal Info": "your online account",
  "Login Page URL": "the login page",
  "Login URL": "the login page",
  "Help Center URL": "our Help Center",
  "Customer Support Live Chat URL": "our live chat",
  "Store Location": "our nearest store",
  "Standard Shipping Days": "a few business days",
  "Expedited Shipping Days": "one to two business days",
  Company: "our company",
  "Company Name": "our company",
  "Company Account": "company account",
};

const PLAN_WORDS = ["platinum", "premium", "gold", "silver", "bronze", "standard", "basic", "free", "freemium", "pro", "business", "personal", "family", "enterprise"];

/** Pull concrete values the customer typed. Conservative: no match → leave it to the fallback. */
export function extractFromMessage(message: string): Record<string, string> {
  const out: Record<string, string> = {};
  const id = "([A-Z]{0,4}[-#]?\\d[\\w-]{2,})";
  const grab = (re: RegExp) => re.exec(message)?.[1];
  const order = grab(new RegExp(`\\b(?:order|purchase)\\s*(?:number|no\\.?|nr\\.?|id)?\\s*[#:]?\\s*${id}`, "i"));
  const invoice = grab(new RegExp(`\\binvoice\\s*(?:number|no\\.?|id)?\\s*[#:]?\\s*${id}`, "i"));
  const tracking = grab(new RegExp(`\\btracking\\s*(?:number|no\\.?|id|code)?\\s*[#:]?\\s*${id}`, "i"));
  const account = grab(new RegExp(`\\baccount\\s*(?:number|no\\.?)\\s*[#:]?\\s*${id}`, "i"));
  const money = /(?:\$|usd\s?|rp\.?\s?|idr\s?|€|£)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(?:dollars|usd|rupiah|idr|euros?)/i.exec(message);
  const plan = PLAN_WORDS.find((w) => new RegExp(`\\b${w}\\b`, "i").test(message));
  if (order) out["Order Number"] = order;
  if (invoice) out["Invoice Number"] = invoice;
  if (tracking) out["Tracking Number"] = tracking;
  if (account) out["Account Number"] = account;
  if (money) {
    const raw = money[0].trim();
    out["Refund Amount"] = raw;
    out["Money Amount"] = raw;
    out["Currency Symbol"] = ""; // the amount already carries its currency
  }
  if (plan) {
    out["Account Type"] = plan;
    out["Account Category"] = plan;
  }
  return out;
}

export function buildSlots(message: string, profile: Record<string, string>): Map<string, SlotValue> {
  const slots = new Map<string, SlotValue>();
  for (const [k, v] of Object.entries(DEFAULT_UI_LABELS)) slots.set(k, { value: v, source: "ui_label" });
  for (const [k, v] of Object.entries(profile)) slots.set(k, { value: v, source: "profile" });
  for (const [k, v] of Object.entries(extractFromMessage(message))) slots.set(k, { value: v, source: "message" });
  return slots;
}

function normaliseName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * Models sometimes shorten a name ("{{Support Phone Number}}"). Map it to the known slot whose
 * name contains it, or that it contains; prefer the longest overlap.
 */
function canonical(n: string, slots: Map<string, SlotValue>): string {
  const lower = n.toLowerCase();
  const known = [...new Set([...slots.keys(), ...Object.keys(FALLBACK)])];
  const exact = known.find((k) => k.toLowerCase() === lower);
  if (exact) return exact;
  const near = known
    .filter((k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))
    .sort((a, b) => b.length - a.length)[0];
  return near ?? n;
}

export function resolveSlot(name: string, slots: Map<string, SlotValue>): SlotValue {
  const n = canonical(normaliseName(name), slots);
  const hit = slots.get(n);
  if (hit) return hit;
  return { value: FALLBACK[n] ?? n.toLowerCase(), source: "fallback" };
}

const DETERMINER = /\b(your|our|the|my|a|an)\s*$/i;

/**
 * Identifier slots read badly when the sentence already names them:
 * "the order number {{Order Number}}" → "the order number on file" (not "… your order number").
 */
const ID_NOUN: Record<string, string> = {
  "Order Number": "order number",
  "Invoice Number": "invoice number",
  "Tracking Number": "tracking number",
  "Rebate Tracking Number": "tracking number",
  "Account Number": "account number",
};

/**
 * Streaming renderer: placeholders can be split across chunks ("{{Order" + " Number}}"),
 * so text from an unmatched "{{" (or a trailing "{") is held back until it closes.
 */
export class PlaceholderRenderer {
  private pending = "";
  readonly used = new Map<string, SlotValue>();
  private static MAX_SLOT = 80;

  constructor(private slots: Map<string, SlotValue>) {}

  push(chunk: string): string {
    this.pending += chunk;
    let out = "";
    for (;;) {
      const open = this.pending.indexOf("{{");
      if (open < 0) {
        // keep a lone trailing "{" in case the next chunk starts with "{"
        if (this.pending.endsWith("{")) {
          out += this.pending.slice(0, -1);
          this.pending = "{";
        } else {
          out += this.pending;
          this.pending = "";
        }
        return this.tidy(out);
      }
      const close = this.pending.indexOf("}}", open);
      if (close < 0) {
        if (this.pending.length - open > PlaceholderRenderer.MAX_SLOT) {
          // not a placeholder after all: release it
          out += this.pending.slice(0, open + 2);
          this.pending = this.pending.slice(open + 2);
          continue;
        }
        out += this.pending.slice(0, open);
        this.pending = this.pending.slice(open);
        return this.tidy(out);
      }
      const name = this.pending.slice(open + 2, close);
      const v = resolveSlot(name, this.slots);
      this.used.set(normaliseName(name), v);
      let value = v.value;
      const before = out + this.pending.slice(0, open);
      // "on our {{Online Company Portal Info}}" + fallback "your online account" → "on our online account"
      if (v.source === "fallback") {
        const noun = ID_NOUN[canonical(normaliseName(name), this.slots)];
        const tail = before.replace(/["'“‘(\s]+$/, "").toLowerCase();
        if (noun && (tail.endsWith(noun) || tail.endsWith(noun.split(" ")[0]) || tail.endsWith("number") || tail.endsWith("#"))) {
          value = "on file";
        } else if (DETERMINER.test(before)) {
          value = value.replace(/^(your|our|the|my|a|an)\s+/i, "");
        }
      }
      out += this.pending.slice(0, open) + value;
      this.pending = this.pending.slice(close + 2);
    }
  }

  flush(): string {
    const rest = this.pending;
    this.pending = "";
    return this.tidy(rest);
  }

  /** after empty substitutions: "Hello , " → "Hello, " and no doubled spaces */
  private tidy(s: string) {
    return s.replace(/ {2,}/g, " ").replace(/ ([,.!?])/g, "$1");
  }

  report() {
    return [...this.used.entries()].map(([name, v]) => ({ name, value: v.value, source: v.source }));
  }
}

/** contact details a customer may ask for even when no retrieved KB answer mentions them */
const CORE_CONTACT = [
  "Customer Support Phone Number",
  "Customer Support Hours",
  "Customer Support Email",
  "Website URL",
  "Customer Support Live Chat URL",
  "Help Center URL",
];

/**
 * Placeholders the model may use: those in the retrieved answers that have a real value, plus
 * core contact details the tenant has configured.
 */
export function fillablePlaceholders(texts: string[], slots: Map<string, SlotValue>): string[] {
  const seen = new Set<string>(CORE_CONTACT);
  for (const t of texts) for (const m of t.matchAll(/\{\{([^}]+)\}\}/g)) seen.add(normaliseName(m[1]));
  return [...seen].filter((n) => resolveSlot(n, slots).source !== "fallback").sort();
}
