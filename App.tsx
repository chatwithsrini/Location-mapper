import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import * as Sharing from "expo-sharing";
import * as MediaLibrary from "expo-media-library/legacy";
import { Image as ExpoImage } from "expo-image";
import { requireNativeModule } from "expo";

type Stamp = {
  address: boolean;
  coordinates: boolean;
  dateTime: boolean;
  placement: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  style: "dark" | "light" | "solid";
};
type Project = {
  id: string;
  sourceUri: string;
  outputUri: string;
  filename: string;
  latitude: number;
  longitude: number;
  address: string;
  addressSource: "geocoded" | "manual" | "none";
  captureTime: string;
  exifStatus: string;
  stamp: Stamp;
  createdAt: string;
  modifiedAt: string;
};
type Draft = {
  sourceUri: string;
  filename: string;
  width: number;
  height: number;
  captureTime: string;
  captureTimeExif: string;
  address: string;
  addressSource: "geocoded" | "manual" | "none";
  latitude: number | null;
  longitude: number | null;
  accuracy: number | null;
};
const NativeGeoPhoto = (() => {
  try {
    return requireNativeModule("GeoPhoto");
  } catch {
    return null;
  }
})();
const dbPromise = SQLite.openDatabaseAsync("geophoto.db");
const defaults: Stamp = {
  address: true,
  coordinates: true,
  dateTime: true,
  placement: "bottom-left",
  style: "dark",
};
const colors = {
  bg: "#F5F7F4",
  ink: "#17241F",
  muted: "#728078",
  green: "#176B4A",
  line: "#E0E7E1",
  white: "#FFFFFF",
  pale: "#E9F3EC",
  red: "#9A3D32",
};

