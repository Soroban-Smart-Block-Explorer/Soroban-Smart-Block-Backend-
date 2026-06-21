import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db';
import { ChannelManager } from '../feed/channelManager';

const router = Router();

const backfillSchema = z.object({
  channelName: z.string(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime(),
  format: z.enum(['jsonl', 'csv', 'parquet', 'arrow', 'json']),
  filters: z.any().optional(),
  compression: z.enum(['none', 'gzip', 'brotli']).optional(),
  callbackUrl: z.string().url().optional(),
});

// POST /api/v1/feed/backfill - Request historical data
router.post('/', async (req, res) => {
  try {
    const validatedData = backfillSchema.parse(req.body);

    // Validate channel exists
    if (!ChannelManager.isValidChannel(validatedData.channelName)) {
      return res.status(400).json({ error: 'Invalid channel name' });
    }

    // Validate date range
    const startTime = new Date(validatedData.startTime);
    const endTime = new Date(validatedData.endTime);

    if (startTime >= endTime) {
      return res.status(400).json({ error: 'Start time must be before end time' });
    }

    // Check if range is within limits (max 90 days)
    const maxDays = 90;
    const diffDays = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);

    if (diffDays > maxDays) {
      return res.status(400).json({
        error: `Date range exceeds maximum of ${maxDays} days`,
      });
    }

    const userId = req.headers['x-user-id'] as string;

    const backfillRequest = await prisma.backfillRequest.create({
      data: {
        userId,
        channelName: validatedData.channelName,
        startTime,
        endTime,
        format: validatedData.format,
        filters: validatedData.filters,
        status: 'pending',
      },
    });

    // Queue backfill job (in real implementation, this would use a job queue)
    processBackfillRequest(backfillRequest.id).catch(console.error);

    res.status(202).json({
      requestId: backfillRequest.id,
      status: backfillRequest.status,
      estimatedCompletionTime: getEstimatedCompletionTime(validatedData.channelName, diffDays),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid request data', details: error.errors });
    }
    console.error('Failed to create backfill request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/feed/backfill/:requestId - Check backfill status and download URL
router.get('/:requestId', async (req, res) => {
  try {
    const request = await prisma.backfillRequest.findUnique({
      where: { id: req.params.requestId },
    });

    if (!request) {
      return res.status(404).json({ error: 'Backfill request not found' });
    }

    const response: any = {
      requestId: request.id,
      channelName: request.channelName,
      startTime: request.startTime,
      endTime: request.endTime,
      format: request.format,
      status: request.status,
      progress: request.progress,
      createdAt: request.createdAt,
    };

    if (request.status === 'completed') {
      response.downloadUrl = request.fileUrl;
      response.fileSizeBytes = request.fileSizeBytes;
      response.recordCount = request.recordCount;
      response.completedAt = request.completedAt;
    } else if (request.status === 'failed') {
      response.errorMessage = request.errorMessage;
    }

    res.json(response);
  } catch (error) {
    console.error('Failed to fetch backfill request:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/feed/backfill - List user's backfill requests
router.get('/', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const offset = (page - 1) * limit;

    const requests = await prisma.backfillRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      select: {
        id: true,
        channelName: true,
        startTime: true,
        endTime: true,
        format: true,
        status: true,
        progress: true,
        fileSizeBytes: true,
        recordCount: true,
        createdAt: true,
        completedAt: true,
      },
    });

    const total = await prisma.backfillRequest.count({
      where: { userId },
    });

    res.json({
      requests,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Failed to fetch backfill requests:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/v1/feed/backfill/limits - Get backfill limits
router.get('/limits', (req, res) => {
  res.json({
    maxRangeDays: 90,
    maxFileSizeBytes: 1024 * 1024 * 1024, // 1GB
    maxRecords: 10000000, // 10M records
    rateLimitPerDay: 10,
    supportedFormats: ['jsonl', 'csv', 'parquet', 'arrow', 'json'],
    supportedCompression: ['none', 'gzip', 'brotli'],
  });
});

async function processBackfillRequest(requestId: string) {
  try {
    // Update status to processing
    await prisma.backfillRequest.update({
      where: { id: requestId },
      data: { status: 'processing', progress: 0 },
    });

    const request = await prisma.backfillRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) return;

    // Simulate data export process
    const totalSteps = 100;

    for (let step = 1; step <= totalSteps; step++) {
      // Simulate processing time
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Update progress
      const progress = (step / totalSteps) * 100;
      await prisma.backfillRequest.update({
        where: { id: requestId },
        data: { progress },
      });
    }

    // Generate mock file URL and metadata
    const fileUrl = `https://api.example.com/downloads/${requestId}.${request.format}`;
    const recordCount = await getRecordCount(
      request.channelName,
      request.startTime,
      request.endTime,
    );
    const fileSizeBytes = estimateFileSize(recordCount, request.format);

    await prisma.backfillRequest.update({
      where: { id: requestId },
      data: {
        status: 'completed',
        progress: 100,
        fileUrl,
        fileSizeBytes,
        recordCount,
        completedAt: new Date(),
      },
    });

    // Send callback if provided
    if (
      request.filters &&
      typeof request.filters === 'object' &&
      request.filters !== null &&
      'callbackUrl' in request.filters
    ) {
      // TODO: Send completion callback
    }
  } catch (error) {
    console.error(`Backfill processing failed for ${requestId}:`, error);

    await prisma.backfillRequest.update({
      where: { id: requestId },
      data: {
        status: 'failed',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      },
    });
  }
}

async function getRecordCount(
  channelName: string,
  startTime: Date,
  endTime: Date,
): Promise<number> {
  // In real implementation, this would query the actual data tables
  const mockCounts: Record<string, number> = {
    transactions: 100000,
    events: 500000,
    ledgers: 10000,
    trades: 50000,
    metrics: 5000,
  };

  const baseCount = mockCounts[channelName] || 10000;
  const daysDiff = (endTime.getTime() - startTime.getTime()) / (1000 * 60 * 60 * 24);
  return Math.round((baseCount * daysDiff) / 30); // Scale by month
}

function estimateFileSize(recordCount: number, format: string): number {
  const bytesPerRecord: Record<string, number> = {
    jsonl: 800, // JSON is verbose
    csv: 200, // CSV is compact
    parquet: 100, // Parquet is highly compressed
    arrow: 150, // Arrow is efficient
    json: 900, // JSON array format
  };

  return recordCount * (bytesPerRecord[format] || 300);
}

function getEstimatedCompletionTime(channelName: string, daysDiff: number): string {
  const baseMinutes = Math.max(1, Math.round(daysDiff / 10)); // 1 minute per 10 days
  const completionTime = new Date();
  completionTime.setMinutes(completionTime.getMinutes() + baseMinutes);
  return completionTime.toISOString();
}

export default router;
