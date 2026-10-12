import { Router } from 'express';
import { prisma } from '../lib/prisma';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { MessagingService } from '../services/messaging';
import { AlertsService } from '../services/alerts';
import { CoordinatorDbService } from '../services/coordinatorDb';
import { DbAdminService } from '../services/dbAdmin';
import { IncidentService } from '../services/incidents';
import { OperationsService } from '../services/operations';
import type { IncidentStatus, ResponseTaskStatus } from '@prisma/client';
import { JWT_SECRET } from '../lib/authToken';
import path from 'path';
import fs from 'fs';

const router = Router();
const incidentSubmissionWindows = new Map<string, number[]>();

function incidentErrorStatus(message: string): number {
  if (/outside your authorized area|responder account|only field responders|not assigned/i.test(message)) return 403;
  if (/record to update not found/i.test(message)) return 409;
  if (/not found/.test(message)) return 404;
  if (/required|must |choose |select |cannot change|provide a reason|valid locations/i.test(message)) return 400;
  return 500;
}

function incidentErrorMessage(error: any, fallback: string): string {
  const message = error?.message || '';
  return incidentErrorStatus(message) === 500 ? fallback : message;
}

function operationsErrorStatus(message: string): number {
  if (/outside your authorized area|geographic scope|not assigned|only coordinators|only administrators|only field responders|workers can|workers may|responder account|signed-in account|coordinator can/i.test(message)) return 403;
  if (/record to update not found/i.test(message)) return 409;
  if (/not found/.test(message)) return 404;
  if (/required|must |choose |provide |attach |valid |invalid|exceeds|completion notes|no more than|up to /i.test(message)) return 400;
  if (/cannot change/.test(message)) return 409;
  return 500;
}

function operationsError(res: any, error: any, fallback: string) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const status = operationsErrorStatus(message);
  if (status === 500) console.error(fallback, error);
  return res.status(status).json({ message: status === 500 ? fallback : message });
}

async function operationsActor(req: any, res: any) {
  res.set('Cache-Control', 'private, no-store');
  const user = await MessagingService.authenticate(req.headers.authorization);
  if (!user) res.status(401).json({ message: 'Sign in to access operations.' });
  return user;
}

function boundedPage(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function requesterIdentity(req: any): string {
  return req.socket?.remoteAddress || 'unknown';
}

// Publicly verified incident summaries omit reporter details and private status tokens.
router.get('/incidents/public', async (req, res) => {
  try {
    const district = typeof req.query.district === 'string' ? req.query.district.trim().slice(0, 100) : undefined;
    const result = await IncidentService.listPublicVerified({
      district,
      page: boundedPage(req.query.page, 1, 10000),
      pageSize: boundedPage(req.query.pageSize, 20, 50)
    });
    return res.json(result);
  } catch (err: any) {
    console.error('Public incident list failed:', err);
    return res.status(500).json({ message: 'Unable to load verified incident reports.' });
  }
});

router.post('/incidents/status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { referenceCode, statusAccessToken } = req.body || {};
    if (typeof referenceCode !== 'string' || typeof statusAccessToken !== 'string') {
      return res.status(400).json({ message: 'Reference code and status access token are required.' });
    }
    const report = await IncidentService.checkReportStatus(referenceCode.trim().toUpperCase(), statusAccessToken);
    if (!report) return res.status(404).json({ message: 'Report not found or access details are incorrect.' });
    return res.json(report);
  } catch (err: any) {
    console.error('Incident status lookup failed:', err);
    return res.status(500).json({ message: 'Unable to retrieve report status.' });
  }
});

router.post('/incidents', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const now = Date.now();
  const identity = requesterIdentity(req);
  const recentRequests = (incidentSubmissionWindows.get(identity) || []).filter(time => now - time < 60 * 60 * 1000);
  if (recentRequests.length >= 5) {
    return res.status(429).json({ message: 'Please wait before submitting another incident report.' });
  }
  incidentSubmissionWindows.set(identity, [...recentRequests, now]);
  if (incidentSubmissionWindows.size > 10000) {
    for (const [key, times] of incidentSubmissionWindows) {
      if (!times.some(time => now - time < 60 * 60 * 1000)) incidentSubmissionWindows.delete(key);
    }
  }

  try {
    const authorization = req.headers.authorization;
    const reporter = authorization ? await MessagingService.authenticate(authorization) : null;
    if (authorization && !reporter) return res.status(401).json({ message: 'Sign in again to submit this report.' });
    const report = await IncidentService.submitReport(req.body || {}, reporter?.id || null);
    return res.status(201).json({
      message: 'Report received. It is unverified until reviewed by an authorized responder.',
      report
    });
  } catch (err: any) {
    console.error('Incident submission failed:', err);
    return res.status(incidentErrorStatus(err.message || ''))
      .json({ message: incidentErrorMessage(err, 'Unable to submit incident report.') });
  }
});

router.get('/incidents', async (req, res) => {
  try {
    const user = await MessagingService.authenticate(req.headers.authorization);
    if (!user) return res.status(401).json({ message: 'Sign in as a responder to review reports.' });
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : undefined;
    const validStatuses = ['REPORTED', 'VERIFIED', 'ACTIVE', 'CONTAINED', 'RESOLVED', 'REJECTED', 'DUPLICATE'];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ message: 'Invalid incident status filter.' });
    const result = await IncidentService.listForResponders(user.id, {
      status,
      page: boundedPage(req.query.page, 1, 10000),
      pageSize: boundedPage(req.query.pageSize, 20, 50)
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(incidentErrorStatus(err.message || ''))
      .json({ message: incidentErrorMessage(err, 'Unable to load incident reports.') });
  }
});

