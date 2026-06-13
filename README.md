# 🚲 Cycle London

A bike-friendly route planner for London. Type a start and destination, choose how
calm or quick you want the ride to be, and the app draws the safest cycle route on
an interactive map — then animates a cyclist tracing the whole journey.

Everything is built on **open data**:

| Layer | Source | Open? |
|---|---|---|
| Map tiles (shows cycleways, paths, surfaces) | [CyclOSM](https://www.cyclosm.org) over OpenStreetMap | ✅ |
| Address search (locked to Greater London) | [Nominatim](https://nominatim.org) | ✅ |
| Bike routing & cycle-safety profiles | [BRouter](https://brouter.de) (OSM-based) | ✅ |
| Interactive map | [Leaflet](https://leafletjs.com) | ✅ |

Three route modes map to BRouter cycle profiles:
**Quiet & Safe** (`safety`) · **Balanced** (`trekking`) · **Fastest** (`fastbike`).

## Run it locally (web)

```bash
npm install
npm run dev
```

Open the printed URL in a browser. No API keys required — all services are public/open.

## Ship it to the App Store (iOS)

The app is a single web codebase wrapped natively with [Capacitor](https://capacitorjs.com),
so the same code that runs in the browser becomes a real iOS app.

```bash
npm install
npm run build        # produce the production web bundle in dist/
npm run ios:add      # one-time: create the native iOS project (needs macOS + Xcode)
npm run ios:sync     # copy the web build into the iOS project
npm run ios:open     # open in Xcode
```

Then in **Xcode**:

1. Select the `App` target → **Signing & Capabilities** → pick your Apple Developer team.
2. Set a unique Bundle Identifier (default `com.cyclelondon.app`) and an app icon.
3. Run on a simulator or device to test, then **Product → Archive** to upload to
   App Store Connect for TestFlight / review.

Requirements for submission: an [Apple Developer Program](https://developer.apple.com/programs/)
membership ($99/yr), Xcode, and an app icon + screenshots.

> **Attribution:** OpenStreetMap, CyclOSM and BRouter must be credited in-app (already shown
> on the map) and in your App Store listing, per their open licences (ODbL / CC-BY-SA).
> For heavy production traffic, self-host BRouter and a tile server rather than the public
> demo endpoints, and run your own Nominatim or a commercial geocoder to respect usage policies.
