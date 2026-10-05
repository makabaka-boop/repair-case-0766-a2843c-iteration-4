import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 容量更正凭证的双标签页端到端验收。
 *
 * 覆盖：过期页面提交更正被冲突拒绝（不显示虚假新增余量）、
 * 另一页更正后当前页经 storage 事件自动刷新有效容量与余量、
 * 写入失败只拒绝本次更正（余量不扣减 / 不虚增、存储原文不变）、
 * 调增 / 调减与登记在两页交错后刷新一致、
 * 含凭证的损坏存档（拿最终容量反验早期记录）不可信且不被覆盖。
 */

const BATCH_A_ID = 'seed-batch-a';

async function seedBatch(
  page: Page,
  capacity: number,
  records: Array<{ films: number; remainingAfter: number }> = [],
  revision = 1,
): Promise<void> {
  const payload = {
    batches: [{ id: BATCH_A_ID, name: '跨页凭证批次', capacity, createdAt: '2026-10-01T08:00:00.000Z' }],
    records: records.map((record, index) => ({
      id: `seed-record-${index}`,
      batchId: BATCH_A_ID,
      films: record.films,
      note: '',
      remainingAfter: record.remainingAfter,
      createdAt: new Date(Date.UTC(2026, 10, 1, 9, index)).toISOString(),
    })),
    revision,
  };
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, value);
      }
    },
    [LEDGER_STORAGE_KEY, JSON.stringify(payload)] as const,
  );
}

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

async function blockStorageSync(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as Window & { __blockLedgerEvents?: boolean };
    w.__blockLedgerEvents = true;
    window.addEventListener(
      'storage',
      (event) => {
        if (w.__blockLedgerEvents && event.key === key) event.stopImmediatePropagation();
      },
      true,
    );
  }, LEDGER_STORAGE_KEY);
}

async function unblockStorageSync(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as Window & { __blockLedgerEvents?: boolean }).__blockLedgerEvents = false;
  });
}

async function readRaw(page: Page) {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw
      ? (JSON.parse(raw) as {
          revision: number;
          corrections: Array<{ previousCapacity: number; newCapacity: number; seq: number }>;
        })
      : null;
  }, LEDGER_STORAGE_KEY);
}

async function makeLedgerWritesFail(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const proto = Object.getPrototypeOf(window.localStorage);
    if (!(proto as { __failLedger?: boolean }).__failLedger) {
      const original = proto.setItem;
      proto.setItem = function patchedSetItem(this: Storage, k: string, value: string) {
        if (k === key) throw new Error('QuotaExceededError: simulated quota');
        return original.call(this, k, value);
      };
      (proto as { __failLedger?: boolean }).__failLedger = true;
    }
  }, LEDGER_STORAGE_KEY);
}

