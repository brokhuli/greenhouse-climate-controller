import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { isRangeKey, type RangeKey } from "../features/greenhouse/range";

function readStored(storageKey: string): RangeKey | null {
  try {
    const stored = localStorage.getItem(storageKey);
    return isRangeKey(stored) ? stored : null;
  } catch {
    // localStorage can be unavailable (private mode); fall back to the default.
    return null;
  }
}

function writeStored(storageKey: string, value: RangeKey): void {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    // localStorage can be unavailable (private mode); the URL param still drives the view.
  }
}

/**
 * A range selection that stays deep-linkable in a URL query param but survives remounts. The URL
 * param wins when present (so shared links keep working); otherwise the last explicit pick is read
 * back from localStorage instead of snapping to the 1h default when a view mounts on a fresh route.
 * Every change mirrors to both the param and storage.
 */
export function usePersistentRange(
  param: string,
  storageKey: string,
): [RangeKey, (next: RangeKey) => void] {
  const [searchParams, setSearchParams] = useSearchParams();
  const fromUrl = searchParams.get(param);
  const value: RangeKey = isRangeKey(fromUrl) ? fromUrl : (readStored(storageKey) ?? "1h");

  const setValue = useCallback(
    (next: RangeKey) => {
      writeStored(storageKey, next);
      setSearchParams(
        (prev) => {
          const updated = new URLSearchParams(prev);
          updated.set(param, next);
          return updated;
        },
        { replace: true },
      );
    },
    [param, storageKey, setSearchParams],
  );

  return [value, setValue];
}
