import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(
  self as unknown as { MonacoEnvironment: { getWorker: () => Worker } }
).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

export default function PythonEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Editor
      theme="vs-dark"
      language="python"
      value={value}
      onChange={(next) => onChange(next ?? "")}
      options={{
        fontSize: 13,
        lineHeight: 23,
        fontFamily: "'SFMono-Regular', Consolas, monospace",
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        padding: { top: 18, bottom: 12 },
        automaticLayout: true,
        wordWrap: "on",
        tabSize: 4,
        insertSpaces: true,
        renderLineHighlight: "none",
        overviewRulerBorder: false,
      }}
      loading={<div className="editor-loading">准备 Python 编辑器…</div>}
    />
  );
}
