# ResQLink

Offline-first emergency SOS relay prototype for HackUTD. This is a learning demo. It does not contact 911 or guarantee delivery.

## Phase 0

The Expo TypeScript app is in `apps/mobile` (Expo SDK 58). Bluetooth, the backend, and the dashboard are later phases.

```bash
cd apps/mobile
npm install
npx expo start
```

A physical Android or iPhone install needs a development build. Expo Go cannot load the Bluetooth module planned for Phase 1. Android Studio and an Android SDK are required for a local Android build. An iPhone build from Windows needs EAS Build and Apple signing.
