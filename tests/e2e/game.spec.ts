import { test, expect } from '@playwright/test';

test.describe('CryptoFlip E2E Tests', () => {
  
  test('should register a user, place a bet, and see the result', async ({ page }) => {
    // 1. Navigate to the game page
    await page.goto('/game');

    // 2. Click the Login / Wallet Connect button
    await page.click('button:has-text("লগইন / ওয়ালেট কানেক্ট")');

    // 3. Select Email/Password authentication method
    await page.click('button:has-text("ইউজারনেম/পাসওয়ার্ড")');

    // 4. Toggle to registration form
    await page.click('button:has-text("রেজিস্ট্রেশন করুন")');

    // 5. Fill credentials with a unique username
    const username = `e2e_user_${Date.now()}`;
    await page.fill('placeholder="ইউজারনেম"', username);
    await page.fill('placeholder="ইমেইল (ঐচ্ছিক)"', `${username}@example.com`);
    await page.fill('placeholder="পাসওয়ার্ড"', 'password123');

    // 6. Click registration submit button
    await page.click('button:has-text("রেজিস্ট্রেশন করুন")');

    // 7. Verify login modal closes and balance is shown
    await expect(page.locator('text=ব্যালেন্স:')).toBeVisible({ timeout: 5000 });
    
    // 8. Place a bet on HEADS
    await page.click('button:has-text("HEADS")');
    await page.fill('input[type="number"]', '1.00');

    // 9. Click FLIP button
    await page.click('button:has-text("FLIP")');

    // 10. Wait for the spin animation and verify status changes to "আবার খেলুন" (Play Again)
    await expect(page.locator('button:has-text("আবার খেলুন")')).toBeVisible({ timeout: 15000 });

    // 11. Verify balance is no longer exactly $10.00
    const balanceText = await page.textContent('text=ব্যালেন্স:');
    console.log(`E2E: Balance after bet: ${balanceText}`);
    expect(balanceText).not.toContain('$10.00');
  });

  test('should verify game results using the public verifier page', async ({ page }) => {
    // 1. Go to verifier page
    await page.goto('/verifier');

    // 2. Define valid inputs
    const serverSeed = 'sampleserverseed123456';
    const serverSeedHash = '27cad43ec11e153e714c1bbc24bb85bb8b083ded2da1cc0b26be5c86c40bdaa6';
    const clientSeed = 'sampleclientseed';
    const nonce = '1';

    // 3. Fill in fields
    await page.fill('placeholder="e.g. a3f2d9c1b8e7..."', serverSeedHash);
    await page.fill('placeholder="e.g. 7f4e2b1a9c8d..."', serverSeed);
    await page.fill('placeholder="আপনার সিড"', clientSeed);
    await page.fill('input[type="number"]', nonce);

    // 4. Click verify button
    await page.click('button:has-text("হিসাব যাচাই করুন")');

    // 5. Verify result elements are visible
    await expect(page.locator('text=সিড ইন্টিগ্রিটি ভেরিফাইড (ম্যাচ হয়েছে)')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=কয়েন ফ্লিপ ফলাফল')).toBeVisible();
    await expect(page.locator('text=প্রোগ্রেসিভ জ্যাকপট ফলাফল')).toBeVisible();
  });
  
});
