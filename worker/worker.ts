import { db } from '../backend/db';
import { featherlessClient } from './featherless';

const POLL_INTERVAL_MS = 5000;

export function startWorker() {
  console.log(`[Worker] Started polling for jobs every ${POLL_INTERVAL_MS}ms...`);
  
  setInterval(async () => {
    // Find a pending job
    const pendingJob = Array.from(db.jobs.values()).find(j => j.status === 'PENDING');
    
    if (pendingJob) {
      console.log(`[Worker] Found pending job: ${pendingJob.id} of type ${pendingJob.type}`);
      db.updateJobStatus(pendingJob.id, 'RUNNING');

      try {
        if (pendingJob.type === 'DEEP_ANALYSIS') {
          const result = await featherlessClient.runDeepAnalysis(pendingJob.payload);
          db.updateJobStatus(pendingJob.id, 'COMPLETED', result);
          console.log(`[Worker] Job ${pendingJob.id} COMPLETED successfully.`);
          
          // Optionally, we could trigger a Discord webhook here to notify users,
          // or rely on the user checking status via /status in Discord.
        } else {
          db.updateJobStatus(pendingJob.id, 'FAILED', undefined, 'Unknown job type');
        }
      } catch (error: any) {
        db.updateJobStatus(pendingJob.id, 'FAILED', undefined, error.message);
        console.error(`[Worker] Job ${pendingJob.id} FAILED:`, error.message);
      }
    }
  }, POLL_INTERVAL_MS);
}
