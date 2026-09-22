/** M1 WP1–8 UI 冒烟：mock 模式走设置/轨迹/bash/面板并截图 */
import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5195', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

// 1. 打开设置 tab（点侧栏 ⚙）
await page.click('.pg-sidebar-actions button:nth-child(2)');
await page.waitForTimeout(900);
await page.screenshot({ path: '/tmp/m1-settings.png' });

// 2. 轨迹页签（先激活会话 tab）
const sessTab = page.locator('.dv-tab', { hasText: '新会话' }).first();
if (await sessTab.count()) await sessTab.click();
await page.waitForTimeout(400);
const trajTab = page.locator('.pg-ws-tab', { hasText: '轨迹' });
if (await trajTab.count()) {
  await trajTab.first().click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '/tmp/m1-traj.png' });
} else errors.push('未找到轨迹页签');

// 3. bash 面板（事件触发 → 直接 eval 状态切换按钮不可用时用键盘）
await page.keyboard.press('Control+j');
await page.waitForTimeout(400);
await page.keyboard.press('Meta+j');
await page.waitForTimeout(400);

// 4. 命令面板
await page.keyboard.press('Meta+k');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/m1-palette.png' });
await page.keyboard.press('Escape');

// 5. 帮助（改绑 UI）
await page.keyboard.press('Meta+/');
await page.waitForTimeout(400);
await page.screenshot({ path: '/tmp/m1-help.png' });
await page.keyboard.press('Escape');

console.log('errors:', errors.length ? errors : '(none)');
await browser.close();
