import { Worker, Job } from 'bullmq';
import { queueConnectionOptions } from './connection';
import { PrismaClient } from '@prisma/client';
import MetaApi from 'metaapi.cloud-sdk';
import { ENV } from '../config/env';

const prisma = new PrismaClient();
const metaApi = new MetaApi(ENV.METAAPI_TOKEN);

export const enforcementWorker = new Worker(
  'EnforcementTasks',
  async (job: Job) => {
    if (job.name === 'SWEEP_EXPIRED_SUBSCRIPTIONS') {
      console.log('[Cron Worker] Initiating system-wide subscription expiry sweep...');
      const now = new Date();

      const expiredUsers = await prisma.user.findMany({
        where: {
          subscriptionStatus: true,
          subscriptionExpiry: { lt: now }
        },
        include: {
          tradingAccounts: {
            include: {
              subscriptions: { where: { isActive: true } }
            }
          }
        }
      });

      if (expiredUsers.length === 0) {
        console.log('[Cron Worker] Verification check complete. Zero expired records found.');
        return;
      }

      const copyFactory = metaApi.copyFactoryApi;

      for (const user of expiredUsers) {
        console.log(`[Expiry Triggered] Revoking access for User ID: ${user.id}`);

        for (const account of user.tradingAccounts) {
          for (const sub of account.subscriptions) {
            try {
              await copyFactory.deleteSubscriber(sub.metaApiSubscriberId);
              await prisma.strategySubscription.update({
                where: { id: sub.id },
                data: { isActive: false }
              });
            } catch (error: any) {
              console.error(`[MetaApi Error] Failed to revoke connection token ${sub.metaApiSubscriberId}: ${error.message}`);
            }
          }

          await prisma.tradingAccount.update({
            where: { id: account.id },
            data: { connectionStatus: 'DISCONNECTED' }
          });
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { subscriptionStatus: false }
        });
      }
    }
  },
  { ...queueConnectionOptions, concurrency: 1 }
);
