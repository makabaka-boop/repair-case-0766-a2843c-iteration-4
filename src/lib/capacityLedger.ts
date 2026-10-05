/**
 * 药液处理容量台账（领域服务）。
 *
 * 与配液计算相互独立：这里跟踪一批药液按「等效胶片数」计的额定容量、
 * 逐次登记的处理用量与剩余容量，避免凭记忆继续使用已耗尽的药液。
 *
 * 契约 = 三个命令（纯函数，不修改传入状态，返回新状态）：
 * - createBatch：创建带名称与额定容量的药液批次，可附带一份配液来源快照；
 * - recordUsage：向指定批次登记一次处理用量，写入前按**最新有效容量**重新计算剩余量，
 *   剩余量 = 最新有效容量 − 该批全部已登记用量之和；登记后剩余为 0 即「已耗尽」；
 * - correctCapacity：为容量台账追加一张不可修改的「容量更正凭证」，
 *   把批次的有效容量改为新值（调增 / 调减均可），不改动批次创建容量与任何历史记录。
 *
 * 使用记录与更正凭证一旦写入均不可修改：命令只追加、不更新、不删除；
 * 累计用量 / 有效容量 / 剩余容量 / 状态均由记录与凭证推导，不单独存储。
 * 有效容量 = 批次创建容量 + 该批全部更正凭证的差额（无凭证时即创建容量）。
 * hasConsistentCapacityTrajectory 校验一份状态能否按「凭证与用量实际发生顺序」
 * 完整分阶段重放，持久化层据此拒绝加载自相矛盾的存档（同 id 批次、超额用量、
 * 与各阶段容量不符的登记后剩余量、签发时容量对不上的凭证、断裂的提交顺序）。
 *
 * 配液来源快照（可选）：从配液计算结果区「存入容量台账」时，
 * 把同一次计算的稀释比例、目标总量、量筒容量、分罐数与浓缩液/清水体积
 * 逐字段拷贝固定保存，之后不随界面参数变化；手工创建的批次没有该字段。
 *
 * 校验失败时返回中文原因且不产生任何写入：
 * - 名称为空；
 * - 额定容量 / 胶片数量为空、非整数或非正整数；
 * - 数值超出安全整数范围（超长数字无法精确表示，显示会异常）；
 * - 登记数量超过当前剩余容量；
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
 * 容量更正凭证（不可修改，只能由 correctCapacity 追加）。
 *
 * 登记时发现批次的额定可处理胶片数填错时，用凭证把**有效容量**改为新值：
 * 批次的创建容量（ChemicalBatch.capacity）与全部历史使用记录
 * （含其 remainingAfter 快照）保持原样，之后的余量与新记录按最新有效容量计算。
 *
 * 凭证记录：所属批次、签发时的原有效容量、新有效容量、原因与提交顺序。
 * seq 是「凭证与用量提交顺序」中的全局稠密序号（1..N），
 * 存档校验据此把凭证精确插入使用记录之间，按各阶段容量重放，
 * 而不是拿最终容量反验早期记录。
 */
export interface CapacityCorrection {
  id: string;
  batchId: string;
  /** 凭证签发时该批次的原有效容量（正整数） */
  previousCapacity: number;
  /** 更正后的新有效容量（正整数，且不低于该批截至签发时的已登记用量） */
  newCapacity: number;
  /** 更正原因（非空，已去除首尾空白） */
  reason: string;
  /**
   * 全局稠密提交顺序：从 1 起，按「使用记录 + 更正凭证」的写入先后连续编号。
   * 同一批次重放时，按它把凭证插入对应序号的使用记录之间。
   */
  seq: number;
  /** 提交时间（ISO 8601） */
  createdAt: string;
}

export interface LedgerState {
  batches: ChemicalBatch[];
  records: UsageRecord[];
  /**
   * 容量更正凭证（按提交顺序追加）。
   * 旧版本状态没有该字段，领域函数一律兼容（视同空数组）；
   * 经持久化层读回的状态恒带该字段。
   */
  corrections?: CapacityCorrection[];
}

export const EMPTY_LEDGER: LedgerState = { batches: [], records: [], corrections: [] };

/** 该批全部更正凭证，按提交顺序排列（兼容无 corrections 字段的旧状态）。 */
export function batchCorrections(state: LedgerState, batchId: string): CapacityCorrection[] {
  return (state.corrections ?? []).filter((correction) => correction.batchId === batchId);
}

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

/** 更正原因校验：空（含纯空白）不允许——凭证必须能追溯为何更正。 */
export function validateCorrectionReason(reason: string): string | undefined {
  if (reason.trim() === '') return '请输入容量更正原因';
  return undefined;
}

/**
 * 更正后的新有效容量校验：可精确表示的正整数。
 * 「不得低于该批已登记用量」由 correctCapacity 在命令内结合最新台账判定
 * （界面输入阶段拿不到最新用量，且跨标签并发下用量可能已变化）。
 */
