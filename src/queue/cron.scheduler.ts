import { Queue } from 'bullmq';
import { queueConnectionOptions } from './connection';

export const cronQueue = new Queue('CronSchedulerTasks', queueConnectionOptions);

export const initializeCronJobs = async () => {
  const activeRepeatableJobs = await cronQueue.getRepeatableJobs();
  for (const job of activeRepeatableJobs) {
    await cronQueue.removeRepeatableByKey(job.key);
  }

  await cronQueue.add(
    'SWEEP_EXPIRED_SUBSCRIPTIONS',
    {},
    {
      repeat: { pattern: '0 * * * *' }
    }
  );

  console.log('⏰ [Cron Engine] Repeatable hourly expiration sweep registered in Redis grid.');
};