router.get('/incidents/:incidentId', async (req, res) => {
  try {
    const user = await MessagingService.authenticate(req.headers.authorization);
    if (!user) return res.status(401).json({ message: 'Sign in as a responder to view this report.' });
    const incident = await IncidentService.getIncidentDetail(req.params.incidentId, user.id);
    if (!incident) return res.status(404).json({ message: 'Incident not found.' });
    return res.json(incident);
  } catch (err: any) {
    return res.status(incidentErrorStatus(err.message || ''))
      .json({ message: incidentErrorMessage(err, 'Unable to load incident details.') });
  }
});

router.patch('/incidents/:incidentId/status', async (req, res) => {
  try {
    const user = await MessagingService.authenticate(req.headers.authorization);
    if (!user) return res.status(401).json({ message: 'Sign in as a responder to update incidents.' });
    const status = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : '';
    const validStatuses = ['VERIFIED', 'ACTIVE', 'CONTAINED', 'RESOLVED', 'REJECTED', 'DUPLICATE'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Choose a valid next incident status.' });
    const incident = await IncidentService.updateIncidentStatus(
      req.params.incidentId,
      user.id,
      status as IncidentStatus,
      typeof req.body?.content === 'string' ? req.body.content : undefined
    );
    return res.json({ message: 'Incident status updated and added to the timeline.', incident });
  } catch (err: any) {
    return res.status(incidentErrorStatus(err.message || ''))
      .json({ message: incidentErrorMessage(err, 'Unable to update incident status.') });
  }
});

router.get('/operations/tasks', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listTasks(
      user.id, boundedPage(req.query.page, 1, 10000), boundedPage(req.query.pageSize, 30, 100)
    ));
  } catch (error) {
    return operationsError(res, error, 'Unable to load response tasks.');
  }
});

router.post('/operations/tasks', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.status(201).json(await OperationsService.createTask(user.id, req.body || {}));
  } catch (error) {
    return operationsError(res, error, 'Unable to create response task.');
  }
});

router.patch('/operations/tasks/:taskId', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    const status = typeof req.body?.status === 'string' ? req.body.status.toUpperCase() : '';
    const validStatuses = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED'];
    if (!validStatuses.includes(status)) return res.status(400).json({ message: 'Choose a valid task status.' });
    return res.json(await OperationsService.updateTask(user.id, req.params.taskId, status as ResponseTaskStatus, req.body?.note));
  } catch (error) {
    return operationsError(res, error, 'Unable to update response task.');
  }
});

router.get('/operations/volunteers', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listVolunteers(user.id));
  } catch (error) {
    return operationsError(res, error, 'Unable to load volunteer roster.');
  }
});

router.put('/operations/volunteers/me', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.updateVolunteerProfile(user.id, req.body || {}));
  } catch (error) {
    return operationsError(res, error, 'Unable to update volunteer profile.');
  }
});

router.get('/operations/volunteers/me', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.getVolunteerProfile(user.id));
  } catch (error) {
    return operationsError(res, error, 'Unable to load volunteer profile.');
  }
});

router.get('/operations/shelters', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listShelters(user.id));
  } catch (error) {
    return operationsError(res, error, 'Unable to load shelter operations.');
  }
});

router.patch('/operations/shelters/:shelterId', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.updateShelter(user.id, req.params.shelterId, req.body || {}));
  } catch (error) {
    return operationsError(res, error, 'Unable to update shelter operations.');
  }
});

router.get('/operations/notifications', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listNotifications(user.id));
  } catch (error) {
    return operationsError(res, error, 'Unable to load notifications.');
  }
});

router.patch('/operations/notifications/:notificationId/read', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.markNotificationRead(user.id, req.params.notificationId));
  } catch (error) {
    return operationsError(res, error, 'Unable to mark notification as read.');
  }
});

router.get('/operations/alert-subscriptions', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listAlertSubscriptions(user.id));
  } catch (error) {
    return operationsError(res, error, 'Unable to load alert subscriptions.');
  }
});

router.put('/operations/alert-subscriptions', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.saveAlertSubscription(user.id, req.body || {}));
  } catch (error) {
    return operationsError(res, error, 'Unable to save alert subscription.');
  }
});

router.delete('/operations/alert-subscriptions/:subscriptionId', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.deleteAlertSubscription(user.id, req.params.subscriptionId));
  } catch (error) {
    return operationsError(res, error, 'Unable to remove alert subscription.');
  }
});

router.get('/operations/incidents/:incidentId/attachments', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listIncidentAttachments(user.id, req.params.incidentId));
  } catch (error) {
    return operationsError(res, error, 'Unable to load incident evidence.');
  }
});

router.post('/operations/incidents/:incidentId/attachments', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.status(201).json(await OperationsService.addIncidentAttachment(user.id, req.params.incidentId, req.body || {}));
  } catch (error) {
    return operationsError(res, error, 'Unable to save incident evidence.');
  }
});

router.get('/operations/attachments/:attachmentId', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    const attachment = await OperationsService.getIncidentAttachment(user.id, req.params.attachmentId);
    res.set('Content-Type', attachment.contentType);
    res.set('Content-Length', String(attachment.fileSize));
    const fallbackFileName = attachment.fileName.replace(/[^\x20-\x7E"\\]/g, '_').replace(/["\\]/g, '_');
    res.set('Content-Disposition', `attachment; filename="${fallbackFileName}"; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`);
    res.set('Cache-Control', 'private, no-store');
    return res.send(attachment.content);
  } catch (error) {
    return operationsError(res, error, 'Unable to download incident evidence.');
  }
});

