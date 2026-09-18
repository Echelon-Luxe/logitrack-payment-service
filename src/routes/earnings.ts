import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';

const DriverParams = z.object({ driverId: z.string().min(1) });
const ShipmentParams = z.object({ shipmentId: z.string().uuid() });
const ListQuery = z.object({
  status: z.enum(['PENDING', 'PAID', 'VOID']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
});

export async function earningRoutes(app: FastifyInstance): Promise<void> {
  // A driver's earnings, plus the totals the UI would otherwise compute by
  // summing a truncated page and getting it wrong.
  app.get('/earnings/driver/:driverId', async (req) => {
    const { driverId } = DriverParams.parse(req.params);
    const { status, limit } = ListQuery.parse(req.query);

    const earnings = await prisma.earning.findMany({
      where: { driverId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Grouped in the database, over every row rather than the page above.
    const grouped = await prisma.earning.groupBy({
      by: ['status'],
      where: { driverId },
      _sum: { amount: true },
      _count: { _all: true },
    });

    const totals = { pending: 0, paid: 0, void: 0 };
    for (const g of grouped) {
      const key = g.status.toLowerCase() as keyof typeof totals;
      totals[key] = g._sum.amount ?? 0;
    }

    return {
      driverId,
      // Kobo, like every other amount in this service.
      currency: earnings[0]?.currency ?? 'NGN',
      totals,
      count: grouped.reduce((n, g) => n + g._count._all, 0),
      earnings,
    };
  });

  app.get('/earnings/shipment/:shipmentId', async (req, reply) => {
    const { shipmentId } = ShipmentParams.parse(req.params);
    const earning = await prisma.earning.findUnique({ where: { shipmentId } });
    if (!earning) return reply.code(404).send({ error: 'No earning for that shipment' });
    return earning;
  });
}
