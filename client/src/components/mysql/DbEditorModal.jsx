import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import GlassModal from '@/components/common/GlassModal';
import LiquidButton from '@/components/common/LiquidButton';
import EmptyState from '@/components/common/EmptyState';
import LoadingState from '@/components/common/LoadingState';
import {
  getDbTables,
  getDbTableStructure,
  getDbTableRows,
  insertDbRow,
  updateDbRow,
  deleteDbRow,
} from '@/api/mysql';
import { formatBytesSize } from '@/utils/format';
import {
  Pencil, Trash2, Plus, RefreshCw, Check, X, ArrowUp, ArrowDown, FileText,
} from '@/components/common/Icons';
import { useUIStore } from '@/components/common/uiStore';

const PAGE_SIZES = [10, 20, 50, 100];

function isBinary(value) {
  return Boolean(value && typeof value === 'object' && value.binary);
}

function isBinaryType(type) {
  return /(blob|binary)/i.test(String(type || ''));
}

// 只有 auto_increment 和真正的生成列不可编辑；DEFAULT_GENERATED（默认值表达式）仍可写入
function isGenerated(col) {
  return /auto_increment|virtual generated|stored generated/i.test(String(col?.extra || ''));
}

// 解析 enum/set 类型里的可选值，供表单下拉使用
function parseOptions(type) {
  const match = /^(enum|set)\((.*)\)$/i.exec(String(type || ''));
  if (!match) return null;
  return match[2].split(',').map((item) => {
    const value = item.trim();
    return value.replace(/^'(.*)'$/, (_, inner) => inner.replace(/''/g, "'"));
  });
}

