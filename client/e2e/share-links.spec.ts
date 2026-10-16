import { expect, test } from "@playwright/test";

// Share-link two-user flow (contract level, no media proof).
// Prerequisites (not started by this spec): API on :3000 and client on
// :5173 with VITE_API_URL pointing at the API. A join/token success
// here never proves live LiveKit media works.

test("title-only create → copy URL → logged-out invitee → register/login → Join", async ({
  page,
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const emailA = `share-a-${stamp}@example.com`;
  const emailB = `share-b-${stamp}@example.com`;
  const pw = "correct horse battery staple!";

  // Host: register, sign in, create.
  await page.goto("/");
  await page.getByRole("button", { name: /register/i }).click();
  await page.getByLabel(/name/i).fill("Share Host");
  await page.getByLabel(/email/i).fill(emailA);
  await page.getByLabel(/password/i).fill(pw);
  await page.getByRole("button", { name: /^register$/i }).click();
  await expect(page.getByText(/account created/i)).toBeVisible();
  await page.getByRole("button", { name: /go to sign in/i }).click();
  await page.getByLabel(/email/i).fill(emailA);
  await page.getByLabel(/password/i).fill(pw);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  await expect(page.getByText(/welcome to intellmeet/i)).toBeVisible();
  await page.getByRole("button", { name: /new meeting/i }).click();
  await page.getByLabel(/title/i).fill(`share ${stamp}`);
  await page.getByRole("button", { name: /create/i }).click();
  const urlText = await page.getByTestId("join-url").textContent();
  expect(urlText).toMatch(/\/join\/[A-Za-z0-9_-]{22}$/);
  const code = urlText!.trim().split("/join/")[1];

  // Invitee: fresh logged-out context opens the link, registers,
  // signs in, and explicitly joins.
  const guest = await browser.newContext();
  const invite = guest.pages()[0] || (await guest.newPage());
  await invite.goto(`/#/join/${code}`);
  await expect(invite.getByText(/sign in to join/i)).toBeVisible();
  await invite.getByRole("button", { name: /register/i }).click();
  await invite.getByLabel(/name/i).fill("Share Guest");
  await invite.getByLabel(/email/i).fill(emailB);
  await invite.getByLabel(/password/i).fill(pw);
  await invite.getByRole("button", { name: /^register$/i }).click();
  await expect(invite.getByText(/account created/i)).toBeVisible();
  await invite.getByRole("button", { name: /go to sign in/i }).click();
  await invite.getByLabel(/email/i).fill(emailB);
  await invite.getByLabel(/password/i).fill(pw);
  await invite.getByRole("button", { name: /^sign in$/i }).click();
  // After sign-in the invite returns to the exact meeting.
  await expect(invite.getByRole("button", { name: /join meeting/i })).toBeVisible({ timeout: 15000 });
  await invite.getByRole("button", { name: /join meeting/i }).click();
  // Joined invitee lands in the meeting lab with the meeting preset.
  await expect(invite.getByTestId("meeting-id")).toHaveValue(/.+/, { timeout: 15000 });
  await guest.close();
});
