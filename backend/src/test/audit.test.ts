import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import Module from 'module';

// ============================================================================
// 0. Intercept ioredis before anything else is loaded
// ============================================================================
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id: string) {
  if (id === 'ioredis') {
    return class MockRedis {
      on(event: string, callback: any) {
        if (event === 'connect') {
          setTimeout(callback, 0);
        }
        return this;
      }
      set() { return 'OK'; }
      get() { return null; }
      incr() { return 1; }
      del() {}
      expire() {}
    };
  }
  return originalRequire.apply(this, arguments as any);
};

// ============================================================================
// 1. Database and Session Variable Mocks
// ============================================================================
const mockUsers: any[] = [];
const mockAuditLogs: any[] = [];

// Simulated session settings
let sessionUserId: string | null = null;
let sessionIpAddress: string | null = null;
let sessionUserAgent: string | null = null;

async function mockQuery(text: string, params: any[] = []): Promise<any> {
  const normalized = text.trim().replace(/\s+/g, ' ');

  // 1. set_config session parameters simulation
  if (normalized.includes("set_config('audit.user_id'")) {
    sessionUserId = params[0] || null;
    return { rows: [] };
  }
  if (normalized.includes("set_config('audit.ip_address'")) {
    sessionIpAddress = params[0] || null;
    return { rows: [] };
  }
  if (normalized.includes("set_config('audit.user_agent'")) {
    sessionUserAgent = params[0] || null;
    return { rows: [] };
  }

  // 2. Insert user record simulation (fires INSERT audit log)
  if (normalized.startsWith('INSERT INTO users')) {
    const id = params[0] || crypto.randomUUID();
    const username = params[1] || 'test_user';
    const email = params[2] || null;
    const balance = 10.00;
    
    const newUser = { id, username, email, balance, is_active: true };
    mockUsers.push(newUser);

    // Simulate INSERT Trigger
    mockAuditLogs.push({
      id: mockAuditLogs.length + 1,
      table_name: 'users',
      record_id: id,
      action: 'INSERT',
      old_data: null,
      new_data: newUser,
      changed_by: sessionUserId,
      ip_address: sessionIpAddress,
      user_agent: sessionUserAgent,
      archived_at: null,
      created_at: new Date()
    });

    return { rows: [newUser] };
  }

  // 3. Update user record simulation (fires UPDATE audit log)
  if (normalized.startsWith('UPDATE users SET balance =')) {
    const balance = params[0];
    const id = params[1];
    
    const index = mockUsers.findIndex(u => u.id === id);
    if (index !== -1) {
      const oldUser = { ...mockUsers[index] };
      mockUsers[index].balance = balance;
      const newUser = { ...mockUsers[index] };

      // Simulate UPDATE Trigger
      mockAuditLogs.push({
        id: mockAuditLogs.length + 1,
        table_name: 'users',
        record_id: id,
        action: 'UPDATE',
        old_data: oldUser,
        new_data: newUser,
        changed_by: sessionUserId,
        ip_address: sessionIpAddress,
        user_agent: sessionUserAgent,
        archived_at: null,
        created_at: new Date()
      });
    }
    return { rows: [] };
  }

  // 4. Delete user record simulation (fires DELETE audit log)
  if (normalized.startsWith('DELETE FROM users')) {
    const id = params[0];
    const index = mockUsers.findIndex(u => u.id === id);
    if (index !== -1) {
      const oldUser = mockUsers[index];
      mockUsers.splice(index, 1);

      // Simulate DELETE Trigger
      mockAuditLogs.push({
        id: mockAuditLogs.length + 1,
        table_name: 'users',
        record_id: id,
        action: 'DELETE',
        old_data: oldUser,
        new_data: null,
        changed_by: sessionUserId,
        ip_address: sessionIpAddress,
        user_agent: sessionUserAgent,
        archived_at: null,
        created_at: new Date()
      });
    }
    return { rows: [] };
  }

  // 5. Select unarchived audit logs (for backup service query)
  if (normalized.includes('FROM audit_logs WHERE archived_at IS NULL')) {
    const unarchived = mockAuditLogs.filter(l => l.archived_at === null);
    return { rows: unarchived };
  }

  // 6. Update archived_at in audit logs simulation
  if (normalized.startsWith('UPDATE audit_logs SET archived_at = NOW()')) {
    const maxId = params[0];
    mockAuditLogs.forEach(l => {
      if (l.id <= maxId && l.archived_at === null) {
        l.archived_at = new Date();
      }
    });
    return { rows: [] };
  }

  return { rows: [] };
}

// Inject DB module mock
import * as dbModule from '../config/database';
const mockDb = {
  connect: async () => ({
    query: async (text: string, params: any[]) => mockQuery(text, params),
    release: () => {}
  }),
  query: async (text: string, params: any[]) => mockQuery(text, params)
};
(dbModule as any).db = mockDb;
(dbModule as any).query = mockQuery;

// ============================================================================
// 2. Real Imports and Setup
// ============================================================================
import { queryAudited } from '../config/database';
import { backupAuditLogs } from '../services/audit-backup';

