import '../config'; // load env
import { archiveRawXdr } from './archiver';
import { logger } from '../logger';

archiveRawXdr()
  .then((r) => {
    logger.info('[Archiver] Completed:', r);
    process.exit(0);
  })
  .catch((err) => {
    logger.error('[Archiver] Fatal:', err);
    process.exit(1);
  });
