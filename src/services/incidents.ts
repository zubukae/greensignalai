import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { IncidentReportSource, IncidentStatus, IncidentUpdateType } from '@prisma/client';
import { JWT_SECRET } from '../lib/authToken';
import { prisma } from '../lib/prisma';

export interface IncidentSubmission {
  title: string;
  description: string;
  hazardType: string;
  districtNodeId: string;
  unionName?: string;
  ward?: string;
  village?: string;
  latitude?: number;
  longitude?: number;
  peopleAffected?: number;
  householdsDisplaced?: number;
  peopleInjured?: number;
  fatalities?: number;
}

const validHazards = new Set([
  'CYCLONE',
  'STORM_SURGE',
  'FLOOD',
  'FLASH_FLOOD',
  'HEAVY_RAIN',
  'WATERLOGGING',
  'LANDSLIDE',
  'LIGHTNING',
  'EARTHQUAKE',
  'DROUGHT',
  'EXTREME_HEAT',
  'OTHER'
]);

function hashStatusToken(token: string): string {
  return createHash('sha256').update(`${JWT_SECRET}:${token}`).digest('hex');
}

function makeReferenceCode(): string {
  const day = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `BD-${day}-${randomBytes(6).toString('hex').toUpperCase()}`;
}

function validateOptionalCount(value: unknown, field: string): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000_000) {
    throw new Error(`${field} must be a non-negative whole number.`);
  }
  return value;
}

export class IncidentService {
  static async submitReport(
    submission: IncidentSubmission,
    reporterId: string | null,
    reportSource: IncidentReportSource = 'CITIZEN'
  ) {
    const title = typeof submission.title === 'string' ? submission.title.trim() : '';
    const description = typeof submission.description === 'string' ? submission.description.trim() : '';
    const hazardType = typeof submission.hazardType === 'string' ? submission.hazardType.toUpperCase() : '';
    if (!title || title.length > 120) throw new Error('Title must be between 1 and 120 characters.');
    if (!description || description.length < 10 || description.length > 4000) {
      throw new Error('Description must be between 10 and 4000 characters.');
    }
    if (!validHazards.has(hazardType)) throw new Error('Choose a supported hazard type.');
    if (!submission.districtNodeId || typeof submission.districtNodeId !== 'string') {
      throw new Error('Select the affected administrative area.');
    }

    const node = await prisma.administrativeNode.findUnique({
      where: { id: submission.districtNodeId },
      select: { id: true, name: true, tier: true, parentId: true }
    });
    if (!node || !['DISTRICT', 'UPAZILA'].includes(node.tier)) {
      throw new Error('Select a valid district or upazila in Bangladesh.');
    }
    const ancestors = [node];
    let parent = node.parentId
      ? await prisma.administrativeNode.findUnique({
          where: { id: node.parentId },
          select: { id: true, name: true, tier: true, parentId: true }
        })
      : null;
    while (parent) {
      ancestors.push(parent);
      parent = parent.parentId
        ? await prisma.administrativeNode.findUnique({
            where: { id: parent.parentId },
            select: { id: true, name: true, tier: true, parentId: true }
          })
        : null;
    }

    const coordinatesProvided = submission.latitude !== undefined || submission.longitude !== undefined;
    if (coordinatesProvided) {
      if (
        typeof submission.latitude !== 'number' ||
        typeof submission.longitude !== 'number' ||
        !Number.isFinite(submission.latitude) ||
        !Number.isFinite(submission.longitude) ||
        submission.latitude < 20.3 || submission.latitude > 26.7 ||
        submission.longitude < 88 || submission.longitude > 92.8
      ) {
        throw new Error('Coordinates must be valid locations within Bangladesh.');
      }
    }

    const statusAccessToken = randomBytes(32).toString('base64url');
    const referenceCode = makeReferenceCode();
    return prisma.$transaction(async (tx: any) => {
      const incident = await tx.disasterIncident.create({
        data: {
          referenceCode,
          title,
          description,
          hazardType,
          reportSource,
          severity: 'INFO',
          status: 'REPORTED',
          division: ancestors.find((area: any) => area.tier === 'DIVISION')?.name || null,
          district: ancestors.find((area: any) => area.tier === 'DISTRICT')?.name || node.name,
          upazila: ancestors.find((area: any) => area.tier === 'UPAZILA')?.name || null,
          unionName: typeof submission.unionName === 'string' ? submission.unionName.trim().slice(0, 100) || null : null,
          ward: typeof submission.ward === 'string' ? submission.ward.trim().slice(0, 50) || null : null,
          village: typeof submission.village === 'string' ? submission.village.trim().slice(0, 100) || null : null,
          latitude: coordinatesProvided ? submission.latitude : null,
          longitude: coordinatesProvided ? submission.longitude : null,
          peopleAffected: validateOptionalCount(submission.peopleAffected, 'Affected people'),
          householdsDisplaced: validateOptionalCount(submission.householdsDisplaced, 'Displaced households'),
          peopleInjured: validateOptionalCount(submission.peopleInjured, 'Injured people'),
          fatalities: validateOptionalCount(submission.fatalities, 'Fatalities'),
          administrativeNodeId: node.id,
          reportedById: reporterId,
          statusAccessTokenHash: hashStatusToken(statusAccessToken)
        },
        select: {
          id: true,
          referenceCode: true,
          title: true,
          status: true,
          createdAt: true
        }
      });
      await tx.incidentUpdate.create({
        data: {
          incidentId: incident.id,
          authorId: reporterId,
          type: 'REPORT_SUBMITTED',
          content: 'Incident report submitted. Awaiting verification.'
        }
      });
      return { ...incident, statusAccessToken };
    });
  }

