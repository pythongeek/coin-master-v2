/**
 * ts-node setup file loaded via --require flag BEFORE any test imports.
 * Installs mocks at the Module.prototype.require level so that all
 * downstream imports pick up the mocked db, redis, server-seed, etc.
 */

import Module from 'module';
import {
  installCommonMocks,
} from './helpers/test-mocks';

// Install once. The mockQuery / mockDb are created internally.
installCommonMocks();

// Note: Tests should call resetAllMocks() at the start of their setup to
// clear shared state between scenarios.