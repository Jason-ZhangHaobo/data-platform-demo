import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Copy,
  KeyRound,
  LoaderCircle,
  LogIn,
  Mail,
  ShieldCheck,
  UserPlus,
  X,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
export type AuthSession = {
  authenticated: boolean;
  mode?: string;
  user?: {
    id: string;
    email: string;
    displayName: string;
    role: string;
  };
  role?: string;
  permissions?: string[];
  expiresAt?: string;
};
type Invitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  expiresAt: string;
};

export function AuthDialog({
  api,
  onClose,
  onAuthenticated,
}: {
  api: Api;
  onClose: () => void;
  onAuthenticated: (session: AuthSession) => void;
}) {
  const [mode, setMode] = useState<"login" | "redeem">("login"),
    [email, setEmail] = useState(""),
    [inviteCode, setInviteCode] = useState(""),
    [displayName, setDisplayName] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const session = await api<AuthSession>(
        mode === "login" ? "/auth/login" : "/auth/redeem",
        mode === "login"
          ? { email, password }
          : { inviteCode, displayName, password },
      );
      onAuthenticated({ ...session, authenticated: true });
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth-overlay-v2" onMouseDown={onClose}>
      <section className="auth-dialog-v2" role="dialog" aria-modal="true" aria-label="受邀用户登录" onMouseDown={(event) => event.stopPropagation()}>
        <header><div><span className="eyebrow">INVITATION ACCESS</span><h2>{mode === "login" ? "登录数栈" : "兑换邀请"}</h2><p>公开浏览无需登录；创建和运行任务需要受邀项目成员。</p></div><button aria-label="关闭登录" onClick={onClose}><X size={18} /></button></header>
        <div className="auth-tabs-v2" role="tablist"><button role="tab" aria-selected={mode === "login"} className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}><LogIn size={14} />已有账号</button><button role="tab" aria-selected={mode === "redeem"} className={mode === "redeem" ? "active" : ""} onClick={() => setMode("redeem")}><UserPlus size={14} />首次受邀</button></div>
        <form onSubmit={submit}>
          {mode === "login" ? <label><Mail size={14} />邮箱<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label> : <><label><KeyRound size={14} />一次性邀请码<input autoComplete="one-time-code" value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} required /></label><label><UserPlus size={14} />显示名称<input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} minLength={2} maxLength={50} required /></label></>}
          <label><ShieldCheck size={14} />密码<input type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} value={password} onChange={(event) => setPassword(event.target.value)} minLength={12} maxLength={128} required /></label>
          {mode === "redeem" && <small>12—128位，大小写字母、数字、符号至少三类。邀请码兑换后立即失效。</small>}
          {error && <p role="alert" className="auth-error-v2">{error}</p>}
          <button className="button primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={15} /> : mode === "login" ? <LogIn size={15} /> : <UserPlus size={15} />}{busy ? "正在验证…" : mode === "login" ? "登录" : "创建账号并登录"}</button>
        </form>
        <footer><ShieldCheck size={13} />会话使用HttpOnly Cookie和CSRF校验；页面不会保存密码。</footer>
      </section>
    </div>
  );
}

export function InvitationPanel({ api }: { api: Api }) {
  const [invitations, setInvitations] = useState<Invitation[]>([]),
    [email, setEmail] = useState(""),
    [role, setRole] = useState("ENGINEER"),
    [issuedCode, setIssuedCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = () =>
    api<Invitation[]>("/auth/invitations")
      .then(setInvitations)
      .catch((cause) => setError((cause as Error).message));
  useEffect(() => {
    void load();
  }, []);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setIssuedCode("");
    try {
      const result = await api<{
        invitation: Invitation;
        inviteCode: string;
        secretShownOnce: boolean;
      }>("/auth/invitations", { email, role });
      setIssuedCode(result.inviteCode);
      setEmail("");
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="invitation-panel-v2">
      <header><div><span className="eyebrow">INVITED MEMBERS</span><h3>项目邀请</h3><p>邀请码只显示一次，7天内有效；不通过聊天发送密码。</p></div><span>{invitations.length}</span></header>
      <form onSubmit={create}><label>受邀邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>项目角色<select value={role} onChange={(event) => setRole(event.target.value)}><option value="ENGINEER">数据开发工程师</option><option value="PRODUCT_MANAGER">数据产品经理</option><option value="VIEWER">只读访客</option></select></label><button className="button primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={14} /> : <UserPlus size={14} />}创建一次性邀请</button></form>
      {issuedCode && <div className="invite-code-v2" role="status"><CheckCircle2 size={16} /><div><strong>请现在复制，刷新后不再显示</strong><code>{issuedCode}</code></div><button onClick={() => navigator.clipboard.writeText(issuedCode)}><Copy size={14} />复制</button></div>}
      {error && <p role="alert" className="auth-error-v2">{error}</p>}
      <div className="invitation-list-v2">{invitations.map((invitation) => <article key={invitation.id}><span className={`status-pill ${invitation.status.toLowerCase()}`}>{invitation.status}</span><div><strong>{invitation.email}</strong><code>{invitation.role} · {new Date(invitation.expiresAt).toLocaleDateString("zh-CN")}</code></div></article>)}</div>
    </section>
  );
}

export function ChangePasswordPanel({
  api,
  onChanged,
}: {
  api: Api;
  onChanged: (session: AuthSession) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState(""),
    [newPassword, setNewPassword] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError("");
    setSaved(false);
    if (newPassword !== confirmation) {
      setError("两次输入的新密码不一致");
      return;
    }
    setBusy(true);
    try {
      const session = await api<AuthSession>("/auth/password", {
        currentPassword,
        newPassword,
      });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmation("");
      setSaved(true);
      onChanged({ ...session, authenticated: true });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="password-panel-v2">
      <header>
        <div>
          <span className="eyebrow">ACCOUNT SECURITY</span>
          <h3>修改登录密码</h3>
          <p>修改后撤销此前会话，并为当前浏览器签发新会话。</p>
        </div>
        <ShieldCheck size={22} />
      </header>
      <form onSubmit={submit}>
        <label>
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            required
          />
        </label>
        <label>
          新密码
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            required
          />
        </label>
        <label>
          再次输入新密码
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={128}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
          />
        </label>
        <button className="button primary" type="submit" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <KeyRound size={14} />}
          {busy ? "正在更新…" : "更新密码并刷新会话"}
        </button>
      </form>
      <small>12—128位，大小写字母、数字、符号至少三类；页面不保存密码。</small>
      {error && <p role="alert" className="auth-error-v2">{error}</p>}
      {saved && <p role="status" className="password-success-v2"><CheckCircle2 size={14} />密码已更新，旧会话已撤销。</p>}
    </section>
  );
}
