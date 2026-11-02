import { useEffect, useState } from 'react';

const cache = new Map<string, Promise<Int8Array>>();

/** Peaks are fetched once per source, however many clips on the timeline use it. */
function loadPeaks(mediaId: string, url: string): Promise<Int8Array> {
  let peaks = cache.get(mediaId);
  if (!peaks) {
    peaks = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`Waveform responded with ${response.status}`);
      return new Int8Array(await response.arrayBuffer());
    });
    peaks.catch(() => cache.delete(mediaId));
    cache.set(mediaId, peaks);
  }
  return peaks;
}

export function useWaveformPeaks(mediaId: string | null, url: string | null): Int8Array | null {
  const [peaks, setPeaks] = useState<Int8Array | null>(null);
  useEffect(() => {
    if (!mediaId || !url) return;
    let current = true;
    void loadPeaks(mediaId, url)
      .then((loaded) => {
        if (current) setPeaks(loaded);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [mediaId, url]);
  return peaks;
}
