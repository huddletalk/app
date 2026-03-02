# app

Minimal React Native CLI app (TypeScript) for HuddleTalk.

## What it does

- Fetches rooms from backend `GET /rooms`.
- Shows room list in the UI.
- Taps into a room and opens a WebRTC connection via backend signaling on `/signal`.

## Setup

```bash
npm install
npm run ios
# or
npm run android
```

`react-native-webrtc` requires native iOS/Android projects.
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
