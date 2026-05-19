import { db } from '../backend/db';
import { featherlessClient, DeepAnalysisPayload } from './featherless';

const POLL_INTERVAL_MS = 5000;

export function startWorker() {
  console.log(`[Worker] Started. Polling every ${POLL_INTERVAL_MS}ms...`);

  let isProcessing = false;

  setInterval(async () => {
    if (isProcessing) return;

    const pendingJob = Array.from(db.jobs.values()).find(j => j.status === 'PENDING');
    if (!pendingJob) return;

    isProcessing = true;
    console.log(`[Worker] Processing job: ${pendingJob.id} (${pendingJob.type})`);
    db.updateJobStatus(pendingJob.id, 'RUNNING');
    db.updateWorkflowStatus(pendingJob.workflowId, 'IN_PROGRESS');

    try {
      if (pendingJob.type === 'DEEP_ANALYSIS') {
        const result = await featherlessClient.runDeepAnalysis(pendingJob.payload as DeepAnalysisPayload);
        db.updateJobStatus(pendingJob.id, 'COMPLETED', result);
        if ('summary' in result) {
          db.updateWorkflowState(pendingJob.workflowId, {
            stage: 'analysis_done',
            summary: result.summary,
            pros: result.pros,
            cons: result.cons,
            score: result.score,
            recommendation: result.recommendation,
          });
        }
        db.updateWorkflowStatus(pendingJob.workflowId, 'COMPLETED');
        console.log(`[Worker] Job ${pendingJob.id} COMPLETED.`);
      } else {
        db.updateJobStatus(pendingJob.id, 'FAILED', undefined, `Unknown job type: ${pendingJob.type}`);
        db.updateWorkflowStatus(pendingJob.workflowId, 'FAILED');
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      db.updateJobStatus(pendingJob.id, 'FAILED', undefined, msg);
      db.updateWorkflowStatus(pendingJob.workflowId, 'FAILED');
      console.error(`[Worker] Job ${pendingJob.id} FAILED:`, msg);
    } finally {
      isProcessing = false;
    }
  }, POLL_INTERVAL_MS);
}
