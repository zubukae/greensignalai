import { PrismaClient, Role, NodeTier, SensorType, NodeStatus, PolicyStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import bcrypt from 'bcryptjs';
import { generateSensorTimeSeries } from '../src/services/sensorTimeSeries';

const prisma = new PrismaClient();

interface CSVRow {
  division: string;
  district: string;
  upazila: string;
  lat: number;
  lng: number;
  worker: string;
  citizen: string;
  coordinator: string;
  planner: string;
  sensorCodeBase: string;
  centerCodeBase: string;
}

// Helper to sanitize text
function sanitizeName(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function createCode(prefix: string, name: string): string {
  const clean = name.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `${prefix}-${clean}`;
}

// Robust CSV parser that handles internal commas (e.g. within quotes like "24.83, 89.04")
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

function parseCSV(): CSVRow[] {
  const basePath = process.cwd();
  const csvPath = path.join(basePath, 'upazilla lat long - Sheet1.csv');

  if (!fs.existsSync(csvPath)) {
    console.warn(`⚠️ CSV file not found at ${csvPath}.`);
    return [];
  }

  const lines = fs.readFileSync(csvPath, 'utf-8').split(/\r?\n/).filter(line => line.trim().length > 0);
  const rows: CSVRow[] = [];
  
  let currentDiv = '';
  let currentDist = '';

  // Skip header (index 0)
  for (let i = 1; i < lines.length; i++) {
    const parts = parseCSVLine(lines[i]);
    if (parts.length < 10) continue;

    const rawDiv = parts[0]?.trim();
    const rawDist = parts[1]?.trim();
    const rawUpz = parts[2]?.trim();
    const rawLatLong = parts[3]?.trim();
    const worker = parts[4]?.trim();
    const citizen = parts[5]?.trim();
    const coordinator = parts[6]?.trim(); // Handles the 'Coordinator ' column
    const planner = parts[7]?.trim();
    const sensors = parts[8]?.trim();
    const centers = parts[9]?.trim();

    // Carry forward division/district for blank cells (forward-fill)
    if (rawDiv) currentDiv = rawDiv;
    if (rawDist) currentDist = rawDist.replace(/\s+District$/i, '');

    if (!rawUpz) continue;

    const upzClean = rawUpz.replace(/^\d+\.\s*/, '').replace(/\s+Upazila$/i, '').trim();
    
    let lat = 23.8103;
    let lng = 90.4125;
    if (rawLatLong) {
      const coords = rawLatLong.split(',').map(s => parseFloat(s.trim()));
      if (coords.length >= 2 && !isNaN(coords[0]) && !isNaN(coords[1])) {
        lat = coords[0];
        lng = coords[1];
      }
    }

    rows.push({
      division: sanitizeName(currentDiv),
      district: sanitizeName(currentDist),
      upazila: sanitizeName(upzClean),
      lat,
      lng,
      worker,
      citizen,
      coordinator,
      planner,
      sensorCodeBase: sensors,
      centerCodeBase: centers
    });
  }

  return rows;
}

// User Creation Hash Cache
const hashCache = new Map<string, string>();
const getPasswordHash = (username: string): string => {
  if (!hashCache.has(username)) {
    hashCache.set(username, bcrypt.hashSync(username, 10));
  }
  return hashCache.get(username)!;
};

// Safe User Upsert Helper
async function upsertUser(username: string, role: Role, nodeId: string) {
  if (!username) return;
  const cleanUser = username.toLowerCase().replace(/[^a-z0-9]/g, '');
  const email = `${cleanUser}@dmr.bd.gov`;

  await prisma.user.upsert({
    where: { username },
    update: { districtNodeId: nodeId, role },
    create: {
      username,
      email,
      passwordHash: getPasswordHash(username),
      fullName: username,
      role,
      districtNodeId: nodeId
    }
  });
}

async function main() {
  console.log('🌱 Starting Database Seeding Process...');

  await prisma.simulationRun.deleteMany();
  await prisma.responsePolicy.deleteMany();
  await prisma.chatMessage.deleteMany();
  await prisma.disasterAlert.deleteMany();
  await prisma.sensorNode.deleteMany();
  await prisma.reliefCenter.deleteMany();
  await prisma.administrativeNode.deleteMany();
  console.log('🧹 Cleaned existing database tables (excluding users).');
  
  const countryNode = await prisma.administrativeNode.create({
    data: {
      name: 'Bangladesh National Command',
      tier: NodeTier.COUNTRY,
      code: 'BD-HQ',
      latitude: 23.8103,
      longitude: 90.4125
    }
  });

  const csvData = parseCSV();
  console.log(`📊 Parsed ${csvData.length} Upazilas from CSV.`);

  const divisionMap = new Map<string, string>();
  const districtMap = new Map<string, string>();
  
  // Track roles strictly to satisfy routing rules
  const divisionCoordinators = new Set<string>();
  const districtCoordinators = new Set<string>();
  const districtPlanners = new Set<string>();

  for (const row of csvData) {
    // 1. Ensure Division Node
    if (!divisionMap.has(row.division)) {
      const divNode = await prisma.administrativeNode.create({
        data: {
          name: row.division,
          tier: NodeTier.DIVISION,
          code: createCode('DIV', row.division),
          parentId: countryNode.id,
          latitude: row.lat,
          longitude: row.lng
        }
      });
      divisionMap.set(row.division, divNode.id);
    }
    const divId = divisionMap.get(row.division)!;

    // 2. Ensure District Node
    const distKey = `${row.division}|${row.district}`;
    if (!districtMap.has(distKey)) {
      const distNode = await prisma.administrativeNode.create({
        data: {
          name: row.district,
          tier: NodeTier.DISTRICT,
          code: createCode('DST', `${row.division}-${row.district}`),
          parentId: divId,
          latitude: row.lat,
          longitude: row.lng
        }
      });
      districtMap.set(distKey, distNode.id);
    }
    const distId = districtMap.get(distKey)!;

    // 3. Create Upazila Node
    const upzNode = await prisma.administrativeNode.create({
      data: {
        name: row.upazila,
        tier: NodeTier.UPAZILA,
        code: createCode('UPZ', `${row.district}-${row.upazila}`),
        parentId: distId,
        latitude: row.lat,
        longitude: row.lng
      }
    });

    // ----------------------------------------------------
    // --- USERS SEEDING BASED ON SPECIFIC COLUMN RULES ---
    // ----------------------------------------------------

    // Workers & Citizens (Assigned to Upazila directly)
    if (row.worker) await upsertUser(row.worker, Role.WORKER, upzNode.id);
    if (row.citizen) await upsertUser(row.citizen, Role.CITIZEN, upzNode.id);

    // Planner: Only the FIRST planner per district is processed. The rest are ignored.
    if (row.planner && !districtPlanners.has(row.district)) {
      await upsertUser(row.planner, Role.PLANNER, distId);
      districtPlanners.add(row.district);
    }

    // Coordinator Distribution:
    if (row.coordinator) {
      if (!divisionCoordinators.has(row.division)) {
        // First coordinator of Division -> Becomes Division Coordinator
        await upsertUser(row.coordinator, Role.COORDINATOR, divId);
        divisionCoordinators.add(row.division);
      } else if (!districtCoordinators.has(row.district)) {
        // First coordinator of District -> Becomes District Coordinator
        await upsertUser(row.coordinator, Role.COORDINATOR, distId);
        districtCoordinators.add(row.district);
      } else {
        // Remaining Coordinators -> Upazila Coordinators
        await upsertUser(row.coordinator, Role.COORDINATOR, upzNode.id);
      }
    }

    // ----------------------------------------------------
    // --- HARDWARE & RELIEF CENTER SEEDING ---
    // ----------------------------------------------------
    const sensorTypes: ('WATER' | 'WIND' | 'SALINITY' | 'SEISMOGRAPH' | 'RAINFALL')[] = [
      'WATER',
      'WIND',
      'SALINITY',
      'SEISMOGRAPH',
      'RAINFALL'
    ];
    
    // Safety fallback for base codes if CSV columns are missing
    const baseSensorCode = row.sensorCodeBase || `SN-${row.district}-${row.upazila}`;
    const baseCenterCode = row.centerCodeBase || `RC-${row.district}-${row.upazila}`;

    for (const sType of sensorTypes) {
      const sCode = `${baseSensorCode}-${sType}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
      const tsPkg = generateSensorTimeSeries(sType, row.district, row.upazila, row.division);

      await (prisma.sensorNode as any).upsert({
        where: { sensorCode: sCode },
        update: {
          metricValue: tsPkg.metricValue,
          currentValue: tsPkg.currentValue,
          unit: tsPkg.unit,
          warningThreshold: tsPkg.warningThreshold,
          dangerThreshold: tsPkg.dangerThreshold,
          timeSeries: tsPkg.timeSeries as any,
          forecastSeries: tsPkg.forecastSeries as any,
          analytics: tsPkg.analytics as any,
          status: NodeStatus.ACTIVE,
          lastPing: new Date()
        },
        create: {
          sensorCode: sCode,
          districtNodeId: upzNode.id,
          type: sType as any,
          latitude: row.lat + (Math.random() - 0.5) * 0.02,
          longitude: row.lng + (Math.random() - 0.5) * 0.02,
          metricValue: tsPkg.metricValue,
          currentValue: tsPkg.currentValue,
          unit: tsPkg.unit,
          warningThreshold: tsPkg.warningThreshold,
          dangerThreshold: tsPkg.dangerThreshold,
          timeSeries: tsPkg.timeSeries as any,
          forecastSeries: tsPkg.forecastSeries as any,
          analytics: tsPkg.analytics as any,
          status: NodeStatus.ACTIVE,
          lastPing: new Date()
        }
      });
    }

    const rcCode = baseCenterCode.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    await prisma.reliefCenter.upsert({
      where: { centerCode: rcCode },
      update: {},
      create: {
        centerCode: rcCode,
        name: `${row.upazila} Primary Relief Shelter`,
        districtNodeId: upzNode.id,
        latitude: row.lat,
        longitude: row.lng,
        capacity: 1000,
        occupancy: 150,
        contactNum: null,
        isOperational: true,
        stockPolicy: { beds: 600, food_packs: 1200, medical_kits: 300, vehicles: 6, tents: 80 },
        currentStock: { beds: 420, food_packs: 850, medical_kits: 180, vehicles: 4, tents: 50 },
        emergencyRequirement: { beds: 80, food_packs: 200, medical_kits: 50, vehicles: 2, tents: 20 },
        restockingRequirement: { beds: 180, food_packs: 350, medical_kits: 120, vehicles: 2, tents: 30 }
      }
    });
  }

  // Seed System Master Admin Account
  await upsertUser('Admin', Role.ADMIN, countryNode.id);

  // Seed Baseline Response Policy
  await prisma.responsePolicy.create({
    data: {
      name: 'Cost-Minimized Pre-positioning v1',
      description: 'National baseline optimization strategy balancing transport cost against unmet demand penalties.',
      tierScope: NodeTier.COUNTRY,
      status: PolicyStatus.ACTIVE,
      triggers: { min_rainfall_24h_mm: 100.0, river_level_above_danger_m: 0.5, predicted_path_probability: 0.70 },
      allocationRules: { food_packs_per_person_per_day: 1.0, water_liters_per_person_per_day: 3.0, medical_kits_per_100_people: 1.0, hub_safety_stock_percent: 20 },
      priorityWeights: { vulnerability_score_weight: 0.35, affected_population_weight: 0.30, lead_time_proximity_weight: 0.20, shelter_capacity_utilization_weight: 0.15 },
      costParameters: { transport_cost_per_km_ton: 45.0, warehouse_holding_cost_per_day: 5.0, unmet_demand_penalty_per_person: 1500.0 }
    }
  });

  console.log(`✅ Seeding Completed Successfully!`);
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed with error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
