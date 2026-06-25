import { expect, test, type Page } from "@playwright/test";

const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 834, height: 1112 },
  { name: "mobile", width: 390, height: 844 }
];

for (const viewport of viewports) {
  test(`keeps the run workbench usable without horizontal overflow on ${viewport.name}`, async ({ page }) => {
    await openAtViewport(page, viewport);

    await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible();
    await expect(page.getByLabel("Prompt")).toBeVisible();
    await expect(page.getByRole("button", { name: "Queue run" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run health check" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Create support bundle" })).toBeVisible();
    await expect(page.getByRole("button", { name: "List workspace backups" })).toBeVisible();

    await expectNoHorizontalOverflow(page);
    await expectVisibleControlsInsideViewport(page, [
      "Queue run",
      "Run health check",
      "Create diagnostics report",
      "Create support bundle",
      "List workspace backups"
    ]);
  });

  test(`keeps management views usable without horizontal overflow on ${viewport.name}`, async ({ page }) => {
    await openAtViewport(page, viewport);

    for (const view of ["Marketplace", "Ontology", "Schedules", "Backups"] as const) {
      await page.getByRole("button", { name: view, exact: true }).click();
      await expect(page.getByRole("heading", { name: view === "Marketplace" ? "Skills" : view, exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }
  });
}

async function openAtViewport(page: Page, viewport: { width: number; height: number }) {
  await page.setViewportSize(viewport);
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
}

async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    overflowingElements: Array.from(document.querySelectorAll("body *"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -1 || rect.right > window.innerWidth + 1);
      })
      .slice(0, 5)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        className: element.getAttribute("class"),
        text: element.textContent?.trim().slice(0, 60)
      }))
  }));

  expect(metrics.overflowingElements).toEqual([]);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
}

async function expectVisibleControlsInsideViewport(page: Page, labels: string[]) {
  for (const label of labels) {
    const button = page.getByRole("button", { name: label }).first();
    const box = await button.boundingBox();

    expect(box, `${label} should have a layout box`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  }
}
