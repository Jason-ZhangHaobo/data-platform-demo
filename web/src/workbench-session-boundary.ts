import type {AuthSession} from "./AuthDialog";
export {loadStartupCore} from "./startup-core.ts";

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,stable(item)]),
  );
  return value;
}

export function workbenchSessionScope(status: {mode: string; budget?: unknown}, session: AuthSession) {
  const {mode} = status;
  if (mode === "PUBLIC_INVITATION" && "budget" in status && (!session.authenticated || session.role !== "ADMIN")) {
    throw new Error("服务状态与当前身份不一致，请重新读取。");
  }
  return JSON.stringify(stable({
    mode, authenticated:session.authenticated, userId:session.user?.id, role:session.role,
    permissions:[...new Set(session.permissions ?? [])].sort(),
    expiresAt:session.expiresAt, readOnly:session.readOnly === true,
    development:[session.developmentOnly, session.developmentTaskOnly, session.developmentTaskId, session.developmentStartsAt, session.developmentExpiresAt],
    publication:[session.publicationOnly, session.publicationTaskId, session.manualPublicationOnly, session.manualPublicationTaskId,
      session.publicationPackageDigest, session.publicationVerificationId, session.publicationStartsAt, session.publicationExpiresAt,
      session.publicationSource, session.manualPublicationSource],
    consumption:[session.consumptionOnly, session.consumptionPilotId, session.consumptionTaskId, session.manualConsumptionOnly,
      session.manualConsumptionTaskId, session.consumptionPlan, session.consumptionStartsAt, session.consumptionExpiresAt,
      session.manualConsumptionSource],
    servicePlanning:[session.servicePlanningOnly, session.servicePlanning],
  }));
}

type Options = {actorId?:string; idempotencyKey?:string};
type Api = <T>(path:string,body?:unknown,options?:Options)=>Promise<T>;
type AccessFailure = {status?:number; code?:string};

export function workbenchAccessFailure(path: string, error: unknown): "SESSION" | "SCOPE" | undefined {
  if (path.startsWith("/auth/") || !error || typeof error !== "object") return;
  const {status,code} = error as AccessFailure;
  if (status === 401) return "SESSION";
  if (status === 403 && code && [
    "PROJECT_PERMISSION_DENIED","DELIVERY_EVIDENCE_ACCESS_DENIED","DEVELOPMENT_ACCESS_DENIED","REPORT_PUBLISHED_EVIDENCE_LOCAL_ONLY",
  ].includes(code)) return "SCOPE";
}

export function createScopedWorkbenchApi(read: Api, epoch: number, currentEpoch: ()=>number,
  onAccessFailure: (kind:"SESSION"|"SCOPE")=>void, mayWrite:()=>boolean=()=>true): Api {
  const assertCurrent = () => {
    if (epoch !== currentEpoch()) throw Object.assign(new Error("会话范围已变化，请在当前会话核对原记录。"),{code:"WORKBENCH_SESSION_CHANGED"});
  };
  return async <T>(path:string,body?:unknown,options?:Options) => {
    assertCurrent();
    if (body !== undefined && !path.startsWith("/auth/") && !mayWrite())
      throw new Error("正在核对当前会话权限，暂不能提交。");
    let value: T;
    try {
      value = await read<T>(path,body,options);
    } catch (error) {
      assertCurrent();
      const failure = workbenchAccessFailure(path,error);
      if (failure) onAccessFailure(failure);
      assertCurrent();
      throw error;
    }
    assertCurrent();
    return value;
  };
}
