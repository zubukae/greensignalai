import { prisma } from '../lib/prisma';

export interface StockQuantityMap {
  beds: number;
  food_packs: number;
  medical_kits: number;
  vehicles: number;
  tents: number;
  [key: string]: number;
}

export interface BOQItem {
  itemName: string;
  unit: string;
  policyQty: number;
  currentQty: number;
  emergencyQty: number;
  restockingQty: number;
  estimatedUnitPriceBDT: number;
  totalRestockCostBDT: number;
}

export interface BOQReport {
  reliefCenterId: string;
  centerName: string;
  centerCode: string;
  generatedAt: string;
  items: BOQItem[];
  totalProjectedCostBDT: number;
}

export interface StockItemBreakdown {
  policy: number;
  current: number;
  emergency: number;
  restock: number;
}

export interface AggregatedStock {
  beds: StockItemBreakdown;
  food_packs: StockItemBreakdown;
  medical_kits: StockItemBreakdown;
  vehicles: StockItemBreakdown;
  tents: StockItemBreakdown;
  totals: {
    totalPolicy: number;
    totalCurrent: number;
    totalEmergency: number;
    totalRestock: number;
    fulfillmentRate: number;
  };
}

export interface UpazilaStockGroup {
  id: string;
  name: string;
  code: string;
  districtId: string;
  districtName: string;
  divisionId?: string;
  divisionName?: string;
  centersCount: number;
  reliefCenters: any[];
  stock: AggregatedStock;
}

export interface DistrictStockGroup {
  id: string;
  name: string;
  code: string;
  divisionId?: string;
  divisionName?: string;
  upazilasCount: number;
  centersCount: number;
  upazilas: UpazilaStockGroup[];
  reliefCenters: any[];
  stock: AggregatedStock;
}

export class CoordinatorDbService {
  /**
   * Helper to sum stock across an array of relief centers
   */
  static aggregateStockForCenters(centers: any[]): AggregatedStock {
    const items = ['beds', 'food_packs', 'medical_kits', 'vehicles', 'tents'];
    const res: any = {
      totals: {
        totalPolicy: 0,
        totalCurrent: 0,
        totalEmergency: 0,
        totalRestock: 0,
        fulfillmentRate: 100
      }
    };

    for (const item of items) {
      let p = 0, c = 0, e = 0, r = 0;
      for (const center of centers) {
        const policy = (center.stockPolicy as any)?.[item] || 0;
        const current = (center.currentStock as any)?.[item] || 0;
        const emerg = (center.emergencyRequirement as any)?.[item] || 0;
        const restock = (center.restockingRequirement as any)?.[item] || Math.max(0, policy - current);

        p += policy;
        c += current;
        e += emerg;
        r += restock;
      }
      res[item] = { policy: p, current: c, emergency: e, restock: r };
      res.totals.totalPolicy += p;
      res.totals.totalCurrent += c;
      res.totals.totalEmergency += e;
      res.totals.totalRestock += r;
    }

    res.totals.fulfillmentRate = res.totals.totalPolicy > 0
      ? Math.min(100, Math.round((res.totals.totalCurrent / res.totals.totalPolicy) * 100))
      : 100;

    return res;
  }

