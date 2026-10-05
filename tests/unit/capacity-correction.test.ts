import { describe, expect, it } from 'vitest';
import {
  batchCorrections,
  batchStatus,
  correctCapacity,
  createBatch,
  effectiveCapacity,
  EMPTY_LEDGER,
  hasConsistentCapacityTrajectory,
  recordUsage,
  remainingCapacity,
  usedCapacity,
  validateCorrectionReason,
  validateNewCapacityInput,
  type CapacityCorrection,
  type LedgerDeps,
  type LedgerState,
} from '../../src/lib/capacityLedger';

/** 确定性依赖：时间逐秒递增，id 递增，便于断言与复现。 */
function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 9, 5, 12, 0, 0) + counter * 1000);
    },
    nextId: () => `test-id-${counter}`,
  };
}

function mustCreate(state: LedgerState, name: string, capacity: string, deps: LedgerDeps) {
  const result = createBatch(state, { name, capacity }, deps);
  if (!result.ok) throw new Error(`测试前置创建批次失败：${result.error}`);
  return result;
}

function mustRecord(state: LedgerState, batchId: string, films: string, deps: LedgerDeps) {
  const result = recordUsage(state, { batchId, films }, deps);
  if (!result.ok) throw new Error(`测试前置登记失败：${result.error}`);
  return result;
}

function mustCorrect(state: LedgerState, batchId: string, newCapacity: string, reason: string, deps: LedgerDeps) {
  const result = correctCapacity(state, { batchId, newCapacity, reason }, deps);
  if (!result.ok) throw new Error(`测试前置更正失败：${result.error}`);
  return result;
}

describe('容量更正：字段校验', () => {
  it('新有效容量为空、非整数、非正整数或超出安全整数范围时分别说明原因', () => {
    const cases: Array<[string, string]> = [
      ['', '请输入新有效容量'],
      ['abc', '新有效容量必须为整数，不能含小数或字母'],
      ['2.5', '新有效容量必须为整数，不能含小数或字母'],
      ['0', '新有效容量须为大于 0 的整数'],
      ['-3', '新有效容量须为大于 0 的整数'],
      ['9'.repeat(400), '数值过大，无法精确记录，请填写较小的整数'],
      [String(2 ** 53 + 1), '数值过大，无法精确记录，请填写较小的整数'],
    ];
    for (const [raw, message] of cases) {
      expect(validateNewCapacityInput(raw)).toBe(message);
    }
    expect(validateNewCapacityInput('16')).toBeUndefined();
  });

  it('更正原因为空（含纯空白）时拒绝', () => {
    expect(validateCorrectionReason('')).toBe('请输入更正原因');
    expect(validateCorrectionReason('   ')).toBe('请输入更正原因');
    expect(validateCorrectionReason('建档容量写错')).toBeUndefined();
  });
});

