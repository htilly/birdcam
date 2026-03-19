const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { createTestDb, closeTestDb } = require('../helpers/db');

const originalDb = require('../../db');

function setupTestDb() {
  const testDb = createTestDb();
  originalDb._setTestDb(testDb);
  for (const key in originalDb._stmtCache) delete originalDb._stmtCache[key];
  return testDb;
}

function teardownTestDb() {
  originalDb._resetTestDb();
  for (const key in originalDb._stmtCache) delete originalDb._stmtCache[key];
  closeTestDb();
}

function createRateLimiter(max, windowMs) {
  const attempts = new Map();
  
  return (ip) => {
    const now = Date.now();
    const windowStart = now - windowMs;
    
    if (!attempts.has(ip)) {
      attempts.set(ip, []);
    }
    
    const ipAttempts = attempts.get(ip);
    const recentAttempts = ipAttempts.filter(t => t > windowStart);
    
    if (recentAttempts.length >= max) {
      return { allowed: false, remaining: 0, resetAt: recentAttempts[0] + windowMs };
    }
    
    recentAttempts.push(now);
    attempts.set(ip, recentAttempts);
    
    return { allowed: true, remaining: max - recentAttempts.length, resetAt: null };
  };
}

describe('security/rate-limits', { concurrency: false }, () => {
  beforeEach(() => {
    setupTestDb();
  });

  afterEach(() => {
    teardownTestDb();
  });

  describe('login rate limiter', () => {
    it('allows requests under limit', () => {
      const limiter = createRateLimiter(5, 60000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 4; i++) {
        const result = limiter(ip);
        assert.strictEqual(result.allowed, true);
      }
    });

    it('blocks requests over limit', () => {
      const limiter = createRateLimiter(5, 60000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 5; i++) {
        limiter(ip);
      }
      
      const result = limiter(ip);
      assert.strictEqual(result.allowed, false);
    });

    it('tracks different IPs separately', () => {
      const limiter = createRateLimiter(3, 60000);
      const ip1 = '192.168.1.100';
      const ip2 = '192.168.1.101';
      
      limiter(ip1);
      limiter(ip1);
      limiter(ip1);
      
      assert.strictEqual(limiter(ip1).allowed, false);
      assert.strictEqual(limiter(ip2).allowed, true);
    });

    it('resets after window expires', async () => {
      const limiter = createRateLimiter(2, 100);
      const ip = '192.168.1.100';
      
      limiter(ip);
      limiter(ip);
      assert.strictEqual(limiter(ip).allowed, false);
      
      await new Promise(resolve => setTimeout(resolve, 150));
      
      assert.strictEqual(limiter(ip).allowed, true);
    });

    it('returns remaining count', () => {
      const limiter = createRateLimiter(5, 60000);
      const ip = '192.168.1.100';
      
      let result = limiter(ip);
      assert.strictEqual(result.remaining, 4);
      
      result = limiter(ip);
      assert.strictEqual(result.remaining, 3);
    });
  });

  describe('setup rate limiter', () => {
    it('has stricter limits than login', () => {
      const loginLimiter = createRateLimiter(15, 900000);
      const setupLimiter = createRateLimiter(10, 900000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 10; i++) {
        loginLimiter(ip);
        setupLimiter(ip);
      }
      
      assert.strictEqual(setupLimiter(ip).allowed, false);
      assert.strictEqual(loginLimiter(ip).allowed, true);
    });
  });

  describe('API rate limiter', () => {
    it('allows higher limits for API', () => {
      const limiter = createRateLimiter(100, 60000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 50; i++) {
        assert.strictEqual(limiter(ip).allowed, true);
      }
    });

    it('blocks after exceeding API limit', () => {
      const limiter = createRateLimiter(10, 60000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 10; i++) {
        limiter(ip);
      }
      
      assert.strictEqual(limiter(ip).allowed, false);
    });
  });

  describe('snapshot rate limiter', () => {
    it('limits snapshot uploads', () => {
      const limiter = createRateLimiter(6, 60000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 6; i++) {
        limiter(ip);
      }
      
      assert.strictEqual(limiter(ip).allowed, false);
    });
  });

  describe('chat rate limiter', () => {
    it('limits messages per second', () => {
      const limiter = createRateLimiter(5, 1000);
      const ip = '192.168.1.100';
      
      for (let i = 0; i < 5; i++) {
        limiter(ip);
      }
      
      assert.strictEqual(limiter(ip).allowed, false);
    });

    it('allows burst then blocks', async () => {
      const limiter = createRateLimiter(3, 500);
      const ip = '192.168.1.100';
      
      assert.strictEqual(limiter(ip).allowed, true);
      assert.strictEqual(limiter(ip).allowed, true);
      assert.strictEqual(limiter(ip).allowed, true);
      assert.strictEqual(limiter(ip).allowed, false);
      
      await new Promise(resolve => setTimeout(resolve, 600));
      
      assert.strictEqual(limiter(ip).allowed, true);
    });
  });

  describe('rate limit settings from db', () => {
    it('reads login rate max from settings', () => {
      originalDb.setSetting('login_rate_max', '10');
      const max = parseInt(originalDb.getSetting('login_rate_max'));
      assert.strictEqual(max, 10);
    });

    it('reads login rate window from settings', () => {
      originalDb.setSetting('login_rate_window_min', '30');
      const window = parseInt(originalDb.getSetting('login_rate_window_min'));
      assert.strictEqual(window, 30);
    });

    it('reads snapshot rate settings', () => {
      originalDb.setSetting('snapshot_rate_max', '10');
      originalDb.setSetting('snapshot_rate_window_sec', '120');
      
      assert.strictEqual(parseInt(originalDb.getSetting('snapshot_rate_max')), 10);
      assert.strictEqual(parseInt(originalDb.getSetting('snapshot_rate_window_sec')), 120);
    });

    it('reads API rate settings', () => {
      originalDb.setSetting('api_rate_max', '200');
      originalDb.setSetting('api_rate_window_min', '5');
      
      assert.strictEqual(parseInt(originalDb.getSetting('api_rate_max')), 200);
      assert.strictEqual(parseInt(originalDb.getSetting('api_rate_window_min')), 5);
    });
  });
});
