import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { comparisonFixture } from '../fixtures/comparison.js';
import { createProject, serializeProject, PROJECT_STORAGE_KEY } from '../../src/projects.js';

async function openProject(page: Page) {
  await page.goto('/');
  const narrow = (page.viewportSize()?.width ?? 1440) < 1080;
  if (narrow) await page.locator('#btn-sidebar').click();
  const project = createProject(comparisonFixture(), { acceptedSites: [], rejectedSites: [] }, '方案与导出验收');
  await page.locator('#project-file').setInputFiles({ name: 'project.json', mimeType: 'application/json', buffer: Buffer.from(serializeProject(project)) });
  await expect(page.locator('#project-status')).toContainText('已导入');
  if (narrow) { await page.locator('#btn-sidebar').click(); await page.locator('#btn-panel').click(); }
}
async function stored(page: Page) {
  return page.evaluate(key => { const s = JSON.parse(localStorage.getItem(key)!); return s.projects.find((p: any) => p.id === s.recentId); }, PROJECT_STORAGE_KEY);
}
test.beforeEach(async ({ context }) => {
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
});

test('A/B独立记录、载入、刷新、文件往返和报告导出保持一致', async ({ page }, info) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => dialog.accept());
  await openProject(page);
  await page.locator('[data-tab="plan"]').click();
  await page.locator('[data-act="accept"]').first().click();
  await page.locator('[data-tab="compare"]').click();
  await page.locator('[data-scenario-save="A"]').click();
  await expect(page.locator('#project-status')).toContainText('已保存');
  const first = (await stored(page)).workbench.scenarios.A;
  await page.locator('#compare-plan').click();
  await page.locator('[data-act="accept"]').first().click();
  await page.locator('[data-tab="compare"]').click();
  await page.locator('[data-scenario-save="B"]').click();
  const before = await stored(page);
  expect(before.workbench.scenarios.A).toEqual(first);
  expect(before.workbench.scenarios.B.acceptedSites).toHaveLength(2);
  await page.locator('#compare-reset').click();
  expect((await stored(page)).workbench.acceptedSites).toHaveLength(0);
  await page.reload(); await expect(page.locator('#project-status')).toContainText('已打开');
  await page.locator('[data-tab="compare"]').click();
  await page.locator('[data-scenario-load="A"]').click();
  expect((await stored(page)).workbench.acceptedSites).toEqual(first.acceptedSites);
  await expect(page.locator('.comparison-table')).not.toContainText('未记录');
  await page.screenshot({ path: info.outputPath('comparison-desktop.png'), animations: 'disabled' });
  const downloadPending = page.waitForEvent('download'); await page.locator('#project-export').click();
  const backup = await readFile((await (await downloadPending).path())!, 'utf8');
  expect(JSON.parse(backup).workbench.scenarios).toEqual(before.workbench.scenarios);
  await page.locator('#project-file').setInputFiles({ name: 'restored.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.locator('#project-status')).toContainText('已导入');
  await page.locator('[data-tab="compare"]').click();
  const uiTable = await page.locator('.comparison-table').innerText();
  const popupPending = page.waitForEvent('popup'); await page.locator('#btn-print').click();
  const report = await popupPending;
  await expect(report.locator('h1')).toContainText('圈点');
  await expect(report.locator('.report-map')).toHaveCount(3);
  expect(await report.locator('.comparison-table').innerText()).toBe(uiTable);
  await expect(report.getByRole('heading', { name: '方案 B 已采纳（2 处）', exact: true })).toBeVisible();
  await report.screenshot({ path: info.outputPath('report-preview.png'), fullPage: true });
  await report.emulateMedia({ media: 'print' });
  await expect(report.locator('.toolbar')).toBeHidden();
  const pdf = await report.pdf({ path: info.outputPath('report.pdf'), preferCSSPageSize: true, printBackground: true });
  expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  expect(errors).toEqual([]);
});

test('设施下载内容、弹窗被阻止时的报告备份与导出失败提示', async ({ page }) => {
  await openProject(page);
  let pending = page.waitForEvent('download'); await page.locator('#btn-facility-csv').click();
  const csv = await readFile((await (await pending).path())!, 'utf8');
  expect(csv).toContain('BD-09'); expect(csv).toContain('幸福小区'); expect(csv.startsWith('\ufeff')).toBe(true);
  await page.evaluate(() => { window.open = () => null; });
  pending = page.waitForEvent('download'); await page.locator('#btn-print').click();
  const report = await readFile((await (await pending).path())!, 'utf8');
  expect(report).toContain('当前已采纳（0 处）');
  await expect(page.locator('#banner')).toContainText('预览窗口被浏览器阻止');
  await page.evaluate(() => { URL.createObjectURL = () => { throw new Error('simulated failure'); }; });
  await page.locator('#btn-facility-csv').click();
  await expect(page.locator('#banner')).toContainText('设施表导出失败');
  expect((await stored(page)).result.centerName).toBe('离线方案验收社区');
});

test('窄屏方案操作与比较表不溢出面板', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openProject(page);
  await page.locator('[data-tab="compare"]').click();
  await page.locator('[data-scenario-save="A"]').click();
  await expect(page.locator('[data-scenario-load="A"]')).toBeEnabled();
  expect(await page.locator('#panel-body').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('comparison-mobile.png'), animations: 'disabled' });
});

test('批量完成后导出薄弱社区，不调用真实服务', async ({ page }) => {
  const communities = [
    { name: '薄弱社区甲', center: { lat: 28, lng: 118 }, score: 60, grade: 'D', coverageShare: null, dominantMissing: null },
    { name: '正常社区乙', center: { lat: 28, lng: 118 }, score: 90, grade: 'A', coverageShare: .9, dominantMissing: null }
  ];
  await page.route('**/api/batch/**', route => route.fulfill({ json: route.request().method() === 'POST' ? { status: 0, jobId: 'offline-job', total: 2 } :
    { status: 0, job: { status: 'done', done: 2, total: 2, current: '', communities, summary: { avgScore: 75, weakList: [communities[0]] } } } }));
  await page.goto('/'); await page.locator('[data-tab="street"]').click();
  await page.locator('#street-addr').fill('离线测试街道'); await page.locator('#btn-street-start').click();
  await expect(page.locator('#btn-weak-csv')).toBeVisible({ timeout: 10_000 });
  const pending = page.waitForEvent('download'); await page.locator('#btn-weak-csv').click();
  const csv = await readFile((await (await pending).path())!, 'utf8');
  expect(csv).toContain('薄弱社区甲'); expect(csv).toContain('无法评估'); expect(csv).not.toContain('正常社区乙');
});