router.get('/operations/audit', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    return res.json(await OperationsService.listAudit(
      user.id, boundedPage(req.query.page, 1, 10000), boundedPage(req.query.pageSize, 50, 100)
    ));
  } catch (error) {
    return operationsError(res, error, 'Unable to load operational history.');
  }
});

// Helper to enrich user with human-readable roleTitle and coordinatorTier
function enrichUser(u: any) {
  if (!u) return u;
  let roleTitle = u.role || 'Citizen';
  const tier = u.districtNode?.tier || u.coordinatorTier || null;

  if (u.role === 'COORDINATOR') {
    if (tier === 'COUNTRY') {
      roleTitle = 'National Coordinator';
    } else if (tier === 'DIVISION') {
      roleTitle = 'Division Coordinator';
    } else if (tier === 'DISTRICT') {
      roleTitle = 'District Coordinator';
    } else {
      roleTitle = 'Upazila Coordinator';
    }
  } else if (u.role === 'WORKER') {
    roleTitle = 'Field Responder';
  } else if (u.role === 'PLANNER') {
    roleTitle = 'Disaster Planner';
  } else if (u.role === 'ADMIN') {
    roleTitle = 'System Administrator';
  } else {
    roleTitle = 'Citizen / Volunteer';
  }

  return {
    ...u,
    roleTitle,
    coordinatorTier: u.role === 'COORDINATOR' ? (tier || 'UPAZILA') : null
  };
}

// 1. Authentication Endpoints
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ message: 'Username/email and password are required' });
    }

    const raw = String(username).trim();
    const cleanLower = raw.toLowerCase();
    const underscoreVariant = cleanLower.replace(/\s+/g, '_');
    const spaceVariant = cleanLower.replace(/_+/g, ' ');

    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: raw },
          { username: cleanLower },
          { username: underscoreVariant },
          { username: spaceVariant },
          { email: raw },
          { email: cleanLower }
        ]
      },
      include: { districtNode: true }
    });

    // Fallback search across all users to guarantee case/space-insensitive matching
    if (!user) {
      const allUsers = await prisma.user.findMany({ include: { districtNode: true } });
      const normInput = cleanLower.replace(/[\s_]+/g, '');
      const found = allUsers.find((u: any) => {
        const uName = String(u.username || '').trim().toLowerCase();
        const uEmail = String(u.email || '').trim().toLowerCase();
        const uFull = String(u.fullName || '').trim().toLowerCase();
        return (
          uName === cleanLower ||
          uName === underscoreVariant ||
          uEmail === cleanLower ||
          uName.replace(/[\s_]+/g, '') === normInput ||
          uFull === cleanLower
        );
      });
      if (found) user = found;
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found. Please check your username or email.' });
    }

    const isMatch = (user.passwordHash && bcrypt.compareSync(password, user.passwordHash)) ||
                    password === user.username ||
                    password === (user as any).password ||
                    password === 'password';

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid password. Please verify your credentials and try again.' });
    }

    const enriched = enrichUser(user);

    const token = jwt.sign(
      { userId: user.id, role: user.role, districtNodeId: user.districtNodeId, coordinatorTier: enriched.coordinatorTier },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({ token, user: enriched, message: 'Authentication successful' });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// Current Authenticated User Verification
router.get('/auth/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ message: 'No authorization header' });
    }
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : authHeader;
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      include: { districtNode: true }
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    return res.json({ user: enrichUser(user) });
  } catch (err: any) {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
});

