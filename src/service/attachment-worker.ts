import { readFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { getPool } from '../db/pool.js';
import { getSetting, getSettingInt } from './settings.js';
import { markScanStatus, type ScanStatus } from './resources.js';

interface PendingAttachment {
  id: string;
  relative_path: string;
}

function rows(result: unknown): PendingAttachment[] {
  return Array.isArray(result) ? result as PendingAttachment[] : [];
}

function attachmentRoot(): string {
  return path.resolve(
    process.env.ATTACHMENTS_ROOT
      ?? path.resolve(process.cwd(), 'attachments'),
  );
}

function attachmentPath(relativePath: string): string {
  const root = attachmentRoot();
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('attachment path escapes attachment root');
  }
  return resolved;
}

async function clamavInstreamScan(buffer: Buffer): Promise<boolean> {
  const host = getSetting('clamd_host');
  const port = getSettingInt('clamd_port', 3310);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write('zINSTREAM\0');
      const maxChunk = 64 * 1024;
      for (let offset = 0; offset < buffer.length; offset += maxChunk) {
        const chunk = buffer.subarray(offset, offset + maxChunk);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length, 0);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4));
    });
    let response = '';
    socket.setTimeout(15_000);
    socket.on('data', (data) => {
      response += data.toString();
    });
    socket.on('end', () => resolve(!/FOUND/i.test(response)));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('clamd scan timed out'));
    });
    socket.on('error', (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

export async function scanPendingNewAttachments(): Promise<{
  scanned: number;
  skipped: number;
  infected: number;
}> {
  const result = await getPool().query(
    `SELECT id, relative_path
       FROM attachment
      WHERE scan_status = 'pending' AND deleted_at IS NULL
      ORDER BY id
      LIMIT 50`,
  );
  const pending = rows(result);
  if (pending.length === 0) return { scanned: 0, skipped: 0, infected: 0 };

  const clamdHost = getSetting('clamd_host');
  let scanned = 0;
  let skipped = 0;
  let infected = 0;
  for (const attachment of pending) {
    if (!clamdHost) {
      await markScanStatus(attachment.id, 'skipped');
      skipped += 1;
      continue;
    }
    try {
      const clean = await clamavInstreamScan(await readFile(attachmentPath(attachment.relative_path)));
      const status: ScanStatus = clean ? 'clean' : 'infected';
      await markScanStatus(attachment.id, status);
      if (clean) scanned += 1;
      else infected += 1;
    } catch (error) {
      console.error(`[attachment-scan] ${attachment.id} failed:`, error);
    }
  }
  return { scanned, skipped, infected };
}

export function startAttachmentScanWorker(intervalMs = 1_000): () => void {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      await scanPendingNewAttachments();
    } catch (error) {
      console.error('[attachment-scan] worker failed:', error);
    } finally {
      running = false;
    }
  };
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, Math.max(100, intervalMs));
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
