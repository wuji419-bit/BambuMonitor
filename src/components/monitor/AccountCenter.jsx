import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Send,
  Trash2,
  X,
} from 'lucide-react';

const EMPTY_FORM = Object.freeze({
  account: '',
  password: '',
  code: '',
  remark: '',
  method: 'password',
  targetId: '',
});

const STATE_COPY = Object.freeze({
  idle: '等待同步',
  syncing: '同步中',
  refreshing: '同步中',
  connected: '已连接',
  invalid: '需重新登录',
  error: '同步异常',
});

function cloneForm() {
  return { ...EMPTY_FORM };
}

function stateByAccount(states = []) {
  return new Map(states.map((state) => [state.accountId, state]));
}

function resultCollections(result, currentAccounts, currentStates) {
  return {
    accounts: Array.isArray(result?.accounts) ? result.accounts : currentAccounts,
    states: Array.isArray(result?.states) ? result.states : currentStates,
  };
}

export default function AccountCenter({
  runtime,
  disabled = false,
  onInventoryChanged,
  onFinalAccountRemoved,
}) {
  const accountApi = runtime?.accounts;
  const [accounts, setAccounts] = useState([]);
  const [states, setStates] = useState([]);
  const [remarkDrafts, setRemarkDrafts] = useState({});
  const [form, setForm] = useState(() => cloneForm());
  const [formOpen, setFormOpen] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [feedback, setFeedback] = useState('');
  const stateMap = useMemo(() => stateByAccount(states), [states]);

  const applyResult = (result) => {
    if (!result?.success) throw new Error(result?.error || '账号操作失败');
    const collections = resultCollections(result, accounts, states);
    setAccounts(collections.accounts);
    setStates(collections.states);
    setRemarkDrafts((current) => {
      const next = { ...current };
      for (const account of collections.accounts) {
        if (!Object.hasOwn(next, account.accountId)) next[account.accountId] = account.remark || '';
      }
      for (const accountId of Object.keys(next)) {
        if (!collections.accounts.some((account) => account.accountId === accountId)) delete next[accountId];
      }
      return next;
    });
    return collections;
  };

  const run = async (key, operation, successCopy, { refreshInventory = false } = {}) => {
    if (busyKey || disabled) return null;
    setBusyKey(key);
    setFeedback('');
    try {
      const result = await operation();
      const collections = applyResult(result);
      if (refreshInventory) await onInventoryChanged?.(result?.devices);
      setFeedback(successCopy);
      return { result, collections };
    } catch (error) {
      setFeedback(error?.message || '账号操作失败');
      return null;
    } finally {
      setBusyKey('');
    }
  };

  useEffect(() => {
    if (!accountApi) return undefined;
    let active = true;
    accountApi.list()
      .then((result) => {
        if (!active) return;
        applyResult(result);
      })
      .catch((error) => {
        if (active) setFeedback(error?.message || '读取账号列表失败');
      });
    return () => { active = false; };
    // The account API is stable for the lifetime of one runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountApi]);

  useEffect(() => {
    if (!runtime?.events || !accountApi) return undefined;
    const updateState = (event) => {
      if (!event?.accountId || !event.state) return;
      setStates((current) => {
        const next = current.filter((state) => state.accountId !== event.accountId);
        return [...next, { accountId: event.accountId, ...event.state }];
      });
    };
    const removeAccount = (event) => {
      if (!event?.accountId) return;
      setAccounts((current) => current.filter((account) => account.accountId !== event.accountId));
      setStates((current) => current.filter((state) => state.accountId !== event.accountId));
    };
    const releases = [
      runtime.events.onAccountUpdated?.(updateState),
      runtime.events.onAccountInvalid?.(updateState),
      runtime.events.onAccountRemoved?.(removeAccount),
    ].filter(Boolean);
    return () => releases.forEach((release) => release());
  }, [accountApi, runtime]);

  if (!accountApi) return null;

  const openAdd = () => {
    setForm(cloneForm());
    setFormOpen(true);
    setFeedback('');
  };

  const openReauthenticate = (account) => {
    setForm({
      ...cloneForm(),
      targetId: account.accountId,
      remark: account.remark || '',
    });
    setFormOpen(true);
    setFeedback('');
  };

  const closeForm = () => {
    if (busyKey) return;
    setFormOpen(false);
    setForm(cloneForm());
  };

  const sendCode = async () => {
    if (!form.account.trim()) {
      setFeedback('请先填写邮箱或手机号');
      return;
    }
    await run('send-code', () => accountApi.requestVerifyCode({
      account: form.account.trim(),
      ...(form.targetId ? { accountId: form.targetId } : {}),
    }), '验证码已发送，请查看短信或邮箱');
  };

  const submitAccount = async (event) => {
    event.preventDefault();
    const account = form.account.trim();
    if (!account) {
      setFeedback('请输入邮箱或手机号');
      return;
    }
    if (form.method === 'password' && !form.password) {
      setFeedback('请输入密码');
      return;
    }
    if (form.method === 'code' && !form.code.trim()) {
      setFeedback('请输入验证码');
      return;
    }
    const credentials = {
      account,
      ...(form.method === 'password' ? { password: form.password } : { code: form.code.trim() }),
      ...(!form.targetId && form.remark.trim() ? { remark: form.remark.trim() } : {}),
    };
    const operation = form.targetId
      ? () => accountApi.reauthenticate(form.targetId, credentials)
      : (form.method === 'password'
        ? () => accountApi.add(credentials)
        : () => accountApi.addWithCode(credentials));
    const completed = await run(
      form.targetId ? `reauth-${form.targetId}` : 'add',
      operation,
      form.targetId ? '账号已重新连接' : '账号已添加',
      { refreshInventory: true },
    );
    if (completed) closeForm();
  };

  const saveRemark = async (account) => {
    const remark = remarkDrafts[account.accountId] ?? '';
    await run(
      `remark-${account.accountId}`,
      () => accountApi.updateRemark(account.accountId, remark),
      remark.trim() ? '账号备注已保存' : '账号备注已清除',
      { refreshInventory: true },
    );
  };

  const refreshAccount = async (account) => {
    await run(
      `refresh-${account.accountId}`,
      () => accountApi.refresh(account.accountId),
      `${account.label} 已同步`,
      { refreshInventory: true },
    );
  };

  const removeAccount = async (account) => {
    const confirmed = window.confirm(`确定移除账号“${account.label}”吗？该账号独有的打印机会从当前窗口移除。`);
    if (!confirmed) return;
    const completed = await run(
      `remove-${account.accountId}`,
      () => accountApi.remove(account.accountId),
      '账号已移除',
    );
    if (!completed) return;
    const finalRemoved = completed.result?.authenticated === false
      || completed.collections.accounts.length === 0;
    if (finalRemoved) onFinalAccountRemoved?.();
    else await onInventoryChanged?.(completed.result?.devices);
  };

  return (
    <div className="account-center">
      <div className="account-center__heading">
        <div>
          <strong>拓竹账号</strong>
          <span>{accounts.length ? `已连接 ${accounts.length} 个账号` : '尚未添加账号'}</span>
        </div>
        <button type="button" onClick={openAdd} disabled={disabled || Boolean(busyKey)}>
          <Plus size={14} aria-hidden="true" />
          添加账号
        </button>
      </div>

      <div className="account-list" aria-live="polite">
        {accounts.map((account) => {
          const state = stateMap.get(account.accountId) || {};
          const stateName = state.connectionState || state.status || 'idle';
          const draft = remarkDrafts[account.accountId] ?? account.remark ?? '';
          const remarkChanged = draft.trim() !== (account.remark || '');
          return (
            <article className="account-row" key={account.accountId} data-state={stateName}>
              <div className="account-row__summary">
                <div>
                  <strong title={account.label}>{account.label}</strong>
                  <span>{account.accountMasked}</span>
                </div>
                <span className="account-state" data-state={stateName}>
                  {STATE_COPY[stateName] || '等待同步'}
                  {Number.isSafeInteger(state.deviceCount) ? ` · ${state.deviceCount} 台` : ''}
                </span>
              </div>
              <label className="account-remark-field">
                <span>备注</span>
                <div>
                  <input
                    type="text"
                    maxLength={40}
                    value={draft}
                    disabled={disabled || Boolean(busyKey)}
                    placeholder="可留空，设备名将显示脱敏账号"
                    onChange={(event) => setRemarkDrafts((current) => ({
                      ...current,
                      [account.accountId]: event.target.value,
                    }))}
                  />
                  <button
                    type="button"
                    aria-label={`保存 ${account.label} 的备注`}
                    title="保存备注"
                    disabled={!remarkChanged || disabled || Boolean(busyKey)}
                    onClick={() => saveRemark(account)}
                  >
                    {busyKey === `remark-${account.accountId}`
                      ? <RefreshCw className="is-spinning" size={14} aria-hidden="true" />
                      : <Save size={14} aria-hidden="true" />}
                  </button>
                </div>
              </label>
              <div className="account-row__actions">
                <button
                  type="button"
                  disabled={disabled || Boolean(busyKey)}
                  onClick={() => refreshAccount(account)}
                >
                  <RefreshCw className={busyKey === `refresh-${account.accountId}` ? 'is-spinning' : ''} size={13} aria-hidden="true" />
                  同步
                </button>
                <button
                  type="button"
                  disabled={disabled || Boolean(busyKey)}
                  onClick={() => openReauthenticate(account)}
                >
                  <KeyRound size={13} aria-hidden="true" />
                  重新登录
                </button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={disabled || Boolean(busyKey)}
                  onClick={() => removeAccount(account)}
                >
                  <Trash2 size={13} aria-hidden="true" />
                  移除
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {formOpen ? (
        <form className="account-form" onSubmit={submitAccount}>
          <header>
            <div>
              <strong>{form.targetId ? '重新登录账号' : '添加拓竹账号'}</strong>
              <span>{form.targetId ? '只更新这个账号的登录状态' : '添加后设备会自动合并到当前列表'}</span>
            </div>
            <button type="button" aria-label="关闭账号表单" onClick={closeForm} disabled={Boolean(busyKey)}>
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="account-form__methods" aria-label="登录方式">
            <button
              type="button"
              className={form.method === 'password' ? 'is-active' : ''}
              onClick={() => setForm((current) => ({ ...current, method: 'password', code: '' }))}
            >密码</button>
            <button
              type="button"
              className={form.method === 'code' ? 'is-active' : ''}
              onClick={() => setForm((current) => ({ ...current, method: 'code', password: '' }))}
            >验证码</button>
          </div>
          <label>
            <span>邮箱 / 手机号</span>
            <input
              type="text"
              autoComplete="username"
              value={form.account}
              onChange={(event) => setForm((current) => ({ ...current, account: event.target.value }))}
            />
          </label>
          {form.method === 'password' ? (
            <label>
              <span>密码</span>
              <input
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              />
            </label>
          ) : (
            <label>
              <span>验证码</span>
              <div className="account-form__code">
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.code}
                  onChange={(event) => setForm((current) => ({ ...current, code: event.target.value }))}
                />
                <button type="button" disabled={Boolean(busyKey)} onClick={sendCode}>
                  <Send size={13} aria-hidden="true" />发送
                </button>
              </div>
            </label>
          )}
          {!form.targetId ? (
            <label>
              <span>账号备注（可选）</span>
              <input
                type="text"
                maxLength={40}
                value={form.remark}
                placeholder="例如：公司、工作室；可直接跳过"
                onChange={(event) => setForm((current) => ({ ...current, remark: event.target.value }))}
              />
            </label>
          ) : null}
          <button className="account-form__submit" type="submit" disabled={Boolean(busyKey)}>
            {busyKey === 'add' || busyKey.startsWith('reauth-')
              ? <RefreshCw className="is-spinning" size={14} aria-hidden="true" />
              : <Check size={14} aria-hidden="true" />}
            {form.targetId ? '重新连接' : '添加账号'}
          </button>
        </form>
      ) : null}

      {feedback ? <p className="account-center__feedback" role={/失败|错误|异常/.test(feedback) ? 'alert' : 'status'}>{feedback}</p> : null}
    </div>
  );
}
