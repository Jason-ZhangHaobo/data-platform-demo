import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Render the actual TSX components without a browser or network. These are
// markup/semantics tests, not visual or click-interaction acceptance.
async function componentUrl(name) {
  const file = new URL(`../../../web/src/${name}.tsx`, import.meta.url);
  let source = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for (const dependency of ['react', 'react/jsx-runtime', 'lucide-react']) source = source.replaceAll(`from "${dependency}"`, `from ${JSON.stringify(import.meta.resolve(dependency))}`);
  source = source.replaceAll('from "../../src/v2/fund-contexts.mjs"', `from ${JSON.stringify(new URL('../../../src/v2/fund-contexts.mjs', import.meta.url).href)}`);
  source = source.replaceAll('from "./delivery-presentation"', `from ${JSON.stringify(new URL('../../../web/src/delivery-presentation.ts', import.meta.url).href)}`);
  source = source.replaceAll('from "./manual-run-recovery"', `from ${JSON.stringify(new URL('../../../web/src/manual-run-recovery.ts', import.meta.url).href)}`);
  source = source.replaceAll('from "./delivery-source"', `from ${JSON.stringify(new URL('../../../web/src/delivery-source.ts', import.meta.url).href)}`);
  source = source.replaceAll('from "../../src/v2/sync-sql-output-schema-client.mjs"', `from ${JSON.stringify(new URL('../../../src/v2/sync-sql-output-schema-client.mjs', import.meta.url).href)}`);
  source = source.replace('import "./sync-output-schema.css";', '');
  if (name === 'DeliveryWorkbench') source = source.replace('from "./SyncOutputSchemaDetails"', `from ${JSON.stringify(await componentUrl('SyncOutputSchemaDetails'))}`);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
export async function component(name, exportName = name) {
  return (await import(await componentUrl(name)))[exportName];
}
