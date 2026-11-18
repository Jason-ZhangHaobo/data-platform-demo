import {ModelUnavailable} from './model.mjs';
import {safeModelDiagnostic} from './model-diagnostics.mjs';
import {sourceReportUsage} from './source-report-execution.mjs';

// One planning call per saved task. Persist its allowance before provider I/O,
// and settle usage independently of whether a later proposal may be adopted.
export async function runBudgetedPlanning({store, project, kind, id, signal, budget, persist, invoke}) {
  const read = () => store.get(kind, id, project);
  const change = patch => store.update(kind, id, project, patch);
  const unsent = {
    model: undefined, usage: undefined, usageEstimated: false,
    usageUnknown: false, modelRequestSent: false,
  };
  try {
    budget.assertCanStartModel();
  } catch (error) {
    change(unsent);
    throw error;
  }
  const reserved = budget.fallbackTokens;
  change({model: 'unconfirmed', usage: {total_tokens: reserved},
    usageEstimated: true, usageUnknown: true, modelRequestSent: undefined});
  try {
    await persist();
  } catch (error) {
    change(unsent);
    throw error;
  }
  if (signal.aborted || read().status === 'CANCELLED') {
    change(unsent);
    await persist();
    return;
  }
  let generated;
  try {
    generated = await invoke();
  } catch (error) {
    const diagnostic = safeModelDiagnostic(error);
    if (error instanceof ModelUnavailable || !diagnostic.requestMayHaveBeenSent)
      change(unsent);
    else if (error?.modelResultRecorded)
      change({...sourceReportUsage(error, reserved), modelRequestSent: true});
    await persist();
    throw error;
  }
  change({...sourceReportUsage(generated, reserved), modelRequestSent: true});
  await persist();
  return generated;
}
