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
  serializeLedgerDocument,
  type LedgerDocument,
  type StorageLike,
} from '../../src/lib/ledgerStorage';

function testDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => {
      counter += 1;
      return new Date(Date.UTC(2026, 9, 4, 12, 0, 0) + counter * 1000);
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

function seedBatch(storage: StorageLike, name: string, capacity: string, deps: LedgerDeps): string {
  const result = createBatch(loadLedger(storage), { name, capacity }, deps);
  if (!result.ok) throw new Error(`seed 失败：${result.error}`);
  const doc = loadLedgerDocument(storage).doc;
  storage.setItem(
    LEDGER_STORAGE_KEY,
    serializeLedgerDocument({ ledger: result.state, revision: doc.revision + 1 }),
  );
  return result.value.id;
}

function reload(storage: StorageLike): LedgerDocument {
  return loadLedgerDocument(storage).doc;
}

describe('容量更正凭证的持久化往返', () => {
  it('调增 → 登记 → 调减后序列化往返，凭证与历史 remainingAfter 原样还原', () => {
    const deps = testDeps();
    const created = createBatch(EMPTY_LEDGER, { name: '显影液', capacity: '10' }, deps);
    if (!created.ok) throw new Error('setup');
    const batchId = created.value.id;
    // 先登记 8（旧阶段容量 10，余 2）再调减到 8
    const recorded = recordUsage(created.state, { batchId, films: '8' }, deps);
    if (!recorded.ok) throw new Error('setup');
    let state = recorded.state;
    const corrected = correctCapacity(state, { batchId, newCapacity: '8', reason: '调减到实际容量' }, deps);
    if (!corrected.ok) throw new Error('setup');
    state = corrected.state;

    const storage = memoryStorage();
    saveLedger(storage, state);

    const restored = loadLedger(storage);
    const batch = restored.batches[0];
    // 创建容量仍是 10，有效容量是 8，余 0、已耗尽
    expect(batch.capacity).toBe(10);
    expect(effectiveCapacity(batch, restored)).toBe(8);
    expect(remainingCapacity(batch, restored)).toBe(0);
    expect(batchStatus(batch, restored)).toBe('exhausted');
    // 历史记录的 remainingAfter 原样为 2（10−8），不被调减重写
    expect(restored.records.map((r) => r.remainingAfter)).toEqual([2]);
    // 凭证字段逐项还原
    const voucher = restored.corrections![0];
    expect(voucher).toMatchObject({ batchId, previousCapacity: 10, newCapacity: 8, seq: 2 });
    expect(voucher.reason).toBe('调减到实际容量');
  });

  it('旧版存档（无 corrections 字段）照常读取，之后追加更正与登记并刷新一致', () => {
    const legacy = JSON.stringify({
      batches: [{ id: 'legacy-b1', name: '旧版批次', capacity: 10, createdAt: '2026-09-01T00:00:00.000Z' }],
      records: [
        { id: 'r1', batchId: 'legacy-b1', films: 4, note: '', remainingAfter: 6, createdAt: '2026-09-01T01:00:00.000Z' },
      ],
    });
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: legacy });
    const loaded = loadLedgerDocument(storage);
    expect(loaded.ok).toBe(true);
    expect(loaded.doc.ledger.corrections).toEqual([]);

    const deps = testDeps();
    // 在旧档上调增到 12
    const outcome = commitLedger(
      storage,
      loaded.doc,
      { type: 'correctCapacity', input: { batchId: 'legacy-b1', newCapacity: '12', reason: '旧档更正' } },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.doc.revision).toBe(1);

    // 刷新还原：历史余量 6 不变，当前有效容量 12、剩余 8
    const refreshedDoc = reload(storage);
    const batch = refreshedDoc.ledger.batches[0];
    expect(batch.capacity).toBe(10);
    expect(effectiveCapacity(batch, refreshedDoc.ledger)).toBe(12);
    expect(refreshedDoc.ledger.records[0].remainingAfter).toBe(6);
    expect(remainingCapacity(batch, refreshedDoc.ledger)).toBe(8);
    const raw = JSON.parse(storage.raw()!) as { corrections: unknown[] };
    expect(raw.corrections).toHaveLength(1);

    // 旧档升级后再登记：按新有效容量计算余量
    const record = commitLedger(
      storage,
      refreshedDoc,
      { type: 'recordUsage', input: { batchId: 'legacy-b1', films: '8' } },
      deps,
    );
    expect(record.ok).toBe(true);
    const final = reload(storage);
    expect(remainingCapacity(final.ledger.batches[0], final.ledger)).toBe(0);
    expect(final.ledger.records.map((r) => r.remainingAfter)).toEqual([6, 0]);
  });

  it('损坏的更正凭证（字段缺失 / 非正整数 / 空原因 / 挂未知批次）使整份存档不可信', () => {
    const goodBatch =
      '{"id":"b1","name":"显影液","capacity":10,"createdAt":"2026-09-01T00:00:00.000Z"}';
    const badArchives = [
      // corrections 不是数组
      `{"batches":[${goodBatch}],"records":[],"corrections":{}}`,
      // 缺 reason
      `{"batches":[${goodBatch}],"records":[],"corrections":[{"id":"c1","batchId":"b1","previousCapacity":10,"newCapacity":12,"seq":1,"createdAt":"t"}]}`,
      // 新容量非正整数
      `{"batches":[${goodBatch}],"records":[],"corrections":[{"id":"c1","batchId":"b1","previousCapacity":10,"newCapacity":0,"reason":"x","seq":1,"createdAt":"t"}]}`,
      // 原容量非安全整数
      `{"batches":[${goodBatch}],"records":[],"corrections":[{"id":"c1","batchId":"b1","previousCapacity":9007199254740993,"newCapacity":12,"reason":"x","seq":1,"createdAt":"t"}]}`,
      // seq 非正整数
      `{"batches":[${goodBatch}],"records":[],"corrections":[{"id":"c1","batchId":"b1","previousCapacity":10,"newCapacity":12,"reason":"x","seq":0,"createdAt":"t"}]}`,
      // 凭证挂在未知批次
      `{"batches":[${goodBatch}],"records":[],"corrections":[{"id":"c1","batchId":"ghost","previousCapacity":10,"newCapacity":12,"reason":"x","seq":1,"createdAt":"t"}]}`,
      // 结构合法但轨迹矛盾：新容量 8 低于当时已登记用量 9（剩余按最终容量反推）
      `{"batches":[${goodBatch}],"records":[{"id":"r1","batchId":"b1","films":9,"note":"","remainingAfter":1,"createdAt":"t"}],"corrections":[{"id":"c1","batchId":"b1","previousCapacity":10,"newCapacity":8,"reason":"x","seq":2,"createdAt":"t"}]}`,
      // 结构合法但拿最终容量反验早期记录：early remainingAfter 应为 1 却是 0
      `{"batches":[${goodBatch}],"records":[{"id":"r1","batchId":"b1","films":9,"note":"","remainingAfter":0,"createdAt":"t"}],"corrections":[{"id":"c1","batchId":"b1","previousCapacity":10,"newCapacity":9,"reason":"x","seq":2,"createdAt":"t"}]}`,
    ];
    for (const payload of badArchives) {
      expect(parseLedger(payload)).toBeNull();
      expect(parseLedgerDocument(payload)).toBeNull();
      const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: payload });
      const load = loadLedgerDocument(storage);
      expect(load.ok).toBe(false);
      expect(loadLedger(storage)).toEqual(EMPTY_LEDGER);
    }
  });
});

