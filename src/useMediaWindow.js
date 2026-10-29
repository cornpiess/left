import { useEffect, useState } from 'react';
import { planPhotoWindow } from './mediaWindow.mjs';
import { getNativePerformanceSnapshot, setNativeMediaWindow } from './nativePhotoPreview';
import { flightEvent } from './flightRecorder';

export default function useMediaWindow({ nextItems, width, height, interactive, enabled }) {
  const [constrained, setConstrained] = useState(false);
  useEffect(() => {
    const requests = planPhotoWindow(nextItems, width, height);
    void setNativeMediaWindow(requests, interactive, enabled).catch(() => {});
  }, [nextItems, width, height, interactive, enabled]);
  useEffect(() => {
    if (!enabled) return;
    let alive = true, busy = false;
    const sample = async () => {
      if (busy) return;
      busy = true;
      try {
        const snapshot = await getNativePerformanceSnapshot();
        if (alive && snapshot) {
          setConstrained(Boolean(snapshot.constrained));
          // Short keys fit the existing bounded local flight log. No asset IDs.
          flightEvent('media-performance', {
            f: snapshot.frames, slow: snapshot.slowFrames, max: Math.round(snapshot.maxFrameMs),
            mem: Math.round(snapshot.residentMiB), peak: Math.round(snapshot.sampledPeakMiB), hits: snapshot.memoryCacheHits,
            req: snapshot.imageRequests, ms: Math.round(snapshot.meanLoadMs), hot: snapshot.constrained,
            err: snapshot.errorCount, cxl: snapshot.cancelledCount,
          });
          if (snapshot.errorCount || snapshot.missingAssets || snapshot.cloudMisses || snapshot.timeouts || snapshot.queuedRequests > 0) {
            // Aggregate only: no asset IDs, filenames, location or image data.
            flightEvent('photo-diagnostics', { err: snapshot.errorCount, code: snapshot.lastErrorCode,
              cloud: snapshot.cloudMisses, miss: snapshot.missingAssets, preview: snapshot.previewImages,
              queued: snapshot.queuedRequests, active: snapshot.activeRequests, hot: snapshot.constrained, timeout: snapshot.timeouts });
          }
        }
      } catch {} finally { busy = false; }
    };
    void sample();
    const timer = setInterval(sample, 10000);
    return () => { alive = false; clearInterval(timer); };
  }, [enabled]);
  // Release window and display-link when the owning surface unmounts.
  useEffect(() => () => { void setNativeMediaWindow([], false, false).catch(() => {}); }, []);
  return constrained;
}
