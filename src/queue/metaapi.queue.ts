import { Queue, Worker, Job } from 'bullmq';
import { queueConnectionOptions } from './connection';
import MetaApi from 'metaapi.cloud-sdk';
import { ENV } from '../config/env';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const metaApi = new MetaApi(ENV.METAAPI_TOKEN);

export const metaapiQueue = new Queue('MetaApiTasks', queueConnectionOptions);

export const metaapiWorker = new Worker(
  'MetaApiTasks',
  async (job: Job) => {
    const { type, payload } = job.data;

    switch (type) {
      case 'PROVISION_TERMINAL': {
        const { accountId, login, password, server } = payload;
        try {
          const account = await metaApi.metatraderAccountApi.createMetatraderAccount({
            name: `PesaMatrix_${login}`,
            type: 'cloud',
            platform: 'mt5',
            login: login,
            password: password,
            server: server,
            magic: 10001,
            quoteStreamingIntervalInSeconds: 2.5
          });

          await prisma.tradingAccount.update({
            where: { id: accountId },
            data: { 
              metaApiAccountId: account.id,
              connectionStatus: 'CONNECTED' 
            }
          });

          await account.deploy();
          await account.waitConnected();
        } catch (error: any) {
          await prisma.tradingAccount.update({
            where: { id: accountId },
            data: { connectionStatus: 'FAILED' }
          });
          throw new Error(`Failed to spin up cloud terminal: ${error.message}`);
        }
        break;
      }

      case 'CREATE_COPY_STRATEGY': {
        const { strategyId, masterMetaApiId, name } = payload;
        try {
          const copyFactory = metaApi.copyFactoryApi;
          const strategy = await copyFactory.createStrategy({
            name: name,
            accountId: masterMetaApiId,
            stopOutBalance: 100,
          });

          await prisma.copyStrategy.update({
            where: { id: strategyId },
            data: { metaApiStrategyId: strategy.id }
          });
        } catch (error: any) {
          throw new Error(`Failed to initialize strategy inside CopyFactory: ${error.message}`);
        }
        break;
      }

      case 'SUBSCRIBE_ACCOUNT': {
        const { subscriptionId, strategyMetaApiId, subscriberMetaApiId, riskMultiplier } = payload;
        try {
          const copyFactory = metaApi.copyFactoryApi;
          const subscriber = await copyFactory.createSubscriber({
            accountId: subscriberMetaApiId,
            strategies: [{ id: strategyMetaApiId, ratio: riskMultiplier }]
          });

          await prisma.strategySubscription.update({
            where: { id: subscriptionId },
            data: { 
              metaApiSubscriberId: subscriber.id,
              isActive: true 
            }
          });
        } catch (error: any) {
          throw new Error(`Failed linking subscriber to network strategy: ${error.message}`);
        }
        break;
      }
    }
  },
  { ...queueConnectionOptions, concurrency: 5 }
);