test('过期页面提交更正被冲突拒绝：不显示虚假余量，对齐最新凭证后重试成功', async ({ browser }) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  await seedBatch(pageA, 10);
  const pageB = await context.newPage();
  await blockStorageSync(pageB);
  await gotoLedger(pageA);
  await gotoLedger(pageB);
  await pageA.getByTestId('batch-item').click();
  await pageB.getByTestId('batch-item').click();

  // A 先调增 10 → 16
  await pageA.getByTestId('correction-capacity-input').fill('16');
  await pageA.getByTestId('correction-reason-input').fill('A 页调增');
  await pageA.getByTestId('correct-capacity-button').click();
  await expect(pageA.getByTestId('detail-effective')).toHaveText('16');
  await expect(pageA.getByTestId('detail-remaining')).toHaveText('16');

  // B 持过期视图（有效容量 10）提交 10 → 12：冲突被拒，顶部提示，立即对齐 A 的凭证
  await pageB.getByTestId('correction-capacity-input').fill('12');
  await pageB.getByTestId('correction-reason-input').fill('B 页过期更正');
  await pageB.getByTestId('correct-capacity-button').click();
  await expect(pageB.getByTestId('ledger-error')).toContainText('其他页面');
  await expect(pageB.getByTestId('correction-item')).toHaveCount(1);
  await expect(pageB.getByTestId('correction-new')).toHaveText('16');
  await expect(pageB.getByTestId('detail-effective')).toHaveText('16');
  await expect(pageB.getByTestId('detail-remaining')).toHaveText('16');
  // 草稿保留，但绝不显示 B 想要的虚假有效容量 12
  await expect(pageB.getByTestId('correction-capacity-input')).toHaveValue('12');
  await expect(pageB.getByTestId('batch-effective')).toHaveText('16');

  // 存储中只有 A 的一张凭证
  const raw = await readRaw(pageA);
  expect(raw?.corrections).toHaveLength(1);
  expect(raw?.corrections[0]).toMatchObject({ previousCapacity: 10, newCapacity: 16, seq: 1 });
  expect(raw?.revision).toBe(2);

  // B 基于最新容量改填 20 重试：成功，凭证链 10→16→20
  await pageB.getByTestId('correction-capacity-input').fill('20');
  await pageB.getByTestId('correct-capacity-button').click();
  await expect(pageB.getByTestId('ledger-error')).toHaveCount(0);
  await expect(pageB.getByTestId('detail-effective')).toHaveText('20');
  await expect(pageB.getByTestId('correction-new')).toHaveText(['16', '20']);
  await unblockStorageSync(pageB);

  // A 经 storage 事件自动同步：无需刷新即看到 20
  await expect(pageA.getByTestId('detail-effective')).toHaveText('20');
  await expect(pageA.getByTestId('correction-item')).toHaveCount(2);

  // 两页刷新后：凭证集合、顺序、有效容量、余量完全一致
  for (const page of [pageA, pageB]) {
    await page.reload();
    await page.getByTestId('nav-ledger').click();
    await expect(page.getByTestId('batch-effective')).toHaveText('20');
    await expect(page.getByTestId('batch-capacity')).toHaveText('10');
    await expect(page.getByTestId('batch-remaining')).toHaveText('20');
    await page.getByTestId('batch-item').click();
    await expect(page.getByTestId('correction-previous')).toHaveText(['10', '16']);
    await expect(page.getByTestId('correction-new')).toHaveText(['16', '20']);
  }
  await context.close();
});

test('另一页更正后当前页自动刷新有效容量与余量，后续登记按新容量且历史余量不重写', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  // 容量 10、已登记 8（旧余量 2）
  await seedBatch(pageA, 10, [{ films: 8, remainingAfter: 2 }]);
  await gotoLedger(pageA);
  await pageA.getByTestId('batch-item').click();
  await expect(pageA.getByTestId('detail-remaining')).toHaveText('2');

  const pageB = await context.newPage();
  await gotoLedger(pageB);
  await pageB.getByTestId('batch-item').click();

  // B 调增到 15
  await pageB.getByTestId('correction-capacity-input').fill('15');
  await pageB.getByTestId('correction-reason-input').fill('B 页调增');
  await pageB.getByTestId('correct-capacity-button').click();
  await expect(pageB.getByTestId('detail-remaining')).toHaveText('7');

  // A 自动同步：有效容量 15、剩余 7（已用 8 不变），历史余量快照仍是 2
  await expect(pageA.getByTestId('detail-effective')).toHaveText('15');
  await expect(pageA.getByTestId('detail-remaining')).toHaveText('7');
  await expect(pageA.getByTestId('batch-remaining')).toHaveText('7');
  await expect(pageA.getByTestId('correction-item')).toHaveCount(1);
  await expect(pageA.getByTestId('usage-remaining')).toHaveText('2');

  // A 在新容量下登记 7 恰好耗尽：新记录 remainingAfter 为 0（15−8−7）
  await pageA.getByTestId('films-input').fill('7');
  await pageA.getByTestId('record-usage-button').click();
  await expect(pageA.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(pageA.getByTestId('usage-remaining').nth(1)).toHaveText('0');
  // 早期记录余量仍是 2，没有被最终容量反验成别的值
  await expect(pageA.getByTestId('usage-remaining').first()).toHaveText('2');

  // B 自动同步为耗尽；两页刷新后一致
  await expect(pageB.getByTestId('batch-status')).toHaveText('已耗尽');
  for (const page of [pageA, pageB]) {
    await page.reload();
    await page.getByTestId('nav-ledger').click();
    await expect(page.getByTestId('batch-effective')).toHaveText('15');
    await expect(page.getByTestId('batch-remaining')).toHaveText('0');
    await page.getByTestId('batch-item').click();
    await expect(page.getByTestId('usage-remaining').first()).toHaveText('2');
    await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');
  }
  await context.close();
});

