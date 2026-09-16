import Editor, { DiffEditor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
(
  self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }
).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
export default function SqlEditor({
  value,
  original,
  onChange,
  diff,
}: {
  value: string;
  original: string;
  onChange: (v: string) => void;
  diff: boolean;
}) {
  const options = {
    fontSize: 13,
    lineHeight: 23,
    fontFamily: "'SFMono-Regular', Consolas, monospace",
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    padding: { top: 18, bottom: 12 },
    automaticLayout: true,
    wordWrap: "on" as const,
    tabSize: 2,
    renderLineHighlight: "none" as const,
    overviewRulerBorder: false,
  };
  return diff ? (
    <DiffEditor
      theme="vs-dark"
      language="sql"
      original={original}
      modified={value}
      options={{ ...options, readOnly: true, renderSideBySide: false }}
      loading={<div className="editor-loading">准备代码差异…</div>}
    />
  ) : (
    <Editor
      theme="vs-dark"
      language="sql"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      options={options}
      loading={<div className="editor-loading">准备 SQL 编辑器…</div>}
    />
  );
}
