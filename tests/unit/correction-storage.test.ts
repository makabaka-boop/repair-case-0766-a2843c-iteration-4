import { describe, expect, it } from 'vitest';
import {
  batchStatus,
  correctCapacity,
  createBatch,
  effectiveCapacity,
  EMPTY_LEDGER,
  recordUsage,
  remainingCapacity,
  usedCapacity,
  type LedgerDeps,
} from '../../src/lib/capacityLedger';
import {
  commitLedger,
  LEDGER_STORAGE_KEY,
  loadLedger,
  loadLedgerDocument,
  parseLedger,
  parseLedgerDocument,
  saveLedger,
  type LedgerDocument,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

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

interface TestStorage extends StorageLike {
  failWrites(): void;
  recoverWrites(): void;
  raw(): string | null;
}

function memoryStorage(initial?: Record<string, string>): TestStorage {
  const data = new Map<string, string>(initial ? Object.entries(initial) : []);
  let failing = false;
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      if (failing) throw new Error('QuotaExceededError: mock quota');
      data.set(key, value);
    },
    failWrites: () => {
      failing = true;
    },
    recoverWrites: () => {
      failing = false;
    },
    raw: () => data.get(LEDGER_STORAGE_KEY) ?? null,
  };
}

function reload(storage: StorageLike): LedgerDocument {
  return loadLedgerDocument(storage).doc;
}

/** 用命令构建：容量 10 → 登记 4 → 更正到 12 → 再登记 4 的台账。 */
function buildCorrectedLedger(deps: LedgerDeps) {
  const created = createBatch(EMPTY_LEDGER, { name: '显影液', capacity: '10' }, deps);
  if (!created.ok) throw new Error('setup');
  const used = recordUsage(created.state, { batchId: created.value.id, films: '4' }, deps);
  if (!used.ok) throw new Error('setup');
  const corrected = correctCapacity(
    used.state,
    { batchId: created.value.id, newCapacity: '12', reason: '建档容量写错' },
    deps,
  );
  if (!corrected.ok) throw new Error('setup');
  const again = recordUsage(corrected.state, { batchId: created.value.id, films: '4', note: '更正后登记' }, deps);
  if (!again.ok) throw new Error('setup');
  return { batchId: created.value.id, state: again.state };
}

