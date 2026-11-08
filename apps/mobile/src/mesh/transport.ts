// Radio layer for the mesh: expo-nearby-connections (Android: Google Nearby Connections over Bluetooth + Wi-Fi;
// iOS: Apple Multipeer Connectivity). Every phone advertises and discovers at the same time with the
// P2P_CLUSTER strategy (many-to-many) and connects to everyone in range. Frames are JSON text (module/src/mesh.ts).
//
// DRAFT — not yet run on hardware. Known limits from the library README:
//   - Android <-> iPhone links are not supported; a mixed crowd forms two separate meshes.
//   - Max text size and background behaviour are not documented; keep the app in the foreground for now.
import {
  Strategy,
  acceptConnection,
  disconnect,
  onConnected,
  onDisconnected,
  onInvitationReceived,
  onPeerFound,
  onPeerLost,
  onTextReceived,
  requestConnection,
  sendText,
  startAdvertise,
  startDiscovery,
  stopAdvertise,
  stopDiscovery,
  type Unsubscribe,
} from 'expo-nearby-connections';
import { PermissionsAndroid, Platform, type Permission } from 'react-native';

import { decodeFrame, encodeFrame, type MeshBeacon, type MeshMessage } from '../../../../module/src/mesh';

export interface TransportEvents {
  /** A connected phone told us its mesh state. */
  onBeacon(beacon: MeshBeacon): void;
  onMessage(message: MeshMessage): void;
  /** A phone (by mesh node id) went out of range. */
  onNodeLost(node: string): void;
  log(line: string): void;
}

/** Android 12+ needs these at runtime; the config plugin only declares them in the manifest. */
async function requestAndroidPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const P = PermissionsAndroid.PERMISSIONS;
  const wanted: Permission[] = [P.ACCESS_FINE_LOCATION, P.ACCESS_COARSE_LOCATION];
  if (Number(Platform.Version) >= 31) wanted.push(P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT);
  if (Number(Platform.Version) >= 33) wanted.push(P.NEARBY_WIFI_DEVICES);
  const res = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every(p => res[p] === PermissionsAndroid.RESULTS.GRANTED);
}

export class NearbyTransport {
  private readonly connected = new Set<string>();
  /** Nearby peer id <-> mesh node id, learned from each peer's first beacon. */
  private readonly peerToNode = new Map<string, string>();
  private readonly nodeToPeer = new Map<string, string>();
  private unsubs: Unsubscribe[] = [];

  constructor(private readonly ev: TransportEvents) {}

  get peerCount() {
    return this.connected.size;
  }

  async start(name: string, firstBeacon: () => MeshBeacon): Promise<void> {
    if (!(await requestAndroidPermissions())) throw new Error('Bluetooth / nearby-devices permission was not granted');

    this.unsubs.push(
      onPeerFound(({ peerId, name: peerName }) => {
        if (this.connected.has(peerId)) return;
        this.ev.log(`found ${peerName}`);
        // Both sides may request at once; the library resolves duplicates, so failures here are expected noise.
        requestConnection(peerId).catch(() => undefined);
      }),
      onInvitationReceived(({ peerId }) => {
        acceptConnection(peerId).catch(e => this.ev.log(`accept failed: ${String(e)}`));
      }),
      onConnected(({ peerId, name: peerName }) => {
        this.connected.add(peerId);
        this.ev.log(`connected to ${peerName}`);
        // Introduce ourselves so the peer learns our node id and route to signal straight away.
        sendText(peerId, encodeFrame({ t: 'beacon', beacon: firstBeacon() })).catch(() => undefined);
      }),
      onDisconnected(({ peerId }) => this.drop(peerId)),
      onPeerLost(({ peerId }) => this.drop(peerId)),
      onTextReceived(({ peerId, text }) => {
        const frame = decodeFrame(text);
        if (!frame) return; // not ours, or malformed: ignore
        if (frame.t === 'beacon') {
          this.peerToNode.set(peerId, frame.beacon.node);
          this.nodeToPeer.set(frame.beacon.node, peerId);
          this.ev.onBeacon(frame.beacon);
        } else {
          this.ev.onMessage(frame.message);
        }
      })
    );

    await startAdvertise(name, Strategy.P2P_CLUSTER);
    await startDiscovery(name, Strategy.P2P_CLUSTER);
    this.ev.log('advertising and discovering nearby phones');
  }

  /** Tell every connected phone our current state (has signal? hops to signal?). */
  async broadcastBeacon(beacon: MeshBeacon) {
    const frame = encodeFrame({ t: 'beacon', beacon });
    await Promise.all([...this.connected].map(p => sendText(p, frame).catch(() => this.drop(p))));
  }

  /** Hand a message to one neighbour, addressed by its mesh node id. */
  async send(node: string, message: MeshMessage): Promise<boolean> {
    const peer = this.nodeToPeer.get(node);
    if (!peer || !this.connected.has(peer)) return false;
    try {
      await sendText(peer, encodeFrame({ t: 'msg', message }));
      return true;
    } catch {
      this.drop(peer);
      return false;
    }
  }

  async stop() {
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    await Promise.allSettled([stopAdvertise(), stopDiscovery(), disconnect()]);
    this.connected.clear();
  }

  private drop(peerId: string) {
    this.connected.delete(peerId);
    const node = this.peerToNode.get(peerId);
    if (node) {
      this.peerToNode.delete(peerId);
      this.nodeToPeer.delete(node);
      this.ev.onNodeLost(node);
    }
  }
}
