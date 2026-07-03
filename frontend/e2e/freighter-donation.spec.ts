import { test, expect, type Page, type Route } from "@playwright/test";
import http from "http";

const MOCK_PROJECT_ID = "8d9ac19b-52eb-42f7-80d9-19a88ba59e43";
const MOCK_WALLET     = "GAFZU5W3TIKDY2NPXE6S2FNFI5GRWEFDB6LJ4T3ZHOELZGMPTKOD2T47";
const MOCK_PUBLIC_KEY = "GAO4GQ5J3GDGUAETVP7BBHSG3CO5VDH2VNDMSXLSHDJMAEY2BVUFONPL";

const MOCK_PROJECT = {
  id: MOCK_PROJECT_ID,
  name: "Amazon Reforestation Initiative",
  description: "Planting 1 million native trees in the Brazilian Amazon.",
  category: "Reforestation",
  location: "Brazil, South America",
  walletAddress: MOCK_WALLET,
  goalXLM: "50000",
  raisedXLM: "18420",
  donorCount: 147,
  co2OffsetKg: 245000,
  co2_per_xlm: 100,
  status: "active",
  verified: true,
  onChainVerified: true,
  tags: ["reforestation", "amazon"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const ok = (data: unknown) => ({ json: { success: true, data } });

test.describe("Freighter Donation Flow", () => {
  let mockProjectState = { ...MOCK_PROJECT };
  let mockDonationsList: any[] = [];
  let apiMockServer: http.Server;

  test.beforeAll(async () => {
    // Start a lightweight HTTP mock server on port 4000 to resolve Next.js getServerSideProps requests
    apiMockServer = http.createServer((req, res) => {
      console.log(`MOCK SERVER RECEIVED REQUEST [${req.method}]: ${req.url}`);
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Access-Control-Allow-Origin", "*");
      
      if (req.url && req.url.includes(`/api/projects/${MOCK_PROJECT_ID}`)) {
        console.log(`MOCK SERVER: Responding with project state`);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          data: mockProjectState,
        }));
        return;
      }
      
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: "Not found" }));
    });
    
    await new Promise<void>((resolve) => {
      apiMockServer.listen(4000, () => {
        resolve();
      });
    });
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      apiMockServer.close(() => {
        resolve();
      });
    });
  });

  test.beforeEach(async ({ page }) => {
    // Reset state for each test run
    mockProjectState = { ...MOCK_PROJECT };
    mockDonationsList = [];

    // Print browser console logs
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.log(`BROWSER CONSOLE [${msg.type()}]: ${msg.text()}`);
      }
    });

    // Print uncaught browser exceptions
    page.on("pageerror", (err) => {
      console.error(`BROWSER UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
    });

    // Mock payments EventSource to prevent endless connection error retries
    await page.route("**/payments?**", (route) => {
      return route.fulfill({
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        },
        body: ""
      });
    });

    // Inject mock Freighter wallet address (but NOT yet connected)
    await page.addInitScript((pk) => {
      (window as any).__test_wallet_available_pk__ = pk;
    }, MOCK_PUBLIC_KEY);

    // Mock API requests (default fallback)
    await page.route("**/api/**", (route: Route) => route.fulfill(ok([])));
    
    // Mock Horizon requests (balance fetching & tx submission)
    await page.route("**/horizon-testnet.stellar.org/**", (route: Route) => {
      const url = route.request().url();
      if (url.includes("/accounts/")) {
        return route.fulfill({
          json: {
            id: MOCK_PUBLIC_KEY,
            account_id: MOCK_PUBLIC_KEY,
            sequence: "1",
            balances: [{ asset_type: "native", balance: "500.0000000" }]
          }
        });
      }
      if (url.includes("/transactions") && route.request().method() === "POST") {
        return route.fulfill({
          json: {
            hash: "mock_stellar_tx_hash_12345",
            ledger: 12345
          }
        });
      }
      return route.fulfill({ json: { _embedded: { records: [] } } });
    });

    // Mock specific endpoints (prefix with v1 to match rewritten routes)
    await page.route("**/api/v1/stats/global", (r) =>
      r.fulfill(ok({ totalDonations: 1, totalXLMRaised: "100", totalCO2OffsetKg: 1000 }))
    );
    await page.route("**/api/v1/stats/categories", (r) =>
      r.fulfill(ok([{ category: "Reforestation", count: 1 }]))
    );
    await page.route("**/api/v1/projects", (r) => r.fulfill(ok([mockProjectState])));
    await page.route("**/api/v1/projects?**", (r) => r.fulfill(ok([mockProjectState])));
    await page.route("**/api/v1/projects/featured", (r) => r.fulfill(ok(mockProjectState)));
    await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}`, (r) => r.fulfill(ok(mockProjectState)));
    await page.route(`**/api/v1/projects/${MOCK_PROJECT_ID}/**`, (r) => r.fulfill(ok([])));
    await page.route("**/api/v1/subscriptions/**/count", (r) =>
      r.fulfill({ json: { success: true, count: 0 } })
    );

    // Donations endpoints
    await page.route(`**/api/v1/donations/project/${MOCK_PROJECT_ID}`, (r) => r.fulfill(ok(mockDonationsList)));
    
    await page.route("**/api/v1/donations", async (route) => {
      if (route.request().method() === "POST") {
        // Increment metrics to simulate backend processing
        mockProjectState.donorCount += 1;
        mockProjectState.raisedXLM = (parseFloat(mockProjectState.raisedXLM) + 50).toString();
        
        // Add to donations feed
        mockDonationsList.unshift({
          id: "mock_payment_id_123",
          projectId: MOCK_PROJECT_ID,
          donorAddress: MOCK_PUBLIC_KEY,
          amountXLM: "50",
          amount: "50",
          currency: "XLM",
          message: "Go Green!",
          transactionHash: "mock_stellar_tx_hash_12345",
          createdAt: new Date().toISOString(),
        });

        return route.fulfill(ok({ id: "donation_new_id" }));
      }
      return route.fulfill(ok([]));
    });
  });

  test("connect Freighter → browse projects → donate → confirmation", async ({ page }) => {
    // 1. Navigate to home page
    await page.goto("/");

    // Assert that we are not logged in initially and "Connect Wallet" button is shown
    const connectButton = page.getByRole("button", { name: /connect wallet/i });
    await expect(connectButton).toBeVisible();

    // 2. Click "Connect Wallet" to connect mock Freighter
    await connectButton.click();

    // Verify wallet shortened address tag appears in navbar
    const shortenedAddressTag = page.locator(".address-tag");
    await expect(shortenedAddressTag).toBeVisible();
    const expectedShortened = new RegExp(
      `${MOCK_PUBLIC_KEY.slice(0, 6)}.*${MOCK_PUBLIC_KEY.slice(-6)}`
    );
    await expect(shortenedAddressTag).toHaveText(expectedShortened);

    // 3. Browse projects
    // Click "Projects" in the navbar
    await page.getByRole("link", { name: /^projects$/i }).first().click();
    await expect(page).toHaveURL(/\/projects$/);

    // Force hard navigation on project links to bypass Next.js client-side router transition hang
    await page.evaluate(() => {
      document.addEventListener("click", (e) => {
        const link = (e.target as HTMLElement).closest("a");
        if (link && link.href && link.href.includes("/projects/")) {
          e.preventDefault();
          window.location.href = link.href;
        }
      }, true);
    });

    // Click on the project card
    const projectCardLink = page.getByText("Amazon Reforestation Initiative");
    await expect(projectCardLink).toBeVisible();
    await projectCardLink.click();

    // Verify detail page URL and initial donor count (147)
    await expect(page).toHaveURL(new RegExp(`/projects/${MOCK_PROJECT_ID}`));
    const donorStat = page.locator(".stat-card", { hasText: "Donors" });
    try {
      await expect(donorStat.locator("p.font-semibold")).toHaveText("147");
    } catch (e) {
      console.log("TEST FAILURE HTML SNAPSHOT:");
      console.log(await page.content());
      throw e;
    }

    // 4. Fill donation amount and click donate
    const amountInput = page.getByPlaceholder(/or enter custom amount/i);
    await amountInput.fill("50");

    const messageInput = page.getByPlaceholder(/leave a message of support/i);
    await messageInput.fill("Go Green!");

    // Clicks the Donate button inside the donation form
    const donateFormCard = page.locator(".card", { hasText: /make a donation/i });
    const submitBtn = donateFormCard.getByRole("button", { name: /Donate/ });
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    // 5. Verify the confirmation thank-you card appears
    await expect(page.getByRole("heading", { name: /thank you/i })).toBeVisible();
    await expect(page.getByText(/your donation of/i)).toContainText("50 XLM");

    // 6. Simulate SSE push payment to trigger the success toast notification
    await page.evaluate((publicKey) => {
      if (typeof (window as any).__test_pushPayment__ === "function") {
        (window as any).__test_pushPayment__({
          id: "mock_payment_id_123",
          from: publicKey,
          amount: "50",
          asset: "XLM",
          createdAt: new Date().toISOString(),
          transactionHash: "mock_stellar_tx_hash_12345",
        });
      }
    }, MOCK_PUBLIC_KEY);

    // Assert that the success toast appears in the UI
    await expect(page.getByText("New donation received")).toBeVisible();
    await expect(page.getByText(/just donated 50 XLM/i)).toBeVisible();

    // 7. Verify donor count increments from 147 to 148 on the page
    // (Playwright expects automatically wait for the setTimeout refresh to update the DOM text to 148)
    await expect(donorStat.locator("p.font-semibold")).toHaveText("148");
  });
});