describe('容量更正凭证的持久化', () => {
  it('序列化 → 解析往返：凭证、分阶段历史余量与最新有效容量一致', () => {
    const deps = testDeps();
    const { batchId, state } = buildCorrectedLedger(deps);
    const restored = parseLedger(JSON.stringify(state));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(state);

    // 历史记录保持各阶段的 remainingAfter：6（容量 10 阶段）、4（容量 12 阶段）
    expect(restored!.records.map((r) => r.remainingAfter)).toEqual([6, 4]);
    expect(restored!.corrections).toHaveLength(1);
    expect(restored!.corrections[0]).toMatchObject({
      batchId,
      fromCapacity: 10,
      toCapacity: 12,
      sequence: 1,
      recordsBefore: 1,
      reason: '建档容量写错',
    });
    expect(usedCapacity(restored!, batchId)).toBe(8);
    expect(effectiveCapacity(restored!, restored!.batches[0])).toBe(12);
    expect(remainingCapacity(restored!.batches[0], restored!)).toBe(4);
  });

  it('写入存储 → 刷新读回：有效容量、历史明细、凭证列表完整还原', () => {
    const deps = testDeps();
    const { state } = buildCorrectedLedger(deps);
    const storage = memoryStorage();
    saveLedger(storage, state);

    const restored = loadLedger(storage);
    expect(restored).toEqual(state);
    expect(restored.corrections[0].reason).toBe('建档容量写错');
    expect(batchStatus(restored.batches[0], restored)).toBe('active');
  });

  it('旧档（无 corrections 字段）仍按原规则恢复，有效容量即创建容量', () => {
    const legacy = JSON.stringify({
      batches: [{ id: 'legacy', name: '旧批次', capacity: 10, createdAt: '2026-09-01T00:00:00.000Z' }],
      records: [
        { id: 'r1', batchId: 'legacy', films: 4, note: '', remainingAfter: 6, createdAt: '2026-09-02T00:00:00.000Z' },
      ],
    });
    const restored = parseLedgerDocument(legacy);
    expect(restored).not.toBeNull();
    expect(restored!.ledger.corrections).toEqual([]);
    expect(effectiveCapacity(restored!.ledger, restored!.ledger.batches[0])).toBe(10);
    expect(remainingCapacity(restored!.ledger.batches[0], restored!.ledger)).toBe(6);
  });

  it('损坏的凭证存档（断链 / 锚点越界 / 挂未知批次 / 字段非法）整份不可信', () => {
    const validRecord = {
      id: 'r1',
      batchId: 'b1',
      films: 4,
      note: '',
      remainingAfter: 6,
      createdAt: '2026-09-02T09:00:00.000Z',
    };
    const validBatch = { id: 'b1', name: '批次', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' };
    const badCorrections: Array<[string, unknown]> = [
      ['挂在未知批次', { id: 'c1', batchId: 'ghost', fromCapacity: 10, toCapacity: 12, reason: 'x', sequence: 1, recordsBefore: 0, createdAt: 't' }],
      ['容量链起点错误', { id: 'c1', batchId: 'b1', fromCapacity: 9, toCapacity: 12, reason: 'x', sequence: 1, recordsBefore: 0, createdAt: 't' }],
      ['序号缺号', { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 12, reason: 'x', sequence: 2, recordsBefore: 0, createdAt: 't' }],
      ['锚点越界', { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 12, reason: 'x', sequence: 1, recordsBefore: 2, createdAt: 't' }],
      ['新容量低于已登记用量', { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 3, reason: 'x', sequence: 1, recordsBefore: 1, createdAt: 't' }],
      ['空原因', { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 12, reason: '  ', sequence: 1, recordsBefore: 0, createdAt: 't' }],
      ['非正整数新容量', { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 0, reason: 'x', sequence: 1, recordsBefore: 0, createdAt: 't' }],
      ['早期记录被最终容量反改（r1=8 不符旧阶段）', null],
    ];
    for (const [label, correction] of badCorrections) {
      let payload: string;
      if (correction === null) {
        // r1.remainingAfter 被改成符合最终容量 12 的 8，但所处阶段容量是 10
        payload = JSON.stringify({
          batches: [validBatch],
          records: [{ ...validRecord, remainingAfter: 8 }],
          corrections: [
            { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 12, reason: 'x', sequence: 1, recordsBefore: 1, createdAt: 't' },
          ],
        });
      } else {
        payload = JSON.stringify({
          batches: [validBatch],
          records: [validRecord],
          corrections: Array.isArray(correction) ? correction : [correction],
        });
      }
      expect(parseLedger(payload), `应当拒绝：${label}`).toBeNull();
      const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: payload });
      expect(loadLedgerDocument(storage).ok).toBe(false);
      expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);
    }
  });

  it('合法的分阶段凭证存档可恢复，并能在最新有效容量上继续登记', () => {
    // r1 属容量 10 阶段（剩余 6）；凭证 10→12；r2 属容量 12 阶段（剩余 4）
    const payload = JSON.stringify({
      batches: [{ id: 'b1', name: '显影液', capacity: 10, createdAt: '2026-09-01T08:00:00.000Z' }],
      records: [
        { id: 'r1', batchId: 'b1', films: 4, note: '', remainingAfter: 6, createdAt: '2026-09-02T09:00:00.000Z' },
        { id: 'r2', batchId: 'b1', films: 4, note: '', remainingAfter: 4, createdAt: '2026-09-04T09:00:00.000Z' },
      ],
      corrections: [
        { id: 'c1', batchId: 'b1', fromCapacity: 10, toCapacity: 12, reason: '调增', sequence: 1, recordsBefore: 1, createdAt: '2026-09-03T09:00:00.000Z' },
      ],
    });
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: payload });
    const load = loadLedgerDocument(storage);
    expect(load.ok).toBe(true);
    expect(load.doc.ledger.records.map((r) => r.remainingAfter)).toEqual([6, 4]);

    // 在最新容量 12 上继续登记 4 → 恰好耗尽
    const deps = testDeps();
    const outcome = commitLedger(
      storage,
      load.doc,
      { type: 'recordUsage', input: { batchId: 'b1', films: '4' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const final = reload(storage).ledger;
    expect(final.records.map((r) => r.remainingAfter)).toEqual([6, 4, 0]);
    expect(batchStatus(final.batches[0], final)).toBe('exhausted');
  });
});

