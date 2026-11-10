// An example take: Paralect Agent's Run modal. Open it from the project header, click each
// category on the left and hover the cards in it, end back on All.
//
//   DEMO_URL=… DEMO_PROJECT=… DEMO_EMAIL=… DEMO_PASSWORD=… node <this skill folder>/scripts/record.mjs \
//     --take out/product-demo/takes/run-modal.mjs --out out/product-demo/run-modal

const BASE = process.env.DEMO_URL ?? "http://localhost:3002";
const PROJECT = process.env.DEMO_PROJECT;

export const url = `${BASE}/p/${PROJECT}`;

/** Sign in on the real origin; the recorder then loads the app in its window. */
export async function prepare(page) {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;
  if (!email || !password) {
    throw new Error(
      "Set DEMO_EMAIL and DEMO_PASSWORD to sign in for the take.",
    );
  }
  await page.goto(`${BASE}/login`);
  await page.getByPlaceholder("you@company.com").fill(email);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.locator('input[type="password"]:visible').fill(password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20000,
  });
}

/** Keep the modal one height across sections so it doesn't jump between them. */
export const css = `
  [role="dialog"][data-slot="dialog-content"] { height: calc(100vh - 4rem); }
`;

const runButton = (t) => t.frame.locator("button:has(svg.lucide-play)").first();
const nav = (t, label) =>
  t.frame.getByRole("button", { name: label, exact: true });
const cards = (t) => t.frame.locator("[cmdk-item]");
const list = (t) => t.frame.locator("[cmdk-list]");

export async function ready(t) {
  await runButton(t).waitFor();
  await t.page.waitForTimeout(1500);
}

/** For `--still`: the modal open with the cursor on a card. */
export async function still(t) {
  await runButton(t).click();
  await t.page.waitForTimeout(1200);
  await t.hover(cards(t).nth(1), { fy: 0.4, ms: 100, dwell: 0 });
}

async function section(t, label, max, dwell) {
  await t.clickOn(nav(t, label), { fx: 0.45 });
  await t.sweep(cards(t), { within: list(t), max, dwell });
}

export default async function take(t) {
  await t.hold(500);
  await t.clickOn(runButton(t), { ms: 800, dwell: 150, settle: 500 });

  await section(t, "Content", 4);
  await section(t, "Reports", 2);
  t.poster();
  await section(t, "Design", 4);
  await section(t, "Images", 2);
  await section(t, "Videos", 4);
  await section(t, "Your skills", 4, 280);

  await t.clickOn(nav(t, "All"), { fx: 0.45, settle: 300 });
  await t.moveTo(t.width * 0.62, t.height * 0.5, { ms: 700 });
  await t.hold(900);
}
