// Runs the shared mesh logic (module/src/mesh.ts) on a real phone:
//   radio (transport.ts) -> MeshNode -> uploader.ts when this phone has internet.
// Every TICK_MS: check internet, refresh location, broadcast our beacon, forward carried messages toward the
// nearest phone with signal, and upload everything if we have signal ourselves.
//
// DRAFT — not yet run on hardware. See apps/mobile/MESH.md for how to test with two phones.
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import * as SecureStore from 'expo-secure-store';

import { MeshNode, type MeshMessage } from '../../../../module/src/mesh';
import { NearbyTransport } from './transport';
import { Uploader } from './uploader';

const TICK_MS = 3_000;
const HEARTBEAT_MS = 60_000;
const NODE_ID_KEY = 'resq.nodeId';
const NAME_KEY = 'resq.name';

export interface MeshStatus {
  running: boolean;
  nodeId: string;
  name: string;
  hasSignal: boolean;
  /** 0 = this phone has signal; 255 = no route known yet. */
  hopsToSignal: number;
  neighbors: number;
  carried: number;
  sosSent: number;
  log: string[];
  error?: string;
}

/** 64 hex chars. Replaced by the SpacetimeDB identity once the phone has been online. Not cryptographic. */
function randomNodeId(): string {
  let s = '';
  for (let i = 0; i < 64; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

class MeshService {
  private node: MeshNode | null = null;
  private transport: NearbyTransport | null = null;
  private uploader: Uploader | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private listeners = new Set<(s: MeshStatus) => void>();
  private status: MeshStatus = { running: false, nodeId: '', name: '', hasSignal: false, hopsToSignal: 255, neighbors: 0, carried: 0, sosSent: 0, log: [] };

  subscribe(cb: (s: MeshStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  async start(name: string) {
    if (this.status.running) return;
    try {
      await SecureStore.setItemAsync(NAME_KEY, name);
      const loc = await Location.requestForegroundPermissionsAsync();
      if (loc.status !== 'granted') throw new Error('Location permission is needed to tell responders where you are');

      this.uploader = new Uploader(l => this.log(l));
      // Prefer the SpacetimeDB identity (same person on the dashboard); fall back to a stored random id offline.
      let nodeId = await SecureStore.getItemAsync(NODE_ID_KEY);
      if (await this.online()) {
        await this.uploader.warmUp();
        if (this.uploader.identityHex) nodeId = this.uploader.identityHex;
      }
      nodeId ??= randomNodeId();
      await SecureStore.setItemAsync(NODE_ID_KEY, nodeId);

      const pos = await this.position();
      this.node = new MeshNode({ id: nodeId, lat: pos?.lat ?? 0, lng: pos?.lng ?? 0, hasSignal: await this.online() });
      this.transport = new NearbyTransport({
        onBeacon: b => this.node?.hearBeacon(b),
        onMessage: m => {
          if (this.node?.receive(m)) this.log(`carrying ${m.kind} from ${m.displayName}`);
        },
        onNodeLost: n => this.node?.loseNeighbor(n),
        log: l => this.log(l),
      });
      await this.transport.start(name, () => this.node!.beacon());
      this.status = { ...this.status, running: true, nodeId, name, error: undefined };
      this.timer = setInterval(() => void this.tick(), TICK_MS);
      void this.tick();
    } catch (e) {
      this.status = { ...this.status, error: e instanceof Error ? e.message : String(e) };
      this.emit();
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.transport?.stop();
    this.status = { ...this.status, running: false };
    this.emit();
  }

  /** The person pressed SOS. Uploaded directly if we have signal, otherwise relayed through nearby phones. */
  async sendSos(note: string) {
    if (!this.node) return;
    const pos = await this.position();
    if (pos) {
      this.node.lat = pos.lat;
      this.node.lng = pos.lng;
    }
    const m = this.node.originate({ kind: 'sos', displayName: this.status.name, note, accuracy: pos?.accuracy ?? 0 });
    this.status = { ...this.status, sosSent: this.status.sosSent + 1 };
    this.log(`SOS created (${m.id})`);
    void this.tick();
  }

  private async tick() {
    const node = this.node;
    const transport = this.transport;
    if (!node || !transport) return;
    node.hasSignal = await this.online();

    const pos = await this.position();
    if (pos) {
      node.lat = pos.lat;
      node.lng = pos.lng;
    }

    // Without signal, keep a heartbeat moving so the dashboard sees when we were last alive and where.
    if (!node.hasSignal && Date.now() - this.lastHeartbeat > HEARTBEAT_MS) {
      node.originate({ kind: 'heartbeat', displayName: this.status.name, accuracy: pos?.accuracy ?? 0 });
      this.lastHeartbeat = Date.now();
    }

    await transport.broadcastBeacon(node.beacon());
    const { sends, uploads } = node.tick();
    for (const s of sends) await transport.send(s.to, s.message);
    if (uploads.length > 0 && (await this.uploader!.upload(uploads))) node.delivered(uploads.map((u: MeshMessage) => u.id));

    this.status = {
      ...this.status,
      hasSignal: node.hasSignal,
      hopsToSignal: node.hopsToSignal(),
      neighbors: transport.peerCount,
      carried: node.carried().length,
    };
    this.emit();
  }

  private async online(): Promise<boolean> {
    try {
      const s = await Network.getNetworkStateAsync();
      return s.isInternetReachable === true;
    } catch {
      return false;
    }
  }

  private async position(): Promise<{ lat: number; lng: number; accuracy: number } | null> {
    try {
      const p = (await Location.getLastKnownPositionAsync({ maxAge: 60_000 })) ?? (await Location.getCurrentPositionAsync({}));
      return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy ?? 0 };
    } catch {
      return null;
    }
  }

  private log(line: string) {
    const stamp = new Date().toLocaleTimeString();
    this.status = { ...this.status, log: [`${stamp}  ${line}`, ...this.status.log].slice(0, 40) };
    this.emit();
  }

  private emit() {
    for (const cb of this.listeners) cb(this.status);
  }

  async savedName(): Promise<string> {
    return (await SecureStore.getItemAsync(NAME_KEY)) ?? '';
  }
}

export const meshService = new MeshService();