describe('容量更正的跨标签并发', () => {
  it('更正提交同样走修订号：过期页面提交被冲突拒绝，不显示未落账的新余量，刷新后可重试', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    // 建立批次并登记 4（剩余 6）
    const created = commitLedger(
      storage,
      reload(storage),
      { type: 'createBatch', input: { name: '显影液', capacity: '10' } },
      deps,
    );
    expect(created.ok).toBe(true);
    const batchId = created.ok ? created.intent.result.ok ? created.intent.result.value.id : '' : '';
    const recorded = commitLedger(
      storage,
      reload(storage),
      { type: 'recordUsage', input: { batchId, films: '4' } },
      deps,
    );
    expect(recorded.ok).toBe(true);

    // 两页读取同一旧状态（有效容量 10、剩余 6）
    const pageA = reload(storage);
    const pageB = reload(storage);

    // A 先更正到 16：成功，剩余变 12
    const a = commitLedger(
      storage,
      pageA,
      { type: 'correctCapacity', input: { batchId, newCapacity: '16', reason: 'A 页更正' } },
      deps,
    );
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.doc.revision).toBe(pageA.revision + 1);
    expect(effectiveCapacity(a.doc.ledger, a.doc.ledger.batches[0])).toBe(16);

    // B 用过期基准更正到 20：冲突拒绝，返回的文档里没有 B 的凭证，容量仍是 16
    const bStale = commitLedger(
      storage,
      pageB,
      { type: 'correctCapacity', input: { batchId, newCapacity: '20', reason: 'B 页更正' } },
      deps,
    );
    expect(bStale.ok).toBe(false);
    if (!bStale.ok && bStale.kind === 'conflict') {
      expect(bStale.error).toContain('容量更正未写入');
      expect(bStale.doc.ledger.corrections).toHaveLength(1);
      expect(effectiveCapacity(bStale.doc.ledger, bStale.doc.ledger.batches[0])).toBe(16);
      expect(remainingCapacity(bStale.doc.ledger.batches[0], bStale.doc.ledger)).toBe(12);
    }

    // 存储中只有 A 的凭证；创建容量 10 与历史记录 remainingAfter=6 原样保留
    const raw = JSON.parse(storage.raw()!) as {
      revision: number;
      batches: Array<{ capacity: number }>;
      corrections: Array<{ fromCapacity: number; toCapacity: number; reason: string }>;
      records: Array<{ remainingAfter: number }>;
    };
    expect(raw.revision).toBe(3);
    expect(raw.batches[0].capacity).toBe(10);
    expect(raw.corrections).toHaveLength(1);
    expect(raw.corrections[0]).toMatchObject({ fromCapacity: 10, toCapacity: 16, reason: 'A 页更正' });
    expect(raw.records[0].remainingAfter).toBe(6);

    // B 刷新后基于最新容量再更正到 20：成功，序号仍是该批第 2 张
    const pageBFresh = reload(storage);
    const b = commitLedger(
      storage,
      pageBFresh,
      { type: 'correctCapacity', input: { batchId, newCapacity: '20', reason: 'B 页更正' } },
      deps,
    );
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    const final = reload(storage).ledger;
    expect(final.corrections.map((c) => [c.sequence, c.fromCapacity, c.toCapacity])).toEqual([
      [1, 10, 16],
      [2, 16, 20],
    ]);
    expect(remainingCapacity(final.batches[0], final)).toBe(16);
  });

  it('领域拒绝（新容量低于已登记用量）不改变修订号、不触碰存储', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const created = commitLedger(
      storage,
      reload(storage),
      { type: 'createBatch', input: { name: '显影液', capacity: '10' } },
      deps,
    );
    const batchId = created.ok && created.intent.result.ok ? created.intent.result.value.id : '';
    const recorded = commitLedger(
      storage,
      reload(storage),
      { type: 'recordUsage', input: { batchId, films: '8' } },
      deps,
    );
    expect(recorded.ok).toBe(true);
    const before = reload(storage);
    const rawBefore = storage.raw();

    const rejected = commitLedger(
      storage,
      before,
      { type: 'correctCapacity', input: { batchId, newCapacity: '7', reason: '调低' } },
      deps,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok && rejected.kind === 'rejected') {
      if (!rejected.intent.result.ok) {
        expect(rejected.intent.result.error).toContain('不得低于该批已登记用量 8');
      }
      expect(rejected.doc.revision).toBe(before.revision);
    }
    expect(storage.raw()).toBe(rawBefore);
    expect(reload(storage).ledger.corrections).toHaveLength(0);
  });

  it('写入失败：更正被整体拒绝，界面文档不出现虚假新增余量，恢复后可重试', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const created = commitLedger(
      storage,
      reload(storage),
      { type: 'createBatch', input: { name: '显影液', capacity: '10' } },
      deps,
    );
    const batchId = created.ok && created.intent.result.ok ? created.intent.result.value.id : '';
    const before = reload(storage);
    const rawBefore = storage.raw();

    storage.failWrites();
    const failed = commitLedger(
      storage,
      before,
      { type: 'correctCapacity', input: { batchId, newCapacity: '20', reason: '配额更正' } },
      deps,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.kind === 'storage') {
      expect(failed.doc.ledger.corrections).toHaveLength(0);
      // 不伪装成功：返回文档的有效容量仍是 10、剩余仍是 10
      expect(effectiveCapacity(failed.doc.ledger, failed.doc.ledger.batches[0])).toBe(10);
      expect(remainingCapacity(failed.doc.ledger.batches[0], failed.doc.ledger)).toBe(10);
    }
    expect(storage.raw()).toBe(rawBefore);

    storage.recoverWrites();
    const retry = commitLedger(
      storage,
      before,
      { type: 'correctCapacity', input: { batchId, newCapacity: '20', reason: '配额更正' } },
      deps,
    );
    expect(retry.ok).toBe(true);
    const final = reload(storage).ledger;
    expect(final.corrections).toHaveLength(1);
    expect(remainingCapacity(final.batches[0], final)).toBe(20);
  });

  it('存储损坏时更正提交被拒且原文不被覆盖', () => {
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: '{broken' });
    const deps = testDeps();
    const outcome = commitLedger(
      storage,
      { ledger: EMPTY_LEDGER, revision: 0 },
      { type: 'correctCapacity', input: { batchId: 'b1', newCapacity: '20', reason: 'x' } },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('corrupted');
    expect(storage.raw()).toBe('{broken');
  });

  it('旧版无修订号存档上更正：首次提交升级，旧记录与创建容量保持原样', () => {
    const legacy = JSON.stringify({
      batches: [{ id: 'legacy', name: '旧批次', capacity: 10, createdAt: '2026-09-01T00:00:00.000Z' }],
      records: [
        { id: 'r1', batchId: 'legacy', films: 4, note: '', remainingAfter: 6, createdAt: '2026-09-02T00:00:00.000Z' },
      ],
    });
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: legacy });
    const deps = testDeps();
    const page = reload(storage);
    expect(page.revision).toBe(0);

    const outcome = commitLedger(
      storage,
      page,
      { type: 'correctCapacity', input: { batchId: 'legacy', newCapacity: '12', reason: '旧档更正' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.revision).toBe(1);

    const raw = JSON.parse(storage.raw()!) as {
      revision: number;
      batches: Array<{ capacity: number }>;
      corrections: unknown[];
      records: Array<{ remainingAfter: number }>;
    };
    expect(raw.revision).toBe(1);
    expect(raw.batches[0].capacity).toBe(10);
    expect(raw.records[0].remainingAfter).toBe(6);
    expect(raw.corrections).toHaveLength(1);

    // 刷新后按分阶段轨迹恢复：早期记录仍是 6，当前余量 12 − 4 = 8
    const restored = reload(storage).ledger;
    expect(restored.records[0].remainingAfter).toBe(6);
    expect(remainingCapacity(restored.batches[0], restored)).toBe(8);
  });

  it('调减后另一页面基于过期「大余量」的登记被冲突拒绝，绝不产生负余量', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const created = commitLedger(
      storage,
      reload(storage),
      { type: 'createBatch', input: { name: '显影液', capacity: '20' } },
      deps,
    );
    const batchId = created.ok && created.intent.result.ok ? created.intent.result.value.id : '';
    const recorded = commitLedger(
      storage,
      reload(storage),
      { type: 'recordUsage', input: { batchId, films: '8' } },
      deps,
    );
    expect(recorded.ok).toBe(true);

    const pageA = reload(storage); // 剩余 12（容量 20）
    const pageB = reload(storage);

    // A 把容量调减到 8（= 已登记用量，剩余 0）
    const a = commitLedger(
      storage,
      pageA,
      { type: 'correctCapacity', input: { batchId, newCapacity: '8', reason: '调减到实测' } },
      deps,
    );
    expect(a.ok).toBe(true);

    // B 按过期余量 12 登记 5：冲突优先（修订号不一致），不重放成「超额」
    const bStale = commitLedger(
      storage,
      pageB,
      { type: 'recordUsage', input: { batchId, films: '5' } },
      deps,
    );
    expect(bStale.ok).toBe(false);
    if (!bStale.ok) expect(bStale.kind).toBe('conflict');
    expect(reload(storage).ledger.records).toHaveLength(1);

    // B 刷新后仍提交 5：在最新容量 8 上被领域拒绝（仅剩 0），容量永不为负
    const bFresh = reload(storage);
    const bOver = commitLedger(
      storage,
      bFresh,
      { type: 'recordUsage', input: { batchId, films: '5' } },
      deps,
    );
    expect(bOver.ok).toBe(false);
    if (!bOver.ok) expect(bOver.kind).toBe('rejected');
    const final = reload(storage).ledger;
    expect(usedCapacity(final, batchId)).toBe(8);
    expect(remainingCapacity(final.batches[0], final)).toBe(0);
    expect(batchStatus(final.batches[0], final)).toBe('exhausted');
  });
});