export default function App() {
  const [screen, setScreen] = useState<
    "home" | "location" | "stamp" | "preview" | "library"
  >("home");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [stamp, setStamp] = useState<Stamp>(defaults);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [latText, setLatText] = useState("");
  const [lonText, setLonText] = useState("");
  const [errors, setErrors] = useState<{ lat?: string; lon?: string }>({});
  const [captureTimeInput, setCaptureTimeInput] = useState("");
  const [captureTimeError, setCaptureTimeError] = useState("");
  const [addressLookup, setAddressLookup] = useState("");
  useEffect(() => {
    (async () => {
      const db = await dbPromise;
      await db.execAsync(
        `CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, sourceUri TEXT NOT NULL, outputUri TEXT NOT NULL, filename TEXT, latitude REAL, longitude REAL, address TEXT, addressSource TEXT NOT NULL DEFAULT 'none', captureTime TEXT, exifStatus TEXT, stamp TEXT, createdAt TEXT NOT NULL, modifiedAt TEXT NOT NULL)`,
      );
      try { await db.execAsync("ALTER TABLE projects ADD COLUMN addressSource TEXT NOT NULL DEFAULT 'none'"); } catch {}
      await refresh();
    })().catch(() => setMessage("Could not open your saved photo collection."));
  }, []);
  async function refresh() {
    const db = await dbPromise;
    const rows = await db.getAllAsync<any>(
      "SELECT * FROM projects ORDER BY createdAt DESC",
    );
    setProjects(rows.map((r: any) => ({ ...r, stamp: JSON.parse(r.stamp) })));
  }
  const goBack = () => {
    if (screen === "location") setScreen("home");
    else if (screen === "stamp") setScreen("location");
    else if (screen === "preview") setScreen("stamp");
    else setScreen("home");
  };
  async function choosePhoto(camera: boolean) {
    setMessage("");
    let stagedUri: string | undefined;
    try {
      if (camera) {
        const p = await ImagePicker.requestCameraPermissionsAsync();
        if (!p.granted) {
          Alert.alert(
            "Camera access needed",
            "Allow camera access in Settings to take a photo. You can still choose a photo or enter coordinates.",
          );
          return;
        }
      }
      const result = camera
        ? await ImagePicker.launchCameraAsync({
            mediaTypes: ["images"],
            quality: 1,
            exif: true,
            cameraType: ImagePicker.CameraType.back,
          })
        : await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ["images"],
            quality: 1,
            exif: true,
          });
      if (result.canceled || !result.assets?.[0]) return;
      const a = result.assets[0];
      const supportedMime = /^(image\/(jpeg|png|heic|heif|webp))$/i.test(a.mimeType || "");
      const supportedName = /\.(jpe?g|png|heic|heif|webp)$/i.test(a.fileName || a.uri);
      if (!supportedMime && !supportedName) {
        Alert.alert(
          "Unsupported photo",
          "Choose a JPEG, PNG, HEIC, or WebP still image.",
        );
        return;
      }
      if (!FileSystem.documentDirectory)
        throw new Error("App storage is unavailable.");
      const folder = FileSystem.documentDirectory + "sources/";
      await FileSystem.makeDirectoryAsync(folder, { intermediates: true });
      const mimeExtension: Record<string, string> = {
        "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic",
        "image/heif": "heif", "image/webp": "webp",
      };
      const nameExtension = (a.fileName || "").match(/\.([a-z0-9]+)$/i)?.[1];
      const uriExtension = a.uri.split("?")[0].match(/\.([a-z0-9]+)$/i)?.[1];
      const ext = (mimeExtension[(a.mimeType || "").toLowerCase()] || nameExtension || uriExtension || "jpg").toLowerCase();
      const safe = `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const src = folder + safe;
      stagedUri = src;
      await FileSystem.copyAsync({ from: a.uri, to: src });
      const info = await FileSystem.getInfoAsync(src);
      if (!info.exists || !info.size)
        throw new Error("The photo could not be copied into app storage.");
      const exif: any = a.exif || {};
      const time = exif.DateTimeOriginal || exif.DateTime || null;
      const captured = time ? parseExifDate(String(time)) : "";
      let initialLat: number | null = null,
        initialLon: number | null = null;
      if (
        typeof exif.GPSLatitude === "number" &&
        typeof exif.GPSLongitude === "number"
      ) {
        initialLat =
          exif.GPSLatitude *
          (String(exif.GPSLatitudeRef).toUpperCase() === "S" ? -1 : 1);
        initialLon =
          exif.GPSLongitude *
          (String(exif.GPSLongitudeRef).toUpperCase() === "W" ? -1 : 1);
      }
      setDraft({
        sourceUri: src,
        filename: a.fileName || safe,
        width: a.width,
        height: a.height,
        captureTime: captured,
        captureTimeExif: "",
        address: "",
        addressSource: "none",
        latitude: initialLat,
        longitude: initialLon,
        accuracy: null,
      });
      setCaptureTimeInput(captured ? captured.replace("T", " ").slice(0, 16) : "");
      setCaptureTimeError("");
      if (initialLat !== null && initialLon !== null) {
        setLatText(initialLat.toFixed(6));
        setLonText(initialLon.toFixed(6));
      } else {
        setLatText("");
        setLonText("");
      }
      setAddressLookup("");
      setStamp(defaults);
      setScreen("location");
      stagedUri = undefined;
    } catch (e: any) {
      if (stagedUri) {
        try {
          await FileSystem.deleteAsync(stagedUri, { idempotent: true });
        } catch {}
      }
      Alert.alert(
        "Photo unavailable",
        friendlyError(
          e,
          "This image could not be read. Try another supported photo.",
        ),
      );
    }
  }
  function startNewPhoto() {
    Alert.alert("Create a photo", "Choose an existing photo or take a new one.", [
      { text: "Choose photo", onPress: () => void choosePhoto(false) },
      { text: "Take photo", onPress: () => void choosePhoto(true) },
      { text: "Cancel", style: "cancel" },
    ]);
  }
  function setStampField(field: "address" | "coordinates" | "dateTime", value: boolean) {
    if (!value) {
      const remainingCoordinates = field === "coordinates" ? false : stamp.coordinates;
      const remainingTime = field === "dateTime" ? false : stamp.dateTime;
      const remainingAddress = field === "address" ? false : stamp.address && !!draft?.address.trim();
      if (!remainingCoordinates && !remainingTime && !remainingAddress) {
        Alert.alert("Keep a stamp field", "At least one field with content must remain visible on the photo.");
        return;
      }
    }
    setStamp({ ...stamp, [field]: value });
  }
  function parseExifDate(s: string) {
    const m = s.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}:\d{2}:\d{2})/);
    return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}` : "";
  }
  function parseDateTimeInput(value: string) {
    const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return null;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText = "00"] = match;
    const year = Number(yearText), month = Number(monthText), day = Number(dayText);
    const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
    const date = new Date(year, month - 1, day, hour, minute, second);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
    const pad = (part: number) => String(part).padStart(2, "0");
    return {
      iso: date.toISOString(),
      exif: `${yearText}:${monthText}:${dayText} ${pad(hour)}:${pad(minute)}:${pad(second)}`,
    };
  }
  function formatDateTimeInput(date: Date) {
    const pad = (part: number) => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function commitCaptureTime() {
    const entered = captureTimeInput.trim();
    const parsed = entered ? parseDateTimeInput(entered) : null;
    if (entered && !parsed) {
      setCaptureTimeError("Enter a valid date and time, such as 2026-11-10 14:35.");
      return false;
    }
    setCaptureTimeError("");
    setDraft((current) => current ? {
      ...current,
      captureTime: parsed?.iso ?? current.captureTime,
      captureTimeExif: parsed?.exif ?? "",
    } : current);
    return true;
  }
  function previewPhoto() {
    if (!commitCaptureTime()) return;
    setScreen("preview");
  }
  function friendlyError(e: any, fallback: string) {
    const s = String(e?.message || "");
    if (/space|quota|storage/i.test(s))
      return "GeoPhoto saves finished photos in this device’s internal app storage. Free some device storage and try again.";
    if (/large|megapixel|memory|bitmap|outofmemory/i.test(s))
      return "This photo is too large to convert with the memory currently available. The original is unchanged; try a smaller photo or close other apps and try again.";
    if (/unsupported|unreadable|decode/i.test(s))
      return "This image format is not supported by this device. Try a JPEG or PNG photo.";
    return fallback;
  }
  async function currentLocation() {
    setBusy(true);
    setMessage("");
    try {
      let p = await Location.getForegroundPermissionsAsync();
      if (!p.granted) p = await Location.requestForegroundPermissionsAsync();
      if (!p.granted) {
        Alert.alert(
          "Location access not granted",
          "Enable foreground location in Settings or enter the coordinates manually.",
        );
        return;
      }
      const enabled = await Location.hasServicesEnabledAsync();
      if (!enabled) {
        Alert.alert(
          "Location services are off",
          "Turn on Location Services, or enter coordinates manually.",
        );
        return;
      }
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        mayShowUserSettingsDialog: true,
      });
      setLatText(loc.coords.latitude.toFixed(6));
      setLonText(loc.coords.longitude.toFixed(6));
      setDraft((d) =>
        d
          ? (() => {
              const changed = d.latitude !== loc.coords.latitude || d.longitude !== loc.coords.longitude;
              return {
                ...d,
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
                accuracy: loc.coords.accuracy,
                ...(changed && d.addressSource === "geocoded" ? { address: "", addressSource: "none" as const } : {}),
              };
            })()
          : d,
      );
    } catch {
      Alert.alert(
        "Location unavailable",
        "A current location fix could not be found. Try again or enter coordinates manually.",
      );
    } finally {
      setBusy(false);
    }
  }
  function validate() {
    const la = latText.trim(), lo = lonText.trim();
    const nlat = Number(la), nlon = Number(lo);
    const e: { lat?: string; lon?: string } = {};
    if (!la || !Number.isFinite(nlat) || nlat < -90 || nlat > 90) e.lat = "Enter a number from −90 to 90.";
    if (!lo || !Number.isFinite(nlon) || nlon < -180 || nlon > 180) e.lon = "Enter a number from −180 to 180.";
    setErrors(e);
    if (Object.keys(e).length) return false;
    setDraft((d) => {
      if (!d) return d;
      const changed = d.latitude !== nlat || d.longitude !== nlon;
      return {
        ...d,
        latitude: nlat,
        longitude: nlon,
        ...(changed && d.addressSource === "geocoded" ? { address: "", addressSource: "none" as const } : {}),
      };
    });
    return true;
  }
  function formatTimeWithZone(value: string | Date) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (n: number) => String(n).padStart(2, "0");
    const offset = -date.getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "−";
    const absoluteOffset = Math.abs(offset);
    const zone = `GMT${sign}${Math.floor(absoluteOffset / 60)}:${pad(absoluteOffset % 60)}`;
    const hour24 = date.getHours();
    const hour12 = hour24 % 12 || 12;
    const meridiem = hour24 >= 12 ? "PM" : "AM";
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${hour12}:${pad(date.getMinutes())} ${meridiem} ${zone}`;
  }
  function addressFromResult(result: Location.LocationGeocodedAddress | undefined) {
    if (!result) return "";
    const road = [result.streetNumber, result.street || result.name].filter(Boolean).join(" ");
    const parts = [road, result.district, result.city || result.subregion, result.region, result.country]
      .map((part) => part?.trim())
      .filter((part): part is string => !!part);
    return parts.filter((part, index) => parts.findIndex((item) => item.toLocaleLowerCase() === part.toLocaleLowerCase()) === index).join(", ");
  }
  async function lookupAddress(latitude?: number, longitude?: number, requestPermission = false) {
    const lat = latitude ?? draft?.latitude;
    const lon = longitude ?? draft?.longitude;
    if (lat === null || lat === undefined || lon === null || lon === undefined) return;
    if (draft?.addressSource === "manual") {
      setAddressLookup("Using the address you entered.");
      return;
    }
    setAddressLookup("Looking up an address for these coordinates…");
    try {
      if (Platform.OS === "android") {
        let permission = await Location.getForegroundPermissionsAsync();
        if (!permission.granted && requestPermission) permission = await Location.requestForegroundPermissionsAsync();
        if (!permission.granted) {
          setAddressLookup("Address lookup on Android needs foreground location access. Tap Find address or enter one below.");
          return;
        }
      }
      const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lon });
      const address = addressFromResult(place);
      if (!address) {
        setAddressLookup("No address was found. Coordinates still work, or enter an address below.");
        return;
      }
      setDraft((current) => current && current.addressSource !== "manual"
        ? { ...current, latitude: lat, longitude: lon, address, addressSource: "geocoded" }
        : current);
      setAddressLookup("Approximate address found from the selected coordinates.");
    } catch {
      setAddressLookup("Address lookup is unavailable. You can enter an address or save with coordinates only.");
    }
  }
  function continueStamp() {
    if (!validate()) return;
    setScreen("stamp");
    void lookupAddress(Number(latText), Number(lonText), false);
  }
  async function save() {
    if (!draft || draft.latitude === null || draft.longitude === null) return;
    if (!NativeGeoPhoto) {
      Alert.alert(
        "Native image support unavailable",
        "Build the app with the included iOS and Android native module. GPS writing cannot be verified in Expo Go.",
      );
      return;
    }
    setBusy(true);
    setMessage("Creating your photo…");
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const output =
      FileSystem.documentDirectory +
      `outputs/GeoPhoto_${new Date()
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d+Z/, "Z")}_${id.slice(-4)}.jpg`;
    try {
      await FileSystem.makeDirectoryAsync(
        FileSystem.documentDirectory + "outputs/",
        { intermediates: true },
      );
      const details = {
        latitude: draft.latitude,
        longitude: draft.longitude,
        address: draft.address,
        addressSource: draft.addressSource,
        addressLabel: draft.addressSource === "manual" ? "Entered: " : "Approx. ",
        addressEnabled: stamp.address,
        coordinatesEnabled: stamp.coordinates,
        dateTimeEnabled: stamp.dateTime,
        placement: stamp.placement,
        style: stamp.style,
        captureTime: draft.captureTime,
        captureTimeExif: draft.captureTimeExif,
        stamp,
        displayTime: `${draft.captureTimeExif ? "Updated · " : draft.captureTime ? "Captured · " : "Created · "}${formatTimeWithZone(draft.captureTime || new Date())}`,
      };
      const result = await NativeGeoPhoto.renderAndTag(
        draft.sourceUri,
        output,
        details,
      );
      const info = await FileSystem.getInfoAsync(output);
      if (!info.exists || !info.size)
        throw new Error("The rendered photo was not created.");
      const exifStatus = result?.verified
        ? "GPS verified in output EXIF"
        : "GPS could not be verified; visible stamp saved";
      const sourcePixels = draft.width * draft.height;
      const outputPixels = Number(result?.width || draft.width) * Number(result?.height || draft.height);
      const resizedNote = outputPixels < sourcePixels * 0.95
        ? `Large image resized to ${result.width} × ${result.height} for on-device rendering`
        : "";
      const status = [exifStatus, resizedNote].filter(Boolean).join(" · ");
      const db = await dbPromise;
      const now = new Date().toISOString();
      await db.runAsync(
        "INSERT INTO projects (id,sourceUri,outputUri,filename,latitude,longitude,address,addressSource,captureTime,exifStatus,stamp,createdAt,modifiedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        draft.sourceUri,
        output,
        draft.filename || "",
        draft.latitude,
        draft.longitude,
        draft.address,
        draft.addressSource,
        draft.captureTime,
        status,
        JSON.stringify(stamp),
        now,
        now,
      );
      await refresh();
      // A successful save should create a durable copy in the device gallery,
      // as well as the private in-app copy used by My Photos.
      let gallerySaved = false;
      try {
        const permission = await MediaLibrary.requestPermissionsAsync(true);
        if (permission.granted) {
          await MediaLibrary.saveToLibraryAsync(output);
          gallerySaved = true;
        }
      } catch {
        // The private project is already safely stored; offer the gallery
        // action again from My Photos if the device library is unavailable.
      }
      setScreen("library");
      setMessage(
        `${gallerySaved ? "Photo saved to your device Photos/Gallery and My Photos." : "Photo saved in My Photos. Allow Photos access to also copy it to your device gallery."} ${result?.verified ? "GPS coordinates were verified in EXIF." : "GPS EXIF could not be verified; coordinates remain visible on the image."}`,
      );
      Alert.alert(
        gallerySaved ? "Saved to your device" : "Saved in My Photos",
        `${gallerySaved ? "A copy is in Photos/Gallery and My Photos." : "The in-app copy is safe. Use Save to Photos in My Photos to try again."}\n\n${status}`,
        [{ text: "OK" }],
      );
    } catch (e: any) {
      try {
        const inf = await FileSystem.getInfoAsync(output);
        if (inf.exists)
          await FileSystem.deleteAsync(output, { idempotent: true });
      } catch {}
      Alert.alert(
        "Could not create photo",
        friendlyError(
          e,
          "The photo could not be rendered. The original is unchanged; check free storage and try again.",
        ),
      );
      setMessage("");
    } finally {
      setBusy(false);
    }
  }
  async function share(uri: string) {
    try {
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: "image/jpeg",
          dialogTitle: "Share geo-tagged photo",
        });
        Alert.alert(
          "Share sheet closed",
          "If you selected a destination, the photo was handed to that app.",
        );
      } else {
        Alert.alert(
          "Sharing unavailable",
          "Sharing is not available on this device.",
        );
      }
    } catch {
      Alert.alert(
        "Could not share photo",
        "The share sheet could not be opened.",
      );
    }
  }
  async function saveToPhotos(uri: string) {
    try {
      const p = await MediaLibrary.requestPermissionsAsync(true);
      if (!p.granted) {
        Alert.alert(
          "Photos permission needed",
          "Allow photo access to save a copy to your device gallery. Your in-app copy is already saved.",
        );
        return;
      }
      await MediaLibrary.saveToLibraryAsync(uri);
      Alert.alert(
        "Saved to Photos",
        "A copy is now in your device photo library.",
      );
    } catch {
      Alert.alert(
        "Could not save to Photos",
        "Your in-app copy is safe. Check photo library access and available storage.",
      );
    }
  }
  function deleteProject(p: Project) {
    Alert.alert(
      "Delete saved photo?",
      "This removes the saved project and its app-managed image files. Copies already saved in Photos remain.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const db = await dbPromise;
              await db.runAsync("DELETE FROM projects WHERE id=?", p.id);
              for (const uri of [p.sourceUri, p.outputUri]) {
                const inf = await FileSystem.getInfoAsync(uri);
                if (inf.exists)
                  await FileSystem.deleteAsync(uri, { idempotent: true });
              }
              await refresh();
            } catch {
              Alert.alert(
                "Could not delete",
                "The saved photo could not be removed.",
              );
            }
          },
        },
      ],
    );
  }
  const parsedCaptureTimeInput = captureTimeInput.trim() ? parseDateTimeInput(captureTimeInput) : null;
  const effectiveCaptureTime = parsedCaptureTimeInput?.iso || draft?.captureTime || "";
  const timeText = effectiveCaptureTime
    ? `${draft?.captureTimeExif || parsedCaptureTimeInput?.exif ? "Updated · " : "Captured · "}${formatTimeWithZone(effectiveCaptureTime)}`
    : `Created · ${formatTimeWithZone(new Date())}`;
  const addressText = draft?.address
    ? `${draft.addressSource === "manual" ? "Entered: " : "Approx. "}${draft.address}`
    : "";
  const latitudeText = Number(draft?.latitude ?? latText).toFixed(6);
  const longitudeText = Number(draft?.longitude ?? lonText).toFixed(6);
  const header = (title: string, back = true) => (
    <View style={styles.header}>
      {back && (
        <Pressable
          onPress={goBack}
          style={styles.back}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      )}
      <View style={styles.headerBrand} pointerEvents="none">
        <View style={styles.headerLogoFrame}>
          <Image source={require("./assets/logo.png")} style={styles.headerLogo} resizeMode="contain" accessibilityLabel="GeoPhoto logo" />
        </View>
        <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
      </View>
    </View>
  );
  const button = (
    label: string,
    onPress: () => void,
    primary = false,
    disabled = false,
    extraStyle?: any,
  ) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={[
        styles.button,
        primary && styles.primary,
        disabled && { opacity: 0.5 },
        extraStyle,
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.primaryText]}>
        {label}
      </Text>
    </Pressable>
  );
  const preview = (compact = false) => (
    <View style={[styles.photoFrame, compact && styles.compactFrame, draft && { aspectRatio: draft.width / draft.height }]}>
      {draft && (
        <Image
          source={{ uri: draft.sourceUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          accessibilityLabel="Selected photo preview"
        />
      )}
      <View
        style={[
          styles.stampCard,
          stamp.placement.includes("top") ? { top: 12 } : { bottom: 12 },
          stamp.placement.includes("right") ? { right: 12 } : { left: 12 },
          stamp.style === "light" && styles.lightCard,
          stamp.style === "solid" && styles.solidCard,
        ]}
      >
                <View style={styles.pin}>
                  <View style={styles.pinTail} />
          <Text style={styles.pinGlyph}>●</Text>
        </View>
                <View style={styles.stampContent}>
                  {stamp.dateTime && <Text numberOfLines={1} style={[styles.stampText, styles.stampTime, stamp.style === "light" && styles.lightText]}>{timeText}</Text>}
                  {stamp.address && !!addressText && <Text numberOfLines={2} style={[styles.stampText, styles.stampAddress, stamp.style === "light" && styles.lightText]}>{addressText}</Text>}
                  {stamp.coordinates && <View style={styles.stampCoordinates}>
                    <Text numberOfLines={1} style={[styles.stampText, styles.stampCoordinate, stamp.style === "light" && styles.lightText]}>Lat: {latitudeText}</Text>
                    <Text numberOfLines={1} style={[styles.stampText, styles.stampCoordinate, styles.longitudeText, stamp.style === "light" && styles.lightText]}>Long: {longitudeText}</Text>
                  </View>}
                </View>
      </View>
    </View>
  );
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
    <SafeAreaView edges={["top", "bottom", "left", "right"]} style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      {screen === "home" && (
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.brand}>
            <View style={styles.brandMark}>
              <Image source={require("./assets/logo.png")} style={styles.brandLogo} resizeMode="contain" accessibilityLabel="GeoPhoto logo" />
            </View>
            <Text style={styles.brandName}>GeoPhoto</Text>
            <Text style={styles.kicker}>KEEP THE PLACE WITH THE PICTURE</Text>
          </View>
          <View style={styles.hero}>
            <Text style={styles.heroTitle}>
              Give your photos{"\n"}a sense of place.
            </Text>
            <Text style={styles.heroCopy}>
              Add a clean location stamp and real GPS metadata. Your original
              stays untouched.
            </Text>
            <View style={styles.heroGraphic}>
              <View style={styles.sun} />
              <View style={styles.hillOne} />
              <View style={styles.hillTwo} />
              <View style={styles.heroCard}>
                <Text style={{ fontSize: 16 }}>⌖ 37.774929, −122.419416</Text>
                <Text style={{ fontSize: 11, color: "#708078", marginTop: 4 }}>
                  San Francisco · 10:42 AM
                </Text>
              </View>
            </View>
          </View>
          {message ? <Text style={styles.homeMessage}>{message}</Text> : null}
          <Text style={styles.sectionTitle}>START A PHOTO</Text>
          {button("Choose Photo", () => choosePhoto(false), true)}
          {button("Take Photo", () => choosePhoto(true))}
          <Pressable
            onPress={() => {
              setScreen("library");
              setMessage("");
            }}
            style={styles.libraryButton}
          >
            <Text style={styles.libraryIcon}>▧</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.libraryTitle}>My Photos</Text>
              <Text style={styles.librarySub}>
                {projects.length
                  ? `${projects.length} saved ${projects.length === 1 ? "photo" : "photos"}`
                  : "Your saved geo-tagged photos"}
              </Text>
            </View>
            <Text style={styles.chevron}>›</Text>
          </Pressable>
          <Text style={styles.privacy}>
            Photos stay on this device. Nothing is uploaded.{"\n"}Removing the
            app or clearing its data may delete in-app copies; Photos/Gallery
            copies remain in your device library.
          </Text>
        </ScrollView>
      )}
      {screen === "location" && (
        <>
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === "ios" ? "padding" : undefined}
          >
            {header("Choose location")}
            <ScrollView contentContainerStyle={styles.container}>
              <Text style={styles.step}>STEP 1 OF 3</Text>
              <Text style={styles.title}>Where was this taken?</Text>
              <Text style={styles.subtitle}>
                Use your current location, keep coordinates found in the photo, or enter a place below.
              </Text>
              {draft && (
                <View style={styles.sourceCard}>
                  <Image
                    source={{ uri: draft.sourceUri }}
                    style={styles.thumb}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sourceTitle} numberOfLines={1}>
                      {draft.filename}
                    </Text>
                    <Text style={styles.sourceSub}>
                      {draft.width} × {draft.height} px
                    </Text>
                    {draft.latitude !== null && (
                      <Text style={styles.sourceSub}>
                        Photo already has coordinates
                      </Text>
                    )}
                  </View>
                </View>
              )}
              {button(
                busy ? "Finding location…" : "Use Current Location",
                currentLocation,
                true,
                busy,
              )}
              {draft?.accuracy !== null && draft?.accuracy !== undefined && (
                <Text style={styles.accuracy}>
                  GPS accuracy ±{Math.round(draft.accuracy)} m
                </Text>
              )}
              <View style={styles.divider}>
                <View style={styles.rule} />
                <Text style={styles.or}>LOCATION COORDINATES</Text>
                <View style={styles.rule} />
              </View>
              {draft?.latitude !== null && draft?.latitude !== undefined && draft.longitude !== null && (
                <View style={styles.exifCard}>
                  <Text style={styles.exifTitle}>COORDINATES READY · EDIT BELOW IF NEEDED</Text>
                  <Text style={styles.exifCoords}>{draft.latitude.toFixed(6)}, {draft.longitude.toFixed(6)}</Text>
                </View>
              )}
              <View style={styles.coordRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>LATITUDE</Text>
                  <TextInput
                    accessibilityLabel="Latitude"
                    keyboardType="numbers-and-punctuation"
                    value={latText}
                    onChangeText={(value) => {
                      setLatText(value);
                      setErrors((current) => ({ ...current, lat: undefined }));
                      setDraft((d) => d ? { ...d, accuracy: null } : d);
                    }}
                    placeholder="37.774929"
                    style={[styles.input, errors.lat && styles.inputError]}
                  />
                  {errors.lat && <Text style={styles.error}>{errors.lat}</Text>}
                </View>
                <View style={{ width: 12 }} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>LONGITUDE</Text>
                  <TextInput
                    accessibilityLabel="Longitude"
                    keyboardType="numbers-and-punctuation"
                    value={lonText}
                    onChangeText={(value) => {
                      setLonText(value);
                      setErrors((current) => ({ ...current, lon: undefined }));
                      setDraft((d) => d ? { ...d, accuracy: null } : d);
                    }}
                    placeholder="−122.419416"
                    style={[styles.input, errors.lon && styles.inputError]}
                  />
                  {errors.lon && <Text style={styles.error}>{errors.lon}</Text>}
                </View>
              </View>
              {draft?.captureTime && (
                <Text style={styles.captureNote}>
                  Capture time found:{" "}
                  {new Date(draft.captureTime).toLocaleString()}
                </Text>
              )}
              {button("Continue with these coordinates", continueStamp, true)}
              <Text style={styles.smallNote}>
                Coordinates are added to the photo’s EXIF metadata when
                supported and verified.
              </Text>
            </ScrollView>
          </KeyboardAvoidingView>
        </>
      )}
      {screen === "stamp" && (
        <>
          {header("Customize stamp")}
          <ScrollView contentContainerStyle={styles.container}>
            <Text style={styles.step}>STEP 2 OF 3</Text>
            <Text style={styles.title}>Make it yours.</Text>
            <Text style={styles.subtitle}>
              A live preview updates as you change the stamp.
            </Text>
            <Text style={styles.label}>PHOTO DATE & TIME</Text>
            <Text style={styles.timeHelp}>
              Edit the time printed on the photo and stored in its EXIF metadata. Uses your device’s local time.
            </Text>
            <TextInput
              accessibilityLabel="Photo date and time"
              value={captureTimeInput}
              onChangeText={(value) => {
                setCaptureTimeInput(value);
                setCaptureTimeError("");
              }}
              placeholder="YYYY-MM-DD HH:mm"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              style={[styles.input, captureTimeError && styles.inputError]}
            />
            {captureTimeError ? <Text style={styles.error}>{captureTimeError}</Text> : null}
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                setCaptureTimeInput(formatDateTimeInput(new Date()));
                setCaptureTimeError("");
              }}
              style={styles.timeNowButton}
            >
              <Text style={styles.timeNowText}>Use current time</Text>
            </Pressable>
            {preview()}
            <Text style={styles.label}>
              {draft?.addressSource === "geocoded"
                ? "ADDRESS · APPROXIMATE LOOKUP"
                : draft?.addressSource === "manual"
                  ? "ADDRESS · ENTERED BY YOU"
                  : "ADDRESS (OPTIONAL)"}
            </Text>
            <Text style={styles.addressStatus}>{addressLookup || "A nearby address may be found from these coordinates. Address lookup can be unavailable offline."}</Text>
            <View style={styles.addressRow}>
            <TextInput
              accessibilityLabel="Address, entered by you or found from coordinates"
              value={draft?.address ?? ""}
              onChangeText={(address) => {
                setDraft((d) => d ? { ...d, address, addressSource: address.trim() ? "manual" : "none" } : d);
                setAddressLookup(address.trim() ? "This address was entered by you." : "Address is optional; coordinates are enough to save.");
              }}
              placeholder="Street, town, region"
              maxLength={100}
              style={[styles.input, styles.addressInput]}
            />
            <Pressable onPress={() => void lookupAddress(undefined, undefined, true)} disabled={addressLookup.startsWith("Looking")} style={[styles.lookupButton, addressLookup.startsWith("Looking") && { opacity: 0.55 }]} accessibilityRole="button" accessibilityLabel="Find address from coordinates">
              <Text style={styles.lookupButtonText}>{addressLookup.startsWith("Looking") ? "…" : "Find"}</Text>
            </Pressable>
            </View>
            <View style={styles.settingsCard}>
              <Toggle
                label="Coordinates"
                value={stamp.coordinates}
                onChange={(v) => setStampField("coordinates", v)}
              />
              <Toggle
                label="Address"
                value={stamp.address}
                onChange={(v) => setStampField("address", v)}
              />
              <Toggle
                label="Date and time"
                value={stamp.dateTime}
                onChange={(v) => setStampField("dateTime", v)}
              />
            </View>
            <Text style={styles.label}>PLACEMENT</Text>
            <View style={styles.optionRow}>
              {(
                [
                  "bottom-left",
                  "bottom-right",
                  "top-left",
                  "top-right",
                ] as const
              ).map((p) => (
                <Pressable
                  key={p}
                  onPress={() => setStamp({ ...stamp, placement: p })}
                  style={[
                    styles.option,
                    stamp.placement === p && styles.optionSelected,
                  ]}
                >
                  <Text
                    style={[
                      styles.optionText,
                      stamp.placement === p && styles.optionTextSelected,
                    ]}
                  >
                    {p.replace("-", " ")}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Text style={styles.label}>STAMP STYLE</Text>
            <View style={styles.optionRow}>
              {(["dark", "light", "solid"] as const).map((s) => (
                <Pressable
                  key={s}
                  onPress={() => setStamp({ ...stamp, style: s })}
                  style={[
                    styles.styleOption,
                    stamp.style === s && styles.optionSelected,
                  ]}
                >
                  <View
                    style={[
                      styles.styleSwatch,
                      s === "dark" && { backgroundColor: "#14211D" },
                      s === "light" && { backgroundColor: "#F5F7F4" },
                      s === "solid" && { backgroundColor: "#176B4A" },
                    ]}
                  />
                  <Text
                    style={[
                      styles.optionText,
                      stamp.style === s && styles.optionTextSelected,
                    ]}
                  >
                    {s}
                  </Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.actionRow}>
              {button("Reset", () => setStamp(defaults), false, false, styles.actionButton)}
              {button("Preview photo", previewPhoto, true, false, styles.actionButton)}
            </View>
          </ScrollView>
        </>
      )}
      {screen === "preview" && (
        <>
          {header("Final preview")}
          <ScrollView contentContainerStyle={styles.container}>
            <Text style={styles.step}>STEP 3 OF 3</Text>
            <Text style={styles.title}>Ready to save.</Text>
            <Text style={styles.subtitle}>
              The stamped image will be saved separately. Your original photo
              stays unchanged.
            </Text>
            {preview()}
            <Text style={styles.smallNote}>
              Very large photos are resized to a safe on-device working size; the original remains unchanged.
            </Text>
            <View style={styles.exifCard}>
              <Text style={styles.exifTitle}>⌖ GPS LOCATION</Text>
              <Text style={styles.exifCoords}>
                {Number(draft?.latitude).toFixed(6)},{" "}
                {Number(draft?.longitude).toFixed(6)}
              </Text>
              <Text style={styles.exifSub}>
                The app verifies GPS coordinates in the finished JPEG before
                confirming.
              </Text>
            </View>
            {button(busy ? "Creating photo…" : "Save Photo", save, true, busy)}
            {button("Back to stamp", () => setScreen("stamp"))}
            <Text style={styles.smallNote}>
              You can save another copy to Photos or share after the output is
              created.
            </Text>
          </ScrollView>
        </>
      )}
      {screen === "library" && (
        <>
          {header("My Photos")}
          <ScrollView contentContainerStyle={styles.libraryContainer}>
            <View style={styles.libraryIntro}>
              <View style={{ flex: 1 }}>
                <Text style={styles.libraryEyebrow}>YOUR COLLECTION</Text>
                <Text style={styles.title}>Photos with a place.</Text>
                <Text style={styles.subtitle}>Saved on this device and ready to share.</Text>
              </View>
              <View style={styles.countBadge}>
                <Text style={styles.countNumber}>{projects.length}</Text>
                <Text style={styles.countLabel}>SAVED</Text>
              </View>
            </View>
            {message ? <Text style={styles.success}>{message}</Text> : null}
            {projects.length > 0 && button("Create another photo", startNewPhoto, true, false, styles.newPhotoButton)}
            {projects.length === 0 ? (
              <View style={styles.empty}>
                <Image source={require("./assets/logo.png")} style={styles.emptyLogo} resizeMode="contain" accessibilityLabel="GeoPhoto logo" />
                <Text style={styles.emptyTitle}>No photos yet</Text>
                <Text style={styles.emptyCopy}>
                  Choose or take a photo to create your first geo-tagged image.
                </Text>
                {button("Create a photo", startNewPhoto, true)}
              </View>
            ) : (
              <View style={styles.projectGrid}>
                {projects.map((p) => (
                  <View key={p.id} style={styles.projectTile}>
                    <Pressable
                      onPress={() => setSelectedProject(p)}
                      accessibilityRole="button"
                      accessibilityLabel={`Open photo tagged ${p.latitude.toFixed(4)}, ${p.longitude.toFixed(4)}`}
                    >
                      <ExpoImage
                        source={{ uri: p.outputUri }}
                        style={styles.projectImage}
                        contentFit="cover"
                        transition={150}
                      />
                    </Pressable>
                    <View style={styles.projectInfo}>
                      <Text style={styles.projectCoords} numberOfLines={1}>
                        {p.latitude.toFixed(6)}, {p.longitude.toFixed(6)}
                      </Text>
                      <Text style={styles.projectMeta} numberOfLines={2}>
                        {p.address || "Location tagged photo"}
                      </Text>
                      <Text style={styles.projectDate}>{new Date(p.createdAt).toLocaleDateString()}</Text>
                      <View style={styles.projectActions}>
                        <Pressable style={styles.tileAction} onPress={() => share(p.outputUri)} accessibilityRole="button" accessibilityLabel="Share photo">
                          <Text style={styles.actionText}>↗  Share</Text>
                        </Pressable>
                        <Pressable style={[styles.tileAction, styles.tileActionPrimary]} onPress={() => saveToPhotos(p.outputUri)} accessibilityRole="button" accessibilityLabel="Save photo to device gallery">
                          <Text style={[styles.actionText, styles.tileActionPrimaryText]}>Save</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            )}
            <Text style={styles.privacy}>
              App-managed images may be removed if you clear app data or
              uninstall. Copies in Photos/Gallery are managed by your device.
            </Text>
          </ScrollView>
        </>
      )}
      {busy && (
        <View style={styles.loading}>
          <ActivityIndicator color={colors.green} />
          <Text style={styles.loadingText}>{message || "Working…"}</Text>
        </View>
      )}
      <Modal
        visible={selectedProject !== null}
        animationType="slide"
        onRequestClose={() => setSelectedProject(null)}
      >
        <SafeAreaProvider style={{ flex: 1 }}>
        <SafeAreaView edges={["top", "bottom", "left", "right"]} style={styles.safe}>
          {selectedProject && (
            <ScrollView contentContainerStyle={styles.container}>
              <View style={styles.header}>
                <Pressable
                  onPress={() => setSelectedProject(null)}
                  style={styles.back}
                  accessibilityRole="button"
                  accessibilityLabel="Close photo"
                >
                  <Text style={styles.backText}>×</Text>
                </Pressable>
                <View style={styles.headerBrand} pointerEvents="none">
                  <View style={styles.headerLogoFrame}>
                    <Image source={require("./assets/logo.png")} style={styles.headerLogo} resizeMode="contain" accessibilityLabel="GeoPhoto logo" />
                  </View>
                  <Text style={styles.headerTitle} numberOfLines={1}>Saved photo</Text>
                </View>
              </View>
              <Image
                source={{ uri: selectedProject.outputUri }}
                style={styles.savedPreview}
                resizeMode="contain"
                accessibilityLabel="Saved geo-tagged photo"
              />
              <Text style={styles.exifCoords}>
                {selectedProject.latitude.toFixed(6)}, {selectedProject.longitude.toFixed(6)}
              </Text>
              <Text style={styles.exifSub}>{selectedProject.exifStatus}</Text>
              {selectedProject.address ? (
                <Text style={styles.exifSub}>
                  {selectedProject.addressSource === "manual" ? "Entered by you" : "Approximate geocoded address"}: {selectedProject.address}
                </Text>
              ) : null}
              {button("Share", () => share(selectedProject.outputUri), true)}
              {button("Save to Photos", () => saveToPhotos(selectedProject.outputUri))}
              {button("Delete saved photo", () => {
                deleteProject(selectedProject);
                setSelectedProject(null);
              })}
            </ScrollView>
          )}
        </SafeAreaView>
        </SafeAreaProvider>
      </Modal>
    </SafeAreaView>
    </SafeAreaProvider>
  );
}
function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.toggle}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ false: "#D8E0DA", true: "#8EB9A0" }}
        thumbColor={value ? "#176B4A" : "#FFFFFF"}
        accessibilityLabel={`Show ${label.toLowerCase()}`}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  container: { padding: 22, paddingBottom: 40 },
  libraryContainer: { padding: 18, paddingBottom: 36 },
  libraryIntro: { flexDirection: "row", alignItems: "center", paddingHorizontal: 4, paddingTop: 12, paddingBottom: 16 },
  libraryEyebrow: { fontSize: 9, letterSpacing: 1.7, color: colors.green, fontWeight: "800", marginBottom: 7 },
  countBadge: { minWidth: 62, height: 62, borderRadius: 20, backgroundColor: "#E5F0E8", alignItems: "center", justifyContent: "center", marginLeft: 12 },
  countNumber: { fontSize: 20, fontWeight: "800", color: colors.green },
  countLabel: { fontSize: 8, fontWeight: "800", color: colors.muted, letterSpacing: 1 },
  newPhotoButton: { marginTop: 0, marginBottom: 8 },
  header: {
    height: 76,
    paddingHorizontal: 16,
    position: "relative",
    alignItems: "center",
    justifyContent: "center",
  },
  headerBrand: { position: "absolute", top: 3, left: 58, right: 58, alignItems: "center", justifyContent: "center" },
  headerLogoFrame: { width: 42, height: 42, borderRadius: 13, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  back: {
    position: "absolute",
    left: 16,
    top: 16,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
    backgroundColor: "#EAF0EB",
  },
  backText: { fontSize: 28, color: colors.ink, marginTop: -4 },
  headerTitle: { fontWeight: "700", fontSize: 12, color: colors.ink, marginTop: 2, maxWidth: "100%" },
  headerLogo: { width: 38, height: 38 },
  brand: { alignItems: "center", paddingTop: 22, paddingBottom: 26 },
  brandMark: {
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
  },
  brandLogo: { width: 52, height: 52 },
  brandName: {
    fontSize: 23,
    fontWeight: "800",
    color: colors.ink,
    marginTop: 9,
  },
  kicker: {
    fontSize: 9,
    letterSpacing: 2.1,
    color: colors.muted,
    fontWeight: "700",
    marginTop: 5,
  },
  hero: {
    height: 286,
    backgroundColor: "#E6F0E8",
    borderRadius: 26,
    padding: 22,
    overflow: "hidden",
    marginBottom: 25,
  },
  heroTitle: {
    fontSize: 28,
    lineHeight: 33,
    fontWeight: "800",
    color: colors.ink,
  },
  heroCopy: {
    fontSize: 13,
    lineHeight: 19,
    color: "#5E7165",
    marginTop: 9,
    width: "92%",
  },
  heroGraphic: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    height: 108,
    overflow: "hidden",
  },
  sun: {
    position: "absolute",
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "#D9B56F",
    right: 40,
    top: 8,
  },
  hillOne: {
    position: "absolute",
    bottom: -50,
    left: -16,
    width: "76%",
    height: 114,
    borderRadius: 100,
    backgroundColor: "#A9C7AB",
    transform: [{ rotate: "-10deg" }],
  },
  hillTwo: {
    position: "absolute",
    bottom: -68,
    right: -14,
    width: "70%",
    height: 126,
    borderRadius: 100,
    backgroundColor: "#78A88A",
    transform: [{ rotate: "12deg" }],
  },
  heroCard: {
    position: "absolute",
    bottom: 16,
    left: 19,
    backgroundColor: "rgba(255,255,255,0.95)",
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 14,
  },
  sectionTitle: {
    fontSize: 10,
    letterSpacing: 1.5,
    color: colors.muted,
    fontWeight: "800",
    marginBottom: 10,
  },
  homeMessage: {
    color: colors.red,
    fontSize: 12,
    lineHeight: 17,
    padding: 12,
    borderRadius: 12,
    backgroundColor: "#F9EDEA",
    marginBottom: 14,
  },
  button: {
    height: 54,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.white,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 10,
  },
  primary: { backgroundColor: colors.green, borderColor: colors.green },
  buttonText: { fontSize: 15, fontWeight: "700", color: colors.ink },
  primaryText: { color: "white" },
  libraryButton: {
    marginTop: 8,
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 17,
    padding: 15,
    flexDirection: "row",
    alignItems: "center",
  },
  libraryIcon: { fontSize: 23, color: colors.green, marginRight: 13 },
  libraryTitle: { fontSize: 15, fontWeight: "700", color: colors.ink },
  librarySub: { fontSize: 12, color: colors.muted, marginTop: 3 },
  chevron: { fontSize: 26, color: colors.muted },
  privacy: {
    fontSize: 11,
    lineHeight: 17,
    color: colors.muted,
    textAlign: "center",
    marginTop: 20,
    paddingHorizontal: 5,
  },
  step: {
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: "800",
    color: colors.green,
    marginTop: 8,
  },
  title: { fontSize: 27, fontWeight: "800", color: colors.ink, marginTop: 7 },
  subtitle: {
    fontSize: 14,
    lineHeight: 21,
    color: colors.muted,
    marginTop: 6,
    marginBottom: 19,
  },
  sourceCard: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 16,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 18,
  },
  thumb: {
    width: 58,
    height: 58,
    borderRadius: 11,
    backgroundColor: "#E8EEE9",
    marginRight: 12,
  },
  sourceTitle: { fontSize: 13, fontWeight: "700", color: colors.ink },
  sourceSub: { fontSize: 11, color: colors.muted, marginTop: 4 },
  accuracy: {
    textAlign: "center",
    fontSize: 12,
    color: colors.green,
    marginTop: -4,
    marginBottom: 12,
  },
  divider: { flexDirection: "row", alignItems: "center", marginVertical: 17 },
  rule: { height: 1, backgroundColor: colors.line, flex: 1 },
  or: {
    fontSize: 9,
    letterSpacing: 1,
    color: colors.muted,
    fontWeight: "800",
    paddingHorizontal: 10,
  },
  coordRow: { flexDirection: "row" },
  label: {
    fontSize: 9,
    letterSpacing: 1.3,
    fontWeight: "800",
    color: colors.muted,
    marginBottom: 8,
    marginTop: 12,
  },
  input: {
    height: 51,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: "white",
    borderRadius: 13,
    paddingHorizontal: 13,
    color: colors.ink,
    fontSize: 15,
  },
  inputError: { borderColor: "#C65F52" },
  addressStatus: { fontSize: 11, color: colors.muted, lineHeight: 16, marginTop: -3, marginBottom: 8 },
  timeHelp: { fontSize: 11, color: colors.muted, lineHeight: 16, marginTop: -3, marginBottom: 8 },
  timeNowButton: { alignSelf: "flex-end", paddingVertical: 10, paddingHorizontal: 3 },
  timeNowText: { fontSize: 11, fontWeight: "700", color: colors.green },
  addressRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  addressInput: { flex: 1 },
  lookupButton: { height: 51, minWidth: 62, paddingHorizontal: 12, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.pale },
  lookupButtonText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  error: { fontSize: 10, color: colors.red, marginTop: 5 },
  captureNote: { fontSize: 12, color: colors.green, marginTop: 14 },
  smallNote: {
    fontSize: 11,
    color: colors.muted,
    lineHeight: 17,
    textAlign: "center",
    paddingHorizontal: 12,
    marginTop: 6,
  },
  photoFrame: {
    width: "100%",
    aspectRatio: 1.15,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "#DDE5DE",
    marginVertical: 8,
    position: "relative",
  },
  compactFrame: { aspectRatio: 1.4 },
  stampCard: {
    position: "absolute",
    width: "92%",
    borderRadius: 9,
    paddingHorizontal: 13,
    paddingVertical: 12,
    backgroundColor: "rgba(10,12,12,0.58)",
    flexDirection: "row",
    alignItems: "flex-start",
  },
  lightCard: { backgroundColor: "rgba(255,255,255,0.66)" },
  solidCard: { backgroundColor: "#176B4A" },
  pin: {
    width: 25,
    height: 25,
    borderRadius: 13,
    backgroundColor: "#79C69A",
    alignItems: "center",
    justifyContent: "center",
    marginRight: 9,
    overflow: "visible",
  },
  pinTail: {
    position: "absolute",
    width: 8,
    height: 8,
    left: 8.5,
    bottom: -2,
    backgroundColor: "#79C69A",
    transform: [{ rotate: "45deg" }],
  },
  pinGlyph: { fontSize: 13, color: "#174C34" },
  stampContent: { flex: 1, gap: 4 },
  stampText: {
    fontSize: 10,
    color: "white",
    fontWeight: "600",
    lineHeight: 15,
  },
  stampTime: { fontSize: 11, lineHeight: 16 },
  stampAddress: { fontSize: 10, lineHeight: 14 },
  stampCoordinates: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  stampCoordinate: { fontSize: 9, lineHeight: 13, flex: 1 },
  longitudeText: { textAlign: "right" },
  lightText: { color: "#17241F" },
  settingsCard: {
    backgroundColor: "white",
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: 17,
    paddingHorizontal: 15,
    marginTop: 14,
    marginBottom: 15,
  },
  toggle: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomColor: "#EEF1EE",
    borderBottomWidth: 1,
  },
  toggleLabel: { fontSize: 14, color: colors.ink, fontWeight: "600" },
  optionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 12,
  },
  option: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: "white",
  },
  optionSelected: { borderColor: colors.green, backgroundColor: colors.pale },
  optionText: {
    fontSize: 11,
    textTransform: "capitalize",
    color: colors.muted,
    fontWeight: "600",
  },
  optionTextSelected: { color: colors.green },
  styleOption: {
    minHeight: 44,
    minWidth: 86,
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    backgroundColor: "white",
  },
  styleSwatch: {
    width: 16,
    height: 16,
    borderRadius: 5,
    borderWidth: 1,
    borderColor: "#CAD4CC",
  },
  actionRow: { flexDirection: "row", gap: 10, marginTop: 6 },
  actionButton: { flex: 1, marginBottom: 0 },
  exifCard: {
    backgroundColor: "#E8F1E9",
    borderRadius: 16,
    padding: 16,
    marginVertical: 17,
  },
  exifTitle: {
    fontSize: 10,
    letterSpacing: 1.1,
    color: colors.green,
    fontWeight: "800",
  },
  exifCoords: {
    fontSize: 17,
    color: colors.ink,
    fontWeight: "700",
    marginTop: 7,
  },
  exifSub: { fontSize: 11, color: colors.muted, marginTop: 7, lineHeight: 16 },
  success: {
    padding: 13,
    backgroundColor: "#E7F3E9",
    borderRadius: 12,
    color: colors.green,
    fontSize: 12,
    marginBottom: 12,
    lineHeight: 17,
  },
  empty: {
    backgroundColor: "white",
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 20,
    alignItems: "center",
    padding: 27,
    marginTop: 16,
  },
  emptyLogo: { width: 64, height: 64 },
  emptyTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: colors.ink,
    marginTop: 12,
  },
  emptyCopy: {
    fontSize: 13,
    color: colors.muted,
    textAlign: "center",
    lineHeight: 19,
    marginTop: 7,
    marginBottom: 20,
  },
  projectGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    rowGap: 12,
    marginTop: 10,
  },
  projectTile: {
    width: "48.5%",
    backgroundColor: "white",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: "hidden",
  },
  projectImage: {
    width: "100%",
    height: 146,
    backgroundColor: "#E5EBE6",
  },
  savedPreview: {
    width: "100%",
    height: 430,
    borderRadius: 18,
    backgroundColor: "#E5EBE6",
    marginVertical: 16,
  },
  projectInfo: { padding: 11 },
  projectCoords: { fontSize: 11, fontWeight: "800", color: colors.ink },
  projectMeta: { fontSize: 10, color: colors.muted, lineHeight: 14, marginTop: 5, minHeight: 28 },
  projectDate: { fontSize: 9, color: colors.muted, marginTop: 5 },
  projectActions: {
    flexDirection: "row",
    gap: 6,
    marginTop: 9,
  },
  actionText: { fontSize: 10, fontWeight: "700", color: colors.green, textAlign: "center" },
  tileAction: { flex: 1, minHeight: 40, justifyContent: "center", borderRadius: 11, backgroundColor: "#F2F6F3", paddingHorizontal: 5 },
  tileActionPrimary: { backgroundColor: colors.green },
  tileActionPrimaryText: { color: colors.white },
  smallAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: 4 },
  loading: {
    position: "absolute",
    left: 25,
    right: 25,
    top: "47%",
    padding: 20,
    backgroundColor: "white",
    borderRadius: 16,
    alignItems: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 12,
  },
  loadingText: { fontSize: 13, color: colors.ink, marginTop: 10 },
});
