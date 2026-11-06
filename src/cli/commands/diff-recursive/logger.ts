import { getLogger, type ConsoleLogger } from '../../../utils/logger.js';

/** The `DiffRecursive` child logger, created once and shared by every module of the walk. */
export const logger: ConsoleLogger = getLogger().child('DiffRecursive');