describe('correctCapacity 命令', () => {
  it('调增：创建容量保持原样，新有效容量生效，后续余量与新记录按新容量计算', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    // 先登记 6（旧容量下剩余 4）
    const afterUsage = mustRecord(created.state, created.value.id, '6', deps).state;

    const corrected = correctCapacity(
      afterUsage,
      { batchId: created.value.id, newCapacity: '16', reason: '  建档时少写了 6 卷  ' },
      deps,
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;

    // 凭证字段完整：批次、原值、新值、原因（去空白）、提交顺序、阶段锚点
    const voucher = corrected.value;
    expect(voucher.batchId).toBe(created.value.id);
    expect(voucher.fromCapacity).toBe(10);
    expect(voucher.toCapacity).toBe(16);
    expect(voucher.reason).toBe('建档时少写了 6 卷');
    expect(voucher.sequence).toBe(1);
    expect(voucher.recordsBefore).toBe(1);
    expect(Object.isFrozen(voucher)).toBe(true);

    const next = corrected.state;
    // 创建容量与批次对象原样保留
    expect(next.batches[0].capacity).toBe(10);
    expect(next.batches[0]).toBe(afterUsage.batches[0]);
    // 历史记录的 remainingAfter 不被重写（仍是旧容量下的 4）
    expect(next.records[0].remainingAfter).toBe(4);
    expect(next.records[0]).toBe(afterUsage.records[0]);
    // 有效容量与剩余按新容量：16 − 6 = 10
    expect(effectiveCapacity(next, next.batches[0])).toBe(16);
    expect(usedCapacity(next, created.value.id)).toBe(6);
    expect(remainingCapacity(next.batches[0], next)).toBe(10);
    expect(batchStatus(next.batches[0], next)).toBe('active');

    // 后续登记按最新有效容量计算余量
    const more = mustRecord(next, created.value.id, '10', deps).state;
    expect(more.records[1].remainingAfter).toBe(0);
    expect(remainingCapacity(more.batches[0], more)).toBe(0);
    expect(batchStatus(more.batches[0], more)).toBe('exhausted');
    // 旧容量下这一步本会超额：命令必须按新容量放行
    expect(more.records).toHaveLength(2);
  });

  it('调减边界：新容量恰好等于已登记用量时允许（剩余 0），再低则拒绝', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '20', deps);
    const afterUsage = mustRecord(created.state, created.value.id, '8', deps).state;
    expect(remainingCapacity(created.value, afterUsage)).toBe(12);

    // 调到 8 = 已登记用量：边界允许，剩余 0，状态转耗尽
    const boundary = correctCapacity(
      afterUsage,
      { batchId: created.value.id, newCapacity: '8', reason: '建档时多写' },
      deps,
    );
    expect(boundary.ok).toBe(true);
    if (!boundary.ok) return;
    expect(boundary.value.toCapacity).toBe(8);
    expect(boundary.value.fromCapacity).toBe(20);
    expect(remainingCapacity(boundary.state.batches[0], boundary.state)).toBe(0);
    expect(batchStatus(boundary.state.batches[0], boundary.state)).toBe('exhausted');

    // 再低（7 < 已登记 8）拒绝：不写入凭证，余量不变化
    const tooLow = correctCapacity(
      boundary.state,
      { batchId: created.value.id, newCapacity: '7', reason: '再降' },
      deps,
    );
    expect(tooLow.ok).toBe(false);
    if (!tooLow.ok) {
      expect(tooLow.error).toBe('新有效容量不得低于该批已登记用量 8，否则历史记录将超额');
    }
    expect(boundary.state.corrections).toHaveLength(1);
    expect(effectiveCapacity(boundary.state, boundary.state.batches[0])).toBe(8);

    // 耗尽批次仍可凭更正调增恢复使用
    const raised = correctCapacity(
      boundary.state,
      { batchId: created.value.id, newCapacity: '12', reason: '重新核定' },
      deps,
    );
    expect(raised.ok).toBe(true);
    if (!raised.ok) return;
    expect(remainingCapacity(raised.state.batches[0], raised.state)).toBe(4);
    expect(batchStatus(raised.state.batches[0], raised.state)).toBe('active');
  });

  it('多次更正：序号连续、容量链相扣、阶段锚点随记录数推进，历史 remainingAfter 原样保留', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    let state = mustRecord(created.state, created.value.id, '4', deps).state;
    // r1 在容量 10 下：remainingAfter 6
    expect(state.records[0].remainingAfter).toBe(6);

    // 更正 1：10 → 12（此时已有 1 条记录）
    state = mustCorrect(state, created.value.id, '12', '调增', deps).state;
    state = mustRecord(state, created.value.id, '3', deps).state;
    // r2 在容量 12 下：12 − 4 − 3 = 5
    expect(state.records[1].remainingAfter).toBe(5);

    // 更正 2：12 → 9（此时已有 2 条记录，已用 7 ≤ 9）
    state = mustCorrect(state, created.value.id, '9', '调减', deps).state;
    state = mustRecord(state, created.value.id, '2', deps).state;
    // r3 在容量 9 下：9 − 7 − 2 = 0
    expect(state.records[2].remainingAfter).toBe(0);

    const vouchers = batchCorrections(state, created.value.id);
    expect(vouchers.map((v) => [v.sequence, v.fromCapacity, v.toCapacity, v.recordsBefore])).toEqual([
      [1, 10, 12, 1],
      [2, 12, 9, 2],
    ]);
    expect(effectiveCapacity(state, state.batches[0])).toBe(9);
    expect(remainingCapacity(state.batches[0], state)).toBe(0);
    // 三条历史记录的 remainingAfter 分属三个阶段，均保持写入时的值
    expect(state.records.map((r) => r.remainingAfter)).toEqual([6, 5, 0]);
    expect(hasConsistentCapacityTrajectory(state)).toBe(true);
  });

  it('无使用记录时更正：首张凭证 fromCapacity 为创建容量，锚点为 0', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const corrected = mustCorrect(created.state, created.value.id, '14', '空批更正', deps);
    expect(corrected.value.sequence).toBe(1);
    expect(corrected.value.fromCapacity).toBe(10);
    expect(corrected.value.recordsBefore).toBe(0);
    expect(remainingCapacity(corrected.state.batches[0], corrected.state)).toBe(14);
  });

  it('批次不存在、原因为空、容量非法时拒绝且不写入凭证', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);

    expect(correctCapacity(created.state, { batchId: 'ghost', newCapacity: '12', reason: 'x' }, deps).ok).toBe(false);
    const noReason = correctCapacity(
      created.state,
      { batchId: created.value.id, newCapacity: '12', reason: '   ' },
      deps,
    );
    expect(noReason.ok).toBe(false);
    if (!noReason.ok) expect(noReason.error).toBe('请输入更正原因');

    const badCapacity = correctCapacity(
      created.state,
      { batchId: created.value.id, newCapacity: '0', reason: 'x' },
      deps,
    );
    expect(badCapacity.ok).toBe(false);
    if (!badCapacity.ok) expect(badCapacity.error).toBe('新有效容量须为大于 0 的整数');

    expect(created.state.corrections).toEqual([]);
  });

  it('凭证不可修改、命令不修改传入状态：再更正基于新状态，旧凭证不被触碰', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const first = mustCorrect(created.state, created.value.id, '12', '第一次', deps);
    expect(() => {
      (first.value as CapacityCorrection).toCapacity = 99;
    }).toThrow(TypeError);
    expect(created.state.corrections).toHaveLength(0);

    const second = mustCorrect(first.state, created.value.id, '15', '第二次', deps);
    expect(second.state.corrections[0]).toBe(first.value);
    expect(second.state.corrections).toHaveLength(2);
    expect(first.state.corrections).toHaveLength(1);
  });

  it('多批次更正互不影响：凭证按批次编号与归属，各自有效容量独立推导', () => {
    const deps = testDeps();
    const a = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const b = mustCreate(a.state, '定影液', '5', deps);
    let state = b.state;
    state = mustRecord(state, a.value.id, '4', deps).state;
    state = mustCorrect(state, a.value.id, '12', 'A 调增', deps).state;
    state = mustCorrect(state, b.value.id, '8', 'B 调增', deps).state;

    const vouchersA = batchCorrections(state, a.value.id);
    const vouchersB = batchCorrections(state, b.value.id);
    expect(vouchersA).toHaveLength(1);
    expect(vouchersB).toHaveLength(1);
    expect(vouchersA[0].sequence).toBe(1);
    expect(vouchersB[0].sequence).toBe(1);
    expect(remainingCapacity(state.batches[0], state)).toBe(8); // 12 − 4
    expect(remainingCapacity(state.batches[1], state)).toBe(8); // 8 − 0
  });
});