test('写入失败：更正只拒绝本次动作，不虚增余量、不产生凭证，存储原文不变，恢复后可重试', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await seedBatch(page, 10);
  await gotoLedger(page);
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('detail-effective')).toHaveText('10');

  await makeLedgerWritesFail(page);
  await page.getByTestId('correction-capacity-input').fill('30');
  await page.getByTestId('correction-reason-input').fill('大调增');
  await page.getByTestId('correct-capacity-button').click();

  await expect(page.getByTestId('ledger-error')).toContainText(/保存失败|存储/);
  // 不显示虚假的新增余量：有效容量与剩余仍是 10，凭证不出现
  await expect(page.getByTestId('detail-effective')).toHaveText('10');
  await expect(page.getByTestId('detail-remaining')).toHaveText('10');
  await expect(page.getByTestId('correction-item')).toHaveCount(0);
  // 草稿保留
  await expect(page.getByTestId('correction-capacity-input')).toHaveValue('30');

  // 存储原文（revision 1、无凭证）不变
  const raw = await readRaw(page);
  expect(raw?.revision).toBe(1);
  expect(raw?.corrections ?? []).toHaveLength(0);

  // 刷新：仍是旧台账
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-effective')).toHaveText('10');
  await expect(page.getByTestId('batch-remaining')).toHaveText('10');

  // 新页面（无补丁）重试同一更正 → 成功
  const page2 = await context.newPage();
  await gotoLedger(page2);
  await page2.getByTestId('batch-item').click();
  await page2.getByTestId('correction-capacity-input').fill('30');
  await page2.getByTestId('correction-reason-input').fill('大调增');
  await page2.getByTestId('correct-capacity-button').click();
  await expect(page2.getByTestId('detail-effective')).toHaveText('30');
  await expect(page2.getByTestId('detail-remaining')).toHaveText('30');
  await context.close();
});

test('含更正凭证的损坏存档（拿最终容量反验早期记录）视为不可信、不写回', async ({ browser }) => {
  // 容量 10，登记 9 的真实早期余量应为 1；随后凭证 10→9。
  // 这里把早期 remainingAfter 篡改成 0（用最终容量 9 反推），轨迹矛盾。
  const corrupted = JSON.stringify({
    batches: [{ id: BATCH_A_ID, name: '矛盾批次', capacity: 10, createdAt: '2026-10-01T08:00:00.000Z' }],
    records: [
      { id: 'r1', batchId: BATCH_A_ID, films: 9, note: '', remainingAfter: 0, createdAt: '2026-10-01T09:00:00.000Z' },
    ],
    corrections: [
      {
        id: 'c1',
        batchId: BATCH_A_ID,
        previousCapacity: 10,
        newCapacity: 9,
        reason: '调减',
        seq: 2,
        createdAt: '2026-10-01T10:00:00.000Z',
      },
    ],
    revision: 3,
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    [LEDGER_STORAGE_KEY, corrupted] as const,
  );
  await gotoLedger(page);

  // 损坏提示、无可写批次
  await expect(page.getByTestId('ledger-error')).toBeVisible();
  await expect(page.getByTestId('batch-item')).toHaveCount(0);
  await expect(page.getByTestId('usage-panel')).toHaveCount(0);

  // 尝试更正 / 创建都被拒，原文不被覆盖
  await page.getByTestId('batch-name-input').fill('不应创建');
  await page.getByTestId('batch-capacity-input').fill('5');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(0);
  const raw = await page.evaluate((key) => window.localStorage.getItem(key), LEDGER_STORAGE_KEY);
  expect(raw).toBe(corrupted);
  await context.close();
});
