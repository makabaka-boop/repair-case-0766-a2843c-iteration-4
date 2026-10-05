/**
 * 药液处理容量台账（领域服务）。
 *
 * 与配液计算相互独立：这里跟踪一批药液按「等效胶片数」计的额定容量、
 * 逐次登记的处理用量与剩余容量，避免凭记忆继续使用已耗尽的药液。
 *
 * 契约 = 三个命令（纯函数，不修改传入状态，返回新状态）：
 * - createBatch：创建带名称与额定容量的药液批次，可附带一份配液来源快照；
 * - recordUsage：向指定批次登记一次处理用量，写入前按**当前有效容量**重新计算剩余量，
 *   剩余量 = 有效容量 − 该批全部已登记用量之和；登记后剩余为 0 即「已耗尽」；
 * - correctCapacity：追加一张不可修改的「容量更正凭证」，
 *   把批次的有效容量从原有效容量改为新有效容量（记录批次、原值、新值、原因、
 *   批次内提交顺序与提交时已登记用量），新容量须为正的安全整数且不得低于已登记用量。
 *
 * 使用记录与更正凭证一旦写入均不可修改：命令只追加、不更新、不删除；
 * 批次创建时的额定容量（capacity）与历史使用记录的 remainingAfter 永不因更正而改写，
 * 累计用量 / 有效容量 / 剩余容量 / 状态均由记录与凭证推导，不单独存储。
 * hasConsistentCapacityTrajectory 校验一份状态能否按「凭证与用量发生的顺序」
 * 分阶段完整重放，持久化层据此拒绝加载自相矛盾的存档（同 id 批次、超额用量、
 * 与所处阶段容量不符的登记后剩余量、断链 / 越界的更正凭证）。
 *
 * 配液来源快照（可选）：从配液计算结果区「存入容量台账」时，
 * 把同一次计算的稀释比例、目标总量、量筒容量、分罐数与浓缩液/清水体积
 * 逐字段拷贝固定保存，之后不随界面参数变化；手工创建的批次没有该字段。
 *
 * 校验失败时返回中文原因且不产生任何写入：
 * - 名称为空；
 * - 额定容量 / 胶片数量 / 新有效容量为空、非整数或非正整数；
 * - 数值超出安全整数范围（超长数字无法精确表示，显示会异常）；
 * - 登记数量超过当前剩余容量；
 * - 更正原因（reason）为空；
 * - 新有效容量低于该批已登记用量（会让既有记录立刻超额）；
 * - 附带的配液来源快照结构不完整或违反「浓缩液 + 清水 = 目标总量」。
 * 字段校验函数同时导出，界面可借此把错误放到对应字段下方，
 * 但命令本身仍是最终闸门（同样校验在命令内再执行一次）。
 */

/** 批次状态：使用中 / 已耗尽 */
export type BatchStatus = 'active' | 'exhausted';

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  active: '使用中',
  exhausted: '已耗尽',
};

export interface ChemicalBatch {
  id: string;
  /** 药液名称（非空，已去除首尾空白） */
  name: string;
  /** 额定容量：整批药液可处理的等效胶片总数（正整数） */
  capacity: number;
  /** 创建时间（ISO 8601） */
  createdAt: string;
  /**
   * 配液来源快照（可选）：创建时从同一次配液计算结果固定保存，
   * 之后不再变化；手工创建的批次没有该字段。
   */
  mixSource?: MixSourceSnapshot;
}

/**
 * 配液来源快照：一批药液「来自哪次配液计算」的完整参数与结果。
 * 字段名与 dilution.ts 的 MixResult 对齐，由界面从当次计算结果逐字段拷贝。
 */
export interface MixSourceSnapshot {
  /** 稀释式 1+n 的 n */
  n: number;
  /** 目标总量（mL） */
  total: number;
  /** 量筒容量（mL） */
  capacity: number;
  /** 显影罐数量（分罐数） */
  tanks: number;
  /** 取整后的浓缩液体积（mL） */
  concentrate: number;
  /** 清水体积（mL），恒满足 concentrate + water = total */
  water: number;
}

