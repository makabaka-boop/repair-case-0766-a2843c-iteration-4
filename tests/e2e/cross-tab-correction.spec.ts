import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 容量更正凭证的端到端验收（含双标签并发）。
 *
 * 覆盖：调增（含过期页面冲突与刷新同步）、调减边界（= 已登记用量）、
 * 多次更正（分阶段历史余量不被重写、存档按阶段重放恢复）、
 * 写入失败回滚（不显示虚假新增余量）、旧档（无更正凭证）兼容。
 */

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

/** 让目标页面随后所有台账写入都抛错（模拟配额 / 安全策略拒绝）。 */
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

/** 屏蔽目标页面收到的台账 storage 事件（确定性复现交错提交）。 */
async function blockStorageSync(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const w = window as Window & { __blockLedgerEvents?: boolean };
    w.__blockLedgerEvents = true;
    window.addEventListener(
      'storage',
      (event) => {
        if (w.__blockLedgerEvents && event.key === key) {
          event.stopImmediatePropagation();
        }
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
          records: Array<{ films: number; remainingAfter: number }>;
          corrections: Array<{ fromCapacity: number; toCapacity: number; sequence: number; reason: string }>;
          batches: Array<{ capacity: number }>;
        })
      : null;
  }, LEDGER_STORAGE_KEY);
}

/** 在页面上创建批次并登记用量（均经真实界面提交）。 */
async function createBatchWithUsage(page: Page, name: string, capacity: string, films?: string) {
  await page.getByTestId('batch-name-input').fill(name);
  await page.getByTestId('batch-capacity-input').fill(capacity);
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
  if (films) {
    await page.getByTestId('films-input').fill(films);
    await page.getByTestId('record-usage-button').click();
  }
}

test('调增：更正后余量与后续登记按新容量计算，创建容量与历史 remainingAfter 保持原样', async ({ page }) => {
  await gotoLedger(page);
  await createBatchWithUsage(page, 'D-76 显影液', '10', '4');
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');
  await expect(page.getByTestId('detail-created-capacity')).toHaveText('10');
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('10');

  // 更正 10 → 16
  await page.getByTestId('new-capacity-input').fill('16');
  await page.getByTestId('correction-reason-input').fill('建档时少写了 6 卷');
  await page.getByTestId('correct-capacity-button').click();

  // 凭证落账：有效容量 16、剩余 12；创建容量仍为 10
  await expect(page.getByTestId('detail-created-capacity')).toHaveText('10');
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('16');
  await expect(page.getByTestId('detail-remaining')).toHaveText('12');
  await expect(page.getByTestId('batch-capacity')).toHaveText('16');
  await expect(page.getByTestId('batch-capacity-corrected')).toContainText('创建 10');

  // 凭证明细
  await expect(page.getByTestId('correction-item')).toHaveCount(1);
  await expect(page.getByTestId('correction-sequence')).toHaveText('第 1 次更正');
  await expect(page.getByTestId('correction-from')).toHaveText('10');
  await expect(page.getByTestId('correction-to')).toHaveText('16');
  await expect(page.getByTestId('correction-reason')).toContainText('建档时少写了 6 卷');

  // 历史记录的 remainingAfter 仍是旧阶段的 6，不被重写
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 后续登记按新容量：再记 10（累计 14 / 16，剩余 2；旧容量下这是超额操作）
  await page.getByTestId('films-input').fill('10');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-status')).toHaveText('使用中');
  await expect(page.getByTestId('detail-remaining')).toHaveText('2');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('2');
  await expect(page.getByTestId('usage-remaining').first()).toHaveText('6');

  // 刷新：存档按阶段重放，历史 6 / 2 与有效容量 16 完整还原
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-status')).toHaveText('使用中');
  await expect(page.getByTestId('batch-used')).toHaveText('14');
  await expect(page.getByTestId('batch-remaining')).toHaveText('2');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('detail-created-capacity')).toHaveText('10');
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('16');
  await expect(page.getByTestId('usage-remaining').first()).toHaveText('6');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('2');
  await expect(page.getByTestId('correction-to')).toHaveText('16');
});

