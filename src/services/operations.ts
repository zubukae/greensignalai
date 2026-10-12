import type { AlertSeverity, ResponseTaskPriority, ResponseTaskStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { IncidentService } from './incidents';

const severityRank: Record<AlertSeverity, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
const taskStatuses = new Set<ResponseTaskStatus>([
  'OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'
]);

type Actor = { id: string; role: string; districtNodeId: string | null };

async function getActor(actorId: string): Promise<Actor> {
  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { id: true, role: true, districtNodeId: true }
  });
  if (!actor) throw new Error('A signed-in account is required.');
  return actor;
}

async function requireOperationsActor(actorId: string, allowed = ['WORKER', 'COORDINATOR', 'ADMIN']) {
  const actor = await getActor(actorId);
  if (!allowed.includes(actor.role)) throw new Error('A responder account is required.');
  return actor;
}

async function getScope(actor: Actor): Promise<string[] | null> {
  if (actor.role === 'ADMIN' || actor.role === 'PLANNER') return null;
  return IncidentService.getAreaScope(actor.id);
}

async function assertNodeScope(actor: Actor, nodeId: string) {
  const scope = await getScope(actor);
  if (scope && !scope.includes(nodeId)) throw new Error('This record is outside your authorized area.');
}

async function appendAudit(
  tx: any,
  actorId: string,
  nodeId: string | null,
  action: string,
  entityType: string,
  entityId: string,
  details: Record<string, unknown> = {}
) {
  await tx.operationalAudit.create({
    data: { actorId, administrativeNodeId: nodeId, action, entityType, entityId, details }
  });
}

async function notify(tx: any, userId: string, type: string, title: string, body: string, entityType?: string, entityId?: string) {
  await tx.userNotification.create({
    data: { userId, type, title, body, entityType, entityId }
  });
}

export class OperationsService {
  static async getVolunteerProfile(actorId: string) {
    await getActor(actorId);
    return prisma.volunteerProfile.findUnique({ where: { userId: actorId } });
  }

