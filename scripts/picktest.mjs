import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:29229');
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => p.url().includes('5173')) || await ctx.newPage();
if (!page.url().includes('5173')) await page.goto('http://localhost:5173');
await page.waitForTimeout(2500);
const c0 = await page.evaluate(() => window.__LC_MAP__ ? JSON.stringify(window.__LC_MAP__.getCenter()) : 'NO_MAP');
// activate pick mode
await page.click('#btn-pick');
await page.waitForTimeout(400);
// click dead center of the map canvas
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width*0.5, box.y + box.height*0.5);
await page.waitForTimeout(2500);
const c1 = await page.evaluate(() => JSON.stringify(window.__LC_MAP__.getCenter()));
const picking = await page.evaluate(() => document.getElementById('map').classList.contains('picking'));
const addr = await page.evaluate(() => document.getElementById('addr-input').value);
console.log(JSON.stringify({c0, c1, pickingStillOn: picking, addr}, null, 1));
await b.close();