test('调减边界：新容量 = 已登记用量时允许并转耗尽；再低被就地拒绝；字段非法不产生凭证', async ({ page }) => {
  await gotoLedger(page);
  await createBatchWithUsage(page, '调减批次', '20', '8');
  await expect(page.getByTestId('detail-remaining')).toHaveText('12');

  // 低于已登记用量（7 < 8）：就地拒绝，余量不变、无凭证
  await page.getByTestId('new-capacity-input').fill('7');
  await page.getByTestId('correction-reason-input').fill('调低');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-new-capacity')).toContainText('不得低于该批已登记用量 8');
  await expect(page.getByTestId('correction-item')).toHaveCount(0);
  await expect(page.getByTestId('detail-remaining')).toHaveText('12');

  // 空原因：就地拒绝
  await page.getByTestId('new-capacity-input').fill('8');
  await page.getByTestId('correction-reason-input').fill('');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-correction-reason')).toHaveText('请输入更正原因');
  await expect(page.getByTestId('correction-item')).toHaveCount(0);

  // 非正整数：就地拒绝
  await page.getByTestId('new-capacity-input').fill('0');
  await page.getByTestId('correction-reason-input').fill('调低');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-new-capacity')).toHaveText('新有效容量须为大于 0 的整数');
  await expect(page.getByTestId('correction-item')).toHaveCount(0);

  // 边界 8 = 已登记用量：允许，剩余 0、状态耗尽
  await page.getByTestId('new-capacity-input').fill('8');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-new-capacity')).toHaveCount(0);
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('8');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('correction-item')).toHaveCount(1);

  // 耗尽批次再登记被拒
  await page.getByTestId('films-input').fill('1');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toContainText('本批仅剩 0');

  // 调增恢复后又可继续登记
  await page.getByTestId('new-capacity-input').fill('12');
  await page.getByTestId('correction-reason-input').fill('重新核定');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('detail-status')).toHaveText('使用中');
  await expect(page.getByTestId('detail-remaining')).toHaveText('4');
  await page.getByTestId('films-input').fill('4');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
});

test('多次更正：序号连续、分阶段历史余量原样保留，刷新按凭证与用量顺序重放', async ({ page }) => {
  await gotoLedger(page);
  await createBatchWithUsage(page, '多次更正批次', '10', '4');
  // r1（容量 10）：剩余 6
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 更正 1：10 → 12
  await page.getByTestId('new-capacity-input').fill('12');
  await page.getByTestId('correction-reason-input').fill('第一次调增');
  await page.getByTestId('correct-capacity-button').click();

  // r2（容量 12）：12 − 4 − 3 = 5
  await page.getByTestId('films-input').fill('3');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('5');

  // 更正 2：12 → 9（已用 7 ≤ 9）
  await page.getByTestId('new-capacity-input').fill('9');
  await page.getByTestId('correction-reason-input').fill('第二次调减');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('9');
  await expect(page.getByTestId('detail-remaining')).toHaveText('2');

  // r3（容量 9）：9 − 7 − 2 = 0
  await page.getByTestId('films-input').fill('2');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('usage-remaining').nth(2)).toHaveText('0');

  // 两条凭证按序号列出，容量链 10→12→9
  await expect(page.getByTestId('correction-item')).toHaveCount(2);
  await expect(page.getByTestId('correction-sequence').first()).toHaveText('第 1 次更正');
  await expect(page.getByTestId('correction-sequence').nth(1)).toHaveText('第 2 次更正');
  await expect(page.getByTestId('correction-from').nth(1)).toHaveText('12');
  await expect(page.getByTestId('correction-to').nth(1)).toHaveText('9');

  // 刷新：阶段重放恢复——三个阶段的历史余量 [6, 5, 0] 均不变
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('usage-remaining').first()).toHaveText('6');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('5');
  await expect(page.getByTestId('usage-remaining').nth(2)).toHaveText('0');
  await expect(page.getByTestId('detail-created-capacity')).toHaveText('10');
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('9');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('correction-item')).toHaveCount(2);

  const raw = await readRaw(page);
  expect(raw?.corrections.map((c) => [c.sequence, c.fromCapacity, c.toCapacity])).toEqual([
    [1, 10, 12],
    [2, 12, 9],
  ]);
  expect(raw?.records.map((r) => r.remainingAfter)).toEqual([6, 5, 0]);
});