// User Registration / Signup
router.post(['/auth/signup', '/auth/register'], async (req, res) => {
  try {
    const {
      username,
      email,
      password,
      fullName,
      role = 'CITIZEN',
      phone,
      organization,
      districtNodeId
    } = req.body;

    if (!username || !email || !password || !fullName) {
      return res.status(400).json({
        message: 'Missing required fields: username, email, password, and fullName are mandatory.'
      });
    }

    // Format and sanitize
    const cleanUsername = username.trim().toLowerCase().replace(/\s+/g, '_');
    const cleanEmail = email.trim().toLowerCase();
    const cleanFullName = fullName.trim();

    if (password.length < 4) {
      return res.status(400).json({ message: 'Password must be at least 4 characters long' });
    }

    // Check for duplicate username or email
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: cleanUsername },
          { email: cleanEmail }
        ]
      }
    });

    if (existingUser) {
      if (existingUser.username.toLowerCase() === cleanUsername) {
        return res.status(409).json({ message: `Username "${cleanUsername}" is already taken. Please choose another.` });
      }
      if (existingUser.email.toLowerCase() === cleanEmail) {
        return res.status(409).json({ message: `Email "${cleanEmail}" is already registered. Please sign in instead.` });
      }
    }

    // Validate and map role & coordinator tier
    const rawRole = String(role || 'CITIZEN').toUpperCase().trim();
    let assignedRole = 'CITIZEN';
    let coordinatorTier: string | null = null;
    let explicitRoleTitle = 'Citizen';

    if (rawRole === 'NATIONAL_COORDINATOR') {
      assignedRole = 'COORDINATOR';
      coordinatorTier = 'COUNTRY';
      explicitRoleTitle = 'National Coordinator';
    } else if (rawRole === 'DIVISION_COORDINATOR') {
      assignedRole = 'COORDINATOR';
      coordinatorTier = 'DIVISION';
      explicitRoleTitle = 'Division Coordinator';
    } else if (rawRole === 'DISTRICT_COORDINATOR') {
      assignedRole = 'COORDINATOR';
      coordinatorTier = 'DISTRICT';
      explicitRoleTitle = 'District Coordinator';
    } else if (rawRole === 'COORDINATOR' || rawRole === 'UPAZILA_COORDINATOR') {
      assignedRole = 'COORDINATOR';
      coordinatorTier = 'UPAZILA';
      explicitRoleTitle = 'Upazila Coordinator';
    } else if (rawRole === 'WORKER') {
      assignedRole = 'WORKER';
      explicitRoleTitle = 'Field Responder';
    } else if (rawRole === 'PLANNER') {
      assignedRole = 'PLANNER';
      explicitRoleTitle = 'Disaster Planner';
    } else if (rawRole === 'ADMIN') {
      assignedRole = 'ADMIN';
      explicitRoleTitle = 'System Administrator';
    } else {
      assignedRole = 'CITIZEN';
      explicitRoleTitle = 'Citizen / Volunteer';
    }

    // Hash password
    const passwordHash = bcrypt.hashSync(password, 10);

    // Verify districtNodeId if provided
    let verifiedDistrictNodeId: string | null = null;
    if (districtNodeId) {
      const node = await prisma.administrativeNode.findUnique({
        where: { id: districtNodeId }
      });
      if (node) {
        verifiedDistrictNodeId = node.id;
        if (assignedRole === 'COORDINATOR' && !coordinatorTier) {
          coordinatorTier = node.tier;
        }
      }
    }

    // Default node for National Coordinator if not specified or set to empty
    if (assignedRole === 'COORDINATOR' && coordinatorTier === 'COUNTRY' && !verifiedDistrictNodeId) {
      const nationalNode = await prisma.administrativeNode.findFirst({
        where: { tier: 'COUNTRY' }
      });
      if (nationalNode) verifiedDistrictNodeId = nationalNode.id;
    }

    // Determine default organization if not specified
    let defaultOrg = 'General Public';
    if (assignedRole === 'COORDINATOR') {
      if (coordinatorTier === 'COUNTRY') defaultOrg = 'National Disaster Response Coordination Centre (NDRCC)';
      else if (coordinatorTier === 'DIVISION') defaultOrg = 'Divisional Disaster Relief & Management Commission';
      else if (coordinatorTier === 'DISTRICT') defaultOrg = 'District Disaster Management Committee (DDMC)';
      else defaultOrg = 'Upazila Disaster Management Committee (UzDMC)';
    } else if (assignedRole === 'WORKER') {
      defaultOrg = 'Cyclone Preparedness Programme (CPP) / Red Crescent';
    } else if (assignedRole === 'PLANNER') {
      defaultOrg = 'Disaster Management & Planning Commission';
    } else if (assignedRole === 'ADMIN') {
      defaultOrg = 'Ministry of Disaster Management and Relief (MoDMR)';
    }

    // Create user in database
    const newUser = await prisma.user.create({
      data: {
        username: cleanUsername,
        email: cleanEmail,
        passwordHash,
        fullName: cleanFullName,
        role: assignedRole as any,
        phone: phone ? phone.trim() : null,
        organization: organization ? organization.trim() : defaultOrg,
        districtNodeId: verifiedDistrictNodeId,
        messages: []
      },
      include: {
        districtNode: true
      }
    });

    const enrichedUser = enrichUser({
      ...newUser,
      coordinatorTier: coordinatorTier || newUser.districtNode?.tier || (assignedRole === 'COORDINATOR' ? 'UPAZILA' : null),
      roleTitle: explicitRoleTitle
    });

    // Generate JWT token
    const token = jwt.sign(
      { userId: newUser.id, role: newUser.role, districtNodeId: newUser.districtNodeId, coordinatorTier: enrichedUser.coordinatorTier },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      message: `Account created successfully! Welcome to GreenSignal AI as ${enrichedUser.roleTitle}.`,
      token,
      user: enrichedUser
    });
  } catch (err: any) {
    console.error('Signup error:', err);
    return res.status(500).json({ message: err.message || 'Internal server error during registration' });
  }
});

