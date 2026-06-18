import { NetworkName, NetworkProfile } from '../profiles';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      network: NetworkName;
      networkProfile: NetworkProfile;
      coldStorage?: {
        enabled: boolean;
        type: string;
        path?: string;
        ledgerSeq: number;
      };
    }
  }
}