test('双页签：一页更正后，过期页面的更正被冲突拒绝且无虚假余量；刷新同步后可继续，写入失败只拒绝本次', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  await gotoLedger(pageA);
  await createBatchWithUsage(pageA, '双页签批次', '10', '4'); // 剩余 6

  const pageB = await context.newPage();
  await blockStorageSync(pageB);
  await gotoLedger(pageB);
  await pageB.getByTestId('batch-item').click();
  await expect(pageB.getByTestId('detail-remaining')).toHaveText('6');

  // A 页调增到 16
  await pageA.getByTestId('new-capacity-input').fill('16');
  await pageA.getByTestId('correction-reason-input').fill('A 页更正');
  await pageA.getByTestId('correct-capacity-button').click();
  await expect(pageA.getByTestId('detail-effective-capacity')).toHaveText('16');
  await expect(pageA.getByTestId('detail-remaining')).toHaveText('12');

  // B 页用过期状态更正到 20：冲突拒绝，不出现 16/20 的虚假余量变化，视图对齐为 16
  await pageB.getByTestId('new-capacity-input').fill('20');
  await pageB.getByTestId('correction-reason-input').fill('B 页过期更正');
  await pageB.getByTestId('correct-capacity-button').click();
  await expect(pageB.getByTestId('ledger-error')).toContainText('容量更正未写入');
  await expect(pageB.getByTestId('correction-item')).toHaveCount(1);
  await expect(pageB.getByTestId('correction-reason')).toContainText('A 页更正');
  await expect(pageB.getByTestId('detail-effective-capacity')).toHaveText('16');
  await expect(pageB.getByTestId('detail-remaining')).toHaveText('12');
  // 草稿保留便于核对重试
  await expect(pageB.getByTestId('new-capacity-input')).toHaveValue('20');

  const rawAfterConflict = await readRaw(pageA);
  expect(rawAfterConflict?.corrections).toHaveLength(1);
  expect(rawAfterConflict?.corrections[0].toCapacity).toBe(16);

  // B 改为 18 后提交成功（基于刷新对齐后的最新台账）
  await pageB.getByTestId('new-capacity-input').fill('18');
  await pageB.getByTestId('correct-capacity-button').click();
  await expect(pageB.getByTestId('ledger-error')).toHaveCount(0);
  await expect(pageB.getByTestId('correction-item')).toHaveCount(2);
  await expect(pageB.getByTestId('detail-effective-capacity')).toHaveText('18');
  await expect(pageB.getByTestId('detail-remaining')).toHaveText('14');
  await unblockStorageSync(pageB);

  // A 经 storage 事件自动同步到第二张凭证
  await expect(pageA.getByTestId('correction-item')).toHaveCount(2);
  await expect(pageA.getByTestId('detail-effective-capacity')).toHaveText('18');
  await expect(pageA.getByTestId('detail-remaining')).toHaveText('14');

  // 写入失败：在 B 页让 setItem 抛错，更正只拒绝本次、不显示虚假余量
  await makeLedgerWritesFail(pageB);
  await pageB.getByTestId('new-capacity-input').fill('30');
  await pageB.getByTestId('correction-reason-input').fill('配额更正');
  await pageB.getByTestId('correct-capacity-button').click();
  await expect(pageB.getByTestId('ledger-error')).toContainText(/保存失败|存储/);
  await expect(pageB.getByTestId('detail-effective-capacity')).toHaveText('18');
  await expect(pageB.getByTestId('detail-remaining')).toHaveText('14');
  await expect(pageB.getByTestId('correction-item')).toHaveCount(2);

  // 原始存储未变（修订号与凭证数保持）
  const rawAfterFail = await readRaw(pageA);
  expect(rawAfterFail?.corrections).toHaveLength(2);
  expect(rawAfterFail?.corrections[1].toCapacity).toBe(18);

  // 刷新 B：恢复的仍是 18，没有容量 30 的幽灵凭证
  await pageB.reload();
  await pageB.getByTestId('nav-ledger').click();
  await expect(pageB.getByTestId('batch-capacity')).toHaveText('18');
  await expect(pageB.getByTestId('batch-remaining')).toHaveText('14');

  // 两页刷新后一致：创建容量 10、有效 18、历史余量 6
  for (const page of [pageA, pageB]) {
    await page.reload();
    await page.getByTestId('nav-ledger').click();
    await expect(page.getByTestId('batch-capacity')).toHaveText('18');
    await expect(page.getByTestId('batch-capacity-corrected')).toContainText('创建 10');
    await expect(page.getByTestId('batch-remaining')).toHaveText('14');
    await page.getByTestId('batch-item').click();
    await expect(page.getByTestId('usage-remaining')).toHaveText('6');
    await expect(page.getByTestId('correction-item')).toHaveCount(2);
  }
  await context.close();
});

