import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const KNOWN_CONTRACTS = [
  {
    address: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    name: 'StellarSwap Router',
    description: 'StellarSwap AMM router contract',
    abi: {
      functions: [
        {
          name: 'swap',
          inputs: [
            { name: 'sender', type: 'address' },
            { name: 'amount_in', type: 'i128' },
            { name: 'amount_out_min', type: 'i128' },
            { name: 'token_in', type: 'address' },
            { name: 'token_out', type: 'address' },
            { name: 'deadline', type: 'u64' },
          ],
          humanTemplate: '{sender} swapped {amount_in} → {amount_out_min} (min) on StellarSwap',
        },
        {
          name: 'add_liquidity',
          inputs: [
            { name: 'sender', type: 'address' },
            { name: 'token_a', type: 'address' },
            { name: 'token_b', type: 'address' },
            { name: 'amount_a', type: 'i128' },
            { name: 'amount_b', type: 'i128' },
          ],
          humanTemplate: '{sender} added liquidity ({amount_a} + {amount_b}) on StellarSwap',
        },
      ],
    },
  },
];

async function main() {
  for (const c of KNOWN_CONTRACTS) {
    await prisma.contract.upsert({
      where: { address: c.address },
      update: { name: c.name, description: c.description, abi: c.abi },
      create: c,
    });
    console.log(`Seeded contract: ${c.name}`);
  }
  console.log('Seed complete.');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
