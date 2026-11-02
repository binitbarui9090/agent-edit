import { serverEventSchema } from '@agent-edit/validation';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { patchJobProgress, refreshMedia } from './media';

const MAX_BACKOFF_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 250;
/** Two missed server heartbeats. A dropped network can leave a socket looking open for minutes. */
const SILENCE_LIMIT_MS = 60_000;
/** The server closed for a reason reconnecting cannot fix: session ended or project gone. */
const FINAL_CLOSE_CODES = new Set([4401, 4404]);

/** Returns whether the socket is live, so callers can fall back to polling and say so. */
export function useProjectEvents(projectId: string): boolean {
  const client = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let attempts = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    let silence: ReturnType<typeof setTimeout> | undefined;

    const scheduleRefresh = () => {
      clearTimeout(refresh);
      refresh = setTimeout(() => void refreshMedia(client, projectId), REFRESH_DEBOUNCE_MS);
    };

    const retryLater = () => {
      clearTimeout(reconnect);
      clearTimeout(silence);
      reconnect = setTimeout(connect, Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempts++));
    };

    /** Gives up on a socket now rather than waiting for a close that may be minutes away. */
    const abandon = () => {
      if (!socket) return;
      socket.onclose = null;
      socket.onmessage = null;
      socket.close();
      socket = null;
      setLive(false);
      retryLater();
    };

    const expectHeartbeat = () => {
      clearTimeout(silence);
      silence = setTimeout(abandon, SILENCE_LIMIT_MS);
    };

    const connect = () => {
      const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${scheme}//${location.host}/api/v1/ws`);
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: 'subscribe', projectId }));
        expectHeartbeat();
      };
      socket.onmessage = ({ data }) => {
        expectHeartbeat();
        const message = JSON.parse(String(data)) as { type?: string };
        if (message.type === 'subscribed') {
          attempts = 0;
          setLive(true);
          // Anything may have happened while disconnected.
          scheduleRefresh();
          return;
        }
        const event = serverEventSchema.safeParse(message);
        if (!event.success) return;
        if (event.data.type === 'job.progress') {
          const { mediaId, step, status, progress } = event.data;
          patchJobProgress(client, projectId, mediaId, { step, status, progress });
        } else {
          scheduleRefresh();
        }
      };
      socket.onclose = ({ code }) => {
        setLive(false);
        clearTimeout(silence);
        if (stopped || FINAL_CLOSE_CODES.has(code)) return;
        retryLater();
      };
    };
    connect();

    window.addEventListener('offline', abandon);

    return () => {
      stopped = true;
      window.removeEventListener('offline', abandon);
      clearTimeout(reconnect);
      clearTimeout(refresh);
      clearTimeout(silence);
      socket?.close();
    };
  }, [client, projectId]);

  return live;
}