test('旧档（无更正凭证）按原规则恢复：有效容量即创建容量，更正后刷新仍保留历史余量', async ({
  page,
}) => {
  // 预置一份无 corrections 字段的旧版台账（两批三条记录，轨迹一致）
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) window.localStorage.setItem(key, value);
    },
    [
      LEDGER_STORAGE_KEY,
      JSON.stringify({
        batches: [
          { id: 'legacy-dev', name: '旧版显影液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' },
          { id: 'legacy-fix', name: '旧版定影液', capacity: 5, createdAt: '2026-09-01T08:05:00.000Z' },
        ],
        records: [
          { id: 'r1', batchId: 'legacy-dev', films: 4, note: '', remainingAfter: 6, createdAt: '2026-09-02T09:00:00.000Z' },
          { id: 'r2', batchId: 'legacy-fix', films: 2, note: '', remainingAfter: 3, createdAt: '2026-09-02T10:00:00.000Z' },
        ],
      }),
    ] as const,
  );
  await gotoLedger(page);

  // 旧档正常恢复，无损坏提示，无凭证
  await expect(page.getByTestId('ledger-error')).toHaveCount(0);
  const items = page.getByTestId('batch-item');
  await expect(items).toHaveCount(2);
  await expect(items.first().getByTestId('batch-capacity')).toHaveText('10');
  await expect(items.first().getByTestId('batch-remaining')).toHaveText('6');
  await items.first().click();
  await expect(page.getByTestId('detail-created-capacity')).toHaveText('10');
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('10');
  await expect(page.getByTestId('correction-empty')).toBeVisible();
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 在旧档上调增显影液到 12：当前剩余变 8，历史记录 remainingAfter=6 不变
  await page.getByTestId('new-capacity-input').fill('12');
  await page.getByTestId('correction-reason-input').fill('旧档容量更正');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('detail-effective-capacity')).toHaveText('12');
  await expect(page.getByTestId('detail-remaining')).toHaveText('8');
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');
  await expect(page.getByTestId('correction-from')).toHaveText('10');
  await expect(page.getByTestId('correction-to')).toHaveText('12');

  // 刷新：凭证随旧档升级保存，按阶段重放恢复
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(items.first().getByTestId('batch-capacity')).toHaveText('12');
  await expect(items.first().getByTestId('batch-remaining')).toHaveText('8');
  await page.getByTestId('batch-item').first().click();
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');
  await expect(page.getByTestId('correction-item')).toHaveCount(1);
  await expect(page.getByTestId('correction-reason')).toContainText('旧档容量更正');

  const raw = await readRaw(page);
  expect(raw?.batches[0].capacity).toBe(10);
  expect(raw?.corrections).toHaveLength(1);
  expect(raw?.corrections[0]).toMatchObject({ fromCapacity: 10, toCapacity: 12, sequence: 1, recordsBefore: 1 });
});
