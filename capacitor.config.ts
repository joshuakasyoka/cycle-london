import type { CapacitorConfig } from '@capacitor/cli'

// Wraps the built web app into a native iOS shell for App Store submission.
//
// LOCATION PERMISSIONS (required for live GPS satnav):
// After running `npm run ios:add`, open ios/App/App/Info.plist and add:
//
//   <key>NSLocationWhenInUseUsageDescription</key>
//   <string>Safe Cycles uses your location to navigate the bike route.</string>
//   <key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
//   <string>Safe Cycles can keep tracking your position while you ride, even with the screen locked.</string>
//
// For background location (screen-off turn alerts), add the "Location updates"
// Background Mode in Xcode: Target → Signing & Capabilities → + Background Modes.
//
// Build steps:
//   npm run build        → produce dist/
//   npm run ios:add      → one-time: scaffold ios/ (needs macOS + Xcode)
//   npm run ios:sync     → copy web build into Xcode project
//   npm run ios:open     → open in Xcode, then Run or Archive
const config: CapacitorConfig = {
  appId: 'com.cyclelondon.app',
  appName: 'Safe Cycles',
  webDir: 'dist',
  ios: {
    contentInset: 'always',
    // Allow the WKWebView to use the device GPS.
    allowsLinkPreview: false,
  },
  // Expose geolocation to the WebView so navigator.geolocation.watchPosition works.
  plugins: {
    Geolocation: {
      // These map to iOS Info.plist keys (set them there too — see comment above).
      requestPermissions: true,
    },
  },
}

export default config
