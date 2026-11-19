import type { CompileContext, LibraryItem } from '@agent-edit/ai-engine';
import type { MediaLookup } from '@agent-edit/timeline-engine';
import type { Database, TimelineDoc } from './mongo.js';

export interface AgentContext {
  compile: CompileContext;
  media: MediaLookup;
  repeatedTakeCount: number;
  chapters: Array<{ mediaId: string; start: number; end: number; title: string | null }>;
  scenes: Array<{ mediaId: string; start: number; end: number; summary: string }>;
}

/**
 * The facts a plan compiles against. Shared by the worker when proposing and by the API when applying,
 * so a recompile after the timeline changed uses exactly the same inputs.
 */
export async function loadAgentContext(
  database: Database,
  timeline: Pick<TimelineDoc, 'projectId' | 'tracks'>,
): Promise<AgentContext> {
  const { projectId } = timeline;
  const assets = await database.media
    .find({ projectId, deletedAt: null, probe: { $ne: null } })
    .toArray();
  const ids = assets.map((asset) => asset._id);
  const [segments, scenes, moments] = await Promise.all([
    database.segments
      .find({ mediaId: { $in: ids } })
      .sort({ start: 1 })
      .toArray(),
    database.scenes.find({ mediaId: { $in: ids } }).toArray(),
    database.moments.find({ mediaId: { $in: ids } }).toArray(),
  ]);

  const library = new Map<string, LibraryItem>();
  for (const asset of assets) {
    const summary = scenes
      .filter((scene) => scene.mediaId === asset._id && scene.summary)
      .map((scene) => scene.summary)
      .join(' ');
    const speech = segments
      .filter((segment) => segment.mediaId === asset._id)
      .map((segment) => segment.text)
      .join(' ');
    library.set(asset._id, {
      id: asset._id,
      name: asset.name,
      folder: asset.folder,
      duration: asset.probe!.duration,
      width: asset.probe!.width,
      height: asset.probe!.height,
      hasAudio: asset.probe!.audioCodec !== null,
      description: `${summary} ${speech.slice(0, 4000)}`.trim(),
    });
  }

  const durations = new Map(assets.map((asset) => [asset._id, asset.probe!.duration]));
  return {
    media: (id) => {
      const duration = durations.get(id);
      return duration === undefined ? undefined : { duration };
    },
    repeatedTakeCount: moments.filter((moment) => moment.kind === 'repeated_take').length,
    chapters: moments
      .filter((moment) => moment.kind === 'chapter')
      .map(({ mediaId, start, end, title }) => ({ mediaId, start, end, title })),
    scenes: scenes.flatMap(({ mediaId, start, end, summary }) =>
      summary ? [{ mediaId, start, end, summary }] : [],
    ),
    compile: {
      library,
      segments: segments.map(({ mediaId, start, end, text, words }) => ({
        mediaId,
        start,
        end,
        text,
        words,
      })),
      silences: moments
        .filter((moment) => moment.kind === 'silence')
        .map(({ mediaId, start, end }) => ({ mediaId, start, end })),
      moments: moments
        .filter((moment) => moment.kind === 'highlight')
        .map(({ mediaId, start, end, score, title, reason }) => ({
          mediaId,
          start,
          end,
          score,
          title,
          reason,
        })),
    },
  };
}