export default function DbEditorModal({ db, onClose }) {
  const { t } = useTranslation();
  const toast = useUIStore((s) => s.toast);
  const uiConfirm = useUIStore((s) => s.confirm);
  const open = Boolean(db);

  const [tables, setTables] = useState([]);
  const [activeTable, setActiveTable] = useState('');
  const [tab, setTab] = useState('data');
  const [columns, setColumns] = useState([]);
  const [primaryKey, setPrimaryKey] = useState([]);
  const [indexes, setIndexes] = useState([]);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [orderBy, setOrderBy] = useState('');
  const [orderDir, setOrderDir] = useState('asc');
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingRows, setLoadingRows] = useState(false);
  const [editor, setEditor] = useState(null);
  const [form, setForm] = useState({});
  const [nullFlags, setNullFlags] = useState({});
  const [saving, setSaving] = useState(false);
  const [deletingKey, setDeletingKey] = useState('');

  const fetchTables = useCallback(async () => {
    if (!db) return;
    setLoadingTables(true);
    try {
      const data = await getDbTables(db);
      const list = data.tables || [];
      setTables(list);
      if (list.length) {
        setActiveTable(list[0].name);
        setPage(1);
      }
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setLoadingTables(false);
    }
  }, [db, toast]);

  const loadRows = useCallback(async () => {
    if (!db || !activeTable) return;
    setLoadingRows(true);
    try {
      const data = await getDbTableRows(db, activeTable, { page, pageSize, orderBy, orderDir });
      setColumns(data.columns || []);
      setPrimaryKey(data.primaryKey || []);
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch (err) {
      setRows([]);
      setTotal(0);
      toast(err?.message || String(err), 'error');
    } finally {
      setLoadingRows(false);
    }
  }, [db, activeTable, page, pageSize, orderBy, orderDir, toast]);

  useEffect(() => {
    if (!open) return;
    // 切换库时重置浏览状态
    setTables([]);
    setActiveTable('');
    setTab('data');
    setColumns([]);
    setPrimaryKey([]);
    setIndexes([]);
    setRows([]);
    setTotal(0);
    setPage(1);
    setPageSize(20);
    setOrderBy('');
    setOrderDir('asc');
    setEditor(null);
    fetchTables();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, db]);

  useEffect(() => {
    if (!open || !activeTable) return;
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeTable, page, pageSize, orderBy, orderDir]);

  // 结构页展示索引信息，按需加载
  useEffect(() => {
    if (!open || !activeTable || tab !== 'structure') return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getDbTableStructure(db, activeTable);
        if (!cancelled) setIndexes(data.indexes || []);
      } catch (err) {
        if (!cancelled) toast(err?.message || String(err), 'error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, db, activeTable, tab, toast]);

  const currentTable = tables.find((item) => item.name === activeTable);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const readOnlyTable = !primaryKey.length || Boolean(currentTable?.isView);

  function selectTable(name) {
    setActiveTable(name);
    setPage(1);
    setOrderBy('');
    setOrderDir('asc');
    setEditor(null);
  }

  function toggleSort(name) {
    if (orderBy === name) {
      setOrderDir(orderDir === 'asc' ? 'desc' : 'asc');
    } else {
      setOrderBy(name);
      setOrderDir('asc');
    }
    setPage(1);
  }

  function openCreate() {
    const initial = {};
    const flags = {};
    for (const col of columns) {
      initial[col.name] = '';
      flags[col.name] = false;
    }
    setForm(initial);
    setNullFlags(flags);
    setEditor({ mode: 'create', row: null });
  }

  function openEdit(row) {
    const initial = {};
    const flags = {};
    for (const col of columns) {
      const value = row[col.name];
      if (isBinary(value)) {
        initial[col.name] = '';
        flags[col.name] = false;
        continue;
      }
      flags[col.name] = value === null;
      initial[col.name] = value === null ? '' : String(value);
    }
    setForm(initial);
    setNullFlags(flags);
    setEditor({ mode: 'edit', row });
  }

  function buildKey(row) {
    const key = {};
    for (const name of primaryKey) {
      const value = row?.[name];
      if (value === undefined || isBinary(value)) return null;
      key[name] = value;
    }
    return key;
  }

  async function handleSave() {
    if (!editor) return;
    const values = {};
    for (const col of columns) {
      if (isGenerated(col) || isBinaryType(col.type)) continue;
      const value = nullFlags[col.name] ? null : String(form[col.name] ?? '');
      if (editor.mode === 'create') {
        values[col.name] = value;
        continue;
      }
      const prev = editor.row?.[col.name];
      const changed = value === null ? prev !== null : String(prev ?? '') !== value;
      if (changed) values[col.name] = value;
    }
    if (editor.mode === 'edit' && !Object.keys(values).length) {
      setEditor(null);
      return;
    }
    setSaving(true);
    try {
      if (editor.mode === 'create') {
        await insertDbRow(db, activeTable, values);
        toast(t('mysql.editor.created'), 'success');
      } else {
        const key = buildKey(editor.row);
        if (!key) throw new Error(t('mysql.editor.noPkValue'));
        await updateDbRow(db, activeTable, key, values);
        toast(t('mysql.editor.updated'), 'success');
      }
      setEditor(null);
      await loadRows();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(row) {
    const key = buildKey(row);
    if (!key) {
      toast(t('mysql.editor.noPkValue'), 'error');
      return;
    }
    const keyText = primaryKey.map((name) => `${name}=${String(row[name])}`).join('，');
    const ok = await uiConfirm({
      title: t('mysql.editor.delete'),
      message: t('mysql.editor.deleteConfirm', { key: keyText }),
      confirmText: t('mysql.editor.delete'),
    });
    if (!ok) return;
    setDeletingKey(JSON.stringify(key));
    try {
      await deleteDbRow(db, activeTable, key);
      toast(t('mysql.editor.deleted'), 'success');
      await loadRows();
    } catch (err) {
      toast(err?.message || String(err), 'error');
    } finally {
      setDeletingKey('');
    }
  }

  function renderCell(col, value) {
    if (value === null || value === undefined) {
      return <span className="italic text-white/35">NULL</span>;
    }
    if (isBinary(value)) {
      return (
        <span className="text-white/40">
          {t('mysql.editor.binaryValue', { size: formatBytesSize(value.length || 0) })}
        </span>
      );
    }
    const text = String(value);
    return (
      <span className="block max-w-[260px] truncate" title={text.length > 60 ? text : undefined}>
        {text}
      </span>
    );
  }

  function renderField(col) {
    const options = parseOptions(col.type);
    const binary = isBinaryType(col.type);
    const locked = binary || (Boolean(editor?.mode === 'create') && isGenerated(col));
    const value = form[col.name] ?? '';
    const setValue = (next) => setForm((prev) => ({ ...prev, [col.name]: next }));
    const disabled = locked || nullFlags[col.name];

    return (
      <div key={col.name} className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs text-white/70">
            <span className="font-mono text-cyan-300">{col.name}</span>
            <span className="text-white/35">{col.type}</span>
            {col.key ? <span className="text-[10px] text-amber-300">{col.key}</span> : null}
          </label>
          {col.nullable ? (
            <label className="flex flex-none items-center gap-1 text-[11px] text-white/50">
              <input
                type="checkbox"
                checked={Boolean(nullFlags[col.name])}
                onChange={(e) => setNullFlags((prev) => ({ ...prev, [col.name]: e.target.checked }))}
                className="h-3.5 w-3.5 accent-cyan-500"
              />
              NULL
            </label>
          ) : null}
        </div>
        {options ? (
          <select
            value={nullFlags[col.name] ? '' : value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-400 disabled:opacity-40"
          >
            <option value="">（空）</option>
            {options.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        ) : /text|json/i.test(col.type) || binary ? (
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
            rows={3}
            placeholder={binary ? t('mysql.editor.binaryReadonly') : ''}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs outline-none focus:border-cyan-400 disabled:opacity-40"
          />
        ) : (
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            disabled={disabled}
            placeholder={isGenerated(col) ? t('mysql.editor.generatedHint') : ''}
            className="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none focus:border-cyan-400 disabled:opacity-40"
          />
        )}
        {col.comment ? <p className="text-[11px] text-white/35">{col.comment}</p> : null}
      </div>
    );
  }

  return (
    <>
      <GlassModal
        open={open}
        onClose={onClose}
        maxWidth="max-w-6xl"
        title={t('mysql.editor.title')}
        subtitle={db ? `${db} · ${t('mysql.editor.subtitle')}` : ''}
      >
        <div className="flex flex-col gap-4 lg:flex-row">
          {/* 左侧数据表列表 */}
          <div className="lg:w-56 lg:flex-none">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs text-white/50">{t('mysql.editor.tables')}</span>
              <button
                type="button"
                onClick={fetchTables}
                disabled={loadingTables}
                title={t('mysql.editor.refresh')}
                className="rounded-full border border-white/15 bg-white/5 p-1 text-white/60 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
              >
                <RefreshCw className="h-3 w-3" />
              </button>
            </div>
            {loadingTables ? (
              <LoadingState text={t('mysql.editor.loading')} />
            ) : tables.length === 0 ? (
              <EmptyState message={t('mysql.editor.noTables')} />
            ) : (
              <div className="max-h-[52vh] space-y-1 overflow-y-auto pr-1">
                {tables.map((item) => (
                  <button
                    key={item.name}
                    type="button"
                    onClick={() => selectTable(item.name)}
                    className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                      activeTable === item.name
                        ? 'border-cyan-500/40 bg-cyan-500/10'
                        : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <FileText className="h-3.5 w-3.5 flex-none text-white/40" />
                      <span className="min-w-0 flex-1 truncate text-sm" title={item.name}>{item.name}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-[10px] text-white/35">
                      <span>{t('mysql.editor.tableRows', { count: item.rows })}</span>
                      <span>{formatBytesSize(item.dataLength + item.indexLength)}</span>
                      {item.isView ? <span className="text-amber-300/70">VIEW</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 右侧数据区 */}
          <div className="min-w-0 flex-1">
            {!activeTable ? (
              <EmptyState message={t('mysql.editor.selectTable')} />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <div className="flex rounded-full border border-white/10 bg-white/5 p-1">
                    {['data', 'structure'].map((key) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTab(key)}
                        className={`rounded-full px-3 py-1 text-xs transition-colors ${
                          tab === key ? 'bg-cyan-500/20 text-cyan-200' : 'text-white/60 hover:text-white'
                        }`}
                      >
                        {key === 'data' ? t('mysql.editor.data') : t('mysql.editor.structure')}
                      </button>
                    ))}
                  </div>
                  <span className="text-xs text-white/40">
                    {t('mysql.editor.totalRows', { count: total })}
                  </span>
                  {readOnlyTable ? (
                    <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                      {currentTable?.isView ? t('mysql.editor.viewReadonly') : t('mysql.editor.noPk')}
                    </span>
                  ) : null}
                  <div className="ml-auto flex items-center gap-2">
                    {tab === 'data' ? (
                      <>
                        <select
                          value={pageSize}
                          onChange={(e) => {
                            setPageSize(Number(e.target.value));
                            setPage(1);
                          }}
                          className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-xs outline-none"
                        >
                          {PAGE_SIZES.map((size) => (
                            <option key={size} value={size}>{t('mysql.editor.perPage', { size })}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={loadRows}
                          disabled={loadingRows}
                          title={t('mysql.editor.refresh')}
                          className="rounded-full border border-white/15 bg-white/5 p-1.5 text-white/60 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-40"
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </button>
                        <LiquidButton
                          onClick={openCreate}
                          disabled={readOnlyTable}
                          className="!px-3 !py-1.5 !text-xs"
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          {t('mysql.editor.insert')}
                        </LiquidButton>
                      </>
                    ) : null}
                  </div>
                </div>

                {tab === 'structure' ? (
                  <div className="max-h-[58vh] overflow-auto rounded-2xl border border-white/10">
                    <table className="min-w-full text-xs">
                      <thead className="sticky top-0 bg-white/[0.06] text-white/60">
                        <tr>
                          {[t('mysql.editor.field'), t('mysql.editor.type'), t('mysql.editor.nullable'), t('mysql.editor.key'), t('mysql.editor.defaultValue'), t('mysql.editor.extra'), t('mysql.editor.comment')].map((label) => (
                            <th key={label} className="whitespace-nowrap px-3 py-2 text-left font-medium">{label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {columns.map((col) => (
                          <tr key={col.name} className="border-t border-white/5">
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-cyan-300">{col.name}</td>
                            <td className="whitespace-nowrap px-3 py-2 text-white/70">{col.type}</td>
                            <td className="px-3 py-2 text-white/60">{col.nullable ? 'YES' : 'NO'}</td>
                            <td className="px-3 py-2 text-amber-300/80">{col.key || '-'}</td>
                            <td className="max-w-[180px] truncate px-3 py-2 text-white/60" title={String(col.default ?? '')}>
                              {col.default === null ? 'NULL' : String(col.default)}
                            </td>
                            <td className="px-3 py-2 text-white/60">{col.extra || '-'}</td>
                            <td className="max-w-[200px] truncate px-3 py-2 text-white/50" title={col.comment}>{col.comment || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {indexes.length ? (
                      <p className="border-t border-white/5 px-3 py-2 text-[11px] text-white/40">
                        {t('mysql.editor.indexHint', {
                          list: indexes.map((idx) => `${idx.name}(${idx.column})`).join('，'),
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : loadingRows ? (
                  <LoadingState text={t('mysql.editor.loading')} />
                ) : rows.length === 0 ? (
                  <EmptyState message={t('mysql.editor.noRows')} />
                ) : (
                  <>
                    <div className="max-h-[50vh] overflow-auto rounded-2xl border border-white/10">
                      <table className="min-w-full text-xs">
                        <thead className="sticky top-0 bg-white/[0.06] text-white/60">
                          <tr>
                            {columns.map((col) => (
                              <th
                                key={col.name}
                                onClick={() => toggleSort(col.name)}
                                className="cursor-pointer whitespace-nowrap px-3 py-2 text-left font-medium hover:text-white"
                                title={col.type}
                              >
                                <span className="inline-flex items-center gap-1">
                                  {col.name}
                                  {col.key === 'PRI' ? <span className="text-[10px] text-amber-300">PK</span> : null}
                                  {orderBy === col.name ? (
                                    orderDir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />
                                  ) : null}
                                </span>
                              </th>
                            ))}
                            <th className="w-20 whitespace-nowrap px-3 py-2 text-right font-medium">
                              {t('mysql.editor.actions')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, index) => {
                            const key = buildKey(row);
                            const busy = deletingKey && key && JSON.stringify(key) === deletingKey;
                            return (
                              <tr key={index} className="border-t border-white/5 hover:bg-white/[0.03]">
                                {columns.map((col) => (
                                  <td key={col.name} className="whitespace-nowrap px-3 py-2 text-white/75">
                                    {renderCell(col, row[col.name])}
                                  </td>
                                ))}
                                <td className="px-3 py-2 text-right">
                                  {readOnlyTable ? (
                                    <span className="text-white/25">-</span>
                                  ) : (
                                    <div className="flex items-center justify-end gap-1.5">
                                      <button
                                        type="button"
                                        onClick={() => openEdit(row)}
                                        title={t('mysql.editor.edit')}
                                        className="rounded-full border border-cyan-500/30 bg-cyan-500/10 p-1.5 text-cyan-300 transition-colors hover:bg-cyan-500/20"
                                      >
                                        <Pencil className="h-3 w-3" />
                                      </button>
                                      <button
                                        type="button"
                                        onClick={() => handleDelete(row)}
                                        disabled={busy}
                                        title={t('mysql.editor.delete')}
                                        className="rounded-full border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-40"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-3 flex items-center justify-between text-xs text-white/50">
                      <span>{t('mysql.editor.pageInfo', { page, pages })}</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                          disabled={page <= 1 || loadingRows}
                          className="rounded-full border border-white/15 bg-white/5 px-3 py-1 transition-colors hover:bg-white/15 disabled:opacity-40"
                        >
                          {t('mysql.editor.prev')}
                        </button>
                        <button
                          type="button"
                          onClick={() => setPage((prev) => Math.min(pages, prev + 1))}
                          disabled={page >= pages || loadingRows}
                          className="rounded-full border border-white/15 bg-white/5 px-3 py-1 transition-colors hover:bg-white/15 disabled:opacity-40"
                        >
                          {t('mysql.editor.next')}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </GlassModal>

      {/* 行编辑：新增与修改共用一套表单 */}
      <GlassModal
        open={Boolean(editor)}
        onClose={() => (saving ? null : setEditor(null))}
        maxWidth="max-w-3xl"
        title={editor?.mode === 'create' ? t('mysql.editor.insertTitle') : t('mysql.editor.editTitle')}
        subtitle={activeTable}
      >
        {editor ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">{columns.map(renderField)}</div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditor(null)}
                disabled={saving}
                className="rounded-full border border-white/15 bg-white/5 px-4 py-2 text-sm text-white/70 transition-colors hover:bg-white/10 disabled:opacity-40"
              >
                <X className="mr-1 inline h-4 w-4" />
                {t('common.cancel')}
              </button>
              <LiquidButton onClick={handleSave} disabled={saving} className="!px-4 !py-2 !text-sm">
                <Check className="mr-1 inline h-4 w-4" />
                {saving ? t('mysql.editor.saving') : t('mysql.editor.save')}
              </LiquidButton>
            </div>
          </div>
        ) : null}
      </GlassModal>
    </>
  );
}
