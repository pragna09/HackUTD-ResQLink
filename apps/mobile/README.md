# ResQLink

HackUTD 2026 emergency response prototype.

ResQLink is an offline-first emergency SOS relay prototype.
ResQLink identifies people who have stopped sending location updates
inside a disaster zone and helps responders prioritize welfare checks.

This is a learning demo. It does not contact 911 or guarantee delivery.
All ResQLink data is synthetic.

## Mesh relay (draft)

The home screen joins a phone-to-phone mesh and sends an SOS without signal. Code in `src/mesh/`; design, limits and
design and limits are in [../../docs/MESH.md](../../docs/MESH.md); to try it on phones see [TESTING.md](TESTING.md). Not yet tested on hardware.
