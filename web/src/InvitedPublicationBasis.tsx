import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import type {CloudPublicationPreflight,Workflow} from './agent-workflow-read';
import {comparePublicationFiles,maxReviewJsonBytes,type PublicationFileComparison} from '../../src/v2/publication-file-comparison.mjs';
import './invited-publication-basis.css';

const DiffEditor=lazy(()=>import('./SqlEditor'));
const titles:Record<string,string>={code:'本次发布的 SQL',assertions:'结果断言与文件演练',deliveryFiles:'调度与部署文件',cloudScope:'两批测试的执行范围'};
type Bundle=NonNullable<Workflow['package']>;

function ReviewFiles({bundle}:{bundle:Bundle}){
  const [file,setFile]=useState('schedule.json');
  const [comparison,setComparison]=useState<{result:PublicationFileComparison;files:Record<string,string>}>();
  const [diffFile,setDiffFile]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(false);
  const epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[]);
  async function choose(file?:File){
    const ticket=++epoch.current;
    setComparison(undefined);setDiffFile('');setError('');setLoading(Boolean(file));
    if(!file)return;
    try {
      if(file.size>maxReviewJsonBytes)throw Error('请选择数舵导出的完整交付包 JSON（最多 6 MiB）。');
      let prior;
      try{prior=JSON.parse(await file.text());}catch{throw Error('无法读取该 JSON，请选择导出的版本化交付包。');}
      const result=await comparePublicationFiles(prior,bundle,{currentDigest:bundle.digest});
      if(ticket!==epoch.current)return;
      setComparison({result,files:prior.files});
      setDiffFile(result.files.find(item=>item.changed)?.name??'');
    }catch(cause){if(ticket===epoch.current)setError((cause as Error).message);}
    finally{if(ticket===epoch.current)setLoading(false);}
  }
  const changed=comparison?.result.files.filter(item=>item.changed)??[];
  return <>
    <label>本次文件 <select value={file} onChange={event=>setFile(event.target.value)}>
      {['schedule.json','deployment.json','calendar.json'].map(name=><option key={name}>{name}</option>)}
    </select></label>
    <pre aria-label={'本次 '+file} tabIndex={0}>{bundle.files[file]}</pre>
    <details className="invited-package-compare">
      <summary>与其他交付版本对照</summary>
      <label>选择同项目的对照包 JSON <input type="file" accept=".json,application/json" onChange={event=>void choose(event.currentTarget.files?.[0])}/></label>
      <small>文件在当前浏览器内读取。对照包由你选取，审批仍绑定当前审阅版本。</small>
      {loading&&<p role="status">正在核对两份交付包…</p>}
      {error&&<p role="alert">{error}</p>}
      {comparison&&<>
        <p role="status">已核对 8 份文件，{changed.length} 份有变化。</p>
        <p>对照口径 {comparison.result.baseline.contextId} · 包摘要 <code>{comparison.result.baseline.packageDigest}</code></p>
        {changed.length>0&&<><label>查看文件差异 <select value={diffFile} onChange={event=>setDiffFile(event.target.value)}>
          {changed.map(item=><option key={item.name}>{item.name}</option>)}
        </select></label>
        <div className="invited-package-diff" aria-label="对照包与本次文件的只读差异">
          <Suspense fallback={<p role="status">加载文件差异…</p>}><DiffEditor value={bundle.files[diffFile]} original={comparison.files[diffFile]}
            comparisonLanguage={diffFile.endsWith('.sql')?'sql':'plaintext'} diff readOnly focusChanges onChange={()=>{}}/></Suspense>
        </div></>}
      </>}
    </details>
  </>;
}

export function InvitedPublicationBasis({section,workflow,preflight,onClose}:{
  section:string;workflow:Workflow;preflight:CloudPublicationPreflight;onClose:()=>void;
}){
  const {package:bundle,report,verification}=workflow;
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus();},[section,preflight.reviewDigest]);
  if(!bundle || !verification || !titles[section])return null;
  return <section className="invited-publication-basis" aria-label={titles[section]}>
    <h4 ref={heading} tabIndex={-1}>{titles[section]}</h4>
    {section==='code'&&<><p>口径 {report.contextId} · 代码版本 <code>{report.revisionId}</code></p>
      <pre tabIndex={0} aria-label="待发布包的加工 SQL">{bundle.files['main.sql']}</pre></>}
    {section==='assertions'&&<><p>{verification.engine} {verification.engineVersion} · 原演练 <code>{verification.id}</code></p>
      <dl><div><dt>加工 SQL</dt><dd>{verification.mainSqlExecuted?'已执行':'待核对'}</dd></div>
      <div><dt>测试 SQL</dt><dd>{verification.testSqlValidation?.passed?'通过':'待核对'}</dd></div></dl>
      <ul>{verification.validation?.regressions?.map(row=><li key={row.contextId}>{row.contextId} · {row.passed?'通过':'未通过'}</li>)}</ul>
      <details><summary>查看包内测试 SQL</summary><pre tabIndex={0}>{bundle.files['tests.sql']}</pre></details></>}
    {section==='deliveryFiles'&&<ReviewFiles key={bundle.digest} bundle={bundle}/>}
    {section==='cloudScope'&&<dl>
      <div><dt>测试批次</dt><dd>{preflight.plannedBatchCount} 批 · 同一冻结样例</dd></div>
      <div><dt>业务日</dt><dd>{preflight.businessDate}</dd></div>
      <div><dt>文件约定调度时间</dt><dd>{preflight.businessScheduledFor}</dd></div>
      <div><dt>本次包摘要</dt><dd><code>{bundle.digest}</code></dd></div>
      <div><dt>本次审阅摘要</dt><dd><code>{preflight.reviewDigest}</code></dd></div>
    </dl>}
    <button type="button" className="button" onClick={onClose}>返回发布前确认</button>
  </section>;
}