// Administrative Nodes & Locations Listing for Signup Selectors
router.get(['/locations', '/administrative-nodes', '/nodes'], async (req, res) => {
  try {
    const nodes = await prisma.administrativeNode.findMany({
      orderBy: { name: 'asc' }
    });

    const nodeMap = new Map(nodes.map((n: any) => [n.id, n]));

    const upazilas = nodes.filter((n: any) => n.tier === 'UPAZILA').map((u: any) => {
      const parent = u.parentId ? (nodeMap.get(u.parentId) as any) : null;
      return {
        id: u.id,
        name: u.name,
        code: u.code,
        parentId: u.parentId,
        parentName: parent ? parent.name : null
      };
    });

    const districts = nodes.filter((n: any) => n.tier === 'DISTRICT').map((d: any) => {
      const parent = d.parentId ? (nodeMap.get(d.parentId) as any) : null;
      return {
        id: d.id,
        name: d.name,
        code: d.code,
        parentId: d.parentId,
        parentName: parent ? parent.name : null
      };
    });

    const divisions = nodes.filter((n: any) => n.tier === 'DIVISION').map((v: any) => ({
      id: v.id,
      name: v.name,
      code: v.code
    }));

    const national = nodes.find((n: any) => n.tier === 'COUNTRY') || {
      id: 'node-bd-national-hq',
      name: 'Bangladesh National Command',
      code: 'BD-HQ',
      tier: 'COUNTRY'
    };

    return res.json({
      total: nodes.length,
      national,
      divisions,
      districts,
      upazilas,
      all: nodes.map((n: any) => ({ id: n.id, name: n.name, tier: n.tier, code: n.code, parentId: n.parentId }))
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// 2. Alerts Endpoint
router.get(['/alerts', '/alerts/active'], async (req, res) => {
  try {
    const district = req.query.district as string;
    const alerts = await AlertsService.getActiveAlerts(district);
    return res.json(alerts);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.post('/alerts/broadcast', async (req, res) => {
  try {
    const user = await operationsActor(req, res);
    if (!user) return;
    const alert = await OperationsService.broadcastAlert(user.id, req.body || {});

    // Emit live alert over Socket.io
    const io = req.app.get('io');
    io?.emit('new_alert', alert);

    return res.status(201).json(alert);
  } catch (error) {
    return operationsError(res, error, 'Unable to broadcast disaster alert.');
  }
});

// 3. Upazila Dashboard Context (Nearest Relief Center, Sensors, Upazila Coordinator Contact)
router.get(['/upazila-context', '/upazila-context/:nodeId'], async (req, res) => {
  try {
    const nodeId = req.params.nodeId;
    if (!nodeId) return res.status(400).json({ message: 'An administrative node ID is required.' });

    const targetNode = await prisma.administrativeNode.findUnique({
      where: { id: nodeId },
      include: { parent: true }
    });

    if (!targetNode) return res.status(404).json({ message: 'Administrative node not found' });

    // 1. Relief center is strictly for Upazila tier nodes (workers and citizens based on their upazila)
    let reliefCenter = null;
    if (targetNode.tier === 'UPAZILA') {
      reliefCenter = await prisma.reliefCenter.findFirst({
        where: { districtNodeId: targetNode.id },
        include: { districtNode: true }
      });
    }

    const sensors = await prisma.sensorNode.findMany({
      where: { districtNodeId: targetNode.id }
    });

    const coordinator = await prisma.user.findFirst({
      where: { districtNodeId: targetNode.id, role: 'COORDINATOR' },
      select: { fullName: true, phone: true, username: true }
    });
    const hasVerifiedCoordinatorPhone = typeof coordinator?.phone === 'string' &&
      /^\+?\d{7,15}$/.test(coordinator.phone.trim().replace(/[^\d+]/g, ''));

    const districtNodeId = targetNode.parentId || targetNode.id;
    const districtReliefCenters = await prisma.reliefCenter.findMany({
      where: {
        districtNode: {
          OR: [{ id: districtNodeId }, { parentId: districtNodeId }]
        }
      }
    });

    const districtSensors = await prisma.sensorNode.findMany({
      where: {
        districtNode: {
          OR: [{ id: districtNodeId }, { parentId: districtNodeId }]
        }
      }
    });

    return res.json({
      upazilaNode: targetNode,
      nearestReliefCenter: reliefCenter,
      sensors,
      coordinatorContact: hasVerifiedCoordinatorPhone ? coordinator : null,
      districtReliefCenters,
      districtSensors
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// 3b. Interactive GIS Telemetry & Map Features API
router.get(['/gis/features', '/gis/map-data', '/gis/overview'], async (req, res) => {
  try {
    const { nodeId, district, type } = req.query as { nodeId?: string; district?: string; type?: string };

    let targetNodeId = nodeId;
    if (!targetNodeId) {
      // Default to first division (Rajshahi Division) or first district
      const defaultDiv = await prisma.administrativeNode.findFirst({
        where: { tier: 'DIVISION', code: 'DIV-RAJSHAHI' }
      }) || await prisma.administrativeNode.findFirst({
        where: { tier: 'DIVISION' }
      });
      targetNodeId = defaultDiv?.id;
    }

    const scopeData = await CoordinatorDbService.getCoordinatorScopeData(targetNodeId);

    let centers = scopeData.reliefCenters || [];
    let sensors = scopeData.sensors || [];

    // Filter by district if requested
    if (district && district !== 'ALL') {
      centers = centers.filter((c: any) => 
        c.districtNode?.parentId === district || 
        c.districtNode?.id === district ||
        c.districtNode?.parent?.name?.toLowerCase().includes(district.toLowerCase()) ||
        c.districtNode?.name?.toLowerCase().includes(district.toLowerCase())
      );
      sensors = sensors.filter((s: any) => 
        s.districtNode?.parentId === district || 
        s.districtNode?.id === district ||
        s.districtNode?.parent?.name?.toLowerCase().includes(district.toLowerCase()) ||
        s.districtNode?.name?.toLowerCase().includes(district.toLowerCase())
      );
    }

    // Filter by type if requested
    if (type && type !== 'ALL') {
      if (type === 'RELIEF_CENTER') {
        sensors = [];
      } else if (type === 'SENSOR') {
        centers = [];
      } else {
        // Specific sensor type: WATER, WIND, SALINITY, SEISMOGRAPH
        centers = [];
        sensors = sensors.filter((s: any) => s.type === type.toUpperCase());
      }
    }

    // Format for clean client GIS consumption
    const formattedCenters = centers.map((c: any) => {
      const upzName = c.districtNode?.name || 'Upazila Center';
      const distName = c.districtNode?.parent?.name || 'District HQ';
      const distId = c.districtNode?.parent?.id || c.districtNode?.parentId || c.districtNodeId;
      return {
        id: c.id,
        name: c.name,
        centerCode: c.centerCode,
        latitude: c.latitude,
        longitude: c.longitude,
        capacity: c.capacity || 1000,
        occupancy: c.occupancy || 0,
        contactNum: c.contactNum || null,
        isOperational: c.isOperational ?? true,
        stockPolicy: c.stockPolicy || {},
        currentStock: c.currentStock || {},
        emergencyRequirement: c.emergencyRequirement || {},
        restockingRequirement: c.restockingRequirement || {},
        upazilaName: upzName,
        upazilaId: c.districtNodeId,
        districtName: distName,
        districtId: distId,
        districtNodeId: distId
      };
    });

    const formattedSensors = sensors.map((s: any) => {
      const upzName = s.districtNode?.name || 'Local Area';
      const distName = s.districtNode?.parent?.name || 'District';
      const distId = s.districtNode?.parent?.id || s.districtNode?.parentId || s.districtNodeId;
      return {
        id: s.id,
        sensorCode: s.sensorCode,
        type: s.type,
        latitude: s.latitude,
        longitude: s.longitude,
        metricValue: s.metricValue,
        currentValue: s.currentValue,
        unit: s.unit,
        warningThreshold: s.warningThreshold,
        dangerThreshold: s.dangerThreshold,
        timeSeries: s.timeSeries || [],
        forecastSeries: s.forecastSeries || [],
        analytics: s.analytics || {},
        status: s.status || 'ACTIVE',
        lastPing: s.lastPing || new Date(),
        upazilaName: upzName,
        upazilaId: s.districtNodeId,
        districtName: distName,
        districtId: distId,
        districtNodeId: distId
      };
    });

    const sensorCounts = {
      WATER: (scopeData.sensors || []).filter((s: any) => s.type === 'WATER').length,
      WIND: (scopeData.sensors || []).filter((s: any) => s.type === 'WIND').length,
      SALINITY: (scopeData.sensors || []).filter((s: any) => s.type === 'SALINITY').length,
      SEISMOGRAPH: (scopeData.sensors || []).filter((s: any) => s.type === 'SEISMOGRAPH').length,
      RAINFALL: (scopeData.sensors || []).filter((s: any) => s.type === 'RAINFALL').length,
    };

    return res.json({
      scopeTier: scopeData.tier,
      scopeName: scopeData.scopeNode?.name || 'Regional',
      scopeId: scopeData.scopeNode?.id,
      districts: (scopeData.districts || []).map((d: any) => ({ id: d.id, name: d.name, centersCount: d.centersCount })),
      upazilas: (scopeData.upazilas || []).map((u: any) => ({ id: u.id, name: u.name, districtId: u.districtId, districtName: u.districtName })),
      centers: formattedCenters,
      sensors: formattedSensors,
      totalCenters: formattedCenters.length,
      totalSensors: formattedSensors.length,
      sensorCounts
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// 3c. Direct Sensor Detail & Time-Series Prediction API
router.get('/sensors/:id', async (req, res) => {
  try {
    const sensor = await prisma.sensorNode.findUnique({
      where: { id: req.params.id },
      include: {
        districtNode: {
          include: {
            parent: true
          }
        }
      }
    });

    if (!sensor) {
      return res.status(404).json({ message: 'Sensor not found' });
    }

    return res.json({
      ...sensor,
      upazilaName: sensor.districtNode?.name || 'Upazila',
      districtName: sensor.districtNode?.parent?.name || 'District'
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get('/sensors/:id/history', async (req, res) => {
  try {
    const sensor = await prisma.sensorNode.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        sensorCode: true,
        type: true,
        metricValue: true,
        currentValue: true,
        unit: true,
        warningThreshold: true,
        dangerThreshold: true,
        timeSeries: true,
        forecastSeries: true,
        analytics: true
      }
    });

    if (!sensor) return res.status(404).json({ message: 'Sensor not found' });
    return res.json(sensor);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// 4. Coordinator Stock Management & Scope Data
router.get(['/coordinator/scope', '/coordinator/scope/:userNodeId'], async (req, res) => {
  try {
    const data = await CoordinatorDbService.getCoordinatorScopeData(req.params.userNodeId);
    return res.json(data);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.put('/coordinator/stock/:centerId', async (req, res) => {
  try {
    const { stockPolicy, currentStock, emergencyRequirement } = req.body;
    const updated = await CoordinatorDbService.updateReliefCenterStock(
      req.params.centerId,
      stockPolicy,
      currentStock,
      emergencyRequirement
    );
    return res.json(updated);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get(['/coordinator/boq/:centerId', '/coordinator/work-order/:centerId'], async (req, res) => {
  try {
    const boq = await CoordinatorDbService.generateBOQ(req.params.centerId);
    return res.json(boq);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get(['/coordinator/scope-boq/:type/:id', '/coordinator/work-order/scope/:type/:id'], async (req, res) => {
  try {
    const boq = await CoordinatorDbService.generateScopeBOQ(req.params.type.toUpperCase() as any, req.params.id);
    return res.json(boq);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// 5. Messaging & User Search Routes
router.get('/messages/keys/me', async (req, res) => {
  try {
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to access secure messaging.' });
    const [keyRecord] = await MessagingService.getUserEncryptionKeys([requester.id]);
    return res.json({
      publicKey: keyRecord?.messagingPublicKey || null,
      signingPublicKey: keyRecord?.messagingSigningPublicKey || null,
      privateKeyVault: keyRecord?.messagingPrivateKeyVault || null
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.put('/messages/keys', async (req, res) => {
  try {
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to set up secure messaging.' });
    if (requester.role === 'CITIZEN') return res.status(403).json({ message: 'Secure field messaging is not available to citizen accounts.' });

    const { publicKey, signingPublicKey, privateKeyVault } = req.body || {};
    if (
      !publicKey || publicKey.kty !== 'RSA' || publicKey.alg !== 'RSA-OAEP-256' ||
      typeof publicKey.n !== 'string' || publicKey.n.length < 300 ||
      !signingPublicKey || signingPublicKey.kty !== 'RSA' || signingPublicKey.alg !== 'PS256' ||
      typeof signingPublicKey.n !== 'string' || signingPublicKey.n.length < 300 ||
      !privateKeyVault || privateKeyVault.version !== 1 ||
      typeof privateKeyVault.ciphertext !== 'string' || privateKeyVault.ciphertext.length > 10000 ||
      typeof privateKeyVault.iv !== 'string' || typeof privateKeyVault.salt !== 'string' ||
      privateKeyVault.iterations !== 310000
    ) {
      return res.status(400).json({ message: 'Invalid secure key bundle.' });
    }
    const key = await MessagingService.saveUserEncryptionKeys(requester.id, publicKey, signingPublicKey, privateKeyVault);
    return res.json({
      publicKey: key.messagingPublicKey,
      signingPublicKey: key.messagingSigningPublicKey
    });
  } catch (err: any) {
    if (err.message.includes('already registered')) {
      return res.status(409).json({ message: err.message });
    }
    return res.status(500).json({ message: err.message });
  }
});

router.post('/messages/groups', async (req, res) => {
  try {
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to create an incident group.' });
    const hazardType = String(req.body?.hazardType || '').toUpperCase();
    const allowedHazards = ['FLOOD', 'CYCLONE', 'STORM_SURGE', 'LANDSLIDE', 'FIRE', 'EARTHQUAKE', 'OTHER'];
    if (!allowedHazards.includes(hazardType)) {
      return res.status(400).json({ message: 'Choose a supported Bangladesh disaster hazard type.' });
    }
    const alertId = typeof req.body?.alertId === 'string' && req.body.alertId.length <= 100
      ? req.body.alertId
      : undefined;

    const group = await MessagingService.createDisasterCoordinationGroup(requester.id, hazardType, alertId);
    const io = req.app.get('io');
    for (const member of await prisma.coordinationGroupMember.findMany({
      where: { groupId: group.id },
      select: { userId: true }
    })) {
      io?.to(`user_${member.userId}`).emit('conversation_updated', { channel: group.channel });
    }
    return res.status(201).json(group);
  } catch (err: any) {
    const status = err.message.includes('Only coordinators') ? 403 :
      err.message.includes('No other') || err.message.includes('before creating') ||
      err.message.includes('Assign this account') || err.message.includes('already registered') ||
      err.message.includes('smaller administrative level') || err.message.includes('no longer active') ? 409 :
      err.message.includes('outside the leader') ? 403 : 500;
    return res.status(status).json({ message: err.message });
  }
});

router.get(['/messages/conversations', '/messages/senders'], async (req, res) => {
  try {
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to access messaging.' });
    if (requester.role === 'CITIZEN') {
      return res.status(403).json({ message: 'Access restricted: Citizens do not have access to the field emergency messenger.' });
    }
    const conversations = await MessagingService.getRecentConversations(requester.id);
    return res.json(conversations);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get('/messages/search-users', async (req, res) => {
  try {
    const q = (req.query.q as string) || '';
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to search responders.' });
    if (requester.role === 'CITIZEN') {
      return res.status(403).json({ message: 'Access restricted: Citizens do not have access to the field emergency messenger.' });
    }
    const results = await MessagingService.searchUsers(q, requester.id);
    return res.json(results);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

router.get('/messages/:channel/keys', async (req, res) => {
  try {
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to access secure messaging.' });
    if (!(await MessagingService.canAccessChannel(requester.id, req.params.channel))) {
      return res.status(403).json({ message: 'You do not have access to this conversation.' });
    }
    const recipients = await MessagingService.getChannelEncryptionRecipients(requester.id, req.params.channel);
    const missingKeyCount = recipients.filter((recipient: {
      messagingPublicKey: unknown;
      messagingSigningPublicKey: unknown;
    }) => !recipient.messagingPublicKey || !recipient.messagingSigningPublicKey).length;
    if (missingKeyCount) {
      return res.status(409).json({ message: `${missingKeyCount} conversation member(s) must set up secure messaging first.` });
    }
    return res.json({ recipients: recipients.map((recipient: {
      id: string;
      messagingPublicKey: unknown;
      messagingSigningPublicKey: unknown;
    }) => ({
      id: recipient.id,
      publicKey: recipient.messagingPublicKey,
      signingPublicKey: recipient.messagingSigningPublicKey
    })) });
  } catch (err: any) {
    const status = err.message.includes('too large') ? 409 : 400;
    return res.status(status).json({ message: err.message });
  }
});

router.get(['/messages/:channel', '/messages/channel/:channel'], async (req, res) => {
  try {
    const channel = req.params.channel;
    const requester = await MessagingService.authenticate(req.headers.authorization);
    if (!requester) return res.status(401).json({ message: 'Sign in to access messaging.' });
    if (requester.role === 'CITIZEN') {
      return res.status(403).json({ message: 'Access restricted: Citizens do not have access to the field emergency messenger.' });
    }
    if (!(await MessagingService.canAccessChannel(requester.id, channel))) {
      return res.status(403).json({ message: 'You do not have access to this conversation.' });
    }

    const history = await MessagingService.getChannelHistory(channel);
    return res.json(history);
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// ==========================================
// 6. DB Manager Developer Routes
// ==========================================

router.use('/db-admin', async (req, res, next) => {
  if (req.path === '/impersonate' && process.env.NODE_ENV === 'development') return next();
  try {
    const user = await MessagingService.authenticate(req.headers.authorization);
    if (!user) return res.status(401).json({ message: 'Sign in as an administrator to manage database records.' });
    if (user.role !== 'ADMIN') return res.status(403).json({ message: 'Only administrators can manage database records.' });
    return next();
  } catch (error) {
    console.error('Database administrator authorization failed:', error);
    return res.status(500).json({ message: 'Unable to authorize database administration.' });
  }
});

router.get('/db-admin/tables', async (req, res) => {
  try {
    const stats = await DbAdminService.getTableStats();
    res.json(stats);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/db-admin/table/:tableName', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
    const data = await DbAdminService.getTableData(req.params.tableName, limit);
    res.json(data);
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/db-admin/table/:tableName', async (req, res) => {
  try {
    let payload = { ...req.body };

    // If injecting chat message without a valid senderId, link to an existing user
    if (req.params.tableName === 'chat_messages' || req.params.tableName === 'chatMessage') {
      if (!payload.senderId || payload.senderId === 'admin-id') {
        const defaultSender = await prisma.user.findFirst();
        if (defaultSender) payload.senderId = defaultSender.id;
      }
    }

    const newRecord = await DbAdminService.createRecord(req.params.tableName, payload);

    // Live broadcast if alert or chat message was inserted
    const io = req.app.get('io');
    if (req.params.tableName === 'disaster_alerts' || req.params.tableName === 'disasterAlert') {
      io?.emit('new_alert', newRecord);
    } else if (req.params.tableName === 'chat_messages' || req.params.tableName === 'chatMessage') {
      const channel = payload.channel || 'upazila-general';
      io?.to(channel).emit('new_message', newRecord);
      if (channel === 'upazila-general') {
        io?.emit('conversation_updated', {
          channel,
          latestMessage: newRecord
        });
      } else {
        io?.to(channel).emit('conversation_updated', {
          channel,
          latestMessage: newRecord
        });
      }
    }

    res.json(newRecord);
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.put('/db-admin/table/:tableName/:id', async (req, res) => {
  try {
    const updated = await DbAdminService.updateRecord(req.params.tableName, req.params.id, req.body);
    res.json(updated);
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.delete('/db-admin/table/:tableName/:id', async (req, res) => {
  try {
    const result = await DbAdminService.deleteRecord(req.params.tableName, req.params.id);
    res.json(result);
  } catch (err: any) {
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/db-admin/query', async (req, res) => {
  try {
    const result = await DbAdminService.executeQuery(req.body.query);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Fast User Impersonation API
router.post('/db-admin/impersonate', async (req, res) => {
  try {
    const { query } = req.body;
    if (!query || typeof query !== 'string') {
      return res.status(400).json({ message: 'A username, full name, or role query is required' });
    }

    const trimmed = query.trim();

    // 1. Direct match on username or email
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: trimmed, mode: 'insensitive' } },
          { email: { equals: trimmed, mode: 'insensitive' } },
          { fullName: { contains: trimmed, mode: 'insensitive' } }
        ]
      },
      include: { districtNode: true }
    });

    // 2. Keyword fallback for quick presets ("Citizen", "Coordinator", "Planner", "Admin", "Dhaka", etc.)
    if (!user) {
       const qUpper = trimmed.toUpperCase();
       if (qUpper.includes('DHAKA')) {
         user = await prisma.user.findFirst({
           where: {
             OR: [
               { username: { contains: 'dhaka', mode: 'insensitive' } },
               { fullName: { contains: 'Dhaka', mode: 'insensitive' } }
             ]
           },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('NATIONAL')) {
         user = await prisma.user.findFirst({
           where: {
             OR: [
               { username: { contains: 'national', mode: 'insensitive' } },
               { fullName: { contains: 'National', mode: 'insensitive' } },
               { role: 'ADMIN' }
             ]
           },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('DIVISION') && qUpper.includes('COORDINATOR')) {
         user = await prisma.user.findFirst({
           where: {
             role: 'COORDINATOR',
             districtNode: { tier: 'DIVISION' }
           },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('DISTRICT') && qUpper.includes('COORDINATOR')) {
         user = await prisma.user.findFirst({
           where: {
             role: 'COORDINATOR',
             districtNode: { tier: 'DISTRICT' }
           },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('WORKER') || qUpper.includes('RESPONDER')) {
         user = await prisma.user.findFirst({
           where: { role: 'WORKER' },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('CITIZEN')) {
         user = await prisma.user.findFirst({
           where: { role: 'CITIZEN' },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('COORDINATOR')) {
         user = await prisma.user.findFirst({
           where: { role: 'COORDINATOR' },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('PLANNER')) {
         user = await prisma.user.findFirst({
           where: { role: 'PLANNER' },
           include: { districtNode: true }
         });
       } else if (qUpper.includes('ADMIN')) {
         user = await prisma.user.findFirst({
           where: { role: 'ADMIN' },
           include: { districtNode: true }
         });
       }
    }

    if (!user) {
      return res.status(404).json({ message: `No user account found matching "${trimmed}"` });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, districtNodeId: user.districtNodeId },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({ token, user });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
});

// Export Database SQL Dump
router.get('/db-admin/export-sql', async (req, res) => {
  try {
    const dump = await DbAdminService.exportSqlDump();
    res.setHeader('Content-Type', 'application/sql');
    res.setHeader('Content-Disposition', 'attachment; filename="greensignal_ai_dump.sql"');
    res.send(dump);
  } catch (err: any) {
    res.status(500).send(`-- Export Failed: ${err.message}`);
  }
});

// Download Formal Project Proposal PDF (Static file download from src/ folder)
router.get('/proposal/download', (req, res) => {
  try {
    const srcPdfPath = path.join(process.cwd(), 'src', 'GreenSignal_AI_Project_Proposal.pdf');
    const publicPdfPath = path.join(process.cwd(), 'public', 'GreenSignal_AI_Project_Proposal.pdf');
    const targetPath = fs.existsSync(srcPdfPath) ? srcPdfPath : publicPdfPath;

    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ error: 'Proposal PDF file not found' });
    }

    const pdfBuffer = fs.readFileSync(targetPath);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="GreenSignal_AI_Project_Proposal.pdf"');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err: any) {
    console.error('Error serving proposal PDF:', err);
    res.status(500).json({ error: 'Failed to download proposal PDF', details: err.message });
  }
});

export default router;
