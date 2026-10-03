import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const BUCKETS = {
  reports: () => process.env.STORAGE_BUCKET_REPORTS || 'reports',
  uploads: () => process.env.STORAGE_BUCKET_UPLOADS || 'uploads',
  punchPhotos: () => process.env.STORAGE_BUCKET_PUNCH_PHOTOS || 'punch-photos',
};

/**
 * Service-role Supabase client: Auth admin (account creation, password resets,
 * bans) and private Storage. The service-role key lives only here (§17).
 */
@Injectable()
export class SupabaseService {
  private readonly logger = new Logger(SupabaseService.name);
  private client?: SupabaseClient;

  private get admin(): SupabaseClient {
    if (!this.client) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured');
      this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    return this.client;
  }

  // ── Auth ──────────────────────────────────────────────────────────────────

  async createUser(email: string, password: string, appMetadata: Record<string, unknown>) {
    const { data, error } = await this.admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: appMetadata,
    });
    if (error) throw error;
    return data.user;
  }

  async updateUser(userId: string, attrs: { password?: string; app_metadata?: Record<string, unknown>; ban_duration?: string }) {
    const { data, error } = await this.admin.auth.admin.updateUserById(userId, attrs);
    if (error) throw error;
    return data.user;
  }

  async getUser(userId: string) {
    const { data, error } = await this.admin.auth.admin.getUserById(userId);
    if (error) throw error;
    return data.user;
  }

  async deleteUser(userId: string) {
    const { error } = await this.admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  }

  /** Checks a password without keeping the session. */
  async verifyPassword(email: string, password: string): Promise<boolean> {
    const probe = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await probe.auth.signInWithPassword({ email, password });
    return !error;
  }

  // ── Storage (all buckets private) ─────────────────────────────────────────

  async upload(bucket: string, path: string, body: Buffer, contentType: string) {
    const { error } = await this.admin.storage.from(bucket).upload(path, body, { contentType, upsert: false });
    if (error) throw error;
  }

  async signedUrl(bucket: string, path: string, expiresInSeconds = 300, downloadName?: string) {
    const { data, error } = await this.admin.storage
      .from(bucket)
      .createSignedUrl(path, expiresInSeconds, downloadName ? { download: downloadName } : undefined);
    if (error) throw error;
    return data.signedUrl;
  }

  async remove(bucket: string, paths: string[]) {
    if (!paths.length) return;
    const { error } = await this.admin.storage.from(bucket).remove(paths);
    if (error) this.logger.warn(`Storage remove failed in ${bucket}: ${error.message}`);
  }
}