  /**
   * Fetch all relief centers and sensors within the coordinator's administrative scope,
   * organized hierarchically by Upazila, District, and Division.
   */
  static async getCoordinatorScopeData(userNodeId?: string) {
    let userNode = userNodeId ? await prisma.administrativeNode.findUnique({
      where: { id: userNodeId },
      include: {
        children: {
          include: {
            children: true
          }
        },
        parent: {
          include: {
            parent: true
          }
        }
      }
    }) : null;

    if (!userNode) {
      userNode = await prisma.administrativeNode.findFirst({
        where: { tier: 'DISTRICT' },
        include: {
          children: {
            include: {
              children: true
            }
          },
          parent: {
            include: {
              parent: true
            }
          }
        }
      });
    }

    if (!userNode) throw new Error('Coordinator administrative node not found.');

    // Collect all child node IDs in scope
    const scopedNodeIds: string[] = [userNode.id];

    if (userNode.tier === 'COUNTRY') {
      const allNodes = await prisma.administrativeNode.findMany();
      for (const n of allNodes) {
        if (!scopedNodeIds.includes(n.id)) {
          scopedNodeIds.push(n.id);
        }
      }
    } else if (userNode.children) {
      for (const child of userNode.children) {
        scopedNodeIds.push(child.id);
        if (child.children) {
          for (const grandChild of child.children) {
            scopedNodeIds.push(grandChild.id);
            if (grandChild.children) {
              for (const greatGrandChild of grandChild.children) {
                scopedNodeIds.push(greatGrandChild.id);
              }
            }
          }
        }
      }
    }

    // Fetch relief centers and sensors for all nodes in scope with full parent lineage
    const reliefCenters = await prisma.reliefCenter.findMany({
      where: { districtNodeId: { in: scopedNodeIds } },
      include: {
        districtNode: {
          include: {
            parent: {
              include: {
                parent: true
              }
            }
          }
        }
      },
      orderBy: { name: 'asc' }
    });

    const sensors = await prisma.sensorNode.findMany({
      where: { districtNodeId: { in: scopedNodeIds } },
      include: {
        districtNode: {
          include: {
            parent: {
              include: {
                parent: true
              }
            }
          }
        }
      }
    });

    const coordinatorContact = await prisma.user.findFirst({
      where: { districtNodeId: userNode?.id, role: 'COORDINATOR' },
      select: { fullName: true, phone: true, username: true }
    });

    // Grouping by Upazila
    const upazilaMap = new Map<string, {
      id: string;
      name: string;
      code: string;
      districtId: string;
      districtName: string;
      divisionId?: string;
      divisionName?: string;
      reliefCenters: any[];
    }>();

    // Grouping by District
    const districtMap = new Map<string, {
      id: string;
      name: string;
      code: string;
      divisionId?: string;
      divisionName?: string;
      upazilaMap: Map<string, any>;
      reliefCenters: any[];
    }>();

    for (const rc of reliefCenters) {
      const node = rc.districtNode;
      let upzId = node.id;
      let upzName = node.name;
      let upzCode = node.code || '';

      let distId = node.id;
      let distName = node.name;
      let distCode = node.code || '';

      let divId = '';
      let divName = '';

      if (node.tier === 'UPAZILA') {
        upzId = node.id;
        upzName = node.name;
        if (node.parent) {
          distId = node.parent.id;
          distName = node.parent.name;
          distCode = node.parent.code || '';
          if (node.parent.parent) {
            divId = node.parent.parent.id;
            divName = node.parent.parent.name;
          }
        }
      } else if (node.tier === 'DISTRICT') {
        distId = node.id;
        distName = node.name;
        distCode = node.code || '';
        if (node.parent) {
          divId = node.parent.id;
          divName = node.parent.name;
        }
      }

      // Add to Upazila Map
      if (!upazilaMap.has(upzId)) {
        upazilaMap.set(upzId, {
          id: upzId,
          name: upzName,
          code: upzCode,
          districtId: distId,
          districtName: distName,
          divisionId: divId,
          divisionName: divName,
          reliefCenters: []
        });
      }
      upazilaMap.get(upzId)!.reliefCenters.push(rc);

      // Add to District Map
      if (!districtMap.has(distId)) {
        districtMap.set(distId, {
          id: distId,
          name: distName,
          code: distCode,
          divisionId: divId,
          divisionName: divName,
          upazilaMap: new Map(),
          reliefCenters: []
        });
      }
      const distEntry = districtMap.get(distId)!;
      distEntry.reliefCenters.push(rc);
      if (!distEntry.upazilaMap.has(upzId)) {
        distEntry.upazilaMap.set(upzId, upazilaMap.get(upzId)!);
      }
    }

    const upazilas: UpazilaStockGroup[] = Array.from(upazilaMap.values()).map(u => ({
      id: u.id,
      name: u.name,
      code: u.code,
      districtId: u.districtId,
      districtName: u.districtName,
      divisionId: u.divisionId,
      divisionName: u.divisionName,
      centersCount: u.reliefCenters.length,
      reliefCenters: u.reliefCenters,
      stock: CoordinatorDbService.aggregateStockForCenters(u.reliefCenters)
    })).sort((a, b) => a.name.localeCompare(b.name));

    const districts: DistrictStockGroup[] = Array.from(districtMap.values()).map(d => {
      const distUpazilas = Array.from(d.upazilaMap.values()).map(u => ({
        id: u.id,
        name: u.name,
        code: u.code,
        districtId: u.districtId,
        districtName: u.districtName,
        divisionId: u.divisionId,
        divisionName: u.divisionName,
        centersCount: u.reliefCenters.length,
        reliefCenters: u.reliefCenters,
        stock: CoordinatorDbService.aggregateStockForCenters(u.reliefCenters)
      })).sort((a, b) => a.name.localeCompare(b.name));

      return {
        id: d.id,
        name: d.name,
        code: d.code,
        divisionId: d.divisionId,
        divisionName: d.divisionName,
        upazilasCount: distUpazilas.length,
        centersCount: d.reliefCenters.length,
        upazilas: distUpazilas,
        reliefCenters: d.reliefCenters,
        stock: CoordinatorDbService.aggregateStockForCenters(d.reliefCenters)
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const totalStock = CoordinatorDbService.aggregateStockForCenters(reliefCenters);

    return {
      tier: userNode.tier as 'DIVISION' | 'DISTRICT' | 'UPAZILA',
      scopeNode: userNode,
      reliefCenters,
      sensors,
      upazilas,
      districts,
      totalStock,
      coordinatorContact
    };
  }

  /**
   * Update relief center stock policy, current stock, and emergency requirements.
   * Automatically calculates restockingRequirement = stockPolicy - currentStock
   */
  static async updateReliefCenterStock(
    centerId: string,
    stockPolicy: StockQuantityMap,
    currentStock: StockQuantityMap,
    emergencyRequirement: StockQuantityMap
  ) {
    // Compute restocking requirement delta
    const restockingRequirement: StockQuantityMap = {
      beds: Math.max(0, (stockPolicy.beds || 0) - (currentStock.beds || 0)),
      food_packs: Math.max(0, (stockPolicy.food_packs || 0) - (currentStock.food_packs || 0)),
      medical_kits: Math.max(0, (stockPolicy.medical_kits || 0) - (currentStock.medical_kits || 0)),
      vehicles: Math.max(0, (stockPolicy.vehicles || 0) - (currentStock.vehicles || 0)),
      tents: Math.max(0, (stockPolicy.tents || 0) - (currentStock.tents || 0))
    };

    return await prisma.reliefCenter.update({
      where: { id: centerId },
      data: {
        stockPolicy: stockPolicy as any,
        currentStock: currentStock as any,
        emergencyRequirement: emergencyRequirement as any,
        restockingRequirement: restockingRequirement as any
      }
    });
  }

  /**
   * Generate Bill of Quantities (BOQ) for procurement & restocking
   */
  static async generateBOQ(centerId: string): Promise<BOQReport> {
    let center = centerId ? await prisma.reliefCenter.findUnique({
      where: { id: centerId }
    }) : null;

    if (!center) {
      center = await prisma.reliefCenter.findFirst();
    }

    if (!center) throw new Error('Relief center not found');

    const policy = (center.stockPolicy as unknown as StockQuantityMap) || {};
    const current = (center.currentStock as unknown as StockQuantityMap) || {};
    const emergency = (center.emergencyRequirement as unknown as StockQuantityMap) || {};
    const restock = (center.restockingRequirement as unknown as StockQuantityMap) || {};

    const priceCatalog: Record<string, { unit: string; price: number }> = {
      beds: { unit: 'Units', price: 3500 },
      food_packs: { unit: 'Packs', price: 1200 },
      medical_kits: { unit: 'Kits', price: 4500 },
      vehicles: { unit: 'Rental/Day', price: 15000 },
      tents: { unit: 'Units', price: 8500 }
    };

    const items: BOQItem[] = Object.keys(priceCatalog).map(key => {
      const pQty = policy[key] || 0;
      const cQty = current[key] || 0;
      const eQty = emergency[key] || 0;
      const rQty = restock[key] || Math.max(0, pQty - cQty);
      const unitPrice = priceCatalog[key].price;

      return {
        itemName: key.replace('_', ' ').toUpperCase(),
        unit: priceCatalog[key].unit,
        policyQty: pQty,
        currentQty: cQty,
        emergencyQty: eQty,
        restockingQty: rQty,
        estimatedUnitPriceBDT: unitPrice,
        totalRestockCostBDT: rQty * unitPrice
      };
    });

    const totalProjectedCostBDT = items.reduce((sum, item) => sum + item.totalRestockCostBDT, 0);

    return {
      reliefCenterId: center.id,
      centerName: center.name,
      centerCode: center.centerCode,
      generatedAt: new Date().toISOString(),
      items,
      totalProjectedCostBDT
    };
  }

  /**
   * Generate Bill of Quantities (BOQ) for an entire administrative scope (Upazila, District, or Division)
   */
  static async generateScopeBOQ(type: 'UPAZILA' | 'DISTRICT' | 'DIVISION', targetId: string) {
    const scopeData = await this.getCoordinatorScopeData(targetId);
    let centers = scopeData.reliefCenters;

    if (type === 'UPAZILA') {
      const upz = scopeData.upazilas.find(u => u.id === targetId);
      if (upz) centers = upz.reliefCenters;
    } else if (type === 'DISTRICT') {
      const dist = scopeData.districts.find(d => d.id === targetId);
      if (dist) centers = dist.reliefCenters;
    }

    const priceCatalog: Record<string, { unit: string; price: number }> = {
      beds: { unit: 'Units', price: 3500 },
      food_packs: { unit: 'Packs', price: 1200 },
      medical_kits: { unit: 'Kits', price: 4500 },
      vehicles: { unit: 'Rental/Day', price: 15000 },
      tents: { unit: 'Units', price: 8500 }
    };

    const aggregated = CoordinatorDbService.aggregateStockForCenters(centers);

    const items: BOQItem[] = Object.keys(priceCatalog).map(key => {
      const itemStock = (aggregated as any)[key] || { policy: 0, current: 0, emergency: 0, restock: 0 };
      const unitPrice = priceCatalog[key].price;
      const totalCost = itemStock.restock * unitPrice;

      return {
        itemName: key.replace('_', ' ').toUpperCase(),
        unit: priceCatalog[key].unit,
        policyQty: itemStock.policy,
        currentQty: itemStock.current,
        emergencyQty: itemStock.emergency,
        restockingQty: itemStock.restock,
        estimatedUnitPriceBDT: unitPrice,
        totalRestockCostBDT: totalCost
      };
    });

    const totalProjectedCostBDT = items.reduce((sum, item) => sum + item.totalRestockCostBDT, 0);

    return {
      scopeType: type,
      scopeName: scopeData.scopeNode.name,
      scopeCode: scopeData.scopeNode.code || targetId,
      totalCenters: centers.length,
      generatedAt: new Date().toISOString(),
      items,
      totalProjectedCostBDT,
      fulfillmentRate: aggregated.totals.fulfillmentRate
    };
  }
}