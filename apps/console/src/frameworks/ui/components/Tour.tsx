/**
 * Guided feature tour: dims the page, spotlights one element at a time and explains it.
 * Steps point at `data-tour="…"` anchors and may switch page first; steps the signed-in role
 * can't use are dropped, and a step whose anchor never appears is skipped, not shown broken.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, Sparkles, X } from "lucide-react";
import type { Permission } from "../../../entities/models";
import type { Page } from "../../../entities/access";

export interface TourStep {
  target: string;
  page?: Page;
  title: string;
  body: string;
  perm?: Permission;
}

export const TOUR: TourStep[] = [
  {
    target: "nav",
    title: "Your console",
    body: "Build, monitor, and security & data, in that order. What you see depends on your role, and the server enforces it too.",
  },
  {
    target: "search",
    title: "Search anything",
    body: "Press ⌘K (Ctrl K) to jump to a page or run an action: create a key, change the PII policy, switch theme.",
  },
  {
    target: "stats",
    page: "dashboard",
    title: "Headline numbers",
    body: "Requests with the change against the day before, token volume, and how many requests had personal data masked.",
    perm: "dashboard:read",
  },
  {
    target: "pareto",
    page: "reliability",
    title: "Where problems come from",
    body: "A Pareto chart: causes sorted by size, with the running total. The bars before the 80% line are where a fix pays off most.",
    perm: "dashboard:read",
  },
  {
    target: "scope",
    page: "usage",
    title: "Filter chips",
    body: "Every monitor page filters by tenant (operators), backend and grouping, with the range on the right.",
    perm: "tenants:all",
  },
  {
    target: "pg-composer",
    page: "playground",
    title: "Build a request",
    body: "Write a customer message or pick a template. Form shows the settings; Code shows the same request as cURL, Python or Node.",
    perm: "playground:run",
  },
  {
    target: "pg-run",
    page: "playground",
    title: "Run it",
    body: "⌘/Ctrl + Enter. The answer streams in on the right with routing, the PII guardrail, retrieval, intent, tokens, latency and cost.",
    perm: "playground:run",
  },
  {
    target: "keys-create",
    page: "keys",
    title: "Create an API key",
    body: "Name it after the service, give it only the scopes it needs and an expiry. The secret is shown once.",
    perm: "keys:create",
  },
  {
    target: "pii-policy",
    page: "guardrails",
    title: "Guardrails",
    body: "Personal data is masked before any model sees it. Owners choose mask, block or off, and every change lands in the audit log.",
    perm: "governance:read",
  },
  {
    target: "help",
    title: "Replay any time",
    body: "Open this guide again from the sparkle button in the top bar. That's it: happy building.",
  },
];

const PAD = 8;

export function Tour({
  steps,
  onClose,
  go,
  page,
}: {
  steps: TourStep[];
  onClose: () => void;
  go: (p: Page) => void;
  page: Page;
}) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const step = steps[i];

  const next = useCallback(() => (i < steps.length - 1 ? setI(i + 1) : onClose()), [i, steps.length, onClose]);
  const back = () => setI((x) => Math.max(0, x - 1));

  // switch page if needed, then wait for the anchor to render
  useEffect(() => {
    if (!step) return;
    if (step.page && step.page !== page) go(step.page);
    let raf = 0;
    const started = performance.now();
    const find = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el) {
        el.scrollIntoView({
          block: "center",
          behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        });
        setTimeout(() => setRect(el.getBoundingClientRect()), 260);
        return;
      }
      if (performance.now() - started > 2000) return next(); // missing anchor: skip, don't show a broken step
      raf = requestAnimationFrame(find);
    };
    setRect(null);
    raf = requestAnimationFrame(find);
    return () => cancelAnimationFrame(raf);
    // runs once per step: the step's anchor is looked up again only when the step changes
  }, [i]);

  // follow the anchor on resize and scroll
  useLayoutEffect(() => {
    if (!step) return;
    const update = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el) setRect(el.getBoundingClientRect());
    };
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [step]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") back();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [next, onClose]);

  useEffect(() => {
    if (rect) card.current?.focus({ preventScroll: true });
  }, [rect]);

  if (!step) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const hole = rect && {
    left: rect.left - PAD,
    top: rect.top - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
  // place the card below the anchor, or above / beside it when there's no room
  const cw = 340;
  let pos = { left: vw / 2 - cw / 2, top: vh / 2 - 90 };
  if (hole) {
    const below = hole.top + hole.height + 12;
    const right = hole.left + hole.width + 12;
    if (below + 190 < vh) pos = { left: hole.left, top: below };
    else if (hole.top - 200 > 0) pos = { left: hole.left, top: hole.top - 200 };
    else if (right + cw < vw) pos = { left: right, top: hole.top };
    else pos = { left: hole.left - cw - 12, top: hole.top };
    pos.left = Math.min(Math.max(12, pos.left), vw - cw - 12);
    pos.top = Math.min(Math.max(12, pos.top), vh - 200);
  }

  return createPortal(
    <div className="tour" aria-live="polite">
      <div className="tour-shade" onClick={onClose} style={hole ? undefined : { background: "rgba(10,10,14,.55)" }} />
      {hole && <div className="tour-hole" style={hole} />}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        tabIndex={-1}
        style={{ ...pos, width: cw }}
      >
        <div className="tour-top">
          <span className="tour-badge">
            <Sparkles size={13} /> Feature guide
          </span>
          <button className="icon-btn" onClick={onClose} aria-label="Close the tour">
            <X size={15} />
          </button>
        </div>
        <h3 id="tour-title">{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-foot">
          <div className="dots" aria-label={`Step ${i + 1} of ${steps.length}`}>
            {steps.map((_, k) => (
              <i key={k} className={k === i ? "on" : ""} />
            ))}
          </div>
          <span style={{ flex: 1 }} />
          {i > 0 && (
            <button className="btn sm ghost" onClick={back}>
              <ArrowLeft size={14} /> Back
            </button>
          )}
          <button className="btn sm primary" onClick={next}>
            {i < steps.length - 1 ? (
              <>
                Next <ArrowRight size={14} />
              </>
            ) : (
              "Done"
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** a pulsing "new" marker that disappears once the user has opened the feature */
export function useSeen(key: string) {
  const k = `seen:${key}`;
  const [seen, setSeen] = useState(() => localStorage.getItem(k) === "1");
  const mark = useCallback(() => {
    localStorage.setItem(k, "1");
    setSeen(true);
  }, [k]);
  return [seen, mark] as const;
}
