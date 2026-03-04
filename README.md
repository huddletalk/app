# app

Minimal React Native CLI app (TypeScript) for HuddleTalk.

## What it does

- Fetches rooms from backend `GET /rooms`.
- Shows room list in the UI.
- Taps into a room and opens mediasoup WebRTC send/recv transports via backend signaling on `/signal`.

## Setup

```bash
npm install
npm run ios
# or
npm run android
```

`react-native-webrtc` and `mediasoup-client` require native iOS/Android projects.
For iOS first-time setup:

```bash
cd ios
bundle install
bundle exec pod install
cd ..
```

## Backend URL configuration

The current scaffold uses localhost defaults in `App.tsx`:

- iOS simulator: `http://127.0.0.1:8080`
- Android emulator: `http://10.0.2.2:8080`

For a physical phone on the same network, set `LAN_BACKEND_HOST` in `App.tsx` to your Mac LAN IP.
