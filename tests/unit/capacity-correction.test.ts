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
      return new Date(Date.UTC(2026, 8, 10, 12, 0, 0) + counter * 1000);
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

function mustCorrect(
  state: LedgerState,
  batchId: string,
  newCapacity: string,
  reason: string,
  deps: LedgerDeps,
) {
  const result = correctCapacity(state, { batchId, newCapacity, reason }, deps);
  if (!result.ok) throw new Error(`测试前置更正失败：${result.error}`);
  return result;
}

describe('correctCapacity 命令', () => {
  it('批次不存在时拒绝更正且不写入', () => {
    const deps = testDeps();
    const result = correctCapacity(
      EMPTY_LEDGER,
      { batchId: 'no-such-id', newCapacity: '20', reason: '误填' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('批次不存在或已被移除');
    expect(EMPTY_LEDGER.corrections ?? []).toHaveLength(0);
  });

  it('原因空（含纯空白）拒绝更正且不写入', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    for (const reason of ['', '   ']) {
      const result = correctCapacity(
        created.state,
        { batchId: created.value.id, newCapacity: '12', reason },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('请输入容量更正原因');
      expect(created.state.corrections ?? []).toHaveLength(0);
    }
  });

  it('新容量为空 / 非整数 / 非正整数 / 超出安全整数范围时分别说明原因且不写入', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const cases: Array<[string, string]> = [
      ['', '请输入新的有效容量'],
      ['12.5', '新容量必须为整数，不能含小数或字母'],
      ['abc', '新容量必须为整数，不能含小数或字母'],
      ['0', '新容量须为大于 0 的整数'],
      ['-4', '新容量须为大于 0 的整数'],
      ['9'.repeat(400), '数值过大，无法精确记录，请填写较小的整数'],
      [String(2 ** 53 + 1), '数值过大，无法精确记录，请填写较小的整数'],
    ];
    for (const [newCapacity, message] of cases) {
      const result = correctCapacity(
        created.state,
        { batchId: created.value.id, newCapacity, reason: '误填' },
        deps,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe(message);
      expect(created.state.corrections ?? []).toHaveLength(0);
      // 有效容量仍是创建容量，没有虚假新增余量
      expect(effectiveCapacity(created.value, created.state)).toBe(10);
      expect(remainingCapacity(created.value, created.state)).toBe(10);
    }
  });

  it('调增：追加凭证后有效容量变大、余量按新容量计算，创建容量不变', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;

    const result = correctCapacity(
      created.state,
      { batchId: batch.id, newCapacity: '15', reason: '  额定容量误填为 10  ' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const voucher = result.value;
    expect(voucher.batchId).toBe(batch.id);
    expect(voucher.previousCapacity).toBe(10);
    expect(voucher.newCapacity).toBe(15);
    expect(voucher.reason).toBe('额定容量误填为 10');
    expect(voucher.seq).toBe(1);
    expect(Object.isFrozen(voucher)).toBe(true);

    // 派生量：有效容量 15、剩余 15；创建容量仍是 10
    expect(effectiveCapacity(batch, result.state)).toBe(15);
    expect(remainingCapacity(batch, result.state)).toBe(15);
    expect(batch.capacity).toBe(10);
    expect(batchStatus(batch, result.state)).toBe('active');
    expect(batchCorrections(result.state, batch.id)).toEqual([voucher]);
    // 纯函数：传入状态不被修改
    expect(created.state.corrections ?? []).toHaveLength(0);
  });

  it('调减边界：新容量恰等于已登记用量时合法，余量归零并转已耗尽，之后登记被拒', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;
    const after8 = mustRecord(created.state, batch.id, '8', deps).state;
    expect(remainingCapacity(batch, after8)).toBe(2);

    // 恰好下调到已登记用量 8：边界合法
    const corrected = mustCorrect(after8, batch.id, '8', '复查后实际只能处理 8 卷', deps).state;
    expect(effectiveCapacity(batch, corrected)).toBe(8);
    expect(remainingCapacity(batch, corrected)).toBe(0);
    expect(batchStatus(batch, corrected)).toBe('exhausted');

    const rejected = recordUsage(corrected, { batchId: batch.id, films: '1' }, deps);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error).toBe('超过剩余容量：本批仅剩 0，无法登记 1');

    // 历史记录的 remainingAfter 是登记当时的快照（10−8=2），不被更正重写
    const history = corrected.records.filter((record) => record.batchId === batch.id);
    expect(history).toHaveLength(1);
    expect(history[0].remainingAfter).toBe(2);
  });

  it('调减低于已登记用量（用量侧边界−1）被拒绝：不写凭证、不改变有效容量与余量', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;
    const after8 = mustRecord(created.state, batch.id, '8', deps).state;

    const result = correctCapacity(
      after8,
      { batchId: batch.id, newCapacity: '7', reason: '想调减到 7' },
      deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('新有效容量不得低于该批已登记用量：已登记 8，无法更正为 7');
    }
    expect(after8.corrections ?? []).toHaveLength(0);
    expect(effectiveCapacity(batch, after8)).toBe(10);
    expect(remainingCapacity(batch, after8)).toBe(2);
  });

  it('新容量与当前有效容量相同（无变化更正）被拒绝，不产生空凭证', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const same = correctCapacity(
      created.state,
      { batchId: created.value.id, newCapacity: '10', reason: '其实没填错' },
      deps,
    );
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.error).toBe('新有效容量与当前有效容量相同，无需更正');
    expect(created.state.corrections ?? []).toHaveLength(0);
  });

  it('多次更正：逐张追加，有效容量沿凭证链变化，每张 originalCapacity 记录其签发阶段', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;

    // 10 → 15（此时无记录，seq 1）
    const up = mustCorrect(created.state, batch.id, '15', '调增', deps);
    // 登记 9（在 15 容量阶段，remainingAfter = 6），seq 占位：记录占 2
    const recorded = mustRecord(up.state, batch.id, '9', deps);
    // 15 → 12（已登记 9，合法；seq = 1 凭证 + 1 记录 + 1 = 3）
    const down = mustCorrect(recorded.state, batch.id, '12', '调减', deps);
    // 12 → 20（seq 4）
    const upAgain = mustCorrect(down.state, batch.id, '20', '再次调增', deps);

    const vouchers = batchCorrections(upAgain.state, batch.id);
    expect(vouchers.map((voucher) => [voucher.previousCapacity, voucher.newCapacity, voucher.seq])).toEqual([
      [10, 15, 1],
      [15, 12, 3],
      [12, 20, 4],
    ]);
    // 每张凭证的 previousCapacity 都是其签发阶段的有效容量，而非创建容量或最终容量
    expect(vouchers[1].previousCapacity).toBe(15);
    expect(vouchers[2].previousCapacity).toBe(12);
    expect(effectiveCapacity(batch, upAgain.state)).toBe(20);
    expect(usedCapacity(upAgain.state, batch.id)).toBe(9);
    expect(remainingCapacity(batch, upAgain.state)).toBe(11);

    // 历史记录 remainingAfter 保持登记当时快照 6（15−9），不随后续更正改变
    const history = upAgain.state.records.filter((record) => record.batchId === batch.id);
    expect(history[0].remainingAfter).toBe(6);
    expect(hasConsistentCapacityTrajectory(upAgain.state)).toBe(true);
  });

  it('凭证冻结不可改，且命令不修改传入状态', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const result = correctCapacity(
      created.state,
      { batchId: created.value.id, newCapacity: '12', reason: '误填' },
      deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(() => {
      (result.value as CapacityCorrection).newCapacity = 99;
    }).toThrow(TypeError);
    expect(created.state.corrections ?? []).toHaveLength(0);
  });

  it('调增后可登记新增余量；调减后只可在新余量内登记', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    const batch = created.value;

    // 已用 8（旧余量 2）→ 调增到 12 → 还能登记 4
    const after8 = mustRecord(created.state, batch.id, '8', deps).state;
    const up = mustCorrect(after8, batch.id, '12', '调增', deps).state;
    const more = recordUsage(up, { batchId: batch.id, films: '4' }, deps);
    expect(more.ok).toBe(true);
    if (more.ok) {
      expect(more.value.remainingAfter).toBe(0);
      expect(batchStatus(batch, more.state)).toBe('exhausted');
      // 新记录按 12 阶段容量写 remainingAfter
      expect(more.value.remainingAfter).toBe(12 - 8 - 4);
    }

    // 另一批：10 用 4 → 调减到 6 → 只剩 2，登记 3 被拒、登记 2 成功
    const other = mustCreate(more.ok ? more.state : up, '定影液', '10', deps);
    const otherBatch = other.value;
    const used4 = mustRecord(other.state, otherBatch.id, '4', deps).state;
    const down = mustCorrect(used4, otherBatch.id, '6', '调减', deps).state;
    expect(remainingCapacity(otherBatch, down)).toBe(2);
    const over = recordUsage(down, { batchId: otherBatch.id, films: '3' }, deps);
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toBe('超过剩余容量：本批仅剩 2，无法登记 3');
    const exact = recordUsage(down, { batchId: otherBatch.id, films: '2' }, deps);
    expect(exact.ok).toBe(true);
    expect(hasConsistentCapacityTrajectory(exact.ok ? exact.state : down)).toBe(true);
  });
});