export interface UsageRecord {
  id: string;
  batchId: string;
  /** 本次处理的等效胶片数量（正整数） */
  films: number;
  /** 备注（可为空字符串） */
  note: string;
  /** 写入前重新计算出的、本次登记之后的剩余容量（恒 ≥ 0） */
  remainingAfter: number;
  /** 登记时间（ISO 8601） */
  createdAt: string;
}

/**
 * 容量更正凭证（不可修改）：登记时把某批药液的额定容量写错后的更正依据。
 *
 * 凭证只追加、不更新、不删除；批次创建时的 capacity 与历史记录的
 * remainingAfter 都不会被更正改写。后续余量与新记录一律以最新有效容量计算，
 * 存档校验则必须按凭证与用量实际发生的顺序分阶段重放，
 * 不能拿最终的新容量反验更正之前的记录。
 */
export interface CapacityCorrection {
  id: string;
  batchId: string;
  /** 原有效容量：本凭证提交前该批的有效容量（首张为创建容量） */
  fromCapacity: number;
  /** 新有效容量：本凭证提交后生效的容量（正的安全整数，且 ≥ 提交时已登记用量） */
  toCapacity: number;
  /** 更正原因（非空，已去除首尾空白） */
  reason: string;
  /** 批次内提交顺序：该批第几张凭证，从 1 开始连续编号 */
  sequence: number;
  /**
   * 阶段锚点：凭证提交时该批已存在的使用记录条数。
   * 凭证在第 recordsBefore 条记录之后、其后记录之前生效——
   * 存档校验据此把凭证插入到正确的阶段重放，而不依赖可能相同的时间戳；
   * 同一锚点上的连续多张凭证按 sequence 顺序依次生效。
   */
  recordsBefore: number;
  /** 提交时间（ISO 8601） */
  createdAt: string;
}

export interface LedgerState {
  batches: ChemicalBatch[];
  records: UsageRecord[];
  /**
   * 容量更正凭证（全局追加顺序）。旧版存档没有本字段，按空列表兼容；
   * 一旦出现就必须逐字段合法、序号连续、容量链不断裂、阶段锚点不越界。
   */
  corrections: CapacityCorrection[];
}

export const EMPTY_LEDGER: LedgerState = { batches: [], records: [], corrections: [] };

/** 命令依赖：时间与 id 生成器可注入，便于测试复现。 */
export interface LedgerDeps {
  now: () => Date;
  nextId: () => string;
}

