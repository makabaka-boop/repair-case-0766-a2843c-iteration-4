import { useEffect, useRef, useState } from 'react';
import {
  BATCH_STATUS_LABEL,
  batchCorrections,
  batchRecords,
  batchStatus,
  effectiveCapacity,
  remainingCapacity,
  usedCapacity,
  validateBatchName,
  validateCapacityInput,
  validateCorrectionCapacityInput,
  validateCorrectionReason,
  validateFilmsInput,
} from './lib/capacityLedger';
import type { CommitOutcome, LedgerDocument, LedgerIntent } from './lib/ledgerStorage';

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false });
}

export interface LedgerProps {
  /** 当前台账文档（台账 + 修订号，由 App 持有并随存储同步） */
  doc: LedgerDocument;
  /**
   * 跨标签安全的提交：在存储最新台账上重放命令并比较修订号。
   * 成功才落账；冲突 / 存储失败 / 损坏时整体拒绝并返回最新完整文档。
   */
  onCommit: (intent: LedgerIntent) => CommitOutcome;
  /** 当前选中的批次 id（由 App 持有，配液建档后可跳转选中） */
  selectedId: string | null;
  onSelectBatch: (id: string | null) => void;
  /** 启动时读取到损坏 / 被策略阻止的存储：就地提示，不做任何写回 */
  storageCorrupted: boolean;
}

/**
 * 容量台账视图：创建药液批次 → 选中批次登记用量 → 按时间查看使用记录。
 *
 * 所有写入都经过 onCommit（乐观并发提交）：
 * - 领域规则拒绝（非法输入、超剩余容量）→ 对应字段下方就地说明，不写存储；
 * - 其他页面已提交（修订号冲突）或 localStorage 写入失败 →
 *   顶部就地说明，本次动作不记账，界面回显存储中的最后完整台账；
 * - 其他标签页写入后，App 通过 storage 事件把最新台账推送到本视图，
 *   批次状态与剩余量自动刷新，无需手动重载。
 */
