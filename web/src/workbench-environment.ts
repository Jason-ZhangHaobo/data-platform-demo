type Status = {
  mode?: string;
  dataServices?: { privateEnabled?: boolean; scope?: string };
};
type Session = { authenticated?: boolean; permissions?: string[] };

// Preview metadata restricts the temporary transport. It is not evidence that
// a backend is local, available, or writable; the API still enforces authority.
export function workbenchEnvironment(status?: Status, preview = { privatePreview: false, privateServicesPreview: false }) {
  const local = status?.mode === "LOCAL_DEVELOPMENT" && !preview.privatePreview;
  const cloud = status?.mode === "PUBLIC_INVITATION";
  const cloudServices = cloud && status?.dataServices?.privateEnabled === true
    && status.dataServices.scope === "PRIVATE_CLOUD_TEST";
  const servicesAvailable = (local || cloudServices) && (!preview.privatePreview || preview.privateServicesPreview);
  return {
    runtimeMode: local ? "LOCAL_DEVELOPMENT" as const : cloud ? "PUBLIC_INVITATION" as const : undefined,
    servicesAvailable,
    agentServiceHandoffAvailable: servicesAvailable && cloudServices,
    cloudServices,
    cloudAccess: preview.privatePreview ? "private-preview" as const : "invited" as const,
    localManualDeliveryAvailable: local,
    unavailableReason: !status ? "正在确认服务端能力…" : "当前服务未启用数据服务能力；不会回退到本机接口。",
  };
}

export function mayWriteServices(status: Status | undefined, session: Session) {
  if (status?.mode === "LOCAL_DEVELOPMENT") return true;
  return status?.mode === "PUBLIC_INVITATION" && session.authenticated === true
    && (session.permissions?.includes("*") === true || session.permissions?.includes("SERVICES") === true);
}
