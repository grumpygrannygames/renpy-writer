import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.grumpygranny.renpywriter',
  appName: "Ren'Py Writer",
  webDir: 'out/android',
  android: {
    // The page never loads anything from outside the app.
    allowMixedContent: false
  }
}

export default config
