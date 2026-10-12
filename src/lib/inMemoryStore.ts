import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { generateSensorTimeSeries } from '../services/sensorTimeSeries';

// Fast precomputed default password hash
let cachedDefaultHash = '';
function getDefaultHash(): string {
  if (!cachedDefaultHash) {
    cachedDefaultHash = bcrypt.hashSync('password', 4);
  }
  return cachedDefaultHash;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

export class InMemoryStore {
  users: any[] = [];
  administrativeNodes: any[] = [];
  sensorNodes: any[] = [];
  reliefCenters: any[] = [];
  chatMessages: any[] = [];
  disasterAlerts: any[] = [];
  disasterIncidents: any[] = [];
  incidentUpdates: any[] = [];
  coordinationGroups: any[] = [];
  coordinationGroupMembers: any[] = [];
  volunteerProfiles: any[] = [];
  responseTasks: any[] = [];
  responseTaskAssignees: any[] = [];
  responseTaskUpdates: any[] = [];
  userNotifications: any[] = [];
  alertSubscriptions: any[] = [];
  incidentAttachments: any[] = [];
  shelterOccupancyUpdates: any[] = [];
  operationalAudits: any[] = [];
  responsePolicies: any[] = [];
  simulationRuns: any[] = [];

  private initialized = false;

  constructor() {
    this.init();
  }

  private init() {
    if (this.initialized) return;
    this.initialized = true;

    // 1. National Command Node
    const nationalNode = {
      id: 'node-bd-national-hq',
      name: 'Bangladesh National Command',
      tier: 'COUNTRY',
      code: 'BD-HQ',
      parentId: null,
      latitude: 23.8103,
      longitude: 90.4125,
      inventory: { food_packs: 50000, water_liters: 150000, medical_kits: 10000, dry_food_bags: 5000, emergency_tents: 2000 },
      requirements: { food_packs_needed: 0, water_liters_needed: 0, medical_kits_needed: 0, tents_needed: 0 },
      affectedPeople: { total_affected: 0, displaced: 0, injured: 0, casualties: 0, vulnerable_groups: { children: 0, elderly: 0, pregnant: 0 } },
      sensorData: { water_level_m: 2.1, rainfall_mm: 5.0, wind_speed_kmh: 18.0, salinity_ppt: 2.4, status: 'NORMAL' },
      incidents: [],
      situationReport: { status: 'STABLE', summary: 'All regional divisions operating within standard preparedness parameters', last_updated: new Date().toISOString(), updated_by: 'National Command Center' },
      messages: [],
      messagingPublicKey: null,
      messagingSigningPublicKey: null,
      messagingPrivateKeyVault: null,
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.administrativeNodes.push(nationalNode);

    // 2. Parse CSV
    const csvPath = path.join(process.cwd(), 'upazilla lat long - Sheet1.csv');
    const divisionMap = new Map<string, any>();
    const districtMap = new Map<string, any>();
    const upazilaMap = new Map<string, any>();

    const divisionCoordinators = new Set<string>();
    const districtCoordinators = new Set<string>();

    let rows: any[] = [];
    if (fs.existsSync(csvPath)) {
      try {
        const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).filter(l => l.trim().length > 0);
        let curDiv = '';
        let curDist = '';

        for (let i = 1; i < lines.length; i++) {
          const parts = parseCSVLine(lines[i]);
          if (parts.length < 4) continue;
          const rawDiv = parts[0]?.trim();
          const rawDist = parts[1]?.trim();
          const rawUpz = parts[2]?.trim();
          const rawLatLong = parts[3]?.trim();
          const worker = parts[4]?.trim() || '';
          const citizen = parts[5]?.trim() || '';
          const coordinator = parts[6]?.trim() || '';
          const planner = parts[7]?.trim() || '';
          const sensors = parts[8]?.trim() || '';
          const centers = parts[9]?.trim() || '';

          if (rawDiv) curDiv = rawDiv;
          if (rawDist) curDist = rawDist.replace(/\s+District$/i, '');
          if (!rawUpz) continue;

          const upzClean = rawUpz.replace(/^\d+\.\s*/, '').replace(/\s+Upazila$/i, '').trim();

          let lat = 24.8335;
          let lng = 89.0438;
          if (rawLatLong) {
            const coords = rawLatLong.split(',').map(s => parseFloat(s.trim()));
            if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
              lat = coords[0];
              lng = coords[1];
            }
          }

          rows.push({
            division: curDiv.trim(),
            district: curDist.trim(),
            upazila: upzClean,
            lat,
            lng,
            worker,
            citizen,
            coordinator,
            planner,
            sensors,
            centers
          });
        }
      } catch (e) {
        console.warn('Error parsing CSV for in-memory seed:', e);
      }
    }

    // Default Adamdighi row if CSV missing
    if (rows.length === 0) {
      rows = [{
        division: 'Rajshahi',
        district: 'Bogura',
        upazila: 'Adamdighi',
        lat: 24.8335,
        lng: 89.0438,
        worker: 'worker1',
        citizen: 'citizen1',
        coordinator: 'Coordinator1',
        planner: 'Planner1',
        sensors: 'sensor1',
        centers: 'center1'
      }];
    }

    for (const r of rows) {
      // Division Node
      if (!divisionMap.has(r.division)) {
        const divNode = {
          id: `div-${r.division.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
          name: `${r.division} Division`,
          tier: 'DIVISION',
          code: `DIV-${r.division.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
          parentId: nationalNode.id,
          latitude: r.lat,
          longitude: r.lng,
          inventory: { food_packs: 10000, water_liters: 30000, medical_kits: 2000, dry_food_bags: 1000, emergency_tents: 500 },
          requirements: { food_packs_needed: 0, water_liters_needed: 0, medical_kits_needed: 0, tents_needed: 0 },
          affectedPeople: { total_affected: 0, displaced: 0, injured: 0, casualties: 0, vulnerable_groups: { children: 0, elderly: 0, pregnant: 0 } },
          sensorData: { water_level_m: 2.1, rainfall_mm: 5.0, wind_speed_kmh: 18.0, salinity_ppt: 2.4, status: 'NORMAL' },
          incidents: [],
          situationReport: { status: 'STABLE', summary: 'Division regional depots ready', last_updated: new Date().toISOString(), updated_by: `${r.division} Command` },
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date()
        };
        this.administrativeNodes.push(divNode);
        divisionMap.set(r.division, divNode);
      }
      const divNode = divisionMap.get(r.division)!;

      // District Node
      const distKey = `${r.division}|${r.district}`;
      if (!districtMap.has(distKey)) {
        const distNode = {
          id: `dist-${r.district.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
          name: `${r.district} District`,
          tier: 'DISTRICT',
          code: `DST-${r.district.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
          parentId: divNode.id,
          latitude: r.lat,
          longitude: r.lng,
          inventory: { food_packs: 3000, water_liters: 10000, medical_kits: 500, dry_food_bags: 300, emergency_tents: 150 },
          requirements: { food_packs_needed: 0, water_liters_needed: 0, medical_kits_needed: 0, tents_needed: 0 },
          affectedPeople: { total_affected: 0, displaced: 0, injured: 0, casualties: 0, vulnerable_groups: { children: 0, elderly: 0, pregnant: 0 } },
          sensorData: { water_level_m: 2.1, rainfall_mm: 5.0, wind_speed_kmh: 18.0, salinity_ppt: 2.4, status: 'NORMAL' },
          incidents: [],
          situationReport: { status: 'STABLE', summary: 'District prepositioning active', last_updated: new Date().toISOString(), updated_by: `${r.district} DC Office` },
          messages: [],
          createdAt: new Date(),
          updatedAt: new Date()
        };
        this.administrativeNodes.push(distNode);
        districtMap.set(distKey, distNode);
      }
      const distNode = districtMap.get(distKey)!;

      // Upazila Node
      const upzSlug = `${r.district.toLowerCase().replace(/[^a-z0-9]/g, '')}-${r.upazila.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const upzId = `upz-${upzSlug}`;
      const upzNode: any = {
        id: upzId,
        name: `${r.upazila} Upazila`,
        tier: 'UPAZILA',
        code: `UPZ-${r.district.toUpperCase().replace(/[^A-Z0-9]/g, '')}-${r.upazila.toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
        parentId: distNode.id,
        latitude: r.lat,
        longitude: r.lng,
        inventory: { food_packs: 700, water_liters: 2500, medical_kits: 120, dry_food_bags: 80, emergency_tents: 30 },
        requirements: { food_packs_needed: 100, water_liters_needed: 500, medical_kits_needed: 20, tents_needed: 10 },
        affectedPeople: { total_affected: 150, displaced: 45, injured: 2, casualties: 0, vulnerable_groups: { children: 12, elderly: 8, pregnant: 2 } },
        sensorData: { water_level_m: 2.1, rainfall_mm: 5.0, wind_speed_kmh: 18.0, salinity_ppt: 2.4, status: 'NORMAL' },
        incidents: [],
        situationReport: { status: 'STABLE', summary: 'Normal local conditions', last_updated: new Date().toISOString(), updated_by: `${r.upazila} Disaster Management` },
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.administrativeNodes.push(upzNode);
      upazilaMap.set(r.upazila, upzNode);

      // Relief Center
      const rcCode = `RC-${r.district.toUpperCase()}-${r.upazila.toUpperCase()}`.replace(/[^A-Z0-9-]/g, '');
      const rc = {
        id: `rc-${upzSlug}`,
        centerCode: rcCode,
        name: `${r.upazila} Primary Relief Shelter`,
        districtNodeId: upzNode.id,
        latitude: r.lat,
        longitude: r.lng,
        capacity: 1000,
        occupancy: 150,
        contactNum: null,
        isOperational: true,
        stockPolicy: { beds: 600, food_packs: 1200, medical_kits: 300, vehicles: 6, tents: 80 },
        currentStock: { beds: 420, food_packs: 850, medical_kits: 180, vehicles: 4, tents: 50 },
        emergencyRequirement: { beds: 80, food_packs: 200, medical_kits: 50, vehicles: 2, tents: 20 },
        restockingRequirement: { beds: 180, food_packs: 350, medical_kits: 120, vehicles: 2, tents: 30 },
        verificationStatus: 'UNVERIFIED',
        verifiedAt: null,
        verifiedById: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.reliefCenters.push(rc);

      // 5 Hardware Sensor Telemetry Streams (WATER, WIND, SALINITY, SEISMOGRAPH, RAINFALL)
      const sensorTypes: ('WATER' | 'WIND' | 'SALINITY' | 'SEISMOGRAPH' | 'RAINFALL')[] = [
        'WATER',
        'WIND',
        'SALINITY',
        'SEISMOGRAPH',
        'RAINFALL'
      ];

      const upzSensorsPackage: Record<string, any> = {};

      sensorTypes.forEach((st, idx) => {
        const sCode = `SN-${r.district.toUpperCase()}-${r.upazila.toUpperCase()}-${st}`.replace(/[^A-Z0-9-]/g, '');
        const timeSeriesData = generateSensorTimeSeries(st, r.district, r.upazila, r.division);
        upzSensorsPackage[st.toLowerCase()] = timeSeriesData;

        this.sensorNodes.push({
          id: `sensor-${upzSlug}-${st.toLowerCase()}`,
          sensorCode: sCode,
          districtNodeId: upzNode.id,
          type: st,
          latitude: r.lat + (idx === 0 ? 0.005 : idx === 1 ? -0.005 : idx === 2 ? 0.003 : idx === 3 ? -0.003 : 0.007),
          longitude: r.lng + (idx === 0 ? 0.004 : idx === 1 ? 0.006 : idx === 2 ? -0.005 : idx === 3 ? -0.002 : -0.006),
          metricValue: timeSeriesData.metricValue,
          currentValue: timeSeriesData.currentValue,
          unit: timeSeriesData.unit,
          warningThreshold: timeSeriesData.warningThreshold,
          dangerThreshold: timeSeriesData.dangerThreshold,
          timeSeries: timeSeriesData.timeSeries,
          forecastSeries: timeSeriesData.forecastSeries,
          analytics: timeSeriesData.analytics,
          status: 'ACTIVE',
          lastPing: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        });
      });

      // Update Upazila node sensorData summary
      upzNode.sensorData = {
        water_level_m: upzSensorsPackage.water?.currentValue || 2.1,
        wind_speed_kmh: upzSensorsPackage.wind?.currentValue || 22.0,
        pressure_hpa: upzSensorsPackage.wind?.analytics?.currentPressureHpa || 1011.0,
        salinity_ppt: upzSensorsPackage.salinity?.currentValue || 1.8,
        seismic_magnitude: upzSensorsPackage.seismograph?.analytics?.foreshockMagnitude || 1.2,
        rainfall_mm: upzSensorsPackage.rainfall?.currentValue || 35.0,
        storm_probability_pct: upzSensorsPackage.wind?.analytics?.stormProbabilityPct || 15,
        quake_probability_pct: upzSensorsPackage.seismograph?.analytics?.probabilityBiggerEarthquakePct || 8,
        flood_risk: upzSensorsPackage.water?.analytics?.floodRisk || 'NORMAL',
        status: upzSensorsPackage.water?.currentValue > 5.5 || upzSensorsPackage.wind?.currentValue > 60 ? 'ELEVATED' : 'NORMAL'
      };

      // Users from CSV
      if (r.worker) {
        this.addUser(r.worker, 'WORKER', upzNode.id);
      }
      if (r.citizen) {
        this.addUser(r.citizen, 'CITIZEN', upzNode.id);
      }
      if (r.coordinator) {
        if (!divisionCoordinators.has(r.division)) {
          this.addUser(r.coordinator, 'COORDINATOR', divNode.id);
          divisionCoordinators.add(r.division);
        } else if (!districtCoordinators.has(r.district)) {
          this.addUser(r.coordinator, 'COORDINATOR', distNode.id);
          districtCoordinators.add(r.district);
        } else {
          this.addUser(r.coordinator, 'COORDINATOR', upzNode.id);
        }
      }
      if (r.planner) {
        this.addUser(r.planner, 'PLANNER', distNode.id);
      }
    }

    // 3. Guarantee Presets for Fast UI Switching & Login
    const adamdighiUpz = upazilaMap.get('Adamdighi') || this.administrativeNodes.find(n => n.tier === 'UPAZILA') || nationalNode;
    const boguraDist = districtMap.get('Rajshahi|Bogura') || this.administrativeNodes.find(n => n.tier === 'DISTRICT') || nationalNode;
    const rajshahiDiv = divisionMap.get('Rajshahi') || this.administrativeNodes.find(n => n.tier === 'DIVISION') || nationalNode;
    const dhakaDiv = divisionMap.get('Dhaka') || this.administrativeNodes.find(n => n.id === 'div-dhaka') || rajshahiDiv;
    const dhakaDist = districtMap.get('Dhaka|Dhaka') || this.administrativeNodes.find(n => n.id === 'dist-dhaka') || boguraDist;

    this.addUser('Adamdighi Citizen', 'CITIZEN', adamdighiUpz.id, 'Adamdighi Citizen', 'citizen.adamdighi@dmr.bd.gov');
    this.addUser('adamdighi_citizen', 'CITIZEN', adamdighiUpz.id, 'Adamdighi Citizen', 'citizen.adamdighi@dmr.bd.gov');
    this.addUser('citizen1', 'CITIZEN', adamdighiUpz.id, 'Adamdighi Citizen', 'citizen1@dmr.bd.gov');
    this.addUser('Adamdighi Coordinator', 'COORDINATOR', adamdighiUpz.id, 'Adamdighi Disaster Coordinator', 'coord.adamdighi@dmr.bd.gov');
    this.addUser('adamdighi_coordinator', 'COORDINATOR', adamdighiUpz.id, 'Adamdighi Disaster Coordinator', 'coord.adamdighi@dmr.bd.gov');
    this.addUser('Coordinator1', 'COORDINATOR', adamdighiUpz.id, 'Adamdighi Disaster Coordinator', 'coordinator1@dmr.bd.gov');
    this.addUser('adamdighi_worker', 'WORKER', adamdighiUpz.id, 'Adamdighi Field Responder', 'worker.adamdighi@dmr.bd.gov');
    this.addUser('adamdighi_planner', 'PLANNER', boguraDist.id, 'Bogura District Planner', 'planner.adamdighi@dmr.bd.gov');
    this.addUser('Bogura Coordinator', 'COORDINATOR', boguraDist.id, 'Bogura District Relief Officer', 'coord.bogura@dmr.bd.gov');
    this.addUser('Rajshahi Coordinator', 'COORDINATOR', rajshahiDiv.id, 'Rajshahi Division Director', 'coord.rajshahi@dmr.bd.gov');
    this.addUser('Dhaka Coordinator', 'COORDINATOR', dhakaDiv.id, 'Dhaka Division Director', 'coord.dhaka@dmr.bd.gov');
    this.addUser('dhaka_coordinator', 'COORDINATOR', dhakaDiv.id, 'Dhaka Division Coordinator', 'coord.dhaka@dmr.bd.gov');
    this.addUser('Dhaka District Coordinator', 'COORDINATOR', dhakaDist.id, 'Dhaka District Relief Officer', 'coord.dhakadist@dmr.bd.gov');
    this.addUser('National Coordinator', 'COORDINATOR', nationalNode.id, 'National Disaster Coordinator', 'national.coord@dmr.bd.gov');
    this.addUser('national_coordinator', 'COORDINATOR', nationalNode.id, 'National Disaster Coordinator', 'national.coord@dmr.bd.gov');
    this.addUser('Admin', 'ADMIN', nationalNode.id, 'National HQ Administrator', 'admin@dmr.bd.gov');
    this.addUser('planner.bogura', 'PLANNER', boguraDist.id, 'Bogura District Planner', 'planner.bogura@dmr.bd.gov');

    // 4. Disaster Alerts
    this.disasterAlerts.push({
      id: 'alert-bd-1',
      title: 'Monsoon Runoff Watch: Jamuna River Basin',
      description: 'Upstream inflows have raised river stage levels by 0.3m over the past 24 hours in Bogura & Sariakandi. Local relief shelters are on standby.',
      district: 'Bogura',
      severity: 'WARNING',
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date()
    });

    this.disasterAlerts.push({
      id: 'alert-bd-2',
      title: 'GreenSignalAI Telemetry Grid Active',
      description: 'Automated water, wind, salinity, and seismic sensor telemetry streaming live across all divisional administrative nodes.',
      district: 'NATIONWIDE',
      severity: 'INFO',
      isActive: true,
      createdAt: new Date(Date.now() - 3600000),
      updatedAt: new Date()
    });

    // 5. Response Policy
    this.responsePolicies.push({
      id: 'policy-national-1',
      name: 'Cost-Minimized Pre-positioning v1',
      description: 'National baseline optimization strategy balancing transport cost against unmet demand penalties.',
      tierScope: 'COUNTRY',
      status: 'ACTIVE',
      triggers: { min_rainfall_24h_mm: 100.0, river_level_above_danger_m: 0.5, predicted_path_probability: 0.70 },
      allocationRules: { food_packs_per_person_per_day: 1.0, water_liters_per_person_per_day: 3.0, medical_kits_per_100_people: 1.0, hub_safety_stock_percent: 20 },
      priorityWeights: { vulnerability_score_weight: 0.35, affected_population_weight: 0.30, lead_time_proximity_weight: 0.20, shelter_capacity_utilization_weight: 0.15 },
      costParameters: { transport_cost_per_km_ton: 45.0, warehouse_holding_cost_per_day: 5.0, unmet_demand_penalty_per_person: 1500.0 },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 6. Initial Chat Messages
    const coordUser = this.users.find(u => u.username === 'Adamdighi Coordinator');
    if (coordUser) {
      this.chatMessages.push({
        id: 'msg-init-1',
        channel: 'upazila-general',
        text: 'Welcome to the GreenSignalAI Field Messenger. Communications are operational.',
        senderId: coordUser.id,
        createdAt: new Date(Date.now() - 1800000)
      });
    }

    console.log(`✅ [InMemoryStore] Initialized with ${this.administrativeNodes.length} nodes, ${this.users.length} users, ${this.reliefCenters.length} centers, ${this.sensorNodes.length} sensors.`);
  }

  private addUser(username: string, role: string, districtNodeId: string, fullName?: string, email?: string, phone?: string) {
    if (!username) return;
    const existing = this.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      existing.role = role;
      existing.districtNodeId = districtNodeId;
      if (fullName) existing.fullName = fullName;
      if (email) existing.email = email;
      if (phone) existing.phone = phone;
      return existing;
    }

    const cleanUser = username.toLowerCase().replace(/[^a-z0-9]/g, '');
    const user = {
      id: `user-${crypto.randomUUID()}`,
      username: username,
      email: email || `${cleanUser}@dmr.bd.gov`,
      passwordHash: getDefaultHash(),
      fullName: fullName || username,
      role: role,
      phone: phone || null,
      organization: role === 'COORDINATOR' ? 'Disaster Management Committee' : role === 'WORKER' ? 'Red Crescent Field Team' : role === 'PLANNER' ? 'Planning Commission' : 'Citizen Community',
      districtNodeId: districtNodeId,
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };
    this.users.push(user);
    return user;
  }
}

// Global Singleton Store Instance
const globalStore = new InMemoryStore();

// Helper to filter objects matching Prisma where clause
function matchesWhere(item: any, where: any, store: InMemoryStore): boolean {
  if (!where || Object.keys(where).length === 0) return true;

  if (where.OR && Array.isArray(where.OR)) {
    if (!where.OR.some((clause: any) => matchesWhere(item, clause, store))) return false;
  }

  if (where.AND && Array.isArray(where.AND)) {
    if (!where.AND.every((clause: any) => matchesWhere(item, clause, store))) return false;
  }

  if (where.NOT) {
    if (typeof where.NOT === 'object') {
      if (matchesWhere(item, where.NOT, store)) return false;
    }
  }

  for (const key of Object.keys(where)) {
    if (key === 'OR' || key === 'AND' || key === 'NOT') continue;
    if (key === 'groupId_userId') {
      if (item.groupId !== where[key].groupId || item.userId !== where[key].userId) return false;
      continue;
    }
    if (key === 'userId_administrativeNodeId') {
      if (item.userId !== where[key].userId || item.administrativeNodeId !== where[key].administrativeNodeId) return false;
      continue;
    }
    const expected = where[key];
    const actual = item[key];

    // Relation filter (e.g. districtNode: { OR: [...] }, parent: { ... })
    if (key === 'districtNode' && expected && typeof expected === 'object') {
      const node = store.administrativeNodes.find(n => n.id === item.districtNodeId);
      if (!node) return false;
      if (!matchesWhere(node, expected, store)) return false;
      continue;
    }

    if (key === 'parent' && expected && typeof expected === 'object') {
      const parentNode = item.parentId ? store.administrativeNodes.find(n => n.id === item.parentId) : null;
      if (!parentNode) return false;
      if (!matchesWhere(parentNode, expected, store)) return false;
      continue;
    }
    if (key === 'assignees' && expected?.some) {
      const matches = store.responseTaskAssignees.some(entry =>
        entry.taskId === item.id && matchesWhere(entry, expected.some, store)
      );
      if (!matches) return false;
      continue;
    }
    if (key === 'volunteerProfile' && expected && typeof expected === 'object') {
      const profile = store.volunteerProfiles.find(entry => entry.userId === item.id);
      if (!profile || !matchesWhere(profile, expected, store)) return false;
      continue;
    }

    // Direct object filters
    if (expected && typeof expected === 'object') {
      if (expected.in && Array.isArray(expected.in)) {
        if (!expected.in.includes(actual)) return false;
        continue;
      }
      if (expected.gte !== undefined && !(actual >= expected.gte)) return false;
      if (expected.lte !== undefined && !(actual <= expected.lte)) return false;
      if (expected.not !== undefined) {
        if (actual === expected.not) return false;
        continue;
      }
      if (expected.contains !== undefined) {
        const expStr = String(expected.contains).toLowerCase();
        const actStr = String(actual || '').toLowerCase();
        if (!actStr.includes(expStr)) return false;
        continue;
      }
      if (expected.equals !== undefined) {
        if (expected.mode === 'insensitive' || key === 'username' || key === 'email') {
          const act = String(actual || '').trim().toLowerCase();
          const exp = String(expected.equals || '').trim().toLowerCase();
          const actNorm = act.replace(/[\s_]+/g, '');
          const expNorm = exp.replace(/[\s_]+/g, '');
          if (act !== exp && actNorm !== expNorm) return false;
        } else {
          if (actual !== expected.equals) return false;
        }
        continue;
      }
    } else {
      if (key === 'username' || key === 'email') {
        const act = String(actual || '').trim().toLowerCase();
        const exp = String(expected || '').trim().toLowerCase();
        const actNorm = act.replace(/[\s_]+/g, '');
        const expNorm = exp.replace(/[\s_]+/g, '');
        if (act !== exp && actNorm !== expNorm) return false;
      } else {
        if (actual !== expected) return false;
      }
    }
  }

  return true;
}

// Helper to expand relations for Prisma includes
function expandIncludes(modelName: string, item: any, include: any, store: InMemoryStore): any {
  if (!include || !item) return item;
  const clone = { ...item };

  if (modelName === 'user') {
    if (include.districtNode) {
      clone.districtNode = store.administrativeNodes.find(n => n.id === clone.districtNodeId) || null;
    }
    if (include.volunteerProfile) {
      const profile = store.volunteerProfiles.find(entry => entry.userId === clone.id) || null;
      clone.volunteerProfile = profile;
    }
  }

  if (modelName === 'administrativeNode') {
    if (include.children) {
      const children = store.administrativeNodes.filter(n => n.parentId === clone.id);
      if (typeof include.children === 'object' && include.children.include) {
        clone.children = children.map(c => expandIncludes('administrativeNode', c, include.children.include, store));
      } else {
        clone.children = children;
      }
    }
    if (include.parent) {
      clone.parent = store.administrativeNodes.find(n => n.id === clone.parentId) || null;
    }
    if (include.reliefCenters || include.shelters) {
      clone.reliefCenters = store.reliefCenters.filter(rc => rc.districtNodeId === clone.id);
    }
    if (include.sensors) {
      clone.sensors = store.sensorNodes.filter(s => s.districtNodeId === clone.id);
    }
  }

  if (modelName === 'reliefCenter') {
    if (include.districtNode) {
      const node = store.administrativeNodes.find(n => n.id === clone.districtNodeId) || null;
      clone.districtNode = node && include.districtNode.select ? projectSelect(node, include.districtNode.select) : node;
    }
  }

  if (modelName === 'responseTask') {
    if (include.administrativeNode) {
      const node = store.administrativeNodes.find(entry => entry.id === clone.administrativeNodeId) || null;
      clone.administrativeNode = node && include.administrativeNode.select
        ? projectSelect(node, include.administrativeNode.select)
        : node;
    }
    if (include.assignees) {
      clone.assignees = store.responseTaskAssignees
        .filter(entry => entry.taskId === clone.id)
        .map(entry => {
          if (!include.assignees.include?.user) return entry;
          const user = store.users.find(candidate => candidate.id === entry.userId);
          return {
            ...entry,
            user: user ? projectSelect(user, include.assignees.include.user.select) : null
          };
        });
    }
    if (include.updates) {
      const order = include.updates.orderBy?.createdAt === 'asc' ? 1 : -1;
      clone.updates = store.responseTaskUpdates
        .filter(entry => entry.taskId === clone.id)
        .sort((a, b) => order * (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()))
        .map(entry => {
          if (!include.updates.include?.author) return entry;
          const author = store.users.find(candidate => candidate.id === entry.authorId);
          return { ...entry, author: author ? projectSelect(author, include.updates.include.author.select) : null };
        });
    }
  }

  if (modelName === 'volunteerProfile' && include.user) {
    const user = store.users.find(candidate => candidate.id === clone.userId);
    clone.user = user ? projectSelect(user, include.user.select) : null;
  }

  if (modelName === 'alertSubscription' && include.administrativeNode) {
    const node = store.administrativeNodes.find(entry => entry.id === clone.administrativeNodeId);
    clone.administrativeNode = node ? projectSelect(node, include.administrativeNode.select) : null;
  }

  if (modelName === 'incidentAttachment' && include.incident) {
    const incident = store.disasterIncidents.find(entry => entry.id === clone.incidentId);
    clone.incident = incident ? projectSelect(incident, include.incident.select) : null;
  }

  if (modelName === 'operationalAudit') {
    if (include.actor) {
      const actor = store.users.find(candidate => candidate.id === clone.actorId);
      clone.actor = actor ? projectSelect(actor, include.actor.select) : null;
    }
    if (include.administrativeNode) {
      const node = store.administrativeNodes.find(entry => entry.id === clone.administrativeNodeId);
      clone.administrativeNode = node ? projectSelect(node, include.administrativeNode.select) : null;
    }
  }

  if (modelName === 'sensorNode') {
    if (include.districtNode) {
      const node = store.administrativeNodes.find(n => n.id === clone.districtNodeId) || null;
      clone.districtNode = node && include.districtNode.select ? projectSelect(node, include.districtNode.select) : node;
    }
  }

  if (modelName === 'chatMessage') {
    if (include.sender) {
      const sender = store.users.find(u => u.id === clone.senderId);
      if (sender) {
        if (typeof include.sender === 'object' && include.sender.select) {
          const sel: any = {};
          for (const k of Object.keys(include.sender.select)) {
            sel[k] = (sender as any)[k];
          }
          clone.sender = sel;
        } else {
          clone.sender = sender;
        }
      } else {
        clone.sender = null;
      }
    }
  }

  if (modelName === 'incidentUpdate' && include.author) {
    const author = store.users.find(user => user.id === clone.authorId);
    if (author) {
      const select = typeof include.author === 'object' ? include.author.select : null;
      clone.author = select ? projectSelect(author, select) : author;
    } else {
      clone.author = null;
    }
  }

  return clone;
}

// Helper to project selected fields
function projectSelect(item: any, select: any): any {
  if (!select || !item) return item;
  const result: any = {};
  for (const k of Object.keys(select)) {
    if (select[k]) {
      result[k] = item[k];
    }
  }
  return result;
}

// Factory to create model collection adapters
function createModelAdapter(modelName: string, getList: () => any[], store: InMemoryStore) {
  return {
    async findUnique(args: { where: any; include?: any; select?: any }) {
      const list = getList();
      const found = list.find(item => matchesWhere(item, args.where, store));
      if (!found) return null;
      let expanded = expandIncludes(modelName, found, args.include || args.select, store);
      if (args.select) expanded = projectSelect(expanded, args.select);
      return expanded;
    },

    async findFirst(args?: { where?: any; include?: any; select?: any; orderBy?: any }) {
      const list = getList();
      const where = args?.where || {};
      const found = list.find(item => matchesWhere(item, where, store));
      if (!found) return null;
      let expanded = expandIncludes(modelName, found, args?.include || args?.select, store);
      if (args?.select) expanded = projectSelect(expanded, args.select);
      return expanded;
    },

    async findMany(args?: { where?: any; include?: any; select?: any; orderBy?: any; take?: number; skip?: number }) {
      const list = getList();
      const where = args?.where || {};
      let filtered = list.filter(item => matchesWhere(item, where, store));

      if (args?.orderBy) {
        const orderRules = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
        filtered.sort((a, b) => {
          for (const rule of orderRules) {
            const orderKey = Object.keys(rule)[0];
            const dir = rule[orderKey];
            if (a[orderKey] === b[orderKey]) continue;
            return dir === 'desc' ? (b[orderKey] > a[orderKey] ? 1 : -1) : (a[orderKey] > b[orderKey] ? 1 : -1);
          }
          return 0;
        });
      }

      if (args?.skip) filtered = filtered.slice(args.skip);
      if (args?.take) filtered = filtered.slice(0, args.take);

      return filtered.map(item => {
        let expanded = expandIncludes(modelName, item, args?.include || args?.select, store);
        if (args?.select) expanded = projectSelect(expanded, args.select);
        return expanded;
      });
    },

    async create(args: { data: any; include?: any; select?: any }) {
      const list = getList();
      const data = { ...args.data };
      if (modelName === 'userNotification' && data.readAt === undefined) data.readAt = null;
      if (modelName === 'responseTask' && data.assignees?.create) {
        const assignments = data.assignees.create;
        delete data.assignees;
        const record = {
          id: data.id || `${modelName}-${crypto.randomUUID()}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        list.push(record);
        for (const assignment of assignments) {
          store.responseTaskAssignees.push({ taskId: record.id, userId: assignment.userId, assignedAt: new Date() });
        }
        let expanded = expandIncludes(modelName, record, args.include, store);
        if (args.select) expanded = projectSelect(expanded, args.select);
        return expanded;
      }
      const record = {
        id: data.id || `${modelName}-${crypto.randomUUID()}`,
        ...data,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      list.push(record);
      let expanded = expandIncludes(modelName, record, args.include, store);
      if (args.select) expanded = projectSelect(expanded, args.select);
      return expanded;
    },

    async createMany(args: { data: any[] }) {
      const list = getList();
      for (const data of args.data) {
        list.push({
          id: data.id || `${modelName}-${crypto.randomUUID()}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      }
      return { count: args.data.length };
    },

    async update(args: { where: any; data: any; include?: any; select?: any }) {
      const list = getList();
      const idx = list.findIndex(item => matchesWhere(item, args.where, store));
      if (idx === -1) {
        throw new Error(`Record to update not found in ${modelName}`);
      }
      const updated = {
        ...list[idx],
        ...args.data,
        updatedAt: new Date()
      };
      list[idx] = updated;
      let expanded = expandIncludes(modelName, updated, args.include, store);
      if (args.select) expanded = projectSelect(expanded, args.select);
      return expanded;
    },

    async updateMany(args: { where?: any; data: any }) {
      const list = getList();
      const where = args.where || {};
      let count = 0;
      for (let i = 0; i < list.length; i++) {
        if (!matchesWhere(list[i], where, store)) continue;
        list[i] = { ...list[i], ...args.data, updatedAt: new Date() };
        count++;
      }
      return { count };
    },

    async upsert(args: { where: any; update: any; create: any; include?: any; select?: any }) {
      const list = getList();
      const idx = list.findIndex(item => matchesWhere(item, args.where, store));
      if (idx !== -1) {
        const updated = {
          ...list[idx],
          ...args.update,
          updatedAt: new Date()
        };
        list[idx] = updated;
        let expanded = expandIncludes(modelName, updated, args.include, store);
        if (args.select) expanded = projectSelect(expanded, args.select);
        return expanded;
      } else {
        const record = {
          id: args.create.id || `${modelName}-${crypto.randomUUID()}`,
          ...args.create,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        list.push(record);
        let expanded = expandIncludes(modelName, record, args.include, store);
        if (args.select) expanded = projectSelect(expanded, args.select);
        return expanded;
      }
    },

    async delete(args: { where: any }) {
      const list = getList();
      const idx = list.findIndex(item => matchesWhere(item, args.where, store));
      if (idx === -1) {
        throw new Error(`Record to delete not found in ${modelName}`);
      }
      const deleted = list.splice(idx, 1)[0];
      return deleted;
    },

    async deleteMany(args?: { where?: any }) {
      const list = getList();
      const where = args?.where;
      if (!where || Object.keys(where).length === 0) {
        const count = list.length;
        list.length = 0;
        return { count };
      }
      let count = 0;
      for (let i = list.length - 1; i >= 0; i--) {
        if (matchesWhere(list[i], where, store)) {
          list.splice(i, 1);
          count++;
        }
      }
      return { count };
    },

    async count(args?: { where?: any }) {
      const list = getList();
      if (!args?.where) return list.length;
      return list.filter(item => matchesWhere(item, args.where, store)).length;
    }
  };
}

export function createInMemoryPrismaClient() {
  const store = globalStore;

  const client: any = {
    user: createModelAdapter('user', () => store.users, store),
    administrativeNode: createModelAdapter('administrativeNode', () => store.administrativeNodes, store),
    sensorNode: createModelAdapter('sensorNode', () => store.sensorNodes, store),
    reliefCenter: createModelAdapter('reliefCenter', () => store.reliefCenters, store),
    chatMessage: createModelAdapter('chatMessage', () => store.chatMessages, store),
    disasterAlert: createModelAdapter('disasterAlert', () => store.disasterAlerts, store),
    disasterIncident: createModelAdapter('disasterIncident', () => store.disasterIncidents, store),
    incidentUpdate: createModelAdapter('incidentUpdate', () => store.incidentUpdates, store),
    coordinationGroup: createModelAdapter('coordinationGroup', () => store.coordinationGroups, store),
    coordinationGroupMember: createModelAdapter('coordinationGroupMember', () => store.coordinationGroupMembers, store),
    volunteerProfile: createModelAdapter('volunteerProfile', () => store.volunteerProfiles, store),
    responseTask: createModelAdapter('responseTask', () => store.responseTasks, store),
    responseTaskAssignee: createModelAdapter('responseTaskAssignee', () => store.responseTaskAssignees, store),
    responseTaskUpdate: createModelAdapter('responseTaskUpdate', () => store.responseTaskUpdates, store),
    userNotification: createModelAdapter('userNotification', () => store.userNotifications, store),
    alertSubscription: createModelAdapter('alertSubscription', () => store.alertSubscriptions, store),
    incidentAttachment: createModelAdapter('incidentAttachment', () => store.incidentAttachments, store),
    shelterOccupancyUpdate: createModelAdapter('shelterOccupancyUpdate', () => store.shelterOccupancyUpdates, store),
    operationalAudit: createModelAdapter('operationalAudit', () => store.operationalAudits, store),
    responsePolicy: createModelAdapter('responsePolicy', () => store.responsePolicies, store),
    simulationRun: createModelAdapter('simulationRun', () => store.simulationRuns, store),

    async $disconnect() {
      return Promise.resolve();
    },

    async $queryRawUnsafe(query: string) {
      console.log('[InMemoryStore] Query executed:', query);
      return [];
    },

    async $executeRawUnsafe(query: string) {
      console.log('[InMemoryStore] Raw execute executed:', query);
      return 1;
    },

    async $transaction<T>(callback: (transaction: any) => Promise<T>): Promise<T> {
      const collections = [
        'users', 'administrativeNodes', 'sensorNodes', 'reliefCenters', 'chatMessages',
        'disasterAlerts', 'disasterIncidents', 'incidentUpdates', 'coordinationGroups',
        'coordinationGroupMembers', 'volunteerProfiles', 'responseTasks',
        'responseTaskAssignees', 'responseTaskUpdates', 'userNotifications',
        'alertSubscriptions', 'incidentAttachments', 'shelterOccupancyUpdates',
        'operationalAudits'
      ] as const;
      const snapshot = new Map<string, any[]>();
      for (const collection of collections) {
        snapshot.set(collection, structuredClone(store[collection]));
      }
      try {
        return await callback(client);
      } catch (error) {
        for (const collection of collections) {
          store[collection].splice(0, store[collection].length, ...(snapshot.get(collection) || []));
        }
        throw error;
      }
    }
  };

  return client;
}
