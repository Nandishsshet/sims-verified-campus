'use strict';
// Must be required BEFORE any src/ module: src/config/env.js freezes process.env at load time.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-secret-test-secret-test-secret-123';
process.env.BCRYPT_ROUNDS = '4';          // fast hashing in tests
process.env.TRUST_PROXY = '1';            // lets tests simulate different client IPs via X-Forwarded-For
process.env.KEY_MAX_FAILED_ATTEMPTS = '5';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgresql://nobody:nobody@127.0.0.1:1/unused';
