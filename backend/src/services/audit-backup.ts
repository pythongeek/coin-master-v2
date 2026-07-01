import fs from 'fs';
import path from 'path';
import { query } from '../config/database';

// Optional AWS S3 Client loader
let s3Client: any = null;
try {
  const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
  s3Client = { S3Client, PutObjectCommand };
} catch {
  // S3 client not installed
}

/**
 * Fetch new audit logs, bundle them to JSON, and save to S3 or a local mock folder.
 */
export async function backupAuditLogs(): Promise<void> {
  try {
    // 1. Fetch all unarchived audit logs
    const result = await query(
      `SELECT id, table_name, record_id, action, old_data, new_data, changed_by, ip_address, user_agent, created_at 
       FROM audit_logs 
       WHERE archived_at IS NULL 
       ORDER BY id ASC`
    );

    if (result.rows.length === 0) {
      if (process.env.NODE_ENV === 'development') {
        console.log('📝 Audit log backup: no new logs to archive.');
      }
      return;
    }

    const logs = result.rows;
    const maxId = logs[logs.length - 1].id;
    const filename = `audit-logs-${Date.now()}-${maxId}.json`;
    const logsContent = JSON.stringify(logs, null, 2);

    // 2. Attempt S3 upload if AWS configuration exists and S3 client is loaded
    let uploaded = false;
    const bucketName = process.env.AWS_S3_AUDIT_BUCKET;
    
    if (bucketName && process.env.AWS_ACCESS_KEY_ID && s3Client) {
      try {
        const client = new s3Client.S3Client({
          region: process.env.AWS_REGION || 'us-east-1',
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          }
        });
        
        await client.send(
          new s3Client.PutObjectCommand({
            Bucket: bucketName,
            Key: `audit-logs/${filename}`,
            Body: logsContent,
            ContentType: 'application/json'
          })
        );
        console.log(`☁️ Audit logs uploaded to S3: audit-logs/${filename}`);
        uploaded = true;
      } catch (s3Err) {
        console.error('❌ Failed uploading audit logs to S3, falling back to local storage:', s3Err);
      }
    }

    // 3. Fallback to local storage (or always store locally as secondary backup)
    if (!uploaded) {
      const backupDir = path.join(__dirname, '../../backups/s3-mock');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      
      const backupPath = path.join(backupDir, filename);
      fs.writeFileSync(backupPath, logsContent, 'utf8');
      console.log(`📁 Audit logs backed up locally: backups/s3-mock/${filename}`);
    }

    // 4. Mark logs as archived in database
    await query(
      'UPDATE audit_logs SET archived_at = NOW() WHERE id <= $1 AND archived_at IS NULL',
      [maxId]
    );
    console.log(`✅ Marked ${logs.length} audit logs as archived in DB.`);
  } catch (error) {
    console.error('❌ Error during audit log backup:', error);
  }
}

let backupInterval: NodeJS.Timeout | null = null;

/**
 * Start the periodic audit backup worker
 */
export function startAuditBackupWorker(intervalMs: number = 3600000): void {
  if (backupInterval) {
    clearInterval(backupInterval);
  }
  
  // Run initial backup check
  backupAuditLogs().catch(console.error);
  
  backupInterval = setInterval(() => {
    backupAuditLogs().catch(console.error);
  }, intervalMs);
  
  console.log(`⏰ Audit log backup worker started (interval: ${intervalMs / 1000}s).`);
}

/**
 * Stop the periodic audit backup worker
 */
export function stopAuditBackupWorker(): void {
  if (backupInterval) {
    clearInterval(backupInterval);
    backupInterval = null;
    console.log('⏰ Audit log backup worker stopped.');
  }
}
