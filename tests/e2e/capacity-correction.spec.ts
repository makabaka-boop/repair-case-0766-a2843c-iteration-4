import { expect, test, type Page } from '@playwright/test';
import { LEDGER_STORAGE_KEY } from '../../src/lib/ledgerStorage';

/**
 * 容量更正凭证的端到端验收（单标签页 + 刷新恢复）。
 *
 * 覆盖：调增后按新余量登记、调减边界（恰好到已登记用量）、低于用量被拒、
 * 多次更正、历史 remainingAfter 不被重写、刷新后同一有效容量、
 * 非法输入就地拒绝、旧档（无 corrections）仍按原规则恢复后再更正。
 */

async function gotoLedger(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByTestId('nav-ledger').click();
}

async function createBatch(page: Page, name: string, capacity: string): Promise<void> {
  await page.getByTestId('batch-name-input').fill(name);
  await page.getByTestId('batch-capacity-input').fill(capacity);
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(1);
}

async function correct(page: Page, newCapacity: string, reason: string): Promise<void> {
  await page.getByTestId('correction-capacity-input').fill(newCapacity);
  await page.getByTestId('correction-reason-input').fill(reason);
  await page.getByTestId('correct-capacity-button').click();
}

async function seedArchive(page: Page, payload: string): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      if (window.localStorage.getItem(key) === null) {
        window.localStorage.setItem(key, value);
      }
    },
    [LEDGER_STORAGE_KEY, payload] as const,
  );
}

test('调增：追加凭证后按最新有效容量计算余量，建档容量与历史余量保持原样', async ({ page }) => {
  await gotoLedger(page);
  await createBatch(page, 'D-76 显影液', '10');

  // 先登记 4（旧阶段容量 10，余 6）
  await page.getByTestId('films-input').fill('4');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('6');
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 调增到 15
  await correct(page, '15', '额定容量误填为 10，实际可处理 15 卷');
  await expect(page.getByTestId('correction-item')).toHaveCount(1);
  await expect(page.getByTestId('correction-previous')).toHaveText('10');
  await expect(page.getByTestId('correction-new')).toHaveText('15');
  await expect(page.getByTestId('correction-reason')).toContainText('额定容量误填');
  await expect(page.getByTestId('detail-effective')).toHaveText('15');
  await expect(page.getByTestId('detail-remaining')).toHaveText('11');
  // 列表与详情共享同一有效容量
  await expect(page.getByTestId('batch-effective')).toHaveText('15');
  await expect(page.getByTestId('batch-remaining')).toHaveText('11');
  // 建档额定容量仍是 10，历史记录余量仍是 6
  await expect(page.getByTestId('detail-original-capacity')).toContainText('建档额定容量 10');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 调增出的新增余量可登记：再登记 11 恰好耗尽（4 + 11 = 15）
  await page.getByTestId('films-input').fill('11');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');

  // 刷新后：有效容量 15、建档容量 10、两条历史余量（6、0）逐项还原
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-effective')).toHaveText('15');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
  await expect(page.getByTestId('batch-remaining')).toHaveText('0');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('correction-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-remaining').first()).toHaveText('6');
  await expect(page.getByTestId('usage-remaining').nth(1)).toHaveText('0');
});

test('调减边界：新容量恰等于已登记用量则归零转已耗尽；低于用量被拒且不显示虚假余量', async ({
  page,
}) => {
  await gotoLedger(page);
  await createBatch(page, '定影液', '10');
  await page.getByTestId('films-input').fill('8');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('detail-remaining')).toHaveText('2');

  // 低于已登记用量 8 → 就地拒绝，不产生凭证、余量不变
  await correct(page, '7', '想调减到 7');
  await expect(page.getByTestId('error-correction-capacity')).toHaveText(
    '新有效容量不得低于该批已登记用量：已登记 8，无法更正为 7',
  );
  await expect(page.getByTestId('correction-item')).toHaveCount(0);
  await expect(page.getByTestId('detail-effective')).toHaveText('10');
  await expect(page.getByTestId('detail-remaining')).toHaveText('2');

  // 非正整数 / 空 / 非整数 / 空原因分别就地拒绝
  await page.getByTestId('correction-capacity-input').fill('0');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-correction-capacity')).toHaveText('新容量须为大于 0 的整数');
  await page.getByTestId('correction-capacity-input').fill('8.5');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-correction-capacity')).toHaveText(
    '新容量必须为整数，不能含小数或字母',
  );
  await page.getByTestId('correction-capacity-input').fill('9');
  await page.getByTestId('correction-reason-input').fill('   ');
  await page.getByTestId('correct-capacity-button').click();
  await expect(page.getByTestId('error-correction-reason')).toHaveText('请输入容量更正原因');
  await expect(page.getByTestId('correction-item')).toHaveCount(0);

  // 恰好下调到已登记用量 8：成功，余量 0、已耗尽，历史余量仍是 2
  await correct(page, '8', '复查后实际只能处理 8 卷');
  await expect(page.getByTestId('detail-effective')).toHaveText('8');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('detail-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('batch-status')).toHaveText('已耗尽');
  await expect(page.getByTestId('usage-remaining')).toHaveText('2');
  await expect(page.getByTestId('exhausted-note')).toBeVisible();

  // 已耗尽（新容量下）登记被拒
  await page.getByTestId('films-input').fill('1');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('error-films')).toContainText('本批仅剩 0');
  await expect(page.getByTestId('usage-item')).toHaveCount(1);

  // 刷新：边界状态与历史快照一致
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-effective')).toHaveText('8');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
  await expect(page.getByTestId('batch-remaining')).toHaveText('0');
});