describe('更正后的容量轨迹分阶段重放（hasConsistentCapacityTrajectory）', () => {
  function batch(id: string, capacity: number) {
    return { id, name: `批次 ${id}`, capacity, createdAt: '2026-09-01T08:00:00.000Z' };
  }
  function record(
    id: string,
    batchId: string,
    films: number,
    remainingAfter: number,
    createdAt = '2026-09-02T09:00:00.000Z',
  ) {
    return { id, batchId, films, note: '', remainingAfter, createdAt };
  }
  function correction(
    id: string,
    batchId: string,
    previousCapacity: number,
    newCapacity: number,
    seq: number,
  ): CapacityCorrection {
    return {
      id,
      batchId,
      previousCapacity,
      newCapacity,
      reason: '测试凭证',
      seq,
      createdAt: '2026-09-02T10:00:00.000Z',
    };
  }

  it('命令产出的「先登记后调减」台账恒可信', () => {
    const deps = testDeps();
    const created = mustCreate(EMPTY_LEDGER, '显影液', '10', deps);
    let state = mustRecord(created.state, created.value.id, '8', deps).state;
    state = mustCorrect(state, created.value.id, '8', '调减', deps).state;
    expect(hasConsistentCapacityTrajectory(state)).toBe(true);
  });

  it('不能拿最终容量反验早期记录：早期 remainingAfter 按创建容量验证', () => {
    // 容量 10，先登记 8（remainingAfter=2），再调减到 8。
    // 若错误地用最终容量 8 反验，会期望 remainingAfter=0；正确的分阶段重放要求 2。
    const good: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 2)],
      corrections: [correction('c1', 'b1', 10, 8, 2)],
    };
    expect(hasConsistentCapacityTrajectory(good)).toBe(true);

    const backDated: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 0)], // 用最终容量反推的错误余量
      corrections: [correction('c1', 'b1', 10, 8, 2)],
    };
    expect(hasConsistentCapacityTrajectory(backDated)).toBe(false);
  });

  it('凭证先于记录时，记录按更正后的阶段容量验证（不能用创建容量反验）', () => {
    // 创建 10，先调增到 15（seq 1），再登记 8：remainingAfter 必须是 7（15−8），不是 2
    const good: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 7)],
      corrections: [correction('c1', 'b1', 10, 15, 1)],
    };
    expect(hasConsistentCapacityTrajectory(good)).toBe(true);

    const stale: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 2)], // 误用创建容量 10 算出的余量
      corrections: [correction('c1', 'b1', 10, 15, 1)],
    };
    expect(hasConsistentCapacityTrajectory(stale)).toBe(false);

    // 凭证之后的阶段超额（登记 16 > 15）同样不可信
    const over: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 16, -1)],
      corrections: [correction('c1', 'b1', 10, 15, 1)],
    };
    expect(hasConsistentCapacityTrajectory(over)).toBe(false);
  });

  it('凭证 previousCapacity 与其签发阶段不符不可信（不能伪造原值）', () => {
    // 10 先用 8，再「声称」原容量是 9 调到 8：与阶段重放值 10 矛盾
    const lied: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 2)],
      corrections: [correction('c1', 'b1', 9, 8, 2)],
    };
    expect(hasConsistentCapacityTrajectory(lied)).toBe(false);

    // 多次更正链中第二张凭证的原值必须是上一阶段的新值
    const brokenChain: LedgerState = {
      batches: [batch('b1', 10)],
      records: [],
      corrections: [
        correction('c1', 'b1', 10, 15, 1),
        correction('c2', 'b1', 10, 20, 2), // 应为 15 → 20
      ],
    };
    expect(hasConsistentCapacityTrajectory(brokenChain)).toBe(false);
  });

  it('凭证新容量低于签发时已登记用量不可信（会把既有登记变超额）', () => {
    const belowUsed: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 8, 2)],
      corrections: [correction('c1', 'b1', 10, 7, 2)],
    };
    expect(hasConsistentCapacityTrajectory(belowUsed)).toBe(false);
  });

  it('提交顺序 seq 重号 / 断裂 / 越界不可信', () => {
    // 两张凭证 + 一条记录（共 3 个事件位置）
    const base = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 1, 9)],
    };
    const dupSeq: LedgerState = {
      ...base,
      corrections: [correction('c1', 'b1', 10, 11, 1), correction('c2', 'b1', 11, 12, 1)],
    };
    expect(hasConsistentCapacityTrajectory(dupSeq)).toBe(false);

    const gapSeq: LedgerState = {
      ...base,
      corrections: [correction('c1', 'b1', 10, 11, 1), correction('c2', 'b1', 11, 12, 4)],
    };
    expect(hasConsistentCapacityTrajectory(gapSeq)).toBe(false);

    const outOfRange: LedgerState = {
      ...base,
      corrections: [correction('c1', 'b1', 10, 11, 5)],
    };
    expect(hasConsistentCapacityTrajectory(outOfRange)).toBe(false);

    const nonPositive: LedgerState = {
      ...base,
      corrections: [correction('c1', 'b1', 10, 11, 0)],
    };
    expect(hasConsistentCapacityTrajectory(nonPositive)).toBe(false);
  });

  it('凭证挂在未知批次上不可信', () => {
    const ghost: LedgerState = {
      batches: [batch('b1', 10)],
      records: [],
      corrections: [correction('c1', 'ghost', 10, 12, 1)],
    };
    expect(hasConsistentCapacityTrajectory(ghost)).toBe(false);
  });

  it('跨批次凭证与记录交错时按全局顺序各自分阶段重放', () => {
    // 位置序列：c1（A 10→12, seq1），r1（A 用 8，记录下标0），r2（B 用 3，下标1），c2（B 5→7, seq4）
    const good: LedgerState = {
      batches: [batch('a', 10), batch('b', 5)],
      records: [
        record('r1', 'a', 8, 4, '2026-09-02T09:01:00.000Z'), // A 阶段容量 12 → 余 4
        record('r2', 'b', 3, 2, '2026-09-02T09:02:00.000Z'), // B 阶段容量 5 → 余 2
      ],
      corrections: [
        correction('c1', 'a', 10, 12, 1),
        correction('c2', 'b', 5, 7, 4),
      ],
    };
    expect(hasConsistentCapacityTrajectory(good)).toBe(true);

    // A 的记录若误用创建容量 10 算余量（=2），与所处阶段 12 矛盾
    const badA: LedgerState = {
      ...good,
      records: [
        record('r1', 'a', 8, 2, '2026-09-02T09:01:00.000Z'),
        record('r2', 'b', 3, 2, '2026-09-02T09:02:00.000Z'),
      ],
    };
    expect(hasConsistentCapacityTrajectory(badA)).toBe(false);
  });

  it('无 corrections 字段的旧状态仍按原规则（创建容量）重放', () => {
    const legacy: LedgerState = {
      batches: [batch('b1', 10)],
      records: [record('r1', 'b1', 4, 6), record('r2', 'b1', 6, 0)],
    };
    expect(hasConsistentCapacityTrajectory(legacy)).toBe(true);
  });
});