export default function Ledger({ doc, onCommit, selectedId, onSelectBatch, storageCorrupted }: LedgerProps) {
  const ledger = doc.ledger;

  // 新建批次表单
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [capacityError, setCapacityError] = useState<string | null>(null);

  // 登记用量表单
  const [films, setFilms] = useState('');
  const [note, setNote] = useState('');
  const [filmsError, setFilmsError] = useState<string | null>(null);

  // 容量更正表单（凭证只追加、不可修改）
  const [newCapacity, setNewCapacity] = useState('');
  const [reason, setReason] = useState('');
  const [newCapacityError, setNewCapacityError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);

  // 冲突 / 存储失败等动作级错误（不属于单个输入字段）
  const [commitError, setCommitError] = useState<string | null>(null);
  // 最近一次「失败后对齐到的修订号」：此时 revision 变化是本次失败的结果，
  // 不能误清掉刚展示的错误提示（见下方 effect）。
  const failedAtRevision = useRef<number | null>(null);

  const selected = ledger.batches.find((batch) => batch.id === selectedId) ?? null;
  const selectedRecords = selected ? batchRecords(ledger, selected.id) : [];
  const selectedCorrections = selected ? batchCorrections(ledger, selected.id) : [];

  // 外部标签页写入（storage 事件）导致文档变化时，清掉已失效的动作级提示；
  // 但要跳过「本组件一次失败提交把视图对齐到最新文档」引发的同一次变化，
  // 否则冲突 / 存储失败提示刚展示就会被清掉。
  useEffect(() => {
    if (failedAtRevision.current === doc.revision) return;
    setCommitError(null);
  }, [doc.revision]);

  // 切换（或取消）选中批次时，丢弃上一批尚未提交的用量 / 备注草稿与错误，
  // 避免操作员在 A 批次填写后直接记到 B 批次（跨批次误登记）。
  // 仅随选中批次变化触发：同批次内登记成功后由提交逻辑自行清空输入。
  const selectedKey = selected?.id ?? null;
  useEffect(() => {
    setFilms('');
    setNote('');
    setFilmsError(null);
    // 容量更正草稿同样按批次隔离，避免给 A 批填的新容量误提到 B 批
    setNewCapacity('');
    setReason('');
    setNewCapacityError(null);
    setReasonError(null);
  }, [selectedKey]);

  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // 先把字段级错误放到对应输入框下方；提交时命令仍会再校验一次（最终闸门）。
    const nameErr = validateBatchName(name);
    const capacityErr = validateCapacityInput(capacity);
    setNameError(nameErr ?? null);
    setCapacityError(capacityErr ?? null);
    setCommitError(null);
    if (nameErr || capacityErr) return;

    const outcome = onCommit({ type: 'createBatch', input: { name, capacity } });
    if (outcome.ok) {
      const created = outcome.intent.result.ok ? outcome.intent.result.value : null;
      onSelectBatch(created ? created.id : null);
      setName('');
      setCapacity('');
      setCommitError(null);
      return;
    }
    if (outcome.kind === 'rejected') {
      const result = outcome.intent.result;
      if (!result.ok) {
        if (result.error === '请输入药液名称') setNameError(result.error);
        else setCapacityError(result.error);
      }
      return;
    }
    // 冲突 / 存储失败 / 损坏：批次未创建，表单保留便于核对后重试。
    // 记录「失败后对齐到的修订号」：App 会把文档换成 outcome.doc，
    // 这里提前记下其修订号，避免对齐触发的 effect 清掉本次提示。
    failedAtRevision.current = outcome.doc.revision;
    setCommitError(outcome.error);
  };

  const submitUsage = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const filmsErr = validateFilmsInput(films);
    setFilmsError(filmsErr ?? null);
    setCommitError(null);
    if (filmsErr) return;

    const outcome = onCommit({ type: 'recordUsage', input: { batchId: selected.id, films, note } });
    if (outcome.ok) {
      setFilms('');
      setNote('');
      setCommitError(null);
      return;
    }
    if (outcome.kind === 'rejected') {
      const result = outcome.intent.result;
      // 超过剩余容量等命令级错误同样就地说明，且不写入任何记录
      if (!result.ok) setFilmsError(result.error);
      return;
    }
    // 冲突 / 存储失败 / 损坏：本次用量未记账。
    // 冲突时界面已随最新文档刷新（剩余量、记录列表都是最新）；
    // 存储失败时文档保持最后完整台账，输入保留，操作员可重试或放弃。
    failedAtRevision.current = outcome.doc.revision;
    setCommitError(outcome.error);
  };

  const submitCorrection = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const capacityErr = validateCorrectionCapacityInput(newCapacity);
    const reasonErr = validateCorrectionReason(reason);
    setNewCapacityError(capacityErr ?? null);
    setReasonError(reasonErr ?? null);
    setCommitError(null);
    if (capacityErr || reasonErr) return;

    const outcome = onCommit({
      type: 'correctCapacity',
      input: { batchId: selected.id, newCapacity, reason },
    });
    if (outcome.ok) {
      // 只有真正写回成功才清空表单并展示新的有效容量；
      // 失败路径下界面回显的都是存储中的最后完整台账，绝不显示虚假的新增余量。
      setNewCapacity('');
      setReason('');
      setCommitError(null);
      return;
    }
    if (outcome.kind === 'rejected') {
      const result = outcome.intent.result;
      // 低于已登记用量等命令级错误放在新容量字段下方，原因字段错误就地说明
      if (!result.ok) {
        if (result.error === '请输入容量更正原因') setReasonError(result.error);
        else setNewCapacityError(result.error);
      }
      return;
    }
    // 冲突 / 存储失败 / 损坏：本次更正未生效，草稿保留便于核对后重试。
    failedAtRevision.current = outcome.doc.revision;
    setCommitError(outcome.error);
  };

  return (
    <>
      {(storageCorrupted || commitError) && (
        <p className="error ledger-banner" role="alert" data-testid="ledger-error">
          {storageCorrupted
            ? '本地台账无法读取或已损坏，为避免覆盖可追溯数据，当前不会写入任何登记；请刷新页面核对存储内容。'
            : commitError}
        </p>
      )}

      <section className="panel no-print" aria-label="新建药液批次">
        <h2 className="panel-title">新建药液批次</h2>
        <form onSubmit={submitCreate} noValidate>
          <div className="fields">
            <div className={`field${nameError ? ' field--invalid' : ''}`}>
              <label htmlFor="batch-name-input">药液名称</label>
              <input
                id="batch-name-input"
                data-testid="batch-name-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameError(null);
                }}
                aria-invalid={Boolean(nameError)}
                aria-describedby="error-batch-name batch-name-hint"
              />
              <small id="batch-name-hint" className="hint">
                如：D-76 显影液（2026-09 配制）
              </small>
              {nameError && (
                <p className="error" role="alert" id="error-batch-name" data-testid="error-batch-name">
                  {nameError}
                </p>
              )}
            </div>
            <div className={`field${capacityError ? ' field--invalid' : ''}`}>
              <label htmlFor="batch-capacity-input">额定容量（等效胶片数）</label>
              <input
                id="batch-capacity-input"
                data-testid="batch-capacity-input"
                inputMode="numeric"
                value={capacity}
                onChange={(event) => {
                  setCapacity(event.target.value);
                  setCapacityError(null);
                }}
                aria-invalid={Boolean(capacityError)}
                aria-describedby="error-batch-capacity batch-capacity-hint"
              />
              <small id="batch-capacity-hint" className="hint">
                整批药液可处理的等效胶片总数，正整数
              </small>
              {capacityError && (
                <p
                  className="error"
                  role="alert"
                  id="error-batch-capacity"
                  data-testid="error-batch-capacity"
                >
                  {capacityError}
                </p>
              )}
            </div>
          </div>
          <button type="submit" className="action-button" data-testid="create-batch-button">
            创建批次
          </button>
        </form>
      </section>

      <section className="panel no-print" aria-label="药液批次列表">
        <h2 className="panel-title">药液批次</h2>
        {ledger.batches.length === 0 ? (
          <p className="note" data-testid="batch-empty">
            还没有药液批次，请先在上方创建。
          </p>
        ) : (
          <ul className="batch-list" data-testid="batch-list">
            {ledger.batches.map((batch) => {
              const status = batchStatus(batch, ledger);
              const isSelected = batch.id === selectedId;
              return (
                <li key={batch.id}>
                  <button
                    type="button"
                    className={`batch-item${isSelected ? ' batch-item--selected' : ''}`}
                    data-testid="batch-item"
                    aria-pressed={isSelected}
                    onClick={() => {
                      onSelectBatch(batch.id);
                    }}
                  >
                    <span className="batch-item__head">
                      <strong data-testid="batch-name">{batch.name}</strong>
                      <span className={`status status--${status}`} data-testid="batch-status">
                        {BATCH_STATUS_LABEL[status]}
                      </span>
                    </span>
                    <span className="batch-item__meta">
                      累计用量 <strong data-testid="batch-used">{usedCapacity(ledger, batch.id)}</strong>
                      　剩余 <strong data-testid="batch-remaining">
                        {remainingCapacity(batch, ledger)}
                      </strong>
                      　有效容量 <strong data-testid="batch-effective">{effectiveCapacity(batch, ledger)}</strong>
                      　建档额定 <span data-testid="batch-capacity">{batch.capacity}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {selected && (
        <section className="panel no-print" aria-label="登记用量" data-testid="usage-panel">
          <h2 className="panel-title">登记用量：{selected.name}</h2>
          <dl className="summary">
            <div>
              <dt>累计用量</dt>
              <dd data-testid="detail-used">{usedCapacity(ledger, selected.id)}</dd>
            </div>
            <div>
              <dt>有效容量</dt>
              <dd data-testid="detail-effective">{effectiveCapacity(selected, ledger)}</dd>
            </div>
            <div>
              <dt>剩余容量</dt>
              <dd data-testid="detail-remaining">{remainingCapacity(selected, ledger)}</dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd data-testid="detail-status">{BATCH_STATUS_LABEL[batchStatus(selected, ledger)]}</dd>
            </div>
          </dl>
          <p className="note" data-testid="detail-original-capacity">
            建档额定容量 {selected.capacity}（创建后不修改）
            {selectedCorrections.length > 0 &&
              `；历经 ${selectedCorrections.length} 次容量更正，当前有效容量 ${effectiveCapacity(selected, ledger)}`}
          </p>
          {selected.mixSource && (
            <p className="mix-source" data-testid="mix-source-summary">
              配液来源：稀释式 1+{selected.mixSource.n}，目标总量 {selected.mixSource.total} mL，
              量筒容量 {selected.mixSource.capacity} mL，显影罐 {selected.mixSource.tanks} 只，
              浓缩液 {selected.mixSource.concentrate} mL ＋ 清水 {selected.mixSource.water} mL
            </p>
          )}
          {batchStatus(selected, ledger) === 'exhausted' && (
            <p className="note" data-testid="exhausted-note">
              本批药液已耗尽，请配制新批次，不要继续使用。
            </p>
          )}

          <form onSubmit={submitUsage} noValidate>
            <div className="fields">
              <div className={`field${filmsError ? ' field--invalid' : ''}`}>
                <label htmlFor="films-input">本次处理（等效胶片数）</label>
                <input
                  id="films-input"
                  data-testid="films-input"
                  inputMode="numeric"
                  value={films}
                  onChange={(event) => {
                    setFilms(event.target.value);
                    setFilmsError(null);
                  }}
                  aria-invalid={Boolean(filmsError)}
                  aria-describedby="error-films films-hint"
                />
                <small id="films-hint" className="hint">
                  正整数，不得超过剩余容量
                </small>
                {filmsError && (
                  <p className="error" role="alert" id="error-films" data-testid="error-films">
                    {filmsError}
                  </p>
                )}
              </div>
              <div className="field">
                <label htmlFor="note-input">备注（可选）</label>
                <input
                  id="note-input"
                  data-testid="note-input"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  aria-describedby="note-hint"
                />
                <small id="note-hint" className="hint">
                  如：4 卷 135，正常冲洗
                </small>
              </div>
            </div>
            <button type="submit" className="action-button" data-testid="record-usage-button">
              登记用量
            </button>
          </form>

          <h3 className="records-title">容量更正凭证</h3>
          <p className="note">
            登记时发现额定可处理胶片数填错时，在此追加更正凭证：新容量须为正整数且不低于本批已登记用量；
            建档容量与历史登记余量保持原样，后续登记按最新有效容量计算。
          </p>
          <form onSubmit={submitCorrection} noValidate data-testid="correction-form">
            <div className="fields">
              <div className={`field${newCapacityError ? ' field--invalid' : ''}`}>
                <label htmlFor="correction-capacity-input">新的有效容量（等效胶片数）</label>
                <input
                  id="correction-capacity-input"
                  data-testid="correction-capacity-input"
                  inputMode="numeric"
                  value={newCapacity}
                  onChange={(event) => {
                    setNewCapacity(event.target.value);
                    setNewCapacityError(null);
                  }}
                  aria-invalid={Boolean(newCapacityError)}
                  aria-describedby="error-correction-capacity correction-capacity-hint"
                />
                <small id="correction-capacity-hint" className="hint">
                  当前有效 {effectiveCapacity(selected, ledger)}，已登记 {usedCapacity(ledger, selected.id)}；
                  调增 / 调减均可，但不得低于已登记用量
                </small>
                {newCapacityError && (
                  <p
                    className="error"
                    role="alert"
                    id="error-correction-capacity"
                    data-testid="error-correction-capacity"
                  >
                    {newCapacityError}
                  </p>
                )}
              </div>
              <div className={`field${reasonError ? ' field--invalid' : ''}`}>
                <label htmlFor="correction-reason-input">更正原因</label>
                <input
                  id="correction-reason-input"
                  data-testid="correction-reason-input"
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setReasonError(null);
                  }}
                  aria-invalid={Boolean(reasonError)}
                  aria-describedby="error-correction-reason correction-reason-hint"
                />
                <small id="correction-reason-hint" className="hint">
                  如：登记时把额定容量 10 误写为 8
                </small>
                {reasonError && (
                  <p
                    className="error"
                    role="alert"
                    id="error-correction-reason"
                    data-testid="error-correction-reason"
                  >
                    {reasonError}
                  </p>
                )}
              </div>
            </div>
            <button type="submit" className="action-button" data-testid="correct-capacity-button">
              追加容量更正凭证
            </button>
          </form>

          {selectedCorrections.length > 0 && (
            <ol className="usage-list correction-list" data-testid="correction-list">
              {selectedCorrections.map((correction) => (
                <li key={correction.id} className="usage-item correction-item" data-testid="correction-item">
                  <span className="usage-item__time" data-testid="correction-time">
                    {formatTime(correction.createdAt)}
                  </span>
                  <span data-testid="correction-change">
                    有效容量 <strong data-testid="correction-previous">{correction.previousCapacity}</strong>
                    {' → '}
                    <strong data-testid="correction-new">{correction.newCapacity}</strong>
                    （凭证序号 {correction.seq}）
                  </span>
                  <em data-testid="correction-reason">原因：{correction.reason}</em>
                </li>
              ))}
            </ol>
          )}

          <h3 className="records-title">使用记录</h3>
          {selectedRecords.length === 0 ? (
            <p className="note" data-testid="usage-empty">
              暂无使用记录。
            </p>
          ) : (
            <ol className="usage-list" data-testid="usage-list">
              {selectedRecords.map((record) => (
                <li key={record.id} className="usage-item" data-testid="usage-item">
                  <span className="usage-item__time" data-testid="usage-time">
                    {formatTime(record.createdAt)}
                  </span>
                  <span>
                    处理 <strong data-testid="usage-films">{record.films}</strong>（等效胶片）
                    {record.note !== '' && <em data-testid="usage-note">　备注：{record.note}</em>}
                  </span>
                  <span className="usage-item__remaining">
                    剩余 <strong data-testid="usage-remaining">{record.remainingAfter}</strong>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </>
  );
}