test('多次更正：凭证逐张追加、有效容量沿凭证链变化，界面历史明细共享同一有效容量', async ({
  page,
}) => {
  await gotoLedger(page);
  await createBatch(page, '停显液', '10');

  await correct(page, '15', '第一次调增');
  await expect(page.getByTestId('detail-effective')).toHaveText('15');

  // 在 15 容量下登记 9，余 6
  await page.getByTestId('films-input').fill('9');
  await page.getByTestId('record-usage-button').click();
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 调减到 12（不低于已登记 9）
  await correct(page, '12', '第二次调减');
  await expect(page.getByTestId('detail-effective')).toHaveText('12');
  await expect(page.getByTestId('detail-remaining')).toHaveText('3');

  // 再调增到 20
  await correct(page, '20', '第三次调增');
  await expect(page.getByTestId('detail-effective')).toHaveText('20');
  await expect(page.getByTestId('detail-remaining')).toHaveText('11');
  await expect(page.getByTestId('batch-effective')).toHaveText('20');

  // 三张凭证按提交顺序列出，原值逐张衔接
  await expect(page.getByTestId('correction-item')).toHaveCount(3);
  await expect(page.getByTestId('correction-previous')).toHaveText(['10', '15', '12']);
  await expect(page.getByTestId('correction-new')).toHaveText(['15', '12', '20']);
  await expect(page.getByTestId('correction-change').first()).toContainText('凭证序号 1');
  // 历史使用记录余量保持登记当时快照（15−9=6），不随后续更正改变
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');

  // 与当前有效容量相同的更正被拒
  await correct(page, '20', '其实没变');
  await expect(page.getByTestId('error-correction-capacity')).toHaveText(
    '新有效容量与当前有效容量相同，无需更正',
  );
  await expect(page.getByTestId('correction-item')).toHaveCount(3);

  // 刷新后三张凭证、有效容量 20、历史余量 6 全部还原
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-effective')).toHaveText('20');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('correction-item')).toHaveCount(3);
  await expect(page.getByTestId('correction-new')).toHaveText(['15', '12', '20']);
  await expect(page.getByTestId('detail-remaining')).toHaveText('11');
  await expect(page.getByTestId('usage-remaining')).toHaveText('6');
});

test('切换批次时容量更正草稿被清空，不会误提到其他批次', async ({ page }) => {
  await gotoLedger(page);
  await createBatch(page, '批次 A', '10');
  await page.getByTestId('batch-name-input').fill('批次 B');
  await page.getByTestId('batch-capacity-input').fill('20');
  await page.getByTestId('create-batch-button').click();
  await expect(page.getByTestId('batch-item')).toHaveCount(2);

  // 当前选中 B，填写更正草稿但不提交
  await page.getByTestId('correction-capacity-input').fill('30');
  await page.getByTestId('correction-reason-input').fill('给 B 的更正');

  // 切到 A：草稿清空
  await page.getByTestId('batch-item').first().click();
  await expect(page.getByTestId('correction-capacity-input')).toHaveValue('');
  await expect(page.getByTestId('correction-reason-input')).toHaveValue('');
  await expect(page.getByTestId('correction-item')).toHaveCount(0);
});

test('旧档（无更正凭证）仍按原规则恢复，追加更正后历史余量不被重写', async ({ page }) => {
  // 旧版存档：容量 10、已登记 8（remainingAfter=2），无 corrections / revision
  const payload = JSON.stringify({
    batches: [{ id: 'legacy-b1', name: '旧版显影液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' }],
    records: [
      { id: 'r1', batchId: 'legacy-b1', films: 8, note: '旧记录', remainingAfter: 2, createdAt: '2026-09-02T09:00:00.000Z' },
    ],
  });
  await seedArchive(page, payload);
  await gotoLedger(page);

  // 旧档按原规则恢复：无凭证，有效容量 = 建档容量 10，余 2
  await expect(page.getByTestId('ledger-error')).toHaveCount(0);
  await expect(page.getByTestId('batch-effective')).toHaveText('10');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
  await expect(page.getByTestId('batch-remaining')).toHaveText('2');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('correction-item')).toHaveCount(0);
  await expect(page.getByTestId('usage-remaining')).toHaveText('2');

  // 追加调减到 8（恰好等于已登记用量）：历史余量 2 保持，新余量 0
  await correct(page, '8', '旧档复查后调减');
  await expect(page.getByTestId('detail-effective')).toHaveText('8');
  await expect(page.getByTestId('detail-remaining')).toHaveText('0');
  await expect(page.getByTestId('usage-remaining')).toHaveText('2');
  await expect(page.getByTestId('correction-previous')).toHaveText('10');
  await expect(page.getByTestId('correction-new')).toHaveText('8');

  // 刷新后一致：凭证存在、历史余量 2 未被最终容量反验重写
  await page.reload();
  await page.getByTestId('nav-ledger').click();
  await expect(page.getByTestId('batch-effective')).toHaveText('8');
  await expect(page.getByTestId('batch-capacity')).toHaveText('10');
  await page.getByTestId('batch-item').click();
  await expect(page.getByTestId('correction-item')).toHaveCount(1);
  await expect(page.getByTestId('usage-remaining')).toHaveText('2');
});
