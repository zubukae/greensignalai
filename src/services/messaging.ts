import { prisma } from '../lib/prisma';
import { verifyAuthToken } from '../lib/authToken';
import { Server, Socket } from 'socket.io';
import { constants, createPublicKey, verify as verifySignature } from 'crypto';

export interface UserSearchResult {
  id: string;
  username: string;
  fullName: string;
  role: string;
  organization: string | null;
}

export interface ConversationSenderItem {
  id: string;
  userId?: string;
  channel: string;
  name: string;
  username?: string;
  role?: string;
  organization?: string | null;
  phone?: string | null;
  isGroup?: boolean;
  avatarIcon: string;
  avatarColor: string;
  lastMessage?: {
    id: string;
    text: string;
    senderId: string;
    senderName: string;
    createdAt: string | Date;
  } | null;
  unreadCount: number;
}

export interface EncryptedChatPayload {
  channel: string;
  text: string;
  encryptionIv: string;
  encryptedKeys: Record<string, string>;
  encryptionSignature: string;
  encryptionVersion: number;
}

function getDirectParticipantIds(channel: string): [string, string] | null {
  const match = channel.match(
    /^direct-((?:user-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-((?:user-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
  );
  return match ? [match[1], match[2]] : null;
}

function getSignedMessagePayload(senderId: string, data: EncryptedChatPayload): string {
  const encryptedKeys: Record<string, string> = {};
  for (const userId of Object.keys(data.encryptedKeys).sort()) {
    encryptedKeys[userId] = data.encryptedKeys[userId];
  }
  return JSON.stringify({
    senderId,
    channel: data.channel,
    text: data.text,
    encryptionIv: data.encryptionIv,
    encryptedKeys,
    encryptionVersion: data.encryptionVersion
  });
}

function normalizeAdministrativeLocation(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/\b(district|zilla|zila|upazila|upazilla|union|union parishad)\b/g, '')
    .replace(/[^a-z0-9\u0980-\u09ff]+/g, ' ')
    .trim();
}

export class MessagingService {
  static async authenticate(authorization?: string) {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;

    const payload = verifyAuthToken(match[1]);
    if (!payload) return null;

    return prisma.user.findUnique({
      where: { id: payload.userId },
      select: { id: true, role: true }
    });
  }

  static async canAccessChannel(userId: string, channel: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, messagingPublicKey: true, messagingSigningPublicKey: true }
    });
    if (!user || user.role === 'CITIZEN') return false;
    if (channel === 'upazila-general') return Boolean(user.messagingPublicKey && user.messagingSigningPublicKey);

    if (channel.startsWith('group-')) {
      const group = await prisma.coordinationGroup.findUnique({
        where: { channel },
        select: { id: true, status: true }
      });
      if (!group || group.status !== 'ACTIVE') return false;
      const membership = await prisma.coordinationGroupMember.findUnique({
        where: { groupId_userId: { groupId: group.id, userId } }
      });
      return Boolean(membership && user.messagingPublicKey && user.messagingSigningPublicKey);
    }

    const participantIds = getDirectParticipantIds(channel);
    if (!participantIds) return false;

    const userIds = participantIds;
    if (userIds[0] === userIds[1] || !userIds.includes(userId)) return false;
    if (`direct-${userIds.slice().sort().join('-')}` !== channel) return false;

    const participants = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, role: true }
    });
    return participants.length === 2 && participants.every(participant => participant.role !== 'CITIZEN');
  }

  static async getChannelEncryptionRecipients(userId: string, channel: string) {
    if (channel === 'upazila-general') {
      const users = await prisma.user.findMany({
        where: { role: { not: 'CITIZEN' } },
        select: { id: true, messagingPublicKey: true, messagingSigningPublicKey: true }
      });
      const configuredUsers = users.filter((candidate: { messagingPublicKey: unknown; messagingSigningPublicKey: unknown }) =>
        Boolean(candidate.messagingPublicKey && candidate.messagingSigningPublicKey)
      );
      if (configuredUsers.length > 100) {
        throw new Error('The shared responder channel is too large for reliable encryption. Create a disaster coordination group instead.');
      }
      return configuredUsers;
    }

    const directIds = getDirectParticipantIds(channel);
    if (directIds) {
      if (!directIds.includes(userId)) throw new Error('You are not a member of this conversation.');
      return prisma.user.findMany({
        where: { id: { in: directIds } },
        select: { id: true, messagingPublicKey: true, messagingSigningPublicKey: true }
      });
    }

    const group = await prisma.coordinationGroup.findUnique({
      where: { channel },
      select: { id: true, status: true }
    });
    if (!group || group.status !== 'ACTIVE') throw new Error('This coordination group is no longer active.');
    const members = await prisma.coordinationGroupMember.findMany({
      where: { groupId: group.id },
      select: { userId: true }
    });
    if (!members.some((member: { userId: string }) => member.userId === userId)) {
      throw new Error('You are not a member of this coordination group.');
    }
    if (members.length > 100) {
      throw new Error('This group is too large for reliable encrypted messaging. Split it into smaller response teams.');
    }
    return prisma.user.findMany({
      where: {
        id: { in: members.map((member: { userId: string }) => member.userId) },
        role: { not: 'CITIZEN' }
      },
      select: { id: true, messagingPublicKey: true, messagingSigningPublicKey: true }
    });
  }

  static async createDisasterCoordinationGroup(userId: string, hazardType: string, alertId?: string) {
    const leader = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        fullName: true,
        districtNodeId: true,
        messagingPublicKey: true,
        messagingSigningPublicKey: true
      }
    });
    if (!leader || !['COORDINATOR', 'ADMIN'].includes(leader.role)) {
      throw new Error('Only coordinators and administrators can start an incident coordination group.');
    }
    if (!leader.districtNodeId) throw new Error('Assign this account to an administrative area before creating a response group.');
    if (!leader.messagingPublicKey || !leader.messagingSigningPublicKey) {
      throw new Error('Set up secure messaging before creating a group.');
    }

    const scope = await prisma.administrativeNode.findUnique({
      where: { id: leader.districtNodeId },
      select: { id: true, name: true, tier: true, parentId: true }
    });
    if (!scope) throw new Error('The leader’s assigned administrative area could not be found.');

    const allNodes = await prisma.administrativeNode.findMany({
      select: { id: true, name: true, tier: true, parentId: true }
    });
    const nodesById = new Map(allNodes.map((node: any) => [node.id, node]));
    const descendants = new Map<string, string[]>();
    for (const node of allNodes) {
      if (!node.parentId) continue;
      const children = descendants.get(node.parentId) || [];
      children.push(node.id);
      descendants.set(node.parentId, children);
    }
    const scopeNodeIds: string[] = [];
    const pendingNodeIds = [scope.id];
    const visitedNodeIds = new Set<string>();
    while (pendingNodeIds.length > 0) {
      const nodeId = pendingNodeIds.pop() as string;
      if (visitedNodeIds.has(nodeId)) continue;
      visitedNodeIds.add(nodeId);
      scopeNodeIds.push(nodeId);
      pendingNodeIds.push(...(descendants.get(nodeId) || []));
    }

    const candidates = await prisma.user.findMany({
      where: {
        districtNodeId: { in: scopeNodeIds },
        role: { not: 'CITIZEN' }
      },
      select: { id: true, messagingPublicKey: true, messagingSigningPublicKey: true }
    });
    const eligibleMembers = candidates
      .filter((candidate: { messagingPublicKey: unknown; messagingSigningPublicKey: unknown }) =>
        Boolean(candidate.messagingPublicKey && candidate.messagingSigningPublicKey)
      )
      .map((candidate: { id: string }) => candidate.id);
    if (!eligibleMembers.includes(userId)) eligibleMembers.push(userId);
    if (eligibleMembers.length < 2) {
      throw new Error('No other secure-messaging responders are assigned to this area yet.');
    }
    if (eligibleMembers.length > 100) {
      throw new Error('This area has more than 100 configured responders. Create a group at a smaller administrative level.');
    }

    const ancestors = [scope];
    let ancestor = scope.parentId ? nodesById.get(scope.parentId) : null;
    while (ancestor) {
      ancestors.push(ancestor);
      ancestor = ancestor.parentId ? nodesById.get(ancestor.parentId) : null;
    }
    const division = ancestors.find((node: any) => node.tier === 'DIVISION')?.name || null;
    const district = ancestors.find((node: any) => node.tier === 'DISTRICT')?.name || scope.name;
    const upazila = ancestors.find((node: any) => node.tier === 'UPAZILA')?.name || null;
    const alert = alertId ? await prisma.disasterAlert.findUnique({
      where: { id: alertId },
      select: { id: true, title: true, district: true, severity: true, isActive: true }
    }) : null;
    if (alertId && (!alert || !alert.isActive)) {
      throw new Error('The selected disaster alert is no longer active.');
    }
    if (alert && alert.district.toUpperCase() !== 'NATIONWIDE') {
      const scopeNames = ancestors.map((node: any) => normalizeAdministrativeLocation(node.name));
      if (!scopeNames.includes(normalizeAdministrativeLocation(alert.district))) {
        throw new Error('This alert is outside the leader’s assigned area.');
      }
    }
    const incidentTitle = alert
      ? `${alert.title} — ${scope.name}`
      : `${hazardType.replace(/_/g, ' ')} response — ${scope.name}`;
    const existingIncident = await prisma.disasterIncident.findFirst({
      where: {
        alertId: alert?.id || null,
        administrativeNodeId: scope.id,
        hazardType,
        status: 'ACTIVE'
      }
    });
    if (existingIncident) {
      const existingGroup = await prisma.coordinationGroup.findFirst({
        where: { incidentId: existingIncident.id, status: 'ACTIVE' }
      });
      if (existingGroup) {
        const currentMembers = await prisma.coordinationGroupMember.findMany({
          where: { groupId: existingGroup.id },
          select: { userId: true }
        });
        const currentMemberIds = new Set(currentMembers.map((member: { userId: string }) => member.userId));
        const additionalMembers = eligibleMembers.filter(memberId => !currentMemberIds.has(memberId));
        if (additionalMembers.length > 0) {
          await prisma.coordinationGroupMember.createMany({
            data: additionalMembers.map(memberId => ({
              groupId: existingGroup.id,
              userId: memberId,
              role: memberId === userId && currentMembers.length === 0 ? 'LEADER' : 'MEMBER'
            }))
          });
        }
        return {
          ...existingGroup,
          memberCount: currentMembers.length + additionalMembers.length,
          excludedUnconfiguredCount: candidates.length - eligibleMembers.length
        };
      }
    }

    const incident = await prisma.disasterIncident.create({
      data: {
        title: incidentTitle,
        hazardType,
        severity: alert?.severity || 'WARNING',
        status: 'ACTIVE',
        division,
        district,
        upazila,
        alertId: alert?.id || null,
        administrativeNodeId: scope.id,
        reportedById: userId
      }
    });
    const group = await prisma.coordinationGroup.create({
      data: {
        name: incidentTitle,
        channel: `group-${incident.id}`,
        incidentId: incident.id,
        scopeNodeId: scope.id,
        leaderId: userId
      }
    });

    try {
      await prisma.coordinationGroupMember.createMany({
        data: eligibleMembers.map(memberId => ({
          groupId: group.id,
          userId: memberId,
          role: memberId === userId ? 'LEADER' : 'MEMBER'
        }))
      });
    } catch (error) {
      await prisma.coordinationGroup.delete({ where: { id: group.id } });
      await prisma.disasterIncident.delete({ where: { id: incident.id } });
      throw error;
    }
    return { ...group, memberCount: eligibleMembers.length, excludedUnconfiguredCount: candidates.length - eligibleMembers.length };
  }

  static async getUserEncryptionKeys(userIds: string[]) {
    return prisma.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        messagingPublicKey: true,
        messagingSigningPublicKey: true,
        messagingPrivateKeyVault: true
      }
    });
  }

  static async saveUserEncryptionKeys(
    userId: string,
    publicKey: unknown,
    signingPublicKey: unknown,
    privateKeyVault: unknown
  ) {
    const currentKeys = await prisma.user.findUnique({
      where: { id: userId },
      select: { messagingPublicKey: true, messagingSigningPublicKey: true }
    });
    if (!currentKeys || currentKeys.messagingPublicKey || currentKeys.messagingSigningPublicKey) {
      throw new Error('Secure messaging keys are already registered or the account no longer exists.');
    }
    return prisma.user.update({
      where: { id: userId },
      data: {
        messagingPublicKey: publicKey,
        messagingSigningPublicKey: signingPublicKey,
        messagingPrivateKeyVault: privateKeyVault
      },
      select: { id: true, messagingPublicKey: true, messagingSigningPublicKey: true }
    });
  }

  /**
   * Search users across system by username, full name, role, phone, or organization for messaging
   */
  static async searchUsers(query: string, currentUserId?: string): Promise<UserSearchResult[]> {
    if (!query || query.trim().length === 0) return [];

    const q = query.trim();
    const validRoles = ['CITIZEN', 'WORKER', 'COORDINATOR', 'PLANNER', 'ADMIN'];
    const matchingRoles = validRoles.filter(r => r.toLowerCase().includes(q.toLowerCase()));

    const orConditions: any[] = [
      { username: { contains: q, mode: 'insensitive' } },
      { fullName: { contains: q, mode: 'insensitive' } },
      { organization: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q } }
    ];
    if (matchingRoles.length > 0) {
      orConditions.push({ role: { in: matchingRoles } });
    }

    const whereClause: any = {
      AND: [
        { OR: orConditions },
        { role: { not: 'CITIZEN' } }
      ]
    };

    if (currentUserId) {
      whereClause.AND.push({ id: { not: currentUserId } });
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      select: {
        id: true,
        username: true,
        fullName: true,
        role: true,
        phone: true,
        organization: true
      },
      take: 50
    });

    return users as any;
  }

  /**
   * Fetch recent message senders and active conversations strictly isolated per user
   */
  static async getRecentConversations(currentUserId?: string): Promise<ConversationSenderItem[]> {
    const effectiveUserId = currentUserId || '';

    // 1. Fetch latest message for 'upazila-general'
    const generalMsg = await prisma.chatMessage.findFirst({
      where: { channel: 'upazila-general' },
      orderBy: { createdAt: 'desc' },
      include: {
        sender: {
          select: { id: true, username: true, fullName: true, role: true }
        }
      }
    });

    const generalConv: ConversationSenderItem = {
      id: 'upazila-general',
      channel: 'upazila-general',
      name: 'Upazila General Emergency Channel',
      username: 'all_responders',
      role: 'BROADCAST',
      organization: 'Emergency Operations Command',
      isGroup: true,
      avatarIcon: 'fa-bullhorn',
      avatarColor: 'bg-indigo-600',
      lastMessage: generalMsg ? {
        id: generalMsg.id,
        text: generalMsg.encryptionVersion ? '🔒 Encrypted message' : generalMsg.text,
        senderId: generalMsg.senderId,
        senderName: generalMsg.sender?.fullName || 'Emergency Dispatch',
        createdAt: generalMsg.createdAt
      } : null,
      unreadCount: 0
    };

    const conversationsMap = new Map<string, ConversationSenderItem>();

    // 2. If user is logged in, find ONLY direct messages that involve this user
    if (effectiveUserId) {
      const userDirectMessages = await prisma.chatMessage.findMany({
        where: {
          channel: {
            startsWith: 'direct-',
            contains: effectiveUserId
          }
        },
        orderBy: { createdAt: 'desc' },
        include: {
          sender: {
            select: {
              id: true,
              username: true,
              fullName: true,
              role: true,
              phone: true,
              organization: true
            }
          }
        },
        take: 200
      });

      const latestMessageByUser = new Map<string, any>();
      for (const msg of userDirectMessages) {
        const participantIds = getDirectParticipantIds(msg.channel);
        if (!participantIds || !participantIds.includes(effectiveUserId)) continue;
        const otherUserId = participantIds.find(id => id !== effectiveUserId);
        if (otherUserId && !latestMessageByUser.has(otherUserId)) latestMessageByUser.set(otherUserId, msg);
      }

      const otherUserIds = Array.from(latestMessageByUser.keys());
      const otherUsers = otherUserIds.length ? await prisma.user.findMany({
        where: { id: { in: otherUserIds } },
        select: {
          id: true,
          username: true,
          fullName: true,
          role: true,
          phone: true,
          organization: true
        }
      }) : [];
      const usersById = new Map(otherUsers.map((user: any) => [user.id, user]));

      for (const [otherUserId, msg] of latestMessageByUser) {
        const otherUser = usersById.get(otherUserId);
        if (!otherUser) continue;
        const roleColor = otherUser.role === 'COORDINATOR' ? 'bg-blue-600' :
                          otherUser.role === 'WORKER' ? 'bg-emerald-600' :
                          otherUser.role === 'ADMIN' ? 'bg-purple-600' :
                          otherUser.role === 'PLANNER' ? 'bg-cyan-600' : 'bg-amber-600';
        const roleIcon = otherUser.role === 'COORDINATOR' ? 'fa-user-shield' :
                         otherUser.role === 'WORKER' ? 'fa-helmet-safety' :
                         otherUser.role === 'ADMIN' ? 'fa-shield-halved' :
                         otherUser.role === 'PLANNER' ? 'fa-chart-line' : 'fa-user';
        conversationsMap.set(otherUserId, {
          id: otherUser.id,
          userId: otherUser.id,
          channel: `direct-${[effectiveUserId, otherUser.id].sort().join('-')}`,
          name: otherUser.fullName || otherUser.username,
          username: otherUser.username,
          role: otherUser.role,
          organization: otherUser.organization,
          phone: otherUser.phone,
          isGroup: false,
          avatarIcon: roleIcon,
          avatarColor: roleColor,
          lastMessage: {
            id: msg.id,
            text: msg.encryptionVersion ? '🔒 Encrypted message' : msg.text,
            senderId: msg.senderId,
            senderName: msg.sender?.fullName || otherUser.fullName || 'User',
            createdAt: msg.createdAt
          },
          unreadCount: msg.senderId !== effectiveUserId ? 1 : 0
        });
      }
    }

    // 3. Sort: Conversations with actual messages first (newest to oldest)
    const directList = Array.from(conversationsMap.values());
    directList.sort((a, b) => {
      const timeA = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const timeB = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return timeB - timeA;
    });

    const memberships = effectiveUserId ? await prisma.coordinationGroupMember.findMany({
      where: { userId: effectiveUserId },
      select: { groupId: true }
    }) : [];
    const groupResults = await Promise.all(
      memberships.map(async (membership: { groupId: string }) => {
        const group = await prisma.coordinationGroup.findUnique({
          where: { id: membership.groupId },
          select: { id: true, name: true, channel: true, status: true, leaderId: true }
        });
        if (!group || group.status !== 'ACTIVE') return null;
        const [lastMessage, leader] = await Promise.all([
          prisma.chatMessage.findFirst({
            where: { groupId: group.id },
            orderBy: { createdAt: 'desc' },
            include: { sender: { select: { id: true, fullName: true } } }
          }),
          prisma.user.findUnique({
            where: { id: group.leaderId },
            select: { fullName: true }
          })
        ]);
        return {
          id: group.id,
          channel: group.channel,
          name: group.name,
          role: 'COORDINATION GROUP',
          organization: leader?.fullName || 'Incident team',
          isGroup: true,
          avatarIcon: 'fa-people-group',
          avatarColor: 'bg-rose-600',
          lastMessage: lastMessage ? {
            id: lastMessage.id,
            text: lastMessage.encryptionVersion ? '🔒 Encrypted message' : lastMessage.text,
            senderId: lastMessage.senderId,
            senderName: lastMessage.sender?.fullName || 'Responder',
            createdAt: lastMessage.createdAt
          } : null,
          unreadCount: 0
        } as ConversationSenderItem;
      })
    );
    const groupList = groupResults.filter((item): item is ConversationSenderItem => item !== null);
    groupList.sort((a, b) => {
      const aTime = a.lastMessage ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bTime = b.lastMessage ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    return [generalConv, ...directList, ...groupList];
  }

  /**
   * Save message to chat_messages table
   */
  static async saveMessage(senderId: string, data: EncryptedChatPayload) {
    if (
      typeof data.text !== 'string' ||
      data.text.length < 1 ||
      data.text.length > 24000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data.text) ||
      typeof data.encryptionIv !== 'string' ||
      !/^[A-Za-z0-9+/]{16}$/.test(data.encryptionIv) ||
      typeof data.encryptionSignature !== 'string' ||
      !/^[A-Za-z0-9+/]{342}==$/.test(data.encryptionSignature) ||
      data.encryptionVersion !== 1 ||
      !data.encryptedKeys ||
      typeof data.encryptedKeys !== 'object' ||
      Array.isArray(data.encryptedKeys)
    ) {
      throw new Error('Invalid encrypted message payload.');
    }

    const sender = await prisma.user.findUnique({
      where: { id: senderId },
      select: {
        id: true,
        role: true,
        messagingPublicKey: true,
        messagingSigningPublicKey: true
      }
    });
    if (!sender || sender.role === 'CITIZEN' || !sender.messagingPublicKey || !sender.messagingSigningPublicKey) {
      throw new Error('Citizens do not have access to send messages in the tactical field messenger.');
    }

    const recipients = await this.getChannelEncryptionRecipients(senderId, data.channel);
    const recipientIds = recipients.map((recipient: { id: string }) => recipient.id).sort();
    const wrappedKeyIds = Object.keys(data.encryptedKeys).sort();
    if (
      recipients.length === 0 ||
      recipients.some((recipient: { messagingPublicKey: unknown; messagingSigningPublicKey: unknown }) =>
        !recipient.messagingPublicKey || !recipient.messagingSigningPublicKey
      ) ||
      JSON.stringify(recipientIds) !== JSON.stringify(wrappedKeyIds) ||
      Object.values(data.encryptedKeys).some((key) =>
        typeof key !== 'string' || !/^[A-Za-z0-9+/]{342}==$/.test(key)
      )
    ) {
      throw new Error('Secure message keys must be prepared for every current conversation member.');
    }
    try {
      const signingKey = createPublicKey({
        key: sender.messagingSigningPublicKey as JsonWebKey,
        format: 'jwk'
      });
      const validSignature = verifySignature(
        'sha256',
        Buffer.from(getSignedMessagePayload(senderId, data)),
        {
          key: signingKey,
          padding: constants.RSA_PKCS1_PSS_PADDING,
          saltLength: 32
        },
        Buffer.from(data.encryptionSignature, 'base64')
      );
      if (!validSignature) throw new Error('The secure message signature is invalid.');
    } catch (error) {
      console.warn('[Messaging] Rejected message with an invalid signature:', error);
      throw new Error('Unable to verify the secure message signature.');
    }

    const group = data.channel.startsWith('group-')
      ? await prisma.coordinationGroup.findUnique({ where: { channel: data.channel }, select: { id: true } })
      : null;
    return await prisma.chatMessage.create({
      data: {
        senderId,
        channel: data.channel,
        text: data.text,
        encryptionIv: data.encryptionIv,
        encryptedKeys: data.encryptedKeys,
        encryptionSignature: data.encryptionSignature,
        encryptionVersion: data.encryptionVersion,
        groupId: group?.id
      },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
            messagingSigningPublicKey: true
          }
        }
      }
    });
  }

  /**
   * Fetch chat history for a given channel
   */
  static async getChannelHistory(channel: string, limit: number = 50) {
    const messages = await prisma.chatMessage.findMany({
      where: { channel },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
            messagingSigningPublicKey: true
          }
        }
      },
      orderBy: { createdAt: 'desc' },
      take: limit
    });
    return messages.reverse();
  }

  static setupSocketMessaging(io: Server) {
    io.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) {
        return next();
      }

      const payload = verifyAuthToken(token);
      if (!payload) return next(new Error('Invalid or expired authentication token'));

      prisma.user.findUnique({
        where: { id: payload.userId },
        select: { id: true }
      }).then(user => {
        if (!user) return next(new Error('Authenticated user not found'));
        socket.data.messagingUserId = user.id;
        next();
      }).catch(error => {
        console.error('[Messaging] Socket authentication failed:', error);
        next(new Error('Unable to authenticate messaging connection'));
      });
    });

    io.on('connection', (socket: Socket) => {
      const userId = socket.data.messagingUserId as string | undefined;
      if (userId) socket.join(`user_${userId}`);

      socket.on('join_channel', async (channel: string, acknowledge?: (result: { ok: boolean; error?: string }) => void) => {
        try {
          if (!userId) {
            acknowledge?.({ ok: false, error: 'Sign in to access messaging.' });
            return;
          }
          if (typeof channel !== 'string' || !(await this.canAccessChannel(userId, channel))) {
            acknowledge?.({ ok: false, error: 'You do not have access to this conversation.' });
            return;
          }
          socket.join(channel);
          acknowledge?.({ ok: true });
        } catch (error) {
          console.error('[Messaging] Failed to join channel:', error);
          acknowledge?.({ ok: false, error: 'Unable to join this conversation.' });
        }
      });

      socket.on('leave_channel', (channel: string) => {
        if (typeof channel === 'string') socket.leave(channel);
      });

      socket.on('send_message', async (
        data: EncryptedChatPayload,
        acknowledge?: (result: { ok: boolean; message?: unknown; error?: string }) => void
      ) => {
        try {
          if (!userId) {
            acknowledge?.({ ok: false, error: 'Sign in to send messages.' });
            return;
          }
          if (!data || typeof data.channel !== 'string') {
            acknowledge?.({ ok: false, error: 'Invalid message.' });
            return;
          }
          if (!(await this.canAccessChannel(userId, data.channel))) {
            acknowledge?.({ ok: false, error: 'You do not have access to this conversation.' });
            return;
          }

          const msg = await this.saveMessage(userId, data);
          io.to(data.channel).emit('new_message', msg);

          if (data.channel && data.channel.startsWith('direct-')) {
            const participantIds = getDirectParticipantIds(data.channel);
            if (participantIds) {
              for (const participantId of participantIds) {
                io.to(`user_${participantId}`).emit('conversation_updated', {
                  channel: data.channel
                });
              }
            }
          } else if (data.channel.startsWith('group-')) {
            const group = await prisma.coordinationGroup.findUnique({
              where: { channel: data.channel },
              select: { id: true }
            });
            if (group) {
              const members = await prisma.coordinationGroupMember.findMany({
                where: { groupId: group.id },
                select: { userId: true }
              });
              for (const member of members) {
                io.to(`user_${member.userId}`).emit('conversation_updated', { channel: data.channel });
              }
            }
          }

          acknowledge?.({ ok: true, message: msg });
        } catch (err) {
          console.error('[Messaging] Failed to send message:', err);
          acknowledge?.({ ok: false, error: err instanceof Error ? err.message : 'Failed to send message.' });
        }
      });
    });
  }
}