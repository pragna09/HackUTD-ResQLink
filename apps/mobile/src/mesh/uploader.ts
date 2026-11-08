// Gateway side: when this phone has internet, upload what it carries to SpacetimeDB (relay_mesh_messages).
// The module de-duplicates by message id, opens/updates the case, picks the nearest responder and alerts it,
// and the dashboard shows the case live with its mesh route.
//
// Set EXPO_PUBLIC_STDB_URI to a SpacetimeDB address the phone can reach, e.g. ws://192.168.1.20:3000 for a
// laptop on the same Wi-Fi (localhost on a phone is the phone itself), or wss://maincloud.spacetimedb.com.
import * as SecureStore from 'expo-secure-store';

import { encodeUpload, type MeshMessage } from '../../../../module/src/mesh';
import { DbConnection } from '../module_bindings';

const URI = process.env.EXPO_PUBLIC_STDB_URI ?? 'ws://localhost:3000';
const DB = process.env.EXPO_PUBLIC_STDB_DB ?? 'welfare-check';
const TOKEN_KEY = 'resq.stdbToken';

export class Uploader {
  private conn: DbConnection | null = null;
  private connecting: Promise<DbConnection> | null = null;
  /** This phone's SpacetimeDB identity once it has connected at least once. */
  identityHex: string | null = null;

  constructor(private readonly log: (line: string) => void) {}

  private async connect(): Promise<DbConnection> {
    if (this.conn) return this.conn;
    this.connecting ??= (async () => {
      const token = (await SecureStore.getItemAsync(TOKEN_KEY)) ?? undefined;
      return new Promise<DbConnection>((resolve, reject) => {
        DbConnection.builder()
          .withUri(URI)
          .withDatabaseName(DB)
          .withToken(token)
          .onConnect((conn, identity, newToken) => {
            this.conn = conn;
            this.identityHex = identity.toHexString();
            void SecureStore.setItemAsync(TOKEN_KEY, newToken);
            this.log(`online: connected to ${URI}`);
            resolve(conn);
          })
          .onConnectError((_ctx, err) => reject(err))
          .onDisconnect(() => {
            this.conn = null;
            this.log('SpacetimeDB connection closed');
          })
          .build();
      });
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** Try to connect without uploading (to learn our identity while we have signal). */
  async warmUp(): Promise<void> {
    await this.connect().catch(() => undefined);
  }

  /** Returns true when SpacetimeDB accepted the batch; the caller then stops carrying those messages. */
  async upload(messages: MeshMessage[]): Promise<boolean> {
    if (messages.length === 0) return true;
    try {
      const conn = await this.connect();
      await conn.reducers.relayMeshMessages({ payload: encodeUpload(messages) });
      this.log(`uploaded ${messages.length} message(s) for the mesh`);
      return true;
    } catch (e) {
      this.log(`upload failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