/** 生产环境默认依赖。 */
export function defaultLedgerDeps(): LedgerDeps {
  let counter = 0;
  return {
    now: () => new Date(),
    nextId: () => {
      counter += 1;
      return `${Date.now().toString(36)}-${counter.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
    },
  };
}

export type CommandResult<T> =
  | { ok: true; value: T; state: LedgerState }
  | { ok: false; error: string };

/**
 * 严格解析整数字符串：拒绝空串、小数、非数字字符；
 * 超长数字（超过 Number.MAX_SAFE_INTEGER）也拒绝——
 * 这类数字无法精确表示（可能变为 Infinity 或被舍入），
 * 一旦入库会造成界面显示异常、持久化往返失败。
 */
function parseStrictInteger(raw: string): number | null {
  const text = raw.trim();
  if (text === '') return null;
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(value)) return null;
  return value;
}

/** 是否为「全是数字、但已超出安全整数范围」的超长输入（用于给出专用提示）。 */
function isUnsafeDigits(raw: string): boolean {
  const text = raw.trim();
  if (!/^[+-]?\d+$/.test(text)) return false;
  return !Number.isSafeInteger(Number.parseInt(text, 10));
}

/** 判断未知值是否为正的安全整数（用于快照结构校验）。 */
function isPositiveIntegerValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/**
 * 配液来源快照结构校验：六个数值均为正整数，
 * 且满足配液计算的核心不变量「浓缩液 + 清水 = 目标总量」。
 * 命令与持久化读取共用本校验。
 */
export function isMixSourceSnapshot(value: unknown): value is MixSourceSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isPositiveIntegerValue(candidate.n) ||
    !isPositiveIntegerValue(candidate.total) ||
    !isPositiveIntegerValue(candidate.capacity) ||
    !isPositiveIntegerValue(candidate.tanks) ||
    !isPositiveIntegerValue(candidate.concentrate) ||
    !isPositiveIntegerValue(candidate.water)
  ) {
    return false;
  }
  return candidate.concentrate + candidate.water === candidate.total;
}

/** 批次名称校验：空（含纯空白）不允许。 */
export function validateBatchName(name: string): string | undefined {
  if (name.trim() === '') return '请输入药液名称';
  return undefined;
}

/** 数字过大（超出安全整数范围）时的统一提示。 */
export const INTEGER_TOO_LARGE_MESSAGE = '数值过大，无法精确记录，请填写较小的整数';

/** 额定容量校验：可精确表示的正整数（拒绝超出安全整数范围的超长数字）。 */
export function validateCapacityInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入额定容量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '额定容量必须为整数，不能含小数或字母';
  if (value <= 0) return '额定容量须为大于 0 的整数';
  return undefined;
}

/** 登记数量校验：可精确表示的正整数（是否超过剩余容量由 recordUsage 判定）。 */
export function validateFilmsInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入等效胶片数量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '数量必须为整数，不能含小数或字母';
  if (value <= 0) return '数量须为大于 0 的整数';
  return undefined;
}

/** 某批次已登记用量之和（累计用量）。 */
export function usedCapacity(state: LedgerState, batchId: string): number {
  return state.records
    .filter((record) => record.batchId === batchId)
    .reduce((sum, record) => sum + record.films, 0);
}

/** 某批次的全部容量更正凭证，按批次内提交顺序（sequence）排列。 */
export function batchCorrections(state: LedgerState, batchId: string): CapacityCorrection[] {
  return state.corrections
    .filter((correction) => correction.batchId === batchId)
    .sort((a, b) => a.sequence - b.sequence);
}

/**
 * 某批次的当前有效容量：沿更正凭证链折叠出的最新容量。
 * 没有凭证时即为创建时的额定容量——批次选择、余量、耗尽判断、
 * 历史明细与存档重放都使用这同一个值，绝不另存一份「当前容量」。
 */
export function effectiveCapacity(state: LedgerState, batch: ChemicalBatch): number {
  let capacity = batch.capacity;
  for (const correction of batchCorrections(state, batch.id)) {
    capacity = correction.toCapacity;
  }
  return capacity;
}

/** 某批次当前剩余容量 = 当前有效容量 − 累计用量。 */
export function remainingCapacity(batch: ChemicalBatch, state: LedgerState): number {
  return effectiveCapacity(state, batch) - usedCapacity(state, batch.id);
}

/**
 * 状态由剩余量推导：剩余为 0 即已耗尽，否则使用中。
 * 负剩余在可信台账中不会出现（见 hasConsistentCapacityTrajectory）；
 * 即便如此也按已耗尽处理，绝不把已超用的药液标为「使用中」。
 */
export function batchStatus(batch: ChemicalBatch, state: LedgerState): BatchStatus {
  return remainingCapacity(batch, state) <= 0 ? 'exhausted' : 'active';
}

/** 某批次的全部使用记录，按登记时间（写入顺序）排列。 */
export function batchRecords(state: LedgerState, batchId: string): UsageRecord[] {
  return state.records.filter((record) => record.batchId === batchId);
}

/**
 * 容量轨迹一致性校验（持久化读取的最终闸门）。
 *
 * 批次选择、历史余量、耗尽判断与后续写入都依据同一份容量轨迹。
 * 更正凭证存在时，容量会随时间分段变化，因此必须按「凭证与用量发生的顺序」
 * 分阶段重放，而不能拿最终有效容量反验整张批次：
 *
 * - 批次 id 唯一：记录按 batchId 归属，同 id 的两个批次会让同一组
 *   使用记录被分别套到不同容量上，药液归属无法确认；
 * - 凭证按批次内序号（sequence，从 1 起连续）排成一条容量链，
 *   每张的 fromCapacity 必须等于链上前一容量（首张为创建容量），
 *   阶段锚点 recordsBefore 不得小于前一张（凭证不可倒插到更早阶段），
 *   也不得超过该批记录总数（凭证必须挂在真实发生的阶段上）；
 * - 逐条重放该批记录：先让所有「提交时已有记录数 = 当前已重放条数」的
 *   凭证生效（同一锚点上按序号连续变更容量），再用变更后的容量消费本条记录，
 *   任一阶段累计用量都不得超过当时的有效容量（剩余永不为负），
 *   每条记录的 remainingAfter 必须等于按当时阶段容量重放出的剩余量；
 * - 记录末尾再应用锚点在最后的凭证：更正后新容量不得低于已登记用量，
 *   且凭证链不得缺号（序号必须到 1..k 完整）。
 *
 * 命令（createBatch / recordUsage / correctCapacity）产出的状态恒满足本校验；
 * 不满足的存档视为不可信：不得加载为可写台账，也不得被普通操作覆盖。
 */
export function hasConsistentCapacityTrajectory(state: LedgerState): boolean {
  const capacityByBatchId = new Map<string, number>();
  for (const batch of state.batches) {
    if (capacityByBatchId.has(batch.id)) return false;
    capacityByBatchId.set(batch.id, batch.capacity);
  }

  // 先按批次收集凭证并做结构防御（正常路径下 storage 层已逐字段校验，
  // 这里是领域侧的最终闸门：手工构造的异常状态同样不得通过）。
  const correctionsByBatchId = new Map<string, CapacityCorrection[]>();
  const seenSequences = new Set<string>();
  for (const correction of state.corrections ?? []) {
    if (
      typeof correction.id !== 'string' ||
      correction.id.trim() === '' ||
      typeof correction.batchId !== 'string' ||
      typeof correction.reason !== 'string' ||
      correction.reason.trim() === '' ||
      !Number.isSafeInteger(correction.fromCapacity) ||
      correction.fromCapacity <= 0 ||
      !Number.isSafeInteger(correction.toCapacity) ||
      correction.toCapacity <= 0 ||
      !Number.isSafeInteger(correction.sequence) ||
      correction.sequence <= 0 ||
      !Number.isSafeInteger(correction.recordsBefore) ||
      correction.recordsBefore < 0 ||
      typeof correction.createdAt !== 'string'
    ) {
      return false;
    }
    if (!capacityByBatchId.has(correction.batchId)) return false;
    const sequenceKey = `${correction.batchId}#${correction.sequence}`;
    if (seenSequences.has(sequenceKey)) return false;
    seenSequences.add(sequenceKey);
    const list = correctionsByBatchId.get(correction.batchId) ?? [];
    list.push(correction);
    correctionsByBatchId.set(correction.batchId, list);
  }

  // 逐批按「凭证阶段 + 记录顺序」重放：不同批次互不影响。
  for (const batch of state.batches) {
    const corrections = (correctionsByBatchId.get(batch.id) ?? [])
      .slice()
      .sort((a, b) => a.sequence - b.sequence);
    const batchRecordCount = state.records.reduce(
      (count, record) => (record.batchId === batch.id ? count + 1 : count),
      0,
    );

    // 序号必须从 1 起连续；容量链不断裂；阶段锚点单调且不越界。
    let chainedCapacity = batch.capacity;
    let previousAnchor = 0;
    for (let index = 0; index < corrections.length; index += 1) {
      const correction = corrections[index];
      if (correction.sequence !== index + 1) return false;
      if (correction.fromCapacity !== chainedCapacity) return false;
      if (correction.recordsBefore < previousAnchor) return false;
      if (correction.recordsBefore > batchRecordCount) return false;
      previousAnchor = correction.recordsBefore;
      chainedCapacity = correction.toCapacity;
    }

    // 分阶段重放记录：anchor 指向下一张待生效的凭证。
    let anchor = 0;
    let phaseCapacity = batch.capacity;
    const applyDue = (consumedRecords: number) => {
      while (anchor < corrections.length && corrections[anchor].recordsBefore === consumedRecords) {
        phaseCapacity = corrections[anchor].toCapacity;
        anchor += 1;
      }
    };
    // 锚点为 0 的凭证（无任何使用记录时提交）在第一条记录之前生效。
    applyDue(0);

    let consumedRecords = 0;
    let usedFilms = 0;
    for (const record of state.records) {
      if (record.batchId !== batch.id) continue;
      // 记录字段同样做结构防御（films 为正整数、remainingAfter 为非负整数）
      if (
        !Number.isSafeInteger(record.films) ||
        record.films <= 0 ||
        !Number.isSafeInteger(record.remainingAfter) ||
        record.remainingAfter < 0
      ) {
        return false;
      }
      // 本条记录按其所处阶段的容量重放：早期记录用更正前容量，
      // 绝不拿最终有效容量反验。
      const next = phaseCapacity - usedFilms - record.films;
      // 超额：在当时的阶段容量下累计用量超过有效容量
      if (next < 0) return false;
      // 登记后剩余量必须与所处阶段的重放轨迹一致
      if (record.remainingAfter !== next) return false;
      usedFilms += record.films;
      consumedRecords += 1;
      // 本条之后到期的凭证在下一条记录之前生效
      applyDue(consumedRecords);
    }
    // 末尾凭证（锚点 = 记录总数）必须全部生效，且最新容量不得低于已登记用量。
    if (anchor !== corrections.length) return false;
    if (phaseCapacity - usedFilms < 0) return false;
  }

  // 防御：不允许挂在未知批次上的记录（上面的逐批循环覆盖不到时由这里兜底）
  for (const record of state.records) {
    if (!capacityByBatchId.has(record.batchId)) return false;
  }
  return true;
}

export interface CreateBatchInput {
  name: string;
  /** 表单原始字符串，由命令内部校验 */
  capacity: string;
  /**
   * 可选：配液来源快照，必须取自同一次配液计算结果。
   * 命令会校验其结构完整性，不合格时拒绝创建（不写入任何数据）。
   */
  mixSource?: MixSourceSnapshot;
}

/**
 * 命令一：创建药液批次。
 * 名称为空、额定容量为空 / 非整数 / 非正整数，或附带的配液来源快照
 * 结构不完整时返回原因，不写入任何记录。
 * 快照通过校验后逐字段拷贝并冻结，自此与后续计算无关（固定保存）。
 */
export function createBatch(
  state: LedgerState,
  input: CreateBatchInput,
  deps: LedgerDeps,
): CommandResult<ChemicalBatch> {
  const nameError = validateBatchName(input.name);
  if (nameError) return { ok: false, error: nameError };
  const capacityError = validateCapacityInput(input.capacity);
  if (capacityError) return { ok: false, error: capacityError };
  if (input.mixSource !== undefined && !isMixSourceSnapshot(input.mixSource)) {
    return { ok: false, error: '配液来源数据不完整，请重新计算后再存入' };
  }

  const batch: ChemicalBatch = Object.freeze({
    id: deps.nextId(),
    name: input.name.trim(),
    capacity: parseStrictInteger(input.capacity)!,
    createdAt: deps.now().toISOString(),
    ...(input.mixSource === undefined
      ? {}
      : {
          mixSource: Object.freeze({
            n: input.mixSource.n,
            total: input.mixSource.total,
            capacity: input.mixSource.capacity,
            tanks: input.mixSource.tanks,
            concentrate: input.mixSource.concentrate,
            water: input.mixSource.water,
          }),
        }),
  });
  return {
    ok: true,
    value: batch,
    state: { ...state, batches: [...state.batches, batch] },
  };
}

export interface RecordUsageInput {
  batchId: string;
  /** 表单原始字符串，由命令内部校验 */
  films: string;
  note?: string;
}

/**
 * 命令二：登记一次处理用量。
 * 写入前按**最新有效容量**重新计算剩余量（有效容量 − 已登记用量之和）：
 * 数量为空 / 非整数 / 非正整数 / 超过当前剩余容量时返回原因，不写入记录；
 * 成功后追加一条不可修改的使用记录，remainingAfter 记录登记后的剩余容量。
 * 历史 remainingAfter 不随后续容量更正变化（分阶段轨迹见
 * hasConsistentCapacityTrajectory）。
 */
export function recordUsage(
  state: LedgerState,
  input: RecordUsageInput,
  deps: LedgerDeps,
): CommandResult<UsageRecord> {
  const batch = state.batches.find((candidate) => candidate.id === input.batchId);
  if (!batch) {
    return { ok: false, error: '批次不存在或已被移除' };
  }
  const filmsError = validateFilmsInput(input.films);
  if (filmsError) return { ok: false, error: filmsError };

  const films = parseStrictInteger(input.films)!;
  // 每条记录写入前重新计算剩余量，而不是沿用界面上的旧值。
  const remaining = remainingCapacity(batch, state);
  if (films > remaining) {
    return {
      ok: false,
      error: `超过剩余容量：本批仅剩 ${remaining}，无法登记 ${films}`,
    };
  }
  const record: UsageRecord = Object.freeze({
    id: deps.nextId(),
    batchId: batch.id,
    films,
    note: (input.note ?? '').trim(),
    remainingAfter: remaining - films,
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: record,
    state: { ...state, records: [...state.records, record] },
  };
}

/** 更正原因校验：空（含纯空白）不允许——没有原因的容量更正不可追溯。 */
export function validateCorrectionReason(reason: string): string | undefined {
  if (reason.trim() === '') return '请输入更正原因';
  return undefined;
}

/**
 * 新有效容量校验：可精确表示的正整数。
 * 是否低于已登记用量由 correctCapacity 结合台账状态判定（需要现场累计）。
 */
export function validateNewCapacityInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入新有效容量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '新有效容量必须为整数，不能含小数或字母';
  if (value <= 0) return '新有效容量须为大于 0 的整数';
  return undefined;
}

export interface CorrectCapacityInput {
  batchId: string;
  /** 表单原始字符串，由命令内部校验 */
  newCapacity: string;
  /** 更正原因（必填，非空） */
  reason: string;
}

/**
 * 命令三：追加一张不可修改的容量更正凭证。
 *
 * 适用场景：批次建档时把额定可处理胶片数写错，但已产生的使用记录不能被重写。
 * 凭证固定记录批次、原有效容量、新有效容量、原因与批次内提交顺序：
 * - 批次不存在、新容量为空 / 非整数 / 非正整数 / 超出安全整数范围、
 *   原因为空时返回原因，不写入任何凭证；
 * - 新有效容量不得低于该批**当前已登记用量**，否则既有记录会立刻变成超额，
 *   历史轨迹无法自洽——调减的最低边界就是「已登记用量」（恰好相等时剩余 0）；
 * - 批次创建容量（batch.capacity）与历史记录的 remainingAfter 一律保持原样，
 *   后续登记与余量展示自动按最新有效容量计算。
 *
 * 命令只追加凭证（冻结对象），不修改批次、不修改任何历史记录、不修改传入状态。
 */
export function correctCapacity(
  state: LedgerState,
  input: CorrectCapacityInput,
  deps: LedgerDeps,
): CommandResult<CapacityCorrection> {
  const batch = state.batches.find((candidate) => candidate.id === input.batchId);
  if (!batch) {
    return { ok: false, error: '批次不存在或已被移除' };
  }
  const reasonError = validateCorrectionReason(input.reason);
  if (reasonError) return { ok: false, error: reasonError };
  const capacityError = validateNewCapacityInput(input.newCapacity);
  if (capacityError) return { ok: false, error: capacityError };

  const newCapacity = parseStrictInteger(input.newCapacity)!;
  // 已登记用量是调减的硬边界：新容量低于它会让历史记录立即超额，
  // 历史 remainingAfter 又不允许重写，轨迹将永远无法自洽。
  const used = usedCapacity(state, batch.id);
  if (newCapacity < used) {
    return {
      ok: false,
      error: `新有效容量不得低于该批已登记用量 ${used}，否则历史记录将超额`,
    };
  }

  const existing = batchCorrections(state, batch.id);
  const fromCapacity = existing.length === 0 ? batch.capacity : existing[existing.length - 1].toCapacity;
  const correction: CapacityCorrection = Object.freeze({
    id: deps.nextId(),
    batchId: batch.id,
    fromCapacity,
    toCapacity: newCapacity,
    reason: input.reason.trim(),
    sequence: existing.length + 1,
    // 阶段锚点：凭证在当前已存在的全部记录之后生效。
    recordsBefore: state.records.filter((record) => record.batchId === batch.id).length,
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: correction,
    state: { ...state, corrections: [...(state.corrections ?? []), correction] },
  };
}
