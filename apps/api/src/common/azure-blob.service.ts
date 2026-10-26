import { BlobSASPermissions, BlobServiceClient, ContainerClient } from '@azure/storage-blob';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Private Azure Blob container for punch selfies. Reads go through short-lived
 * SAS URLs, so the connection string must carry an AccountKey.
 */
@Injectable()
export class AzureBlobService {
  private readonly logger = new Logger(AzureBlobService.name);
  private client?: ContainerClient;
  private ensured = false;

  private get container(): ContainerClient {
    if (!this.client) {
      const conn = process.env.AZURE_STORAGE_CONNECTION_STRING;
      if (!conn) throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
      this.client = BlobServiceClient.fromConnectionString(conn).getContainerClient(process.env.AZURE_STORAGE_CONTAINER_SELFIES || 'punch-selfies');
    }
    return this.client;
  }

  async upload(key: string, body: Buffer, contentType: string) {
    if (!this.ensured) {
      // Private container (no public access level), created on first write.
      await this.container.createIfNotExists();
      this.ensured = true;
    }
    await this.container.getBlockBlobClient(key).uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  readUrl(key: string, expiresInSeconds = 3600) {
    return this.container.getBlockBlobClient(key).generateSasUrl({
      permissions: BlobSASPermissions.parse('r'),
      expiresOn: new Date(Date.now() + expiresInSeconds * 1000),
    });
  }

  async remove(keys: string[]) {
    for (const key of keys) {
      try {
        await this.container.deleteBlob(key, { deleteSnapshots: 'include' });
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode !== 404) this.logger.warn(`Blob remove failed for ${key}: ${(err as Error).message}`);
      }
    }
  }
}