  static async checkReportStatus(referenceCode: string, token: string) {
    if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
    const incident = await prisma.disasterIncident.findUnique({
      where: { referenceCode },
      select: {
        id: true,
        referenceCode: true,
        status: true,
        title: true,
        hazardType: true,
        createdAt: true,
        updatedAt: true,
        statusAccessTokenHash: true
      }
    });
    if (!incident || !incident.statusAccessTokenHash) return null;

    const actual = Buffer.from(hashStatusToken(token), 'hex');
    const expected = Buffer.from(incident.statusAccessTokenHash, 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const updates = await prisma.incidentUpdate.findMany({
      where: { incidentId: incident.id },
      select: { type: true, content: true, fromStatus: true, toStatus: true, createdAt: true },
      orderBy: { createdAt: 'asc' }
    });
    const { statusAccessTokenHash: _secret, id: _id, ...publicIncident } = incident;
    return { ...publicIncident, updates };
  }

  static async getAreaScope(userId: string): Promise<string[]> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, districtNodeId: true }
    });
    if (!user || user.role === 'CITIZEN') throw new Error('A responder account is required.');
    if (user.role === 'ADMIN' || user.role === 'PLANNER') return [];
    if (!user.districtNodeId) throw new Error('Your account is not assigned to an administrative area.');

    const nodes = await prisma.administrativeNode.findMany({
      select: { id: true, parentId: true }
    });
    const children = new Map<string, string[]>();
    for (const item of nodes) {
      if (!item.parentId) continue;
      const siblings = children.get(item.parentId) || [];
      siblings.push(item.id);
      children.set(item.parentId, siblings);
    }
    const scope: string[] = [];
    const pending = [user.districtNodeId];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop() as string;
      if (visited.has(id)) continue;
      visited.add(id);
      scope.push(id);
      pending.push(...(children.get(id) || []));
    }
    return scope;
  }

  static async listForResponders(userId: string, filters: {
    status?: string;
    page?: number;
    pageSize?: number;
  }) {
    const scope = await this.getAreaScope(userId);
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (scope.length) where.administrativeNodeId = { in: scope };

    const [items, total] = await Promise.all([
      prisma.disasterIncident.findMany({
        where,
        select: {
          id: true,
          referenceCode: true,
          title: true,
          description: true,
          hazardType: true,
          reportSource: true,
          severity: true,
          status: true,
          division: true,
          district: true,
          upazila: true,
          unionName: true,
          ward: true,
          village: true,
          latitude: true,
          longitude: true,
          peopleAffected: true,
          householdsDisplaced: true,
          peopleInjured: true,
          fatalities: true,
          createdAt: true,
          updatedAt: true
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.disasterIncident.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  static async listPublicVerified(filters: { district?: string; page?: number; pageSize?: number }) {
    const page = filters.page || 1;
    const pageSize = filters.pageSize || 20;
    const where: Record<string, unknown> = {
      status: { in: ['VERIFIED', 'ACTIVE', 'CONTAINED', 'RESOLVED'] }
    };
    if (filters.district) where.district = { equals: filters.district, mode: 'insensitive' };
    const [items, total] = await Promise.all([
      prisma.disasterIncident.findMany({
        where,
        select: {
          referenceCode: true,
          title: true,
          hazardType: true,
          severity: true,
          status: true,
          division: true,
          district: true,
          upazila: true,
          createdAt: true,
          updatedAt: true
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize
      }),
      prisma.disasterIncident.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  static async updateIncidentStatus(
    incidentId: string,
    actorId: string,
    status: IncidentStatus,
    content?: string
  ) {
    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { id: true, role: true }
    });
    if (!actor || !['WORKER', 'COORDINATOR', 'ADMIN'].includes(actor.role)) {
      throw new Error('Only field responders and coordinators can update incidents.');
    }
    const incident = await prisma.disasterIncident.findUnique({
      where: { id: incidentId },
      select: { id: true, status: true, administrativeNodeId: true, resolvedAt: true, reportedById: true, title: true }
    });
    if (!incident) throw new Error('Incident not found.');

    const scope = await this.getAreaScope(actorId);
    if (scope.length && (!incident.administrativeNodeId || !scope.includes(incident.administrativeNodeId))) {
      throw new Error('This incident is outside your authorized area.');
    }
    const transitions: Record<IncidentStatus, IncidentStatus[]> = {
      REPORTED: ['VERIFIED', 'REJECTED', 'DUPLICATE'],
      VERIFIED: ['ACTIVE', 'REJECTED', 'DUPLICATE'],
      ACTIVE: ['CONTAINED', 'RESOLVED'],
      CONTAINED: ['ACTIVE', 'RESOLVED'],
      RESOLVED: ['ACTIVE'],
      REJECTED: [],
      DUPLICATE: []
    };
    if (!transitions[incident.status as IncidentStatus]?.includes(status)) {
      throw new Error(`Cannot change an incident from ${incident.status} to ${status}.`);
    }
    const updateType: IncidentUpdateType = status === 'VERIFIED'
      ? 'VERIFICATION'
      : status === 'RESOLVED'
        ? 'RESOLUTION'
        : 'STATUS_CHANGE';
    const detail = content?.trim().slice(0, 2000);
    if ((status === 'REJECTED' || status === 'DUPLICATE') && !detail) {
      throw new Error('Provide a reason when rejecting or marking a duplicate report.');
    }

    return prisma.$transaction(async (tx: any) => {
      const updated = await tx.disasterIncident.update({
        where: { id: incident.id, status: incident.status },
        data: {
          status,
          resolvedAt: status === 'RESOLVED' ? new Date() : null
        },
        select: {
          id: true,
          referenceCode: true,
          status: true,
          updatedAt: true
        }
      });
      await tx.incidentUpdate.create({
        data: {
          incidentId: incident.id,
          authorId: actorId,
          type: updateType,
          content: detail || `Status changed from ${incident.status} to ${status}.`,
          fromStatus: incident.status,
          toStatus: status
        }
      });
      await tx.operationalAudit.create({
        data: {
          actorId,
          administrativeNodeId: incident.administrativeNodeId,
          action: 'INCIDENT_STATUS_UPDATED',
          entityType: 'INCIDENT',
          entityId: incident.id,
          details: { fromStatus: incident.status, toStatus: status }
        }
      });
      if (incident.reportedById && incident.reportedById !== actorId) {
        await tx.userNotification.create({
          data: {
            userId: incident.reportedById,
            type: 'INCIDENT_STATUS_UPDATED',
            title: 'Incident report updated',
            body: `${incident.title}: ${status.replace('_', ' ')}`,
            entityType: 'INCIDENT',
            entityId: incident.id
          }
        });
      }
      return updated;
    });
  }

  static async getIncidentDetail(incidentId: string, actorId: string) {
    const scope = await this.getAreaScope(actorId);
    const incident = await prisma.disasterIncident.findUnique({
      where: { id: incidentId },
      select: {
        id: true,
        referenceCode: true,
        title: true,
        description: true,
        hazardType: true,
        reportSource: true,
        severity: true,
        status: true,
        division: true,
        district: true,
        upazila: true,
        unionName: true,
        ward: true,
        village: true,
        latitude: true,
        longitude: true,
        peopleAffected: true,
        householdsDisplaced: true,
        peopleInjured: true,
        fatalities: true,
        createdAt: true,
        updatedAt: true,
        administrativeNodeId: true
      }
    });
    if (!incident) return null;
    if (scope.length && (!incident.administrativeNodeId || !scope.includes(incident.administrativeNodeId))) {
      throw new Error('This incident is outside your authorized area.');
    }
    const updates = await prisma.incidentUpdate.findMany({
      where: { incidentId },
      include: { author: { select: { fullName: true, role: true } } },
      orderBy: { createdAt: 'asc' }
    });
    const publicUpdates = updates.map((update: any) => ({
      type: update.type,
      content: update.content,
      fromStatus: update.fromStatus,
      toStatus: update.toStatus,
      createdAt: update.createdAt,
      author: update.author
    }));
    const { administrativeNodeId: _node, ...publicIncident } = incident;
    return { ...publicIncident, updates: publicUpdates };
  }
}
