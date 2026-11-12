/**
 * PII guardrail: finds personal data in what a caller sends before any of it leaves for a
 * model provider.
 *
 * Policy per tenant:
 *  - mask  (default) each value is replaced by a typed placeholder ({{Customer Email}}) in the
 *          text the model and the retriever see. On the support path the gateway fills the
 *          placeholder back in after generation, the same way it fills {{Order Number}}, so the
 *          customer still reads a natural answer while the provider never saw the value. Card,
 *          ID and bank numbers come back only as "the card ending in 4242", never in full.
 *  - block the request is rejected with 422 pii_detected before admission; nothing is sent.
 *  - off   no scanning.
 *
 * Detectors are deliberately conservative (checksums for cards and IBANs, keywords for
 * national ids, context for phone numbers) so order and invoice numbers aren't masked by
 * mistake: a masked order number would break the answer. Personal names are not detected;
 * that needs an NER model and is listed as a known gap.
 *
 * Values are never logged, metered or emitted in events. Only types and counts are.
 */
export const PII_TYPES = ["email", "phone", "card", "national_id", "iban", "ip_address"] as const;
export type PiiType = (typeof PII_TYPES)[number];
export const PII_MODES = ["mask", "block", "off"] as const;
export type PiiMode = (typeof PII_MODES)[number];

export interface PiiPolicy {
  mode: PiiMode;
  types: PiiType[];
}
export const DEFAULT_PII_POLICY: PiiPolicy = { mode: "mask", types: [...PII_TYPES] };

export const PII_LABEL: Record<PiiType, string> = {
  email: "Email address",
  phone: "Phone number",
  card: "Payment card number",
  national_id: "National ID (NIK, SSN)",
  iban: "Bank account (IBAN)",
  ip_address: "IP address",
};

/** placeholder name per type; numbered from the second value on ("Customer Email 2") */
const SLOT: Record<PiiType, string> = {
  email: "Customer Email",
  phone: "Customer Phone",
  card: "Card Number",
  national_id: "National ID",
  iban: "Bank Account",
  ip_address: "IP Address",
};

const digitsOf = (s: string) => s.replace(/\D/g, "");

