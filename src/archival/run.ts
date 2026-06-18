import '../config'; // load env
import { archiveRawXdr } from './archiver';

archiveRawXdr()
  .then((r) => {
    console.log('[Archiver] Completed:', r);
    process.exit(0);
  })
  .catch((err) => {
    console.error('[Archiver] Fatal:', err);
    process.exit(1);
  });
