import { registerWebModule, NativeModule } from 'expo';

class GeoPhotoModule extends NativeModule<{}> {}

export default registerWebModule(GeoPhotoModule, 'GeoPhotoModule');
