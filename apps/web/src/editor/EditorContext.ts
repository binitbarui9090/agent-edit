import { createContext, useContext } from 'react';
import type { MediaAsset, MediaPlayback } from '@agent-edit/validation';
import type { PlaybackEngine } from './playback';

export interface EditorContextValue {
  engine: PlaybackEngine | null;
  media: ReadonlyMap<string, MediaAsset>;
  playback: ReadonlyMap<string, MediaPlayback>;
}

export const EditorContext = createContext<EditorContextValue>({
  engine: null,
  media: new Map(),
  playback: new Map(),
});

export const useEditorContext = () => useContext(EditorContext);
