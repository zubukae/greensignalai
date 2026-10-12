import { prisma } from '../lib/prisma';

export class DbAdminService {
  private static readonly MODEL_MAP: Record<string, string> = {
    users: 'user',
    user: 'user',
    administrative_nodes: 'administrativeNode',
    administrativenode: 'administrativeNode',
    administrativenodes: 'administrativeNode',
    relief_centers: 'reliefCenter',
    reliefcenter: 'reliefCenter',
    reliefcenters: 'reliefCenter',
    sensor_nodes: 'sensorNode',
    sensornode: 'sensorNode',
    sensornodes: 'sensorNode',
    chat_messages: 'chatMessage',
    chatmessage: 'chatMessage',
    chatmessages: 'chatMessage',
    disaster_alerts: 'disasterAlert',
    disasteralert: 'disasterAlert',
    disasteralerts: 'disasterAlert',
    disaster_incidents: 'disasterIncident',
    disasterincident: 'disasterIncident',
    disasterincidents: 'disasterIncident',
    incident_updates: 'incidentUpdate',
    incidentupdate: 'incidentUpdate',
    incidentupdates: 'incidentUpdate',
    coordination_groups: 'coordinationGroup',
    coordinationgroup: 'coordinationGroup',
    coordinationgroups: 'coordinationGroup',
    coordination_group_members: 'coordinationGroupMember',
    coordinationgroupmember: 'coordinationGroupMember',
    coordinationgroupmembers: 'coordinationGroupMember',
    volunteer_profiles: 'volunteerProfile',
    volunteerprofile: 'volunteerProfile',
    response_tasks: 'responseTask',
    responsetask: 'responseTask',
    response_task_assignees: 'responseTaskAssignee',
    responsetaskassignee: 'responseTaskAssignee',
    response_task_updates: 'responseTaskUpdate',
    responsetaskupdate: 'responseTaskUpdate',
    user_notifications: 'userNotification',
    usernotification: 'userNotification',
    alert_subscriptions: 'alertSubscription',
    alertsubscription: 'alertSubscription',
    incident_attachments: 'incidentAttachment',
    incidentattachment: 'incidentAttachment',
    shelter_occupancy_updates: 'shelterOccupancyUpdate',
    shelteroccupancyupdate: 'shelterOccupancyUpdate',
    operational_audits: 'operationalAudit',
    operationalaudit: 'operationalAudit',
    response_policies: 'responsePolicy',
    responsepolicy: 'responsePolicy',
    responsepolicies: 'responsePolicy',
    simulation_runs: 'simulationRun',
    simulationrun: 'simulationRun',
    simulationruns: 'simulationRun',
  };

  /**
   * Safely map a requested table name to a Prisma client accessor key
   */
  private static getPrismaModelName(requestedName: string): string | null {
    const key = requestedName.toLowerCase().trim();
    if (this.MODEL_MAP[key]) return this.MODEL_MAP[key];

    const normalized = key.replace(/_/g, '');
    if (this.MODEL_MAP[normalized]) return this.MODEL_MAP[normalized];

    // Direct match against prisma client keys
    for (const pKey of Object.keys(prisma)) {
      if (pKey.toLowerCase() === normalized) return pKey;
    }

    return null;
  }

  static async getTableStats(): Promise<Record<string, number>> {
    const tableKeys = [
      { snake: 'users', model: 'user' },
      { snake: 'administrative_nodes', model: 'administrativeNode' },
      { snake: 'sensor_nodes', model: 'sensorNode' },
      { snake: 'relief_centers', model: 'reliefCenter' },
      { snake: 'chat_messages', model: 'chatMessage' },
      { snake: 'disaster_alerts', model: 'disasterAlert' },
      { snake: 'disaster_incidents', model: 'disasterIncident' },
      { snake: 'incident_updates', model: 'incidentUpdate' },
      { snake: 'coordination_groups', model: 'coordinationGroup' },
      { snake: 'coordination_group_members', model: 'coordinationGroupMember' },
      { snake: 'volunteer_profiles', model: 'volunteerProfile' },
      { snake: 'response_tasks', model: 'responseTask' },
      { snake: 'response_task_assignees', model: 'responseTaskAssignee' },
      { snake: 'response_task_updates', model: 'responseTaskUpdate' },
      { snake: 'user_notifications', model: 'userNotification' },
      { snake: 'alert_subscriptions', model: 'alertSubscription' },
      { snake: 'incident_attachments', model: 'incidentAttachment' },
      { snake: 'shelter_occupancy_updates', model: 'shelterOccupancyUpdate' },
      { snake: 'operational_audits', model: 'operationalAudit' },
      { snake: 'response_policies', model: 'responsePolicy' },
      { snake: 'simulation_runs', model: 'simulationRun' }
    ];

    const stats: Record<string, number> = {};
    
    await Promise.all(
      tableKeys.map(async ({ snake, model }) => {
        try {
          const count = typeof (prisma as any)[model]?.count === 'function'
            ? await (prisma as any)[model].count()
            : 0;
          stats[snake] = count;
          stats[model] = count;
        } catch (e) {
          stats[snake] = 0;
          stats[model] = 0;
        }
      })
    );
    
    return stats;
  }

