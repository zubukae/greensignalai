import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createInMemoryPrismaClient } from '../src/lib/inMemoryStore';

test('in-memory callback transactions roll back operational writes on error', async () => {
  const client = createInMemoryPrismaClient();
  const before = await client.operationalAudit.count();
  await assert.rejects(
    client.$transaction(async (tx: any) => {
      await tx.operationalAudit.create({
        data: {
          action: 'TEST',
          entityType: 'TASK',
          entityId: 'rollback-test',
          details: {}
        }
      });
      throw new Error('force rollback');
    }),
    /force rollback/
  );
  assert.equal(await client.operationalAudit.count(), before);
});

test('in-memory task creation persists nested assignees for individual assignment views', async () => {
  const client = createInMemoryPrismaClient();
  const suffix = `test-${randomUUID()}`;
  const user = await client.user.create({
    data: { id: `${suffix}-user`, username: suffix, fullName: 'Test Responder', role: 'WORKER' }
  });
  const node = await client.administrativeNode.create({
    data: { id: `${suffix}-node`, name: 'Test Area', tier: 'DISTRICT', parentId: null }
  });
  const task = await client.responseTask.create({
    data: {
      title: 'Test assignment',
      description: 'Check an assigned location',
      status: 'ASSIGNED',
      administrativeNodeId: node.id,
      createdById: user.id,
      assignees: { create: [{ userId: user.id }] }
    }
  });
  const assigned = await client.responseTask.findMany({
    where: { assignees: { some: { userId: user.id } } },
    include: { assignees: { include: { user: { select: { fullName: true } } } } }
  });
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, task.id);
  assert.equal(assigned[0].assignees[0].user.fullName, 'Test Responder');
});
