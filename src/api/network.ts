import { Router, Request, Response } from 'express';
import { config } from '../config';

/**
 * @swagger
 * tags:
 *   name: Network
 *   description: Active Stellar network configuration
 */

export const networkRouter = Router();

/**
 * @swagger
 * /api/v1/network:
 *   get:
 *     summary: Get active network configuration
 *     description: Returns the current network profile (testnet / mainnet / devnet) and RPC connection details.
 *     tags: [Network]
 *     responses:
 *       200:
 *         description: Active network info
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 network:
 *                   type: string
 *                   description: Active network name
 *                   example: testnet
 *                 rpcUrl:
 *                   type: string
 *                   description: Soroban RPC endpoint
 *                   example: https://soroban-testnet.stellar.org
 *                 passphrase:
 *                   type: string
 *                   description: Stellar network passphrase
 *                   example: Test SDF Network ; September 2015
 *                 indexerStartLedger:
 *                   type: integer
 *                   description: Ledger sequence the indexer started from
 *                   example: 0
 */
networkRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    network: config.stellarNetwork,
    rpcUrl: config.stellarRpcUrl,
    passphrase: config.networkPassphrase,
    indexerStartLedger: config.indexerStartLedger,
  });
});
