# GeoPhoto

GeoPhoto is an offline-first Expo app for iOS and Android. It creates a new JPEG with a location card drawn into the image and GPS coordinates written into the JPEG's EXIF metadata. The chosen source image is copied into app storage and is never edited.

## Requirements

- Node.js 24.3.x, or another version supported by this Expo SDK (22.13.x, 26.x, or 27+)
- npm
- Xcode and CocoaPods for iOS builds
- Android Studio and an Android SDK for Android builds
- A physical device or simulator for exercising camera, location, and Photos/Gallery flows

The project uses Expo SDK 58. Native image rendering and EXIF verification are implemented in the local Expo module at `modules/my-module`; Expo Go does not load that app-specific module.

## Install and run

```sh
npm install
npx expo install --fix
npx expo prebuild
npx expo run:ios
# or
npx expo run:android
```

To launch Metro after installing the development build:

```sh
npx expo start --dev-client
```

Use a development build (or a production build) for camera capture, native image rendering, and GPS EXIF writing. After changing Swift or Kotlin code, rebuild the native app. For a clean native regeneration, run `npx expo prebuild --clean` and rebuild.

## How it works

- **Source storage:** selected and captured images are copied from temporary picker URIs into the app's persistent `sources/` directory. The original copy is not modified.
- **Visible stamp:** a local Expo native module renders the stamp directly onto the oriented source image and writes a high-quality JPEG under `outputs/`. It keeps the image aspect ratio and uses native image APIs rather than moving full-size image bytes through JavaScript.
- **GPS metadata:** iOS uses ImageIO and Android uses AndroidX ExifInterface. Both remove any previous GPS location, write the chosen latitude and longitude, read the output metadata back, and compare the signed coordinates to the selected values. The app only labels GPS as verified after this read-back succeeds. If the JPEG renders but EXIF cannot be verified, the output remains available with a clear unverified status.
- **Address and time:** the stamp tries a reverse-geocoded address for the selected coordinates, and labels it as approximate. A user-entered address is labeled separately. Address lookup is optional and may be unavailable offline. The stamp shows the source capture time when found, otherwise the creation time, with the device's local GMT offset.
- **Saved work:** project records are stored in SQLite. Image bytes are stored as files, never in the database. Projects include source/output URIs, original filename, coordinates, manual address, capture time, stamp configuration, EXIF status, and created/modified times.
- **Local privacy:** photo selection, manual coordinates, stamping, saving, and browsing work offline. Reverse geocoding is best-effort convenience; when it is unavailable, the user can enter an address or save with coordinates alone. Current location and Android address lookup use foreground permission only. Photos access is requested only when the user chooses Save to Photos. Nothing is uploaded.

## Platform notes and limitations

- GPS writing and verification require the included native module and a development or production build; they are unavailable in Expo Go.
- Large photos are decoded from their app-managed source file into bounded native thumbnails. Android retries with progressively smaller decode sizes if a device cannot render the first size; iOS uses ImageIO thumbnails instead of creating full-resolution JavaScript or UIKit copies. Aspect ratio is preserved, but very high-resolution output may have fewer pixels than its source. The saved project reports when this happens. Some formats, including HEIC/HEIF or WebP, depend on OS decoder support; unreadable formats produce an error while leaving the original untouched.
- Android preserves common camera and capture-date EXIF fields when available. iOS preserves the source image's other ImageIO metadata where the platform can represent it. GPS fields are replaced with the chosen location.
- The address field is optional and explicitly user-entered. There is no network geocoding requirement.
- In-app files can be removed by clearing app data or uninstalling. Copies saved to Photos/Gallery are owned by the operating system and remain there unless removed by the user.
- Photos are downsampled progressively for local rendering so large dimensions do not require a full-resolution working bitmap. The practical limits are free device storage and whether the operating system can decode the source format; incomplete output files are removed and are not added to the saved collection.

## Manual verification checklist

1. Choose a JPEG, cancel the picker, and confirm cancellation returns without an error. Repeat with a PNG or another supported format. Try a very high-resolution image and confirm it is processed locally and the saved item reports if it was downsampled.
2. Take a photo after granting camera access. Deny camera access once and confirm the explanation leaves photo selection available.
3. Enter valid positive and negative coordinates, then try blank, non-numeric, and out-of-range values.
4. Use Current Location with permission granted, denied, and device location services disabled. Confirm manual entry remains available.
5. Toggle each stamp field; preview all four placements and dark, light, and solid styles on bright and dark photos.
6. Save the output and confirm the original file is unchanged. Inspect the output with an EXIF viewer and compare GPS latitude/longitude with the selected values.
7. Simulate an EXIF failure if possible and confirm the saved item clearly says GPS could not be verified.
8. Share the output, save it to Photos/Gallery, reopen it from My Photos, then delete the project and confirm the deletion prompt.
9. Restart the app and confirm saved projects remain available. Confirm no photo/library permission is requested until its related feature is invoked.
