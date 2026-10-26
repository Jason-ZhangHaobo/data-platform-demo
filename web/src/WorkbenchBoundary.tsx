import React from "react";

export class WorkbenchBoundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main role="alert" style={{ maxWidth: 640, margin: "12vh auto", padding: 32, fontFamily: "system-ui, sans-serif", color: "#174f40", background: "#f4f7f2", borderRadius: 20 }}>
      <p>数舵 · 连接恢复</p><h1>工作台组件暂时未能加载</h1>
      <p>网络或服务繁忙，页面加载没有完成。已保存的任务和结果不会丢失，也不会自动重新提交任务。</p>
      <p>重新加载可能清除尚未保存的输入，请确认后再试。</p>
      <button type="button" onClick={() => { if (window.confirm("重新加载会清除尚未保存的输入；已保存任务不受影响。是否继续？")) window.location.reload(); }} style={{ padding: "12px 20px", border: 0, borderRadius: 8, color: "white", background: "#14694e", cursor: "pointer" }}>重新加载工作台</button>
    </main>;
  }
}