describe('容量更正的跨标签提交（commitLedger）', () => {
  it('更正成功推进修订号；领域拒绝（低于用量 / 无变化）不改修订号、不写存储', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '显影液', '10', deps);
    // 先登记 8
    const afterRecord = commitLedger(
      storage,
      reload(storage),
      { type: 'recordUsage', input: { batchId, films: '8' } },
      deps,
    );
    expect(afterRecord.ok).toBe(true);

    // 低于已登记用量 → 领域拒绝，修订号不变
    const below = commitLedger(
      storage,
      reload(storage),
      { type: 'correctCapacity', input: { batchId, newCapacity: '7', reason: '调减' } },
      deps,
    );
    expect(below.ok).toBe(false);
    if (!below.ok) {
      expect(below.kind).toBe('rejected');
      expect(below.doc.revision).toBe(2);
    }
    expect(reload(storage).revision).toBe(2);

    // 与当前有效容量相同 → 领域拒绝
    const same = commitLedger(
      storage,
      reload(storage),
      { type: 'correctCapacity', input: { batchId, newCapacity: '10', reason: '无变化' } },
      deps,
    );
    expect(same.ok).toBe(false);
    if (!same.ok) expect(same.kind).toBe('rejected');

    // 合法调增到 12 → 成功，修订号 3，余量变 4
    const up = commitLedger(
      storage,
      reload(storage),
      { type: 'correctCapacity', input: { batchId, newCapacity: '12', reason: '调增' } },
      deps,
    );
    expect(up.ok).toBe(true);
    if (!up.ok) return;
    expect(up.doc.revision).toBe(3);
    const batch = up.doc.ledger.batches[0];
    expect(effectiveCapacity(batch, up.doc.ledger)).toBe(12);
    expect(remainingCapacity(batch, up.doc.ledger)).toBe(4);
    expect(usedCapacity(up.doc.ledger, batchId)).toBe(8);
  });

  it('过期页面更正：另一页已提交时冲突拒绝，不产生虚假余量，刷新对齐后重试成功', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '并发批次', '10', deps);
    const pageA = reload(storage);
    const pageB = reload(storage);

    // A 先把容量更正为 16
    const a = commitLedger(
      storage,
      pageA,
      { type: 'correctCapacity', input: { batchId, newCapacity: '16', reason: 'A 页调增' } },
      deps,
    );
    expect(a.ok).toBe(true);

    // B 持过期修订号提交更正（10 → 12）：冲突拒绝，返回最新文档
    const bStale = commitLedger(
      storage,
      pageB,
      { type: 'correctCapacity', input: { batchId, newCapacity: '12', reason: 'B 页过期更正' } },
      deps,
    );
    expect(bStale.ok).toBe(false);
    if (!bStale.ok && bStale.kind === 'conflict') {
      expect(bStale.error).toContain('其他页面');
      // 返回的最新文档已含 A 的凭证、有效容量 16
      const batch = bStale.doc.ledger.batches[0];
      expect(effectiveCapacity(batch, bStale.doc.ledger)).toBe(16);
      expect(bStale.doc.ledger.corrections).toHaveLength(1);
    } else {
      throw new Error('过期更正应返回 conflict');
    }
    // 存储中只有 A 的一张凭证，没有 B 的「虚假调减」
    const raw = JSON.parse(storage.raw()!) as { corrections: Array<{ newCapacity: number }> };
    expect(raw.corrections.map((c) => c.newCapacity)).toEqual([16]);

    // B 刷新后基于最新容量 16 更正为 20：成功
    const freshB = reload(storage);
    const retry = commitLedger(
      storage,
      freshB,
      { type: 'correctCapacity', input: { batchId, newCapacity: '20', reason: 'B 页重试' } },
      deps,
    );
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    const final = reload(storage);
    const batch = final.ledger.batches[0];
    expect(effectiveCapacity(batch, final.ledger)).toBe(20);
    expect(final.ledger.corrections!.map((c) => [c.previousCapacity, c.newCapacity, c.seq])).toEqual([
      [10, 16, 1],
      [16, 20, 2],
    ]);
  });

  it('写入失败：更正被拒绝、界面不显示新增余量，存储保留提交前台账；恢复后重试成功', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '配额批次', '10', deps);
    const before = reload(storage);
    const rawBefore = storage.raw();

    storage.failWrites();
    const failed = commitLedger(
      storage,
      before,
      { type: 'correctCapacity', input: { batchId, newCapacity: '30', reason: '大调增' } },
      deps,
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok && failed.kind === 'storage') {
      expect(failed.error).toContain('保存失败');
      // 返回文档是提交前台账：没有凭证、有效容量仍 10
      expect(failed.doc.ledger.corrections).toHaveLength(0);
      const batch = failed.doc.ledger.batches[0];
      expect(effectiveCapacity(batch, failed.doc.ledger)).toBe(10);
      expect(remainingCapacity(batch, failed.doc.ledger)).toBe(10);
    }
    // 存储原文一字节未变
    expect(storage.raw()).toBe(rawBefore);

    storage.recoverWrites();
    const retry = commitLedger(
      storage,
      reload(storage),
      { type: 'correctCapacity', input: { batchId, newCapacity: '30', reason: '大调增' } },
      deps,
    );
    expect(retry.ok).toBe(true);
    const final = reload(storage);
    expect(effectiveCapacity(final.ledger.batches[0], final.ledger)).toBe(30);
  });

  it('损坏存档上提交更正一律被拒且不覆盖原文', () => {
    const storage = memoryStorage({ [LEDGER_STORAGE_KEY]: '{broken json' });
    const deps = testDeps();
    const outcome = commitLedger(
      storage,
      { ledger: EMPTY_LEDGER, revision: 0 },
      { type: 'correctCapacity', input: { batchId: 'x', newCapacity: '5', reason: '不应写入' } },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe('corrupted');
    expect(storage.raw()).toBe('{broken json');
  });

  it('多次更正与登记交错提交后，刷新还原的分阶段容量与每条历史余量严格一致', () => {
    const storage = memoryStorage();
    const deps = testDeps();
    const batchId = seedBatch(storage, '交错批次', '10', deps);
    let doc = reload(storage);
    // 序列：登记 4（余6）→ 调增 20 → 登记 10（余6）→ 调减 18（已用14）→ 登记 4（余0）
    const steps: Array<
      | { type: 'recordUsage'; films: string }
      | { type: 'correctCapacity'; newCapacity: string; reason: string }
    > = [
      { type: 'recordUsage', films: '4' },
      { type: 'correctCapacity', newCapacity: '20', reason: '调增 20' },
      { type: 'recordUsage', films: '10' },
      { type: 'correctCapacity', newCapacity: '18', reason: '调减 18' },
      { type: 'recordUsage', films: '4' },
    ];
    for (const step of steps) {
      const intent =
        step.type === 'recordUsage'
          ? ({ type: 'recordUsage' as const, input: { batchId, films: step.films } } as const)
          : ({
              type: 'correctCapacity' as const,
              input: { batchId, newCapacity: step.newCapacity, reason: step.reason },
            } as const);
      const outcome = commitLedger(storage, doc, intent, deps);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        throw new Error(
          outcome.kind === 'rejected' && !outcome.intent.result.ok
            ? `交错序列不应失败：${outcome.intent.result.error}`
            : `交错序列不应失败：${outcome.kind}`,
        );
      }
      doc = outcome.doc;
    }

    const final = reload(storage);
    const batch = final.ledger.batches[0];
    expect(effectiveCapacity(batch, final.ledger)).toBe(18);
    expect(usedCapacity(final.ledger, batchId)).toBe(18);
    expect(remainingCapacity(batch, final.ledger)).toBe(0);
    expect(batchStatus(batch, final.ledger)).toBe('exhausted');
    // 历史 remainingAfter 按各自阶段容量：10−4=6；20−14=6；18−18=0
    expect(final.ledger.records.map((r) => r.remainingAfter)).toEqual([6, 6, 0]);
    // 凭证链：位置 2 与 4
    expect(final.ledger.corrections!.map((c) => [c.previousCapacity, c.newCapacity, c.seq])).toEqual([
      [10, 20, 2],
      [20, 18, 4],
    ]);
  });
});