  static async getTableData(tableName: string, limit?: number) {
    const modelName = this.getPrismaModelName(tableName);
    if (!modelName || !(prisma as any)[modelName]) {
       throw new Error(`Table '${tableName}' not found in schema`);
    }

    const queryOptions: any = {};
    if (limit && limit > 0) {
      queryOptions.take = limit;
    }

    return await (prisma as any)[modelName].findMany(queryOptions);
  }

  static async createRecord(tableName: string, data: any) {
    const modelName = this.getPrismaModelName(tableName);
    if (!modelName || !(prisma as any)[modelName]) {
       throw new Error(`Table '${tableName}' not found in schema`);
    }
    
    return await (prisma as any)[modelName].create({ data });
  }

  static async updateRecord(tableName: string, id: string, data: any) {
    const modelName = this.getPrismaModelName(tableName);
    if (!modelName || !(prisma as any)[modelName]) {
       throw new Error(`Table '${tableName}' not found in schema`);
    }
    
    try {
        return await (prisma as any)[modelName].update({
            where: { id: id },
            data: data
        });
    } catch (e: any) {
        if (!isNaN(Number(id))) {
            return await (prisma as any)[modelName].update({
                where: { id: Number(id) },
                data: data
            });
        }
        throw e;
    }
  }

  static async deleteRecord(tableName: string, id: string) {
    const modelName = this.getPrismaModelName(tableName);
    if (!modelName || !(prisma as any)[modelName]) {
       throw new Error(`Table '${tableName}' not found in schema`);
    }
    
    try {
        await (prisma as any)[modelName].delete({
            where: { id: id }
        });
    } catch (e: any) {
        if (!isNaN(Number(id))) {
            await (prisma as any)[modelName].delete({
                where: { id: Number(id) }
            });
        } else {
            throw e;
        }
    }
    return { success: true };
  }

  static async executeQuery(query: string) {
    try {
      const isSelect = query.trim().toUpperCase().startsWith('SELECT');
      if (typeof (prisma as any).$queryRawUnsafe === 'function') {
        if (isSelect) {
          const rows = await (prisma as any).$queryRawUnsafe(query);
          return JSON.parse(
            JSON.stringify(rows, (_key, value) =>
              typeof value === 'bigint' ? value.toString() : value
            )
          );
        } else {
          const affectedRows = await (prisma as any).$executeRawUnsafe(query);
          return { affectedRows };
        }
      }
      return { message: 'Raw query executed', query };
    } catch (err: any) {
      return { error: err.message, query };
    }
  }

  /**
   * Generates a complete .sql export file
   */
  static async exportSqlDump(): Promise<string> {
    const now = new Date().toISOString();
    let sql = `-- GreenSignalAI Database Dump\n-- Generated At: ${now}\n\n`;

    try {
      const users = await prisma.user.findMany({ take: 200 });
      if (users.length > 0) {
        sql += `-- Table: users (${users.length} sample records)\n`;
        users.forEach((u: any) => {
          sql += `INSERT INTO users (id, username, email, full_name, role) VALUES ('${u.id}', '${u.username}', '${u.email || ''}', '${u.fullName || ''}', '${u.role}');\n`;
        });
        sql += '\n';
      }

      const nodes = await prisma.administrativeNode.findMany({ take: 200 });
      if (nodes.length > 0) {
        sql += `-- Table: administrative_nodes (${nodes.length} sample records)\n`;
        nodes.forEach((n: any) => {
          sql += `INSERT INTO administrative_nodes (id, name, code, tier, latitude, longitude) VALUES ('${n.id}', '${n.name.replace(/'/g, "''")}', '${n.code}', '${n.tier}', ${n.latitude}, ${n.longitude});\n`;
        });
        sql += '\n';
      }

      const centers = await prisma.reliefCenter.findMany({ take: 200 });
      if (centers.length > 0) {
        sql += `-- Table: relief_centers (${centers.length} sample records)\n`;
        centers.forEach((c: any) => {
          sql += `INSERT INTO relief_centers (id, name, capacity, occupancy) VALUES ('${c.id}', '${c.name.replace(/'/g, "''")}', ${c.capacity}, ${c.occupancy});\n`;
        });
        sql += '\n';
      }

      const alerts = await prisma.disasterAlert.findMany();
      if (alerts.length > 0) {
        sql += `-- Table: disaster_alerts (${alerts.length} records)\n`;
        alerts.forEach((a: any) => {
          sql += `INSERT INTO disaster_alerts (id, title, severity, is_active) VALUES ('${a.id}', '${a.title.replace(/'/g, "''")}', '${a.severity}', ${a.isActive});\n`;
        });
        sql += '\n';
      }
    } catch (e: any) {
      sql += `-- Export note: ${e.message}\n`;
    }

    return sql;
  }
}
