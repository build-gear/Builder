import { expect, test } from "@playwright/test";

test("keeps keyboard focus visible on the primary command path", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByLabel("Prompt")).toBeFocused();

  const promptFrameStyle = await page.locator(".prompt-frame").evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      borderColor: style.borderColor,
      boxShadow: style.boxShadow
    };
  });
  expect(promptFrameStyle.borderColor).toContain("149, 230, 187");
  expect(promptFrameStyle.boxShadow).toContain("149, 230, 187");

  await page.keyboard.press("Tab");
  const focusedButtonStyle = await page.locator("button:focus-visible").evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      outlineStyle: style.outlineStyle,
      outlineColor: style.outlineColor
    };
  });
  expect(focusedButtonStyle.outlineStyle).toBe("solid");
  expect(focusedButtonStyle.outlineColor).toContain("149, 230, 187");
});

test("does not expose inert shell controls", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await expect(page.locator(".app-shell")).toHaveClass(/sidebar-collapsed/);

  await page.getByRole("button", { name: "Hide inspector" }).click();
  await expect(page.getByRole("button", { name: "Show inspector" })).toBeVisible();
  await expect(page.getByText("Events")).toHaveCount(0);

  await page.getByRole("button", { name: "Add context" }).click();
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await expect(page.getByText("Choose context")).toBeVisible();
});

test("names icon-only controls for assistive tech and native tooltips", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");

  const unnamedControls = await page.evaluate(() => Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".chrome-button, .mini-button, .panel-tool-button, .round-button, .mic-button, .primary-action"
    )
  )
    .filter((button) => !button.getAttribute("aria-label")?.trim() || !button.getAttribute("title")?.trim())
    .map((button) => button.outerHTML));

  expect(unnamedControls).toEqual([]);
});