function luhn(num: string) {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(raw: string) {
  const s = raw.replace(/\s/g, "").toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** what the customer reads back where a masked value was */
function readBack(type: PiiType, value: string) {
  const last4 = digitsOf(value).slice(-4) || value.slice(-4);
  switch (type) {
    case "email":
    case "phone":
      return value.trim(); // the customer's own contact detail, returned only to the caller who sent it
    case "card":
      return `the card ending in ${last4}`;
    case "iban":
      return `the account ending in ${last4}`;
    case "national_id":
      return "your ID number";
    case "ip_address":
      return "the IP address you shared";
  }
}

interface Detector {
  type: PiiType;
  re: RegExp;
  /** which capture group holds the value (default 0) */
  group?: number;
  accept?: (value: string, text: string, index: number) => boolean;
}

const ID_CONTEXT = /\b(order|purchase|invoice|tracking|track|reference|ref|ticket|case|account no|acct)\b[^\n]{0,20}$/i;
const PHONE_CONTEXT =
  /\b(phone|call|text|sms|whats\s?app|wa|tel|telp|hp|mobile|cell|reach me|contact me|number is)\b[^\n]{0,20}$/i;

const DETECTORS: Detector[] = [
  { type: "email", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  { type: "iban", re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, accept: (v) => ibanValid(v) },
  {
    type: "card",
    re: /(?<![\w+-])\d(?:[ -]?\d){12,18}(?![\w-])/g,
    accept: (v) => {
      const d = digitsOf(v);
      // no card number starts with 0; a leading 0 is a local phone number
      return d.length >= 13 && d.length <= 19 && d[0] !== "0" && luhn(d) && !/^(\d)\1+$/.test(d);
    },
  },
  { type: "national_id", re: /\b(?:nik|ktp|national\s+id|id\s+number|nomor\s+induk)\b\D{0,15}(\d{16})\b/gi, group: 1 },
  { type: "national_id", re: /\b(?:ssn|social\s+security(?:\s+number)?)\b\D{0,15}(\d{3}-?\d{2}-?\d{4})\b/gi, group: 1 },
  {
    type: "phone",
    re: /(?<![\w+])(\+?\d[\d\s().-]{6,18}\d)(?!\w)/g,
    group: 1,
    accept: (v, text, i) => {
      const d = digitsOf(v);
      if (d.length < 8 || d.length > 15) return false;
      const before = text.slice(Math.max(0, i - 40), i);
      if (ID_CONTEXT.test(before)) return false; // "order 0812345678" is an order id, not a phone
      return v.startsWith("+") || (d.startsWith("0") && d.length >= 9) || PHONE_CONTEXT.test(before);
    },
  },
  {
    type: "ip_address",
    re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
    accept: (v) => v.split(".").every((o) => Number(o) <= 255),
  },
];

export interface PiiFinding {
  type: PiiType;
  slot: string;
}
export interface PiiScan {
  /** text with every enabled finding replaced by {{Slot}} */
  masked: string;
  findings: PiiFinding[];
  /** slot name → what the customer reads back (never logged) */
  readBack: Map<string, string>;
  counts: Partial<Record<PiiType, number>>;
}

export function scanPii(text: string, types: readonly PiiType[] = PII_TYPES): PiiScan {
  const enabled = new Set(types);
  const findings: PiiFinding[] = [];
  const readBackMap = new Map<string, string>();
  const counts: Partial<Record<PiiType, number>> = {};
  const seen = new Map<string, string>(); // same value twice → same slot
  let masked = text;
  for (const d of DETECTORS) {
    if (!enabled.has(d.type)) continue;
    masked = masked.replace(d.re, (...m: any[]) => {
      const whole: string = m[0];
      const value: string = d.group ? m[d.group] : whole;
      const offset: number = m[m.length - 2];
      const str: string = m[m.length - 1];
      if (!value || (d.accept && !d.accept(value, str, offset + whole.indexOf(value)))) return whole;
      const key = `${d.type}:${value.replace(/\s/g, "").toLowerCase()}`;
      let slot = seen.get(key);
      if (!slot) {
        const n = (counts[d.type] ?? 0) + 1;
        counts[d.type] = n;
        slot = n === 1 ? SLOT[d.type] : `${SLOT[d.type]} ${n}`;
        seen.set(key, slot);
        findings.push({ type: d.type, slot });
        readBackMap.set(slot, readBack(d.type, value));
      }
      return whole.replace(value, `{{${slot}}}`);
    });
  }
  return { masked, findings, readBack: readBackMap, counts };
}

/**
 * Text for the retriever: masked values and the words that only introduce them ("email me at",
 * "my card is") are dropped. Left in, they dilute lexical coverage and a short in-scope message
 * like "how do I cancel order 123? email me at {{Customer Email}}" reads as off-topic.
 */
export function retrievalText(masked: string) {
  const slot = String.raw`\{\{[^}]+\}\}`;
  const leadIn = String.raw`(?:(?:you\s+can|please|pls)\s+)?(?:e-?mail|mail|call|text|sms|whats\s?app|wa|reach|contact|ping)\s+(?:me\s+)?(?:at|on|via|to)?\s*`;
  const mine = String.raw`\b(?:my|the)\s+(?:e-?mail(?:\s+address)?|phone(?:\s+number)?|number|card(?:\s+number)?|nik|ktp|ssn|iban|account|ip(?:\s+address)?)\s*(?:is|:)?\s*`;
  return masked
    .replace(new RegExp(`\\b${leadIn}${slot}`, "gi"), " ")
    .replace(new RegExp(`${mine}${slot}`, "gi"), " ")
    .replace(new RegExp(slot, "g"), " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** "email:2,card:1" for metering and the audit trail; never the values */
export const summarizeCounts = (c: Partial<Record<PiiType, number>>) =>
  Object.entries(c)
    .map(([t, n]) => `${t}:${n}`)
    .join(",");

export function parsePolicy(raw: unknown): PiiPolicy {
  try {
    const p = typeof raw === "string" ? JSON.parse(raw) : raw;
    const mode = (PII_MODES as readonly string[]).includes(p?.mode) ? (p.mode as PiiMode) : DEFAULT_PII_POLICY.mode;
    const types = Array.isArray(p?.types)
      ? (p.types as string[]).filter((t): t is PiiType => (PII_TYPES as readonly string[]).includes(t))
      : [...PII_TYPES];
    return { mode, types };
  } catch {
    return { ...DEFAULT_PII_POLICY };
  }
}
