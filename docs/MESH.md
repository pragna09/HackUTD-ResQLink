# Mesh relay — SOS without signal

> Concept prototype. The routing, the backend and the dashboard demo are built and tested. The phone radio
> layer (`apps/mobile`) is a **draft that has not been run on real phones yet**.

## The idea

When towers go down in a disaster zone, a phone with no signal can still reach other phones nearby over
Bluetooth / Wi-Fi Direct. Each phone passes the message on, hop by hop, toward the **nearest phone that still
has internet**. That phone uploads it, and the existing system takes over: the person appears on the dashboard,
the nearest police / fire / hospital is picked, and an alert is sent.

```
[no signal] Ana ──hop──> stranger ──hop──> stranger ──hop──> [has signal] Ben ──internet──> SpacetimeDB
   presses SOS                                                   uploads        └─> case + nearest center + alert
                                                                                └─> dashboard (SOS, "via mesh", route on map)
```

## How "nearest signal" is found (`module/src/mesh.ts`)

- Every phone advertises a small **beacon**: `{ hasSignal, hopsToSignal }`. A phone with internet says 0.
  Every other phone takes 1 + the smallest number it hears from a neighbour (distance-vector routing).
- A phone carrying a message forwards it to the neighbour **closest to signal**. If nobody knows a route yet,
  it sends to every neighbour (epidemic flooding) so the message keeps spreading while routes form.
- **Store and forward:** phones keep messages until they are delivered or too old (6 h), so a message can wait
  for someone to walk into range.
- **Safety rails:** every hop de-duplicates by message id (no loops), a message travels at most 12 hops,
  SOS messages are sent before heartbeats, and each phone carries at most 200 messages.
- The same file runs on phones, in the dashboard simulator and in tests, so the demo shows the real logic.

## What the backend does (`relay_mesh_messages` reducer)

- Accepts a JSON batch from the uploading phone, strictly validated. Stores each message id once, so several
  phones uploading the same SOS is harmless.
- Keeps the **phone's own timestamp** (when the person pressed SOS), not the upload time. A location only
  replaces the stored one if it is newer.
- An **SOS opens a case immediately**, even if the zone is below the severity-3 scan threshold, and alerts the
  nearest responder: *"SOS from Ana, sent 4 min ago with no signal and relayed phone-to-phone to Ben…
  Unverified — please send a welfare check."* Hop counts are stored (`mesh_message.hops`, `missing_case.meshHops`)
  but not shown on any screen. An existing case is marked SOS and re-triaged.
- SOS cases rank first on the dashboard and are **never auto-closed** by a later heartbeat; a responder closes them.
- Unknown senders get a minimal profile (sending an SOS is consent to be located).

## Dashboard demo

**Simulate mesh (no signal)** takes the selected zone, assumes its towers are down, scatters synthetic
bystander phones (about 2 per km², so each has ~6 neighbours), and runs the real routing at an assumed
**1 km phone-to-phone range**. You watch messages hop on the map (red), see which phones with signal uploaded
them (blue rings), then the SOS cases appear in the queue. Selecting a case draws the route it took.

The 1 km range is optimistic: it is Bluetooth LE long range / Wi-Fi Direct in the open. Indoors it is often
10–100 m, so a real mesh needs far more phones per km².

## Phone app draft (`apps/mobile`)

Built on [expo-nearby-connections](https://www.npmjs.com/package/expo-nearby-connections) (Android: Google
Nearby Connections; iPhone: Multipeer Connectivity). The app advertises and discovers at the same time
(`P2P_CLUSTER`, many-to-many), connects to every phone in range, and exchanges beacons and messages as JSON.
When it has internet it uploads to SpacetimeDB through the generated bindings.

**Not verified on hardware.** Known limits from the library: **Android cannot talk to iPhone** (a mixed crowd
forms two separate meshes), message size limits and background operation are undocumented, so keep the app open.

### Testing it on phones

See the short guide: [apps/mobile/TESTING.md](../apps/mobile/TESTING.md).

## Not solved yet

- **Authenticity:** messages are not signed, so anyone in radio range could forge one. Sign with a per-phone key
  registered while online before trusting this for real dispatch.
- **Delivery receipts:** the sender is not told its SOS arrived; that needs an acknowledgement flooded back.
- **Battery:** continuous advertising and discovery drains phones; real use needs duty cycling.
- **Identity:** a phone that has never been online sends under a random id, so the dashboard shows it as a new
  person rather than linking it to an existing profile.
