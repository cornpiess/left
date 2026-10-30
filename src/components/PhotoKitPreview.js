import { Image, Platform } from 'react-native';
import { NativePhotoPreview } from '../nativePhotoPreview';
export default function PhotoKitPreview({ uri, assetId, style, resizeMode, onLoad, onError, resolutionScale = 1, blurRadius, purpose, ...props }) {
  const id = assetId || uri;
  if (NativePhotoPreview && typeof id === 'string' && (assetId || id.startsWith('ph://'))) {
    return <NativePhotoPreview {...props} assetId={id} style={style} resizeMode={resizeMode || 'contain'} resolutionScale={resolutionScale} blurRadius={blurRadius || 0} purpose={purpose || 'feed'} onLoad={onLoad} onError={onError} />;
  }
  // Older binaries and non-iOS preview environments retain the file renderer.
  if (Platform.OS === 'ios' && (!uri || uri.startsWith('ph://') || uri.startsWith('assets-library://'))) return null;
  return uri ? <Image {...props} source={{ uri }} style={style} resizeMode={resizeMode || 'contain'} blurRadius={blurRadius} onLoad={onLoad} onError={onError} /> : null;
}
