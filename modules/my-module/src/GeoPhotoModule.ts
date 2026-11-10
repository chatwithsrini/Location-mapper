import { NativeModule, requireNativeModule } from 'expo';

declare class GeoPhotoModule extends NativeModule<{}> {}

export default requireNativeModule<GeoPhotoModule>('GeoPhoto');