export function validateCorrectionCapacityInput(raw: string): string | undefined {
  if (raw.trim() === '') return '请输入新的有效容量';
  if (isUnsafeDigits(raw)) return INTEGER_TOO_LARGE_MESSAGE;
  const value = parseStrictInteger(raw);
  if (value === null) return '新容量必须为整数，不能含小数或字母';
  if (value <= 0) return '新容量须为大于 0 的整数';
  return undefined;
}

/** 某批次已登记用量之和（累计用量）。 */
export function usedCapacity(state: LedgerState, batchId: string): number {
  return state.records
    .filter((record) => record.batchId === batchId)
    .reduce((sum, record) => sum + record.films, 0);
}

/**
 * 某批次当前**有效容量**：创建容量 + 该批全部更正凭证的差额。
 * 无更正凭证时恒等于批次创建容量；调增 / 调减只体现在凭证里，
 * 批次自身的创建容量（batch.capacity）永不改变。
 */
export function effectiveCapacity(batch: ChemicalBatch, state: LedgerState): number {
  return batchCorrections(state, batch.id).reduce(
    (capacity, correction) => capacity + (correction.newCapacity - correction.previousCapacity),
    batch.capacity,
  );
}

/** 某批次当前剩余容量 = 有效容量 − 累计用量。 */
export function remainingCapacity(batch: ChemicalBatch, state: LedgerState): number {
  return effectiveCapacity(batch, state) - usedCapacity(state, batch.id);
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
 * 更正凭证出现后，容量随时间分阶段变化，因此必须按
 * **「凭证与用量实际发生顺序」分阶段重放**，不能拿最终容量反验早期记录：
 * 例如批次创建容量 10、登记 8 后把容量调减为 8，
 * 早期记录的 remainingAfter 必须按 10 − 8 = 2 验证，而不是 8 − 8 = 0。
 *
 * 事件顺序由凭证的全局稠密提交序号 seq（在「使用记录 + 更正凭证」
 * 的写入先后中从 1 连续编号）唯一确定：全局顺序中使用记录按其数组下标
 * 依次占位、凭证按 seq 占位。于是一份可信台账必须满足：
 * - 批次 id 唯一：记录 / 凭证按 batchId 归属，同 id 的两个批次会让同一组
 *   事件被分别套到多个容量上，药液归属无法确认；
 * - 每条使用记录与每张凭证都挂在已知批次上；
 * - 凭证 seq 互不相同，且恰好覆盖「跳过记录下标后」的全部位置
 *   （1..(记录数 + 凭证数) 中由凭证占据的那些位置）——提交顺序断裂或重号
 *   会让凭证与用量的先后无法确定；
 * - 分阶段重放每批事件：凭证签发时的原有效容量必须与其记录的 previousCapacity
 *   一致，新有效容量不得低于截至签发时该批已登记用量（余量不得为负）；
 *   使用记录在其所处阶段不得超过当时有效容量，且 remainingAfter 必须等于
 *   按该阶段容量重放出的剩余量。
 *
 * 命令（createBatch / recordUsage / correctCapacity）产出的状态恒满足本校验；
 * 不满足的存档视为不可信：不得加载为可写台账，也不得被普通操作覆盖。
 */
export function hasConsistentCapacityTrajectory(state: LedgerState): boolean {
  const corrections = state.corrections ?? [];
  const eventCount = state.records.length + corrections.length;

  // 批次 id 唯一，并初始化每批的阶段容量（创建容量）
  const capacityByBatchId = new Map<string, number>();
  for (const batch of state.batches) {
    if (capacityByBatchId.has(batch.id)) return false;
    capacityByBatchId.set(batch.id, batch.capacity);
  }

  // 使用记录与凭证必须挂在已知批次上
  for (const record of state.records) {
    if (!capacityByBatchId.has(record.batchId)) return false;
  }
  for (const correction of corrections) {
    if (!capacityByBatchId.has(correction.batchId)) return false;
  }

  // 把使用记录（按数组下标）与凭证（按 seq）合并为全局提交顺序：
  // 位置 1..eventCount 中，凭证按其稠密 seq 占位，其余位置由记录依次占位。
  // seq 重号、倒退、越界或断裂都会让合并无法对齐，整份台账不可信。
  type Event =
    | { kind: 'record'; record: UsageRecord }
    | { kind: 'correction'; correction: CapacityCorrection };
  const events: Event[] = [];
  let recordCursor = 0;
  let correctionCursor = 0;
  for (let position = 1; position <= eventCount; position += 1) {
    const nextCorrection = corrections[correctionCursor];
    if (nextCorrection && nextCorrection.seq === position) {
      events.push({ kind: 'correction', correction: nextCorrection });
      correctionCursor += 1;
    } else if (nextCorrection && nextCorrection.seq < position) {
      // seq 重号 / 倒退 / 非正整数：提交顺序无法对齐
      return false;
    } else if (recordCursor < state.records.length) {
      events.push({ kind: 'record', record: state.records[recordCursor] });
      recordCursor += 1;
    } else {
      // 记录已取完但位置仍对不上下一张凭证：顺序断裂
      return false;
    }
  }

  // 按全局提交顺序重放：每批只消费归属自己的事件，相对先后与全局一致。
  // usedByBatchId 记录各批截至当前事件已登记用量；阶段容量随凭证变化。
  const usedByBatchId = new Map<string, number>(
    [...capacityByBatchId.keys()].map((id) => [id, 0]),
  );
  for (const event of events) {
    if (event.kind === 'correction') {
      const { correction } = event;
      const capacity = capacityByBatchId.get(correction.batchId)!;
      const used = usedByBatchId.get(correction.batchId)!;
      // 凭证签发时的原有效容量必须与其所处阶段的重放值一致：
      // 不能拿最终容量或其它阶段容量冒充「原值」。
      if (correction.previousCapacity !== capacity) return false;
      // 新有效容量不得低于截至签发时已登记用量：不允许把已登记用量改成超额。
      if (correction.newCapacity < used) return false;
      capacityByBatchId.set(correction.batchId, correction.newCapacity);
      continue;
    }

    const { record } = event;
    const capacity = capacityByBatchId.get(record.batchId)!;
    const used = usedByBatchId.get(record.batchId)!;
    const nextRemaining = capacity - (used + record.films);
    // 超额：该阶段累计用量超过当时有效容量，剩余量为负
    if (nextRemaining < 0) return false;
    // 登记后剩余量必须等于按该阶段容量重放的值，而不是用最终容量反推
    if (record.remainingAfter !== nextRemaining) return false;
    usedByBatchId.set(record.batchId, used + record.films);
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
 * 写入前按最新有效容量重新计算剩余量（有效容量 − 已登记用量之和）：
 * 数量为空 / 非整数 / 非正整数 / 超过当前剩余容量时返回原因，不写入记录；
 * 成功后追加一条不可修改的使用记录，remainingAfter 记录其所处容量阶段登记后的剩余容量
 * （历史快照，之后的容量更正不会回改它）。
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

export interface CorrectCapacityInput {
  batchId: string;
  /** 表单原始字符串：新的有效容量，由命令内部校验 */
  newCapacity: string;
  /** 更正原因（必填，命令内部去除首尾空白并校验非空） */
  reason: string;
}

/**
 * 命令三：追加一张不可修改的「容量更正凭证」。
 *
 * 用于登记时发现批次的额定可处理胶片数写错的情形：
 * - 不修改批次的创建容量（batch.capacity），也不重写任何历史使用记录
 *   （含其 remainingAfter 快照）——只追加凭证；
 * - 新容量须为正的安全整数，且不得低于该批截至提交时的已登记用量
 *   （否则会把既有登记变成超额、余量变负，凭证连同原因一起被拒绝）；
 * - 与当前有效容量相同的「无变化更正」同样拒绝，不产生空凭证、不推进修订号；
 * - seq 取「使用记录 + 更正凭证」的下一个全局提交位置（稠密、连续），
 *   存档校验据此把凭证精确插回用量之间分阶段重放。
 *
 * 成功后的后续登记按新的有效容量计算余量；凭证本身与使用记录一样冻结、
 * 只追加，界面不提供编辑或删除入口。
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
  const capacityError = validateCorrectionCapacityInput(input.newCapacity);
  if (capacityError) return { ok: false, error: capacityError };

  const newCapacityValue = parseStrictInteger(input.newCapacity)!;
  // 命令在最新台账上重放：以最新有效容量与最新累计用量为准，
  // 绝不依据界面上可能已过期的余量。
  const previousCapacity = effectiveCapacity(batch, state);
  const used = usedCapacity(state, batch.id);
  if (newCapacityValue < used) {
    return {
      ok: false,
      error: `新有效容量不得低于该批已登记用量：已登记 ${used}，无法更正为 ${newCapacityValue}`,
    };
  }
  if (newCapacityValue === previousCapacity) {
    return { ok: false, error: '新有效容量与当前有效容量相同，无需更正' };
  }

  const corrections = state.corrections ?? [];
  const correction: CapacityCorrection = Object.freeze({
    id: deps.nextId(),
    batchId: batch.id,
    previousCapacity,
    newCapacity: newCapacityValue,
    reason: input.reason.trim(),
    // 全局稠密提交顺序：凭证与使用记录共享同一条提交位置序列
    seq: state.records.length + corrections.length + 1,
    createdAt: deps.now().toISOString(),
  });
  return {
    ok: true,
    value: correction,
    state: { ...state, corrections: [...corrections, correction] },
  };
}
