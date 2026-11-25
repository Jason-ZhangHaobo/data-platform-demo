import type {NativeSyncPublication} from '../../src/v2/native-sync-publication-client.mjs';
import type {NativeSyncReview, NativeSyncReviewBinding} from '../../src/v2/native-sync-review-client.mjs';
import {serviceHandoffLocation} from './service-source-binding.ts';

// The caller has verified each receipt. Join the two on the displayed review
// and release before handing a specific monitor row to the services workbench.
export function nativeBatchServiceHref(href:string, selected:NativeSyncReviewBinding, review:NativeSyncReview,
  release:NativeSyncPublication, batchId:string) {
  const monitor=release.monitor;
  if (review.review.status!=='REVIEWED' || release.phase!=='RELEASED' || !monitor?.completed ||
      review.review.id!==release.binding.reviewId || review.evidence.syncRehearsalDigest!==release.binding.syncRehearsalDigest ||
      monitor.businessDate!==review.evidence.rehearsal.businessDate) return;
  for (const field of ['taskId','deliveryId','packageId','packageDigest','verificationId'] as const) {
    if (selected[field]!==review.binding[field] || selected[field]!==release.binding[field]) return;
  }
  if (monitor.runs.length!==2 || monitor.runs[0].id===monitor.runs[1].id || !monitor.runs.some(run=>run.id===batchId)) return;
  const {revisionId,runId}=review.evidence.source;
  const url=serviceHandoffLocation(href,{taskId:selected.taskId,packageDigest:selected.packageDigest,releaseId:monitor.releaseId,
    sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',revisionId,runId});
  url.searchParams.set('release_batch',batchId);
  return url.pathname+url.search;
}
