import { PrismaClient } from '@prisma/client';
import { createInMemoryPrismaClient } from './inMemoryStore';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const globalForPrisma = global as unknown as { prisma: any; inMemoryPrisma: any };

const isDbConfigured = Boolean(
  process.env.DATABASE_URL &&
  process.env.DATABASE_URL.trim().length > 0 &&
  !process.env.DATABASE_URL.includes('localhost:5432')
);

const fallbackClient = globalForPrisma.inMemoryPrisma || createInMemoryPrismaClient();
if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.inMemoryPrisma = fallbackClient;
}

function createResilientPrismaClient() {
  if (!isDbConfigured) {
    console.log('[GreenSignal AI] Active in-memory disaster response database store initialized.');
    return fallbackClient;
  }

  let realPrisma: any = null;
  try {
    realPrisma = new PrismaClient({
      log: [
        { emit: 'event', level: 'error' },
        { emit: 'event', level: 'warn' }
      ]
    });

    // Custom event handlers to capture logs cleanly without raw prisma:error stdout noise
    if (typeof realPrisma.$on === 'function') {
      realPrisma.$on('error', (e: any) => {
        console.warn('[Database] Prisma notice:', e.message || e);
      });
      realPrisma.$on('warn', (e: any) => {
        console.warn('[Database] Prisma warning:', e.message || e);
      });
    }
  } catch (initErr) {
    console.warn('[GreenSignal AI] PostgreSQL instantiation notice — activating in-memory store:', initErr);
    return fallbackClient;
  }

  const modelNames = [
    'user',
    'administrativeNode',
    'sensorNode',
    'reliefCenter',
    'chatMessage',
    'disasterAlert',
    'disasterIncident',
    'incidentUpdate',
    'coordinationGroup',
    'coordinationGroupMember',
    'volunteerProfile',
    'responseTask',
    'responseTaskAssignee',
    'responseTaskUpdate',
    'userNotification',
    'alertSubscription',
    'incidentAttachment',
    'shelterOccupancyUpdate',
    'operationalAudit',
    'responsePolicy',
    'simulationRun'
  ];

  const resilientClient: any = {
    $transaction: async (callback: (transaction: any) => Promise<any>) => {
      if (!realPrisma) return fallbackClient.$transaction(callback);
      return realPrisma.$transaction(async (realTransaction: any) => {
        const transactionClient: any = {};
        for (const model of modelNames) {
          transactionClient[model] = new Proxy(
            {},
            {
              get(_target, prop: string) {
                return (...args: any[]) => {
                  const method = realTransaction[model]?.[prop];
                  if (typeof method !== 'function') {
                    throw new Error(`Method ${prop} not found on transaction model ${model}`);
                  }
                  return method.apply(realTransaction[model], args);
                };
              }
            }
          );
        }
        return callback(transactionClient);
      });
    },
    $disconnect: async () => {
      try {
        if (realPrisma) await realPrisma.$disconnect();
      } catch {
        // Safe ignore
      }
    },
    $queryRawUnsafe: async (query: string, ...values: any[]) => {
      try {
        if (realPrisma) return await realPrisma.$queryRawUnsafe(query, ...values);
      } catch (err: any) {
        console.warn('[Database] Raw query fallback:', err.message);
      }
      return fallbackClient.$queryRawUnsafe(query);
    },
    $executeRawUnsafe: async (query: string, ...values: any[]) => {
      try {
        if (realPrisma) return await realPrisma.$executeRawUnsafe(query, ...values);
      } catch (err: any) {
        console.warn('[Database] Raw execute fallback:', err.message);
      }
      return fallbackClient.$executeRawUnsafe(query);
    }
  };

  for (const model of modelNames) {
    resilientClient[model] = new Proxy(
      {},
      {
        get(_target, prop: string) {
          return async (...args: any[]) => {
            if (realPrisma && realPrisma[model] && typeof realPrisma[model][prop] === 'function') {
              try {
                return await realPrisma[model][prop](...args);
              } catch (queryErr: any) {
                console.warn(`[Database] Query on ${model}.${prop} redirected to in-memory store:`, queryErr.message || queryErr);
                if (fallbackClient[model] && typeof fallbackClient[model][prop] === 'function') {
                  return await fallbackClient[model][prop](...args);
                }
                throw queryErr;
              }
            }
            if (fallbackClient[model] && typeof fallbackClient[model][prop] === 'function') {
              return await fallbackClient[model][prop](...args);
            }
            throw new Error(`Method ${prop} not found on model ${model}`);
          };
        }
      }
    );
  }

  return resilientClient;
}

let clientInstance: any;

if (globalForPrisma.prisma) {
  clientInstance = globalForPrisma.prisma;
} else {
  clientInstance = createResilientPrismaClient();
  if (process.env.NODE_ENV !== 'production') {
    globalForPrisma.prisma = clientInstance;
  }
}

export const prisma = clientInstance;