describe('分阶段容量轨迹重放（hasConsistentCapacityTrajectory）', () => {
  function correction(
    partial: Partial<CapacityCorrection> & { batchId: string },
  ): CapacityCorrection {
    return {
      id: `c-${partial.sequence ?? 1}`,
      fromCapacity: 10,
      toCapacity: 12,
      reason: '手工构造',
      sequence: 1,
      recordsBefore: 0,
      createdAt: '2026-09-02T12:00:00.000Z',
      ...partial,
    };
  }

  function batch(id: string, capacity: number) {
    return { id, name: `批次 ${id}`, capacity, createdAt: '2026-09-01T08:00:00.000Z' };
  }

  function record(id: string, batchId: string, films: number, remainingAfter: number, createdAt?: string) {
    return {
      id,
      batchId,
      films,
      note: '',
      remainingAfter,
      createdAt: createdAt ?? '2026-09-02T09:00:00.000Z',
    };
  }

  it('命令产出的「更正前记录 + 更正后记录」状态恒可信', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    let state = mustRecord(created.state, created.value.id, '4', deps).state;
    state = mustCorrect(state, created.value.id, '12', '调增', deps).state;
    state = mustRecord(state, created.value.id, '8', deps).state;
    expect(hasConsistentCapacityTrajectory(state)).toBe(true);
  });

  it('不能拿最终容量反验早期记录：r1 按旧容量 10 重放为 6，即使最终容量 12 也合法', () => {
    // 这是本次需求的核心反例：若用最终容量 12 反验，r1 应剩 8，会被误判为矛盾。
    const state: LedgerState = {
      batches: [batch('b1', 10)],
      records: [
        record('r1', 'b1', 4, 6, '2026-09-02T09:00:00.000Z'),
        record('r2', 'b1', 4, 4, '2026-09-04T09:00:00.000Z'),
      ],
      corrections: [
        correction({
          batchId: 'b1',
          sequence: 1,
          fromCapacity: 10,
          toCapacity: 12,
          recordsBefore: 1,
          createdAt: '2026-09-03T09:00:00.000Z',
        }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(state)).toBe(true);
  });

  it('早期记录若被改成符合最终容量（8）反而不符合所处阶段（10 − 4 = 6），不可信', () => {
    const state: LedgerState = {
      batches: [batch('b1', 10)],
      records: [
        record('r1', 'b1', 4, 8, '2026-09-02T09:00:00.000Z'),
        record('r2', 'b1', 4, 4, '2026-09-04T09:00:00.000Z'),
      ],
      corrections: [
        correction({
          batchId: 'b1',
          sequence: 1,
          fromCapacity: 10,
          toCapacity: 12,
          recordsBefore: 1,
          createdAt: '2026-09-03T09:00:00.000Z',
        }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(state)).toBe(false);
  });

  it('调减凭证让阶段容量下降：更正后的记录按新低容量重放，超额记录不可信', () => {
    // r1: 10 − 4 = 6；更正 10 → 6（已用 4 ≤ 6）；r2 登记 3：6 − 4 − 3 = −1 超额
    const state: LedgerState = {
      batches: [batch('b1', 10)],
      records: [
        record('r1', 'b1', 4, 6),
        record('r2', 'b1', 3, -1),
      ],
      corrections: [
        correction({ batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 6, recordsBefore: 1 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(state)).toBe(false);
  });

  it('新容量低于已登记用量的凭证不可信（阶段末尾容量不足以覆盖历史用量）', () => {
    // 已用 8，凭证把容量降到 7：历史记录本身不动，但新容量低于已登记用量
    const state: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 2)],
      corrections: [
        correction({ batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 7, recordsBefore: 1 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(state)).toBe(false);
  });

  it('容量链断裂（fromCapacity 与链上前一容量不符）不可信', () => {
    const base = {
      batches: [batch('b1', 10)],
      records: [],
    };
    const broken: LedgerState = {
      ...base,
      corrections: [
        correction({ batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 12, recordsBefore: 0 }),
        // 第二张声称从 10 改到 15，但链上前一容量是 12
        correction({ batchId: 'b1', sequence: 2, fromCapacity: 10, toCapacity: 15, recordsBefore: 0 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(broken)).toBe(false);
  });

  it('序号缺号 / 重复不可信', () => {
    const base = { batches: [batch('b1', 10)], records: [] as LedgerState['records'] };
    const gap: LedgerState = {
      ...base,
      corrections: [
        correction({ batchId: 'b1', sequence: 2, fromCapacity: 10, toCapacity: 12, recordsBefore: 0 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(gap)).toBe(false);
    const dup: LedgerState = {
      ...base,
      corrections: [
        correction({ id: 'c1', batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 12, recordsBefore: 0 }),
        correction({ id: 'c2', batchId: 'b1', sequence: 1, fromCapacity: 12, toCapacity: 15, recordsBefore: 0 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(dup)).toBe(false);
  });

  it('阶段锚点倒插（后一张凭证的 recordsBefore 更小）或越界不可信', () => {
    const records = [record('r1', 'b1', 2, 8), record('r2', 'b1', 2, 6)];
    const backwards: LedgerState = {
      batches: [batch('b1', 10)],
      records,
      corrections: [
        correction({ id: 'c1', batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 12, recordsBefore: 2 }),
        correction({ id: 'c2', batchId: 'b1', sequence: 2, fromCapacity: 12, toCapacity: 14, recordsBefore: 1 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(backwards)).toBe(false);

    const outOfRange: LedgerState = {
      batches: [batch('b1', 10)],
      records,
      corrections: [
        correction({ id: 'c1', batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 12, recordsBefore: 3 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(outOfRange)).toBe(false);
  });

  it('凭证挂在未知批次上、字段非法、原因为空时不可信', () => {
    const ghost: LedgerState = {
      batches: [batch('b1', 10)],
      records: [],
      corrections: [correction({ id: 'c1', batchId: 'ghost', sequence: 1, fromCapacity: 10, toCapacity: 12 })],
    };
    expect(hasConsistentCapacityTrajectory(ghost)).toBe(false);

    const badReason: LedgerState = {
      batches: [batch('b1', 10)],
      records: [],
      corrections: [
        correction({
          id: 'c1',
          batchId: 'b1',
          sequence: 1,
          fromCapacity: 10,
          toCapacity: 12,
          reason: '   ',
        }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(badReason)).toBe(false);

    const nonPositive: LedgerState = {
      batches: [batch('b1', 10)],
      records: [],
      corrections: [
        correction({ id: 'c1', batchId: 'b1', sequence: 1, fromCapacity: 10, toCapacity: 0 }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(nonPositive)).toBe(false);
  });

  it('跨批次交错：凭证只影响本批阶段，另一批仍按创建容量重放', () => {
    const state: LedgerState = {
      batches: [batch('b1', 10), batch('b2', 5)],
      records: [
        record('r1', 'b1', 4, 6, '2026-09-02T09:00:00.000Z'),
        record('r2', 'b2', 2, 3, '2026-09-02T10:00:00.000Z'),
        record('r3', 'b1', 6, 0, '2026-09-04T09:00:00.000Z'),
      ],
      corrections: [
        // b1 在 r1 之后由 10 调到 12，r3 按 12 重放：12 − 4 − 6 = 2，写 0 不合法
        correction({
          id: 'c1',
          batchId: 'b1',
          sequence: 1,
          fromCapacity: 10,
          toCapacity: 12,
          recordsBefore: 1,
          createdAt: '2026-09-03T09:00:00.000Z',
        }),
      ],
    };
    expect(hasConsistentCapacityTrajectory(state)).toBe(false);

    const fixed: LedgerState = {
      ...state,
      records: [
        record('r1', 'b1', 4, 6, '2026-09-02T09:00:00.000Z'),
        record('r2', 'b2', 2, 3, '2026-09-02T10:00:00.000Z'),
        record('r3', 'b1', 6, 2, '2026-09-04T09:00:00.000Z'),
      ],
    };
    expect(hasConsistentCapacityTrajectory(fixed)).toBe(true);
  });
});