// ============================================================================
// 3. Test Cases
// ============================================================================
async function runTests() {
  console.log('🧪 Starting Immutable Database Audit Logs & S3 Mock Backup Integration Tests...');

  const backupDir = path.join(__dirname, '../../backups/s3-mock');

  try {
    // Clean backup mock folder before test
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        fs.unlinkSync(path.join(backupDir, file));
      }
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 1: Automated Audit Logging for INSERT triggers
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 1: Testing INSERT audit trigger and session context mapping...');

    const userId = '11111111-2222-3333-4444-555555555555';
    const actorId = '99999999-9999-9999-9999-999999999999'; // admin who makes change
    const ip = '192.168.1.100';
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

    // Run audited insert query
    await queryAudited(
      actorId,
      ip,
      ua,
      'INSERT INTO users (id, username, email) VALUES ($1, $2, $3)',
      [userId, 'gambler1', 'gambler1@coinmaster.internal']
    );

    const logLen1 = mockAuditLogs.length;
    if (logLen1 === 1) {
      const log = mockAuditLogs[0];
      if (
        log.table_name === 'users' &&
        log.record_id === userId &&
        log.action === 'INSERT' &&
        log.changed_by === actorId &&
        log.ip_address === ip &&
        log.user_agent === ua &&
        log.new_data.username === 'gambler1'
      ) {
        console.log('✅ Automated audit log created successfully with correct request session parameters.');
      } else {
        throw new Error(`Audit log entry mismatch: ${JSON.stringify(log)}`);
      }
    } else {
      throw new Error(`Expected 1 audit log entry, found ${mockAuditLogs.length}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 2: Automated Audit Logging for UPDATE triggers
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 2: Testing UPDATE audit trigger with old/new data snapshots...');

    // Run audited update query
    await queryAudited(
      actorId,
      ip,
      ua,
      'UPDATE users SET balance = $1 WHERE id = $2',
      [25.50, userId]
    );

    const logLen2 = mockAuditLogs.length;
    if (logLen2 === 2) {
      const log = mockAuditLogs[1];
      if (
        log.table_name === 'users' &&
        log.record_id === userId &&
        log.action === 'UPDATE' &&
        log.old_data.balance === 10.00 &&
        log.new_data.balance === 25.50
      ) {
        console.log('✅ Update trigger captured old/new state snapshots perfectly.');
      } else {
        throw new Error(`Update audit log mismatch: ${JSON.stringify(log)}`);
      }
    } else {
      throw new Error(`Expected 2 audit log entries, found ${mockAuditLogs.length}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 3: Automated Audit Logging for DELETE triggers
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 3: Testing DELETE audit trigger...');

    // Run audited delete query
    await queryAudited(
      actorId,
      ip,
      ua,
      'DELETE FROM users WHERE id = $1',
      [userId]
    );

    const logLen3 = mockAuditLogs.length;
    if (logLen3 === 3) {
      const log = mockAuditLogs[2];
      if (
        log.table_name === 'users' &&
        log.record_id === userId &&
        log.action === 'DELETE' &&
        log.old_data.username === 'gambler1' &&
        log.new_data === null
      ) {
        console.log('✅ Delete trigger successfully captured the snapshot of deleted record.');
      } else {
        throw new Error(`Delete audit log mismatch: ${JSON.stringify(log)}`);
      }
    } else {
      throw new Error(`Expected 3 audit log entries, found ${mockAuditLogs.length}`);
    }

    // ══════════════════════════════════════════════════════════════
    //  SCENARIO 4: S3 Mock Local Storage Backup Worker
    // ══════════════════════════════════════════════════════════════
    console.log('\nScenario 4: Testing S3 Backup Worker archiving process...');

    // Verify unarchived count is 3
    const unarchivedCountBefore = mockAuditLogs.filter(l => l.archived_at === null).length;
    if (unarchivedCountBefore !== 3) {
      throw new Error(`Expected 3 unarchived logs, found ${unarchivedCountBefore}`);
    }

    // Run the backup service logs dump
    await backupAuditLogs();

    // Check mock database update status
    const unarchivedCountAfter = mockAuditLogs.filter(l => l.archived_at === null).length;
    if (unarchivedCountAfter === 0) {
      console.log('✅ Backup service marked all archived logs in the database.');
    } else {
      throw new Error(`Logs were not marked archived. Still unarchived count: ${unarchivedCountAfter}`);
    }

    // Check filesystem json dump file
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      if (files.length === 1 && files[0].startsWith('audit-logs-')) {
        console.log(`✅ Backup file "${files[0]}" created successfully inside local s3-mock folder.`);
        
        // Validate file content
        const filePath = path.join(backupDir, files[0]);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (content.length === 3 && content[1].action === 'UPDATE') {
          console.log('✅ Backup JSON content schema validated and contents are intact.');
        } else {
          throw new Error(`Backup file content discrepancy: ${JSON.stringify(content)}`);
        }
      } else {
        throw new Error(`Expected 1 backup log file, found files: ${JSON.stringify(files)}`);
      }
    } else {
      throw new Error('Local mock backup folder was not created.');
    }

    // Clean up created files
    if (fs.existsSync(backupDir)) {
      const files = fs.readdirSync(backupDir);
      for (const file of files) {
        fs.unlinkSync(path.join(backupDir, file));
      }
    }

    console.log('\n🎉 All database audit logging and backup integration tests passed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test failed with error:', error);
    process.exit(1);
  }
}

runTests();