  static async listTasks(actorId: string, page = 1, pageSize = 30) {
    const actor = await requireOperationsActor(actorId);
    const scope = await getScope(actor);
    const where: any = {};
    if (actor.role === 'WORKER') where.assignees = { some: { userId: actor.id } };
    else if (scope) where.administrativeNodeId = { in: scope };
    const [items, total] = await Promise.all([
      prisma.responseTask.findMany({
        where,
        include: {
          administrativeNode: { select: { id: true, name: true, tier: true } },
          assignees: { include: { user: { select: { id: true, fullName: true, role: true } } } },
          updates: { orderBy: { createdAt: 'asc' }, include: { author: { select: { fullName: true } } } }
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.responseTask.count({ where })
    ]);
    return { items, total, page, pageSize };
  }

  static async createTask(actorId: string, input: any) {
    const actor = await requireOperationsActor(actorId, ['COORDINATOR', 'ADMIN']);
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const description = typeof input?.description === 'string' ? input.description.trim() : '';
    if (!title || title.length > 160) throw new Error('Task title must be between 1 and 160 characters.');
    if (!description || description.length > 5000) throw new Error('Task description must be no more than 5000 characters.');
    if (typeof input?.administrativeNodeId !== 'string') throw new Error('Choose an administrative area.');
    await assertNodeScope(actor, input.administrativeNodeId);
    const node = await prisma.administrativeNode.findUnique({
      where: { id: input.administrativeNodeId },
      select: { id: true }
    });
    if (!node) throw new Error('Administrative area not found.');
    if (input.priority !== undefined && !['LOW', 'NORMAL', 'HIGH', 'URGENT'].includes(input.priority)) {
      throw new Error('Choose a valid task priority.');
    }
    const priority: ResponseTaskPriority = input.priority || 'NORMAL';
    if (input.assigneeIds !== undefined && (!Array.isArray(input.assigneeIds) || input.assigneeIds.some((id: unknown) => typeof id !== 'string'))) {
      throw new Error('Task assignees must be a list of user IDs.');
    }
    const assigneeIds: string[] = Array.isArray(input.assigneeIds) ? [...new Set(input.assigneeIds)] : [];
    if (assigneeIds.length > 50) throw new Error('A task can have no more than 50 assignees.');
    const assignees = assigneeIds.length
      ? await prisma.user.findMany({
          where: {
            id: { in: assigneeIds },
            role: 'WORKER'
          },
          include: { volunteerProfile: { select: { isAvailable: true } } }
        })
      : [];
    if (assignees.length !== assigneeIds.length || assignees.some((assignee: any) =>
      assignee.volunteerProfile && !assignee.volunteerProfile.isAvailable
    )) {
      throw new Error('Every assignee must be an authorized worker and any listed volunteer must be available.');
    }
    for (const assignee of assignees) {
      if (!assignee.districtNodeId) throw new Error('Every assignee must be assigned to an administrative area.');
      await assertNodeScope(actor, assignee.districtNodeId);
      const assigneeScope = await IncidentService.getAreaScope(assignee.id);
      if (!assigneeScope.includes(node.id)) {
        throw new Error('Each worker must be assigned within their own geographic scope.');
      }
    }

    if (input.incidentId !== undefined && input.incidentId !== null && typeof input.incidentId !== 'string') {
      throw new Error('Choose a valid incident.');
    }
    const incidentId = typeof input.incidentId === 'string' && input.incidentId ? input.incidentId : null;
    if (incidentId) {
      const incident = await prisma.disasterIncident.findUnique({
        where: { id: incidentId },
        select: { id: true, administrativeNodeId: true }
      });
      if (!incident) throw new Error('Incident not found.');
      if (incident.administrativeNodeId) await assertNodeScope(actor, incident.administrativeNodeId);
    }
    if (input.dueAt !== undefined && input.dueAt !== '' && typeof input.dueAt !== 'string') {
      throw new Error('Provide a valid task due date.');
    }
    const dueAt = input.dueAt ? new Date(input.dueAt) : null;
    if (dueAt && !Number.isFinite(dueAt.getTime())) throw new Error('Provide a valid task due date.');
    return prisma.$transaction(async (tx: any) => {
      const task = await tx.responseTask.create({
        data: {
          title,
          description,
          priority,
          status: assigneeIds.length ? 'ASSIGNED' : 'OPEN',
          dueAt,
          incidentId,
          administrativeNodeId: node.id,
          createdById: actor.id,
          assignees: { create: assigneeIds.map(userId => ({ userId })) }
        },
        include: { assignees: true, administrativeNode: { select: { id: true, name: true } } }
      });
      for (const userId of assigneeIds) {
        await notify(tx, userId, 'TASK_ASSIGNED', 'Response task assigned', title, 'TASK', task.id);
      }
      await appendAudit(tx, actor.id, node.id, 'TASK_CREATED', 'TASK', task.id, {
        priority,
        assigneeCount: assigneeIds.length
      });
      return task;
    });
  }

  static async updateTask(actorId: string, taskId: string, status: ResponseTaskStatus, noteInput: unknown) {
    const actor = await requireOperationsActor(actorId);
    if (!taskStatuses.has(status)) throw new Error('Choose a valid task status.');
    const task = await prisma.responseTask.findUnique({
      where: { id: taskId },
      include: { assignees: { select: { userId: true } } }
    });
    if (!task) throw new Error('Task not found.');
    await assertNodeScope(actor, task.administrativeNodeId);
    const assigned = task.assignees.some((entry: any) => entry.userId === actor.id);
    if (actor.role === 'WORKER' && !assigned) throw new Error('Workers can update only their assigned tasks.');
    const workerStatuses = new Set<ResponseTaskStatus>(['IN_PROGRESS', 'BLOCKED', 'COMPLETED']);
    if (actor.role === 'WORKER' && !workerStatuses.has(status)) {
      throw new Error('Workers may start, block, or complete assigned tasks.');
    }
    if (noteInput !== undefined && noteInput !== null && typeof noteInput !== 'string') {
      throw new Error('Task update notes must be text.');
    }
    const note = typeof noteInput === 'string' ? noteInput.trim() : '';
    if (note.length > 2000) throw new Error('Task update notes must be no more than 2000 characters.');
    if (status === 'COMPLETED' && !note) throw new Error('Add completion notes before completing this task.');
    const transitions: Record<ResponseTaskStatus, ResponseTaskStatus[]> = {
      OPEN: ['ASSIGNED', 'IN_PROGRESS', 'CANCELLED'],
      ASSIGNED: ['IN_PROGRESS', 'BLOCKED', 'CANCELLED'],
      IN_PROGRESS: ['BLOCKED', 'COMPLETED', 'CANCELLED'],
      BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
      COMPLETED: [],
      CANCELLED: ['OPEN']
    };
    if (task.status !== status && !transitions[task.status as ResponseTaskStatus]?.includes(status)) {
      throw new Error(`Cannot change a task from ${task.status} to ${status}.`);
    }
    const updateNote = note || `Task status changed from ${task.status} to ${status}.`;
    return prisma.$transaction(async (tx: any) => {
      const updated = await tx.responseTask.update({
        where: { id: taskId, status: task.status },
        data: { status, completedAt: status === 'COMPLETED' ? new Date() : null }
      });
      await tx.responseTaskUpdate.create({
        data: { taskId, authorId: actor.id, status, note: updateNote }
      });
      await appendAudit(tx, actor.id, task.administrativeNodeId, 'TASK_STATUS_UPDATED', 'TASK', taskId, {
        fromStatus: task.status,
        toStatus: status
      });
      const recipients = [...new Set([task.createdById, ...task.assignees.map((entry: any) => entry.userId)])]
        .filter(id => id !== actor.id);
      for (const userId of recipients) {
        await notify(tx, userId, 'TASK_UPDATED', 'Response task updated', `${task.title}: ${status.replace('_', ' ')}`, 'TASK', taskId);
      }
      return updated;
    });
  }

  static async updateVolunteerProfile(actorId: string, input: any) {
    const actor = await getActor(actorId);
    if (!actor.districtNodeId) throw new Error('Your account must be assigned to an area before creating a volunteer profile.');
    if (input?.skills !== undefined && (!Array.isArray(input.skills) || input.skills.some((skill: unknown) => typeof skill !== 'string'))) {
      throw new Error('Volunteer skills must be provided as a list of text values.');
    }
    const skills = Array.isArray(input?.skills)
      ? [...new Set(input.skills.map((skill: string) => skill.trim()).filter(Boolean))]
      : [];
    if (skills.length > 30 || skills.some((skill: string) => skill.length > 60)) {
      throw new Error('Provide up to 30 volunteer skills, each no longer than 60 characters.');
    }
    if (input?.isAvailable !== undefined && typeof input.isAvailable !== 'boolean') {
      throw new Error('Volunteer availability must be true or false.');
    }
    if (input?.availabilityNote !== undefined && input.availabilityNote !== null && typeof input.availabilityNote !== 'string') {
      throw new Error('Volunteer availability notes must be text.');
    }
    const rawAvailabilityNote = typeof input?.availabilityNote === 'string' ? input.availabilityNote.trim() : '';
    if (rawAvailabilityNote.length > 500) throw new Error('Volunteer availability notes must be no more than 500 characters.');
    const availabilityNote = rawAvailabilityNote || null;
    return prisma.$transaction(async (tx: any) => {
      const profile = await tx.volunteerProfile.upsert({
        where: { userId: actor.id },
        create: {
          userId: actor.id,
          administrativeNodeId: actor.districtNodeId,
          skills,
          isAvailable: input?.isAvailable === true,
          availabilityNote
        },
        update: {
          administrativeNodeId: actor.districtNodeId,
          skills,
          isAvailable: input?.isAvailable === true,
          availabilityNote
        }
      });
      await appendAudit(tx, actor.id, actor.districtNodeId, 'VOLUNTEER_PROFILE_UPDATED', 'VOLUNTEER', actor.id, {
        isAvailable: profile.isAvailable,
        skillCount: profile.skills.length
      });
      return profile;
    });
  }

  static async listVolunteers(actorId: string) {
    const actor = await requireOperationsActor(actorId);
    const scope = await getScope(actor);
    if (actor.role === 'WORKER') throw new Error('Only coordinators can view volunteer rosters.');
    const profileWhere: any = {};
    const workerWhere: any = { role: 'WORKER' };
    if (scope) {
      profileWhere.administrativeNodeId = { in: scope };
      workerWhere.districtNodeId = { in: scope };
    }
    const [profiles, workers] = await Promise.all([
      prisma.volunteerProfile.findMany({
        where: profileWhere,
        select: {
          userId: true,
          skills: true,
          isAvailable: true,
          availabilityNote: true,
          updatedAt: true,
          user: { select: { fullName: true, phone: true, districtNodeId: true, role: true } }
        },
        orderBy: [{ isAvailable: 'desc' }, { updatedAt: 'desc' }]
      }),
      prisma.user.findMany({
        where: workerWhere,
        include: { volunteerProfile: true }
      })
    ]);
    const result = profiles.slice();
    const profiledWorkers = new Set(profiles.map((profile: any) => profile.userId));
    for (const worker of workers) {
      if (profiledWorkers.has(worker.id)) continue;
      result.push({
        userId: worker.id,
        skills: [],
        isAvailable: true,
        availabilityNote: null,
        updatedAt: worker.updatedAt,
        user: {
          fullName: worker.fullName,
          phone: worker.phone,
          districtNodeId: worker.districtNodeId,
          role: worker.role
        }
      });
    }
    return result.sort((a: any, b: any) => Number(b.isAvailable) - Number(a.isAvailable));
  }

  static async listShelters(actorId: string) {
    const actor = await requireOperationsActor(actorId);
    const scope = await getScope(actor);
    const where = scope ? { districtNodeId: { in: scope } } : {};
    return prisma.reliefCenter.findMany({
      where,
      select: {
        id: true, name: true, centerCode: true, districtNodeId: true, capacity: true,
        occupancy: true, isOperational: true, verificationStatus: true, verifiedAt: true,
        districtNode: { select: { name: true, tier: true } }
      },
      orderBy: { name: 'asc' }
    });
  }

  static async updateShelter(actorId: string, shelterId: string, input: any) {
    const actor = await requireOperationsActor(actorId, ['COORDINATOR', 'ADMIN']);
    const shelter = await prisma.reliefCenter.findUnique({
      where: { id: shelterId },
      select: { id: true, name: true, districtNodeId: true, capacity: true, occupancy: true, verificationStatus: true }
    });
    if (!shelter) throw new Error('Shelter not found.');
    await assertNodeScope(actor, shelter.districtNodeId);
    const hasOccupancy = input?.occupancy !== undefined;
    const occupancy = input?.occupancy;
    if (hasOccupancy && (!Number.isSafeInteger(occupancy) || occupancy < 0 || occupancy > shelter.capacity)) {
      throw new Error(`Occupancy must be a whole number from 0 to ${shelter.capacity}.`);
    }
    const status = input?.verificationStatus;
    if (status !== undefined && !['VERIFIED', 'NEEDS_REVIEW', 'UNVERIFIED'].includes(status)) {
      throw new Error('Choose a valid shelter verification status.');
    }
    if (input?.note !== undefined && input.note !== null && typeof input.note !== 'string') {
      throw new Error('Shelter update notes must be text.');
    }
    const rawNote = typeof input?.note === 'string' ? input.note.trim() : '';
    if (rawNote.length > 500) throw new Error('Shelter update notes must be no more than 500 characters.');
    const note = rawNote || null;
    return prisma.$transaction(async (tx: any) => {
      const updated = await tx.reliefCenter.update({
        where: {
          id: shelter.id,
          occupancy: shelter.occupancy,
          verificationStatus: shelter.verificationStatus
        },
        data: {
          ...(hasOccupancy ? { occupancy } : {}),
          ...(status ? {
            verificationStatus: status,
            verifiedAt: status === 'VERIFIED' ? new Date() : null,
            verifiedById: status === 'VERIFIED' ? actor.id : null
          } : {})
        }
      });
      if (hasOccupancy && occupancy !== shelter.occupancy) {
        await tx.shelterOccupancyUpdate.create({
          data: {
            reliefCenterId: shelter.id,
            updatedById: actor.id,
            previousOccupancy: shelter.occupancy,
            occupancy,
            note
          }
        });
      }
      await appendAudit(tx, actor.id, shelter.districtNodeId, 'SHELTER_UPDATED', 'SHELTER', shelter.id, {
        previousOccupancy: shelter.occupancy,
        occupancy: hasOccupancy ? occupancy : shelter.occupancy,
        previousVerificationStatus: shelter.verificationStatus,
        verificationStatus: status || shelter.verificationStatus
      });
      return updated;
    });
  }

  static async listNotifications(actorId: string) {
    await getActor(actorId);
    return prisma.userNotification.findMany({
      where: { userId: actorId },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
  }

  static async markNotificationRead(actorId: string, notificationId: string) {
    await getActor(actorId);
    const result = await prisma.userNotification.updateMany({
      where: { id: notificationId, userId: actorId, readAt: null },
      data: { readAt: new Date() }
    });
    if (!result.count) throw new Error('Notification not found.');
    return { success: true };
  }

  static async saveAlertSubscription(actorId: string, input: any) {
    const actor = await getActor(actorId);
    const nodeId = input?.administrativeNodeId;
    if (typeof nodeId !== 'string') throw new Error('Choose an area for alert subscriptions.');
    if (!await prisma.administrativeNode.findUnique({ where: { id: nodeId }, select: { id: true } })) {
      throw new Error('Administrative area not found.');
    }
    if (input?.hazardTypes !== undefined && (!Array.isArray(input.hazardTypes) || input.hazardTypes.some((value: unknown) => typeof value !== 'string'))) {
      throw new Error('Alert hazard filters must be provided as a list of text values.');
    }
    const hazardTypes = Array.isArray(input?.hazardTypes)
      ? [...new Set(input.hazardTypes.map((value: string) => value.trim().toUpperCase()).filter(Boolean))]
      : [];
    if (hazardTypes.length > 20 || hazardTypes.some((value: string) => !/^[A-Z_]{2,40}$/.test(value))) {
      throw new Error('Choose valid hazard types.');
    }
    const minimumSeverity = input?.minimumSeverity;
    if (!['INFO', 'WARNING', 'CRITICAL'].includes(minimumSeverity)) {
      throw new Error('Choose a minimum alert severity.');
    }
    return prisma.alertSubscription.upsert({
      where: { userId_administrativeNodeId: { userId: actor.id, administrativeNodeId: nodeId } },
      create: { userId: actor.id, administrativeNodeId: nodeId, hazardTypes, minimumSeverity, isActive: true },
      update: { hazardTypes, minimumSeverity, isActive: true }
    });
  }

  static async listAlertSubscriptions(actorId: string) {
    await getActor(actorId);
    return prisma.alertSubscription.findMany({
      where: { userId: actorId },
      include: { administrativeNode: { select: { id: true, name: true, tier: true } } },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async deleteAlertSubscription(actorId: string, subscriptionId: string) {
    await getActor(actorId);
    const result = await prisma.alertSubscription.deleteMany({ where: { id: subscriptionId, userId: actorId } });
    if (!result.count) throw new Error('Alert subscription not found.');
    return { success: true };
  }

  static async broadcastAlert(actorId: string, input: any) {
    const actor = await requireOperationsActor(actorId, ['COORDINATOR', 'ADMIN']);
    const title = typeof input?.title === 'string' ? input.title.trim() : '';
    const description = typeof input?.description === 'string' ? input.description.trim() : '';
    let district = typeof input?.district === 'string' ? input.district.trim() : '';
    const administrativeNodeId = typeof input?.administrativeNodeId === 'string'
      ? input.administrativeNodeId
      : null;
    const severity = input?.severity || 'WARNING';
    const hazardType = typeof input?.hazardType === 'string' ? input.hazardType.trim().toUpperCase() : '';
    if (input?.hazardType !== undefined && input.hazardType !== null && typeof input.hazardType !== 'string') {
      throw new Error('Alert hazard type must be text.');
    }
    if (!title || title.length > 160 || !description || description.length > 4000) {
      throw new Error('Alert title and description are required and must be within the length limits.');
    }
    if (!['INFO', 'WARNING', 'CRITICAL'].includes(severity)) throw new Error('Choose a valid alert severity.');
    if ((!district && !administrativeNodeId) || district.length > 100) throw new Error('Choose a district or NATIONWIDE.');
    if (hazardType && !/^[A-Z_]{2,40}$/.test(hazardType)) throw new Error('Choose a valid alert hazard type.');
    const nationwide = !administrativeNodeId && district.toUpperCase() === 'NATIONWIDE';
    const targetNode = nationwide ? null : administrativeNodeId
      ? await prisma.administrativeNode.findUnique({
          where: { id: administrativeNodeId },
          select: { id: true, parentId: true, name: true, tier: true }
        })
      : await prisma.administrativeNode.findFirst({
          where: { name: { equals: district, mode: 'insensitive' } },
          select: { id: true, parentId: true, name: true, tier: true }
        });
    if (!nationwide && !targetNode) throw new Error('Choose a configured district or upazila.');
    if (targetNode && !['DISTRICT', 'UPAZILA'].includes(targetNode.tier)) {
      throw new Error('Alert target must be a district or upazila.');
    }
    if (targetNode) district = targetNode.name;
    if (nationwide && actor.role !== 'ADMIN') throw new Error('Only administrators can broadcast nationwide alerts.');
    if (targetNode) await assertNodeScope(actor, targetNode.id);

    const subscriptions = await prisma.alertSubscription.findMany({
      where: { isActive: true },
      select: { id: true, userId: true, administrativeNodeId: true, hazardTypes: true, minimumSeverity: true }
    });
    const nodes = targetNode ? await prisma.administrativeNode.findMany({ select: { id: true, parentId: true } }) : [];
    const relevantNodeIds = new Set<string>();
    if (targetNode) {
      let ancestorId: string | null = targetNode.id;
      while (ancestorId) {
        relevantNodeIds.add(ancestorId);
        ancestorId = nodes.find((node: any) => node.id === ancestorId)?.parentId || null;
      }
      for (const node of nodes) {
        let cursor: string | null = node.id;
        while (cursor) {
          if (cursor === targetNode.id) {
            relevantNodeIds.add(node.id);
            break;
          }
          cursor = nodes.find((entry: any) => entry.id === cursor)?.parentId || null;
        }
      }
    }
    const receivers = subscriptions.filter((subscription: any) => {
      const areaMatches = nationwide || relevantNodeIds.has(subscription.administrativeNodeId);
      const hazardMatches = !subscription.hazardTypes.length ||
        (hazardType && subscription.hazardTypes.includes(hazardType));
      return areaMatches && hazardMatches && severityRank[severity as AlertSeverity] >= severityRank[subscription.minimumSeverity];
    });
    return prisma.$transaction(async (tx: any) => {
      const alert = await tx.disasterAlert.create({
        data: { title, description, district, hazardType: hazardType || null, severity }
      });
      for (const subscription of receivers) {
        await notify(tx, subscription.userId, 'DISASTER_ALERT', title, description, 'ALERT', alert.id);
      }
      await appendAudit(tx, actor.id, targetNode?.id || null, 'ALERT_BROADCAST', 'ALERT', alert.id, {
        district, severity, hazardType: hazardType || null, subscriptionRecipients: receivers.length
      });
      return alert;
    });
  }

  static async addIncidentAttachment(actorId: string, incidentId: string, input: any) {
    const actor = await requireOperationsActor(actorId);
    const incident = await prisma.disasterIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, administrativeNodeId: true }
    });
    if (!incident) throw new Error('Incident not found.');
    if (incident.administrativeNodeId) await assertNodeScope(actor, incident.administrativeNodeId);
    const rawFileName = typeof input?.fileName === 'string' ? input.fileName.trim() : '';
    if (rawFileName.length > 255) throw new Error('Attachment file name must be no more than 255 characters.');
    const fileName = rawFileName.replace(/[\\/\0]/g, '_');
    const contentType = typeof input?.contentType === 'string' ? input.contentType.toLowerCase() : '';
    if (!fileName || !/^(image\/(jpeg|png|webp)|application\/pdf)$/.test(contentType)) {
      throw new Error('Attach a JPEG, PNG, WebP image, or PDF file.');
    }
    if (typeof input?.contentBase64 !== 'string' || input.contentBase64.length > 7_000_000) {
      throw new Error('Attachment must be no larger than 5 MB.');
    }
    const content = Buffer.from(input.contentBase64, 'base64');
    if (!content.length || content.length > 5 * 1024 * 1024 || content.toString('base64').replace(/=+$/, '') !== input.contentBase64.replace(/=+$/, '')) {
      throw new Error('Attachment content is invalid or exceeds the 5 MB limit.');
    }
    const fileSize = content.length;
    return prisma.$transaction(async (tx: any) => {
      const attachment = await tx.incidentAttachment.create({
        data: { incidentId, uploadedById: actor.id, fileName, contentType, fileSize, content },
        select: { id: true, incidentId: true, fileName: true, contentType: true, fileSize: true, createdAt: true }
      });
      await appendAudit(tx, actor.id, incident.administrativeNodeId, 'INCIDENT_ATTACHMENT_ADDED', 'INCIDENT', incidentId, {
        attachmentId: attachment.id,
        fileName,
        fileSize
      });
      return attachment;
    });
  }

  static async listIncidentAttachments(actorId: string, incidentId: string) {
    const actor = await requireOperationsActor(actorId);
    const incident = await prisma.disasterIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, administrativeNodeId: true }
    });
    if (!incident) throw new Error('Incident not found.');
    if (incident.administrativeNodeId) await assertNodeScope(actor, incident.administrativeNodeId);
    return prisma.incidentAttachment.findMany({
      where: { incidentId },
      select: { id: true, fileName: true, contentType: true, fileSize: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  static async getIncidentAttachment(actorId: string, attachmentId: string) {
    const actor = await requireOperationsActor(actorId);
    const attachment = await prisma.incidentAttachment.findUnique({
      where: { id: attachmentId },
      include: { incident: { select: { administrativeNodeId: true } } }
    });
    if (!attachment) throw new Error('Attachment not found.');
    if (attachment.incident.administrativeNodeId) await assertNodeScope(actor, attachment.incident.administrativeNodeId);
    return attachment;
  }

  static async listAudit(actorId: string, page = 1, pageSize = 50) {
    const actor = await requireOperationsActor(actorId, ['COORDINATOR', 'ADMIN']);
    const scope = await getScope(actor);
    const where: any = {};
    if (scope) where.administrativeNodeId = { in: scope };
    const [items, total] = await Promise.all([
      prisma.operationalAudit.findMany({
        where,
        include: {
          actor: { select: { fullName: true, role: true } },
          administrativeNode: { select: { name: true } }
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.operationalAudit.count({ where })
    ]);
    return { items, total, page, pageSize };
  }
}
