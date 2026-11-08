// Loads the synthetic dataset into a running database by calling reset_demo, then prints row counts.
//   npm run seed           # reset + seed
//   npm run check          # counts only
// Needs bindings:  spacetime generate --lang typescript --out-dir seed/module_bindings --module-path module
// CLI equivalent:  spacetime call welfare-check reset_demo
import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { DbConnection } from './module_bindings';

config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const URI = process.env.STDB_URI ?? 'ws://localhost:3000';
const DB = process.env.STDB_DB ?? 'welfare-check';
const checkOnly = process.argv.includes('--check');

const TABLES = [
  'user_profile',
  'location_ping',
  'zone',
  'news_item',
  'emergency_center',
  'shelter_offer',
  'missing_case',
  'alert',
] as const;

DbConnection.builder()
  .withUri(URI)
  .withDatabaseName(DB)
  .onConnect(conn => {
    const counts = () => ({
      user_profile: conn.db.userProfile.count(),
      location_ping: conn.db.locationPing.count(),
      zone: conn.db.zone.count(),
      news_item: conn.db.newsItem.count(),
      emergency_center: conn.db.emergencyCenter.count(),
      shelter_offer: conn.db.shelterOffer.count(),
      missing_case: conn.db.missingCase.count(),
      alert: conn.db.alert.count(),
    });
    conn
      .subscriptionBuilder()
      .onApplied(async () => {
        if (!checkOnly) {
          console.log(`calling reset_demo on ${URI}/${DB} …`);
          await conn.reducers.resetDemo({});
          await new Promise(r => setTimeout(r, 750)); // let the subscription catch up
        }
        console.table(counts());
        conn.disconnect();
        process.exit(0);
      })
      .subscribe(TABLES.map(t => `SELECT * FROM ${t}`));
  })
  .onConnectError((_ctx, err) => {
    console.error(`Cannot connect to ${URI} (${DB}). Is \`spacetime start\` running and the module published?`, err);
    process.exit(1);
  })
  .build();
