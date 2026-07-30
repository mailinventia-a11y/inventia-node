import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { httpError } from './phase5Http.js';

const tenantUploadRoot = path.resolve(process.env.LOCAL_STORAGE_DIR || path.join(process.cwd(), 'uploads', 'tenant-files'));
const invoiceUploadRoot = path.resolve(process.env.INVOICE_STORAGE_DIR || path.join(process.cwd(), 'uploads'));

export function createStorageAdapter() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_STORAGE_BUCKET) {
    return new SupabaseStorageAdapter('');
  }
  return new LocalStorageAdapter(tenantUploadRoot, '');
}

export function createInvoiceStorageAdapter() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_STORAGE_BUCKET) {
    return new SupabaseStorageAdapter('invoices');
  }
  return new LocalStorageAdapter(invoiceUploadRoot, 'invoices');
}

class LocalStorageAdapter {
  provider = 'local';

  constructor(root, prefix) {
    this.root = root;
    this.prefix = prefix;
  }

  async put({ organizationId, originalName, contentType, buffer }) {
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
    const key = joinKey(this.prefix, organizationId, new Date().toISOString().slice(0, 10), `${crypto.randomUUID()}-${safeName}`);
    return this.putKey({ key, contentType, buffer });
  }

  async putKey({ key, contentType, buffer }) {
    const target = safeLocalPath(this.root, key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    return { key, provider: this.provider, content_type: contentType, size_bytes: buffer.length };
  }

  async remove(key) {
    await fs.rm(safeLocalPath(this.root, key), { force: true });
  }

  async signedUrl(key) {
    return `/api/v1/files/${encodeURIComponent(key)}`;
  }

  async read(key) {
    return fs.readFile(safeLocalPath(this.root, key));
  }
}

class SupabaseStorageAdapter {
  provider = 'supabase';

  constructor(prefix) {
    this.prefix = prefix;
    this.bucket = process.env.SUPABASE_STORAGE_BUCKET;
    this.client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
  }

  async put({ organizationId, originalName, contentType, buffer }) {
    const safeName = path.basename(originalName).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
    const key = joinKey(this.prefix, organizationId, new Date().toISOString().slice(0, 10), `${crypto.randomUUID()}-${safeName}`);
    return this.putKey({ key, contentType, buffer });
  }

  async putKey({ key, contentType, buffer }) {
    const { error } = await this.client.storage.from(this.bucket).upload(key, buffer, {
      contentType,
      upsert: false
    });
    if (error) throw httpError(502, 'storage_upload_failed', error.message);
    return { key, provider: this.provider, content_type: contentType, size_bytes: buffer.length };
  }

  async remove(key) {
    const { error } = await this.client.storage.from(this.bucket).remove([key]);
    if (error) throw httpError(502, 'storage_delete_failed', error.message);
  }

  async signedUrl(key, expiresIn = 900) {
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(key, expiresIn);
    if (error) throw httpError(502, 'storage_url_failed', error.message);
    return data.signedUrl;
  }

  async read(key) {
    const { data, error } = await this.client.storage.from(this.bucket).download(key);
    if (error) throw httpError(502, 'storage_download_failed', error.message);
    return Buffer.from(await data.arrayBuffer());
  }
}

function safeLocalPath(root, key) {
  const target = path.resolve(root, key);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw httpError(400, 'invalid_file_key', 'The file key is invalid.');
  }
  return target;
}

function joinKey(...parts) {
  return parts.filter(Boolean).map(part => String(part).replace(/^\/+|\/+$/g, '')).join('/');
}
